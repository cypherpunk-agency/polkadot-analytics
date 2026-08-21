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

import { callUpstream, graphql, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { deriveRates } from '../../src/core/pricing.js'
import { aggregate, trimForWire, dayOf } from '../../src/core/swaps.js'
import { twox128, xxhash64 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { toHex, fromHex, utf8, concat, u32le } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'
import { encodeSs58 } from '../../src/core/codec/ss58.js'
import { structuralLabel } from '../../src/core/topology.js'
import { liveness } from '../../src/core/liveness.js'
import { keccakHex } from '../../src/core/codec/keccak.js'
// Decision 0009: pricing is a source others COMPOSE. `capital` below calls this module's
// `market` operation for the oracle, the money-market reserves and the Omnipool balance sheet
// rather than reimplementing any of them. One level deep — the pricer calls no one.
import hydrationEvm from './hydration-evm.mjs'

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

/** The bare hostname, which is what the job engine's politeness gate keys on — one in-flight
 *  request per host, and the hostname string belongs here rather than in the engine. */
const hostOf = (url) => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const RPC_HOST = hostOf(RPC)

const PAGE = 1000

/** Nominal 6 s blocks. Used ONLY to guess where to start looking for a UTC day boundary — the
 *  boundary itself comes from the chain, and the guess is checked before it is trusted. Real
 *  block time on this chain is a trailing average around 5.6–6.2 s and is never a constant. */
const NOMINAL_BLOCKS_PER_DAY = 14_400

/** A ceiling on how much of somebody else's database we will pull into a 256 MB container in
 *  one request. Reaching it is a bug or a runaway window, so it throws rather than truncating. */
const MAX_TRADES = 250_000

/**
 * The same ceiling for ONE account, and it is not the same number because the shape of the risk
 * is different. Measured against orca on 2026-08-20 over a seven-day block range: the busiest
 * addresses on this venue are pallet accounts — `pallet:py/trsry` 10,250 trades, `pallet:feeproc/`
 * 9,165 — so a fourteen-day window on the busiest account is ~20,000 rows and ~20 pages. Forty
 * thousand leaves headroom above that and still refuses a window nobody would wait through.
 * It REFUSES rather than truncating, for the reason the window cap does: a silently short
 * account is a net-flow figure that is simply wrong and looks fine.
 */
const MAX_ACCOUNT_TRADES = 40_000

/** Bigger pages than the window pager's 1,000, because the cost of an orca page is almost all
 *  fixed: measured 2026-08-20 on the busiest account, 1,000 rows took 1.71 s and 3,000 took
 *  1.88 s. Ten pages of a thousand is 17 s; four of three thousand is 7.5 s, for the same rows. */
const ACCOUNT_PAGE = 3000

/** How many of an account's trades cross the wire. Every figure on the page is computed over
 *  ALL of them server-side; this caps only the transcript, which nobody scrolls past. */
const ACCOUNT_TRADE_ROWS = 300

/**
 * Hydration's display prefix, as `server/sources/arbs-hydration.mjs` already uses.
 *
 * ⚠️ It is a CONVENTION, not something this chain will tell you. Hydration's runtime constant
 * `System::SS58Prefix` reads **0** (decoded out of `state_getMetadata` on 2026-08-20 — see
 * docs/platform/hydration.md), while every wallet, explorer and the Hydration app itself render
 * these accounts under 63, which is what makes them start with a `7`. Both encodings are the
 * same 32 bytes and both are "valid"; only one is the string a reader will recognise. Nothing
 * here JOINS on the address — the public key does that — so the prefix is display only.
 */
const SS58_HYDRATION = 63

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
async function fetchAssets(ids, { run = (fn) => fn() } = {}) {
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id >= 0)
  /** @type {Map<number, ReturnType<typeof decodeAssetDetails> & {id:number}>} */
  const assets = new Map()

  for (let i = 0; i < wanted.length; i += 200) {
    const batch = wanted.slice(i, i + 200)
    const changes = await run(() =>
      jsonRpc({
        source: 'hydration-rpc',
        url: RPC,
        method: 'state_queryStorageAt',
        params: [batch.map(assetKey)],
        timeoutMs: 30_000,
      }),
    )
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

async function verifyRegistry({ run } = {}) {
  const assets = await fetchAssets(CANARIES.map(([id]) => id), { run })
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

/* ------------------------------------------------------------------ one account ---- */
//
// ── orca filters by swapper, server-side, and it is fast ─────────────────────────────────────
// `RoutedTradeFilter.participantSwappers` is a `StringListFilter` (introspected 2026-08-20), so
// `contains: [$account]` is an indexed array-containment test rather than a download of the
// window followed by a filter in this process. Measured the same day against
// orca-prod-pool-01: 1,078 trades for one account over the WHOLE index in 1.0 s, 116 over a
// seven-day block range in 0.6 s. That is what makes an account view affordable at all — the
// alternative is pulling ~60,000 trades to draw a hundred.
//
// `contains` matches the account ANYWHERE in the array, while `valueTrades` attributes a trade
// to `participantSwappers[0]`. Those differ only for multi-swapper trades, which were 0 of
// 9,537 in a 24 h sample — but "rare" is not "never", so the operation counts the rows where
// the requested account is not the first swapper and the page states it.

/** Everything about an account that is one number: how much it did in the window, how much it
 *  ever did, when it started and stopped, and what orca thinks the account IS.
 *
 *  `firstEver`/`lastEver` are not decoration. They are the only honest way for a window-bounded
 *  page to say how much of an account's life it is NOT showing. */
const ACCOUNT_FRAME = `
query AccountFrame($account: String!, $from: Int!, $to: Int!) {
  ever: routedTrades(filter: { participantSwappers: { contains: [$account] } }) { totalCount }
  inWindow: routedTrades(
    filter: {
      participantSwappers: { contains: [$account] }
      paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to }
    }
  ) { totalCount }
  firstEver: routedTrades(
    filter: { participantSwappers: { contains: [$account] } }
    orderBy: [PARA_BLOCK_HEIGHT_ASC, ID_ASC]
    first: 1
  ) { nodes { paraBlockHeight block { timestamp } } }
  lastEver: routedTrades(
    filter: { participantSwappers: { contains: [$account] } }
    orderBy: [PARA_BLOCK_HEIGHT_DESC, ID_DESC]
    first: 1
  ) { nodes { paraBlockHeight block { timestamp } } }
  acct: accounts(filter: { id: { equalTo: $account } }) { nodes { id accountType } }
}`

/** The account's own trades, newest first — the order the reader wants and the order the page
 *  draws. Same node shape as `TRADES`, so `valueTrades` values both identically. */
const ACCOUNT_TRADES = `
query AccountTrades($account: String!, $from: Int!, $to: Int!, $first: Int!, $after: Cursor) {
  routedTrades(
    filter: {
      participantSwappers: { contains: [$account] }
      paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to }
    }
    orderBy: [PARA_BLOCK_HEIGHT_DESC, ID_DESC]
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

/** A slice of the venue's order book, for price discovery only — the swapper, the venue and the
 *  leg count are not asked for, because nothing here reads them. */
const RATE_SAMPLE = `
query RateSample($from: Int!, $to: Int!, $first: Int!) {
  routedTrades(
    filter: { paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to } }
    orderBy: [PARA_BLOCK_HEIGHT_ASC, ID_ASC]
    first: $first
  ) {
    nodes {
      routeTradeInputs { nodes { assetId amount } }
      routeTradeOutputs { nodes { assetId amount } }
    }
  }
}`

/** First host that answers. A dead host is a reported fact, not a silent failover.
 *  `run(host, fn)` wraps the attempt — the job passes the politeness gate, which needs the
 *  hostname it is gating; the request path passes nothing and calls straight through. */
async function connect(run = (_host, fn) => fn()) {
  const failures = []
  for (const url of ORCA_HOSTS) {
    const host = hostOf(url)
    try {
      const data = await run(host, () => graphql({ source: ORCA, url, query: HEAD_AND_FLOOR, timeoutMs: 20_000 }))
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

/* --------------------------------------------------- assets, and what a trade was worth ---- */
//
// Everything below is shared by BOTH readers of this module: the live `swaps` operation and the
// stored `swaps-daily` job. It is one implementation on purpose. A decimals rule or a pricing
// rule that exists twice is a rule that will be corrected once, and the half nobody looked at
// then renders a plausible number that is wrong by 10ⁿ — which is the failure this whole repo
// is arranged against.

/**
 * orca's own asset table: its mixed-type key mapped to a registry id, plus its own opinion of
 * the symbol and decimals. `run` wraps each call, so a job can put it behind the politeness
 * gate while the request path calls it directly.
 */
async function fetchSquidAssets({ url, ids, run = (fn) => fn() }) {
  /** @type {Map<string, {registryId:number|null, symbol:string|null, decimals:number|null}>} */
  const out = new Map()
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400)
    const data = await run(() =>
      graphql({ source: ORCA, url, query: SQUID_ASSETS, variables: { ids: batch }, timeoutMs: 30_000 }),
    )
    for (const asset of data?.assets?.nodes ?? []) {
      const registryId = Number(asset.assetRegistryId)
      out.set(String(asset.id), {
        registryId: Number.isInteger(registryId) ? registryId : null,
        symbol: asset.symbol ?? null,
        decimals: asset.decimals ?? null,
      })
    }
  }
  return out
}

/** The registry ids worth asking the chain about — deduped, nulls dropped. */
const registryIdsOf = (squidAssets) =>
  [...new Set([...squidAssets.values()].map((a) => a.registryId).filter((id) => id !== null))]

/**
 * One resolved meaning per orca asset key, and a record of where it came from.
 *
 * orca's `assetId` is a mixed-type key — the numeric registry id for `Token` assets and the EVM
 * contract address for `Erc20` ones (HOLLAR is `0x531a…f99a`). Joining it to the registry by a
 * numeric cast would drop every Erc20 asset, which on this venue includes HOLLAR, aDOT and the
 * whole GIGA family. So the squid maps its own key to a registry id, and the registry — read
 * from the chain and self-checked by `verifyRegistry` — says what that id is worth.
 *
 * The chain is the authority and wins wherever it has an answer. It does not always have one:
 * an `External`-typed registry entry — an asset registered over XCM, DED and DAMN among them —
 * decodes to `symbol: null, decimals: null` on chain, because its metadata lives on its own
 * chain rather than in Hydration's registry. Dropping those legs would quietly shrink the
 * totals; taking orca's word for them and saying so does not. Where BOTH have an answer and
 * they differ, the chain is used and the disagreement is reported — a decimals disagreement is
 * a factor of ten on every figure that asset touches and must never be settled silently.
 */
export function resolveAssetMeaning(squidIds, squidAssets, assets) {
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

  const unmappedAssetIds = squidIds.filter((id) => !squidAssets.has(id) || squidAssets.get(id).registryId === null)
  const unknownAssets = squidIds
    .filter((id) => resolved.get(id).decimals === null)
    .map((id) => resolved.get(id).registryId ?? id)

  const symbolOf = (squidId) => resolved.get(String(squidId))?.symbol ?? null

  // Two registered assets can carry the same ticker — a bridged USDT and a native one, an Erc20
  // wrapper and the token it wraps. Collapsing them onto one label turns a real arbitrage
  // between two representations into a nonsensical USDT→USDT route. So a symbol shared by more
  // than one traded asset gets its registry id appended, and only then.
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

  return { resolved, disagreements, borrowedMetadata, unmappedAssetIds, unknownAssets, symbolOf, labelOf, amountOf }
}

/**
 * Rates out of the order book, then the canonical `Trade` shape.
 *
 * Rates come only from single-asset-in, single-asset-out trades: those are the ones that state a
 * price unambiguously. A route that consumed two assets and produced one states nothing about
 * either rate on its own.
 *
 * Volume is the INPUT side — what the trader actually sent, before any hop. Every input leg is
 * valued, and a single unpriceable leg makes the whole trade unpriced: `null`, never `0`,
 * because "we could not value this" and "this was worth nothing" are different facts.
 *
 * `priceFrom` exists for the `account` operation and changes nothing for the two callers that
 * do not pass it. One account's trades are not an order book: an address that only ever swapped
 * DOT for GDOT never touched a dollar-pegged leg, so deriving rates from its own trades alone
 * prices NOTHING and the whole page reads as "this account moved no value". So the account view
 * hands in a sample of the venue's book over the same blocks, purely as price observations —
 * they are never counted, never listed, and never appear in a total.
 *
 * @param {Array<object>} raw   normalised orca rows, as the pager below builds them
 * @param {ReturnType<typeof resolveAssetMeaning>} meaning
 * @param {{priceFrom?: Array<{inputs: object[], output: object}>}} [options]
 *        extra rows used for RATE DERIVATION ONLY
 */
export function valueTrades(raw, { symbolOf, labelOf, amountOf }, { priceFrom = null } = {}) {
  const priceable = []
  for (const trade of priceFrom ? priceFrom.concat(raw) : raw) {
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

  const trades = raw.map((t) => {
    const pallet = palletName(t.swapper)
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
      // The 32-byte public key, ALWAYS — and separate from `account` above, which is a display
      // key that collapses a pallet account onto its PalletId. `pallet:py/trsry` cannot be
      // turned back into an address: `PalletId::into_sub_account_truncating` puts arbitrary
      // bytes after the eight-byte id, and `palletName` stops at the first of them, so
      // reconstructing the account from the label would silently invent a different account for
      // every sub-account. Every join and every link is on this field; nothing joins on the
      // display string. See CLAUDE.md — the same account is a different string on every chain.
      accountId: t.swapper ? String(t.swapper).toLowerCase() : null,
      timestamp: t.timestamp,
      height: t.height ?? null,
      date: dayOf(t.timestamp),
      // The stacked dimension is HOW THE TRADE WAS INITIATED — a direct Omnipool swap, a router
      // route, a DCA schedule instalment, a batch. On a venue where a single Omnipool is most of
      // the liquidity, that is the question with an interesting answer.
      venue: t.venue,
      tokenIn: labelOf(firstIn.assetId),
      tokenOut: labelOf(String(t.output.assetId)),
      amountIn: amountOf(firstIn) ?? 0,
      // `null`, not `0`: an asset with no decimals on file produced an amount we cannot state,
      // which is not the same as a leg that returned nothing. The account view nets these per
      // asset and a zero here would net out as a real, wrong position change.
      amountOut: amountOf(t.output),
      usd,
      hops: t.hops,
      isPallet: Boolean(pallet),
    }
  })

  return { trades, rates }
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
 * The window, in whole UTC days, resolved to real block heights.
 *
 * ONE implementation, used by both `swaps` and `account`, and that is the point rather than a
 * tidiness preference: the account view is drawn from a link on the swaps page and claims to
 * cover the same window. Two copies of this arithmetic would agree until the day one of them
 * was corrected, and then the account page would quietly be showing a different fortnight than
 * the ranking that sent the reader to it — with both pages stating a window, and the two
 * sentences disagreeing.
 *
 * Both edges come from the chain. Never from multiplying an assumed block time: this chain's
 * has moved by a factor of 2.9 across the range orca holds (CLAUDE.md, twice).
 *
 * @returns {{firstDay:string, lastDay:string, floorDay:string, from:number, to:number,
 *            clamped:boolean, boundaryAssisted:boolean}}
 */
export async function resolveWindow({ url, head, headMs, floor, floorMs, days }) {
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

  return { firstDay, lastDay, floorDay, from, to: head.height + 1, clamped, boundaryAssisted }
}

/* ------------------------------------------- price discovery for a window, sampled ---- */
//
// The `swaps` operation prices its trades against every other trade in the same window, because
// it has already paid to fetch all of them. The `account` operation has not, and must not: the
// whole reason an account view is affordable is that orca filters by swapper server-side, and
// pulling ~60,000 trades to price the 117 that belong to one address would throw that away and
// make every distinct address a full window fetch of somebody else's database.
//
// So price discovery is a SAMPLE of the same blocks, and three things about it are deliberate:
//
//   · it SPANS the window rather than sitting at one end. A rate median taken from the last
//     four hours of a fortnight is a today-price applied to a fortnight of trades, and it would
//     look exactly as plausible as a correct one.
//   · it is MEMOISED PER WINDOW, not per account. Every account viewed inside the same 15
//     minutes shares one sample, so the tenth reader costs nothing — and, more importantly,
//     two accounts viewed minutes apart are valued by the same rate table rather than by two
//     independently-sampled ones that quietly disagree.
//   · it is stated on the page. These rates are NOT the ones /hydration/ derived from the whole
//     window, and a reader comparing a dollar figure between the two pages must be told why
//     they can differ rather than left to discover it.

/** Five chunks, evenly spaced across the window's blocks. Measured against orca on 2026-08-20:
 *  a `routedTrades` page costs ~1.0–1.3 s almost independently of its size (200 rows 1.07 s,
 *  800 rows 1.27 s), so the cost here is the number of QUERIES, not the number of rows. Five
 *  chunks of a thousand is one round of parallel requests and up to 5,000 observations. */
const RATE_SAMPLE_CHUNKS = 5
const RATE_SAMPLE_PER_CHUNK = 1000
/** The same 15 minutes as the `swaps` cache: the two are re-derived on the same rhythm. */
const RATE_SAMPLE_TTL_MS = 900_000
/** Windows are `days` × the head block, so the key space is tiny in practice. Bounded anyway —
 *  this is reachable from a public URL and an unbounded memo on one is a memory-exhaustion vector. */
const RATE_SAMPLE_MEMO = 12

/** @type {Map<string, {at:number, promise:Promise<{rows:Array<object>, chunks:number}>}>} */
const rateSampleMemo = new Map()

async function fetchRateSample(url, from, to) {
  const span = Math.max(1, to - from)
  const chunks = Math.max(1, Math.min(RATE_SAMPLE_CHUNKS, Math.ceil(span / RATE_SAMPLE_PER_CHUNK)))
  const width = Math.ceil(span / chunks)

  const ranges = []
  for (let i = 0; i < chunks; i += 1) {
    const start = from + i * width
    if (start >= to) break
    ranges.push([start, Math.min(to, start + width)])
  }

  const pages = await Promise.all(
    ranges.map(([a, b]) =>
      graphql({
        source: ORCA,
        url,
        query: RATE_SAMPLE,
        variables: { from: a, to: b, first: RATE_SAMPLE_PER_CHUNK },
        timeoutMs: 60_000,
      }),
    ),
  )

  const rows = []
  for (const data of pages) {
    for (const node of data?.routedTrades?.nodes ?? []) {
      const inputs = node.routeTradeInputs?.nodes ?? []
      const outputs = node.routeTradeOutputs?.nodes ?? []
      // Only one-asset-in, one-asset-out states a rate unambiguously; `deriveRates` drops the
      // rest anyway, and not sending them is a smaller payload off a database we do not own.
      if (inputs.length !== 1 || !outputs.length) continue
      const last = outputs[outputs.length - 1]
      rows.push({
        inputs: [{ assetId: String(inputs[0].assetId), amount: inputs[0].amount }],
        output: { assetId: String(last.assetId), amount: last.amount },
      })
    }
  }
  return { rows, chunks: ranges.length }
}

/** Single-flight and TTL, for the same reason server/lib/cache.mjs has both: a cold cache is
 *  exactly when several readers arrive at once, and without single-flight this memo would make
 *  that worse rather than better. A rejected sample is not retained. */
function rateSample(url, from, to) {
  const key = `${from}-${to}`
  const hit = rateSampleMemo.get(key)
  if (hit && Date.now() - hit.at < RATE_SAMPLE_TTL_MS) return hit.promise

  const promise = fetchRateSample(url, from, to).catch((error) => {
    rateSampleMemo.delete(key)
    throw error
  })
  rateSampleMemo.set(key, { at: Date.now(), promise })
  while (rateSampleMemo.size > RATE_SAMPLE_MEMO) {
    rateSampleMemo.delete(rateSampleMemo.keys().next().value)
  }
  return promise
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


/* ------------------------------------------------------- stored history: mode A ---- */
//
// The live `swaps` operation above answers a request by fetching the window every time, which is
// why it is capped at fourteen days. This is the other half: one closed UTC day per stored fact,
// fetched once and never again. Together they are the two modes of docs/concept/plan.md §2 —
// the cache for what can still change, the store for what cannot.
//
// ── why the identity is a MONTH and the segment is a DAY ─────────────────────────────────────
// A fact is keyed by `(source, operation, canonical params, segment)`. The params are part of
// the key, so two identities NEVER share a segment: an operation parameterised by an arbitrary
// `{from, to}` range would refetch and re-store the same day once per distinct range a reader
// asks for, and a year of overlapping windows would cost a year of orca traffic each time. The
// identity therefore has to be a fixed bucket that many readers land on, and it has to be a
// bucket that can be `immutable` — which rules out "everything up to now", because a job that
// reaches `done` frees nothing: the demand path answers "complete" from then on and no later day
// is ever fetched (server/lib/demand.mjs). A calendar month is the smallest bucket that is both.
//
// The cost of that choice, stated rather than discovered: the CURRENT month is not servable from
// the store at all, and last month's days only become servable once the month has ended. A page
// that wants both history and this week reads the store for whole past months and the live
// `swaps` operation for the tail. That seam is real; it is not hidden.
//
// ── what "immutable" means here, and where the guarantee actually comes from ─────────────────
// `immutable()` is a pure function of the params and the wall clock — it cannot ask orca
// anything — so it is the cheap gate, not the guarantee: the month must be entirely in the past
// plus a settling margin. The GUARANTEE is in `nextBatch`, which refuses to write a day unless
// orca has indexed a block at or after the day's END instant. A squid that is hours or weeks
// behind therefore produces a failed attempt, never a truncated day frozen into the store
// forever. That inversion is deliberate: a wrong day here would render perfectly.

/** Stamped on every row. Bump it when the payload's meaning changes, so a stored fact can be
 *  told apart from one produced by different arithmetic (plan §6.1). */
const SWAPS_DAILY_VERSION = 'hydration/swaps-daily@1'

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/

/** How long after a month ends before its days are treated as settled. orca ran 26 s behind the
 *  chain when this was written (verified 2026-08-20), so two hours is ~275× the observed lag —
 *  and it costs nothing, because the days it delays are days nobody could have read yet. The
 *  real protection against a lagging indexer is the head check in `nextBatch`. */
const SETTLE_MS = 2 * 60 * 60_000

/** Per-day list caps. A stored day is a summary, not a transcript: the demand envelope returns
 *  EVERY segment of an identity in one response with no paging (server/lib/demand.mjs), so a
 *  month of raw trades — ~340,000 rows, ~150 MB — is not a payload anybody can serve. */
const TOP_ACCOUNTS = 50
const TOP_ROUTES = 40

/** Blocks to step past a day's first block before looking for its last. Never a block TIME:
 *  Hydration's has ranged from 13.96 s/block (2025-01-25) to 4.88 s (2026-07-15) — a day has
 *  been as short as 6,188 blocks and as long as 17,702 (verified live, 2026-08-20). The hint is
 *  the previous day's own measured block count, cut by a quarter, and the query checks it. */
const FIRST_DAY_HINT_BLOCKS = 4_000

const monthOf = (month) => month.split('-').map(Number)

/** The instant a month ends, as ms epoch. UTC throughout: `Date.UTC` has no DST to get wrong. */
function monthEndMs(month) {
  const [year, index] = monthOf(month)
  return index === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index, 1)
}

/** Every UTC day in the month, as ISO dates — which is also the segment id, and ISO dates sort
 *  as strings in their real order. A counter here would draw the chart out of sequence.
 *  Exported, with `monthIsSettled` and `summariseDay`, because those three are the parts of this
 *  job that can be tested without an upstream — see server/test/hydration-swaps-daily.test.mjs. */
export function daysOfMonth(month) {
  const [year, index] = monthOf(month)
  const days = []
  for (let at = Date.UTC(year, index - 1, 1); at < monthEndMs(month); at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10))
  }
  return days
}

/**
 * THE most dangerous line in this file (docs/architecture/jobs.md). Total by construction: an
 * unparseable month is not immutable, it is refused — a predicate that throws would burn the
 * job's attempt budget on a design error, and one that is wrong in the permissive direction
 * freezes a partial answer forever.
 */
export function monthIsSettled(params, now = Date.now()) {
  const month = params?.month
  if (typeof month !== 'string' || !MONTH_RE.test(month)) return false
  return now >= monthEndMs(month) + SETTLE_MS
}

/* ---- the queries this job adds, beyond the ones the live operation already uses ---- */

/** Head, floor, and the day's END boundary, in one request. `probe` is the self-check on the
 *  height hint: a hint that has accidentally overshot the boundary would return the hint block
 *  itself and the day would silently end early. `edge` is the OTHER self-check — the day's first
 *  block and the one before it, so the boundary carried forward in the cursor is re-proved
 *  against the chain's own timestamps rather than trusted for a month at a time. */
const DAY_FRAME = `
query DayFrame($est: Int!, $from: Int!, $prev: Int!, $at: Datetime!) {
  head: blocks(orderBy: HEIGHT_DESC, first: 1) { nodes { height timestamp } }
  floor: routedTrades(orderBy: PARA_BLOCK_HEIGHT_ASC, first: 1) { nodes { paraBlockHeight block { timestamp } } }
  probe: blocks(filter: { height: { equalTo: $est } }) { nodes { height timestamp } }
  edge: blocks(filter: { height: { greaterThanOrEqualTo: $prev, lessThanOrEqualTo: $from } }, orderBy: HEIGHT_ASC) {
    nodes { height timestamp }
  }
  boundary: blocks(
    filter: { height: { greaterThanOrEqualTo: $est }, timestamp: { greaterThanOrEqualTo: $at } }
    orderBy: HEIGHT_ASC
    first: 1
  ) { nodes { height timestamp } }
}`

/** The same, with no hint to check — the first day of a month has no previous boundary to step
 *  from. 1.9–5.0 s against a 13.7 M-row table (measured 2026-08-20), paid once per month. */
const FIRST_FRAME = `
query FirstFrame($at: Datetime!) {
  head: blocks(orderBy: HEIGHT_DESC, first: 1) { nodes { height timestamp } }
  floor: routedTrades(orderBy: PARA_BLOCK_HEIGHT_ASC, first: 1) { nodes { paraBlockHeight block { timestamp } } }
  boundary: blocks(filter: { timestamp: { greaterThanOrEqualTo: $at } }, orderBy: HEIGHT_ASC, first: 1) {
    nodes { height timestamp }
  }
}`

/**
 * Everything about the day that is one number: how many trades orca counts in it, how many
 * BLOCKS it holds, and Hydration's own published pool volume over exactly those blocks.
 *
 * The block count is the completeness check, and it is free here. A parachain numbers its blocks
 * consecutively, so `blocks` in `[from, to)` must be exactly `to - from`; a squid that skipped a
 * block would otherwise hand us a day that is short by however many trades were in it, with
 * nothing anywhere saying so. Ten days sampled across the whole range matched exactly
 * (2026-08-20), so a mismatch is a real fault rather than a quirk to tolerate.
 */
const DAY_STATS = `
query DayStats($from: Int!, $to: Int!, $last: Int!) {
  trades: routedTrades(filter: { paraBlockHeight: { greaterThanOrEqualTo: $from, lessThan: $to } }) { totalCount }
  blocks(filter: { height: { greaterThanOrEqualTo: $from, lessThan: $to } }) { totalCount }
  platformTotalVolumesByPeriod(filter: { startBlockNumber: $from, endBlockNumber: $last }) {
    nodes { totalVolNorm omnipoolVolNorm stableswapVolNorm xykpoolVolNorm }
  }
}`

/**
 * Asset metadata memoised for the life of the worker PROCESS, which is short by design: the
 * worker drains the queue and exits (job-worker.mjs). Decimals and symbols do not change per
 * day, and re-reading them for every one of 596 days would be 596 RPC round-trips to say the
 * same thing. Misses are remembered too — an id the registry does not know today will not know
 * itself any better on the next day of the same backfill — and a restarted worker asks again.
 */
const registryMemo = new Map()
const registryMisses = new Set()
const squidAssetMemo = new Map()

/** First orca host that answers this query, gated per host. A host that did not answer is
 *  RETURNED alongside the data rather than swallowed — the caller records it on the day, so a
 *  fact fetched from the second host says so instead of looking identical to one from the
 *  first. */
async function orcaQuery({ gate, query, variables, timeoutMs }) {
  const failures = []
  for (const url of ORCA_HOSTS) {
    const host = hostOf(url)
    try {
      const data = await gate(host, () => graphql({ source: ORCA, url, query, variables, timeoutMs }))
      return { data, url, host, failures }
    } catch (error) {
      failures.push(`${host}: ${error.message}`)
    }
  }
  throw new UpstreamError(`no orca host answered — ${failures.join('; ')}`, { kind: 'transport', source: ORCA })
}

/** Round money to cents and rates to six significant figures. Not cosmetic: a raw double prints
 *  as 17 characters, and this is multiplied by every list in every one of ~600 stored days. */
const money = (n) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100)
const sig6 = (n) => (Number.isFinite(n) ? Number(n.toPrecision(6)) : null)

/** One day of trades, rolled up into the payload that is actually stored. */
export function summariseDay({ date, trades, rates, blocks, platform, quality }) {
  const byVenue = new Map()
  const byAsset = new Map()
  const byRoute = new Map()
  const byAccount = new Map()

  let usd = 0
  let unpriced = 0
  let legs = 0
  let palletTrades = 0
  let palletUsd = 0

  for (const trade of trades) {
    const value = trade.usd ?? 0
    if (trade.usd === null) unpriced += 1
    else usd += value
    legs += trade.hops ?? 0
    if (trade.isPallet) {
      palletTrades += 1
      palletUsd += value
    }

    const venue = byVenue.get(trade.venue) ?? { venue: trade.venue, usd: 0, count: 0 }
    venue.usd += value
    venue.count += 1
    byVenue.set(trade.venue, venue)

    const inSymbol = trade.tokenIn ?? '?'
    const asset = byAsset.get(inSymbol) ?? { symbol: inSymbol, usd: 0, tradesIn: 0, tradesOut: 0 }
    asset.usd += value
    asset.tradesIn += 1
    byAsset.set(inSymbol, asset)
    const outSymbol = trade.tokenOut ?? '?'
    const out = byAsset.get(outSymbol) ?? { symbol: outSymbol, usd: 0, tradesIn: 0, tradesOut: 0 }
    out.tradesOut += 1
    byAsset.set(outSymbol, out)

    const routeName = `${inSymbol}→${outSymbol}`
    const route = byRoute.get(routeName) ?? { route: routeName, usd: 0, count: 0 }
    route.usd += value
    route.count += 1
    byRoute.set(routeName, route)

    const account = byAccount.get(trade.account) ?? {
      account: trade.account,
      usd: 0,
      count: 0,
      pallet: trade.isPallet,
    }
    account.usd += value
    account.count += 1
    byAccount.set(trade.account, account)
  }

  const accounts = [...byAccount.values()].sort((a, b) => b.usd - a.usd)
  // Shares are computed over EVERY account and then the list is trimmed, so "top four share"
  // stays a share of everything rather than a share of what survived the trim.
  const shareOf = (n) => (usd > 0 ? (accounts.slice(0, n).reduce((sum, a) => sum + a.usd, 0) / usd) * 100 : null)

  return {
    date,
    coverage: 'indexed',
    blocks,
    trades: trades.length,
    legs,
    // Hydration emits one event per swap LEG. Kept per day because it is the one number that
    // says whether the grouping upstream is still happening at all.
    legInflation: trades.length ? sig6(legs / trades.length) : null,
    usd: money(usd),
    // `null` is not `0`: a trade with an unpriceable input leg is counted here and left out of
    // the dollar total, so the two numbers disagree by exactly this much.
    unpricedTrades: unpriced,
    accounts: accounts.length,
    pallet: { trades: palletTrades, usd: money(palletUsd) },
    topFourShare: sig6(shareOf(4)),
    topTenShare: sig6(shareOf(10)),
    venues: [...byVenue.values()].sort((a, b) => b.usd - a.usd).map((v) => ({ ...v, usd: money(v.usd) })),
    assets: [...byAsset.values()].sort((a, b) => b.usd - a.usd).map((a) => ({ ...a, usd: money(a.usd) })),
    routes: [...byRoute.values()]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, TOP_ROUTES)
      .map((r) => ({ ...r, usd: money(r.usd) })),
    routesTotal: byRoute.size,
    topAccounts: accounts.slice(0, TOP_ACCOUNTS).map((a) => ({ ...a, usd: money(a.usd) })),
    // The day's own price discovery, kept because it is the cheapest daily price series on this
    // venue and because every dollar above was computed with it. Rates are derived from THIS
    // day's trades alone, so a symbol's rate varies day to day — which is the point.
    rates: Object.fromEntries(Object.entries(rates).map(([symbol, rate]) => [symbol, sig6(rate)])),
    platform,
    quality,
  }
}

/** One day, fetched and summarised. Every upstream call is gated on the host it goes to. */
async function ingestDay({ gate, day, fromBlock, fromBlockAt, hintBlocks }) {
  const dayStart = `${day}T00:00:00Z`
  const dayEnd = `${addDaysIso(day, 1)}T00:00:00Z`

  // The registry decode is trusted by every dollar below, so it is re-checked against three
  // known assets on every batch — a runtime upgrade mid-backfill must fail loudly rather than
  // rescale the rest of the history.
  await verifyRegistry({ run: (fn) => gate(RPC_HOST, fn) })

  /* ---- the day's block window, read from the chain, never multiplied out of a block time ---- */

  let url
  let head
  let floor
  let from = fromBlock
  let fromAt = fromBlockAt ?? null
  const hostFailures = []

  if (from === null || from === undefined) {
    const first = await orcaQuery({ gate, query: FIRST_FRAME, variables: { at: dayStart }, timeoutMs: 120_000 })
    hostFailures.push(...first.failures)
    url = first.url
    head = first.data?.head?.nodes?.[0]
    floor = first.data?.floor?.nodes?.[0]
    const start = first.data?.boundary?.nodes?.[0]
    if (!head || !floor) throw new UpstreamError('orca answered without a head block or a first routed trade.', { kind: 'upstream', source: ORCA })
    if (!start) {
      throw new UpstreamError(`orca has no block at or after ${dayStart}; its head is #${head.height} at ${head.timestamp}.`, {
        kind: 'upstream',
        source: ORCA,
      })
    }
    from = start.height
    fromAt = start.timestamp
  }

  const est = from + Math.max(1, hintBlocks ?? FIRST_DAY_HINT_BLOCKS)
  const frame = await orcaQuery({
    gate,
    query: DAY_FRAME,
    variables: { est, from, prev: Math.max(1, from - 1), at: dayEnd },
    timeoutMs: 120_000,
  })
  hostFailures.push(...frame.failures)
  url = frame.url
  head = frame.data?.head?.nodes?.[0] ?? head
  floor = frame.data?.floor?.nodes?.[0] ?? floor
  if (!head || !floor) throw new UpstreamError('orca answered without a head block or a first routed trade.', { kind: 'upstream', source: ORCA })

  // The carried-forward boundary, re-proved: the day's first block must be at or after the day's
  // start, and the block before it must be before it. That is the whole definition of "first
  // block of the day", and checking it costs nothing because it rode along with this request. A
  // cursor that drifted by even one block would otherwise attribute a trade to the wrong day for
  // the rest of the month, and every total would still look entirely reasonable.
  const edge = frame.data?.edge?.nodes ?? []
  const atFrom = edge.find((node) => node.height === from)
  const beforeFrom = edge.find((node) => node.height === from - 1)
  const startMs = Date.parse(dayStart)
  if (!atFrom || Date.parse(atFrom.timestamp) < startMs || (beforeFrom && Date.parse(beforeFrom.timestamp) >= startMs)) {
    throw new UpstreamError(
      `block ${from} is not the first block of ${day}: it is at ${atFrom?.timestamp ?? 'a height orca does not have'}` +
        `${beforeFrom ? `, and block ${from - 1} is at ${beforeFrom.timestamp}` : ''}.`,
      { kind: 'decode', source: ORCA },
    )
  }
  fromAt = atFrom.timestamp

  const probe = frame.data?.probe?.nodes?.[0]
  let end = frame.data?.boundary?.nodes?.[0] ?? null
  let assisted = true
  if (!probe || !end || Date.parse(probe.timestamp) >= Date.parse(dayEnd)) {
    // The hint overshot (or the block it names is not there yet), so the answer above may be the
    // hint block rather than the boundary. Pay for the full scan instead of trusting it.
    assisted = false
    const scan = await gate(hostOf(url), () =>
      graphql({ source: ORCA, url, query: BOUNDARY_SCAN, variables: { at: dayEnd }, timeoutMs: 120_000 }),
    )
    end = scan?.boundary?.nodes?.[0] ?? null
  }

  // THE guarantee. No block at or after the day's end means orca's index stops inside this day,
  // and a day summarised from a partial index would be a wrong number stored forever.
  if (!end) {
    throw new UpstreamError(
      `orca has not indexed past ${dayEnd} — its head is block ${head.height} at ${head.timestamp}. ` +
        `Refusing to store ${day} from an index that stops inside it.`,
      { kind: 'upstream', source: ORCA },
    )
  }

  const to = end.height
  // `to` is EXCLUSIVE — the first block of the next day. Both edges are real block heights read
  // off the chain's own timestamps; `firstBlockAt` is kept as the evidence, because a day whose
  // first block is at 00:00:30 and one whose first block is at 04:00:00 are different facts.
  const blocks = {
    from,
    to,
    count: to - from,
    firstBlockAt: fromAt,
    toBlockAt: end.timestamp,
    boundaryAssisted: assisted,
  }

  /* ---- days before this source has any routed trades at all ---- */

  if (to <= floor.paraBlockHeight) {
    return {
      day: {
        date: day,
        // Not "no trades": orca does not group swap legs into routed trades before its floor, so
        // a count of 0 would be a claim about the venue that nothing here supports. Every field
        // an indexed day carries is present and explicitly null — a key that is simply absent
        // reads, at the far end, exactly like a typo in the key name.
        coverage: 'before-source-floor',
        blocks,
        trades: null,
        legs: null,
        legInflation: null,
        usd: null,
        unpricedTrades: null,
        accounts: null,
        pallet: null,
        topFourShare: null,
        topTenShare: null,
        venues: null,
        assets: null,
        routes: null,
        routesTotal: null,
        topAccounts: null,
        rates: null,
        platform: null,
        quality: null,
        floorBlock: floor.paraBlockHeight,
        floorAt: floor.block.timestamp,
      },
      head,
      to,
      toAt: end.timestamp,
      blocksInDay: blocks.count,
    }
  }

  /* ---- one number each: trade count, block count, and orca's own published volume ---- */

  const stats = await gate(hostOf(url), () =>
    graphql({ source: ORCA, url, query: DAY_STATS, variables: { from, to, last: to - 1 }, timeoutMs: 60_000 }),
  )
  const expected = stats?.trades?.totalCount ?? null
  const indexedBlocks = stats?.blocks?.totalCount ?? null
  if (indexedBlocks !== null && indexedBlocks !== blocks.count) {
    throw new UpstreamError(
      `orca holds ${indexedBlocks} of the ${blocks.count} blocks in ${day} (${from}–${to - 1}). A parachain numbers ` +
        'its blocks consecutively, so a short count is a gap in the index — every trade in the missing blocks would ' +
        'be absent from a day this job would then never fetch again.',
      { kind: 'upstream', source: ORCA },
    )
  }
  if (expected !== null && expected > MAX_TRADES) {
    throw new UpstreamError(`${expected} routed trades in ${day} is past the ${MAX_TRADES} ceiling this service holds in memory.`, {
      kind: 'upstream',
      source: ORCA,
    })
  }
  const volume = stats?.platformTotalVolumesByPeriod?.nodes?.[0] ?? null
  const platform = volume
    ? {
        total: money(Number(volume.totalVolNorm)),
        omnipool: money(Number(volume.omnipoolVolNorm)),
        stableswap: money(Number(volume.stableswapVolNorm)),
        xyk: money(Number(volume.xykpoolVolNorm)),
      }
    : null

  /* ---- the trades ---- */

  const raw = []
  const squidAssetIds = new Set()
  let multiAsset = 0
  let multiSwapper = 0
  let withoutBalances = 0
  let pages = 0

  // Counted where the request is made, not in the `for` header: an increment in the header is
  // skipped by the `break`, so the last page of every day goes unrecorded. The live operation
  // above had that off-by-one and its `meta.pagesFetched` was short by one per window.
  for (let after = null; ; ) {
    const data = await gate(hostOf(url), () =>
      graphql({ source: ORCA, url, query: TRADES, variables: { from, to, first: PAGE, after }, timeoutMs: 60_000 }),
    )
    pages += 1
    const connection = data?.routedTrades
    const nodes = connection?.nodes ?? []
    for (const node of nodes) {
      const inputs = node.routeTradeInputs?.nodes ?? []
      const outputs = node.routeTradeOutputs?.nodes ?? []
      if (!inputs.length || !outputs.length) {
        withoutBalances += 1
        continue
      }
      if (inputs.length > 1 || outputs.length > 1) multiAsset += 1
      const swappers = node.participantSwappers ?? []
      if (swappers.length > 1) multiSwapper += 1

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
    if (!connection?.pageInfo?.hasNextPage || !nodes.length) break
    after = connection.pageInfo.endCursor
  }

  // The paging cross-check, and here it REFUSES rather than annotating. The live operation can
  // afford to note a discrepancy and move on — it re-fetches the window on the next request. A
  // stored day is fetched once and never again, so a page silently lost at the seam would be a
  // permanently short day that nothing ever revisits.
  if (expected !== null && expected !== raw.length + withoutBalances) {
    throw new UpstreamError(
      `orca counted ${expected} routed trades in ${day} (blocks ${from}–${to - 1}) but paging returned ` +
        `${raw.length + withoutBalances} over ${pages} page(s). That is a paging fault, not a rounding one.`,
      { kind: 'upstream', source: ORCA },
    )
  }

  /* ---- assets: orca supplies the key, the chain registry supplies the meaning ---- */

  const squidIds = [...squidAssetIds]
  const freshSquidIds = squidIds.filter((id) => !squidAssetMemo.has(id))
  if (freshSquidIds.length) {
    const fetched = await fetchSquidAssets({
      url,
      ids: freshSquidIds,
      run: (fn) => gate(hostOf(url), fn),
    })
    for (const id of freshSquidIds) squidAssetMemo.set(id, fetched.get(id) ?? null)
  }
  const squidAssets = new Map()
  for (const id of squidIds) {
    const meta = squidAssetMemo.get(id)
    if (meta) squidAssets.set(id, meta)
  }

  const wantedRegistryIds = registryIdsOf(squidAssets)
  const freshRegistryIds = wantedRegistryIds.filter((id) => !registryMemo.has(id) && !registryMisses.has(id))
  if (freshRegistryIds.length) {
    const fetched = await fetchAssets(freshRegistryIds, { run: (fn) => gate(RPC_HOST, fn) })
    for (const id of freshRegistryIds) {
      if (fetched.has(id)) registryMemo.set(id, fetched.get(id))
      else registryMisses.add(id)
    }
  }
  const assets = new Map()
  for (const id of wantedRegistryIds) if (registryMemo.has(id)) assets.set(id, registryMemo.get(id))

  const meaning = resolveAssetMeaning(squidIds, squidAssets, assets)
  const { trades, rates } = valueTrades(raw, meaning)

  const summary = summariseDay({
    date: day,
    trades,
    rates,
    blocks,
    platform,
    quality: {
      expectedTrades: expected,
      pagesFetched: pages,
      tradesWithoutBalances: withoutBalances,
      multiAsset,
      multiSwapper,
      // Every one of these is a caveat the page has to be able to state from the payload alone.
      unknownAssets: meaning.unknownAssets,
      unmappedAssetIds: meaning.unmappedAssetIds,
      assetDisagreements: meaning.disagreements,
      borrowedMetadata: meaning.borrowedMetadata,
      orcaHost: hostOf(url),
      hostFailures,
    },
  })
  if (from < floor.paraBlockHeight) {
    // The day straddles orca's first routed trade — the whole-day case returned above — so this
    // is a partial day of coverage rather than a quiet one.
    summary.coverage = 'partial-source-floor'
    summary.floorBlock = floor.paraBlockHeight
    summary.floorAt = floor.block.timestamp
  }

  return { day: summary, head, to, toAt: end.timestamp, blocksInDay: blocks.count }
}

/* ------------------------------------------------------------------------------ page ---- */

/* ═══════════════════════════════════════════════════ what Hydration holds — the plumbing ═════ */
//
// The stock question, beside the flow question the rest of this module answers: how much capital
// sits on this chain right now, and in which assets. Every reading, every grade and the full
// derivation are in docs/platform/hydration-capital.md; what follows is the code that re-derives
// them. Two things about it are load-bearing.
//
// ── the one thing that would inflate the answer by 37 % ──────────────────────────────────────
// Hydration's venues hold EACH OTHER'S receipt tokens, several layers deep. Adding the four
// together counted $72.5 M on 2026-08-21, of which $27.1 M was one venue holding another's claim.
// The stack is not guessable from the names: `GDOT` (69) is the aToken of the STABLESWAP POOL
// `2-Pool-GDOT` (690), and `GETH` (420) is the aToken of `2-Pool-GETH` (4200), whose own reserves
// are aETH — itself the aToken of ETH. A symbol filter keeps every one of them.
//
// So the classification is asked of the CONTRACT and the REGISTRY, never of the name:
//
//     UNDERLYING_ASSET_ADDRESS() answers  ->  an aToken           (derived)
//     asset() answers                     ->  an ERC-4626 vault   (derived)
//     registry type StableSwap / XYK      ->  a pool share token  (derived)
//     otherwise                           ->  base
//
// and a position counts only when its token is base. A derived position is a claim on reserves
// counted where they physically sit, so this is exact rather than an estimate: the aDOT the
// Omnipool holds is INSIDE the money market's supplied DOT, not beside it.
//
// ── composition, not a second pricer ─────────────────────────────────────────────────────────
// Decision 0009: pricing is a source others compose. The oracle discovery chain, the money-market
// reserves and the Omnipool balance sheet read by all three storage paths already exist in
// `hydration-evm`, and this CALLS it rather than reimplementing it — one level deep, which is the
// rule that decision sets. No price here comes from anywhere but a chain (decision 0008).
//
// It composes `hydration-evm` rather than `prices.mjs`, and that is deliberate. This operation
// needs the money market's per-reserve `supplied` and `borrowed` and the Omnipool's reserves, not
// only a price — `prices.mjs` serves prices alone, so composing it would mean reading the SAME
// oracle twice, a minute apart, and an asset would be worth two amounts on one page. Taking each
// price from the reserve row whose quantity it multiplies keeps price and quantity inside one
// snapshot, which is the property 0009's caching rule is protecting.
//
// The two were checked against each other rather than assumed compatible: across the 25 assets
// both value, `prices.mjs` and this operation agree to a worst relative difference of 0.0004 %
// (verified live 2026-08-21). Two modules, two authors, one oracle, one number. This chain also
// resolves four assets `prices.mjs` cannot — wstETH, jitoSOL, sUSDS, sUSDe — through the
// stableswap share-price residual below.

/** The pool account of a stableswap pool: `blake2_256("sts" ‖ u32le(poolId))`. Derived, never
 *  stored — `Stableswap::Pools` gives the members and the amplification and NOT the reserves.
 *  Tested against two plausible alternatives (docs/platform/hydration.md); the wrong derivation
 *  does not error, it yields a valid-looking account holding nothing. */
const stableswapAccount = (poolId) => '0x' + toHex(blake2b(concat(utf8('sts'), u32le(poolId)), 32))

/** A Substrate-native asset's EVM address: 12 zero bytes, `00000001`, then the u32 id big-endian.
 *  An `Erc20`-typed asset does NOT follow this — its address is a real contract in AssetLocations. */
const evmAddressOfAsset = (id) => `0x${'0'.repeat(31)}1${Number(id).toString(16).padStart(8, '0')}`

/** The reverse: an address in that shape back to its id, or null if it is a real contract. */
function assetIdOfEvmAddress(address) {
  const hex = String(address ?? '').replace(/^0x/, '').toLowerCase()
  if (hex.length !== 40 || !hex.startsWith('0'.repeat(31) + '1')) return null
  return Number.parseInt(hex.slice(32), 16)
}

const capitalSelector = (signature) => keccakHex(signature).slice(0, 10)
const CAP_SEL = {
  balanceOf: capitalSelector('balanceOf(address)'),
  underlying: capitalSelector('UNDERLYING_ASSET_ADDRESS()'),
  asset4626: capitalSelector('asset()'),
  convertToAssets: capitalSelector('convertToAssets(uint256)'),
}
const capitalWord = (value) => String(value).replace(/^0x/, '').toLowerCase().padStart(64, '0')

const STORAGE_PAGE = 400
const EVM_BATCH = 150

/** `state_queryStorageAt`, paged. A missing key comes back `null`, which is a fact about the
 *  chain rather than an error: an `Erc20` asset simply has no orml row. */
async function readStorage(keys) {
  const found = new Map()
  for (let at = 0; at < keys.length; at += STORAGE_PAGE) {
    const slice = keys.slice(at, at + STORAGE_PAGE)
    const changes = await jsonRpc({
      source: 'hydration-rpc',
      url: RPC,
      method: 'state_queryStorageAt',
      params: [slice],
      timeoutMs: 45_000,
    })
    for (const [key, value] of changes?.[0]?.changes ?? []) found.set(key.toLowerCase(), value)
  }
  return keys.map((key) => found.get(key.toLowerCase()) ?? null)
}

/** Every key under a storage prefix, paged. */
async function keysUnder(prefix) {
  const out = []
  let start = null
  for (;;) {
    const page = await jsonRpc({
      source: 'hydration-rpc',
      url: RPC,
      method: 'state_getKeysPaged',
      params: [prefix, 1000, start],
      timeoutMs: 45_000,
    })
    if (!page?.length) break
    out.push(...page)
    if (page.length < 1000) break
    start = page[page.length - 1]
  }
  return out
}

/** An `eth_call` batch. Per-item failures become `null` rather than throwing: a reverting call
 *  means "this contract has no answer", which is a fact to report and not a dead page. */
async function ethCalls(calls) {
  const out = new Array(calls.length).fill(null)
  for (let at = 0; at < calls.length; at += EVM_BATCH) {
    const slice = calls.slice(at, at + EVM_BATCH)
    const body = slice.map((call, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to: call.to, data: call.data }, 'latest'],
    }))
    const answer = await callUpstream({ source: 'hydration-rpc', url: RPC, method: 'POST', body, timeoutMs: 60_000 })
    if (!Array.isArray(answer)) {
      throw new UpstreamError('the node answered a JSON-RPC batch with something that is not an array.', {
        kind: 'decode',
        source: 'hydration-rpc',
      })
    }
    for (const item of answer) {
      if (!Number.isInteger(item?.id) || item.id < 0 || item.id >= slice.length) continue
      out[at + item.id] = item.error ? null : (item.result ?? null)
    }
  }
  return out
}

const wordAddress = (hex) => (hex && hex !== '0x' && BigInt(hex) !== 0n ? '0x' + hex.slice(26) : null)

/** A fixed-width little-endian unsigned integer at a byte offset in a hex string. */
function leUint(hex, byteOffset = 0, byteLength = 16) {
  if (!hex) return null
  const slice = hex.replace(/^0x/, '').slice(byteOffset * 2, (byteOffset + byteLength) * 2)
  if (slice.length !== byteLength * 2) return null
  return BigInt('0x' + (slice.match(/../g) ?? []).reverse().join(''))
}

/** `AssetRegistry::AssetLocations` for an `Erc20` asset is always `parents: 0`, `X1[AccountKey20]`
 *  — 24 bytes. Asserted rather than generally decoded: taking 20 bytes off the end of an
 *  arbitrary junction yields a plausible address for a location that is not one. */
function erc20AddressOf(hex) {
  if (!hex) return null
  const bytes = String(hex).replace(/^0x/, '').toLowerCase()
  return bytes.length === 48 && bytes.startsWith('00010300') ? '0x' + bytes.slice(8) : null
}

/** `Stableswap::Pools -> PoolInfo`. Only the member list is wanted. The trailing amplification
 *  and fee are measured, not parsed — a tail that is not 16 bytes means the layout moved, and
 *  that must be loud rather than yielding a plausible member list. */
function decodePoolMembers(hex) {
  const [count, next] = decodeCompact(hex, 2)
  const assets = []
  let at = next
  for (let i = 0; i < count; i += 1) {
    assets.push(Number(leUint('0x' + hex.slice(at, at + 8), 0, 4)))
    at += 8
  }
  const tailBytes = (hex.length - at) / 2
  if (tailBytes !== 16) {
    throw new UpstreamError(
      `Stableswap PoolInfo left ${tailBytes} trailing bytes, expected 16 — the runtime layout has changed.`,
      { kind: 'decode', source: 'hydration-rpc' },
    )
  }
  return assets
}

const scaledBy = (raw, decimals) =>
  raw === null || raw === undefined || decimals === null || decimals === undefined ? null : Number(raw) / 10 ** decimals

/** Dollars, to the cent. `null` in, `null` out — a figure we could not compute is not zero. */
const usd2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100)

/** One GraphQL call to an orca host `connect()` has already chosen. No host failover: the
 *  failover happened when the host was picked, and re-picking mid-operation would mean two
 *  halves of one answer came from two indexes. */
const orcaOnce = (url, query, variables) =>
  graphql({ source: ORCA, url, query, variables, timeoutMs: 120_000 })

/** Blocks in a day, as a BRACKET rather than an estimate — used ONLY to let the height index
 *  answer a boundary lookup quickly. This chain's block time has moved by a factor of 2.9 across
 *  the range these series cover, so nothing multiplies one out; the bracket is deliberately far
 *  wider than any day on record (6,188 to 17,702), and every boundary it finds is then proved
 *  against the chain's own timestamps. A bracket that was too tight throws; it never shifts a day. */
const DAY_BLOCKS_MIN = 4_000
const DAY_BLOCKS_MAX = 26_000

export default {
  id: 'hydration',
  label: LABEL,
  homepage: 'https://hydration.net',
  transport: 'graphql+jsonrpc',
  doc: 'docs/platform/hydration.md',
  covers: ['Hydration (Polkadot parachain 2034)'],

  operations: {
    /**
     * What Hydration holds right now, once — the capital across all four venues, resolved to
     * base assets so that nothing is counted twice.
     *
     * Five minutes. Reserves, prices and supplies are current state and can never be immutable,
     * so this is the TTL cache and nothing else (docs/architecture/middleware.md). One snapshot
     * is ~40 requests against a public node; per visitor it would make this site that node's
     * heaviest anonymous client.
     */
    capital: {
      summary:
        'Every position in Hydration’s four venues — Omnipool, 17 stableswap pools, 290 XYK pools and the ' +
        'money market — priced on-chain and resolved to base assets, with the receipt tokens the venues hold ' +
        'in each other named and netted rather than summed.',
      ttlMs: 300_000,
      schema: {},

      async run() {
        const startedAt = Date.now()
        const observedAt = Date.now()

        // The decode below is trusted by every dollar on the page.
        await verifyRegistry()

        /* ---- 1. the venues' topology, off the chain ---- */

        const stableswapPrefix = '0x' + toHex(concat(twox128(utf8('Stableswap')), twox128(utf8('Pools'))))
        const xykPrefix = '0x' + toHex(concat(twox128(utf8('XYK')), twox128(utf8('PoolAssets'))))
        const [stableswapKeys, xykKeys] = await Promise.all([keysUnder(stableswapPrefix), keysUnder(xykPrefix)])
        const [stableswapValues, xykValues] = await Promise.all([readStorage(stableswapKeys), readStorage(xykKeys)])

        const stableswapPools = []
        stableswapKeys.forEach((key, i) => {
          if (!stableswapValues[i]) return
          // Blake2_128Concat: 16 bytes of hash then the u32 key itself.
          const id = Number(leUint('0x' + key.slice(stableswapPrefix.length + 32), 0, 4))
          stableswapPools.push({ id, members: decodePoolMembers(stableswapValues[i]), account: stableswapAccount(id) })
        })

        // `XYK::PoolAssets` is keyed by the pool's ACCOUNT with the asset pair as the value —
        // the opposite of what the name suggests, and the reason no derivation is needed here:
        // the key already IS the account whose balances are the reserves.
        const xykPools = []
        xykKeys.forEach((key, i) => {
          const value = xykValues[i]
          if (!value) return
          xykPools.push({
            account: '0x' + key.slice(xykPrefix.length + 32),
            members: [Number(leUint('0x' + value.slice(2, 10), 0, 4)), Number(leUint('0x' + value.slice(10, 18), 0, 4))],
          })
        })

        /* ---- 2. the money market and the Omnipool, composed rather than reimplemented ---- */

        const market = await hydrationEvm.operations.market.run({})
        const omnipoolAssets = market.omnipool?.assets ?? []

        /* ---- 3. the registry, for exactly the assets these venues touch ---- */

        const touched = new Set()
        for (const pool of stableswapPools) {
          touched.add(pool.id)
          for (const id of pool.members) touched.add(id)
        }
        for (const pool of xykPools) for (const id of pool.members) touched.add(id)
        for (const asset of omnipoolAssets) touched.add(asset.id)
        for (const reserve of market.reserves ?? []) {
          const id = assetIdOfEvmAddress(reserve.asset)
          if (id !== null) touched.add(id)
        }
        const registry = await fetchAssets([...touched])

        // `Erc20` assets need their contract address: it is where the balance lives, and it is
        // also what answers the two questions that decide whether the asset is derived.
        const erc20Ids = [...registry.values()].filter((asset) => asset.type === 'Erc20').map((asset) => asset.id)
        const locationsPrefix = '0x' + toHex(concat(twox128(utf8('AssetRegistry')), twox128(utf8('AssetLocations'))))
        const locationKeys = erc20Ids.map((id) => {
          const encoded = u32le(id)
          return locationsPrefix + toHex(blake2b(encoded, 16)) + toHex(encoded)
        })
        const locationValues = await readStorage(locationKeys)
        const contractOf = new Map()
        erc20Ids.forEach((id, i) => {
          const address = erc20AddressOf(locationValues[i])
          if (address) contractOf.set(id, address)
        })
        // A money-market reserve whose address is a contract resolves to its id through this map.
        const idOfContract = new Map([...contractOf].map(([id, address]) => [address.toLowerCase(), id]))

        const addressOf = (id) => contractOf.get(id) ?? evmAddressOfAsset(id)
        const symbolOfId = (id) => registry.get(id)?.symbol ?? registry.get(id)?.name ?? `#${id}`
        const decimalsOf = (id) => registry.get(id)?.decimals ?? null
        const typeOf = (id) => registry.get(id)?.type ?? null

        /* ---- 4. the wrap graph, asked of the contracts ---- */

        const probes = erc20Ids.flatMap((id) => [
          { to: addressOf(id), data: CAP_SEL.underlying },
          { to: addressOf(id), data: CAP_SEL.asset4626 },
        ])
        const probed = await ethCalls(probes)

        /** id -> { kind, underlying, ratio } for every derived asset. */
        const wrap = new Map()
        const vaultIds = []
        erc20Ids.forEach((id, i) => {
          const underlying = wordAddress(probed[i * 2])
          const vaultAsset = wordAddress(probed[i * 2 + 1])
          if (underlying) {
            const target = assetIdOfEvmAddress(underlying) ?? idOfContract.get(underlying.toLowerCase()) ?? null
            // An aToken is 1:1 with its underlying — verified live across 282 DOT<->aDOT legs in
            // 24 h, deviation exactly 0 (docs/platform/hydration.md).
            wrap.set(id, { kind: 'aToken', underlying: target, ratio: 1 })
          } else if (vaultAsset) {
            const target = assetIdOfEvmAddress(vaultAsset) ?? idOfContract.get(vaultAsset.toLowerCase()) ?? null
            // A 4626 SHARE IS NOT 1:1 with its asset, unlike an aToken, and the two are
            // indistinguishable in the registry. `convertToAssets` is asked below.
            wrap.set(id, { kind: 'vault', underlying: target, ratio: null })
            vaultIds.push(id)
          }
        })
        if (vaultIds.length) {
          const one = capitalWord((10n ** 18n).toString(16))
          const ratios = await ethCalls(vaultIds.map((id) => ({ to: addressOf(id), data: CAP_SEL.convertToAssets + one })))
          vaultIds.forEach((id, i) => {
            const raw = ratios[i] && ratios[i] !== '0x' ? BigInt(ratios[i]) : null
            if (raw !== null) wrap.get(id).ratio = Number(raw) / 1e18
          })
        }
        // Pool share tokens are derived by their registry TYPE, which is the authority for them.
        for (const [id, asset] of registry) {
          if (wrap.has(id)) continue
          if (asset.type === 'StableSwap') wrap.set(id, { kind: 'stableswap share', underlying: null, ratio: null })
          else if (asset.type === 'XYK') wrap.set(id, { kind: 'XYK share', underlying: null, ratio: null })
        }
        const derivedKind = (id) => wrap.get(id)?.kind ?? null

        /* ---- 5. prices: three chained paths, each labelled ---- */

        const oraclePrice = new Map()
        const spotPrice = new Map()
        const marketPriceNote = new Map()
        for (const reserve of market.reserves ?? []) {
          const id = assetIdOfEvmAddress(reserve.asset) ?? idOfContract.get(String(reserve.asset).toLowerCase()) ?? null
          if (id === null || reserve.price === null) continue
          oraclePrice.set(id, reserve.price)
          marketPriceNote.set(id, reserve.priceSource)
        }
        for (const asset of omnipoolAssets) if (asset.spotUsd !== null) spotPrice.set(asset.id, asset.spotUsd)

        /** One whole unit, in dollars, and where the number came from. `null` is never `0`. */
        function priceOf(id, depth = 0) {
          if (depth > 8) return { price: null, via: null }
          if (oraclePrice.has(id)) return { price: oraclePrice.get(id), via: marketPriceNote.get(id) ?? 'money-market oracle' }
          const link = wrap.get(id)
          if (link?.underlying !== null && link?.underlying !== undefined && link.ratio !== null) {
            const inner = priceOf(link.underlying, depth + 1)
            if (inner.price !== null) {
              return {
                price: inner.price * link.ratio,
                via: `${symbolOfId(link.underlying)} × ${link.ratio === 1 ? '1:1' : link.ratio.toFixed(5)} (${link.kind})`,
              }
            }
          }
          if (spotPrice.has(id)) return { price: spotPrice.get(id), via: 'Omnipool implied spot' }
          return { price: null, via: null }
        }

        /* ---- 6. every position ---- */

        /** @type {Array<{venue:string, pool:string|null, asset:number, amount:number|null}>} */
        const positions = []
        for (const asset of omnipoolAssets) {
          positions.push({ venue: 'Omnipool', pool: null, asset: asset.id, amount: asset.reserve })
        }

        const balanceReads = []
        for (const pool of stableswapPools) {
          for (const id of pool.members) balanceReads.push({ venue: 'Stableswap', pool: symbolOfId(pool.id), poolId: pool.id, account: pool.account, asset: id })
        }
        for (const pool of xykPools) {
          for (const id of pool.members) balanceReads.push({ venue: 'XYK', pool: pool.account.slice(0, 10), poolId: null, account: pool.account, asset: id })
        }

        // Three storage paths, one balance sheet. HDX is `pallet-balances`, an `Erc20` asset's
        // balance is in EVM storage, everything else is orml. Missing one does not error — it
        // returns null, which a naive decoder turns into zero.
        const viaOrml = balanceReads.filter((read) => typeOf(read.asset) !== 'Erc20' && read.asset !== 0)
        const viaSystem = balanceReads.filter((read) => read.asset === 0)
        const viaEvm = balanceReads.filter((read) => typeOf(read.asset) === 'Erc20')

        const tokensPrefix = '0x' + toHex(concat(twox128(utf8('Tokens')), twox128(utf8('Accounts'))))
        const systemPrefix = '0x' + toHex(concat(twox128(utf8('System')), twox128(utf8('Account'))))
        const [ormlValues, systemValues, evmValues] = await Promise.all([
          readStorage(
            viaOrml.map((read) => {
              const currency = u32le(read.asset)
              const digest = new Uint8Array(8)
              new DataView(digest.buffer).setBigUint64(0, xxhash64(currency, 0), true)
              return tokensPrefix + toHex(blake2b(fromHex(read.account), 16)) + toHex(fromHex(read.account)) + toHex(digest) + toHex(currency)
            }),
          ),
          readStorage(viaSystem.map((read) => systemPrefix + toHex(blake2b(fromHex(read.account), 16)) + toHex(fromHex(read.account)))),
          ethCalls(viaEvm.map((read) => ({ to: addressOf(read.asset), data: CAP_SEL.balanceOf + capitalWord(read.account.slice(0, 42)) }))),
        ])
        // orml `AccountData { free, reserved, frozen }` — free at byte 0. `frame_system::
        // AccountInfo` puts `free` at byte 16, after four u32s.
        viaOrml.forEach((read, i) => { read.raw = leUint(ormlValues[i], 0, 16) })
        viaSystem.forEach((read, i) => { read.raw = leUint(systemValues[i], 16, 16) })
        viaEvm.forEach((read, i) => { read.raw = evmValues[i] && evmValues[i] !== '0x' ? BigInt(evmValues[i]) : null })
        for (const read of balanceReads) positions.push({ ...read, amount: scaledBy(read.raw, decimalsOf(read.asset)) })

        for (const reserve of market.reserves ?? []) {
          const id = assetIdOfEvmAddress(reserve.asset) ?? idOfContract.get(String(reserve.asset).toLowerCase()) ?? null
          positions.push({
            venue: 'Money market',
            pool: `${reserve.market} market`,
            poolId: null,
            asset: id,
            // `supplied` is the aToken supply, and an Aave market lets a depositor borrow and
            // re-deposit, so it counts a looped position once per turn of the loop. Measured
            // 2026-08-21: the market claimed 5,595,503 DOT supplied while the WHOLE CHAIN held
            // 4,489,790. What is actually in custody is `supplied - borrowed`, and that is what
            // `netAmount` carries. Floored at zero for HOLLAR, which the market MINTS as debt
            // rather than lending out of deposits — its supplied is 0 and its borrowed is $12.3 M.
            amount: reserve.supplied,
            netAmount: reserve.supplied === null ? null : Math.max(0, reserve.supplied - (reserve.borrowed ?? 0)),
            borrowedAmount: reserve.supplied === null ? null : Math.min(reserve.supplied, reserve.borrowed ?? 0),
            borrowed: reserve.borrowed,
            // A reserve the registry cannot name still has a price and a symbol from the market
            // itself; dropping it would be worse than carrying it under the market's own label.
            fallbackSymbol: reserve.symbol,
            fallbackPrice: reserve.price,
            fallbackVia: reserve.priceSource,
          })
        }

        for (const position of positions) {
          const known = position.asset !== null && registry.has(position.asset)
          const { price, via } = known ? priceOf(position.asset) : { price: null, via: null }
          position.price = price ?? position.fallbackPrice ?? null
          position.via = price !== null ? via : (position.fallbackVia ?? null)
          position.symbol = known ? symbolOfId(position.asset) : (position.fallbackSymbol ?? `#${position.asset}`)
          position.derived = known ? derivedKind(position.asset) : null
          position.usd = position.price === null || position.amount === null ? null : position.amount * position.price
          // Everything outside the money market is already net: a pool's reserve is what the pool
          // holds. Only a lending reserve has a borrowed leg to remove.
          const net = position.netAmount === undefined ? position.amount : position.netAmount
          position.netUsd = position.price === null || net === null ? null : net * position.price
          position.borrowedUsd =
            position.price === null || position.borrowedAmount === undefined || position.borrowedAmount === null
              ? null
              : position.borrowedAmount * position.price
        }

        /* ---- 7. the stableswap cross-check, which is also how an unpriced leg is valued ---- */
        //
        // For a pool whose SHARE token the oracle prices, `sharePrice × TotalIssuance(shares)` is
        // a second, independent reading of the same pool. Where every leg prices, the two agreed
        // to within 0.64 % across four pools on 2026-08-21 — which is what makes the reading
        // trustworthy where a leg does NOT price. There the gap IS that leg's value, exactly,
        // provided there is only one such leg; with two it cannot be split and is not.

        const issuancePrefix = '0x' + toHex(concat(twox128(utf8('Tokens')), twox128(utf8('TotalIssuance'))))
        const shareKeys = stableswapPools.map((pool) => {
          const currency = u32le(pool.id)
          const digest = new Uint8Array(8)
          new DataView(digest.buffer).setBigUint64(0, xxhash64(currency, 0), true)
          return issuancePrefix + toHex(digest) + toHex(currency)
        })
        const shareValues = await readStorage(shareKeys)

        const pools = stableswapPools.map((pool, i) => {
          const legs = positions.filter((position) => position.venue === 'Stableswap' && position.poolId === pool.id)
          const legSum = legs.reduce((total, leg) => total + (leg.usd ?? 0), 0)
          const unpriced = legs.filter((leg) => leg.usd === null)
          const shares = scaledBy(leUint(shareValues[i], 0, 16), decimalsOf(pool.id))
          const share = priceOf(pool.id)
          const viaShares = shares === null || share.price === null ? null : shares * share.price
          const gap = viaShares === null ? null : viaShares - legSum
          return {
            id: pool.id,
            symbol: symbolOfId(pool.id),
            members: pool.members.map((id) => ({ id, symbol: symbolOfId(id), derived: derivedKind(id) })),
            legSumUsd: usd2(legSum),
            shares,
            sharePrice: share.price,
            viaSharesUsd: usd2(viaShares),
            gapUsd: usd2(gap),
            gapPercent: viaShares ? sig6((gap / viaShares) * 100) : null,
            unpriced: unpriced.map((leg) => ({ asset: leg.asset, symbol: leg.symbol, amount: leg.amount })),
          }
        })

        // Attribute the gap. Exactly one unpriced leg means the residual is that leg's value and
        // its implied unit price falls out; two or more cannot be split without assuming both
        // sit at parity, so they are reported unattributed instead.
        let residualUsd = 0
        const unattributed = []
        for (const pool of pools) {
          if (pool.gapUsd === null || pool.gapUsd <= 0 || !pool.unpriced.length) continue
          residualUsd += pool.gapUsd
          if (pool.unpriced.length === 1) {
            const [leg] = pool.unpriced
            const target = positions.find(
              (position) => position.venue === 'Stableswap' && position.poolId === pool.id && position.asset === leg.asset,
            )
            if (target && target.amount) {
              target.usd = pool.gapUsd
              target.netUsd = pool.gapUsd
              target.price = pool.gapUsd / target.amount
              target.via = `implied from ${pool.symbol}’s own share price`
              leg.impliedPrice = sig6(target.price)
              leg.impliedUsd = pool.gapUsd
            }
          } else {
            unattributed.push({ pool: pool.symbol, usd: pool.gapUsd, legs: pool.unpriced.map((leg) => leg.symbol) })
          }
        }

        /* ---- 8. roll up ---- */

        const byVenue = new Map()
        for (const position of positions) {
          const entry = byVenue.get(position.venue) ?? {
            venue: position.venue,
            grossUsd: 0,
            derivedUsd: 0,
            distinctUsd: 0,
            borrowedUsd: 0,
            netUsd: 0,
            positions: 0,
            unpricedPositions: 0,
          }
          entry.positions += 1
          if (position.usd === null) entry.unpricedPositions += 1
          else {
            entry.grossUsd += position.usd
            if (position.derived) entry.derivedUsd += position.usd
            else {
              entry.distinctUsd += position.usd
              entry.netUsd += position.netUsd ?? position.usd
              entry.borrowedUsd += position.borrowedUsd ?? 0
            }
          }
          byVenue.set(position.venue, entry)
        }
        const venues = [...byVenue.values()].sort((a, b) => b.grossUsd - a.grossUsd)
        const grossUsd = venues.reduce((total, venue) => total + venue.grossUsd, 0)
        const derivedUsd = venues.reduce((total, venue) => total + venue.derivedUsd, 0)
        const distinctUsd = grossUsd - derivedUsd
        const loopedUsd = venues.reduce((total, venue) => total + venue.borrowedUsd, 0)
        const netUsd = distinctUsd - loopedUsd

        // By BASE asset — the actual question, "how much money is in which assets". A derived
        // position is skipped because its backing is counted where it sits, so this sums to the
        // distinct total: that equality is the reconciliation, and the residual is published.
        const byAsset = new Map()
        for (const position of positions) {
          if (position.derived) continue
          const key = position.asset ?? `?${position.symbol}`
          const entry = byAsset.get(key) ?? {
            id: position.asset,
            symbol: position.symbol,
            // Seven registry assets are called USDC or USDT. A bare ticker in a ranked list is a
            // factual error here, so anything a reader sees carries the id.
            label: position.asset === null ? position.symbol : `${position.symbol} (${position.asset})`,
            usd: 0,
            grossUsd: 0,
            borrowedUsd: 0,
            amount: 0,
            grossAmount: 0,
            venues: [],
            unpricedPositions: 0,
            via: null,
          }
          if (!entry.venues.includes(position.venue)) entry.venues.push(position.venue)
          if (position.usd === null) entry.unpricedPositions += 1
          else {
            entry.usd += position.netUsd ?? position.usd
            entry.grossUsd += position.usd
            entry.borrowedUsd += position.borrowedUsd ?? 0
            entry.amount += (position.netAmount === undefined ? position.amount : position.netAmount) ?? 0
            entry.grossAmount += position.amount ?? 0
            entry.via = entry.via ?? position.via
          }
          byAsset.set(key, entry)
        }
        const assets = [...byAsset.values()]
          .map((asset) => ({
            ...asset,
            usd: usd2(asset.usd),
            grossUsd: usd2(asset.grossUsd),
            borrowedUsd: usd2(asset.borrowedUsd),
            amount: sig6(asset.amount),
            grossAmount: sig6(asset.grossAmount),
          }))
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))

        const assetTotal = assets.reduce((total, asset) => total + (asset.usd ?? 0), 0)
        const unpricedPositions = positions.filter((position) => position.usd === null)
        const unpricedAssets = new Set(unpricedPositions.map((position) => position.symbol))
        const xykPoolsWithNoPricedLeg = xykPools.filter((pool) =>
          pool.members.every((id) => {
            const leg = positions.find((position) => position.venue === 'XYK' && position.account === pool.account && position.asset === id)
            return !leg || leg.usd === null
          }),
        ).length

        /* ---- 9. the reconciliation that decided the headline ---- */
        //
        // For every base asset we claim to have found, compare against `Tokens::TotalIssuance` —
        // the whole chain's supply of it. The venues cannot hold more of a token than exists.
        //
        // At GROSS this check FAILS for six assets, DOT worst at 126 % of its own chain-wide
        // supply, and that failure is what identified the recursive-deposit loop: an Aave market
        // lets a depositor borrow and re-deposit, and `supplied` counts every turn. Netting the
        // borrowing out brings every asset back under its supply. The check is run on both
        // figures and BOTH results are published, because the second is only convincing next to
        // the first.
        //
        // `Erc20`-typed assets are excluded: their orml row is a mirror residue, not a supply —
        // HOLLAR's reads 13,584 against a real 12.6 M (docs/platform/hydration.md).

        const checkable = assets.filter(
          (asset) => asset.id !== null && asset.usd !== null && typeOf(asset.id) !== 'Erc20' && asset.amount > 0,
        )
        const issuanceValues = await readStorage(
          checkable.map((asset) => {
            const currency = u32le(asset.id)
            const digest = new Uint8Array(8)
            new DataView(digest.buffer).setBigUint64(0, xxhash64(currency, 0), true)
            return issuancePrefix + toHex(digest) + toHex(currency)
          }),
        )
        const supplyCheck = []
        checkable.forEach((asset, i) => {
          const supply = scaledBy(leUint(issuanceValues[i], 0, 16), decimalsOf(asset.id))
          if (supply === null || supply <= 0) return
          supplyCheck.push({
            id: asset.id,
            label: asset.label,
            supply: sig6(supply),
            heldNet: asset.amount,
            heldGross: asset.grossAmount,
            netShare: sig6(asset.amount / supply),
            grossShare: sig6(asset.grossAmount / supply),
          })
        })
        const overAtGross = supplyCheck.filter((row) => row.grossShare > 1.02)
        const overAtNet = supplyCheck.filter((row) => row.netShare > 1.02)

        const headBlock = await jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'chain_getHeader', params: [], timeoutMs: 20_000 })
        const [nowRaw] = await readStorage(['0x' + toHex(concat(twox128(utf8('Timestamp')), twox128(utf8('Now'))))])
        const chainNowMs = nowRaw ? Number(leUint(nowRaw, 0, 8)) : null

        return {
          fetchedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          totals: {
            grossUsd: usd2(grossUsd),
            derivedUsd: usd2(derivedUsd),
            distinctUsd: usd2(distinctUsd),
            loopedUsd: usd2(loopedUsd),
            netUsd: usd2(netUsd),
            derivedShare: grossUsd > 0 ? sig6(derivedUsd / grossUsd) : null,
            // Everything the market has lent out, including the HOLLAR it MINTS rather than
            // lends. `loopedUsd` above is the part that was lent out of deposits, which is the
            // only part that can be double-counted by a re-deposit.
            borrowedUsd: usd2(market.totals?.borrowedUsd ?? null),
            positions: positions.length,
            unpricedPositions: unpricedPositions.length,
            unpricedAssets: [...unpricedAssets].slice(0, 40),
            unpricedAssetCount: unpricedAssets.size,
            xykPoolsWithNoPricedLeg,
            xykPools: xykPools.length,
            stableswapPools: stableswapPools.length,
            omnipoolAssets: omnipoolAssets.length,
            reserves: (market.reserves ?? []).length,
            // The residual the share-price cross-check recovered, and what could not be split.
            residualUsd: usd2(residualUsd),
            unattributed,
            // The reconciliation: by-asset must sum to distinct. Published rather than asserted,
            // because a reader who cannot see the residual has to take the equality on trust.
            byAssetTotalUsd: usd2(assetTotal),
            byAssetResidualUsd: usd2(assetTotal - netUsd),
            supplyCheck: {
              checked: supplyCheck.length,
              overAtGross: overAtGross.length,
              overAtNet: overAtNet.length,
              worstAtGross: overAtGross.sort((a, b) => b.grossShare - a.grossShare).slice(0, 6),
              stillOver: overAtNet.sort((a, b) => b.netShare - a.netShare).slice(0, 6),
            },
          },
          supplyCheck: supplyCheck.sort((a, b) => b.grossShare - a.grossShare),
          venues,
          assets,
          pools,
          wraps: [...wrap]
            .filter(([, link]) => link.underlying !== null && link.underlying !== undefined)
            .map(([id, link]) => ({
              id,
              symbol: symbolOfId(id),
              kind: link.kind,
              underlying: link.underlying,
              underlyingSymbol: symbolOfId(link.underlying),
              underlyingKind: derivedKind(link.underlying),
              ratio: link.ratio,
            }))
            .sort((a, b) => a.id - b.id),
          positions: positions
            .filter((position) => position.usd !== null || position.amount)
            .map((position) => ({
              venue: position.venue,
              pool: position.pool,
              asset: position.asset,
              symbol: position.symbol,
              label: position.asset === null ? position.symbol : `${position.symbol} (${position.asset})`,
              amount: sig6(position.amount),
              usd: usd2(position.usd),
              via: position.via,
              derived: position.derived,
            }))
            .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)),
          meta: {
            liveness: liveness({
              source: 'hydration',
              label: `${LABEL} — chain state`,
              observedAt,
              headAt: chainNowMs,
              head: `block #${Number(BigInt(headBlock?.number ?? 0)).toLocaleString('en-US')}`,
              covers: { from: null, to: null },
              staleAfterMs: STALE_AFTER_MS,
              frozenAfterMs: FROZEN_AFTER_MS,
              note:
                'Read from chain state at the head block, not from an indexer. A parachain can answer ' +
                'every call and still be weeks stale, so the head’s own `Timestamp::Now` is what this is ' +
                'judged against rather than the fact that it answered.',
            }),
            source: 'hydration',
            sourceLabel: 'Hydration RPC (Substrate + EVM planes)',
            sourceUrl: 'rpc.hydradx.cloud',
            venue: 'Hydration',
            venueUrl: 'https://app.hydration.net',
            headBlock: Number(BigInt(headBlock?.number ?? 0)),
            chainNow: chainNowMs === null ? null : new Date(chainNowMs).toISOString(),
            priceOracle: market.contracts?.priceOracle ?? null,
            baseCurrencyUnit: market.totals?.baseCurrencyUnit ?? null,
            doc: 'docs/platform/hydration-capital.md',
          },
        }
      },
    },

    /**
     * The live tail of the daily series: the last N CLOSED UTC days, counted rather than walked.
     *
     * ── why this exists at all ───────────────────────────────────────────────────────────────
     * `swaps-daily` (mode A, below) stores a calendar month at a time and cannot serve the
     * current month, because a month that has not ended can never be immutable — decision 0012,
     * and the same seam `/netflows/` has. So the long-range view reads whole past months from the
     * store and this for the days since. It is the exact counterpart of
     * `asset-hub/sovereign-dot-recent`, and it is deliberately the SAME pattern rather than a
     * second one.
     *
     * ── why it is counted and not walked ─────────────────────────────────────────────────────
     * Walking a day the way `swaps-daily` does — every routed trade, priced — costs 6.5–12.8 s
     * (measured 2026-08-21). On the 28th of a month that tail is five minutes, which is not a
     * page load. Counting a day costs about 150 ms, because orca answers `totalCount` on both
     * `routedTrades` and `swaps` and GraphQL ALIASES let a whole month go in one request: 20 days
     * of counts in 3.1 s, verified live 2026-08-21.
     *
     * The price of that is real and is stated on the page rather than discovered: a tail day
     * carries its trade count, its leg count, the inflation factor between them and orca's own
     * published pool volume — and `usd: null`, because this repository's own priced-trade volume
     * needs the trades themselves. `null` is not `0`: the chart breaks the line rather than
     * drawing the tail at the floor.
     */
    'swaps-recent-daily': {
      summary:
        'The last N closed UTC days of Hydration trading, counted rather than walked: trades, legs, the ' +
        'leg-inflation factor and orca’s own published pool volume per day. The live tail the month-bucketed ' +
        'store cannot serve.',
      // Thirty minutes. A day that has closed does not change, but the SET of closed days does,
      // and the last day of the set is the one a reader is watching. Half an hour is the same
      // figure `asset-hub/sovereign-dot-recent` uses for the same reason.
      ttlMs: 1_800_000,
      schema: {
        // Thirty-one, because that is the most closed days a calendar month can have waiting for
        // it, and this exists to cover exactly that gap. It is not a window control.
        days: { type: 'int', min: 1, max: 31, default: 31 },
      },

      async run({ days }) {
        const startedAt = Date.now()
        const { url, host, head, floor, failures } = await connect()
        const headMs = Date.parse(head.timestamp)
        const floorMs = Date.parse(floor.block.timestamp)

        // Yesterday, in UTC, by the SERVER's clock — and then bounded by what orca has actually
        // indexed, so a server clock running fast cannot ask for a day the index stops inside.
        const yesterday = addDaysIso(dayIso(Date.now()), -1)
        const lastClosed = addDaysIso(dayIso(headMs), -1)
        const lastDay = lastClosed < yesterday ? lastClosed : yesterday
        const firstDay = addDaysIso(lastDay, -(days - 1))
        const floorDay = dayIso(floorMs)

        const wanted = []
        for (let day = firstDay; day <= lastDay; day = addDaysIso(day, 1)) wanted.push(day)
        // The exclusive right edge of the last day is the first block of the day after it.
        const edges = [...wanted, addDaysIso(lastDay, 1)]

        /* ---- the boundaries: one unbounded anchor, then a bracketed alias per edge ---- */
        //
        // A bracket, not an estimate. Block time on this chain has moved by a factor of 2.9
        // across the range this series covers, so nothing here multiplies one out — the bracket
        // exists only so the height index can answer the lookup, and every boundary it returns is
        // then PROVED against the chain's own timestamps below. A bracket that was too tight
        // therefore throws rather than shifting a day's trades into its neighbour.

        const anchor = await orcaOnce(url, BOUNDARY_SCAN, { at: `${edges[0]}T00:00:00Z` })
        const anchorBlock = anchor?.boundary?.nodes?.[0]
        if (!anchorBlock) {
          throw new UpstreamError(
            `orca has no block at or after ${edges[0]}T00:00:00Z; its head is #${head.height} at ${head.timestamp}.`,
            { kind: 'upstream', source: ORCA },
          )
        }

        let query = 'query Edges {\n'
        edges.forEach((day, i) => {
          if (i === 0) return
          const low = anchorBlock.height + i * DAY_BLOCKS_MIN
          const high = anchorBlock.height + i * DAY_BLOCKS_MAX
          query +=
            `  e${i}: blocks(filter: { timestamp: { greaterThanOrEqualTo: "${day}T00:00:00Z" }, ` +
            `height: { greaterThanOrEqualTo: ${low}, lessThan: ${high} } }, orderBy: HEIGHT_ASC, first: 1) ` +
            `{ nodes { height timestamp } }\n`
        })
        query += '}'
        const edgeAnswer = await orcaOnce(url, query, {})

        const heights = [anchorBlock.height]
        edges.forEach((day, i) => {
          if (i === 0) return
          const node = edgeAnswer?.[`e${i}`]?.nodes?.[0]
          if (!node) {
            throw new UpstreamError(
              `orca has not indexed past ${day}T00:00:00Z — its head is block ${head.height} at ${head.timestamp}. ` +
                'Refusing to report a day from an index that stops inside it.',
              { kind: 'upstream', source: ORCA },
            )
          }
          heights.push(node.height)
        })

        /* ---- prove every boundary, and count every day, in one request ---- */
        //
        // "The first block of day D" means exactly two things: this block is at or after D's
        // start, and the one before it is not. Both are checked. A boundary that drifted by a
        // single block would attribute trades to the wrong day for the rest of the series and
        // every total would still look entirely reasonable.

        query = 'query Days {\n'
        heights.forEach((height, i) => {
          query +=
            `  p${i}: blocks(filter: { height: { greaterThanOrEqualTo: ${Math.max(1, height - 1)}, ` +
            `lessThanOrEqualTo: ${height} } }, orderBy: HEIGHT_ASC) { nodes { height timestamp } }\n`
        })
        wanted.forEach((day, i) => {
          const from = heights[i]
          const to = heights[i + 1]
          query +=
            `  t${i}: routedTrades(filter: { paraBlockHeight: { greaterThanOrEqualTo: ${from}, lessThan: ${to} } }) { totalCount }\n` +
            `  l${i}: swaps(filter: { paraBlockHeight: { greaterThanOrEqualTo: ${from}, lessThan: ${to} } }) { totalCount }\n` +
            `  b${i}: blocks(filter: { height: { greaterThanOrEqualTo: ${from}, lessThan: ${to} } }) { totalCount }\n` +
            `  v${i}: platformTotalVolumesByPeriod(filter: { startBlockNumber: ${from}, endBlockNumber: ${to - 1} }) ` +
            `{ nodes { totalVolNorm omnipoolVolNorm stableswapVolNorm xykpoolVolNorm } }\n`
        })
        query += '}'
        const answer = await orcaOnce(url, query, {})

        const proved = []
        heights.forEach((height, i) => {
          const nodes = answer?.[`p${i}`]?.nodes ?? []
          const at = nodes.find((node) => node.height === height)
          const before = nodes.find((node) => node.height === height - 1)
          const startMs = Date.parse(`${edges[i]}T00:00:00Z`)
          if (!at || Date.parse(at.timestamp) < startMs || (before && Date.parse(before.timestamp) >= startMs)) {
            throw new UpstreamError(
              `block ${height} is not the first block of ${edges[i]}: it is at ${at?.timestamp ?? 'a height orca does not have'}` +
                `${before ? `, and block ${height - 1} is at ${before.timestamp}` : ''}.`,
              { kind: 'decode', source: ORCA },
            )
          }
          proved.push(at.timestamp)
        })

        let gapless = 0
        const series = wanted.map((date, i) => {
          const from = heights[i]
          const to = heights[i + 1]
          const trades = answer?.[`t${i}`]?.totalCount ?? null
          const legs = answer?.[`l${i}`]?.totalCount ?? null
          const blockCount = answer?.[`b${i}`]?.totalCount ?? null
          // A parachain numbers its blocks consecutively, so this equality is a free completeness
          // check on the range: an index with a hole answers fewer.
          const complete = blockCount === to - from
          if (complete) gapless += 1
          const volume = answer?.[`v${i}`]?.nodes?.[0] ?? null
          const before = to <= floor.paraBlockHeight

          return {
            date,
            // Not `indexed`: this day was COUNTED, not walked, so it carries fewer fields than a
            // stored day and the page must be able to tell them apart without guessing.
            coverage: before ? 'before-source-floor' : 'counted',
            blocks: { from, to, count: to - from, firstBlockAt: proved[i], toBlockAt: proved[i + 1], gapless: complete },
            trades: before ? null : trades,
            legs: before ? null : legs,
            legInflation: before || !trades ? null : sig6(legs / trades),
            // `null`, never `0`. This repository's own priced-trade volume needs every trade in
            // the day; a counted day does not have them, and drawing the tail at zero would read
            // as a market that stopped.
            usd: null,
            platform: volume
              ? {
                  total: Number(volume.totalVolNorm),
                  omnipool: Number(volume.omnipoolVolNorm),
                  stableswap: Number(volume.stableswapVolNorm),
                  xyk: Number(volume.xykpoolVolNorm),
                }
              : null,
          }
        })

        return {
          days: series,
          firstDay,
          lastDay,
          floorDay,
          gaplessDays: gapless,
          meta: {
            liveness: livenessOf({ observedAt: startedAt, head, headMs, firstDay, lastDay }),
            source: 'hydration',
            sourceLabel: 'Hydration liquidity-pools squid (orca)',
            sourceUrl: host,
            venue: 'Hydration',
            venueUrl: 'https://app.hydration.net',
            orcaHost: host,
            hostFailures: failures,
            headBlock: head.height,
            headTime: head.timestamp,
            elapsedMs: Date.now() - startedAt,
            fetchedAt: new Date().toISOString(),
            fidelity: 'counted',
            note:
              'Counted, not walked: each day here is a trade count, a leg count and orca’s own published pool ' +
              'volume, read with one aliased query per pass. Dollar volume computed from the trades themselves — ' +
              'the figure the stored months carry — is not available for these days and is null rather than zero.',
          },
        }
      },
    },

    swaps: {
      summary: 'Hydration routed trades over a recent window, valued and rolled up. Legs are grouped upstream.',
      // Fifteen minutes. A fourteen-day window is ~79,000 trades and ~37 MB of upstream
      // traffic; doing that on every pageview would make this site orca's heaviest client.
      ttlMs: 900_000,
      schema: {
        // Fourteen, not seven, and not unlimited. 468 bytes/trade on the wire and ~330 ms per
        // 1,000-row page, measured against orca on 2026-08-20.
        //
        // ⚠ The rate to size this by is NOT the one a short window measures. A 14-day window in
        // August 2026 gave 8,527 trades/day, and that is this venue at its quietest: the mean
        // over the whole 19 months orca holds is 11,050/day and 2025-08 ran at 19,046 — 2.2×
        // the window figure (exact per-month counts in docs/platform/hydration.md). So fourteen
        // days is ~3 s/day and ~26 s here, but the same fourteen days in August 2025 would have
        // been about a minute. The cap is OURS and it is a cost decision; the data goes back to
        // January 2025, and from three months up the page reads the daily series instead —
        // `swaps-daily` from the store plus `swaps-recent-daily` for the tail.
        days: { type: 'int', min: 1, max: 14, default: 7 },
      },

      async run({ days }) {
        await verifyRegistry()

        const { url, host, head, floor, failures } = await connect()
        const headMs = Date.parse(head.timestamp)
        const floorMs = Date.parse(floor.block.timestamp)

        /* ---- the window, in whole UTC days, resolved to real block heights ---- */

        const { firstDay, lastDay, floorDay, from, to, clamped, boundaryAssisted } = await resolveWindow({
          url,
          head,
          headMs,
          floor,
          floorMs,
          days,
        })

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

        for (let after = null; ; ) {
          const data = await graphql({
            source: ORCA,
            url,
            query: TRADES,
            variables: { from, to, first: PAGE, after },
            timeoutMs: 60_000,
          })
          // After the request, not in the `for` header — the header's increment is skipped by
          // the `break` below, so the final page was never counted.
          pages += 1
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

        const squidIds = [...squidAssetIds]
        const squidAssets = await fetchSquidAssets({ url, ids: squidIds })
        const assets = await fetchAssets(registryIdsOf(squidAssets))

        const meaning = resolveAssetMeaning(squidIds, squidAssets, assets)
        const { disagreements, borrowedMetadata, unmappedAssetIds, unknownAssets, symbolOf, labelOf, amountOf } = meaning

        /* ---- pricing, and the canonical Trade shape ---- */

        const { trades, rates } = valueTrades(raw, meaning)

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
          `The window is capped at 14 days by this service, not by the data. A day is 11,050 routed trades on average across ` +
            'everything the indexer holds — and 19,046 in August 2025, against 8,527 measured over a recent fortnight — pulled ' +
            'from an indexer we do not own; thirty days at the long-run rate is well over a minute of fetching behind a ' +
            'spinner. The cap is a cost decision. It is not a shortage of history: the 3-month, 12-month and all-time windows ' +
            'on this page read the same venue back to January 2025 from a store, one summarised day at a time.',
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

    /**
     * ONE ACCOUNT: what it sent, what it got back, and what that nets to per asset.
     *
     * ── what this is NOT, and the page says all of it ─────────────────────────────────────
     *   · It is not "this account". It is this account ON HYDRATION, in swaps only, inside a
     *     window of at most fourteen days. Transfers, XCM arrivals, liquidity provision,
     *     borrow/supply on the money market and fees all move the same balances and none of
     *     them is a `routedTrade` — so the net figures here are a NET OF SWAPS, not a balance
     *     change, and reading them as a portfolio would be wrong in both directions.
     *   · It is not an identity. The only labels attached are structural — `modl`, `para`,
     *     `sibl`, and orca's own pool typing — which are arithmetic over the account's own
     *     bytes and over the venue's registry. Nothing here names or profiles a person; see
     *     docs/concept/plan.md §8.3 for why that line is where it is on an ungated, indexed site.
     *
     * The window is bounded and the page states the boundedness with a number rather than a
     * hedge: `tradesEver` and the account's first and last trade in orca's whole index come
     * back with every response, so "117 of 1,079 trades, of an account first seen on
     * 2025-07-10" is a sentence the payload can always produce.
     */
    account: {
      summary:
        'One account on Hydration: its routed trades in a recent window, what flowed in and out by asset, ' +
        'and how much of that account’s history the window actually covers.',
      // The same fifteen minutes as `swaps`, and deliberately so: this page links to that one
      // and quotes the same window, so the two going stale on different rhythms would show up
      // as two pages disagreeing about a fortnight.
      ttlMs: 900_000,
      schema: {
        // Hex or SS58, any network prefix, normalised to the public key by readParams — which
        // is also what stops one account being four cache entries. See server/lib/params.mjs.
        account: { type: 'account', required: true },
        // Identical bounds to `swaps`, so a reader can carry `days` across the link.
        days: { type: 'int', min: 1, max: 14, default: 7 },
      },

      async run({ account, days }) {
        await verifyRegistry()

        const { url, host, head, floor, failures } = await connect()
        const headMs = Date.parse(head.timestamp)
        const floorMs = Date.parse(floor.block.timestamp)
        const { firstDay, lastDay, floorDay, from, to, clamped, boundaryAssisted } = await resolveWindow({
          url,
          head,
          headMs,
          floor,
          floorMs,
          days,
        })

        // Started here and awaited after the paging loop: it does not depend on anything below
        // and it is five parallel requests, so overlapping it with the account's own pages takes
        // it off the clock entirely. The `catch` is not error handling — it stops an early throw
        // below from turning this into an unhandled rejection; the real one is at the `await`.
        const samplePromise = rateSample(url, from, to)
        samplePromise.catch(() => {})

        /* ---- what this account is, and how much of it this window can see ---- */

        const frame = await graphql({
          source: ORCA,
          url,
          query: ACCOUNT_FRAME,
          variables: { account, from, to },
          timeoutMs: 60_000,
        })

        const tradesEver = frame?.ever?.totalCount ?? null
        const expected = frame?.inWindow?.totalCount ?? null
        const firstEver = frame?.firstEver?.nodes?.[0] ?? null
        const lastEver = frame?.lastEver?.nodes?.[0] ?? null
        const orcaType = frame?.acct?.nodes?.[0]?.accountType ?? null

        if (expected !== null && expected > MAX_ACCOUNT_TRADES) {
          throw new UpstreamError(
            `${expected.toLocaleString('en-US')} routed trades for this account in blocks ` +
              `${from.toLocaleString('en-US')}–${(to - 1).toLocaleString('en-US')} is past the ` +
              `${MAX_ACCOUNT_TRADES.toLocaleString('en-US')} ceiling this service will hold at once. ` +
              'Ask for a shorter window rather than being served a silently short account.',
            { kind: 'upstream', source: ORCA },
          )
        }

        /* ---- its trades, newest first, filtered by orca rather than by us ---- */

        const raw = []
        const squidAssetIds = new Set()
        let legCount = 0
        let multiAsset = 0
        let notFirstSwapper = 0
        let withoutBalances = 0
        let pages = 0

        for (let after = null; ; ) {
          const data = await graphql({
            source: ORCA,
            url,
            query: ACCOUNT_TRADES,
            variables: { account, from, to, first: ACCOUNT_PAGE, after },
            timeoutMs: 60_000,
          })
          pages += 1
          const connection = data?.routedTrades
          const nodes = connection?.nodes ?? []
          for (const node of nodes) {
            const inputs = node.routeTradeInputs?.nodes ?? []
            const outputs = node.routeTradeOutputs?.nodes ?? []
            if (!inputs.length || !outputs.length) {
              withoutBalances += 1
              continue
            }
            if (inputs.length > 1 || outputs.length > 1) multiAsset += 1
            const swappers = node.participantSwappers ?? []
            // `contains` matched the account anywhere in the array; `valueTrades` attributes the
            // trade to the FIRST swapper. Counted rather than hidden — this row is in the totals
            // and the account was a participant, but it is not the row's attributed trader.
            if ((swappers[0] ?? '').toLowerCase() !== account) notFirstSwapper += 1

            legCount += node.swaps?.totalCount ?? 0
            for (const record of inputs.concat(outputs)) squidAssetIds.add(String(record.assetId))

            raw.push({
              id: node.id,
              height: node.paraBlockHeight,
              timestamp: Math.floor(Date.parse(node.block.timestamp) / 1000),
              swapper: swappers[0] ?? account,
              venue: initiation(node.swaps?.nodes?.[0]?.operationId),
              hops: node.swaps?.totalCount ?? 0,
              inputs: inputs.map((r) => ({ assetId: String(r.assetId), amount: r.amount })),
              output: outputs[outputs.length - 1],
              // Kept per row so the flow arithmetic below can use EVERY output leg rather than
              // only the last one, which is all the canonical Trade shape carries.
              outputs: outputs.map((r) => ({ assetId: String(r.assetId), amount: r.amount })),
            })
          }
          if (!connection?.pageInfo?.hasNextPage || !nodes.length) break
          after = connection.pageInfo.endCursor
        }

        /* ---- price discovery: the venue's book over the same blocks, sampled ---- */

        const sample = await samplePromise
        for (const row of sample.rows) {
          squidAssetIds.add(row.inputs[0].assetId)
          squidAssetIds.add(row.output.assetId)
        }

        /* ---- assets: orca supplies the key, the chain registry supplies the meaning ---- */

        const squidIds = [...squidAssetIds]
        const squidAssets = await fetchSquidAssets({ url, ids: squidIds })
        const assets = await fetchAssets(registryIdsOf(squidAssets))
        const meaning = resolveAssetMeaning(squidIds, squidAssets, assets)
        const { disagreements, borrowedMetadata, unmappedAssetIds, unknownAssets, symbolOf, labelOf, amountOf } = meaning

        // The sample is handed in for RATE DERIVATION ONLY. `trades` below is this account's
        // trades and nothing else — no sampled row is ever counted, listed or totalled.
        const { trades, rates } = valueTrades(raw, meaning, { priceFrom: sample.rows })

        /* ---- what flowed in and out, by asset ---- */

        const flows = new Map()
        const flowOf = (record) => {
          const label = labelOf(record.assetId)
          const symbol = symbolOf(record.assetId)
          const key = label ?? `asset ${record.assetId}`
          const hit = flows.get(key) ?? {
            asset: key,
            symbol,
            // `null` where the registry has no decimals: an amount we cannot state is not an
            // amount of zero, and a page that prints 0 for it would be inventing a fact.
            known: symbol !== null,
            sent: 0,
            received: 0,
            sentUsd: 0,
            receivedUsd: 0,
            priced: symbol !== null && rates[symbol] !== undefined,
            legsOut: 0,
            legsIn: 0,
            unstated: 0,
          }
          flows.set(key, hit)
          return hit
        }

        for (const t of raw) {
          for (const record of t.inputs) {
            const flow = flowOf(record)
            flow.legsOut += 1
            const amount = amountOf(record)
            if (amount === null) flow.unstated += 1
            else {
              flow.sent += amount
              if (flow.priced) flow.sentUsd += amount * rates[flow.symbol]
            }
          }
          for (const record of t.outputs) {
            const flow = flowOf(record)
            flow.legsIn += 1
            const amount = amountOf(record)
            if (amount === null) flow.unstated += 1
            else {
              flow.received += amount
              if (flow.priced) flow.receivedUsd += amount * rates[flow.symbol]
            }
          }
        }

        const flowRows = [...flows.values()]
          .map((flow) => ({
            asset: flow.asset,
            symbol: flow.symbol,
            priced: flow.priced,
            sent: flow.known ? sig6(flow.sent) : null,
            received: flow.known ? sig6(flow.received) : null,
            net: flow.known ? sig6(flow.received - flow.sent) : null,
            sentUsd: flow.priced ? money(flow.sentUsd) : null,
            receivedUsd: flow.priced ? money(flow.receivedUsd) : null,
            netUsd: flow.priced ? money(flow.receivedUsd - flow.sentUsd) : null,
            grossUsd: flow.priced ? money(flow.sentUsd + flow.receivedUsd) : null,
            legsOut: flow.legsOut,
            legsIn: flow.legsIn,
            unstatedLegs: flow.unstated,
          }))
          // Priced first and by size, because that is the order a reader can act on. Unpriced
          // rows are not dropped and not sorted to zero — they go to the end, still stated.
          .sort((a, b) => (b.grossUsd ?? -1) - (a.grossUsd ?? -1) || b.legsOut + b.legsIn - (a.legsOut + a.legsIn))

        /* ---- the totals, over every trade fetched, not over the rows shipped ---- */

        const byVenue = new Map()
        const byRoute = new Map()
        const activeDays = new Set()
        let usdIn = 0
        let unpriced = 0
        for (const trade of trades) {
          activeDays.add(trade.date)
          if (trade.usd === null) unpriced += 1
          else usdIn += trade.usd

          const venue = byVenue.get(trade.venue) ?? { venue: trade.venue, usd: 0, count: 0 }
          venue.usd += trade.usd ?? 0
          venue.count += 1
          byVenue.set(trade.venue, venue)

          const name = `${trade.tokenIn ?? '?'}→${trade.tokenOut ?? '?'}`
          const route = byRoute.get(name) ?? { route: name, usd: 0, count: 0 }
          route.usd += trade.usd ?? 0
          route.count += 1
          byRoute.set(name, route)
        }

        const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp)
        const observedAt = Date.now()
        const structural = structuralLabel(account)
        const display = trades[0]?.account ?? palletName(account) ?? account
        const window = `${firstDay} to ${lastDay} UTC`

        /* ---- notes, generated from this payload ---- */

        const notes = [
          'This is what this account did ON HYDRATION, in swaps, inside this window. It is not ' +
            'everything the account did: transfers, XCM arrivals and departures, liquidity ' +
            'provision, borrowing and supplying on the money market, and fees all move the same ' +
            'balances and none of them is a trade. The net figures below are a net OF SWAPS, not a ' +
            'change in what this account holds.',
          `Window: whole UTC days, ${window} — blocks ${from.toLocaleString('en-US')}–` +
            `${(to - 1).toLocaleString('en-US')}. Both edges were read from the chain rather than ` +
            'assumed from a block time.',
          tradesEver === null
            ? 'orca did not report how many trades this account has in total, so how much of its history this window covers cannot be stated.'
            : `orca holds ${tradesEver.toLocaleString('en-US')} routed ${plural(tradesEver, 'trade')} for this account in its ` +
              `whole index; ${(expected ?? trades.length).toLocaleString('en-US')} of them fall in this window. ` +
              (firstEver && lastEver
                ? `Its first is at ${firstEver.block.timestamp.slice(0, 10)} (block ` +
                  `${Number(firstEver.paraBlockHeight).toLocaleString('en-US')}) and its most recent at ` +
                  `${lastEver.block.timestamp.slice(0, 10)}. Everything outside this window is real and is not drawn here.`
                : ''),
          'A trade is one asset out and one asset in, so every row below is both. "Sent" is what ' +
            'left this account and "received" is what came back; the net is the difference, per asset.',
          `Dollar figures use rates derived from a SAMPLE of the venue's own trades over these same blocks — ` +
            `${sample.rows.length.toLocaleString('en-US')} single-asset-in, single-asset-out trades taken from ` +
            `${sample.chunks} ${plural(sample.chunks, 'slice')} spread across the window, plus this account's own ` +
            'trades. /hydration/ derives its rates from every trade in the window instead, so a dollar figure here ' +
            'and the same figure there can differ slightly. Neither is the venue\'s published number; both are ' +
            'medians of what actually traded.',
          'An asset with no rate in this window is left unvalued rather than counted as zero, and is listed as ' +
            'such. "We could not value this" and "this was worth nothing" are different facts.',
        ]

        if (structural) {
          notes.push(
            `This address is structurally ${structural.label}. That is read from its own first bytes — the runtime ` +
              'wrote them — and is the only kind of label this site attaches to an account. No behavioural or ' +
              'attributed identity is inferred here.',
          )
        }
        if (orcaType && orcaType !== 'User') {
          notes.push(
            `orca's own account registry types this address as \`${orcaType}\` — it is a POOL account, not a trader. ` +
              'Its trades are the pool being traded against, seen from the pool\'s side.',
          )
        }
        if (!trades.length) {
          notes.push(
            'This account made no routed trades in this window. That is a fact about the window, not about the ' +
              'account: a longer one, or Hydration activity that is not a swap, would not appear here either way.',
          )
        }
        if (notFirstSwapper) {
          notes.push(
            `${notFirstSwapper.toLocaleString('en-US')} ${plural(notFirstSwapper, 'trade')} list this account as a ` +
              'participant but not as the first swapper. orca filters on participation, and the trade is attributed ' +
              'to its first swapper elsewhere on this site — so those rows are counted here and counted under ' +
              'another account on the rankings.',
          )
        }
        if (multiAsset) {
          notes.push(
            `${multiAsset.toLocaleString('en-US')} ${plural(multiAsset, 'trade')} consumed or produced more than one ` +
              'asset. The flow table counts every leg of those; the route label on the transcript names only the ' +
              'first asset in and the last out.',
          )
        }
        if (withoutBalances) {
          notes.push(
            `${withoutBalances.toLocaleString('en-US')} routed ${plural(withoutBalances, 'trade')} for this account ` +
              'carry no balance rows in orca and were dropped: there is nothing to value or to name a route with.',
          )
        }
        if (expected !== null && expected !== raw.length + withoutBalances) {
          notes.push(
            `orca counted ${expected.toLocaleString('en-US')} trades for this account in this window but paging ` +
              `returned ${(raw.length + withoutBalances).toLocaleString('en-US')} over ${pages} ` +
              `${plural(pages, 'page')}. That is a paging fault, not a rounding one; the figures here are of what ` +
              'was actually read.',
          )
        }
        if (trades.length > ACCOUNT_TRADE_ROWS) {
          notes.push(
            `Every figure on this page is computed over all ${trades.length.toLocaleString('en-US')} of this ` +
              `account's trades in the window. The transcript lists the ${ACCOUNT_TRADE_ROWS} most recent of them, ` +
              'because a table of thousands is a download rather than a reading.',
          )
        }
        if (unpriced) {
          notes.push(
            `${unpriced.toLocaleString('en-US')} of the ${trades.length.toLocaleString('en-US')} trades could not be ` +
              'valued at all — nothing on their input leg reached a dollar-pegged asset in this window. They are ' +
              'counted and excluded from every dollar total, so the two disagree by exactly that much.',
          )
        }
        if (clamped) {
          notes.push(
            `${days} days were requested, which reaches back before ${floorDay}, this source's first routed trade. ` +
              'The window was cut there rather than drawing days that only look empty.',
          )
        }
        if (!boundaryAssisted) {
          notes.push(
            "The fast path for finding the window's first block did not pass its own self-check, so the boundary " +
              'was found by a full scan instead. The window is right; it was slower to compute.',
          )
        }
        if (borrowedMetadata.length) {
          notes.push(
            `Hydration's own registry has no symbol or decimals for ${borrowedMetadata.length} asset(s) here ` +
              `(${some(borrowedMetadata)}) — they are registered as \`External\`, so their metadata lives on the ` +
              "chain they came from. Those legs use orca's metadata, which is one source rather than two agreeing.",
          )
        }
        if (unmappedAssetIds.length) {
          notes.push(
            `orca returned ${unmappedAssetIds.length} asset key(s) it cannot map to a registry id ` +
              `(${some(unmappedAssetIds)}). Legs in those assets are unvalued rather than guessed at.`,
          )
        }
        if (disagreements.length) {
          notes.push(
            `orca and the chain registry disagree about ${disagreements.length} asset(s): ${some(disagreements, 4)}. ` +
              'The chain is used. A decimals disagreement is a factor of ten on everything that asset touches.',
          )
        }
        if (failures.length) {
          notes.push(`${failures.length} orca host(s) did not answer and were skipped: ${failures.join('; ')}.`)
        }

        return {
          account: {
            hex: account,
            address: encodeSs58(fromHex(account), SS58_HYDRATION),
            ss58Prefix: SS58_HYDRATION,
            // What the rankings call it — `pallet:py/trsry` for a pallet account, the hex
            // otherwise. Carried so the two pages name the same account the same way.
            display,
            isPallet: Boolean(palletName(account)),
            structural: structural
              ? { kind: structural.kind, label: structural.label, paraId: structural.paraId ?? null, palletId: structural.palletId ?? null }
              : null,
            orcaType,
          },
          window: {
            days,
            from: firstDay,
            to: lastDay,
            text: window,
            blockRange: [from, to - 1],
            clamped,
            coverageFrom: floorDay,
          },
          activity: {
            tradesInWindow: trades.length,
            tradesExpected: expected,
            tradesEver,
            firstEverAt: firstEver?.block?.timestamp ?? null,
            firstEverBlock: firstEver ? Number(firstEver.paraBlockHeight) : null,
            lastEverAt: lastEver?.block?.timestamp ?? null,
            lastEverBlock: lastEver ? Number(lastEver.paraBlockHeight) : null,
            windowShare: tradesEver ? sig6((trades.length / tradesEver) * 100) : null,
            firstInWindow: sorted.length ? sorted[sorted.length - 1].date : null,
            lastInWindow: sorted.length ? sorted[0].date : null,
            activeDays: activeDays.size,
            legs: legCount,
            legInflation: trades.length ? sig6(legCount / trades.length) : null,
            notFirstSwapper,
            multiAsset,
            tradesWithoutBalances: withoutBalances,
            pagesFetched: pages,
          },
          totals: {
            // The value of everything this account SENT, which is the same convention
            // /hydration/ uses for volume — the input leg, before any hop.
            usdIn: money(usdIn),
            unpricedTrades: unpriced,
            venues: [...byVenue.values()].sort((a, b) => b.usd - a.usd).map((v) => ({ ...v, usd: money(v.usd) })),
            routes: [...byRoute.values()].sort((a, b) => b.usd - a.usd).slice(0, TOP_ROUTES).map((r) => ({ ...r, usd: money(r.usd) })),
            routesTotal: byRoute.size,
          },
          flows: flowRows,
          trades: sorted.slice(0, ACCOUNT_TRADE_ROWS).map((t) => ({
            id: t.id,
            timestamp: t.timestamp,
            height: t.height,
            venue: t.venue,
            tokenIn: t.tokenIn,
            tokenOut: t.tokenOut,
            amountIn: sig6(t.amountIn),
            amountOut: t.amountOut === null ? null : sig6(t.amountOut),
            usd: money(t.usd),
            hops: t.hops,
          })),
          tradesShown: Math.min(sorted.length, ACCOUNT_TRADE_ROWS),
          rates: Object.fromEntries(Object.entries(rates).map(([symbol, rate]) => [symbol, sig6(rate)])),
          meta: {
            liveness: livenessOf({ observedAt, head, headMs, firstDay, lastDay }),
            source: 'hydration',
            sourceLabel: 'Hydration liquidity-pools squid (orca) + chain registry',
            sourceUrl: `${host} · rpc.hydradx.cloud`,
            venue: 'Hydration',
            venueUrl: 'https://app.hydration.net',
            orcaHost: host,
            headBlock: head.height,
            headTime: head.timestamp,
            rateSample: { trades: sample.rows.length, chunks: sample.chunks },
            unknownAssets,
            unmappedAssetIds,
            assetDisagreements: disagreements,
            borrowedMetadata,
            fetchedAt: new Date().toISOString(),
            notes,
          },
        }
      },
    },
  },

  /**
   * Store-backed ingest. Not named `swaps`: a `jobs` entry WINS over an `operations` entry of
   * the same name (server/index.mjs), so calling this one `swaps` would silently take
   * `/api/hydration/swaps` away from the live operation `/hydration/` is drawn from — the page
   * would render, answer 200, and show nothing. One operation, one mode.
   */
  jobs: {
    'swaps-daily': {
      summary:
        'One closed UTC day of Hydration routed trades per stored fact, a calendar month at a time. ' +
        'Fetched once and never again; this is how history reaches back past the live window.',
      schema: {
        // A month, and only a month. The identity has to be a bucket many readers land on, or
        // the store re-fetches the same day once per distinct window — see the note above.
        month: { type: 'string', required: true, pattern: MONTH_RE, maxLength: 7 },
      },

      immutable: (params) => monthIsSettled(params),

      // Knowable without asking anybody: a month has the number of days a month has. The engine
      // records it before the first batch so the coverage bar has a denominator from the start.
      plan: async ({ params }) => ({ totalUnits: daysOfMonth(params?.month ?? '').length || null }),

      async nextBatch({ params, cursor, gate }) {
        const days = daysOfMonth(params.month)
        const state = cursor ?? { day: days[0], fromBlock: null, fromBlockAt: null, blocksPerDay: null }
        const index = days.indexOf(state.day)
        if (index < 0) {
          // A cursor from another month's job, or a hand-edited one. Not weather — say so.
          throw new UpstreamError(`the stored cursor names ${state.day}, which is not a day of ${params.month}.`, {
            kind: 'decode',
            source: ORCA,
          })
        }

        // The hint for finding this day's last block is the PREVIOUS day's measured block count,
        // cut by a quarter. Never an assumed block time — this chain's has moved by a factor of
        // 2.9 inside the range this job backfills.
        const hintBlocks =
          state.blocksPerDay === null || state.blocksPerDay === undefined
            ? FIRST_DAY_HINT_BLOCKS
            : Math.max(1, Math.floor(state.blocksPerDay * 0.75))

        const { day, head, to, toAt, blocksInDay } = await ingestDay({
          gate,
          day: state.day,
          fromBlock: state.fromBlock,
          fromBlockAt: state.fromBlockAt,
          hintBlocks,
        })

        const finished = index + 1 >= days.length
        return {
          rows: [
            {
              segment: state.day,
              payload: day,
              // What this row was computed against, so it can be audited and re-derived.
              head: `orca block ${head.height} @ ${head.timestamp}`,
              codeVersion: SWAPS_DAILY_VERSION,
            },
          ],
          // The next day starts at THIS day's last block — the boundary is carried forward
          // rather than looked up twice. Omitted on the final batch, where the contract keeps
          // the last committed cursor.
          cursor: finished
            ? undefined
            : { day: days[index + 1], fromBlock: to, fromBlockAt: toAt, blocksPerDay: blocksInDay },
          done: finished,
          doneUnits: index + 1,
          totalUnits: days.length,
        }
      },
    },
  },
}
