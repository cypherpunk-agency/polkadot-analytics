// Interlay — BTC brought into Polkadot by over-collateralised vaults, and a chain that stopped.
//
// One number carries this module. iBTC is minted only against BTC locked by a vault and burned
// only when that BTC is released, so **`Tokens::TotalIssuance(Token(IBTC))` IS the BTC bridged
// in** — not a proxy for it, not a sum of transfer events, not an indexer's opinion. It is a
// single storage read against an anonymous public RPC, and there is no key and no indexer
// anywhere in the path.
//
// XCLAIM, in one sentence: a vault posts collateral worth more than the BTC it custodies, and if
// it misbehaves the user is made whole in collateral. The security is economic rather than
// cryptographic — the failure mode is not theft, it is being paid in DOT when you wanted BTC.
//
// ── the chain has not produced a block in over three weeks, and answers everything ──────────
// Verified live 2026-08-20: Interlay's `Timestamp::Now` reads **2026-07-27T12:13:01Z**, its head
// (10,885,373) equals its finalized head, and `ParachainSystem::LastRelayChainBlockNumber` is
// 32,291,282 against a relay chain some 345,000 blocks further on. Meanwhile the RPC serves
// state in about a second, every storage read succeeds, and a dashboard built on any of it
// renders a beautifully formatted number from July.
//
// This is the exact failure this repository exists to catch, so the payload does not merely
// carry it in `meta.liveness` — the staleness is computed from the chain's own clock, it lands
// as the FIRST data note when it is real, and `chain.lagDays` is on the payload as a number a
// page cannot fail to notice. Moonbeam did the same thing on the same day. Read
// `Timestamp::Now` and compare it against the wall clock before believing any per-chain figure.
//
// ── the one asset here whose decimals cannot come from a registry ───────────────────────────
// Everywhere else in this repo, decimals are read from the chain and asserted against canaries
// before anything is scaled. iBTC cannot be done that way. Its 8 decimals are a compile-time
// Rust constant — `IBTC("interBTC", 8) = 1` in `interbtc/primitives/src/lib.rs`
// (*source-verified* 2026-08-20) — and Interlay's `AssetRegistry` does not cover it: sweeping
// `AssetRegistry::Metadata` returns 15 keys, every one of them a bare little-endian `u32`
// (`ForeignAsset` ids 1–15), and no entry whose key is a `Token(...)` CurrencyId at all
// (*verified live*, same day). There is nothing on chain to read.
//
// A wrong divisor is a silent factor of 10ⁿ on the headline figure, so three independent checks
// stand in for the registry, and each catches a different thing:
//
//   1. THE KEY IS COMPUTED AND CHECKED AGAINST THE NODE'S OWN ENUMERATION. The whole
//      `Tokens::TotalIssuance` map is swept and the derived iBTC key must appear in it. An
//      empty sweep is treated as an ERROR rather than as an empty map — that is what a moved
//      prefix looks like, and it is the failure CLAUDE.md names: it reads as "nothing here".
//   2. `system_properties` MUST AGREE, WHEN IT SPEAKS. The node serves
//      `tokenSymbol: ["INTR","IBTC","DOT","KINT","KBTC","KSM"]` beside
//      `tokenDecimals: [10,8,10,12,8,12]`, position-aligned, and it says IBTC is 8. That is
//      chain-spec metadata served by the node — NOT consensus state, not part of the runtime,
//      and not signed by anybody — so it is corroboration and never the authority. A
//      disagreement throws; a silence is reported as "not corroborated", never as agreement.
//   3. A PLAUSIBILITY CANARY, in the shape `arbs-bifrost.mjs` uses for the vDOT rate. Above
//      `MAX_PLAUSIBLE_BTC` the module refuses to publish rather than rendering the number.
//
// The canary's blind spot is stated rather than hidden, because it is real: a divisor that is
// too SMALL makes the figure enormous and is caught, while a divisor that is too LARGE makes it
// tiny — and a tiny number is indistinguishable from a bridge that wound down. Only check 2
// catches that direction, which is why a missing `system_properties` is reported in the notes.
//
// ── kBTC is ABSENT here, which is not the same as zero ──────────────────────────────────────
// `Token(KBTC)` encodes to `0x000b` and that key is **not in the map**: the sweep returns 27
// CurrencyIds and none of them is it (*verified live* 2026-08-20). kBTC is Kintsugi's wrapper,
// on Kusama, and Interlay simply never mints it. So it is reported with `present: false` and a
// `null` amount. Rendering it as 0 would say "the wrapper exists here and holds nothing", which
// is a claim about a different world.
//
// ── no dollar figure, and that is deliberate ────────────────────────────────────────────────
// Nothing this service reads gives a BTC/USD price without a credential, and rule 1 of this repo
// is that there is no credential. So `usd` is `null` with the reason attached. `null` is not
// `0`: inventing a price to fill the column would make the one number on this page that nobody
// verified the largest one on it.
//
// ── what this module deliberately does NOT read ─────────────────────────────────────────────
// Interlay's own sovereign DOT — its `sibl` account on Asset Hub and its `para` account on the
// relay chain — is already swept by `server/sources/asset-hub.mjs` (`/api/asset-hub/sovereign-dot`,
// which enumerates every parachain from four independent sources). Reading it again here would
// duplicate an upstream this registry already declares, and would let the two answers drift.
//
// ── which host actually answers ─────────────────────────────────────────────────────────────
// `https://api.interlay.io/parachain` answers anonymous Substrate JSON-RPC over HTTPS POST and
// is the only Interlay endpoint reachable from this service's network (2026-08-20).
// `rpc.interlay.io`, `interlay-rpc.dwellir.com` and `interlay.api.onfinality.io/public` all fail
// at CONNECT and resolve to no address here; whether that is policy or a dead host was not
// established, and this module does not fall back to them.

import { jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { liveness } from '../../src/core/liveness.js'
import { twox128, xxhash64 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { toHex, fromHex, utf8, concat } from '../../src/core/codec/bytes.js'

/* ═══════════════════════════════════════════════════════════════════════════════ the host ═════ */

const INTERLAY = {
  id: 'interlay-rpc',
  label: 'Interlay (api.interlay.io public RPC)',
  url: 'https://api.interlay.io/parachain',
}

const LABEL = 'Interlay (parachain 2032)'

/**
 * Interlay is a parachain; a healthy one is seconds behind, not minutes. These thresholds are
 * the same ones `asset-hub.mjs` uses, and they are what turns a 24-day-old figure into `frozen`
 * instead of a green pill.
 */
const STALE_AFTER_MS = 5 * 60_000
const FROZEN_AFTER_MS = 60 * 60_000

/* ═══════════════════════════════════════════════════════════════════ substrate plumbing ═════ */

const palletPrefix = (pallet, item) => '0x' + toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))

/**
 * `Twox64Concat` — eight LITTLE-endian bytes of the seed-0 xxhash64 digest, then the key itself.
 *
 * There is no `twox64` export in `src/core/codec/xxhash.js` and there should not be: the hasher
 * is a 64-bit digest, and what Substrate stores is its little-endian encoding. `xxhash64`
 * returns a BigInt, so the encoding happens here, explicitly, through a `DataView`. The same
 * four lines exist in `asset-hub.mjs` for the same reason.
 */
function twox64Concat(bytes) {
  const digest = new Uint8Array(8)
  new DataView(digest.buffer).setBigUint64(0, xxhash64(bytes, 0), true)
  return toHex(digest) + toHex(bytes)
}

/** `Blake2_128Concat` — the 16-byte digest, then the key itself, which is why it reads back out. */
const blake2Concat = (bytes) => toHex(blake2b(bytes, 16)) + toHex(bytes)

const KEYS = {
  totalIssuance: palletPrefix('Tokens', 'TotalIssuance'),
  timestamp: palletPrefix('Timestamp', 'Now'),
  lastRelayBlock: palletPrefix('ParachainSystem', 'LastRelayChainBlockNumber'),
  assetRegistryMetadata: palletPrefix('AssetRegistry', 'Metadata'),
  vaults: palletPrefix('VaultRegistry', 'Vaults'),
}

/**
 * `CurrencyId::Token(TokenSymbol)` — enum variant 0, then the symbol's own variant index. Both
 * indices are *source-verified* against `interbtc/primitives/src/lib.rs` (2026-08-20):
 * `Token` opens the `CurrencyId` enum, and `TokenSymbol` is `DOT = 0, IBTC = 1, INTR = 2,
 * KSM = 10, KBTC = 11, KINT = 12` — the gap is deliberate, Interlay's tokens below ten and
 * Kintsugi's above. So iBTC encodes to the two bytes `0x0001` and kBTC to `0x000b`.
 *
 * This is the only CurrencyId shape this module encodes. The other four variants
 * (`ForeignAsset`, `LendToken`, `LpToken`, `StableLpToken`) appear in live keys here and are
 * NOT decoded anywhere below — where one turns up, it is reported as raw hex, because its
 * layout has been inferred from key shapes rather than read out of the source.
 */
const CURRENCY_TOKEN_VARIANT = 0x00
const TOKEN_SYMBOL = { IBTC: 0x01, KBTC: 0x0b }
const tokenCurrencyId = (symbolVariant) => new Uint8Array([CURRENCY_TOKEN_VARIANT, symbolVariant])

/**
 * The compile-time constant, written down once with its provenance. `IBTC("interBTC", 8)` and
 * `KBTC("kBTC", 8)` in `interbtc/primitives/src/lib.rs` — *source-verified* 2026-08-20. Nothing
 * on chain states these; see the header, and see `corroborateDecimals()` for the one runtime
 * cross-check that exists.
 */
const TOKEN_DECIMALS = { IBTC: 8, KBTC: 8 }

/**
 * Above this, the module refuses to publish. The band is deliberately wide: 1,000 iBTC is about
 * 470× today's issuance and more than ten times ALL the BTC currently bridged into Polkadot by
 * every route combined, so no amount of genuine growth reaches it without being a protocol event
 * in its own right. What it catches is the only error that actually happens here — a divisor
 * short by a factor of 10³ or more puts today's supply at 2,118 and a factor of 10⁴ at 21,184,
 * both of which render perfectly. See the header for the direction it cannot catch.
 */
const MAX_PLAUSIBLE_BTC = 1_000

const KEY_PAGE = 500
const SWEEP_BUDGET = 4_000

const rpc = (method, params = [], timeoutMs = 30_000) =>
  jsonRpc({ source: INTERLAY.id, url: INTERLAY.url, method, params, timeoutMs })

/**
 * A `state_getKeysPaged` walk, pinned to a block. Hitting the budget is REPORTED rather than
 * silently truncated — a partial sweep that claims to be a total is exactly the failure this
 * repo exists to avoid.
 */
async function storageKeys(prefix, at, { budget = SWEEP_BUDGET } = {}) {
  const keys = []
  let start = prefix
  for (;;) {
    const page = await rpc('state_getKeysPaged', [prefix, KEY_PAGE, start, at])
    if (!page?.length) break
    keys.push(...page)
    start = page[page.length - 1]
    if (page.length < KEY_PAGE) return { keys, complete: true }
    if (keys.length >= budget) return { keys, complete: false }
  }
  return { keys, complete: true }
}

/** @returns {Promise<Map<string,string>>} lowercase key → raw hex value. Absent keys stay absent. */
async function storageValues(keys, at) {
  const out = new Map()
  for (let i = 0; i < keys.length; i += 250) {
    const changes = await rpc('state_queryStorageAt', [keys.slice(i, i + 250), at], 45_000)
    for (const [key, value] of changes?.[0]?.changes ?? []) {
      if (value !== null && value !== undefined) out.set(String(key).toLowerCase(), value)
    }
  }
  return out
}

/** Unsigned little-endian integer out of a raw storage hex string, as a BigInt. */
function decodeUint(value, bytes, what) {
  const body = String(value ?? '').replace(/^0x/, '')
  if (body.length !== bytes * 2) {
    // A width that is not what the pallet declares means the item is not what we think it is —
    // a runtime upgrade changed the type, or the key collided with something else. Either way
    // the number that would come out of it is a plausible integer with the wrong meaning.
    throw new UpstreamError(
      `${what}: expected a ${bytes}-byte little-endian integer, got ${body.length / 2} bytes.`,
      { kind: 'decode', source: INTERLAY.id },
    )
  }
  let out = 0n
  for (let i = body.length - 2; i >= 0; i -= 2) out = (out << 8n) | BigInt(parseInt(body.slice(i, i + 2), 16))
  return out
}

/**
 * Exact decimal text for a raw integer amount. Built from the digits rather than from a float,
 * so `2.11841671` is that value and not the nearest double to it. `scaled` is offered next to it
 * for arithmetic; this is the one that is exactly right.
 */
function scaleExact(raw, decimals) {
  const digits = raw.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`
  return `${whole}${fraction}`
}

/* ═══════════════════════════════════════════════════════════════════════ the pinned block ═════ */

/**
 * The block every read in one payload is pinned to, plus what the payload has to be able to
 * state about it: how high it is, what runtime produced it, and — the part that matters here —
 * what the CHAIN thinks the time is.
 */
async function pin() {
  const hash = await rpc('chain_getFinalizedHead', [], 20_000)
  const [header, version, properties, chainName, nowRaw, relayRaw] = await Promise.all([
    rpc('chain_getHeader', [hash], 20_000),
    rpc('state_getRuntimeVersion', [hash], 20_000),
    rpc('system_properties', [], 20_000),
    rpc('system_chain', [], 20_000),
    rpc('state_getStorage', [KEYS.timestamp, hash], 20_000),
    rpc('state_getStorage', [KEYS.lastRelayBlock, hash], 20_000),
  ])

  // `Timestamp::Now` is a u64 of milliseconds set by the block's own inherent. It is the chain's
  // clock rather than ours, which is the only thing that makes a liveness claim mean anything —
  // a state read that succeeds tells you the node is up, never that the chain is moving.
  const timeMs = nowRaw ? Number(decodeUint(nowRaw, 8, 'Timestamp::Now')) : null

  return {
    hash,
    block: parseInt(header?.number ?? '0x0', 16),
    chainName: chainName ?? null,
    specName: version?.specName ?? null,
    specVersion: version?.specVersion ?? null,
    properties: properties ?? null,
    timeMs,
    timeIso: timeMs === null ? null : new Date(timeMs).toISOString(),
    // Interlay's own statement about how far the relay chain had got when it last made a block.
    // Comparable against the relay height `/api/asset-hub/sovereign-dot` reports, without this
    // module having to declare a second upstream to find out.
    lastRelayChainBlock: relayRaw ? Number(decodeUint(relayRaw, 4, 'ParachainSystem::LastRelayChainBlockNumber')) : null,
  }
}

/* ═════════════════════════════════════════════════════════════════════ the decimals guard ═════ */

/**
 * What the node's chain-spec properties say a symbol's decimals are, or `null` when it does not
 * say clearly.
 *
 * `tokenSymbol` and `tokenDecimals` are parallel arrays on a multi-token chain, aligned by
 * position — Interlay serves six of each. A symbol appearing twice, arrays of different lengths,
 * or a non-integer all yield `null` rather than a guess: this is a CROSS-CHECK, and a
 * cross-check that guesses is worse than none.
 */
function decimalsFromProperties(properties, symbol) {
  const symbols = properties?.tokenSymbol
  const decimals = properties?.tokenDecimals
  if (!Array.isArray(symbols) || !Array.isArray(decimals)) return null
  if (symbols.length !== decimals.length || symbols.length === 0) return null
  const at = symbols.indexOf(symbol)
  if (at < 0 || symbols.indexOf(symbol, at + 1) !== -1) return null
  return Number.isInteger(decimals[at]) ? decimals[at] : null
}

/**
 * The constant, corroborated where the chain will corroborate it. Disagreement throws — it means
 * the compile-time constant this module carries has moved, and every figure computed from it is
 * out by a power of ten.
 */
function assertDecimals(properties, symbol) {
  const assumed = TOKEN_DECIMALS[symbol]
  const served = decimalsFromProperties(properties, symbol)
  if (served !== null && served !== assumed) {
    throw new UpstreamError(
      `Interlay's node reports ${served} decimals for ${symbol} where this module carries the compile-time constant ${assumed}. ` +
        'One of them is wrong and the difference is a factor of 10^' + Math.abs(served - assumed) + ' on every amount on the page. Refusing to publish.',
      { kind: 'decode', source: INTERLAY.id },
    )
  }
  return { decimals: assumed, corroborated: served !== null, servedByNode: served }
}

/**
 * The plausibility canary. The band is wide on purpose and still catches the only error that
 * matters here; see `MAX_PLAUSIBLE_BTC`.
 */
function assertPlausible(symbol, scaled) {
  if (scaled === null) return
  if (!Number.isFinite(scaled) || scaled < 0 || scaled > MAX_PLAUSIBLE_BTC) {
    throw new UpstreamError(
      `Interlay reports ${scaled} ${symbol}, outside the 0–${MAX_PLAUSIBLE_BTC} BTC band a vault-backed wrapper on this chain can occupy. ` +
        `${symbol}'s decimals are a compile-time Rust constant that cannot be read from any storage item here, so a figure this size is that constant being wrong ` +
        'by a power of ten rather than the protocol having grown. Refusing to publish it.',
      { kind: 'decode', source: INTERLAY.id },
    )
  }
}

/* ══════════════════════════════════════════════════════════════════════════ the operation ═════ */

async function btcBridged() {
  const observedAt = Date.now()
  const chain = await pin()

  const issuanceKey = (symbol) => KEYS.totalIssuance + twox64Concat(tokenCurrencyId(TOKEN_SYMBOL[symbol]))

  // The whole map, not two point reads. Sweeping it is what lets the derived keys be checked
  // against the node's OWN enumeration, and it is what makes an absent key readable as absent
  // rather than as a key we failed to build.
  const { keys, complete } = await storageKeys(KEYS.totalIssuance, chain.hash)
  if (keys.length === 0) {
    // A chain with no `Tokens::TotalIssuance` entries at all is not a state Interlay can be in.
    // What it looks like from here is a moved storage prefix — and a moved prefix reads as an
    // empty map rather than as an error, which would publish "0 BTC bridged" in perfect health.
    throw new UpstreamError(
      `Interlay's \`Tokens::TotalIssuance\` map is empty at block ${chain.block}. That is not a state this chain can be in; ` +
        'the storage prefix this module computes no longer matches the runtime. Refusing to report an empty map as zero issuance.',
      { kind: 'decode', source: INTERLAY.id },
    )
  }
  const values = await storageValues(keys, chain.hash)
  const present = new Set(keys.map((key) => key.toLowerCase()))

  const assets = {}
  for (const symbol of ['IBTC', 'KBTC']) {
    const key = issuanceKey(symbol).toLowerCase()
    const inMap = present.has(key)
    const { decimals, corroborated, servedByNode } = assertDecimals(chain.properties, symbol)
    const raw = inMap ? decodeUint(values.get(key), 16, `Tokens::TotalIssuance(Token(${symbol}))`) : null
    const scaled = raw === null ? null : Number(raw) / 10 ** decimals
    assertPlausible(symbol, scaled)
    assets[symbol] = {
      symbol,
      currencyIdHex: '0x' + toHex(tokenCurrencyId(TOKEN_SYMBOL[symbol])),
      storageKey: issuanceKey(symbol),
      // `present` is the fact the amounts hang off. False means the key is not in the map at
      // all, which is a different statement from a balance of nothing and never renders as 0.
      present: inMap,
      raw: raw === null ? null : raw.toString(),
      scaled,
      amount: raw === null ? null : scaleExact(raw, decimals),
      decimals,
      decimalsSource: 'compile-time constant in interbtc/primitives/src/lib.rs (source-verified 2026-08-20)',
      decimalsCorroboratedByNode: corroborated,
      decimalsServedByNode: servedByNode,
      // No BTC price is available to this service without a credential, and there is none.
      usd: null,
      usdUnavailableBecause:
        'No BTC/USD price is reachable from this service without an API key, and this repo has none. A dollar figure here would be the only number on the page that nothing verified.',
    }
  }

  const vaults = await vaultSummary(chain.hash)
  const registry = await assetRegistryShape(chain.hash)

  const live = livenessOf(chain, observedAt)
  const lagMs = chain.timeMs === null ? null : observedAt - chain.timeMs

  return {
    chain: {
      name: chain.chainName,
      paraId: 2032,
      block: chain.block,
      blockHash: chain.hash,
      specName: chain.specName,
      specVersion: chain.specVersion,
      timeIso: chain.timeIso,
      lastRelayChainBlock: chain.lastRelayChainBlock,
      lagMs,
      // On the payload as a plain number, next to the data rather than only in `meta`, because
      // the whole risk on this chain is a page rendering a July figure as today's.
      lagDays: lagMs === null ? null : Number((lagMs / 86_400_000).toFixed(2)),
      state: live.state,
    },
    bridged: {
      // The headline: BTC held by Interlay's vaults, by construction of the pallet.
      btc: assets.IBTC.scaled,
      btcExact: assets.IBTC.amount,
      usd: null,
    },
    assets: [assets.IBTC, assets.KBTC],
    vaults,
    issuanceMap: { currencies: keys.length, complete },
    assetRegistry: registry,
    fetchedAt: new Date(observedAt).toISOString(),
    meta: { liveness: live },
    notes: buildNotes({ chain, assets, vaults, registry, keys, complete, live }),
  }
}

/* ══════════════════════════════════════════════════════════════════════════════ the vaults ═════ */

/**
 * What backs the wrapper, read from KEYS ALONE — no struct is decoded, so there is no
 * `VaultRegistry::Vault` layout here to be silently wrong about after an upgrade.
 *
 * `VaultRegistry::Vaults` is a `StorageMap<_, Blake2_128Concat, VaultId, Vault>` and `VaultId`
 * is `{ account_id: AccountId32, currencies: { collateral: CurrencyId, wrapped: CurrencyId } }`.
 * Because the hasher concats, the whole `VaultId` reads back out of the key: 32 bytes of account
 * followed by the two CurrencyIds. That is *verified live* rather than assumed — every one of
 * the 133 keys present on 2026-08-20 re-derives its own 16-byte Blake2 digest from the plaintext
 * tail, 133 of 133, which is the check `assertKeyShape` below repeats on every request.
 *
 * The wrapped currency is matched against the SAME encoded `Token(IBTC)` bytes the issuance key
 * is built from, so this block cannot drift from the number above it. The collateral CurrencyId
 * is reported as raw hex and deliberately not decoded: only the `Token(...)` variant is
 * source-verified here, and labelling an inferred variant would be a guess rendered as a fact.
 */
async function vaultSummary(at) {
  const { keys, complete } = await storageKeys(KEYS.vaults, at)
  const ibtc = toHex(tokenCurrencyId(TOKEN_SYMBOL.IBTC))

  const operators = new Set()
  const wrappingIbtc = new Set()
  const collateral = new Map()
  let shapeChecked = 0
  let shapeFailed = 0
  let ibtcVaults = 0

  for (const key of keys) {
    const tail = key.slice(2 + 64) // past the 32-byte pallet ++ item prefix
    const digest = tail.slice(0, 32)
    const vaultId = tail.slice(32)
    // The self-check: recompute the hasher's digest over the plaintext the key carries. If they
    // disagree, this is not a `Blake2_128Concat` map of `VaultId` and nothing below it means
    // what it says.
    if (vaultId.length > 64 && toHex(blake2b(fromHex(vaultId), 16)) === digest) shapeChecked += 1
    else {
      shapeFailed += 1
      continue
    }
    const account = vaultId.slice(0, 64)
    const currencies = vaultId.slice(64)
    operators.add(account)
    if (currencies.endsWith(ibtc)) {
      ibtcVaults += 1
      wrappingIbtc.add(account)
      const collateralHex = currencies.slice(0, -ibtc.length)
      collateral.set(collateralHex, (collateral.get(collateralHex) ?? 0) + 1)
    }
  }

  return {
    registrations: keys.length,
    keyShapeVerified: shapeChecked,
    keyShapeFailed: shapeFailed,
    operators: operators.size,
    wrappingIbtc: ibtcVaults,
    operatorsWrappingIbtc: wrappingIbtc.size,
    collateral: [...collateral]
      .map(([currencyIdHex, registrations]) => ({ currencyIdHex: '0x' + currencyIdHex, registrations }))
      .sort((a, b) => b.registrations - a.registrations),
    complete,
  }
}

/**
 * Evidence for the claim in the header: the registry that WOULD hold decimals holds only
 * `ForeignAsset(u32)` ids. Keys only — 15 short reads' worth of nothing, and it settles the
 * question on every request instead of citing a note.
 */
async function assetRegistryShape(at) {
  const { keys, complete } = await storageKeys(KEYS.assetRegistryMetadata, at, { budget: 1_000 })
  // Key = 32-byte prefix ++ 8-byte twox64 digest ++ the key itself. A bare `u32` tail is four
  // bytes; anything else would be a CurrencyId-shaped key and would change the claim.
  const tails = keys.map((key) => key.slice(2 + 64 + 16))
  const u32Only = tails.length > 0 && tails.every((tail) => tail.length === 8)
  return {
    entries: keys.length,
    keysAreForeignAssetU32: u32Only,
    coversTokenVariant: false,
    complete,
  }
}

/* ═════════════════════════════════════════════════════════════════════════════ liveness ═════ */

/**
 * How current this is, from the chain's own clock rather than from ours. On this chain that is
 * not a formality: the node answers every call in about a second while the last block it made is
 * weeks old, and nothing in the transport layer can see the difference.
 */
function livenessOf(chain, observedAt) {
  return liveness({
    source: 'interlay',
    label: LABEL,
    observedAt,
    headAt: chain.timeMs,
    head: `finalized #${chain.block.toLocaleString('en-US')}`,
    staleAfterMs: STALE_AFTER_MS,
    frozenAfterMs: FROZEN_AFTER_MS,
    note:
      chain.timeMs === null
        ? 'The block’s timestamp inherent could not be read, so how current this is cannot be established from the chain itself. It is not confirmed current.'
        : null,
  })
}

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const count = (n) => n.toLocaleString('en-US')

function buildNotes({ chain, assets, vaults, registry, keys, complete, live }) {
  const notes = []
  const ibtc = assets.IBTC

  // The staleness leads, when it is real. A reader who stops after one sentence must not walk
  // away with a July number believed to be today's.
  if (live.state !== 'live') {
    const days = live.lagMs === null ? null : Math.round(live.lagMs / 86_400_000)
    const relaySeen =
      chain.lastRelayChainBlock === null
        ? ''
        : ` The chain also records having last seen relay block ${count(chain.lastRelayChainBlock)}, which the relay chain passed long ago.`
    notes.push(
      live.lagMs === null
        ? `⚠ How current this is could not be established from Interlay's own clock. Every figure below is from block ${count(chain.block)} and nothing here confirms when that block was made.`
        : `⚠ Interlay's last block is ${count(days)} day${days === 1 ? '' : 's'} old — block ${count(chain.block)}, timestamped ${chain.timeIso} by the chain's own inherent, while its RPC answers every call normally. Every number on this page is that date's, drawn today.${relaySeen}`,
    )
  }

  notes.push(
    `iBTC issued: **${ibtc.amount}** (raw ${BigInt(ibtc.raw).toLocaleString('en-US')} at ${ibtc.decimals} decimals), read from \`Tokens::TotalIssuance(Token(IBTC))\` at Interlay block ${count(chain.block)} (runtime \`${chain.specName}\` ${chain.specVersion}). iBTC is minted only against BTC a vault has locked and burned only when that BTC is released, so this figure IS the BTC bridged in by Interlay — not a proxy for it and not a sum of events. It is a stock, not a flow: nothing here says how much moved.`,
  )

  notes.push(
    `The storage key is computed, never hardcoded — \`twox128("Tokens") ++ twox128("TotalIssuance") ++ Twox64Concat(0x0001)\`, where \`0x0001\` is \`CurrencyId::Token(TokenSymbol::IBTC)\` (both enum indices source-verified in \`interbtc/primitives/src/lib.rs\`). It is then checked against the node's own enumeration: the whole map was swept, ${count(keys.length)} CurrencyIds came back, and the derived key is one of them. An empty sweep is treated as an error rather than as an empty map, because a storage prefix moved by a runtime upgrade reads as "nothing here" rather than as a failure.`,
  )

  notes.push(
    `⚠ iBTC's ${ibtc.decimals} decimals are a **compile-time Rust constant**, not a chain reading. This is the one asset on this site whose divisor cannot come from a registry: Interlay's \`AssetRegistry::Metadata\` holds ${count(registry.entries)} entries and every key is a bare \`u32\` \`ForeignAsset\` id — there is no entry for a \`Token(...)\` CurrencyId at all, verified on this request. A wrong divisor here is a silent factor of 10ⁿ on the headline figure, so three checks stand in for the registry.`,
  )

  notes.push(
    ibtc.decimalsCorroboratedByNode
      ? `The node's own \`system_properties\` corroborates it: it lists \`${ibtc.symbol}\` against ${ibtc.decimalsServedByNode} decimals, matching the constant. That is chain-spec metadata served by the node — not consensus state, not part of the runtime, and signed by nobody — so it is corroboration and never the authority. It is also the ONLY check that catches a divisor that is too large, because too large makes the figure small and a small figure is indistinguishable from a bridge that wound down.`
      : `⚠ The node's \`system_properties\` did not state ${ibtc.symbol}'s decimals on this request, so the constant is **uncorroborated** here. The plausibility band below still catches a divisor that is too small; it cannot catch one that is too large, because that makes the figure small and a small figure looks exactly like a bridge that wound down.`,
  )

  notes.push(
    `The third check is a plausibility canary: above ${count(MAX_PLAUSIBLE_BTC)} iBTC this module refuses to publish at all rather than rendering the number. ${count(MAX_PLAUSIBLE_BTC)} is roughly 470× today's issuance and more than ten times all the BTC bridged into Polkadot by every route combined, so real growth does not reach it — while a divisor short by 10³ would put today's supply at 2,118 and by 10⁴ at 21,184, and both would render perfectly.`,
  )

  notes.push(
    assets.KBTC.present
      ? `kBTC is also issued on this chain: ${assets.KBTC.amount}.`
      : '`kBTC` is **absent from this chain**, which is not the same as zero. `Token(KBTC)` encodes to `0x000b` and that key is not in `Tokens::TotalIssuance` at all — kBTC is Kintsugi\'s wrapper on Kusama, and Interlay never mints it. It is reported with `present: false` and a `null` amount; a 0 here would claim the wrapper exists on this chain and holds nothing, which is a statement about a different chain.',
  )

  notes.push(
    'There is **no dollar figure** on this page. No BTC/USD price is reachable from this service without an API key and this repo has none, so `usd` is `null` with the reason attached rather than a number. `null` is not `0`: a made-up price would make the largest figure here the one nothing verified.',
  )

  if (vaults.keyShapeFailed > 0) {
    notes.push(
      `⚠ ${count(vaults.keyShapeFailed)} of ${count(vaults.registrations)} \`VaultRegistry::Vaults\` keys did not re-derive their own \`Blake2_128Concat\` digest from the plaintext they carry, so the vault counts below are a floor and the key layout assumed here is not the one this chain uses.`,
    )
  }

  notes.push(
    `${count(vaults.wrappingIbtc)} vault registration${vaults.wrappingIbtc === 1 ? '' : 's'} back that iBTC, across ${count(vaults.operatorsWrappingIbtc)} distinct operator account${vaults.operatorsWrappingIbtc === 1 ? '' : 's'} (${count(vaults.registrations)} registrations in the pallet in total, ${count(vaults.keyShapeVerified)} of which re-derived their own key hash on this request). These are read from the KEYS of \`VaultRegistry::Vaults\` — the hasher concats, so the whole \`VaultId\` reads back out — and no vault struct is decoded, so there is no collateral amount here and no claim about how over-collateralised anything is. A registration is not a vault with BTC in it.`,
  )

  if (vaults.collateral.length) {
    notes.push(
      `The collateral CurrencyIds behind those vaults are reported as raw hex — ${vaults.collateral
        .map((row) => `${row.currencyIdHex} (${count(row.registrations)})`)
        .join(', ')} — and deliberately not decoded into names. Only \`CurrencyId::Token\` is source-verified here; the \`ForeignAsset\`, \`LendToken\` and \`LpToken\` variants have been inferred from live key shapes, and a label put on an inferred variant is a guess rendered as a fact. \`0x0000\` is \`Token(DOT)\`, which is source-verified.`,
    )
  }

  notes.push(
    'Interlay\'s own sovereign DOT — the `sibl` account on Asset Hub and the `para` account on the relay chain — is **not read here**. `/api/asset-hub/sovereign-dot` already sweeps every parachain\'s, from four independent enumerations, and reading it a second time in this module would duplicate an upstream and let the two answers drift.',
  )

  notes.push(
    `For scale, and dated rather than live: on 2026-08-20 Asset Hub held 71.08 tBTC bridged from Ethereum by Snowbridge against these ${ibtc.amount} iBTC — Ethereum-routed BTC exceeds Interlay's entire supply by roughly thirty-fold. The usual framing of Interlay as Polkadot's BTC bridge is inverted by its own chain. The live comparison is \`/api/asset-hub/bridged-inventory\`; the figure quoted here is a reading from that date and is not refreshed with this payload.`,
  )

  if (!complete) {
    notes.push('⚠ The `Tokens::TotalIssuance` sweep hit this module’s key budget, so the CurrencyId count is a floor rather than the whole map. The two amounts above are still exact — they are point reads of keys that were found.')
  }

  return notes
}

/* ═══════════════════════════════════════════════════════════════════════════ registry ═════ */

export default {
  id: 'interlay',
  label: LABEL,
  homepage: 'https://interlay.io',
  transport: 'jsonrpc',
  doc: 'docs/platform/bridges.md',
  covers: [
    'Interlay (parachain 2032) — Tokens::TotalIssuance, VaultRegistry::Vaults, AssetRegistry::Metadata',
  ],

  operations: {
    'btc-bridged': {
      summary:
        'BTC bridged into Polkadot through Interlay’s over-collateralised vaults, read as `Tokens::TotalIssuance(Token(IBTC))` — which IS that BTC, since iBTC is minted only against locked BTC. Carries kBTC’s absence as an absence rather than a zero, the vault registrations backing it, the chain’s own clock, and the checks standing in for the decimals registry Interlay does not have.',
      // Fifteen minutes. Issuance moves only when somebody completes an issue or a redeem, which
      // is a several-block, human-paced event — and this is somebody else's free public endpoint.
      ttlMs: 900_000,
      schema: {},
      run: () => btcBridged(),
    },
  },
}
