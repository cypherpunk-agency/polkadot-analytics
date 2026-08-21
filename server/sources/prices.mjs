// Dollars. The one place an asset becomes a USD figure, and the one place that decides it cannot.
//
// Decision 0008 settled where a price comes from: Hydration's money-market oracle, read on chain,
// no off-chain feed. Decision 0009 settled how a second module gets one: a pricing source that
// other sources compose, one level deep, `null` propagating and never degrading to `0`. Decision
// 0013 settled the shape of THIS file, because 0009's one-line rule ("the pricer calls no one")
// does not survive contact with a valuation. So, stated once and true of every line below:
//
//   ┌─ THE PRICING HALF ──────────────────────────────────────────────────────────────────────┐
//   │ imports NOTHING from server/sources/. One upstream: rpc.hydradx.cloud. Answers           │
//   │ /api/prices/hydration-oracle, and exports `quotes()` for any source to call in-process.  │
//   └─────────────────────────────────────────────────────────────────────────────────────────┘
//   ┌─ THE VALUATION HALF ────────────────────────────────────────────────────────────────────┐
//   │ imports asset-hub.mjs read-only through its public `operations` table, and multiplies.   │
//   │ Fetches nothing itself. Answers /api/prices/bridged. Moving it into asset-hub.mjs later  │
//   │ is a clean win and nothing here stands in the way.                                       │
//   └─────────────────────────────────────────────────────────────────────────────────────────┘
//
// ── the two things this module exists to not get wrong ─────────────────────────────────────
//
// 1. A PRICE FOR THE WRONG ASSET. Hydration's oracle prices assets called USDT, USDC, WBTC and
//    EURC, and NONE of them is the asset Asset Hub's /bridged/ page is about. Read live from
//    `AssetRegistry::AssetLocations` on 2026-08-21:
//
//      id 10  USDT     {parents:1, X3(Parachain(1000), PalletInstance(50), GeneralIndex(1984))}
//                      → Asset Hub's OWN USDt, the one /bridged/ says is not bridged
//      id 22  USDC     …GeneralIndex(1337) → Asset Hub's own Circle USDC, likewise
//      id 19  WBTC     GeneralKey("wh") + GeneralIndex(2) + GeneralKey(0x…2260fac5…)
//                      → WORMHOLE-wrapped Ethereum WBTC
//      id 1000190      {parents:2, X2(GlobalConsensus(Ethereum{1}), AccountKey20(0x2260fa…))}
//                      → the SAME Ethereum contract over SNOWBRIDGE. getAssetPrice REVERTS on it.
//
//    So the join key is the SCALE bytes of the XCM location and nothing else — not the ticker,
//    and not the underlying ERC-20 address, because the bridge that wrapped it is part of the
//    asset's identity. Two WBTCs and two sUSDSs on Hydration are backed by one Ethereum contract
//    each. Substituting one's price onto the other would be within a fraction of a percent of
//    right today and would be a claim this repository has no evidence for.
//
// 2. A DIVISOR FROM THE WRONG CHAIN. A price is per whole token; an amount is raw units divided
//    by decimals. If the two chains disagree about decimals, the product is wrong by a factor of
//    10ⁿ and renders perfectly. So every matched asset's decimals are compared and a disagreement
//    is REFUSED (`decimals-disagree`, price null) rather than resolved. On all 16 matched-and-
//    scaled bridged assets they agreed on 2026-08-21.
//
// ── what can be priced, measured rather than assumed ───────────────────────────────────────
// `getAssetPrice` was called on all 1,438 registry ids on 2026-08-21. It answered for 22 — which
// is `Pool.getReservesList()` minus HOLLAR. The oracle is the collateral valuation of one Aave
// fork, not a price feed for the chain: a revert means "not a reserve", not "no market".
//
// The Omnipool's own implied spot covers a DIFFERENT 19 assets and is published as a second,
// separately labelled source. It is not a guess: four assets are in both venues and the two
// constructions agreed to 0.51 % worst case that day (vDOT +0.12 %, PAXG +0.51 %, HOLLAR −0.12 %,
// tBTC −0.26 %). That cross-check is recomputed on every read and published, so the day it stops
// agreeing is a number on the page rather than a silent drift.
//
// Full working, with the responses: docs/platform/prices.md.

import assetHub from './asset-hub.mjs'
import { TtlCache } from '../lib/cache.mjs'
import { callUpstream, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { twox128, xxhash64 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { keccakHex } from '../../src/core/codec/keccak.js'
import { toHex, fromHex, utf8, concat, u32le } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'
import { liveness } from '../../src/core/liveness.js'

const RPC = 'https://rpc.hydradx.cloud'
const LABEL = 'Hydration (parachain 2034) — money-market oracle and Omnipool'

/** Ids, not addresses. An id is legible and its registry entry carries a symbol to assert on. */
const ANCHOR_ATOKEN = 1001 // aDOT — leads to the Pool, and therefore to the oracle
const ANCHOR_UNDERLYING = 5 // DOT
const HUB_ID = 1 // H2O, the Omnipool hub asset. Renamed from LRNA; the registry is the authority.
const NATIVE_ID = 0 // HDX — pallet-balances, not orml

/** `modl` + `omnipool`, right-padded to 32 bytes. The EVM side sees the first 20. */
const OMNIPOOL_ACCOUNT = `0x6d6f646c6f6d6e69706f6f6c${'00'.repeat(20)}`

/**
 * Registry self-check. Same idea as `arbs-hydration.mjs`'s `[5,'DOT',10]`: assert a known value
 * and throw, rather than publish amounts scaled by a layout we no longer understand.
 */
const REGISTRY_CANARIES = [
  [5, 'DOT', 10],
  [1001, 'aDOT', 10],
  [222, 'HOLLAR', 18],
]

/**
 * Plausibility bands, and the reason they are this wide.
 *
 * These do not encode a view about what DOT is worth. The failure they exist to catch is a factor
 * of 10ⁿ — a wrong `BASE_CURRENCY_UNIT`, a wrong decimals, a misread word offset — and every one
 * of those lands at least a decade away from the truth. A tight band would break on an ordinary
 * market move and teach the next person to widen it; a band this wide only ever fires on the class
 * of bug that renders perfectly.
 *
 * The stablecoins are the second canary and they matter because they sit at a DIFFERENT magnitude
 * from DOT: an error that happens to leave DOT inside its band will not leave a dollar inside
 * $0.50–$2.00 as well. They are checked only when present — a delisting must not take the site
 * down — and DOT is mandatory, because if the oracle cannot price DOT then the discovery chain
 * that found the oracle is what is wrong.
 */
const DOT_BAND = [0.05, 50]
const STABLE_BAND = [0.5, 2]
const STABLE_CANARIES = [
  [10, 'USDT'],
  [22, 'USDC'],
]

/** Registry asset types, in `AssetType`'s own variant order. */
const ASSET_TYPE = ['Token', 'XYK', 'StableSwap', 'Bond', 'External', 'Erc20']

/* ------------------------------------------------------------------------- selectors ---- */

/** Computed, never copied. `keccakHex` self-checks against two known digests in its own module. */
const selector = (signature) => keccakHex(signature).slice(0, 10)

const SEL = {
  pool: selector('POOL()'),
  underlying: selector('UNDERLYING_ASSET_ADDRESS()'),
  addressesProvider: selector('ADDRESSES_PROVIDER()'),
  getPool: selector('getPool()'),
  getPriceOracle: selector('getPriceOracle()'),
  baseCurrencyUnit: selector('BASE_CURRENCY_UNIT()'),
  getAssetPrice: selector('getAssetPrice(address)'),
  balanceOf: selector('balanceOf(address)'),
}

/* ---------------------------------------------------------------------- storage keys ---- */

// Computed, never hardcoded. A hardcoded prefix is right until a runtime upgrade moves it, and
// then reads as "this map is empty" rather than as an error.

const palletPrefix = (pallet, item) => '0x' + toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))

function twox64Concat(bytes) {
  const digest = new Uint8Array(8)
  new DataView(digest.buffer).setBigUint64(0, xxhash64(bytes, 0), true)
  return toHex(digest) + toHex(bytes)
}

const blake2Concat = (bytes) => toHex(blake2b(bytes, 16)) + toHex(bytes)

const registryKey = (item, id) => palletPrefix('AssetRegistry', item) + blake2Concat(u32le(id))
const omnipoolKey = (id) => palletPrefix('Omnipool', 'Assets') + blake2Concat(u32le(id))
const tokensAccountKey = (account, id) =>
  palletPrefix('Tokens', 'Accounts') + blake2Concat(fromHex(account)) + twox64Concat(u32le(id))
const systemAccountKey = (account) => palletPrefix('System', 'Account') + blake2Concat(fromHex(account))

/** The id is the concat half of `Blake2_128Concat`: the last four bytes, little-endian. */
const idFromKey = (key) => parseInt((key.slice(key.length - 8).match(/../g) ?? []).reverse().join(''), 16)

/** A Substrate registry asset's address on Hydration's EVM: 31 zero bytes, `01`, then the id BE. */
const evmAddressOfAsset = (id) => `0x${'0'.repeat(31)}1${Number(id).toString(16).padStart(8, '0')}`

/**
 * What the oracle is keyed by for this asset, and it is NOT one thing.
 *
 * An `Erc20`-typed registry asset is a real contract on Hydration's own EVM and the oracle knows
 * it by that address; everything else is a Substrate asset and the oracle knows it by the
 * synthetic form above. Asking for the wrong one does not error — it reverts, which this module
 * reads as "no price". HOLLAR is the live proof: keyed by id it looks unpriceable and quietly
 * falls through to the Omnipool path, taking the market's best dollar anchor out of the median.
 */
const oracleAddressOf = (entry, id) =>
  (entry?.type === 'Erc20' ? decodeErc20Location(entry.locationHex) : null) ?? evmAddressOfAsset(id)

/* ------------------------------------------------------------------------- decoding ---- */

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64)
const uintAt = (hex, i) => BigInt('0x' + word(hex, i))
const addressAt = (hex, i) => '0x' + word(hex, i).slice(24)
const padWord = (value) => String(value).replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** A little-endian unsigned integer of `bytes` bytes at `offset`, as a BigInt. */
function decodeUintLe(hex, offset, bytes) {
  if (!hex) return null
  const raw = fromHex(hex)
  if (raw.length < offset + bytes) return null
  let value = 0n
  for (let i = bytes - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(raw[offset + i])
  return value
}

/**
 * `AssetDetails` — and it throws unless it consumes its input EXACTLY. Wrong decimals are a
 * silent factor of 10ⁿ on every figure downstream, so the layout has to fail loudly.
 */
function decodeAssetDetails(hex) {
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

  const name = optionalText()
  const typeIndex = byte()
  at += 16 // existential_deposit
  const symbol = optionalText()
  const decimals = byte() === 1 ? byte() : null
  if (byte() === 1) at += 16 // xcm_rate_limit
  byte() // is_sufficient

  if (at !== bytes.length) {
    throw new Error(`AssetDetails left ${bytes.length - at} byte(s) undecoded — the runtime layout has changed`)
  }
  return { name, type: ASSET_TYPE[typeIndex] ?? `type-${typeIndex}`, symbol, decimals }
}

/** `AssetState` — five u128s and a tradable byte. Only `hub_reserve` is used here. */
function decodeHubReserve(hex) {
  const bytes = fromHex(hex)
  if (bytes.length !== 65) throw new Error(`AssetState is ${bytes.length} bytes, expected 65`)
  return decodeUintLe(hex, 0, 16)
}

/** `frame_system::AccountInfo` — four u32s, then `AccountData`. `free` starts at byte 16. */
const decodeSystemFree = (hex) => decodeUintLe(hex, 16, 16)

/** orml `AccountData { free, reserved, frozen }`. */
const decodeOrmlFree = (hex) => decodeUintLe(hex, 0, 16)

/** An `Erc20` asset's contract: `{parents: 0, X1(AccountKey20(none, key))}` = `0x00010300` + 20. */
function decodeErc20Location(hex) {
  if (!hex) return null
  const bytes = hex.replace(/^0x/, '').toLowerCase()
  if (bytes.length !== 48 || !bytes.startsWith('00010300')) return null
  return '0x' + bytes.slice(8)
}

/* ------------------------------------------------------------------------ transports ---- */

/**
 * A JSON-RPC batch of `eth_call`. Per-item failures are RETURNED, not thrown: a reverting
 * `getAssetPrice` is the ordinary answer for an asset the oracle does not carry, and turning it
 * into an exception would make an unpriceable asset take the page down with it.
 */
async function ethCallBatch(calls) {
  if (!calls.length) return []
  const body = calls.map((call, id) => ({
    jsonrpc: '2.0',
    id,
    method: 'eth_call',
    params: [{ to: call.to, data: call.data }, 'latest'],
  }))
  const answer = await callUpstream({ source: 'prices', url: RPC, method: 'POST', body, timeoutMs: 45_000 })
  if (!Array.isArray(answer)) {
    throw new UpstreamError('the node answered a JSON-RPC batch with something that is not an array.', {
      kind: 'decode',
      source: 'prices',
    })
  }
  const out = new Array(calls.length).fill(null)
  for (const item of answer) {
    if (!Number.isInteger(item?.id) || item.id < 0 || item.id >= calls.length) continue
    out[item.id] = item.error ? { error: String(item.error.message ?? 'reverted') } : { result: item.result }
  }
  return out
}

/** The same batch, but every item must succeed — for the discovery chain, where a revert means
 *  we do not know where the oracle is and therefore must not publish a price. */
async function ethCallAll(calls, what) {
  const results = await ethCallBatch(calls)
  return results.map((item, i) => {
    if (!item?.result || item.result === '0x') {
      throw new UpstreamError(
        `${what}: call ${i} (${calls[i].data.slice(0, 10)} on ${calls[i].to}) failed — ${item?.error ?? 'empty return'}.`,
        { kind: 'upstream', source: 'prices' },
      )
    }
    return item.result
  })
}

/** Several storage keys, one request. A missing key comes back `null` — a fact, not an error. */
async function storageAt(keys) {
  const out = new Map()
  for (let i = 0; i < keys.length; i += 250) {
    const chunk = keys.slice(i, i + 250)
    const changes = await jsonRpc({
      source: 'prices',
      url: RPC,
      method: 'state_queryStorageAt',
      params: [chunk],
      timeoutMs: 45_000,
    })
    for (const [key, value] of changes?.[0]?.changes ?? []) out.set(key.toLowerCase(), value)
  }
  return keys.map((key) => out.get(key.toLowerCase()) ?? null)
}

async function allKeys(prefix) {
  const out = []
  let start
  for (;;) {
    const page = await jsonRpc({
      source: 'prices',
      url: RPC,
      method: 'state_getKeysPaged',
      params: [prefix, 500, start],
      timeoutMs: 45_000,
    })
    if (!page?.length) break
    out.push(...page)
    if (page.length < 500) break
    start = page[page.length - 1]
  }
  return out
}

/* --------------------------------------------------------------------------- numbers ---- */

const scaled = (raw, decimals) =>
  raw === null || raw === undefined || decimals === null || decimals === undefined
    ? null
    : Number(raw) / 10 ** decimals

/** `null` in, `null` out. Never zero — see rule 3 and every entry in `Facts worth not re-deriving`. */
const sumOrNull = (values) => {
  const known = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v))
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/* ═══════════════════════════════════════════════════════════ THE PRICING HALF ═══════════ */

/**
 * Where the oracle is, derived rather than declared, with every hop checked against the next.
 * `Liquidation::BorrowingContract` is where circulating notes say the Pool address lives; it
 * reads `null` on chain, so anything trusting it gets the zero address.
 */
async function discover() {
  const [anchorDetails, anchorLocation, hubDetails] = await storageAt([
    registryKey('Assets', ANCHOR_ATOKEN),
    registryKey('AssetLocations', ANCHOR_ATOKEN),
    registryKey('Assets', HUB_ID),
  ])

  if (!anchorDetails) {
    throw new UpstreamError(`AssetRegistry has no asset ${ANCHOR_ATOKEN}; the discovery anchor is gone.`, {
      kind: 'upstream',
      source: 'prices',
    })
  }

  let anchor
  let hub
  try {
    anchor = decodeAssetDetails(anchorDetails)
    hub = hubDetails ? decodeAssetDetails(hubDetails) : null
  } catch (error) {
    throw new UpstreamError(`asset registry: ${error.message}`, { kind: 'decode', source: 'prices' })
  }
  if (anchor.type !== 'Erc20' || anchor.symbol !== 'aDOT') {
    throw new UpstreamError(
      `asset ${ANCHOR_ATOKEN} decoded as ${anchor.symbol}/${anchor.type}, expected aDOT/Erc20. ` +
        'Refusing to follow it to an oracle address.',
      { kind: 'decode', source: 'prices' },
    )
  }
  if (!hub || hub.decimals === null) {
    throw new UpstreamError(`the Omnipool hub asset (id ${HUB_ID}) has no decimals in the registry.`, {
      kind: 'decode',
      source: 'prices',
    })
  }

  const anchorToken = decodeErc20Location(anchorLocation)
  if (!anchorToken) {
    throw new UpstreamError(`AssetLocations(${ANCHOR_ATOKEN}) is not the AccountKey20 shape an Erc20 asset has.`, {
      kind: 'decode',
      source: 'prices',
    })
  }

  const [underlyingRaw, poolRaw] = await ethCallAll(
    [
      { to: anchorToken, data: SEL.underlying },
      { to: anchorToken, data: SEL.pool },
    ],
    'aToken discovery',
  )
  const expected = evmAddressOfAsset(ANCHOR_UNDERLYING)
  if (addressAt(underlyingRaw, 0) !== expected) {
    throw new UpstreamError(
      `the aDOT aToken says its underlying is ${addressAt(underlyingRaw, 0)}, not DOT (${expected}).`,
      { kind: 'decode', source: 'prices' },
    )
  }
  const pool = addressAt(poolRaw, 0)

  const [providerRaw] = await ethCallAll([{ to: pool, data: SEL.addressesProvider }], 'addresses provider')
  const provider = addressAt(providerRaw, 0)

  const [roundTrip, oracleRaw] = await ethCallAll(
    [
      { to: provider, data: SEL.getPool },
      { to: provider, data: SEL.getPriceOracle },
    ],
    'addresses provider registry',
  )
  if (addressAt(roundTrip, 0) !== pool) {
    throw new UpstreamError(
      `the addresses provider names ${addressAt(roundTrip, 0)} as the pool, but the aDOT aToken names ${pool}.`,
      { kind: 'decode', source: 'prices' },
    )
  }
  const oracle = addressAt(oracleRaw, 0)

  const [baseUnitRaw] = await ethCallAll([{ to: oracle, data: SEL.baseCurrencyUnit }], 'oracle base unit')
  const baseCurrencyUnit = Number(uintAt(baseUnitRaw, 0))
  // A base unit that is not a positive power of ten is the exact shape of a 10ⁿ error, and every
  // price divided by it would be plausible and wrong.
  if (!(baseCurrencyUnit > 0) || !Number.isInteger(Math.log10(baseCurrencyUnit))) {
    throw new UpstreamError(
      `the price oracle reports a base currency unit of ${baseCurrencyUnit}, which is not a power of ten.`,
      { kind: 'decode', source: 'prices' },
    )
  }

  return { pool, provider, oracle, anchorToken, baseCurrencyUnit, hubDecimals: hub.decimals, hubSymbol: hub.symbol }
}

/** Head and clock, from the chain's own timestamp — a node can answer everything and be weeks old. */
async function readChain() {
  const [header, runtime, nowRaw] = await Promise.all([
    jsonRpc({ source: 'prices', url: RPC, method: 'chain_getHeader', params: [], timeoutMs: 20_000 }),
    jsonRpc({ source: 'prices', url: RPC, method: 'state_getRuntimeVersion', params: [], timeoutMs: 20_000 }),
    jsonRpc({
      source: 'prices',
      url: RPC,
      method: 'state_getStorage',
      params: [palletPrefix('Timestamp', 'Now')],
      timeoutMs: 20_000,
    }),
  ])
  const ms = decodeUintLe(nowRaw, 0, 8)
  return {
    block: Number.parseInt(header?.number ?? '0x0', 16),
    specName: runtime?.specName ?? null,
    specVersion: runtime?.specVersion ?? null,
    timeMs: ms === null ? null : Number(ms),
  }
}

/** Every registered asset: id → { symbol, decimals, type, locationHex }. */
async function readRegistry() {
  const assetsPrefix = palletPrefix('AssetRegistry', 'Assets')
  const keys = await allKeys(assetsPrefix)
  const ids = keys.map(idFromKey).sort((a, b) => a - b)
  const [details, locations] = await Promise.all([
    storageAt(ids.map((id) => registryKey('Assets', id))),
    storageAt(ids.map((id) => registryKey('AssetLocations', id))),
  ])

  const byId = new Map()
  for (let i = 0; i < ids.length; i += 1) {
    if (!details[i]) continue
    let decoded
    try {
      decoded = decodeAssetDetails(details[i])
    } catch (error) {
      throw new UpstreamError(`asset ${ids[i]}: ${error.message}`, { kind: 'decode', source: 'prices' })
    }
    byId.set(ids[i], { id: ids[i], ...decoded, locationHex: locations[i] ? locations[i].toLowerCase() : null })
  }

  for (const [id, symbol, decimals] of REGISTRY_CANARIES) {
    const got = byId.get(id)
    if (!got || got.symbol !== symbol || got.decimals !== decimals) {
      throw new UpstreamError(
        `asset registry self-check failed: asset ${id} decoded as ${got ? `${got.symbol}/${got.decimals}` : 'missing'}, ` +
          `expected ${symbol}/${decimals}. Refusing to publish prices scaled by a layout we no longer understand.`,
        { kind: 'decode', source: 'prices' },
      )
    }
  }
  return byId
}

/**
 * The oracle's own answers. One `eth_call` per registered asset, batched — 1,438 assets cost
 * twelve requests. Sweeping the whole registry rather than a candidate list is deliberate: the
 * priced set is what it is on the day, and a hand-kept list of "assets the oracle carries" would
 * be wrong within a month and would be wrong SILENTLY, by omitting an asset that gained a price.
 */
async function readOraclePrices(registry, { oracle, baseCurrencyUnit }) {
  const ids = [...registry.keys()]
  const prices = new Map()
  for (let i = 0; i < ids.length; i += 120) {
    const chunk = ids.slice(i, i + 120)
    const answers = await ethCallBatch(
      chunk.map((id) => ({ to: oracle, data: SEL.getAssetPrice + padWord(oracleAddressOf(registry.get(id), id)) })),
    )
    chunk.forEach((id, j) => {
      const answer = answers[j]
      if (!answer?.result || answer.result === '0x') return
      const value = Number(uintAt(answer.result, 0)) / baseCurrencyUnit
      // A zero is not a price. Aave's fallback path can answer 0 for an asset with no source, and
      // `0` here would mean "this is worth nothing" everywhere downstream.
      if (value > 0) prices.set(id, value)
    })
  }
  return prices
}

/**
 * The Omnipool's implied spot, for the assets the oracle does not carry.
 *
 * The reserve read is the trap and it is why this is not four lines: `Tokens::Accounts` returns
 * `null` for the `Erc20`-typed assets and for HDX, which is `pallet-balances` and not orml at all.
 * Three storage paths, one balance sheet; miss one and the asset silently disappears rather than
 * erroring — and the missing ones include the largest.
 */
async function readOmnipool(registry, oraclePrices, { hubDecimals }) {
  const prefix = palletPrefix('Omnipool', 'Assets')
  const keys = await allKeys(prefix)
  if (!keys.length) return null
  const ids = keys.map(idFromKey)

  const states = await storageAt(ids.map(omnipoolKey))
  const balances = await storageAt([
    ...ids.map((id) => tokensAccountKey(OMNIPOOL_ACCOUNT, id)),
    systemAccountKey(OMNIPOOL_ACCOUNT),
  ])
  const ormlRaw = balances.slice(0, ids.length)
  const nativeFree = decodeSystemFree(balances[ids.length])

  const rows = ids.map((id, i) => {
    const entry = registry.get(id) ?? null
    const isErc20 = entry?.type === 'Erc20'
    let hubReserveRaw = null
    try {
      hubReserveRaw = states[i] ? decodeHubReserve(states[i]) : null
    } catch (error) {
      throw new UpstreamError(`Omnipool asset ${id}: ${error.message}`, { kind: 'decode', source: 'prices' })
    }
    return {
      id,
      symbol: entry?.symbol ?? null,
      decimals: entry?.decimals ?? null,
      contract: isErc20 ? decodeErc20Location(entry?.locationHex) : null,
      readPath: isErc20 ? 'evm' : id === NATIVE_ID ? 'system' : 'orml',
      hubReserve: scaled(hubReserveRaw, hubDecimals),
      ormlFree: ormlRaw[i] ? decodeOrmlFree(ormlRaw[i]) : null,
      nativeFree,
    }
  })

  const erc20 = rows.filter((r) => r.readPath === 'evm' && r.contract)
  const evmBalances = await ethCallBatch(
    erc20.map((r) => ({ to: r.contract, data: SEL.balanceOf + padWord(OMNIPOOL_ACCOUNT.slice(0, 42)) })),
  )
  const evmBalance = new Map(
    erc20.map((r, i) => [r.id, evmBalances[i]?.result && evmBalances[i].result !== '0x' ? uintAt(evmBalances[i].result, 0) : null]),
  )

  for (const row of rows) {
    const raw = row.readPath === 'evm' ? evmBalance.get(row.id) ?? null : row.readPath === 'system' ? row.nativeFree : row.ormlFree
    row.reserve = scaled(raw, row.decimals)
    row.oraclePrice = oraclePrices.get(row.id) ?? null
    delete row.ormlFree
    delete row.nativeFree
  }

  // Anchor the hub asset against everything the oracle already prices, then read every other
  // asset off that anchor. The spread between anchors is published rather than smoothed away:
  // it is the only visible measure of how much the two venues disagree.
  const anchors = rows
    .filter((r) => r.oraclePrice !== null && r.reserve && r.hubReserve)
    .map((r) => ({ symbol: r.symbol, hubUsd: (r.reserve * r.oraclePrice) / r.hubReserve }))
  const hubUsd = median(anchors.map((a) => a.hubUsd))
  const spreadBps =
    anchors.length > 1 && hubUsd
      ? ((Math.max(...anchors.map((a) => a.hubUsd)) - Math.min(...anchors.map((a) => a.hubUsd))) / hubUsd) * 10_000
      : null

  for (const row of rows) {
    row.spotUsd = hubUsd === null || !row.reserve || row.hubReserve === null ? null : (row.hubReserve * hubUsd) / row.reserve
  }

  return { hubUsd, spreadBps, anchors: anchors.map((a) => a.symbol), rows }
}

/**
 * The pricing half's whole output. Cached here rather than by its callers, so two modules in the
 * same minute cannot value the same asset at two different prices (decision 0009).
 */
const memo = new TtlCache({ maxEntries: 4, maxBytes: 8 * 1024 * 1024 })
const QUOTE_TTL_MS = 300_000

/**
 * @returns {Promise<{
 *   fetchedAt: string, chain: object, oracle: object, omnipool: object|null,
 *   quotes: Array<{id:number, symbol:string|null, decimals:number|null, type:string|null,
 *                  locationHex:string|null, usd:number, source:string}>,
 *   byLocation: Map<string, object>, crossCheck: Array<object>, counts: object,
 *   liveness: object
 * }>}
 */
export function quotes() {
  return memo.resolve('hydration-oracle', QUOTE_TTL_MS, buildQuotes)
}

async function buildQuotes() {
  const startedAt = Date.now()
  const [chain, found] = await Promise.all([readChain(), discover()])
  const registry = await readRegistry()
  const oraclePrices = await readOraclePrices(registry, found)

  // ── canary one: DOT. Mandatory, because if the oracle cannot price DOT then the chain that
  // led us to the oracle is what is wrong, and every other price it returns is suspect too.
  const dot = oraclePrices.get(ANCHOR_UNDERLYING) ?? null
  if (dot === null) {
    throw new UpstreamError(
      `the price oracle at ${found.oracle} does not price DOT (asset ${ANCHOR_UNDERLYING}). ` +
        'DOT is the anchor of the discovery chain that found it, so this is a broken read rather than a delisting.',
      { kind: 'upstream', source: 'prices' },
    )
  }
  if (dot < DOT_BAND[0] || dot > DOT_BAND[1]) {
    throw new UpstreamError(
      `the oracle prices DOT at $${dot}, outside the $${DOT_BAND[0]}–$${DOT_BAND[1]} plausibility band. ` +
        'That band is wide enough that only a factor-of-ten error reaches it, so this is a decoding or ' +
        'base-unit fault rather than a market move. Refusing to publish dollar figures.',
      { kind: 'decode', source: 'prices' },
    )
  }

  // ── canary two: the dollar itself, at a different order of magnitude from DOT. Conditional,
  // because a delisting must not take the site down — but an out-of-band answer must.
  for (const [id, symbol] of STABLE_CANARIES) {
    const price = oraclePrices.get(id)
    if (price === undefined) continue
    if (price < STABLE_BAND[0] || price > STABLE_BAND[1]) {
      throw new UpstreamError(
        `the oracle prices ${symbol} (asset ${id}) at $${price}, outside $${STABLE_BAND[0]}–$${STABLE_BAND[1]}. ` +
          'A dollar-pegged asset that far from a dollar is a scaling fault, not a depeg.',
        { kind: 'decode', source: 'prices' },
      )
    }
  }

  const omnipool = await readOmnipool(registry, oraclePrices, found)

  // Both paths, oracle first. The `source` label travels with the number for its whole life —
  // merging them would make a 0.5 %-different construction indistinguishable from the oracle's.
  const quoteList = []
  for (const [id, usd] of oraclePrices) {
    const entry = registry.get(id)
    quoteList.push({
      id,
      symbol: entry?.symbol ?? null,
      decimals: entry?.decimals ?? null,
      type: entry?.type ?? null,
      locationHex: entry?.locationHex ?? null,
      usd,
      source: 'money-market oracle',
    })
  }
  for (const row of omnipool?.rows ?? []) {
    if (oraclePrices.has(row.id) || row.spotUsd === null || !(row.spotUsd > 0)) continue
    const entry = registry.get(row.id)
    quoteList.push({
      id: row.id,
      symbol: entry?.symbol ?? null,
      decimals: entry?.decimals ?? null,
      type: entry?.type ?? null,
      locationHex: entry?.locationHex ?? null,
      usd: row.spotUsd,
      source: 'Omnipool implied spot',
    })
  }
  quoteList.sort((a, b) => a.id - b.id)

  // Recomputed on every read, not quoted from a document: the day the two venues stop agreeing
  // is a number on the page rather than a drift nobody notices.
  const crossCheck = (omnipool?.rows ?? [])
    .filter((r) => r.oraclePrice !== null && r.spotUsd !== null)
    .map((r) => ({
      id: r.id,
      symbol: r.symbol,
      oracle: r.oraclePrice,
      spot: r.spotUsd,
      differencePct: ((r.spotUsd - r.oraclePrice) / r.oraclePrice) * 100,
    }))
    .sort((a, b) => Math.abs(b.differencePct) - Math.abs(a.differencePct))

  const byLocation = new Map()
  for (const quote of quoteList) {
    if (quote.locationHex) byLocation.set(quote.locationHex, quote)
  }

  // Every LOCATED asset, priced or not. A caller needs to tell "Hydration has never heard of this
  // location" apart from "Hydration has it and neither venue prices it" — two different facts
  // about an asset, with two different things to say about them, and `byLocation` alone collapses
  // them into one absent price.
  const registryByLocation = new Map()
  for (const entry of registry.values()) {
    if (entry.locationHex) registryByLocation.set(entry.locationHex, entry)
  }

  // ⚠ A DIAGNOSTIC, NEVER A PRICE SOURCE. Hydration registers the same underlying token once per
  // ROUTE, and on 2026-08-21 it carried five USDCs, three WETHs, three WBTCs, three USDTs and
  // three DAIs — Acala-wrapped, Wormhole, Snowbridge, Asset Hub's own, and the issuing parachain's
  // own — as separate ids with separate liquidity. The money market prices exactly one of each
  // family and it is never the Snowbridge one.
  //
  // So a caller asking "why is the bridged WBTC not priced when Hydration obviously prices WBTC"
  // deserves the real answer — "it prices a different WBTC, and here it is" — rather than a bare
  // absence. That answer is worth publishing and is worth nothing as a substitute: the bridge that
  // wrapped a token is part of its identity, and a price for one leg is not a price for the other.
  const bySymbol = new Map()
  for (const entry of registry.values()) {
    if (!entry.symbol) continue
    const key = entry.symbol.toUpperCase()
    const list = bySymbol.get(key) ?? []
    list.push({
      id: entry.id,
      symbol: entry.symbol,
      decimals: entry.decimals,
      locationHex: entry.locationHex,
      usd: byLocation.get(entry.locationHex ?? '')?.usd ?? oraclePrices.get(entry.id) ?? null,
      source: quoteList.find((q) => q.id === entry.id)?.source ?? null,
    })
    bySymbol.set(key, list)
  }

  return {
    fetchedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    chain,
    oracle: {
      address: found.oracle,
      pool: found.pool,
      addressesProvider: found.provider,
      anchorAToken: found.anchorToken,
      baseCurrencyUnit: found.baseCurrencyUnit,
    },
    omnipool: omnipool
      ? { hubSymbol: found.hubSymbol, hubUsd: omnipool.hubUsd, hubSpreadBps: omnipool.spreadBps, anchors: omnipool.anchors, assetCount: omnipool.rows.length }
      : null,
    counts: {
      registered: registry.size,
      quoted: quoteList.length,
      byOracle: oraclePrices.size,
      byOmnipool: quoteList.filter((q) => q.source === 'Omnipool implied spot').length,
      bothPaths: crossCheck.length,
      withLocation: byLocation.size,
      registeredWithLocation: registryByLocation.size,
    },
    crossCheck,
    quotes: quoteList,
    byLocation,
    registryByLocation,
    bySymbol,
    liveness: liveness({
      source: 'prices',
      label: LABEL,
      observedAt: Date.now(),
      headAt: chain.timeMs,
      head: `block ${chain.block.toLocaleString('en-US')}`,
      // Hydration makes a block every few seconds, so ten minutes behind is already a problem
      // and an hour is the whole width of the oracle's own step interval.
      staleAfterMs: 10 * 60_000,
      frozenAfterMs: 60 * 60_000,
      note:
        chain.timeMs === null
          ? 'The block’s timestamp inherent could not be read, so how current these prices are cannot be established from the chain itself.'
          : null,
    }),
  }
}

/**
 * The composition surface other sources use. A `Map` from XCM location bytes to a quote —
 * location bytes because that is the only key that identifies an asset across two chains, and a
 * Map because a caller wants a lookup, not a scan.
 */
export async function quotesByLocation() {
  const built = await quotes()
  return built.byLocation
}

/** The two lookup Maps are for in-process composition; JSON cannot carry a Map. */
const wireSafe = ({ byLocation, registryByLocation, bySymbol, liveness: live, ...rest }) => ({
  ...rest,
  meta: { liveness: live },
})

/* ═══════════════════════════════════════════════════════ THE VALUATION HALF ═════════════ */

/**
 * Why a price can be absent, kept apart rather than folded into one missing number. Three of
 * these are different facts about the world and the page says which one applies to which asset.
 */
const STATUS = {
  priced: 'priced',
  /** Asset Hub has no `Metadata` entry, so nothing on the chain that holds the supply says what a
   *  whole token is. Not a pricing failure — the amount itself does not exist yet. */
  noDecimals: 'no-decimals',
  /** The location is in no Hydration registry entry. No id, no venue, no price. */
  notOnHydration: 'not-on-hydration',
  /** Matched, but in neither the money market nor the Omnipool. */
  noVenue: 'no-venue',
  /** Matched, but the two chains disagree about the divisor. Refused — see the file header. */
  decimalsDisagree: 'decimals-disagree',
}

async function bridgedValue() {
  const startedAt = Date.now()
  // Read-only, through the same public table an HTTP caller would reach. This module adds no
  // upstream of its own here and cannot make asset-hub.mjs fetch anything new.
  const [inventory, priced] = await Promise.all([assetHub.operations['bridged-inventory'].run({}), quotes()])

  const assets = inventory.bridged.map((asset) => {
    const key = asset.locationHex?.toLowerCase() ?? null
    const quote = key ? priced.byLocation.get(key) ?? null : null
    const known = hydrationEntry(priced, key)

    let status
    if (asset.decimals === null) status = STATUS.noDecimals
    else if (!quote && !known) status = STATUS.notOnHydration
    else if (!quote) status = STATUS.noVenue
    else if (quote.decimals !== null && quote.decimals !== asset.decimals) status = STATUS.decimalsDisagree
    else status = STATUS.priced

    const usd = status === STATUS.priced ? asset.supplyScaled * quote.usd : null

    return {
      locationHex: asset.locationHex,
      locationText: asset.locationText,
      symbol: asset.symbol,
      name: asset.name,
      network: asset.network,
      networkLabel: asset.networkLabel,
      decimals: asset.decimals,
      supply: asset.supply,
      supplyScaled: asset.supplyScaled,
      accounts: asset.accounts,
      usd,
      price: quote?.usd ?? null,
      priceSource: status === STATUS.priced ? quote.source : null,
      priceStatus: status,
      hydrationId: quote?.id ?? known?.id ?? null,
      hydrationSymbol: quote?.symbol ?? known?.symbol ?? null,
      hydrationDecimals: quote?.decimals ?? known?.decimals ?? null,
      // Only for the ones without a price: on a priced row it would be noise.
      namesakes: status === STATUS.priced ? [] : namesakesOf(priced, asset.symbol, quote?.id ?? known?.id ?? null),
    }
  })

  const pricedAssets = assets.filter((a) => a.priceStatus === STATUS.priced)
  const totalUsd = sumOrNull(pricedAssets.map((a) => a.usd))

  // What the eight metadata-less assets WOULD be worth at Hydration's decimals. Published as a
  // named, excluded figure rather than quietly included or quietly dropped: the divisor is a
  // second chain's claim about an asset this chain cannot scale, and a wrong divisor is a silent
  // factor of 10ⁿ. Stating the amount at stake is what rule 3 asks for here.
  const unscalable = assets
    .filter((a) => a.priceStatus === STATUS.noDecimals)
    .map((a) => {
      const key = a.locationHex?.toLowerCase() ?? null
      const quote = key ? priced.byLocation.get(key) ?? null : null
      const decimals = a.hydrationDecimals
      const wouldBeUsd = quote && decimals !== null ? (Number(a.supply) / 10 ** decimals) * quote.usd : null
      return {
        locationHex: a.locationHex,
        locationText: a.locationText,
        supply: a.supply,
        hydrationId: a.hydrationId,
        hydrationSymbol: a.hydrationSymbol,
        hydrationDecimals: decimals,
        price: quote?.usd ?? null,
        priceSource: quote?.source ?? null,
        wouldBeUsd,
      }
    })

  const totals = {
    assets: assets.length,
    priced: pricedAssets.length,
    pricedUsd: totalUsd,
    byOracle: pricedAssets.filter((a) => a.priceSource === 'money-market oracle').length,
    byOracleUsd: sumOrNull(pricedAssets.filter((a) => a.priceSource === 'money-market oracle').map((a) => a.usd)),
    byOmnipool: pricedAssets.filter((a) => a.priceSource === 'Omnipool implied spot').length,
    byOmnipoolUsd: sumOrNull(pricedAssets.filter((a) => a.priceSource === 'Omnipool implied spot').map((a) => a.usd)),
    unpriced: assets.length - pricedAssets.length,
    noDecimals: assets.filter((a) => a.priceStatus === STATUS.noDecimals).length,
    notOnHydration: assets.filter((a) => a.priceStatus === STATUS.notOnHydration).length,
    noVenue: assets.filter((a) => a.priceStatus === STATUS.noVenue).length,
    decimalsDisagree: assets.filter((a) => a.priceStatus === STATUS.decimalsDisagree).length,
    // Assets, not dollars. A share of value would need the value of the assets we could not
    // value, which is the whole thing we do not have.
    coverageByCount: assets.length ? pricedAssets.length / assets.length : null,
    excludedNoDecimalsUsd: sumOrNull(unscalable.map((u) => u.wouldBeUsd)),
  }

  return {
    fetchedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    // Two reads at two instants on two chains. Both blocks travel, because a reader comparing a
    // dollar figure against either chain needs to know which block each half came from.
    assetHubChain: inventory.chain,
    hydrationChain: priced.chain,
    oracle: {
      address: priced.oracle.address,
      baseCurrencyUnit: priced.oracle.baseCurrencyUnit,
      hubUsd: priced.omnipool?.hubUsd ?? null,
      hubSpreadBps: priced.omnipool?.hubSpreadBps ?? null,
      quotedAssets: priced.counts.quoted,
      registeredAssets: priced.counts.registered,
    },
    crossCheck: priced.crossCheck,
    totals,
    assets: assets.sort(byValueThenLabel),
    unscalable,
    notes: bridgedNotes({ assets, totals, priced, unscalable }),
    meta: {
      liveness: [priced.liveness, ...toArray(inventory.meta?.liveness)],
    },
  }
}

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : [])

/** Priced assets first, largest first — the order the chart draws in. Unpriced never sort as 0. */
function byValueThenLabel(a, b) {
  if (a.usd !== null && b.usd !== null) return b.usd - a.usd
  if (a.usd !== null) return -1
  if (b.usd !== null) return 1
  return String(a.symbol ?? a.locationHex).localeCompare(String(b.symbol ?? b.locationHex))
}

/** Hydration's registry entry for a location, price or no price — `null` when it has never heard
 *  of it. "Not on Hydration" and "on Hydration, priced by neither venue" are different facts. */
const hydrationEntry = (priced, locationHex) =>
  (locationHex ? priced.registryByLocation.get(locationHex) : null) ?? null

/**
 * Hydration assets carrying the same ticker as this one and keyed by a DIFFERENT location — the
 * other routes the same underlying token took onto that chain. Published so the page can answer
 * "Hydration prices WBTC, why is this WBTC unpriced" with the actual reason. Never a price.
 */
function namesakesOf(priced, symbol, matchedId) {
  if (!symbol) return []
  return (priced.bySymbol.get(symbol.toUpperCase()) ?? [])
    .filter((entry) => entry.id !== matchedId)
    .map((entry) => ({ ...entry, route: routeOf(entry.locationHex) }))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
}

/**
 * Which bridge or chain a Hydration location came in through, read off the location's own leading
 * bytes rather than off a list of ids. All five shapes verified live 2026-08-21 (see
 * docs/platform/prices.md); anything else is reported as its raw prefix rather than guessed at.
 */
function routeOf(locationHex) {
  if (!locationHex) return 'no location'
  const hex = locationHex.replace(/^0x/, '').toLowerCase()
  if (hex.startsWith('0202090704')) return 'Snowbridge (Ethereum)'
  if (hex.startsWith('02010903')) return 'Kusama'
  // `{parents: 0, X3(GeneralKey("wh"), GeneralIndex(chain), GeneralKey(token)))}`.
  if (hex.startsWith('000306027768')) return 'Wormhole'
  if (hex.startsWith('010300a10f')) return 'issued on Asset Hub'
  if (hex.startsWith('010200411f')) return 'via Acala (para 2000)'
  if (hex.startsWith('010100') || hex.startsWith('010200')) return 'a parachain’s own token'
  if (hex.startsWith('00010300')) return 'a contract on Hydration’s EVM'
  if (hex === '0100') return 'the relay chain'
  return `location 0x${hex.slice(0, 10)}…`
}

/* ---------------------------------------------------------------------------- notes ---- */

const count = (n) => Number(n).toLocaleString('en-US')
const dollars = (n) => (n === null ? 'null' : `$${Math.round(n).toLocaleString('en-US')}`)

function bridgedNotes({ assets, totals, priced, unscalable }) {
  const notes = []

  notes.push(
    `${count(totals.priced)} of ${count(totals.assets)} bridged assets could be valued, totalling ${dollars(totals.pricedUsd)}. ` +
      'That figure is a floor on what is bridged in, not a total: it excludes every asset below, and those are not worth zero — ' +
      'they are assets this site cannot value from a chain.',
  )

  notes.push(
    `Prices come from Hydration read live at block ${count(priced.chain.block)}: ` +
      `${count(totals.byOracle)} assets from the money-market oracle at ${priced.oracle.address} ` +
      `(${dollars(totals.byOracleUsd)}) and ${count(totals.byOmnipool)} from the Omnipool's own implied spot ` +
      `(${dollars(totals.byOmnipoolUsd)}). The oracle answers for ${count(priced.counts.byOracle)} of the ` +
      `${count(priced.counts.registered)} assets in Hydration's registry — it is the collateral valuation of one ` +
      'Aave fork, not a price feed for the chain, so a revert means “not a reserve” rather than “no market”.',
  )

  if (priced.crossCheck.length) {
    const worst = priced.crossCheck[0]
    notes.push(
      `The two price paths are checked against each other on every read. ${count(priced.crossCheck.length)} assets are in ` +
        `both venues and the largest disagreement right now is ${worst.symbol ?? `asset ${worst.id}`} at ` +
        `${worst.differencePct.toFixed(2)} % (oracle $${worst.oracle.toPrecision(6)}, Omnipool $${worst.spot.toPrecision(6)}). ` +
        'The Omnipool figure is never merged into the oracle’s: each number keeps the label of the venue it came from.',
    )
  }

  notes.push(
    'The money-market oracle is a stepped feed — about 18 updates a day, not one per block — so a fast move can be ' +
      'up to an hour old in these figures. It is the same feed for every asset here, so the ranking moves less than the total does.',
  )

  if (totals.noDecimals) {
    const known = unscalable.filter((u) => u.wouldBeUsd !== null)
    notes.push(
      `${count(totals.noDecimals)} assets have no metadata entry on Asset Hub, so the chain that holds the supply does not ` +
        'say how many decimals it uses. Their raw supply cannot be turned into a token count, let alone a dollar figure, ' +
        'and they are absent from every bar and every total above rather than drawn at zero.' +
        (known.length
          ? ` Hydration's registry does carry decimals for ${count(known.length)} of them; at those decimals they would be ` +
            `worth about ${dollars(sumOrNull(known.map((u) => u.wouldBeUsd)))}. That is a second chain's claim about the divisor ` +
            'and a wrong divisor is a silent factor of ten to the n, so the figure is stated here and used nowhere.'
          : ''),
    )
  }

  if (totals.notOnHydration) {
    notes.push(
      `${count(totals.notOnHydration)} assets are not in Hydration's asset registry under their Asset Hub location at all — ` +
        'no id, no venue, no price. Matching is done on the raw SCALE bytes of the XCM location, which is the only key that ' +
        'identifies an asset across two chains: three symbols on this page are carried by more than one asset, and the ' +
        'underlying ERC-20 address is not a key either, because Hydration registers the same Ethereum contract separately ' +
        'per bridge.',
    )
  }

  if (totals.noVenue) {
    const names = assets
      .filter((a) => a.priceStatus === STATUS.noVenue)
      .map((a) => a.symbol ?? a.locationText ?? a.locationHex)
      .join(', ')
    notes.push(
      `${count(totals.noVenue)} assets ARE in Hydration's registry but in neither the money market nor the Omnipool, so ` +
        `neither price path reaches them: ${names}. Several are in stableswap pools, which would price them if the ` +
        'stableswap invariant were implemented here; it is not.',
    )
  }

  if (totals.decimalsDisagree) {
    notes.push(
      `${count(totals.decimalsDisagree)} assets matched a Hydration asset whose decimals disagree with Asset Hub's. ` +
        'The price is refused rather than reconciled: the two chains would be describing different tokens, and the ' +
        'product of a price and the wrong divisor is wrong by a factor of ten to the n and renders perfectly.',
    )
  }

  notes.push(
    'Asset Hub and Hydration are read separately, a few seconds apart, so a transfer landing between the two reads ' +
      'moves the supply without moving the price. Both block heights are in the payload.',
  )

  return notes
}

/* ------------------------------------------------------------------------ the source ---- */

export default {
  id: 'prices',
  label: 'Prices — Hydration’s money-market oracle and Omnipool implied spot, read on chain',
  homepage: 'https://app.hydration.net/borrow',
  transport: 'jsonrpc-eth',
  doc: 'docs/platform/prices.md',
  covers: [
    'Hydration (Polkadot parachain 2034) — the Aave-fork price oracle and the Omnipool, on chain id 222222',
    'Polkadot Asset Hub (para 1000) — ForeignAssets inventory, valued (read through the asset-hub source)',
  ],

  operations: {
    'hydration-oracle': {
      summary:
        'Every asset Hydration can price in dollars, keyed by the SCALE bytes of its XCM location: the money-market oracle’s own reserves, plus the Omnipool’s implied spot for the assets the oracle does not carry, each carrying the venue it came from and a live cross-check between the two on the assets both price.',
      // Five minutes. The oracle steps about eighteen times a day, so a fresher read buys nothing
      // and a public dashboard sweeping 1,438 assets per visitor would be this node's heaviest
      // anonymous client by a wide margin.
      ttlMs: 300_000,
      schema: {},
      run: async () => wireSafe(await quotes()),
    },

    bridged: {
      summary:
        'Asset Hub’s bridged `ForeignAssets` inventory valued in dollars, asset by asset, with every asset that could NOT be valued named and the reason given — no decimals on Asset Hub, absent from Hydration’s registry, present but in no priced venue, or a decimals disagreement between the two chains.',
      // Fifteen minutes, matching the inventory it is built on. Valuing a registry that changes at
      // governance speed more often than that would only re-poll the price.
      ttlMs: 900_000,
      schema: {},
      run: () => bridgedValue(),
    },
  },
}
