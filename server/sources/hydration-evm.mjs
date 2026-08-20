// Hydration's money market and Omnipool balance sheet — the EVM plane of the same node the
// `hydration` source already reads.
//
// There is no money-market pallet. The market is an Aave v3 fork running as EVM contracts on
// Hydration's own EVM (chain id 222222), surfaced back into Substrate as `Erc20`-typed registry
// assets. It is read with `eth_call` over the same anonymous JSON-RPC endpoint, and that endpoint
// accepts a JSON *array* of calls — which is what collapses ~180 round trips into ~23 requests.
//
// ── the one mistake this whole module exists to not make ────────────────────────────────────
// An `Erc20`-typed registry asset has NO orml-tokens row. Reading one through orml does not
// error; it returns `null`, which every naive decoder turns into zero. Two live consequences,
// both measured here rather than quoted:
//
//   · `Tokens::TotalIssuance(222)` reads about 15,200 HOLLAR. The ERC-20 `totalSupply()` on the
//     contract in `AssetRegistry::AssetLocations(222)` reads about 11,494,500. The mirror is a
//     residue; the ratio between them is published on the page so "the obvious read is wrong"
//     is something a reader can see rather than take on trust.
//   · `Tokens::Accounts(omnipoolAccount, id)` returns `null` for 5 of the Omnipool's 19 assets —
//     the 4 `Erc20` ones and HDX, which is `pallet-balances` and not orml at all. Those five
//     include the two largest. A TVL summed from that sweep understates the pool by about half
//     and renders perfectly. So the sweep here uses THREE read paths, one per registry type, and
//     the page states how much of the pool each path was responsible for.
//
// ── the address discovery chain, and why it is not a constant ───────────────────────────────
// `Liquidation::BorrowingContract` is documented in circulating notes as where the Pool address
// lives. It reads `null` on chain — a `Default`-modifier item that has never been set — so
// anything trusting it gets the zero address. Instead the Pool is *derived*, and every hop is
// checked against the next:
//
//     AssetRegistry::Assets(1001)          must decode as an Erc20 asset called aDOT
//     AssetRegistry::AssetLocations(1001)  -> the aDOT aToken contract
//     aToken.UNDERLYING_ASSET_ADDRESS()    must equal the EVM address of asset 5 (DOT)
//     aToken.POOL()                        -> the core Pool
//     Pool.ADDRESSES_PROVIDER().getPool()  must equal that same Pool  <- the round trip
//
// The second market (GIGAHDX) needs no derivation: `GigaHdx::GigaHdxPoolContract` holds its
// address in storage and is read from there.
//
// Selectors are computed with keccak-256, never copied. `UNDERLYING_ASSET_ADDRESS()` is
// `0xb16a19de`; `0x89d1a0fc` circulates in third-party notes and is wrong.

import { callUpstream, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { twox128, xxhash64 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { keccakHex } from '../../src/core/codec/keccak.js'
import { toHex, fromHex, utf8, concat, u32le } from '../../src/core/codec/bytes.js'
import { decodeCompact } from '../../src/core/codec/scale.js'

const RPC = 'https://rpc.hydradx.cloud'

/** The registry ids this module refuses to proceed without. Ids, not addresses: an id is a
 *  legible thing a reader can check, and the registry entry behind it carries a symbol we can
 *  assert on before following it anywhere. */
const ANCHOR_ATOKEN = 1001 // aDOT — the aToken that leads to the Pool
const ANCHOR_UNDERLYING = 5 // DOT
const HOLLAR_ID = 222
const HUB_ID = 1 // H2O, the Omnipool hub asset. Renamed from LRNA; the registry is the authority.
const NATIVE_ID = 0 // HDX — pallet-balances, not orml

/** `modl` + `omnipool`, right-padded to 32 bytes. The EVM side sees the first 20 bytes. */
const OMNIPOOL_ACCOUNT = `0x6d6f646c6f6d6e69706f6f6c${'00'.repeat(20)}`

/** Aave's RAY. `currentLiquidityRate` and `currentVariableBorrowRate` are per-second linear
 *  rates scaled to 1e27 and annualised over a 365-day year. */
const RAY = 1e27
const SECONDS_PER_YEAR = 31_536_000

/* -------------------------------------------------------------------------- selectors ---- */

/** A 4-byte selector, computed. `keccakHex` is validated in its own module against
 *  `keccak256("") = c5d2…a470` and `transfer(address,uint256) = 0xa9059cbb`. */
const selector = (signature) => keccakHex(signature).slice(0, 10)

const SEL = {
  pool: selector('POOL()'),
  underlying: selector('UNDERLYING_ASSET_ADDRESS()'),
  addressesProvider: selector('ADDRESSES_PROVIDER()'),
  getPool: selector('getPool()'),
  getPriceOracle: selector('getPriceOracle()'),
  getPoolDataProvider: selector('getPoolDataProvider()'),
  baseCurrencyUnit: selector('BASE_CURRENCY_UNIT()'),
  getReservesList: selector('getReservesList()'),
  getReserveData: selector('getReserveData(address)'),
  getAssetPrice: selector('getAssetPrice(address)'),
  getEModeCategoryData: selector('getEModeCategoryData(uint8)'),
  totalSupply: selector('totalSupply()'),
  balanceOf: selector('balanceOf(address)'),
  symbol: selector('symbol()'),
  decimals: selector('decimals()'),
  facilitatorsList: selector('getFacilitatorsList()'),
  facilitatorBucket: selector('getFacilitatorBucket(address)'),
}

/* ------------------------------------------------------------------------ ABI decoding ---- */

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64)
const uintAt = (hex, i) => BigInt('0x' + word(hex, i))
const addressAt = (hex, i) => '0x' + word(hex, i).slice(24)
const padWord = (value) => String(value).replace(/^0x/, '').toLowerCase().padStart(64, '0')
const encodeUint = (value) => BigInt(value).toString(16).padStart(64, '0')

/** A `string` or `bytes` laid out at `head`: a length word, then the bytes. */
function stringAt(hex, head) {
  const length = Number(uintAt(hex, head))
  let text = ''
  for (let i = 0; i < length; i += 1) {
    const at = 2 + (head + 1 + Math.floor(i / 32)) * 64 + (i % 32) * 2
    const code = parseInt(hex.slice(at, at + 2), 16)
    if (!Number.isFinite(code)) break
    text += String.fromCharCode(code)
  }
  return text
}

/** A top-level dynamic return value: one head word holding a byte offset. */
const offsetWords = (hex, i) => Number(uintAt(hex, i)) / 32

function decodeAddressArray(hex) {
  const at = offsetWords(hex, 0)
  const length = Number(uintAt(hex, at))
  return Array.from({ length }, (_, i) => addressAt(hex, at + 1 + i))
}

const decodeString = (hex) => stringAt(hex, offsetWords(hex, 0))

/**
 * The EVM address of a Substrate-native registry asset: twelve zero bytes, then `00000001`,
 * then the u32 id big-endian. Verified against the live reserve list — asset 22 (USDC) is
 * `0x…0100000016`, asset 1000765 (tBTC) is `0x…01000f453d`.
 *
 * `Erc20`-typed assets do NOT follow this: their address is a real contract, and it lives in
 * `AssetRegistry::AssetLocations`.
 */
const evmAddressOfAsset = (id) => `0x${'0'.repeat(31)}1${Number(id).toString(16).padStart(8, '0')}`

/* -------------------------------------------------------------------- substrate storage ---- */

const palletPrefix = (pallet, item) => '0x' + toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))

/** `Twox64Concat` — eight little-endian bytes of the seed-0 digest, then the key itself. */
function twox64Concat(bytes) {
  const digest = new Uint8Array(8)
  new DataView(digest.buffer).setBigUint64(0, xxhash64(bytes, 0), true)
  return toHex(digest) + toHex(bytes)
}

const blake2Concat = (bytes) => toHex(blake2b(bytes, 16)) + toHex(bytes)

/**
 * The hashers are named apart rather than assumed, because getting one wrong does not error —
 * it returns `null`, which reads as "this asset has no supply" instead of as a bug. Verified
 * live: `AssetRegistry` and `Omnipool` maps are `Blake2_128Concat`; orml's `TotalIssuance` and
 * the currency half of `Tokens::Accounts` are `Twox64Concat`.
 */
const registryKey = (item, id) => palletPrefix('AssetRegistry', item) + blake2Concat(u32le(id))
const omnipoolKey = (id) => palletPrefix('Omnipool', 'Assets') + blake2Concat(u32le(id))
const totalIssuanceKey = (id) => palletPrefix('Tokens', 'TotalIssuance') + twox64Concat(u32le(id))
const tokensAccountKey = (account, id) =>
  palletPrefix('Tokens', 'Accounts') + blake2Concat(fromHex(account)) + twox64Concat(u32le(id))
const systemAccountKey = (account) => palletPrefix('System', 'Account') + blake2Concat(fromHex(account))

/** A fixed-width little-endian unsigned integer at a byte offset. */
function decodeUintLe(hex, byteOffset = 0, byteLength = 16) {
  if (!hex) return null
  const bytes = hex.replace(/^0x/, '')
  const slice = bytes.slice(byteOffset * 2, (byteOffset + byteLength) * 2)
  if (slice.length !== byteLength * 2) return null
  const reversed = (slice.match(/../g) ?? []).reverse().join('')
  return BigInt('0x' + reversed)
}

const ASSET_TYPE = ['Token', 'XYK', 'StableSwap', 'Bond', 'External', 'Erc20']

/**
 * `AssetRegistry::Assets: AssetId -> AssetDetails`, decoded to the fields this module needs.
 * Same self-check discipline as `server/sources/hydration.mjs`: leftover bytes throw, because a
 * layout change that yields a plausible symbol with the wrong decimals is a silent factor of
 * 10^n on every amount underneath it.
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

/**
 * `AssetRegistry::AssetLocations: AssetId -> Location`. For an `Erc20` asset this is always the
 * same 24-byte shape — `parents: 0`, `X1[ AccountKey20 { network: None, key } ]` — so it is
 * decoded by asserting that shape rather than by shipping an XCM decoder. An unexpected shape
 * returns null and the caller says the address could not be resolved, which is the honest
 * answer; taking 20 bytes off the end of an arbitrary junction would not be.
 */
function decodeErc20Location(hex) {
  if (!hex) return null
  const bytes = hex.replace(/^0x/, '').toLowerCase()
  if (bytes.length !== 48 || !bytes.startsWith('00010300')) return null
  return '0x' + bytes.slice(8)
}

/**
 * `Omnipool::Assets: AssetId -> AssetState` — 65 bytes exactly:
 *   u128 hub_reserve, u128 shares, u128 protocol_shares, u128 cap, u8 tradable bitflags.
 *
 * NOTE what is NOT in here: the asset reserve. That is the Omnipool account's *balance*, and
 * which storage holds it depends on the asset's registry type. This is the structural fact the
 * whole Omnipool section below is arranged around.
 */
function decodeAssetState(hex) {
  const bytes = fromHex(hex)
  if (bytes.length !== 65) throw new Error(`AssetState is ${bytes.length} bytes, expected 65`)
  return {
    hubReserve: decodeUintLe(hex, 0, 16),
    shares: decodeUintLe(hex, 16, 16),
    protocolShares: decodeUintLe(hex, 32, 16),
    cap: decodeUintLe(hex, 48, 16),
    tradable: bytes[64],
  }
}

/** `frame_system::AccountInfo` — nonce/consumers/providers/sufficients (4 × u32), then
 *  `AccountData { free, reserved, frozen, flags }`. `free` starts at byte 16. */
const decodeSystemFree = (hex) => decodeUintLe(hex, 16, 16)

/** orml `AccountData { free, reserved, frozen }` — 48 bytes. */
const decodeOrmlFree = (hex) => decodeUintLe(hex, 0, 16)

/* -------------------------------------------------------------------------- transports ---- */

/**
 * A JSON-RPC batch: one HTTP request carrying an array of calls, answered with an array of
 * results. Verified live on this host — it is what makes a 25-reserve snapshot cost a couple of
 * dozen requests instead of a couple of hundred.
 *
 * Per-item failures are RETURNED, not thrown. An `eth_call` that reverts is ordinary here: the
 * price oracle only prices assets that are money-market reserves, so a reverting
 * `getAssetPrice` means "no price" — which must become `null` and a stated caveat, not a dead
 * page and not a zero.
 */
async function ethCallBatch(calls) {
  if (!calls.length) return []
  const body = calls.map((call, id) => ({
    jsonrpc: '2.0',
    id,
    method: 'eth_call',
    params: [{ to: call.to, data: call.data }, 'latest'],
  }))
  const answer = await callUpstream({ source: 'hydration-evm', url: RPC, method: 'POST', body, timeoutMs: 45_000 })
  if (!Array.isArray(answer)) {
    throw new UpstreamError('the node answered a JSON-RPC batch with something that is not an array.', {
      kind: 'decode',
      source: 'hydration-evm',
    })
  }
  const out = new Array(calls.length).fill(null)
  for (const item of answer) {
    if (!Number.isInteger(item?.id) || item.id < 0 || item.id >= calls.length) continue
    out[item.id] = item.error ? { error: String(item.error.message ?? 'reverted') } : { result: item.result }
  }
  return out
}

/** The same batch, but every item must succeed — used for the discovery chain, where a revert
 *  means we do not know where the market is and therefore must not draw one. */
async function ethCallAll(calls, what) {
  const results = await ethCallBatch(calls)
  return results.map((item, i) => {
    if (!item?.result) {
      throw new UpstreamError(
        `${what}: call ${i} (${calls[i].data.slice(0, 10)} on ${calls[i].to}) failed — ${item?.error ?? 'no answer'}.`,
        { kind: 'upstream', source: 'hydration-evm' },
      )
    }
    return item.result
  })
}

/** Several storage keys, one request. Missing keys come back as `null`, which is a fact about
 *  the chain here rather than an error — see the header. */
async function storageAt(keys) {
  const changes = await jsonRpc({
    source: 'hydration-rpc',
    url: RPC,
    method: 'state_queryStorageAt',
    params: [keys],
    timeoutMs: 30_000,
  })
  const byKey = new Map((changes?.[0]?.changes ?? []).map(([key, value]) => [key.toLowerCase(), value]))
  return keys.map((key) => byKey.get(key.toLowerCase()) ?? null)
}

/* ---------------------------------------------------------------------------- numbers ---- */

/** A raw token amount to a float. `null` in, `null` out — never zero. */
function scaled(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null
  return Number(raw) / 10 ** decimals
}

/**
 * Aave stores a linear per-second rate annualised into a ray. The APY is that rate compounded
 * every second, which is what a borrower actually pays and what every Aave frontend shows. Both
 * are published, because the difference is real (2.90 % APR is 2.95 % APY) and because a single
 * unlabelled "rate" column is how two dashboards come to disagree.
 */
function apyFromRay(ray) {
  const apr = Number(ray) / RAY
  if (!Number.isFinite(apr)) return null
  return Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR))
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Sum that keeps `null` out of the arithmetic. An all-null list sums to `null`, not to 0. */
const sum = (values) => {
  const present = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v))
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

/**
 * The Aave v3 reserve configuration bitmap. Layout verified against known values — USDC decodes
 * to 6 decimals / LTV 80.00 % — and the decimals it yields are cross-checked against the
 * underlying contract's own `decimals()` on every reserve before any amount is scaled.
 */
function decodeConfiguration(bits) {
  const field = (offset, width) => Number((bits >> BigInt(offset)) & ((1n << BigInt(width)) - 1n))
  return {
    ltvBps: field(0, 16),
    liquidationThresholdBps: field(16, 16),
    liquidationBonusBps: field(32, 16),
    decimals: field(48, 8),
    active: field(56, 1) === 1,
    frozen: field(57, 1) === 1,
    borrowingEnabled: field(58, 1) === 1,
    paused: field(60, 1) === 1,
    reserveFactorBps: field(64, 16),
    borrowCap: field(80, 36),
    supplyCap: field(116, 36),
    liquidationProtocolFeeBps: field(152, 16),
    eModeCategory: field(168, 8),
  }
}

/** `ReserveDataLegacy` — fifteen words, in this order. */
function decodeReserveData(hex) {
  if (!hex || (hex.length - 2) / 64 < 15) throw new Error('getReserveData did not return 15 words')
  return {
    configuration: decodeConfiguration(uintAt(hex, 0)),
    liquidityRate: uintAt(hex, 2),
    variableBorrowRate: uintAt(hex, 4),
    lastUpdate: Number(uintAt(hex, 6)),
    aToken: addressAt(hex, 8),
    stableDebtToken: addressAt(hex, 9),
    variableDebtToken: addressAt(hex, 10),
    accruedToTreasury: uintAt(hex, 12),
  }
}

/* -------------------------------------------------------------------------- discovery ---- */

/**
 * Find the Pool without trusting a hardcoded address, and refuse to draw anything if the chain
 * disagrees with itself at any hop. See the header for the chain, and for why
 * `Liquidation::BorrowingContract` is not part of it.
 */
async function discover() {
  const [anchorDetails, anchorLocation, gigaPoolRaw, borrowingContract, hollarLocation, hollarIssuance, hubDetails] =
    await storageAt([
      registryKey('Assets', ANCHOR_ATOKEN),
      registryKey('AssetLocations', ANCHOR_ATOKEN),
      palletPrefix('GigaHdx', 'GigaHdxPoolContract'),
      palletPrefix('Liquidation', 'BorrowingContract'),
      registryKey('AssetLocations', HOLLAR_ID),
      totalIssuanceKey(HOLLAR_ID),
      registryKey('Assets', HUB_ID),
    ])

  if (!anchorDetails) {
    throw new UpstreamError(`AssetRegistry has no asset ${ANCHOR_ATOKEN}; the discovery anchor is gone.`, {
      kind: 'upstream',
      source: 'hydration-rpc',
    })
  }
  let anchor
  let hub
  try {
    anchor = decodeAssetDetails(anchorDetails)
    hub = hubDetails ? decodeAssetDetails(hubDetails) : null
  } catch (error) {
    throw new UpstreamError(`asset registry: ${error.message}`, { kind: 'decode', source: 'hydration-rpc' })
  }
  if (anchor.type !== 'Erc20' || anchor.symbol !== 'aDOT') {
    throw new UpstreamError(
      `asset ${ANCHOR_ATOKEN} decoded as ${anchor.symbol}/${anchor.type}, expected aDOT/Erc20. ` +
        'Refusing to follow it to a market address.',
      { kind: 'decode', source: 'hydration-rpc' },
    )
  }
  if (!hub || hub.decimals === null) {
    throw new UpstreamError(`the Omnipool hub asset (id ${HUB_ID}) has no decimals in the registry.`, {
      kind: 'decode',
      source: 'hydration-rpc',
    })
  }

  const anchorToken = decodeErc20Location(anchorLocation)
  if (!anchorToken) {
    throw new UpstreamError(`AssetLocations(${ANCHOR_ATOKEN}) is not the AccountKey20 shape an Erc20 asset has.`, {
      kind: 'decode',
      source: 'hydration-rpc',
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
      `the aDOT aToken says its underlying is ${addressAt(underlyingRaw, 0)}, not DOT (${expected}). ` +
        'The registry and the market no longer agree about what aDOT is.',
      { kind: 'decode', source: 'hydration-evm' },
    )
  }
  const corePool = addressAt(poolRaw, 0)

  const [providerRaw] = await ethCallAll([{ to: corePool, data: SEL.addressesProvider }], 'addresses provider')
  const provider = addressAt(providerRaw, 0)

  const [roundTrip, oracleRaw, dataProviderRaw] = await ethCallAll(
    [
      { to: provider, data: SEL.getPool },
      { to: provider, data: SEL.getPriceOracle },
      { to: provider, data: SEL.getPoolDataProvider },
    ],
    'addresses provider registry',
  )
  if (addressAt(roundTrip, 0) !== corePool) {
    throw new UpstreamError(
      `the addresses provider names ${addressAt(roundTrip, 0)} as the pool, but the aDOT aToken names ${corePool}.`,
      { kind: 'decode', source: 'hydration-evm' },
    )
  }

  return {
    corePool,
    gigaPool: gigaPoolRaw && /^0x[0-9a-f]{40}$/i.test(gigaPoolRaw) ? gigaPoolRaw.toLowerCase() : null,
    provider,
    oracle: addressAt(oracleRaw, 0),
    dataProvider: addressAt(dataProviderRaw, 0),
    anchorToken,
    hollarToken: decodeErc20Location(hollarLocation),
    hubDecimals: hub.decimals,
    hubSymbol: hub.symbol,
    // Published, not used. It is where circulating notes say the pool address lives, and it is
    // empty — that is worth stating on the page rather than silently working around.
    borrowingContract: borrowingContract ?? null,
    hollarIssuanceRaw: decodeUintLe(hollarIssuance, 0, 16),
  }
}

/* ------------------------------------------------------------------------- the market ---- */

/**
 * One market's reserves. Five requests: the reserve list, the reserve structs, the labels, the
 * token supplies, the prices. Every one of them is a single HTTP request carrying a batch.
 */
async function readMarket({ pool, label, oracle, baseUnit }) {
  const [listRaw] = await ethCallAll([{ to: pool, data: SEL.getReservesList }], `${label} reserve list`)
  const assets = decodeAddressArray(listRaw)
  if (!assets.length) return { label, pool, reserves: [], unreadable: [] }

  const structs = await ethCallBatch(assets.map((asset) => ({ to: pool, data: SEL.getReserveData + padWord(asset) })))

  const decoded = []
  const unreadable = []
  assets.forEach((asset, i) => {
    if (!structs[i]?.result) return unreadable.push(asset)
    try {
      decoded.push({ asset, data: decodeReserveData(structs[i].result) })
    } catch (error) {
      throw new UpstreamError(`${label} reserve ${asset}: ${error.message}`, { kind: 'decode', source: 'hydration-evm' })
    }
  })

  const labels = await ethCallBatch(
    decoded.flatMap(({ asset, data }) => [
      { to: asset, data: SEL.symbol },
      { to: asset, data: SEL.decimals },
      { to: data.aToken, data: SEL.symbol },
    ]),
  )

  const supplies = await ethCallBatch(
    decoded.flatMap(({ asset, data }) => [
      { to: data.aToken, data: SEL.totalSupply },
      { to: data.variableDebtToken, data: SEL.totalSupply },
      { to: data.stableDebtToken, data: SEL.totalSupply },
      { to: asset, data: SEL.balanceOf + padWord(data.aToken) },
    ]),
  )

  const prices = await ethCallBatch(decoded.map(({ asset }) => ({ to: oracle, data: SEL.getAssetPrice + padWord(asset) })))

  const reserves = decoded.map(({ asset, data }, i) => {
    const config = data.configuration
    const read = (row, offset) => (row[offset]?.result ? row[offset] : null)
    const symbol = read(labels, i * 3) ? decodeString(labels[i * 3].result) : null
    const contractDecimals = read(labels, i * 3 + 1) ? Number(uintAt(labels[i * 3 + 1].result, 0)) : null
    const aTokenSymbol = read(labels, i * 3 + 2) ? decodeString(labels[i * 3 + 2].result) : null

    // The bitmap and the contract must agree about decimals. If they do not, every amount on
    // this row is out by a power of ten and still renders, so the whole read is refused.
    if (contractDecimals !== null && contractDecimals !== config.decimals) {
      throw new UpstreamError(
        `${label} reserve ${symbol ?? asset}: the configuration bitmap says ${config.decimals} decimals, ` +
          `the contract says ${contractDecimals}.`,
        { kind: 'decode', source: 'hydration-evm' },
      )
    }
    const decimals = config.decimals

    const raw = (offset) => (supplies[i * 4 + offset]?.result ? uintAt(supplies[i * 4 + offset].result, 0) : null)
    const suppliedRaw = raw(0)
    const variableDebtRaw = raw(1)
    const stableDebtRaw = raw(2)
    const availableRaw = raw(3)
    const borrowedRaw =
      variableDebtRaw === null && stableDebtRaw === null ? null : (variableDebtRaw ?? 0n) + (stableDebtRaw ?? 0n)

    const supplied = scaled(suppliedRaw, decimals)
    const borrowed = scaled(borrowedRaw, decimals)
    const available = scaled(availableRaw, decimals)

    // A reserve nobody has supplied has NO utilisation — the ratio is 0/0. HOLLAR is exactly
    // that: zero supply, eleven million of debt, because it is minted as debt rather than
    // deposited. Printing 0 % there would read as "nobody is borrowing it", the opposite of the
    // truth, so it is null and the page says why.
    const utilisation = supplied === null || borrowed === null || supplied === 0 ? null : borrowed / supplied

    const priceRaw = prices[i]?.result ? uintAt(prices[i].result, 0) : null

    return {
      market: label,
      asset,
      symbol,
      aTokenSymbol,
      decimals,
      aToken: data.aToken,
      variableDebtToken: data.variableDebtToken,
      supplied,
      borrowed,
      available,
      utilisation,
      supplyApy: apyFromRay(data.liquidityRate),
      borrowApy: apyFromRay(data.variableBorrowRate),
      supplyApr: Number(data.liquidityRate) / RAY,
      borrowApr: Number(data.variableBorrowRate) / RAY,
      oraclePrice: priceRaw === null ? null : Number(priceRaw) / baseUnit,
      priceError: prices[i]?.error ?? null,
      ltvBps: config.ltvBps,
      liquidationThresholdBps: config.liquidationThresholdBps,
      liquidationBonusBps: config.liquidationBonusBps,
      reserveFactorBps: config.reserveFactorBps,
      supplyCap: config.supplyCap,
      borrowCap: config.borrowCap,
      eModeCategory: config.eModeCategory,
      active: config.active,
      frozen: config.frozen,
      paused: config.paused,
      borrowingEnabled: config.borrowingEnabled,
      lastUpdate: data.lastUpdate,
    }
  })

  return { label, pool, reserves, unreadable }
}

/* ---------------------------------------------------------------------------- e-mode ---- */

/**
 * e-mode categories, by enumeration: there is no count on chain, so ids are walked from 1 to a
 * fixed ceiling and the empty ones dropped. The ceiling is published, so a reader can tell that
 * the list is bounded by us rather than complete by construction.
 *
 * Worth recording against our own notes: `docs/concept/research/hydration.md` reports (2026-08-19)
 * that this call "returns an all-zero struct" and that category metadata is unreadable on this
 * deployment. Read again on 2026-08-20 it returns fully populated categories with human labels.
 * The code takes what the chain says now; the page states that the note disagrees.
 */
const EMODE_CEILING = 8

async function readEModes(pool) {
  const answers = await ethCallBatch(
    Array.from({ length: EMODE_CEILING }, (_, i) => ({ to: pool, data: SEL.getEModeCategoryData + encodeUint(i + 1) })),
  )
  const categories = []
  answers.forEach((answer, i) => {
    if (!answer?.result) return
    const hex = answer.result
    // `EModeCategoryLegacy { uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus,
    //  address priceSource, string label }` — a dynamic struct, so word 0 is its offset and the
    // label's own offset is relative to the struct, not to the start of the return value.
    const at = offsetWords(hex, 0)
    const ltvBps = Number(uintAt(hex, at))
    const label = stringAt(hex, at + offsetWords(hex, at + 4))
    if (!label && !ltvBps) return // an unallocated id, not a category
    categories.push({
      id: i + 1,
      label: label || `category ${i + 1}`,
      ltvBps,
      liquidationThresholdBps: Number(uintAt(hex, at + 1)),
      liquidationBonusBps: Number(uintAt(hex, at + 2)),
    })
  })
  return categories
}

/* ---------------------------------------------------------------------------- HOLLAR ---- */

const MODL = '6d6f646c'

/** An EVM address beginning with the ASCII "modl" is a pallet account truncated to 20 bytes,
 *  not a contract somebody deployed. The HSM is one. It is the difference between "the protocol
 *  minted this" and "a third party did", so it is named. */
function palletNameOfEvmAddress(address) {
  const hex = String(address).replace(/^0x/, '').toLowerCase()
  if (!hex.startsWith(MODL)) return null
  let text = ''
  for (let i = MODL.length; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code === 0 || code < 0x20 || code > 0x7e) break
    text += String.fromCharCode(code)
  }
  return text ? `pallet:${text}` : 'pallet'
}

/**
 * HOLLAR is a GHO fork: supply is not minted by a treasury, it is minted by *facilitators*, each
 * with a bucket capacity and a current level. The levels must sum to `totalSupply()` exactly —
 * that is the invariant the token enforces, and checking it costs nothing, so it is checked. A
 * mismatch is reported on the page rather than thrown: the two reads are one round trip apart
 * and the borrow facilitator accrues interest continuously.
 */
async function readHollar(token) {
  if (!token) return null
  const [supplyRaw, decimalsRaw, listRaw, symbolRaw] = await ethCallAll(
    [
      { to: token, data: SEL.totalSupply },
      { to: token, data: SEL.decimals },
      { to: token, data: SEL.facilitatorsList },
      { to: token, data: SEL.symbol },
    ],
    'HOLLAR token',
  )
  const decimals = Number(uintAt(decimalsRaw, 0))
  const totalSupplyRaw = uintAt(supplyRaw, 0)
  const addresses = decodeAddressArray(listRaw)

  const buckets = await ethCallBatch(addresses.map((a) => ({ to: token, data: SEL.facilitatorBucket + padWord(a) })))
  const facilitators = addresses.map((address, i) => {
    const hex = buckets[i]?.result
    const capacityRaw = hex ? uintAt(hex, 0) : null
    const levelRaw = hex ? uintAt(hex, 1) : null
    return {
      address,
      pallet: palletNameOfEvmAddress(address),
      capacity: scaled(capacityRaw, decimals),
      level: scaled(levelRaw, decimals),
      headroom: capacityRaw === null || levelRaw === null ? null : scaled(capacityRaw - levelRaw, decimals),
      atCapacity: capacityRaw !== null && levelRaw !== null && capacityRaw > 0n && levelRaw >= capacityRaw,
      unreadable: !hex,
    }
  })

  const readable = facilitators.filter((f) => !f.unreadable)
  const levelSumRaw = addresses.reduce((total, _, i) => {
    const hex = buckets[i]?.result
    return hex ? total + uintAt(hex, 1) : total
  }, 0n)

  return {
    token,
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupply: scaled(totalSupplyRaw, decimals),
    facilitators,
    facilitatorCount: facilitators.length,
    unreadableFacilitators: facilitators.length - readable.length,
    mintCapacity: sum(facilitators.map((f) => f.capacity)),
    levelSum: scaled(levelSumRaw, decimals),
    // Compared as integers. A float comparison here would pass on a gap of several HOLLAR.
    levelSumMatchesSupply: levelSumRaw === totalSupplyRaw && readable.length === facilitators.length,
    levelSumGap: scaled(totalSupplyRaw - levelSumRaw, decimals),
  }
}

/* -------------------------------------------------------------------------- Omnipool ---- */

/**
 * The Omnipool's balance sheet, read the way that does not drop assets.
 *
 * `Omnipool::Assets` gives every listed asset's `hub_reserve` — its value denominated in the hub
 * asset — so the pool's total is the sum of those and does NOT depend on reading balances at
 * all. The balances are read anyway, by all three paths, because they are what a spot price and
 * a per-asset token amount need, and because measuring how much of the pool the orml path alone
 * would have found is the only way to say how wrong the naive sweep is *today* rather than on
 * the day somebody wrote it down.
 *
 * The hub asset has no dollar price of its own. It is anchored by inverting the pool: for every
 * listed asset the money market can price, `hubUsd = reserve × price / hub_reserve`. Several
 * assets give several answers; the median is used and the spread is published, because an
 * anchor derived from one asset is a single point of failure with no way to notice it failed.
 */
async function readOmnipool({ oracle, baseUnit, hubDecimals, priceByAddress }) {
  const prefix = palletPrefix('Omnipool', 'Assets')
  const PAGE = 200
  const keys = await jsonRpc({
    source: 'hydration-rpc',
    url: RPC,
    method: 'state_getKeysPaged',
    params: [prefix, PAGE, prefix],
    timeoutMs: 30_000,
  })
  if (!keys?.length) return null
  // One page. The pool has had ~19 assets for its whole life, so paging is not implemented —
  // but a truncated first page would silently understate the pool, which is exactly the class
  // of failure this module exists to avoid. Refuse rather than under-report.
  if (keys.length >= PAGE) {
    throw new UpstreamError(
      `Omnipool::Assets returned a full page of ${PAGE} keys; this reader takes one page and would understate the pool.`,
      { kind: 'upstream', source: 'hydration-rpc' },
    )
  }

  // The id is the concat half of `Blake2_128Concat`: the last four bytes, little-endian.
  const ids = keys.map((key) => {
    const tail = key.slice(key.length - 8)
    return parseInt((tail.match(/../g) ?? []).reverse().join(''), 16)
  })

  const states = await storageAt(ids.map(omnipoolKey))

  // One request for everything Substrate still owes us: the registry entry, the location and
  // the orml balance for each asset, plus the native balance of the pool account.
  const detailKeys = [
    ...ids.map((id) => registryKey('Assets', id)),
    ...ids.map((id) => registryKey('AssetLocations', id)),
    ...ids.map((id) => tokensAccountKey(OMNIPOOL_ACCOUNT, id)),
    systemAccountKey(OMNIPOOL_ACCOUNT),
  ]
  const details = await storageAt(detailKeys)
  const n = ids.length
  const registryRaw = details.slice(0, n)
  const locationRaw = details.slice(n, 2 * n)
  const ormlRaw = details.slice(2 * n, 3 * n)
  const nativeFree = decodeSystemFree(details[3 * n])

  const assets = ids.map((id, i) => {
    let registry = null
    try {
      registry = registryRaw[i] ? decodeAssetDetails(registryRaw[i]) : null
    } catch (error) {
      throw new UpstreamError(`Omnipool asset ${id}: ${error.message}`, { kind: 'decode', source: 'hydration-rpc' })
    }
    let state = null
    try {
      state = states[i] ? decodeAssetState(states[i]) : null
    } catch (error) {
      throw new UpstreamError(`Omnipool asset ${id}: ${error.message}`, { kind: 'decode', source: 'hydration-rpc' })
    }
    const contract = decodeErc20Location(locationRaw[i])
    const isErc20 = registry?.type === 'Erc20'
    return {
      id,
      symbol: registry?.symbol ?? null,
      type: registry?.type ?? null,
      decimals: registry?.decimals ?? null,
      contract: isErc20 ? contract : null,
      hubReserveRaw: state?.hubReserve ?? null,
      ormlFree: ormlRaw[i] ? decodeOrmlFree(ormlRaw[i]) : null,
      // Which storage actually holds this asset's balance. Three answers, and picking the wrong
      // one returns null rather than an error — which is the entire trap.
      readPath: isErc20 ? 'evm' : id === NATIVE_ID ? 'system' : 'orml',
    }
  })

  // The one EVM batch this section needs: the pool account's balance of every Erc20 asset.
  const erc20 = assets.filter((a) => a.readPath === 'evm' && a.contract)
  const omnipoolEvm = OMNIPOOL_ACCOUNT.slice(0, 42)
  const balances = await ethCallBatch(
    erc20.map((a) => ({ to: a.contract, data: SEL.balanceOf + padWord(omnipoolEvm) })),
  )
  const evmBalance = new Map(
    erc20.map((a, i) => [a.id, balances[i]?.result ? uintAt(balances[i].result, 0) : null]),
  )

  // Prices for anything the market did not already price for us.
  const needsPrice = assets.filter((a) => {
    const address = (a.contract ?? evmAddressOfAsset(a.id)).toLowerCase()
    return !priceByAddress.has(address)
  })
  const extraPrices = await ethCallBatch(
    needsPrice.map((a) => ({ to: oracle, data: SEL.getAssetPrice + padWord(a.contract ?? evmAddressOfAsset(a.id)) })),
  )
  needsPrice.forEach((a, i) => {
    if (!extraPrices[i]?.result) return
    priceByAddress.set((a.contract ?? evmAddressOfAsset(a.id)).toLowerCase(), Number(uintAt(extraPrices[i].result, 0)) / baseUnit)
  })

  // Nothing below this line carries a BigInt: the wire format is JSON and a raw u128 would
  // throw on serialisation rather than round-trip.
  const rows = assets.map((a) => {
    const reserveRaw =
      a.readPath === 'evm' ? evmBalance.get(a.id) ?? null : a.readPath === 'system' ? nativeFree : a.ormlFree
    return {
      id: a.id,
      symbol: a.symbol,
      type: a.type,
      decimals: a.decimals,
      contract: a.contract,
      readPath: a.readPath,
      reserve: scaled(reserveRaw, a.decimals),
      hubReserve: scaled(a.hubReserveRaw, hubDecimals),
      oraclePrice: priceByAddress.get((a.contract ?? evmAddressOfAsset(a.id)).toLowerCase()) ?? null,
      // What an ORML-only sweep would have returned for this asset. It is the whole point of
      // the section, so it travels as its own field rather than being inferred on the page.
      ormlWouldFind: a.ormlFree !== null ? scaled(a.ormlFree, a.decimals) : null,
    }
  })

  // Anchor the hub asset. One candidate per priced asset with a non-zero reserve.
  const candidates = rows
    .filter((r) => r.oraclePrice !== null && r.reserve && r.hubReserve)
    .map((r) => ({ symbol: r.symbol, hubUsd: (r.reserve * r.oraclePrice) / r.hubReserve }))
  const hubUsd = median(candidates.map((c) => c.hubUsd))
  const spreadBps =
    candidates.length > 1 && hubUsd
      ? ((Math.max(...candidates.map((c) => c.hubUsd)) - Math.min(...candidates.map((c) => c.hubUsd))) / hubUsd) * 10_000
      : null

  const priced = rows.map((r) => ({
    ...r,
    // TVL comes from `hub_reserve`, which exists for every listed asset — so no asset can go
    // missing from the total even if its balance read fails.
    tvlUsd: hubUsd === null || r.hubReserve === null ? null : r.hubReserve * hubUsd,
    // The spot price the pool itself implies, which is the only way HDX gets a dollar figure:
    // the money-market oracle only prices its own reserves and reverts on HDX.
    spotUsd: hubUsd === null || !r.reserve || r.hubReserve === null ? null : (r.hubReserve * hubUsd) / r.reserve,
  }))

  const tvlUsd = sum(priced.map((r) => r.tvlUsd))
  const missed = priced.filter((r) => r.readPath !== 'orml')
  const missedUsd = sum(missed.map((r) => r.tvlUsd))

  return {
    hubDecimals,
    hubUsd,
    hubAnchorCount: candidates.length,
    hubAnchorSpreadBps: spreadBps,
    hubAnchors: candidates.map((c) => c.symbol),
    assetCount: priced.length,
    tvlUsd,
    byReadPath: ['orml', 'system', 'evm'].map((path) => ({
      path,
      count: priced.filter((r) => r.readPath === path).length,
      tvlUsd: sum(priced.filter((r) => r.readPath === path).map((r) => r.tvlUsd)),
    })),
    ormlOnlyMissesCount: missed.length,
    ormlOnlyMissesUsd: missedUsd,
    ormlOnlyMissesShare: tvlUsd && missedUsd !== null ? missedUsd / tvlUsd : null,
    ormlOnlyMissesSymbols: missed.map((r) => r.symbol ?? `asset ${r.id}`),
    unreadableReserves: priced.filter((r) => r.reserve === null).map((r) => r.symbol ?? `asset ${r.id}`),
    assets: priced.sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1)),
  }
}

/* ------------------------------------------------------------------------- the source ---- */

/** Reserve symbols that are receipts for something already counted elsewhere: an aToken over a
 *  stableswap LP share. Matched on the registry's own naming rather than on a hardcoded list,
 *  because the set changes and a stale list would silently stop flagging a new one. */
const WRAPPER_SYMBOL = /^(?:\d+-Pool|G(?:DOT|ETH|SOL))/i

export default {
  id: 'hydration-evm',
  label: 'Hydration money market (Aave v3 fork, EVM plane)',
  homepage: 'https://app.hydration.net/borrow',
  transport: 'jsonrpc-eth',
  doc: 'docs/platform/hydration.md',
  covers: ['Hydration (Polkadot parachain 2034) — EVM plane, chain id 222222'],

  operations: {
    market: {
      summary:
        'Every reserve in Hydration’s Aave-fork money market — supplied, borrowed, utilisation, rates, caps, e-mode — plus HOLLAR’s real ERC-20 supply with its facilitator buckets, and the Omnipool balance sheet read by all three storage paths.',
      // Five minutes. Rates, balances and supply are current state and are never immutable, so
      // this is a TTL cache and nothing more. One snapshot is a couple of dozen requests against
      // a public node; doing it per visitor would make this site that node's heaviest anonymous
      // client by a wide margin.
      ttlMs: 300_000,
      schema: {},

      async run() {
        const startedAt = Date.now()
        const found = await discover()

        const [baseUnitRaw] = await ethCallAll([{ to: found.oracle, data: SEL.baseCurrencyUnit }], 'oracle base unit')
        const baseUnit = Number(uintAt(baseUnitRaw, 0))
        if (!(baseUnit > 0)) {
          throw new UpstreamError('the price oracle reports a base currency unit of zero.', {
            kind: 'decode',
            source: 'hydration-evm',
          })
        }

        const markets = [await readMarket({ pool: found.corePool, label: 'Core', oracle: found.oracle, baseUnit })]
        if (found.gigaPool) {
          markets.push(await readMarket({ pool: found.gigaPool, label: 'GIGAHDX', oracle: found.oracle, baseUnit }))
        }

        const eModes = await readEModes(found.corePool)
        const hollar = await readHollar(found.hollarToken)

        const reserves = markets.flatMap((m) => m.reserves)
        const priceByAddress = new Map(
          reserves.filter((r) => r.oraclePrice !== null).map((r) => [r.asset.toLowerCase(), r.oraclePrice]),
        )

        const omnipool = await readOmnipool({
          oracle: found.oracle,
          baseUnit,
          hubDecimals: found.hubDecimals,
          priceByAddress,
        })

        // The Omnipool's implied spot prices are the only dollar figure available for an asset
        // the money-market oracle refuses — HDX above all, and therefore stHDX. Applying it here
        // is the one place a price crosses from one venue to the other, so it is labelled
        // `spot` and never merged into `oraclePrice`.
        const spotBySymbol = new Map(
          (omnipool?.assets ?? [])
            .filter((a) => a.symbol && a.spotUsd !== null)
            .map((a) => [a.symbol.toUpperCase(), a.spotUsd]),
        )
        const stakedOf = (symbol) => (symbol && /^st/i.test(symbol) ? symbol.slice(2).toUpperCase() : null)

        for (const reserve of reserves) {
          if (reserve.oraclePrice !== null) {
            reserve.price = reserve.oraclePrice
            reserve.priceSource = 'money-market oracle'
          } else {
            // A staked wrapper is valued at its underlying's spot, which is a FLOOR: staking
            // rewards make stHDX worth at least one HDX and generally more. Said on the page.
            const key = spotBySymbol.has((reserve.symbol ?? '').toUpperCase())
              ? (reserve.symbol ?? '').toUpperCase()
              : stakedOf(reserve.symbol)
            const spot = key ? spotBySymbol.get(key) ?? null : null
            reserve.price = spot
            reserve.priceSource = spot === null ? null : `Omnipool spot (${key})`
          }
          reserve.suppliedUsd = reserve.price === null || reserve.supplied === null ? null : reserve.supplied * reserve.price
          reserve.borrowedUsd = reserve.price === null || reserve.borrowed === null ? null : reserve.borrowed * reserve.price
          reserve.availableUsd =
            reserve.price === null || reserve.available === null ? null : reserve.available * reserve.price
          reserve.isWrapper = WRAPPER_SYMBOL.test(reserve.symbol ?? '')
        }

        const unpriced = reserves.filter((r) => r.price === null)
        const suppliedUsd = sum(reserves.map((r) => r.suppliedUsd))
        const borrowedUsd = sum(reserves.map((r) => r.borrowedUsd))
        const wrapperSuppliedUsd = sum(reserves.filter((r) => r.isWrapper).map((r) => r.suppliedUsd))

        // Every reserve that IS HOLLAR — there is one per market, and summing only the core
        // pool's would understate how much of the supply is market debt.
        const hollarReserves = hollar
          ? reserves.filter((r) => r.asset.toLowerCase() === hollar.token.toLowerCase())
          : []
        const hollarBorrowed = sum(hollarReserves.map((r) => r.borrowed))

        // A facilitator whose address is a HOLLAR aToken IS a money market — that is how the
        // market mints. Naming it from the reserve data rather than from a lookup table means
        // a new market names itself the day it is added, and a removed one stops being named.
        if (hollar) {
          const marketByAToken = new Map(hollarReserves.map((r) => [r.aToken.toLowerCase(), r.market]))
          for (const facilitator of hollar.facilitators) {
            const market = marketByAToken.get(facilitator.address.toLowerCase())
            facilitator.label = facilitator.pallet ?? (market ? `${market} money market (aHOLLAR)` : null)
          }
        }
        const hollarInOmnipool = (omnipool?.assets ?? []).find((a) => a.id === HOLLAR_ID) ?? null

        // The wrong number, kept next to the right one. Publishing the ratio is the only way a
        // reader can tell how badly the obvious read fails. Scaled by the token's own decimals
        // rather than an assumed 18 — the point of this figure is that it is a bad read, and a
        // bad read with a guessed exponent would prove nothing.
        const issuanceMirror = scaled(found.hollarIssuanceRaw, hollar?.decimals ?? null)
        const mirrorRatio =
          issuanceMirror && hollar?.totalSupply && issuanceMirror > 0 ? hollar.totalSupply / issuanceMirror : null

        return {
          fetchedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          contracts: {
            corePool: found.corePool,
            gigaPool: found.gigaPool,
            addressesProvider: found.provider,
            priceOracle: found.oracle,
            poolDataProvider: found.dataProvider,
            hollarToken: found.hollarToken,
            anchorAToken: found.anchorToken,
            borrowingContractStorage: found.borrowingContract,
          },
          totals: {
            marketCount: markets.length,
            reserveCount: reserves.length,
            suppliedUsd,
            borrowedUsd,
            availableUsd: sum(reserves.map((r) => r.availableUsd)),
            utilisation: suppliedUsd && borrowedUsd !== null ? borrowedUsd / suppliedUsd : null,
            wrapperSuppliedUsd,
            wrapperShare: suppliedUsd && wrapperSuppliedUsd !== null ? wrapperSuppliedUsd / suppliedUsd : null,
            wrapperSymbols: reserves.filter((r) => r.isWrapper).map((r) => r.symbol),
            unpricedCount: unpriced.length,
            unpricedSymbols: unpriced.map((r) => r.symbol ?? r.asset),
            unpricedSupplied: unpriced.map((r) => ({ symbol: r.symbol ?? r.asset, supplied: r.supplied })),
            spotPricedSymbols: reserves.filter((r) => r.priceSource && r.priceSource !== 'money-market oracle').map((r) => r.symbol),
            frozenCount: reserves.filter((r) => r.frozen).length,
            noUtilisationCount: reserves.filter((r) => r.utilisation === null).length,
            baseCurrencyUnit: baseUnit,
          },
          markets: markets.map((m) => ({
            label: m.label,
            pool: m.pool,
            reserveCount: m.reserves.length,
            unreadable: m.unreadable,
          })),
          reserves: reserves.sort((a, b) => (b.suppliedUsd ?? -1) - (a.suppliedUsd ?? -1)),
          eModes,
          eModeCeiling: EMODE_CEILING,
          hollar: hollar && {
            ...hollar,
            issuanceMirror,
            mirrorRatio,
            inOmnipool: hollarInOmnipool
              ? { reserve: hollarInOmnipool.reserve, ormlWouldFind: hollarInOmnipool.ormlWouldFind, tvlUsd: hollarInOmnipool.tvlUsd }
              : null,
            reserve: hollarReserves.length
              ? {
                  markets: hollarReserves.map((r) => r.market),
                  supplied: sum(hollarReserves.map((r) => r.supplied)),
                  borrowed: hollarBorrowed,
                  borrowApy: hollarReserves[0].borrowApy,
                  utilisation: hollarReserves[0].utilisation,
                  share: hollar.totalSupply && hollarBorrowed !== null ? hollarBorrowed / hollar.totalSupply : null,
                }
              : null,
          },
          omnipool,
        }
      },
    },
  },
}
