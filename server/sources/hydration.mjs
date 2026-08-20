// Hydration — the Omnipool DEX on Polkadot.
//
// Two upstreams, both anonymous and both public:
//   · the Subsquid archive at explorer.hydradx.cloud/graphql, which is the same indexer the
//     official Hydration UI uses, for the swap events;
//   · the chain itself at rpc.hydradx.cloud, for the asset registry, because an indexer that
//     hands you `asset: 1000624` and nothing else is not enough to say what was traded.
//
// This page is the descendant of the 2022 Mangata X DEX-stats work in `subflow DEX stats`:
// same questions — what traded, for how much, by whom — against a venue that is still live.
//
// ── the one thing that would silently double every number ───────────────────────────────────
// Hydration emits ONE `Broadcast.Swapped3` per swap LEG, not per trade. A single user swap of
// USDT→GDOT is four legs: AAVE unwrap, stableswap, omnipool in, omnipool out. Summing legs
// would count the same money up to four times, and the result would look entirely plausible.
// Legs of one trade share the first element of `operationStack`, so that is what we group on.
// See docs/platform/hydration.md.

import { graphql, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { deriveRates } from '../../src/core/pricing.js'
import { aggregate, trimForWire, dayOf } from '../../src/core/swaps.js'
import { twox128 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { toHex, fromHex, utf8, concat, u32le } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'

const ARCHIVE = 'https://explorer.hydradx.cloud/graphql'
const RPC = 'https://rpc.hydradx.cloud'

/** ~6 s blocks. Only used to turn "N days" into a height range; every bucket is then stamped
 *  from the block's own timestamp, so drift in this constant cannot mis-date anything. */
const BLOCKS_PER_DAY = 14_400
const PAGE = 1000

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
 * registry — there are thousands of entries and almost all of them are share tokens nobody
 * traded today.
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

/* ---------------------------------------------------------------------- swap events ---- */

const HEAD = '{ blocks(limit: 1, orderBy: height_DESC) { height timestamp } }'

const SWAPS = `
query Swaps($from: Int!, $to: Int!, $limit: Int!, $after: String) {
  events(
    where: { name_eq: "Broadcast.Swapped3", block: { height_gte: $from, height_lt: $to }, id_gt: $after }
    orderBy: id_ASC
    limit: $limit
  ) {
    id
    indexInBlock
    args
    block { height timestamp }
  }
}`

/**
 * Keyset paging on `id`, not `offset`. Offset paging over a hundred thousand rows makes the
 * archive re-scan from the top on every page, and the last page costs the most; keyset paging
 * costs the same for page 1 and page 90.
 */
async function fetchLegs(from, to, onPage) {
  let after = ''
  let total = 0
  for (;;) {
    const data = await graphql({
      source: 'hydration-archive',
      url: ARCHIVE,
      query: SWAPS,
      variables: { from, to, limit: PAGE, after },
      timeoutMs: 60_000,
    })
    const events = data.events ?? []
    if (!events.length) break
    onPage(events)
    total += events.length
    after = events[events.length - 1].id
    if (events.length < PAGE) break
  }
  return total
}

/* --------------------------------------------------------------------- pallet names ---- */

// A swapper beginning with the ASCII "modl" is a pallet account, not a person: Substrate
// derives them from a PalletId. Naming them matters because several of the busiest "traders"
// on any given day are the fee processor and the referrals pot recycling protocol income —
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

/** The first element of the stack is the thing the user actually asked for; the rest are how it got done. */
function origin(stack) {
  const first = Array.isArray(stack) && stack.length ? stack[0] : null
  if (!first) return { kind: 'Direct', key: null }
  return { kind: first.__kind ?? 'Unknown', key: `${first.__kind}:${first.value}` }
}

export default {
  id: 'hydration',
  label: 'Hydration (Omnipool)',
  homepage: 'https://hydration.net',
  transport: 'graphql+jsonrpc',
  doc: 'docs/platform/hydration.md',
  covers: ['Hydration (Polkadot parachain 2034)'],

  operations: {
    swaps: {
      summary: 'Hydration swaps over a recent window, grouped into trades, valued and rolled up.',
      // Fifteen minutes. A full window is ~55 s and ~60 MB of upstream traffic; doing that on
      // every pageview would make this site the archive's heaviest client by a wide margin.
      ttlMs: 900_000,
      schema: {
        // Capped at seven deliberately. Each extra day is another ~11,000 legs and another
        // ~8 MB from an indexer we do not own. The cap is a cost decision, and the page says so
        // rather than pretending the window is a preference.
        days: { type: 'int', min: 1, max: 7, default: 3 },
      },

      async run({ days }) {
        await verifyRegistry()

        const head = (await graphql({ source: 'hydration-archive', url: ARCHIVE, query: HEAD })).blocks[0]
        const to = head.height + 1
        const from = Math.max(0, to - days * BLOCKS_PER_DAY)

        /** @type {Map<string, {legs: any[]}>} */
        const groups = new Map()
        const assetIds = new Set()

        const legCount = await fetchLegs(from, to, (events) => {
          for (const event of events) {
            const args = event.args ?? {}
            const { kind, key } = origin(args.operationStack)
            // A leg with no operation stack stands alone — its own trade, one hop long.
            const groupKey = key ? `${event.block.height}:${key}` : `solo:${event.id}`
            const group = groups.get(groupKey) || { legs: [], originKind: kind }
            group.legs.push({
              index: event.indexInBlock,
              height: event.block.height,
              timestamp: Math.floor(new Date(event.block.timestamp).getTime() / 1000),
              swapper: args.swapper,
              filler: args.fillerType?.__kind ?? 'Unknown',
              inputs: args.inputs ?? [],
              outputs: args.outputs ?? [],
              id: event.id,
            })
            groups.set(groupKey, group)
            for (const side of [args.inputs, args.outputs]) {
              for (const leg of side ?? []) assetIds.add(Number(leg.asset))
            }
          }
        })

        const assets = await fetchAssets([...assetIds])
        const symbolOf = (id) => assets.get(Number(id))?.symbol ?? null

        // Two registered assets can carry the same ticker — a bridged USDT and a native one,
        // an Erc20 wrapper and the token it wraps. Collapsing them onto one label turns a real
        // arbitrage between two representations into a nonsensical USDT→USDT route. So a
        // symbol shared by more than one traded asset gets its id appended, and only then.
        const symbolUsers = new Map()
        for (const id of assetIds) {
          const symbol = symbolOf(id)
          if (symbol) symbolUsers.set(symbol, (symbolUsers.get(symbol) ?? 0) + 1)
        }
        const labelOf = (id) => {
          const symbol = symbolOf(id)
          if (!symbol) return null
          return symbolUsers.get(symbol) > 1 ? `${symbol}·${id}` : symbol
        }
        const amountOf = (leg) => {
          const asset = assets.get(Number(leg.asset))
          if (!asset || asset.decimals === null) return null
          return Number(leg.amount) / 10 ** asset.decimals
        }

        // One trade per group: first leg in, last leg out, ordered the way the block executed.
        const raw = []
        for (const [key, group] of groups) {
          const legs = group.legs.sort((a, b) => a.index - b.index)
          const firstIn = legs[0].inputs[0]
          const lastOut = legs[legs.length - 1].outputs[0]
          if (!firstIn || !lastOut) continue
          raw.push({
            key,
            legs,
            originKind: group.originKind,
            swapper: legs[0].swapper,
            timestamp: legs[0].timestamp,
            inAsset: Number(firstIn.asset),
            inAmount: amountOf(firstIn),
            outAsset: Number(lastOut.asset),
            outAmount: amountOf(lastOut),
            pools: [...new Set(legs.map((l) => l.filler))].join('+'),
          })
        }

        const { rates } = deriveRates(
          raw
            .filter((t) => t.inAmount && t.outAmount)
            .map((t) => ({
              inSymbol: symbolOf(t.inAsset),
              inAmount: t.inAmount,
              outSymbol: symbolOf(t.outAsset),
              outAmount: t.outAmount,
            })),
        )

        const unknownAssets = [...assetIds].filter((id) => !assets.has(id) || assets.get(id).decimals === null)

        const trades = raw.map((t) => {
          const symbol = symbolOf(t.inAsset)
          const rate = symbol === null ? undefined : rates[symbol]
          const pallet = palletName(t.swapper)
          return {
            id: t.key,
            account: pallet ?? String(t.swapper).toLowerCase(),
            timestamp: t.timestamp,
            date: dayOf(t.timestamp),
            // The stacked dimension is HOW THE TRADE WAS INITIATED — a direct swap, a router
            // route, a DCA schedule instalment, a batch. On a venue where a single Omnipool is
            // most of the liquidity, that is the question with an interesting answer.
            //
            // Whatever the chain sends is used as-is rather than mapped onto a fixed list. The
            // variant set is open-ended and a hardcoded one goes stale silently: a new execution
            // type would land in whichever bucket the mapping defaulted to. Verified live in
            // runtime 435: Omnipool, Router, DCA, Batch — plus `Direct`, which is ours, for a
            // leg that arrives with no operation stack at all.
            venue: t.originKind,
            destination: t.pools,
            tokenIn: labelOf(t.inAsset),
            tokenOut: labelOf(t.outAsset),
            amountIn: t.inAmount ?? 0,
            usd: rate === undefined || t.inAmount === null ? null : t.inAmount * rate,
            hops: t.legs.length,
            isPallet: Boolean(pallet),
          }
        })

        const palletTrades = trades.filter((t) => t.isPallet)
        const result = aggregate({
          trades,
          rates,
          meta: {
            venue: 'Hydration',
            venueUrl: 'https://app.hydration.net',
            source: 'hydration',
            sourceLabel: 'Hydration archive + RPC',
            sourceUrl: 'explorer.hydradx.cloud · rpc.hydradx.cloud',
            unit: 'trade',
            unitPlural: 'trades',
            venueLabel: 'how the trade was initiated',
            window: `the last ${days} day${days === 1 ? '' : 's'}`,
            windowDays: days,
            blockRange: [from, to - 1],
            headBlock: head.height,
            headTime: head.timestamp,
            legCount,
            tradeCount: trades.length,
            palletTrades: palletTrades.length,
            palletUsd: palletTrades.reduce((s, t) => s + (t.usd || 0), 0),
            unknownAssets,
            fetchedAt: new Date().toISOString(),
            notes: [
              'Hydration emits one event per swap LEG. Legs sharing the first element of the operation stack are one trade — without that grouping a four-hop route would count as four trades and four times the volume.',
              'Volume is the value of the first leg IN: what the trader actually sent, before any hop.',
              'Accounts beginning with the ASCII "modl" are pallet accounts, not people. They are labelled as such and left in the totals, because the money did move; the summary states how much of the volume they are.',
              'Prices are derived from the trades themselves against dollar-pegged legs. An asset that never traded against a priced one in this window has no rate and is excluded from the dollar total but counted in the trade count.',
            ],
          },
        })

        return trimForWire(result)
      },
    },
  },
}
