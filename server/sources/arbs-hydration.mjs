// Hydration, read as a *venue* rather than as a stream of trades.
//
// The sibling module `hydration.mjs` answers "what traded". This one answers the questions
// underneath that: which forms of an asset exist and what joins them, what the money market's
// configured limits actually are, how HOLLAR's peg is defended, and what is resting on the
// OTC book. Same host, different plane of the same node — so, per the one-module-per-upstream
// rule, one module; the operations are separate because their costs and their caveats are.
//
// Everything here is a read of CURRENT STATE. Nothing is immutable, nothing is persisted, and
// none of it has a history on this site yet: the interesting version of every table below is
// the time series, and the time series needs the store that does not exist. Where that changes
// what a number means — an oracle gap read once tells you nothing about whether it usually
// lags — the page says so rather than implying a trend from one sample.
//
// ── two upstream planes on one host ─────────────────────────────────────────────────────────
//   · Substrate JSON-RPC over HTTPS POST. `state_getKeysPaged` walks a map's keys and
//     `state_queryStorageAt` returns HUNDREDS of values in ONE request. Reading a map one key
//     at a time over WebSocket is what makes a Hydration snapshot take 30 seconds; it takes
//     about one second done this way.
//   · The EVM plane (`eth_*`) on the same URL, which accepts a JSON-RPC BATCH ARRAY. The money
//     market is an Aave v3 fork living in contracts, not in a pallet, so the whole reserve
//     table is ~70 `eth_call`s — which is three HTTP requests, not seventy.
//
// ── what would silently be wrong, and how each is caught ────────────────────────────────────
//   · A REORDERED STORAGE STRUCT. Every decoder here must consume its input EXACTLY. Leftover
//     bytes throw. A runtime upgrade that adds a field then breaks the page loudly instead of
//     yielding a plausible number with the wrong meaning.
//   · WRONG DECIMALS. The same asset has a decimal count in the Substrate registry and another
//     in the Aave configuration bitmap. They are compared, and a mismatch is reported on the
//     page rather than quietly rescaling an amount by a factor of ten.
//   · A HARDCODED CONTRACT. `Liquidation.BorrowingContract` — the storage item that is supposed
//     to hold the Pool address — is EMPTY on the live chain (verified: `state_getStorage`
//     returns null). So one address is a constant: the Aave `PoolAddressesProvider`. Everything
//     else is asked of it at run time, and the answer is reported, so a governance move shows
//     up as a changed address on the page instead of as a stale read.

import { callUpstream, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { twox128 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { keccakHex } from '../../src/core/codec/keccak.js'
import { encodeSs58 } from '../../src/core/codec/ss58.js'
import { toHex, fromHex, utf8, concat, u32le, leHexToNumber } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'
import { fetchVdot } from './arbs-bifrost.mjs'

const RPC = 'https://rpc.hydradx.cloud'

/**
 * The one hardcoded address in this module, and it is hardcoded because the chain refuses to
 * tell us: `Liquidation.BorrowingContract`, which the arbs research recorded as the way to
 * discover the Aave Pool, holds nothing at all today. This is the Aave v3 `PoolAddressesProvider`,
 * the immutable registry every other address is derived from at run time.
 */
const AAVE_ADDRESSES_PROVIDER = '0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691'

/** Hydration's SS58 network prefix. A wrong prefix renders a valid address belonging to nobody. */
const SS58_HYDRATION = 63

/** HOLLAR — Hydration's own stablecoin, and the asset the HSM defends. */
const HOLLAR_ASSET = 222

/** The vDOT/aDOT stableswap pool, whose peg is a claim about Bifrost's redemption rate. */
const VDOT_POOL = 690
const VDOT_ASSET = 15

/* ══════════════════════════════════════════════════════ substrate storage plumbing ═════ */

const palletPrefix = (pallet, item) => '0x' + toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))

/** `Blake2_128Concat` over a fixed-width little-endian u32 — a map key, not a call argument. */
const mapKeyU32 = (prefix, id) => {
  const encoded = u32le(id)
  return prefix + toHex(blake2b(encoded, 16)) + toHex(encoded)
}

/** The concat half of `Blake2_128Concat` puts the plain key back on the end, so it reads out. */
const assetIdFromKey = (key) => leHexToNumber(key.slice(-8))

const KEY_PAGE = 1000
const VALUE_BATCH = 250

async function storageKeys(prefix, { limit = 8000 } = {}) {
  const keys = []
  let start = prefix
  for (;;) {
    const page = await jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'state_getKeysPaged', params: [prefix, KEY_PAGE, start], timeoutMs: 30_000 })
    if (!page?.length) break
    keys.push(...page)
    start = page[page.length - 1]
    if (page.length < KEY_PAGE || keys.length >= limit) break
  }
  return keys
}

/** @returns {Promise<Map<string,string>>} lowercase key → raw hex value */
async function storageValues(keys) {
  const out = new Map()
  for (let i = 0; i < keys.length; i += VALUE_BATCH) {
    const batch = keys.slice(i, i + VALUE_BATCH)
    const changes = await jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'state_queryStorageAt', params: [batch], timeoutMs: 30_000 })
    for (const [key, value] of changes?.[0]?.changes ?? []) {
      if (value !== null && value !== undefined) out.set(String(key).toLowerCase(), value)
    }
  }
  return out
}

const storageValue = (key) => jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'state_getStorage', params: [key], timeoutMs: 20_000 })

/**
 * A cursor over a SCALE blob that knows how much is left.
 *
 * `done()` is the self-check every decoder in this file ends with: if a runtime upgrade added
 * a field, the bytes do not run out where we expect and the read throws instead of returning a
 * number that looks fine.
 */
function scale(hex, what) {
  const body = String(hex ?? '').replace(/^0x/, '')
  let at = 0 // nibbles
  const need = (nibbles) => {
    if (at + nibbles > body.length) throw new UpstreamError(`${what}: ran out of bytes`, { kind: 'decode', source: 'hydration-rpc' })
  }
  const api = {
    /** unsigned little-endian integer of `bytes` width, as a BigInt */
    big(bytes) {
      need(bytes * 2)
      const slice = body.slice(at, at + bytes * 2)
      at += bytes * 2
      let value = 0n
      for (let i = slice.length - 2; i >= 0; i -= 2) value = value * 256n + BigInt(parseInt(slice.slice(i, i + 2), 16))
      return value
    },
    u(bytes) {
      return Number(api.big(bytes))
    },
    bytes(count) {
      need(count * 2)
      const slice = body.slice(at, at + count * 2)
      at += count * 2
      return slice
    },
    compact() {
      need(2)
      const [value, next] = decodeCompact(body, at)
      at = next
      return value
    },
    bool() {
      const byte = api.u(1)
      if (byte > 1) throw new UpstreamError(`${what}: ${byte} is not a bool`, { kind: 'decode', source: 'hydration-rpc' })
      return byte === 1
    },
    left: () => (body.length - at) / 2,
    done() {
      if (at !== body.length) {
        throw new UpstreamError(
          `${what}: left ${(body.length - at) / 2} byte(s) undecoded — the runtime layout has changed. Refusing to publish a reading of a structure we no longer understand.`,
          { kind: 'decode', source: 'hydration-rpc' },
        )
      }
    },
  }
  return api
}

/* ════════════════════════════════════════════════════════════════ the asset registry ═════ */

const ASSETS_PREFIX = palletPrefix('AssetRegistry', 'Assets')
const LOCATIONS_PREFIX = palletPrefix('AssetRegistry', 'AssetLocations')
const ASSET_TYPE = ['Token', 'XYK', 'StableSwap', 'Bond', 'External', 'Erc20']

/**
 * `AssetRegistry::Assets: AssetId -> AssetDetails`, decoded to exactly its own length.
 *
 * Deliberately a second implementation of the same structure `hydration.mjs` decodes. A shared
 * copy would be tidier and would also mean one lane's runtime-upgrade fix silently changes what
 * the other lane publishes; a decoder that must fail loudly is the last place to want that.
 */
function decodeAssetDetails(hex) {
  const r = scale(hex, 'AssetDetails')
  const text = () => {
    const length = r.compact()
    return new TextDecoder().decode(fromHex(r.bytes(length)))
  }
  const optionalText = () => (r.u(1) === 1 ? text() : null)

  const name = optionalText()
  const typeIndex = r.u(1)
  r.bytes(16) // existential_deposit
  const symbol = optionalText()
  const decimals = r.u(1) === 1 ? r.u(1) : null
  if (r.u(1) === 1) r.bytes(16) // xcm_rate_limit
  const isSufficient = r.bool()
  r.done()

  return { name, type: ASSET_TYPE[typeIndex] ?? `type-${typeIndex}`, symbol, decimals, isSufficient }
}

/**
 * Three assets whose symbol and decimals are common knowledge, checked before anything else is
 * decoded. Wrong decimals are a silent factor of 10ⁿ on every amount on every page here.
 */
const CANARIES = [
  [0, 'HDX', 12],
  [5, 'DOT', 10],
  [22, 'USDC', 6],
]

async function fetchAssets(ids) {
  const wanted = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id >= 0)
  const keys = wanted.map((id) => mapKeyU32(ASSETS_PREFIX, id))
  const values = await storageValues(keys)
  const assets = new Map()
  for (const id of wanted) {
    const raw = values.get(mapKeyU32(ASSETS_PREFIX, id).toLowerCase())
    if (!raw) continue // an id the registry does not know: the caller reports it rather than guessing
    try {
      assets.set(id, { id, ...decodeAssetDetails(raw) })
    } catch (error) {
      throw new UpstreamError(`asset ${id}: ${error.message}`, { kind: 'decode', source: 'hydration-rpc' })
    }
  }
  return assets
}

async function verifiedAssets(ids) {
  const assets = await fetchAssets([...ids, ...CANARIES.map(([id]) => id)])
  for (const [id, symbol, decimals] of CANARIES) {
    const got = assets.get(id)
    if (!got || got.symbol !== symbol || got.decimals !== decimals) {
      throw new UpstreamError(
        `asset registry self-check failed: asset ${id} decoded as ${got ? `${got.symbol}/${got.decimals}` : 'missing'}, expected ${symbol}/${decimals}. Refusing to publish amounts scaled by a layout we no longer understand.`,
        { kind: 'decode', source: 'hydration-rpc' },
      )
    }
  }
  return assets
}

/** Whole units, or `null` when the registry does not know the decimals. Never 0. */
function scaled(raw, decimals) {
  if (decimals === null || decimals === undefined) return null
  return Number(raw) / 10 ** decimals
}

/* ═══════════════════════════════════════════════════════════════════════ the EVM plane ═════ */

const selector = (signature) => keccakHex(signature).slice(0, 10)

const SEL = {
  getPool: selector('getPool()'),
  getPoolDataProvider: selector('getPoolDataProvider()'),
  getPriceOracle: selector('getPriceOracle()'),
  getReservesList: selector('getReservesList()'),
  getReserveData: selector('getReserveData(address)'),
  getEModeCategoryData: selector('getEModeCategoryData(uint8)'),
  flashLoanPremium: selector('FLASHLOAN_PREMIUM_TOTAL()'),
  // Not `0x89d1a0fc`, which circulates in third-party notes about this fork. Selectors are
  // computed here for exactly that reason: a copied one is right until it is not.
  underlying: selector('UNDERLYING_ASSET_ADDRESS()'),
  totalSupply: selector('totalSupply()'),
  symbol: selector('symbol()'),
}

const EVM_BATCH = 60

/**
 * A JSON-RPC batch array on the EVM plane. This is the whole cost story: 70 `eth_call`s become
 * two HTTP requests. A failed member of the batch comes back as `null` for that call only —
 * one dead contract must not take the page with it, and a `null` is reported as unknown rather
 * than as zero.
 */
async function ethBatch(calls) {
  const out = new Array(calls.length).fill(null)
  for (let start = 0; start < calls.length; start += EVM_BATCH) {
    const chunk = calls.slice(start, start + EVM_BATCH)
    const body = chunk.map((call, i) => ({
      jsonrpc: '2.0',
      id: start + i,
      method: 'eth_call',
      params: [{ to: call.to, data: call.data }, 'latest'],
    }))
    const answer = await callUpstream({ source: 'hydration-evm', url: RPC, method: 'POST', body, timeoutMs: 45_000 })
    if (!Array.isArray(answer)) {
      throw new UpstreamError('hydration-evm did not answer a batch array with an array.', { kind: 'decode', source: 'hydration-evm' })
    }
    for (const item of answer) {
      const index = Number(item?.id)
      if (!Number.isInteger(index) || index < 0 || index >= calls.length) continue
      out[index] = item?.error ? null : item?.result ?? null
    }
  }
  return out
}

const wordsOf = (hex) => String(hex ?? '').replace(/^0x/, '').match(/.{64}/g) ?? []
const wordAddress = (word) => (word ? `0x${word.slice(24)}` : null)
const wordBig = (word) => (word ? BigInt(`0x${word}`) : null)
const wordNumber = (word) => (word ? Number(BigInt(`0x${word}`)) : null)

/** An ABI-encoded `string` return: offset word, length word, then the bytes. */
function abiString(hex) {
  const words = wordsOf(hex)
  if (words.length < 3) return null
  const length = Number(BigInt(`0x${words[1]}`))
  if (!Number.isFinite(length) || length <= 0 || length > 128) return null
  const data = words.slice(2).join('').slice(0, length * 2)
  return new TextDecoder().decode(fromHex(data))
}

/**
 * The Aave v3 `ReserveConfigurationMap` — one uint256 carrying eighteen fields as bit ranges.
 *
 * The layout is fixed by the Aave codebase, which is why it can be read at all; the reason it
 * is worth reading rather than calling eighteen getters is that it arrives free inside
 * `getReserveData`. Caps are in WHOLE TOKENS in Aave, not in the token's smallest unit — the
 * one place in this file where a raw integer is already a human number.
 */
function decodeReserveConfig(value) {
  if (value === null) return null
  const bits = (offset, width) => Number((value >> BigInt(offset)) & ((1n << BigInt(width)) - 1n))
  const flag = (offset) => ((value >> BigInt(offset)) & 1n) === 1n
  const cap = (raw) => (raw > 0 ? raw : null) // 0 means "no cap", which is not "a cap of zero"
  return {
    ltv: bits(0, 16) / 100,
    liquidationThreshold: bits(16, 16) / 100,
    liquidationBonus: bits(32, 16) / 100,
    decimals: bits(48, 8),
    active: flag(56),
    frozen: flag(57),
    borrowingEnabled: flag(58),
    paused: flag(60),
    borrowableInIsolation: flag(61),
    siloedBorrowing: flag(62),
    flashLoanEnabled: flag(63),
    reserveFactor: bits(64, 16) / 100,
    borrowCap: cap(bits(80, 36)),
    supplyCap: cap(bits(116, 36)),
    liquidationProtocolFee: bits(152, 16) / 100,
    emodeCategory: bits(168, 8),
  }
}

/* ═══════════════════════════════════════════════════ EVM address ↔ Substrate asset id ═════ */

/**
 * Hydration exposes every registered Substrate asset at a synthetic ERC-20 address:
 * sixteen zero bytes, then `0x…01`, then the asset id as a big-endian u32. So most of the
 * money market's "token contracts" are not contracts at all, and their asset id is *in* the
 * address. This is checked, not assumed: the symbol the contract answers is compared with the
 * symbol the registry holds, and a disagreement is reported.
 */
const PRECOMPILE_PREFIX = `0x${'0'.repeat(31)}1`

function assetIdFromPrecompile(address) {
  const lower = String(address ?? '').toLowerCase()
  if (!lower.startsWith(PRECOMPILE_PREFIX) || lower.length !== 42) return null
  const id = Number(BigInt(`0x${lower.slice(34)}`))
  return Number.isSafeInteger(id) ? id : null
}

/** `AssetRegistry::AssetLocations` value for a genuine ERC-20: parents 0, X1, AccountKey20(None). */
const ERC20_LOCATION = /^0x00010300([0-9a-f]{40})$/

/**
 * The reverse index a real contract needs: EVM address → Substrate asset id. Built by walking
 * the whole `AssetLocations` map once, which is four HTTP requests for ~680 entries, because
 * there is no reverse map on chain and guessing is how you bind an aToken to the wrong asset.
 */
async function erc20AssetIndex() {
  const keys = await storageKeys(LOCATIONS_PREFIX, { limit: 4000 })
  const values = await storageValues(keys)
  const byAddress = new Map()
  for (const [key, value] of values) {
    const match = ERC20_LOCATION.exec(String(value).toLowerCase())
    if (!match) continue
    byAddress.set(`0x${match[1]}`, assetIdFromKey(key))
  }
  return byAddress
}

/* ════════════════════════════════════════════════════════════════════════ chain header ═════ */

async function head() {
  const [header, version] = await Promise.all([
    jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'chain_getHeader', timeoutMs: 20_000 }),
    jsonRpc({ source: 'hydration-rpc', url: RPC, method: 'state_getRuntimeVersion', timeoutMs: 20_000 }),
  ])
  return { block: parseInt(header?.number ?? '0x0', 16), specVersion: version?.specVersion ?? null }
}

/* ═════════════════════════════════════════════════════════════════════════ the wrap map ═════ */

async function wrapMap() {
  const chain = await head()

  // One request: the four addresses everything else hangs off, plus the reserve list.
  const [poolWord, dataProviderWord, oracleWord] = await ethBatch([
    { to: AAVE_ADDRESSES_PROVIDER, data: SEL.getPool },
    { to: AAVE_ADDRESSES_PROVIDER, data: SEL.getPoolDataProvider },
    { to: AAVE_ADDRESSES_PROVIDER, data: SEL.getPriceOracle },
  ])
  const pool = wordAddress(wordsOf(poolWord)[0])
  if (!pool || /^0x0+$/.test(pool)) {
    throw new UpstreamError(
      `the Aave PoolAddressesProvider at ${AAVE_ADDRESSES_PROVIDER} did not name a Pool. Everything on this page hangs off that answer, so there is nothing to draw.`,
      { kind: 'upstream', source: 'hydration-evm' },
    )
  }

  const [listRaw, premiumRaw] = await ethBatch([
    { to: pool, data: SEL.getReservesList },
    { to: pool, data: SEL.flashLoanPremium },
  ])
  const listWords = wordsOf(listRaw)
  const reserveCount = wordNumber(listWords[1]) ?? 0
  const addresses = listWords.slice(2, 2 + reserveCount).map((word) => wordAddress(word))
  if (!addresses.length) {
    return { chain, empty: true }
  }

  // 23 reserves in one request.
  const reserveData = await ethBatch(addresses.map((address) => ({ to: pool, data: SEL.getReserveData + address.slice(2).padStart(64, '0') })))

  const rows = addresses.map((address, i) => {
    const words = wordsOf(reserveData[i])
    return {
      address,
      config: words.length >= 15 ? decodeReserveConfig(wordBig(words[0])) : null,
      aToken: words.length >= 15 ? wordAddress(words[8]) : null,
      variableDebtToken: words.length >= 15 ? wordAddress(words[10]) : null,
      lastUpdate: words.length >= 15 ? wordNumber(words[6]) : null,
    }
  })

  // 23 × 3 + 23 = 92 calls, two requests: the aToken's own claim about what it wraps (the
  // cross-check), the two supply figures, and the underlying's symbol as the registry check.
  const probeCalls = []
  for (const row of rows) {
    probeCalls.push({ to: row.aToken ?? row.address, data: SEL.underlying })
    probeCalls.push({ to: row.aToken ?? row.address, data: SEL.totalSupply })
    probeCalls.push({ to: row.variableDebtToken ?? row.address, data: SEL.totalSupply })
    probeCalls.push({ to: row.address, data: SEL.symbol })
  }
  const probes = await ethBatch(probeCalls)

  // e-mode categories are numbered from 1 and simply stop answering; enumerate rather than
  // hardcode a count, because a governance vote can add one and a fixed list would not notice.
  const emodeRaw = await ethBatch(Array.from({ length: 12 }, (_, i) => ({ to: pool, data: SEL.getEModeCategoryData + (i + 1).toString(16).padStart(64, '0') })))

  const erc20Index = await erc20AssetIndex()
  const resolve = (address) => {
    if (!address) return null
    const precompiled = assetIdFromPrecompile(address)
    if (precompiled !== null) return { id: precompiled, via: 'precompile' }
    const registered = erc20Index.get(String(address).toLowerCase())
    return registered === undefined ? null : { id: registered, via: 'AssetLocations' }
  }

  const bindings = rows.map((row) => ({ underlying: resolve(row.address), aToken: resolve(row.aToken) }))
  const assets = await verifiedAssets(bindings.flatMap((b) => [b.underlying?.id, b.aToken?.id]).filter((id) => id !== null && id !== undefined))

  const reserves = rows.map((row, i) => {
    const binding = bindings[i]
    const underlyingAsset = binding.underlying ? assets.get(binding.underlying.id) ?? null : null
    const aTokenAsset = binding.aToken ? assets.get(binding.aToken.id) ?? null : null
    const claimed = wordAddress(wordsOf(probes[i * 4])[0])
    const contractSymbol = abiString(probes[i * 4 + 3])
    const decimals = underlyingAsset?.decimals ?? null

    return {
      address: row.address,
      assetId: binding.underlying?.id ?? null,
      boundVia: binding.underlying?.via ?? null,
      symbol: underlyingAsset?.symbol ?? contractSymbol ?? null,
      contractSymbol,
      registrySymbol: underlyingAsset?.symbol ?? null,
      assetType: underlyingAsset?.type ?? null,
      decimals,
      // Two independent claims about the same fact. They agree today; if they ever stop, the
      // page shows both rather than picking one.
      configDecimals: row.config?.decimals ?? null,
      decimalsAgree: decimals !== null && row.config?.decimals !== null && row.config?.decimals !== undefined ? decimals === row.config.decimals : null,

      aTokenAddress: row.aToken,
      aTokenAssetId: binding.aToken?.id ?? null,
      aTokenSymbol: aTokenAsset?.symbol ?? null,
      // The aToken's own answer to "what do I wrap", compared with the address the Pool listed
      // it under. This is the wrap map's only real integrity check.
      wrapConfirmed: claimed === null ? null : claimed.toLowerCase() === row.address.toLowerCase(),
      variableDebtToken: row.variableDebtToken,

      supplied: scaled(wordBig(wordsOf(probes[i * 4 + 1])[0]) ?? 0n, decimals),
      borrowed: scaled(wordBig(wordsOf(probes[i * 4 + 2])[0]) ?? 0n, decimals),
      ...(row.config ?? {}),
      lastUpdate: row.lastUpdate,
    }
  })

  for (const reserve of reserves) {
    // Cap headroom is the only "utilisation" this page carries, and it is utilisation of a
    // GOVERNANCE LIMIT, not of the liquidity. `null` where there is no cap: an uncapped
    // reserve is not a reserve that is 0 % full.
    reserve.supplyCapUsed = reserve.supplyCap && reserve.supplied !== null ? reserve.supplied / reserve.supplyCap : null
    reserve.borrowCapUsed = reserve.borrowCap && reserve.borrowed !== null ? reserve.borrowed / reserve.borrowCap : null
  }

  const emodes = emodeRaw
    .map((raw, i) => {
      const words = wordsOf(raw)
      if (words.length < 7) return null
      const ltv = wordNumber(words[1])
      if (!ltv) return null // an unset category answers with zeros, which is how the list ends
      return {
        id: i + 1,
        label: abiString(`0x${words.slice(5).join('')}`),
        ltv: ltv / 100,
        liquidationThreshold: (wordNumber(words[2]) ?? 0) / 100,
        liquidationBonus: (wordNumber(words[3]) ?? 0) / 100,
        priceSource: wordAddress(words[4]),
        maxLeverage: ltv < 10000 ? 1 / (1 - ltv / 10000) : null,
        members: reserves.filter((r) => r.emodeCategory === i + 1).map((r) => r.symbol ?? r.address),
      }
    })
    .filter(Boolean)

  const unbound = reserves.filter((r) => r.assetId === null)
  const unconfirmed = reserves.filter((r) => r.wrapConfirmed !== true)
  const decimalsDisagree = reserves.filter((r) => r.decimalsAgree === false)
  const flashLoanEnabled = reserves.filter((r) => r.flashLoanEnabled)
  const noATokenAsset = reserves.filter((r) => r.aTokenAssetId === null)

  return {
    chain,
    empty: false,
    contracts: {
      addressesProvider: AAVE_ADDRESSES_PROVIDER,
      pool,
      poolDataProvider: wordAddress(wordsOf(dataProviderWord)[0]),
      priceOracle: wordAddress(wordsOf(oracleWord)[0]),
    },
    protocol: {
      reserveCount: reserves.length,
      flashLoanPremiumBps: wordNumber(wordsOf(premiumRaw)[0]),
      flashLoanEnabledCount: flashLoanEnabled.length,
      emodeCount: emodes.length,
    },
    reserves,
    emodes,
    fetchedAt: new Date().toISOString(),
    notes: [
      `The Pool contract is not hardcoded: it is asked of the Aave PoolAddressesProvider at ${AAVE_ADDRESSES_PROVIDER} on every refresh, and that answer (${pool}) is printed above. The provider address itself IS a constant here, because \`Liquidation.BorrowingContract\` — the storage item that is supposed to hold it — is empty on the live chain.`,
      `${reserves.length - unbound.length} of ${reserves.length} reserves resolve to a Substrate asset id. ${
        unbound.length
          ? `${unbound.length} do not and are shown with their raw EVM address only: ${unbound.map((r) => r.address).join(', ')}.`
          : 'None are left unresolved.'
      }`,
      `${noATokenAsset.length === 0 ? 'Every' : `${reserves.length - noATokenAsset.length} of ${reserves.length}`} aToken contract${noATokenAsset.length === 0 ? ' is' : 's are'} registered as a Hydration asset in its own right, which is what makes the wrap map a map between two asset ids rather than between an id and an address.`,
      unconfirmed.length
        ? `${unconfirmed.length} row(s) could not be confirmed by calling UNDERLYING_ASSET_ADDRESS() on the aToken. Those wrap bindings are the Pool's claim alone and are marked unconfirmed.`
        : 'Every wrap binding is confirmed twice: the Pool lists the aToken against an underlying, and the aToken independently answers UNDERLYING_ASSET_ADDRESS() with the same address.',
      decimalsDisagree.length
        ? `⚠ ${decimalsDisagree.length} reserve(s) report different decimals in the Substrate registry and in the Aave configuration bitmap. Every amount for those rows is scaled by the registry value and both are shown. A decimals disagreement is a factor of ten, and it renders perfectly.`
        : 'Decimals agree between the Substrate asset registry and the Aave configuration bitmap on every reserve. They are two independent records of the same fact and a disagreement would be a silent factor of ten.',
      `Flash loans are enabled on ${flashLoanEnabled.length} of ${reserves.length} reserves, at a ${wordNumber(wordsOf(premiumRaw)[0])} bps premium. That is a configuration reading, not a claim about whether anybody uses them.`,
      'Supply and borrow figures are the aToken and variable-debt-token total supplies. aToken balances are REBASED — the liquidity index is already inside the unit count, so one aToken redeems for one underlying and treating the index as a second conversion double-counts.',
      'Caps are Aave’s own, in whole tokens, and “no cap” is reported as no cap rather than as a cap of zero. The percentages beside them are headroom against a governance limit — not utilisation of the pool’s liquidity, which is a different number and lives on the money-market board.',
      'This is a single reading of current state. There is no history behind any of these numbers on this site yet, so nothing here says whether a value is normal.',
    ],
  }
}

/* ═══════════════════════════════════════════════════════════════════ pegs, HSM and OTC ═════ */

const POOLS_PREFIX = palletPrefix('Stableswap', 'Pools')
const PEGS_PREFIX = palletPrefix('Stableswap', 'PoolPegs')
const HSM_PREFIX = palletPrefix('HSM', 'Collaterals')
const OTC_PREFIX = palletPrefix('OTC', 'Orders')

/**
 * `Stableswap::Pools: PoolId -> PoolInfo`.
 *
 *     Vec<AssetId>  assets
 *     u16           initial_amplification
 *     u16           final_amplification
 *     u32           initial_block
 *     u32           final_block
 *     Permill       fee
 */
function decodePoolInfo(hex) {
  const r = scale(hex, 'Stableswap::PoolInfo')
  const count = r.compact()
  const assets = Array.from({ length: count }, () => r.u(4))
  const info = {
    assets,
    initialAmplification: r.u(2),
    finalAmplification: r.u(2),
    initialBlock: r.u(4),
    finalBlock: r.u(4),
    feePermill: r.u(4),
  }
  r.done()
  if (info.feePermill > 1_000_000) {
    throw new UpstreamError(`Stableswap::PoolInfo fee ${info.feePermill} is not a Permill`, { kind: 'decode', source: 'hydration-rpc' })
  }
  return info
}

/**
 * `Stableswap::PoolPegs: PoolId -> PoolPegInfo`, one entry per PEG-AWARE pool only.
 *
 *     Vec<PegSource>   source     0 = Value((u128,u128)), 2 = MMOracle([u8;20])
 *     u32              recorded block
 *     Permill          max update per block
 *     Vec<(u128,u128)> current    positionally aligned with `source` and with the pool's assets
 *
 * Field names beyond `source` and `current` are INFERRED from the values rather than read from
 * metadata: the u32 is a plausible recent block height and the next is inside Permill range,
 * and both are asserted below. Say so on the page rather than presenting an inference as a
 * decoded field name.
 */
function decodePoolPegs(hex, headBlock) {
  const r = scale(hex, 'Stableswap::PoolPegInfo')
  const sourceCount = r.compact()
  const sources = []
  for (let i = 0; i < sourceCount; i += 1) {
    const variant = r.u(1)
    if (variant === 0) sources.push({ kind: 'Value', numerator: r.big(16).toString(), denominator: r.big(16).toString() })
    else if (variant === 2) sources.push({ kind: 'MMOracle', address: `0x${r.bytes(20)}` })
    else {
      throw new UpstreamError(
        `Stableswap::PoolPegInfo carries an unknown PegSource variant ${variant}. The peg column would be a guess, so there is no reading to publish.`,
        { kind: 'decode', source: 'hydration-rpc' },
      )
    }
  }

  const recordedBlock = r.u(4)
  const maxPegUpdatePermill = r.u(4)
  const pegCount = r.compact()
  const current = []
  for (let i = 0; i < pegCount; i += 1) {
    const numerator = r.big(16)
    const denominator = r.big(16)
    current.push({
      numerator: numerator.toString(),
      denominator: denominator.toString(),
      // `null`, not 1, when the denominator is zero: an unset peg is not a peg of one.
      ratio: denominator > 0n ? Number(numerator) / Number(denominator) : null,
    })
  }
  r.done()

  if (recordedBlock <= 0 || recordedBlock > headBlock || maxPegUpdatePermill > 1_000_000) {
    throw new UpstreamError(
      `Stableswap::PoolPegInfo decoded a recorded block of ${recordedBlock} against a head of ${headBlock} and a Permill of ${maxPegUpdatePermill}. One of those is impossible, so the layout has moved.`,
      { kind: 'decode', source: 'hydration-rpc' },
    )
  }
  return { sources, recordedBlock, maxPegUpdatePermill, current }
}

/**
 * `HSM::Collaterals: AssetId -> CollateralInfo`.
 *
 *     AssetId          pool_id
 *     Permill          purchase_fee
 *     FixedU128        max_buy_price_coefficient   (1e18 fixed point)
 *     Perbill          the per-block buy-back rate
 *     Permill          the buy-back fee
 *     Option<Balance>  max_in_holding
 *
 * The two rate fields are 1e-4 under this reading and 1e-4 under this reading alone; see the
 * caveat generated onto the page. Their VALUES are settled — the alternative pairing makes one
 * of them 10 % — but which name attaches to which is not readable from the bytes.
 */
function decodeCollateral(hex) {
  const r = scale(hex, 'HSM::CollateralInfo')
  const poolId = r.u(4)
  const purchaseFeePermill = r.u(4)
  const coefficient = r.big(16)
  const buybackRatePerbill = r.u(4)
  const buyBackFeePermill = r.u(4)
  const maxInHolding = r.u(1) === 1 ? r.big(16) : null
  r.done()

  if (purchaseFeePermill > 1_000_000 || buyBackFeePermill > 1_000_000 || buybackRatePerbill > 1_000_000_000) {
    throw new UpstreamError('HSM::CollateralInfo decoded a fee outside its own denominator — the layout has moved.', { kind: 'decode', source: 'hydration-rpc' })
  }

  return {
    poolId,
    purchaseFee: purchaseFeePermill / 1_000_000,
    maxBuyPriceCoefficient: Number(coefficient) / 1e18,
    buybackRate: buybackRatePerbill / 1_000_000_000,
    buyBackFee: buyBackFeePermill / 1_000_000,
    maxInHoldingRaw: maxInHolding === null ? null : maxInHolding.toString(),
  }
}

/**
 * `OTC::Orders: OrderId -> Order`.
 *
 *     AccountId32  owner
 *     AssetId      asset_in
 *     AssetId      asset_out
 *     Balance      amount_in    (what REMAINS on a partially-filled order)
 *     Balance      amount_out
 *     bool         partially_fillable
 */
function decodeOtcOrder(hex) {
  const r = scale(hex, 'OTC::Order')
  const owner = r.bytes(32)
  const order = {
    ownerHex: `0x${owner}`,
    owner: encodeSs58(fromHex(owner), SS58_HYDRATION),
    assetIn: r.u(4),
    assetOut: r.u(4),
    amountInRaw: r.big(16).toString(),
    amountOutRaw: r.big(16).toString(),
    partiallyFillable: r.bool(),
  }
  r.done()
  return order
}

// A `modl` prefix is Substrate's PalletId derivation: the account is a pallet, not a person.
const MODL = '6d6f646c'

function palletName(hexAccount) {
  const hex = String(hexAccount ?? '').replace(/^0x/, '')
  if (!hex.startsWith(MODL)) return null
  let text = ''
  for (let i = MODL.length; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code < 0x20 || code > 0x7e) break
    text += String.fromCharCode(code)
  }
  return text ? `pallet:${text}` : 'pallet'
}

async function pegState() {
  const chain = await head()

  const [poolKeys, pegKeys, hsmKeys, hollarReceivedKeys] = [
    await storageKeys(POOLS_PREFIX, { limit: 500 }),
    await storageKeys(PEGS_PREFIX, { limit: 500 }),
    await storageKeys(HSM_PREFIX, { limit: 200 }),
    await storageKeys(palletPrefix('HSM', 'HollarAmountReceived'), { limit: 200 }),
  ]

  const [poolValues, pegValues, hsmValues, flashMinter] = [
    await storageValues(poolKeys),
    await storageValues(pegKeys),
    await storageValues(hsmKeys),
    await storageValue(palletPrefix('HSM', 'FlashMinter')),
  ]

  const pools = []
  for (const key of poolKeys) {
    const id = assetIdFromKey(key)
    const raw = poolValues.get(key.toLowerCase())
    if (!raw) continue
    pools.push({ id, ...decodePoolInfo(raw) })
  }

  const pegsById = new Map()
  for (const key of pegKeys) {
    const raw = pegValues.get(key.toLowerCase())
    if (!raw) continue
    pegsById.set(assetIdFromKey(key), decodePoolPegs(raw, chain.block))
  }

  const collaterals = []
  for (const key of hsmKeys) {
    const raw = hsmValues.get(key.toLowerCase())
    if (!raw) continue
    collaterals.push({ assetId: assetIdFromKey(key), ...decodeCollateral(raw) })
  }

  const wantedAssets = new Set([HOLLAR_ASSET, VDOT_ASSET])
  for (const pool of pools) {
    wantedAssets.add(pool.id)
    for (const asset of pool.assets) wantedAssets.add(asset)
  }
  for (const collateral of collaterals) wantedAssets.add(collateral.assetId)
  const assets = await verifiedAssets([...wantedAssets])

  for (const collateral of collaterals) {
    const asset = assets.get(collateral.assetId)
    collateral.symbol = asset?.symbol ?? null
    collateral.decimals = asset?.decimals ?? null
    collateral.maxInHolding = collateral.maxInHoldingRaw === null ? null : scaled(BigInt(collateral.maxInHoldingRaw), asset?.decimals ?? null)
  }

  const decorated = pools
    .map((pool) => {
      const pegs = pegsById.get(pool.id) ?? null
      const ramping = pool.initialAmplification !== pool.finalAmplification && chain.block < pool.finalBlock
      return {
        id: pool.id,
        label: assets.get(pool.id)?.symbol ?? null,
        assets: pool.assets.map((id, i) => ({
          id,
          symbol: assets.get(id)?.symbol ?? null,
          // Positional alignment between `assets`, `source` and `current` is how the pallet
          // stores it. If the lengths ever disagree the peg is reported as unknown rather than
          // attached to whichever asset happened to line up.
          peg: pegs && pegs.current.length === pool.assets.length ? pegs.current[i] : null,
          pegSource: pegs && pegs.sources.length === pool.assets.length ? pegs.sources[i] : null,
        })),
        feePercent: (pool.feePermill / 1_000_000) * 100,
        amplification: pool.finalAmplification,
        initialAmplification: pool.initialAmplification,
        ramping,
        rampEndsAtBlock: pool.finalBlock,
        pegged: Boolean(pegs),
        pegRecordedBlock: pegs?.recordedBlock ?? null,
        pegBlocksAgo: pegs ? chain.block - pegs.recordedBlock : null,
        maxPegUpdatePercent: pegs ? (pegs.maxPegUpdatePermill / 1_000_000) * 100 : null,
        pegAlignmentOk: pegs ? pegs.current.length === pool.assets.length && pegs.sources.length === pool.assets.length : null,
      }
    })
    .sort((a, b) => a.id - b.id)

  /* ── the vDOT oracle gap: the one number here with an external anchor ───────────────── */

  const vdotPool = decorated.find((pool) => pool.id === VDOT_POOL) ?? null
  const oraclePeg = vdotPool?.assets.find((asset) => asset.id === VDOT_ASSET)?.peg?.ratio ?? null

  let bifrost = null
  let bifrostError = null
  try {
    bifrost = await fetchVdot()
  } catch (error) {
    // Bifrost being unreachable makes the gap unmeasurable. It does not make it zero, and it
    // must not fall back to the on-chain peg, which would make the monitor agree with itself.
    bifrostError = error?.message ?? 'Bifrost did not answer.'
  }

  const trueRate = bifrost?.rate ?? null
  const gapBps = oraclePeg !== null && trueRate !== null && trueRate > 0 ? ((oraclePeg - trueRate) / trueRate) * 10_000 : null

  /* ── OTC book ──────────────────────────────────────────────────────────────────────── */

  const orders = await otcOrders(assets)

  const unpegged = decorated.filter((pool) => !pool.pegged)
  const misaligned = decorated.filter((pool) => pool.pegAlignmentOk === false)

  return {
    chain,
    empty: decorated.length === 0,
    hollar: { assetId: HOLLAR_ASSET, symbol: assets.get(HOLLAR_ASSET)?.symbol ?? null, decimals: assets.get(HOLLAR_ASSET)?.decimals ?? null },
    hsm: {
      collaterals: collaterals.sort((a, b) => a.assetId - b.assetId),
      flashMinter: flashMinter ?? null,
      hollarAmountReceivedEntries: hollarReceivedKeys.length,
    },
    pools: decorated,
    vdot: {
      poolId: VDOT_POOL,
      assetId: VDOT_ASSET,
      oraclePeg,
      oracleSource: vdotPool?.assets.find((asset) => asset.id === VDOT_ASSET)?.pegSource ?? null,
      recordedBlock: vdotPool?.pegRecordedBlock ?? null,
      blocksAgo: vdotPool?.pegBlocksAgo ?? null,
      bifrost,
      bifrostError,
      trueRate,
      gapBps,
    },
    otc: orders,
    fetchedAt: new Date().toISOString(),
    notes: pegNotes({ decorated, collaterals, unpegged, misaligned, vdot: { oraclePeg, trueRate, gapBps, bifrostError }, orders, chain }),
  }
}

async function otcOrders(assets) {
  const keys = await storageKeys(OTC_PREFIX, { limit: 4000 })
  const values = await storageValues(keys)
  const decoded = []
  for (const key of keys) {
    const raw = values.get(key.toLowerCase())
    if (!raw) continue
    decoded.push({ id: assetIdFromKey(key), ...decodeOtcOrder(raw) })
  }

  const missing = [...new Set(decoded.flatMap((order) => [order.assetIn, order.assetOut]))].filter((id) => !assets.has(id))
  const extra = missing.length ? await fetchAssets(missing) : new Map()
  const lookup = (id) => assets.get(id) ?? extra.get(id) ?? null

  const orders = decoded
    .map((order) => {
      const assetIn = lookup(order.assetIn)
      const assetOut = lookup(order.assetOut)
      const amountIn = scaled(BigInt(order.amountInRaw), assetIn?.decimals ?? null)
      const amountOut = scaled(BigInt(order.amountOutRaw), assetOut?.decimals ?? null)
      const pallet = palletName(order.ownerHex)
      return {
        id: order.id,
        owner: pallet ?? order.owner,
        ownerHex: order.ownerHex,
        isPallet: Boolean(pallet),
        assetIn: order.assetIn,
        symbolIn: assetIn?.symbol ?? null,
        assetOut: order.assetOut,
        symbolOut: assetOut?.symbol ?? null,
        amountIn,
        amountOut,
        // `null` where either side could not be scaled: a price computed from an unknown
        // decimal count is wrong by a power of ten and looks entirely reasonable.
        price: amountIn !== null && amountOut !== null && amountIn > 0 ? amountOut / amountIn : null,
        partiallyFillable: order.partiallyFillable,
      }
    })
    .sort((a, b) => a.id - b.id)

  // Assets the registry knows by id and by nothing else. `AssetRegistry::Assets` carries an
  // `Option` for both symbol and decimals, and a stack of `External` (XCM-registered) entries
  // have neither filled in. Without decimals an amount is an unscaled integer, so those orders
  // show no amount at all rather than a number that is wrong by a power of ten.
  const undecimalled = [...new Set(orders.flatMap((order) => [order.assetIn, order.assetOut]))]
    .filter((id) => {
      const asset = lookup(id)
      return !asset || asset.decimals === null || asset.decimals === undefined
    })
    .map((id) => ({ id, symbol: lookup(id)?.symbol ?? null, type: lookup(id)?.type ?? null, registered: Boolean(lookup(id)) }))
    .sort((a, b) => a.id - b.id)

  return {
    count: orders.length,
    orders,
    unpricedAssets: undecimalled,
    unpricedOrders: orders.filter((order) => order.amountIn === null || order.amountOut === null).length,
    palletOrders: orders.filter((o) => o.isPallet).length,
    partiallyFillable: orders.filter((o) => o.partiallyFillable).length,
  }
}

function pegNotes({ decorated, collaterals, unpegged, misaligned, vdot, orders, chain }) {
  const identicalRates = collaterals.filter((c) => c.buybackRate === c.buyBackFee).length
  const notes = [
    `${decorated.length} stableswap pools, ${decorated.length - unpegged.length} of which carry a peg entry. Only peg-aware pools have one; a pool with no entry is not a pool whose peg is 1:1 by policy, it is a pool where the concept does not apply, and it is shown as blank rather than as parity.`,
    'The peg columns are read from `Stableswap::PoolPegs`, whose `source` and `current` vectors are aligned POSITIONALLY with the pool’s asset list. Where the three lengths disagree the peg is shown as unknown rather than attached to whichever asset lined up.',
    'The "recorded at block" and "max update" fields of the peg record are inferred from their values — one is a plausible recent block height, the other is inside Permill range — and both are asserted on every read. They are not read from runtime metadata, so treat the field NAMES as this repo’s reading rather than as the pallet’s own.',
  ]

  if (misaligned.length) {
    notes.push(`⚠ ${misaligned.length} pool(s) have a peg record whose length does not match their asset list. Their pegs are withheld.`)
  }

  const pegged = decorated.filter((pool) => pool.pegged && pool.pegBlocksAgo !== null)
  if (pegged.length) {
    const stalest = pegged.reduce((worst, pool) => (pool.pegBlocksAgo > worst.pegBlocksAgo ? pool : worst))
    notes.push(
      `Peg records are not all fresh. The oldest was written ${stalest.pegBlocksAgo.toLocaleString('en-US')} blocks ago (pool ${stalest.id}${
        stalest.label ? `, ${stalest.label}` : ''
      }); the newest ${Math.min(...pegged.map((pool) => pool.pegBlocksAgo)).toLocaleString('en-US')}. Age is given in BLOCKS, which is exact, and not in hours, which would need a block-rate estimate this page does not make. A stale peg is not a wrong peg — it is a peg nothing has moved.`,
    )
  }

  notes.push(
    collaterals.length
      ? `The HSM currently holds ${collaterals.length} collateral${collaterals.length === 1 ? '' : 's'}: ${collaterals.map((c) => c.symbol ?? `asset ${c.assetId}`).join(', ')}. The set is read from storage on every refresh, never hardcoded — the arbs research found four collaterals in July 2026 and two in August, and anything carrying a fixed list would have rendered a subset without saying so.`
      : 'The HSM has no collateral entries at all right now. That is what the chain says; it is not a failure to read.',
  )

  if (collaterals.length) {
    const floor = [...new Set(collaterals.map((c) => c.maxBuyPriceCoefficient))]
    notes.push(
      `The buy-back price coefficient on chain is ${floor.map((f) => f.toFixed(3)).join(' / ')}. Hydration’s own published documentation says 0.995. The chain is the authority and it disagrees with the docs.`,
    )
    notes.push(
      `The purchase fee is ${[...new Set(collaterals.map((c) => c.purchaseFee))].join(' / ')} — exactly zero — so the sell side carries no fee at all.`,
    )
  }

  if (identicalRates) {
    notes.push(
      `⚠ On ${identicalRates} collateral row(s) the two rate parameters decode to the SAME value (1e-4) under different denominators, so a swapped labelling between them would be invisible here. The values are settled; which name belongs to which is this repo’s reading of the field order, not something the bytes can settle.`,
    )
  }

  notes.push(
    '`HSM::HollarAmountReceived` is reset in `on_finalize`, so an RPC read lands at a block boundary and returns nothing every time. Its entry count is reported for that reason and a time series of it would be a flat line of zeros.',
  )

  if (vdot.gapBps === null) {
    notes.push(
      vdot.bifrostError
        ? `The vDOT oracle gap is not measurable right now: ${vdot.bifrostError} The on-chain peg is still shown; the gap is blank, not zero. Falling back to the on-chain number would make the monitor agree with itself by construction.`
        : 'The vDOT oracle gap is not measurable right now — one of its two inputs is missing. It is blank rather than zero.',
    )
  } else {
    notes.push(
      `The vDOT gap compares pool ${VDOT_POOL}’s on-chain peg (${vdot.oraclePeg?.toFixed(6)}) with Bifrost’s own implied redemption rate (${vdot.trueRate?.toFixed(6)}): ${vdot.gapBps.toFixed(2)} bps. This is ONE reading. The arbs research measured 112 bps of lag on 2026-07-10 and ~0 bps on 2026-08-19 — a monitor answers whether a lag is normal, a snapshot cannot, and this site has no history behind it yet.`,
    )
  }

  notes.push(
    `${orders.count} open OTC orders, ${orders.partiallyFillable} of them partially fillable. The amounts are whatever \`amount_in\` and \`amount_out\` hold in storage right now; the map keeps no record of what an order was opened at, so a partially filled order shows a residue and its original size is not recoverable from here.`,
  )

  notes.push(
    'The "asks" column is `amount_out / amount_in` — the maker’s own ratio, and nothing more. It is not compared with any pool price and carries no claim about whether the order is good.',
  )

  if (orders.palletOrders) {
    notes.push(`${orders.palletOrders} of the open orders belong to accounts beginning with the ASCII "modl" — pallet accounts, not people. They are labelled as such.`)
  }

  if (orders.unpricedAssets.length) {
    notes.push(
      `${orders.unpricedAssets.length} asset(s) on the book have no decimals in \`AssetRegistry::Assets\` — the field is an \`Option\` and it is empty for them (${orders.unpricedAssets
        .map((asset) => `${asset.id}${asset.type ? ` · ${asset.type}` : ''}`)
        .join(', ')}). ${orders.unpricedOrders} order(s) therefore show no amount and no price rather than an unscaled integer.`,
    )
  }

  notes.push(
    `Read at block ${chain.block.toLocaleString('en-US')}, runtime spec ${chain.specVersion}. Every figure is current state with no history behind it, so nothing here says whether a value is usual.`,
  )
  return notes
}

/* ═══════════════════════════════════════════════════════════════════════════ registry ═════ */

export default {
  id: 'arbs-hydration',
  label: 'Hydration (venue structure)',
  homepage: 'https://hydration.net',
  transport: 'jsonrpc',
  doc: 'docs/platform/hydration.md',
  covers: ['Hydration (Polkadot parachain 2034) — money-market configuration, stableswap pegs, HSM, OTC'],

  operations: {
    'wrap-map': {
      summary:
        'The aToken wrap map: every money-market reserve bound to its Substrate asset id and to the wrapped asset it mints, with the Aave configuration bitmap, the caps and the e-mode categories.',
      // Five minutes. Configuration changes by governance vote, not by the block, and the whole
      // read is about a dozen requests against somebody else's free node.
      ttlMs: 300_000,
      schema: {},
      run: () => wrapMap(),
    },

    'peg-state': {
      summary:
        'Stableswap peg records for all pools, the HSM’s configured band per collateral, the vDOT peg measured against Bifrost’s own redemption rate, and the open OTC order book.',
      ttlMs: 300_000,
      schema: {},
      run: () => pegState(),
    },
  },
}
