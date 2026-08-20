// Hydration — the Omnipool DEX on Polkadot.
//
// Two upstreams, both anonymous and both public:
//   · orca — Hydration's own liquidity-pools squid (`galacticcouncil/hydration-data-lake`,
//     self-hosted, CORS-open, PostGraphile). We read `routedTrades`, which is the swap LEGS
//     already grouped into trades. Two hosts are listed and the first one that answers wins.
//   · the chain itself at rpc.hydradx.cloud, for the asset registry, because an indexer that
//     hands you `asset: 1000624` and nothing else is not enough to say what was traded — and
//     because the registry, not any indexer, is the authority on a symbol and its decimals.
//
// This page is the descendant of the 2022 Mangata X DEX-stats work in `subflow DEX stats`:
// same questions — what traded, for how much, by whom — against a venue that is still live.
//
// ── the one thing that would silently double every number ───────────────────────────────────
// Hydration emits ONE `Broadcast.Swapped3` per swap LEG, not per trade. A single user swap of
// USDT→GDOT is four legs: AAVE unwrap, stableswap, omnipool in, omnipool out. Summing legs
// would count the same money up to four times, and the result would look entirely plausible.
// Legs of one trade share the first element of `operationStack`.
//
// We used to do that grouping by hand against the generic Subsquid archive at
// explorer.hydradx.cloud. orca has already done it, keyed on the same `Broadcast::IncrementalId`
// our decoder used, so the two agree by construction — and orca answers a whole day in one
// second where the generic archive times out at twelve. The grouping is still the fact that
// matters; it is just no longer ours to get wrong. `swaps.totalCount` on each row is the leg
// count, and the page reports the leg-inflation factor so the grouping stays visible rather
// than becoming an invisible assumption. See docs/platform/hydration.md.
//
// ── the window ──────────────────────────────────────────────────────────────────────────────
// orca's `routedTrades` begin at a specific block, and before that block this source has
// nothing — not "no trading". That floor is read live and stated on the page, because a chart
// that starts on a date for a reason nobody wrote down is the exact failure this repo's third
// rule exists to prevent. Window edges are whole UTC days resolved to real block heights by
// asking the chain which block a day started at, never by multiplying an assumed block time.

import { graphql, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { deriveRates } from '../../src/core/pricing.js'
import { aggregate, trimForWire, dayOf } from '../../src/core/swaps.js'
import { twox128 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { toHex, fromHex, utf8, concat, u32le } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'
import { liveness } from '../../src/core/liveness.js'

/** The upstream's human name, as `/api` and every liveness line spell it. Declared once, for
 *  the reason bulletin.mjs declares its own: the contract says `label` is "the upstream's human
 *  name, as it appears at /api", and two string literals is how that quietly stops being true. */
const LABEL = 'Hydration (Omnipool)'

/**
 * Liveness thresholds for THIS upstream rather than the generic defaults in
 * src/core/liveness.js.
 *
 * Fifteen minutes is not a new number — it is the threshold this module's own head-age note has
 * used since it was written, and reusing it is deliberate: the pill and the note are two
 * renderings of one fact, and giving them separate constants is how they end up disagreeing on
 * screen. Hydration produces a block every ~6 s, so fifteen minutes is already ~150 blocks of
 * trades that this page cannot see.
 *
 * A day is the frozen line, and this is the source that earned the state: the generic `hydradx`
 * SQD squid answered every query in 381 ms with 1.57 MB of well-formed rows while 103 days
 * behind. orca is a different deployment, not a different class of thing.
 */
const STALE_AFTER_MS = 15 * 60_000
const FROZEN_AFTER_MS = 24 * 60 * 60_000

/** Trap 7 in docs/concept/research/hydration.md: the URL orca's own README documents is dead,
 *  and the live one was found by watching the app's network traffic. It can move again, so a
 *  second host with an identical schema is listed and the failure of the first is reported
 *  rather than swallowed. */
const ORCA_HOSTS = [
  'https://orca-prod-pool-01.orca.hydration.cloud/graphql',
  'https://orca-prod-pool-02.catfish.hydration.cloud/graphql',
]
const RPC = 'https://rpc.hydradx.cloud'

const PAGE = 1000

/** Nominal 6 s blocks. Used ONLY to guess where to start looking for a UTC day boundary — the
 *  boundary itself comes from the chain, and the guess is checked before it is trusted. Real
 *  block time on this chain is a trailing average around 5.6–6.2 s and is never a constant. */
const NOMINAL_BLOCKS_PER_DAY = 14_400

/** A ceiling on how much of somebody else's database we will pull into a 256 MB container in
 *  one request. Reaching it is a bug or a runaway window, so it throws rather than truncating. */
const MAX_TRADES = 250_000

/* ------------------------------------------------------------------- asset registry ---- */

const ASSETS_PREFIX = '0x' + toHex(concat(twox128(utf8('AssetRegistry')), twox128(utf8('Assets'))))

/** `Blake2_128Concat` over a fixed-width little-endian u32 — a map key, not a call argument. */
const assetKey = (id) => {
  const encoded = u32le(id)
  return ASSETS_PREFIX + toHex(blake2b(encoded, 16)) + toHex(encoded)
}

const ASSET_TYPE = ['Token', 'XYK', 'StableSwap', 'Bond', 'External', 'Erc20']

/**
 * `AssetRegistry::Assets: AssetId -> AssetDetails`.
 *
 * Field order, read off the live chain and checked against known assets:
 *
 *     Option<BoundedVec<u8>>  name
 *     AssetType               1-byte enum
 *     u128                    existential_deposit
 *     Option<BoundedVec<u8>>  symbol
 *     Option<u8>              decimals
 *     Option<u128>            xcm_rate_limit
 *     bool                    is_sufficient
 *
 * Decoding "consumes exactly" is the self-check: a runtime upgrade that reorders or adds a
 * field leaves bytes over, and leftover bytes throw rather than yielding a plausible symbol
 * with the wrong decimals. Wrong decimals here are a silent factor of 10^n on every total.
 */
export function decodeAssetDetails(hex) {
  const bytes = fromHex(hex)
  let at = 0

  const byte = () => {
    if (at >= bytes.length) throw new Error('AssetDetails ended early')
    return bytes[at++]
  }
  const text = () => {
    const [length, next] = decodeCompact(toHex(bytes), at * 2)
    at = next / 2
    const slice = bytes.subarray(at, at + length)
    at += length
    return new TextDecoder().decode(slice)
  }
  const optionalText = () => (byte() === 1 ? text() : null)
  const skip = (n) => {
    at += n
  }

  const name = optionalText()
  const typeIndex = byte()
  skip(16) // existential_deposit, not shown anywhere
  const symbol = optionalText()
  const decimals = byte() === 1 ? byte() : null
  if (byte() === 1) skip(16) // xcm_rate_limit
  const isSufficient = byte() === 1

  if (at !== bytes.length) {
    throw new Error(`AssetDetails left ${bytes.length - at} byte(s) undecoded — the runtime layout has changed`)
  }

  return { name, type: ASSET_TYPE[typeIndex] ?? `type-${typeIndex}`, symbol, decimals, isSufficient }
}

/**
 * Resolve exactly the assets that appeared in the window, rather than sweeping the whole
 * registry — there are ~1,400 entries and almost all of them are share tokens nobody traded
 * today.
 */
async function fetchAssets(ids) {
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id >= 0)
  /** @type {Map<number, ReturnType<typeof decodeAssetDetails> & {id:number}>} */
  const assets = new Map()

  for (let i = 0; i < wanted.length; i += 200) {
    const batch = wanted.slice(i, i + 200)
    const changes = await jsonRpc({
      source: 'hydration-rpc',
      url: RPC,
      method: 'state_queryStorageAt',
      params: [batch.map(assetKey)],
      timeoutMs: 30_000,
    })
    const byKey = new Map((changes?.[0]?.changes ?? []).map(([key, value]) => [key.toLowerCase(), value]))
    for (const id of batch) {
      const raw = byKey.get(assetKey(id).toLowerCase())
      if (!raw) continue // an id the registry does not know; the caller reports it rather than guessing
      try {
        assets.set(id, { id, ...decodeAssetDetails(raw) })
      } catch (error) {
        throw new UpstreamError(`asset ${id}: ${error.message}`, { kind: 'decode', source: 'hydration-rpc' })
      }
    }
  }
  return assets
}

/**
 * The decode above is trusted by every dollar figure on the page, so it is checked against
 * three assets whose symbol and decimals are common knowledge before any of them are used.
 * A runtime upgrade that changes the layout then fails loudly, on the first request, instead
 * of quietly rescaling the charts.
 */
const CANARIES = [
  [0, 'HDX', 12],
  [5, 'DOT', 10],
  [22, 'USDC', 6],
]

async function verifyRegistry() {
  const assets = await fetchAssets(CANARIES.map(([id]) => id))
  for (const [id, symbol, decimals] of CANARIES) {
    const got = assets.get(id)
    if (!got || got.symbol !== symbol || got.decimals !== decimals) {
      throw new UpstreamError(
        `asset registry self-check failed: asset ${id} decoded as ` +
          `${got ? `${got.symbol}/${got.decimals}` : 'missing'}, expected ${symbol}/${decimals}. ` +
          'Refusing to price anything against a layout we no longer understand.',
        { kind: 'decode', source: 'hydration-rpc' },
      )
    }
  }
}

/* ------------------------------------------------------------------------------ orca ---- */

const ORCA = 'hydration-orca'

/** Head, and the oldest routed trade orca holds. One request, because the second is the thing
 *  that decides whether the requested window even exists in this source. */
const HEAD_AND_FLOOR = `
query HeadAndFloor {
  blocks(orderBy: HEIGHT_DESC, first: 1) { nodes { height timestamp } }
  floor: routedTrades(orderBy: PARA_BLOCK_HEIGHT_ASC, first: 1) {
    nodes { id paraBlockHeight block { height timestamp } }
  }
}`

/**
 * The first block at or after an instant, with the guess that made it fast checked before the
 * answer is used.
 *
 * `blocks(timestamp_gte)` unassisted takes 1–4 s on a 13.7 M-row table; the same query with a
 * height floor takes 190 ms. But a height floor that is accidentally ABOVE the real boundary
 * returns the floor block itself and the window then starts silently late — so `probe` reads
 * the guess's own timestamp and the guess is only trusted when it really does sit before the
 * instant we are looking for.
 */
const BOUNDARY = `
query Boundary($est: Int!, $at: Datetime!) {
  probe: blocks(filter: { height: { equalTo: $est } }) { nodes { height timestamp } }
  boundary: blocks(
    filter: { height: { greaterThanOrEqualTo: $est }, timestamp: { greaterThanOrEqualTo: $at } }
    orderBy: HEIGHT_ASC
    first: 1
  ) { nodes { height timestamp } }
}`

const BOUNDARY_SCAN = `
query BoundaryScan($at: Datetime!) {
  boundary: blocks(filter: { timestamp: { greaterThanOrEqualTo: $at } }, orderBy: HEIGHT_ASC, first: 1) {
    nodes { height timestamp }
  }
}`

const COUNT = `
query Count($from: Int!, $to: Int!) {
  routedTrades(filter: { paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to } }) { totalCount }
}`

/**
 * Keyset paging through the connection's own cursor, not `offset`. Offset paging over a
 * hundred thousand rows makes the database re-scan from the top on every page and the last
 * page costs the most; measured here, page 1 and page 6 both take ~330 ms.
 *
 * `swaps(first: 1)` is deliberate: only the outermost operation and the leg count are wanted,
 * and pulling every leg back would undo most of the saving of having them pre-grouped.
 */
const TRADES = `
query Trades($from: Int!, $to: Int!, $first: Int!, $after: Cursor) {
  routedTrades(
    filter: { paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to } }
    orderBy: [PARA_BLOCK_HEIGHT_ASC, ID_ASC]
    first: $first
    after: $after
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      paraBlockHeight
      participantSwappers
      block { timestamp }
      swaps(first: 1, orderBy: SWAP_INDEX_ASC) { totalCount nodes { operationId } }
      routeTradeInputs { nodes { assetId amount } }
      routeTradeOutputs { nodes { assetId amount } }
    }
  }
}`

const SQUID_ASSETS = `
query SquidAssets($ids: [String!]) {
  assets(filter: { id: { in: $ids } }) { nodes { id assetRegistryId symbol decimals } }
}`

/**
 * orca's own published volume for exactly the blocks we read, so the page can state how far it
 * is from the number Hydration publishes about itself and why. `…VolNorm` is USD-normalised.
 */
const PLATFORM_VOLUME = `
query PlatformVolume($from: Int!, $to: Int!) {
  platformTotalVolumesByPeriod(filter: { startBlockNumber: $from, endBlockNumber: $to }) {
    nodes { totalVolNorm omnipoolVolNorm stableswapVolNorm xykpoolVolNorm }
  }
}`

/** First host that answers. A dead host is a reported fact, not a silent failover. */
async function connect() {
  const failures = []
  for (const url of ORCA_HOSTS) {
    const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    try {
      const data = await graphql({ source: ORCA, url, query: HEAD_AND_FLOOR, timeoutMs: 20_000 })
      const head = data?.blocks?.nodes?.[0]
      const floor = data?.floor?.nodes?.[0]
      if (!head || !floor) {
        throw new UpstreamError('answered without a head block or a first routed trade.', { kind: 'upstream', source: ORCA })
      }
      return { url, host, head, floor, failures }
    } catch (error) {
      failures.push(`${host}: ${error.message}`)
    }
  }
  throw new UpstreamError(`no orca host answered — ${failures.join('; ')}`, { kind: 'transport', source: ORCA })
}

async function firstBlockAtOrAfter(url, instant, hint) {
  const est = Math.max(1, Math.floor(hint))
  const data = await graphql({ source: ORCA, url, query: BOUNDARY, variables: { est, at: instant }, timeoutMs: 30_000 })
  const probe = data?.probe?.nodes?.[0]
  const found = data?.boundary?.nodes?.[0]
  if (probe && found && Date.parse(probe.timestamp) < Date.parse(instant)) return { block: found, assisted: true }

  const scan = await graphql({ source: ORCA, url, query: BOUNDARY_SCAN, variables: { at: instant }, timeoutMs: 90_000 })
  return { block: scan?.boundary?.nodes?.[0] ?? null, assisted: false }
}

/* --------------------------------------------------------------------- pallet names ---- */

// A swapper beginning with the ASCII "modl" is a pallet account, not a person: Substrate
// derives them from a PalletId. Naming them matters because several of the busiest "traders"
// on any given day are the fee processor and the DCA machinery recycling protocol flow —
// counting those as user flow would overstate how much anyone actually traded.
const MODL = '6d6f646c'

function palletName(hexAccount) {
  const hex = String(hexAccount).replace(/^0x/, '')
  if (!hex.startsWith(MODL)) return null
  const tail = hex.slice(MODL.length)
  let text = ''
  for (let i = 0; i + 1 < tail.length; i += 2) {
    const code = parseInt(tail.slice(i, i + 2), 16)
    if (code === 0) break
    if (code < 0x20 || code > 0x7e) break
    text += String.fromCharCode(code)
  }
  return text ? `pallet:${text}` : 'pallet'
}

/* ------------------------------------------------------------------------ operation ---- */

/**
 * `operationId` is the chain's operation stack, flattened by the squid as
 * `Kind:value[:value][/Kind:value…]` — e.g. `Router:10633824/Omnipool:10633825`, or
 * `DCA:30104:10619288/Router:10619289` for an instalment of a DCA schedule.
 *
 * The FIRST segment is what the user asked for; the rest is how it got done. That is the same
 * `operationStack[0]` the hand-rolled decoder grouped on.
 *
 * Whatever the chain sends is used as-is rather than mapped onto a fixed list, and this is not a
 * theoretical worry: over fourteen days in August 2026 the kinds observed were Omnipool, Router,
 * DCA, Batch — and `Xcm`, five times, which is exactly the rate at which somebody writes down
 * "the four kinds we've seen" and silently loses the fifth. `XcmExchange` exists in the runtime
 * metadata and has still never been observed. `Direct` is ours, for a trade that arrives with no
 * operation stack at all — a single leg that nothing wrapped — and it is not a chain-side
 * variant.
 */
function initiation(operationId) {
  if (!operationId) return 'Direct'
  const kind = String(operationId).split('/')[0].split(':')[0]
  return kind || 'Direct'
}

/* --------------------------------------------------------------------------- windows ---- */

const dayIso = (ms) => new Date(ms).toISOString().slice(0, 10)

const plural = (n, word) => (n === 1 ? word : `${word}s`)

/** A list a reader can actually read, that never pretends to be the whole list when it is not. */
const some = (list, n = 6) =>
  list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')}, and ${list.length - n} more`

const addDaysIso = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/* -------------------------------------------------------------------------- liveness ---- */

/**
 * The liveness assertion for one swaps load. See src/core/liveness.js for why a source asserts
 * this at all: transport, upstream and decode errors catch an upstream that fails, and cannot
 * catch one that succeeds and is wrong about the date.
 *
 * The head here is ORCA'S, not the chain's, and the distinction is the whole reason this is
 * worth asserting. orca answers in a few hundred milliseconds whether it is at the tip or a
 * fortnight behind it, and every trade on this page came from orca — so its head is what the
 * numbers are current to. Hydration's own head is not read on this path (the RPC leg is only
 * consulted for the asset registry, which has no clock), and this assertion does not claim to
 * speak for it: a chain producing blocks that orca has not indexed is exactly the gap the
 * `stale` sentence describes.
 *
 * @param {object} spec
 * @param {number} spec.observedAt   ms epoch — when WE asked. The same instant the head age
 *                                   in the notes is measured against, so the two cannot drift.
 * @param {{height: number, timestamp: string}} spec.head   orca's newest indexed block
 * @param {number} spec.headMs       `Date.parse` of that block's timestamp
 * @param {string} spec.firstDay     first UTC day the payload draws
 * @param {string} spec.lastDay      last UTC day the payload draws
 */
function livenessOf({ observedAt, head, headMs, firstDay, lastDay }) {
  const readable = Number.isFinite(headMs)
  return liveness({
    source: 'hydration',
    label: `${LABEL} — orca indexer`,
    observedAt,
    // NOT collapsed into `live` when the timestamp will not parse. orca answered; we could not
    // read a clock out of what it said, and `unknown` is the honest word for that.
    headAt: readable ? headMs : null,
    head: `block #${head.height.toLocaleString('en-US')}`,
    // The window the CHARTS draw, which is a separate fact from the head: the last bar stops
    // at orca's head, so a reader needs both the day range and how old that day's edge is.
    covers: { from: firstDay, to: lastDay },
    staleAfterMs: STALE_AFTER_MS,
    frozenAfterMs: FROZEN_AFTER_MS,
    note: !readable
      ? `orca reported its head block as ${head.timestamp}, which is not a timestamp this site can parse, so how current these trades are cannot be established from the indexer itself.`
      : observedAt - headMs >= STALE_AFTER_MS
        ? 'The most recent day on this chart is missing whatever happened in that gap; it is a short bar because the index stops there, not because trading did.'
        : null,
  })
}

/**
 * `aggregate()` draws every day between the first and last trade, which is right when the
 * dataset defines the window. Here the WINDOW defines the window: a reader who asked for
 * fourteen days must see fourteen bars, and a day at either edge with no trades in it is a
 * fact about the venue, not a reason to shorten the axis. So the series is extended out to
 * the window the page claims to be showing.
 *
 * Only the span fields are corrected. Every other total was computed over the trades and is
 * unaffected by drawing more empty days around them.
 */
export function spanWindow(result, firstDay, lastDay) {
  if (result.empty) return result
  const empty = (date) => ({ date, usd: 0, count: 0, stack: result.venues.map(() => 0) })

  const days = result.days.slice()
  for (let d = addDaysIso(days[0].date, -1); d >= firstDay; d = addDaysIso(d, -1)) days.unshift(empty(d))
  for (let d = addDaysIso(days[days.length - 1].date, 1); d <= lastDay; d = addDaysIso(d, 1)) days.push(empty(d))

  return {
    ...result,
    days,
    totals: { ...result.totals, spanDays: days.length, first: days[0].date, last: days[days.length - 1].date },
  }
}

/* ------------------------------------------------------------------------------ page ---- */

export default {
  id: 'hydration',
  label: LABEL,
  homepage: 'https://hydration.net',
  transport: 'graphql+jsonrpc',
  doc: 'docs/platform/hydration.md',
  covers: ['Hydration (Polkadot parachain 2034)'],

  operations: {
    swaps: {
      summary: 'Hydration routed trades over a recent window, valued and rolled up. Legs are grouped upstream.',
      // Fifteen minutes. A fourteen-day window is ~79,000 trades and ~37 MB of upstream
      // traffic; doing that on every pageview would make this site orca's heaviest client.
      ttlMs: 900_000,
      schema: {
        // Fourteen, not seven, and not unlimited. Measured on 2026-08-20 against orca:
        // 8,527 trades/day, 468 bytes/trade on the wire, ~330 ms per 1,000-row page — so a
        // day costs ~3 s and fourteen days ~26 s. Thirty days is ~181,000 trades and ~60 s,
        // which is a page load nobody waits through. The cap is OURS and it is a cost
        // decision; the data goes back to January 2025 and the page says both.
        days: { type: 'int', min: 1, max: 14, default: 7 },
      },

      async run({ days }) {
        await verifyRegistry()

        const { url, host, head, floor, failures } = await connect()
        const headMs = Date.parse(head.timestamp)
        const floorMs = Date.parse(floor.block.timestamp)

        /* ---- the window, in whole UTC days, resolved to real block heights ---- */

        const lastDay = dayIso(headMs)
        const askedFirstDay = addDaysIso(lastDay, -(days - 1))
        const floorDay = dayIso(floorMs)

        let firstDay = askedFirstDay
        let from = floor.paraBlockHeight
        let boundaryAssisted = true
        const clamped = askedFirstDay < floorDay

        if (clamped) {
          firstDay = floorDay
        } else {
          // Guess low on purpose: at ~5.6 s/block a day is ~15,400 blocks, so 18,000 per day
          // plus a day of slack always lands before the boundary. The query checks it anyway.
          const hint = head.height - days * Math.ceil(NOMINAL_BLOCKS_PER_DAY * 1.25) - NOMINAL_BLOCKS_PER_DAY
          const { block, assisted } = await firstBlockAtOrAfter(url, `${askedFirstDay}T00:00:00Z`, hint)
          if (!block) {
            throw new UpstreamError(
              `orca has no block at or after ${askedFirstDay}T00:00:00Z, but reports a head at ${head.timestamp}.`,
              { kind: 'upstream', source: ORCA },
            )
          }
          from = Math.max(block.height, floor.paraBlockHeight)
          boundaryAssisted = assisted
        }
        const to = head.height + 1

        /* ---- the trades ---- */

        const counted = await graphql({ source: ORCA, url, query: COUNT, variables: { from, to }, timeoutMs: 60_000 })
        const expected = counted?.routedTrades?.totalCount ?? null
        if (expected !== null && expected > MAX_TRADES) {
          throw new UpstreamError(
            `${expected.toLocaleString('en-US')} routed trades in blocks ${from}–${to - 1} is past the ` +
              `${MAX_TRADES.toLocaleString('en-US')} ceiling this service will hold in memory at once. ` +
              'Ask for a shorter window rather than being served a silently truncated one.',
            { kind: 'upstream', source: ORCA },
          )
        }

        const raw = []
        const squidAssetIds = new Set()
        let legCount = 0
        let multiAsset = 0
        let multiSwapper = 0
        let withoutBalances = 0
        let pages = 0

        for (let after = null; ; pages += 1) {
          const data = await graphql({
            source: ORCA,
            url,
            query: TRADES,
            variables: { from, to, first: PAGE, after },
            timeoutMs: 60_000,
          })
          const connection = data?.routedTrades
          const nodes = connection?.nodes ?? []
          for (const node of nodes) {
            const inputs = node.routeTradeInputs?.nodes ?? []
            const outputs = node.routeTradeOutputs?.nodes ?? []
            if (!inputs.length || !outputs.length) {
              // A routed trade the indexer recorded without any balance rows. It cannot be
              // valued or routed, so it is dropped — and counted, so the drop is visible.
              withoutBalances += 1
              continue
            }
            if (inputs.length > 1 || outputs.length > 1) multiAsset += 1
            const swappers = node.participantSwappers ?? []
            if (swappers.length > 1) multiSwapper += 1

            legCount += node.swaps?.totalCount ?? 0
            for (const record of inputs.concat(outputs)) squidAssetIds.add(String(record.assetId))

            raw.push({
              id: node.id,
              height: node.paraBlockHeight,
              timestamp: Math.floor(Date.parse(node.block.timestamp) / 1000),
              swapper: swappers[0] ?? null,
              venue: initiation(node.swaps?.nodes?.[0]?.operationId),
              hops: node.swaps?.totalCount ?? 0,
              inputs: inputs.map((r) => ({ assetId: String(r.assetId), amount: r.amount })),
              output: outputs[outputs.length - 1],
            })
          }
          if (raw.length > MAX_TRADES) {
            throw new UpstreamError(`orca returned more than ${MAX_TRADES} routed trades for blocks ${from}–${to - 1}.`, {
              kind: 'upstream',
              source: ORCA,
            })
          }
          if (!connection?.pageInfo?.hasNextPage || !nodes.length) break
          after = connection.pageInfo.endCursor
        }

        /* ---- assets: orca supplies the key, the chain registry supplies the meaning ---- */

        // orca's `assetId` is a mixed-type key — the numeric registry id for `Token` assets and
        // the EVM contract address for `Erc20` ones (HOLLAR is `0x531a…f99a`). Joining it to the
        // registry by a numeric cast would drop every Erc20 asset, which on this venue includes
        // HOLLAR, aDOT and the whole GIGA family. So the squid maps its own key to a registry
        // id, and the registry — read from the chain and self-checked above — says what that id
        // is worth. Where both have an opinion, disagreements are reported, not averaged.
        const squidIds = [...squidAssetIds]
        /** @type {Map<string, {registryId:number|null, symbol:string|null, decimals:number|null}>} */
        const squidAssets = new Map()
        for (let i = 0; i < squidIds.length; i += 400) {
          const batch = squidIds.slice(i, i + 400)
          const data = await graphql({ source: ORCA, url, query: SQUID_ASSETS, variables: { ids: batch }, timeoutMs: 30_000 })
          for (const asset of data?.assets?.nodes ?? []) {
            const registryId = Number(asset.assetRegistryId)
            squidAssets.set(String(asset.id), {
              registryId: Number.isInteger(registryId) ? registryId : null,
              symbol: asset.symbol ?? null,
              decimals: asset.decimals ?? null,
            })
          }
        }

        const unmappedAssetIds = squidIds.filter((id) => !squidAssets.has(id) || squidAssets.get(id).registryId === null)
        const registryIds = [...new Set([...squidAssets.values()].map((a) => a.registryId).filter((id) => id !== null))]
        const assets = await fetchAssets(registryIds)

        /**
         * One resolved meaning per orca asset key, and a record of where it came from.
         *
         * The chain is the authority and wins wherever it has an answer. It does not always
         * have one: an `External`-typed registry entry — an asset registered over XCM, DED and
         * DAMN among them — decodes to `symbol: null, decimals: null` on chain, because its
         * metadata lives on its own chain rather than in Hydration's registry. Dropping those
         * legs would quietly shrink the totals; taking orca's word for them and saying so does
         * not. Where BOTH have an answer and they differ, the chain is used and the
         * disagreement is reported — a decimals disagreement is a factor of ten on every
         * figure that asset touches and must never be settled silently.
         */
        const disagreements = []
        const borrowedMetadata = []
        /** @type {Map<string, {symbol:string|null, decimals:number|null, registryId:number|null}>} */
        const resolved = new Map()
        for (const squidId of squidIds) {
          const squid = squidAssets.get(squidId) ?? null
          const registryId = squid?.registryId ?? null
          const chain = registryId === null ? null : assets.get(registryId) ?? null

          if (chain && chain.decimals !== null && squid?.decimals != null && chain.decimals !== squid.decimals) {
            disagreements.push(
              `${squidId}: chain says ${chain.symbol}/${chain.decimals}, orca says ${squid.symbol}/${squid.decimals}`,
            )
          }

          if (chain && chain.decimals !== null && chain.symbol) {
            resolved.set(squidId, { symbol: chain.symbol, decimals: chain.decimals, registryId })
          } else if (squid && squid.decimals != null && squid.symbol) {
            borrowedMetadata.push(`${squid.symbol} (id ${registryId ?? squidId})`)
            resolved.set(squidId, { symbol: squid.symbol, decimals: squid.decimals, registryId })
          } else {
            resolved.set(squidId, { symbol: null, decimals: null, registryId })
          }
        }

        const unknownAssets = squidIds
          .filter((id) => resolved.get(id).decimals === null)
          .map((id) => resolved.get(id).registryId ?? id)

        const symbolOf = (squidId) => resolved.get(String(squidId))?.symbol ?? null

        // Two registered assets can carry the same ticker — a bridged USDT and a native one,
        // an Erc20 wrapper and the token it wraps. Collapsing them onto one label turns a real
        // arbitrage between two representations into a nonsensical USDT→USDT route. So a
        // symbol shared by more than one traded asset gets its registry id appended, and only
        // then.
        const symbolUsers = new Map()
        for (const squidId of squidIds) {
          const symbol = symbolOf(squidId)
          if (symbol) symbolUsers.set(symbol, (symbolUsers.get(symbol) ?? 0) + 1)
        }
        const labelOf = (squidId) => {
          const meta = resolved.get(String(squidId))
          if (!meta?.symbol) return null
          if (symbolUsers.get(meta.symbol) <= 1) return meta.symbol
          return `${meta.symbol}·${meta.registryId ?? squidId}`
        }
        const amountOf = (record) => {
          const meta = resolved.get(String(record.assetId))
          if (!meta || meta.decimals === null) return null
          const amount = Number(record.amount)
          return Number.isFinite(amount) ? amount / 10 ** meta.decimals : null
        }

        /* ---- pricing ---- */

        // Rates come only from single-asset-in, single-asset-out trades: those are the ones
        // that state a price unambiguously. A route that consumed two assets and produced one
        // states nothing about either rate on its own.
        const priceable = []
        for (const trade of raw) {
          if (trade.inputs.length !== 1) continue
          const inAmount = amountOf(trade.inputs[0])
          const outAmount = amountOf(trade.output)
          if (!inAmount || !outAmount) continue
          priceable.push({
            inSymbol: symbolOf(trade.inputs[0].assetId),
            inAmount,
            outSymbol: symbolOf(String(trade.output.assetId)),
            outAmount,
          })
        }
        const { rates } = deriveRates(priceable)

        /* ---- the canonical Trade shape ---- */

        const trades = raw.map((t) => {
          const pallet = palletName(t.swapper)
          // Volume is the INPUT side: what the trader actually sent, before any hop. Every
          // input leg is valued, and a single unpriceable leg makes the whole trade unpriced —
          // null, never 0, because "we could not value this" and "this was worth nothing" are
          // different facts.
          let usd = 0
          for (const record of t.inputs) {
            const amount = amountOf(record)
            const symbol = symbolOf(record.assetId)
            const rate = symbol === null ? undefined : rates[symbol]
            if (amount === null || rate === undefined) {
              usd = null
              break
            }
            usd += amount * rate
          }
          const firstIn = t.inputs[0]
          return {
            id: t.id,
            account: pallet ?? String(t.swapper).toLowerCase(),
            timestamp: t.timestamp,
            date: dayOf(t.timestamp),
            // The stacked dimension is HOW THE TRADE WAS INITIATED — a direct Omnipool swap, a
            // router route, a DCA schedule instalment, a batch. On a venue where a single
            // Omnipool is most of the liquidity, that is the question with an interesting
            // answer.
            venue: t.venue,
            tokenIn: labelOf(firstIn.assetId),
            tokenOut: labelOf(String(t.output.assetId)),
            amountIn: amountOf(firstIn) ?? 0,
            usd,
            hops: t.hops,
            isPallet: Boolean(pallet),
          }
        })

        /* ---- notes, generated from this payload ---- */

        const palletTrades = trades.filter((t) => t.isPallet)
        // One instant, used by both the liveness assertion and the head-age figure in `meta`,
        // so a slow render cannot make the pill and the number disagree by a minute.
        const observedAt = Date.now()
        const headAgeMinutes = Math.round((observedAt - headMs) / 60_000)
        const inflation = trades.length ? legCount / trades.length : 0
        const window = `${firstDay} to ${lastDay} UTC`
        const pagedUsd = trades.reduce((sum, t) => sum + (t.usd || 0), 0)

        // What Hydration publishes about itself, over exactly these blocks. Two defensible
        // numbers that differ by a multiple is precisely the thing a reader has to be told,
        // and it costs one 300 ms query. It is a cross-check, not the page: if it fails, the
        // page still renders and says the check did not run.
        let platform = null
        let platformError = null
        try {
          const data = await graphql({
            source: ORCA,
            url,
            query: PLATFORM_VOLUME,
            variables: { from, to: to - 1 },
            timeoutMs: 30_000,
          })
          const node = data?.platformTotalVolumesByPeriod?.nodes?.[0]
          if (node) {
            platform = {
              total: Number(node.totalVolNorm),
              omnipool: Number(node.omnipoolVolNorm),
              stableswap: Number(node.stableswapVolNorm),
              xyk: Number(node.xykpoolVolNorm),
            }
          }
        } catch (error) {
          platformError = error.message
        }
        const money0 = (n) => '$' + Math.round(n).toLocaleString('en-US')

        const notes = [
          `Hydration emits one event per swap LEG. These are ${trades.length.toLocaleString('en-US')} routed trades made of ` +
            `${legCount.toLocaleString('en-US')} legs — a factor of ${inflation.toFixed(2)}. The grouping is orca's, keyed on the ` +
            "chain's own Broadcast incremental id; counting the legs instead would multiply every dollar on this page by that factor.",
          `Window: whole UTC days, ${window}, which is blocks ${from.toLocaleString('en-US')}–${(to - 1).toLocaleString('en-US')}. ` +
            'The day boundary was read from the chain rather than assumed from a block time — block time here is a trailing ' +
            'average near 5.6–6.2 s and is not a constant.',
          `${lastDay} is still in progress: its bar covers only up to block ${head.height.toLocaleString('en-US')} at ` +
            `${head.timestamp}, so it is a partial day and will look short next to the others.`,
          `This source begins at block ${floor.paraBlockHeight.toLocaleString('en-US')} (${floorDay}). Before that date orca has ` +
            'no routed trades — which is not the same as no trading. It indexes individual swap legs back to 2024-04-28 but does ' +
            'not group them into trades before this floor, and the previous source behind this page (the generic Subsquid ' +
            'archive) saw its first `Broadcast.Swapped3` only at block 7,567,547, on 2025-05-19. A window that appears to start ' +
            'in mid-2025 is an artefact of the source, not of the venue.',
          `The window is capped at 14 days by this service, not by the data. A day is ~8,500 trades and ~4 MB from an indexer we ` +
            'do not own; thirty days would be a minute of fetching behind a spinner. The cap is a cost decision and it is the ' +
            'reason this chart is short, not a shortage of history.',
          'Accounts beginning with the ASCII "modl" are pallet accounts, not people. They are labelled as such and left in the ' +
            'totals, because the money did move; the summary states how much of the volume they are.',
          'Volume is the value of what went IN — what the trader sent, before any hop. A trade with an unpriceable input leg is ' +
            'null, not zero, and is excluded from the dollar total while still being counted.',
          'The "settled" figure is 100% by construction and is not a success rate. A swap that failed emits no event, so a ' +
            'failed trade never becomes a row here at all — this page cannot see them and does not claim to.',
          'Prices are derived from the trades themselves against dollar-pegged legs, and only from trades with one asset in and ' +
            'one out. An asset that never traded against a priced one in this window has no rate.',
          'Asset id 1 is H2O, the Omnipool hub asset. A lot of writing about Hydration, including its own older material, still ' +
            'calls it LRNA; the chain registry is the authority and it says H2O. Trades routed through the hub appear under that ' +
            'symbol.',
          `Two upstreams, cross-checked: orca (${host}) supplies the trades and the asset key, which is a registry id for native ` +
            'assets and an EVM contract address for Erc20 ones; the chain registry at rpc.hydradx.cloud is the authority on ' +
            'every symbol and decimal used to value them. Joining orca\'s key numerically instead would drop HOLLAR, aDOT and ' +
            'the whole GIGA family without a word.',
        ]

        if (platform && Number.isFinite(platform.total) && pagedUsd > 0) {
          notes.push(
            `Hydration's own indexer reports ${money0(platform.total)} of pool volume over exactly these blocks ` +
              `(${money0(platform.omnipool)} Omnipool + ${money0(platform.stableswap)} stableswap + ${money0(platform.xyk)} XYK), ` +
              `against ${money0(pagedUsd)} here — ${(platform.total / pagedUsd).toFixed(2)}× as much. Neither is wrong. That ` +
              'figure is the notional that crossed each POOL, so one route through a stableswap and the Omnipool is counted in ' +
              'both; this page counts what the trader sent, once. A "Hydration volume" number means nothing without saying which.',
          )
        } else if (platformError) {
          notes.push(`The cross-check against Hydration's own published pool volume did not run: ${platformError}`)
        }
        if (borrowedMetadata.length) {
          notes.push(
            `Hydration's own registry has no symbol or decimals for ${borrowedMetadata.length} asset(s) traded in this window ` +
              `(${some(borrowedMetadata)}) — they are registered as \`External\`, meaning their metadata lives ` +
              'on the chain they came from. Those legs are valued on orca\'s metadata instead of the chain\'s, which is one ' +
              'source rather than two agreeing.',
          )
        }

        if (clamped) {
          notes.push(
            `${days} days were requested, which reaches back before ${floorDay}. The window was cut at this source's first ` +
              'routed trade rather than drawing days that only look empty.',
          )
        }
        if (!boundaryAssisted) {
          notes.push(
            'The fast path for finding the window\'s first block did not pass its own self-check, so the boundary was found by ' +
              'a full scan instead. The window is right; it was slower to compute.',
          )
        }
        if (withoutBalances) {
          notes.push(
            `${withoutBalances.toLocaleString('en-US')} routed trade(s) in this window carry no input or output balance rows in ` +
              'orca and were dropped: there is nothing to value or to name a route with. They are not in any figure here.',
          )
        }
        if (expected !== null && expected !== raw.length + withoutBalances) {
          notes.push(
            `orca counted ${expected.toLocaleString('en-US')} routed trades in blocks ${from.toLocaleString('en-US')}–` +
              `${(to - 1).toLocaleString('en-US')} but paging returned ${(raw.length + withoutBalances).toLocaleString('en-US')}. ` +
              'That difference is a paging fault, not a rounding one; the totals here are of what was actually read.',
          )
        }
        if (multiAsset) {
          notes.push(
            `${multiAsset.toLocaleString('en-US')} ${plural(multiAsset, 'trade')} consumed or produced more than one asset. ` +
              `${multiAsset === 1 ? 'It is' : 'They are'} valued over every input leg, but the route label names only the ` +
              'first asset in and the last out.',
          )
        }
        if (multiSwapper) {
          notes.push(
            `${multiSwapper.toLocaleString('en-US')} ${plural(multiSwapper, 'trade')} list more than one swapper. The first is ` +
              'used as the account, so those rows attribute the whole trade to one of several participants.',
          )
        }
        if (unmappedAssetIds.length) {
          notes.push(
            `orca returned ${unmappedAssetIds.length} asset key(s) it cannot map to a registry id ` +
              `(${some(unmappedAssetIds)}). Legs in those assets are unpriced rather than guessed at.`,
          )
        }
        if (disagreements.length) {
          notes.push(
            `orca and the chain registry disagree about ${disagreements.length} asset(s): ${some(disagreements, 4)}. ` +
              'The chain is used. A decimals disagreement is a factor of ten on everything that asset touches, so it is stated ' +
              'rather than resolved quietly.',
          )
        }
        if (failures.length) {
          notes.push(`${failures.length} orca host(s) did not answer and were skipped: ${failures.join('; ')}.`)
        }
        // The head-age warning that used to be pushed here is now `meta.liveness`, which says
        // the same thing in the shape every other source says it in, and gets a pill and a
        // banner instead of being the fourteenth bullet in a list. Two renderings of one fact
        // is how they end up disagreeing; see `livenessOf` above.

        const result = aggregate({
          trades,
          rates,
          meta: {
            // The assertion the page renders as a pill, a banner and a data-notes line. Same
            // key, same shape, same place as asset-hub, bulletin and dotlake put theirs.
            liveness: livenessOf({ observedAt, head, headMs, firstDay, lastDay }),
            venue: 'Hydration',
            venueUrl: 'https://app.hydration.net',
            source: 'hydration',
            sourceLabel: 'Hydration liquidity-pools squid (orca) + chain registry',
            sourceUrl: `${host} · rpc.hydradx.cloud`,
            unit: 'trade',
            unitPlural: 'trades',
            venueLabel: 'how the trade was initiated',
            window,
            windowDays: days,
            windowFrom: firstDay,
            windowTo: lastDay,
            windowClamped: clamped,
            partialDay: lastDay,
            coverageFrom: floorDay,
            coverageFromBlock: floor.paraBlockHeight,
            blockRange: [from, to - 1],
            headBlock: head.height,
            headTime: head.timestamp,
            headAgeMinutes,
            orcaHost: host,
            pagesFetched: pages,
            expectedTrades: expected,
            tradesWithoutBalances: withoutBalances,
            legCount,
            legInflation: inflation,
            platformPoolVolume: platform,
            tradeCount: trades.length,
            palletTrades: palletTrades.length,
            palletUsd: palletTrades.reduce((s, t) => s + (t.usd || 0), 0),
            unknownAssets,
            unmappedAssetIds,
            assetDisagreements: disagreements,
            borrowedMetadata,
            fetchedAt: new Date().toISOString(),
            notes,
          },
        })

        return trimForWire(spanWindow(result, firstDay, lastDay))
      },
    },
  },
}
