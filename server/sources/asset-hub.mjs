// Polkadot's own chains, read directly: Asset Hub and the relay chain it hangs off.
//
// This is the first module here that reads Polkadot itself rather than a parachain, an indexer
// or a DEX. It answers three questions that only the chains can answer:
//
//   · WHAT IS BRIDGED IN. `ForeignAssets` is keyed by an XCM `Location`, so the key itself says
//     where an asset came from. Split on `parents`, group by `GlobalConsensus`, and the result
//     is the inventory of everything that entered Polkadot from outside its own consensus.
//   · WHO HOLDS IT. `ForeignAssets::Account` decomposes each bridged supply across the sovereign
//     accounts of the parachains, with the remainder sitting on Asset Hub itself.
//   · WHERE THE DOT IS. `System::Account` against the `para` and `sibl` sovereign accounts, on
//     both chains, because a parachain's DOT holding is the SUM of two accounts on two chains
//     and reading either one alone is wrong by orders of magnitude.
//
// ── `parents == 2` is a RUNTIME GUARANTEE, not a pattern in today's data ────────────────────
// The whole module hangs off "bridged means `parents: 2`". That 34 of today's 52 keys begin
// with `02` is an observation and could be a coincidence of the current registry. The rule was
// therefore read out of the runtime that enforces it (both repositories read 2026-08-20):
//
//   polkadot-fellows/runtimes @ main
//     system-parachains/asset-hubs/asset-hub-polkadot/src/lib.rs
//       impl pallet_assets::Config<ForeignAssetsInstance> {
//         type CreateOrigin = ForeignCreators<(
//           FromSiblingParachain<parachain_info::Pallet<Runtime>, Location>,
//           FromNetwork<UniversalLocation, EthereumNetwork, Location>,
//           KusamaAssetFromAssetHubKusama,
//         ), LocationToAccountId, AccountId, Location>;
//
// Those three are the ONLY permissionless ways a `ForeignAssets` entry can come into existence,
// and each pins `parents` exactly:
//
//   · `FromSiblingParachain` (polkadot-sdk, cumulus/parachains/runtimes/assets/common/src/
//     matching.rs) returns false unless `a.unpack()` is `(1, interior)` whose first junction is
//     `Parachain(id)` with `id != 1000`. Sibling assets are `parents: 1`, structurally.
//   · `FromNetwork` calls `ensure_is_remote(UniversalLocation, a)` (polkadot-sdk, polkadot/xcm/
//     xcm-builder/src/universal_exports.rs). Asset Hub's `UniversalLocation` is
//     `[GlobalConsensus(Polkadot), Parachain(1000)]` — two elements — and `appended_with` strips
//     `parents` of them. At parents 0 or 1 the result still opens with `GlobalConsensus(Polkadot)`,
//     which `ensure_is_remote` rejects as not remote; at parents 3 the append fails outright. Only
//     `parents: 2` leaves the asset's own leading junction in first position, and it must be
//     `GlobalConsensus(n)` with `n != Polkadot`.
//   · `KusamaAssetFromAssetHubKusama` is `RemoteAssetFromLocation<StartsWith<KsmLocation>,
//     AssetHubKusama>` with `KsmLocation = Location::new(2, GlobalConsensus(Kusama))`
//     (asset-hub-polkadot/src/xcm_config.rs), so the asset must START WITH parents 2 and Kusama.
//
// So `parents: 1` ⇔ a sibling parachain's own asset and `parents: 2` ⇔ another consensus system,
// by construction of the runtime rather than by inspection of the registry.
//
// THE ONE ESCAPE HATCH, and the reason this module still checks rather than assumes:
// `type ForceOrigin = AssetsForceOrigin` can `force_create` an arbitrary `Location`, so
// governance is not bound by the three filters above. `classifyBridged()` therefore re-derives
// the invariant on every read — parents 2 must open with `GlobalConsensus(X)`, X must not be
// Polkadot — and reports any key that fails it instead of counting it.
//
// ── two hosts, one module, and why that is not a violation ──────────────────────────────────
// The rule is one module per upstream, and this module names two hostnames. They are one
// upstream in every sense that matters: the same operator's public RPC, the same network, the
// same runtime release (`1.24.1-8ae9775dc43` on both, 2026-08-20), and — decisively — a single
// figure. Post-Asset-Hub-Migration a chain's sovereign DOT is `para` on the relay PLUS `sibl`
// on Asset Hub; splitting that across two modules would mean neither could compute the number
// anybody wants. So: one module, one seam, both hostnames declared here and nowhere else.
//
// ── everything is pinned to one finalized block ─────────────────────────────────────────────
// Every read in an operation is issued with an explicit block hash from `chain_getFinalizedHead`.
// Not tidiness: `bridged-holders` reconciles a sum of ~1,000 holder balances against the asset's
// `supply`, and a transfer landing between the supply read and the holder sweep would break that
// reconciliation for reasons that have nothing to do with a bug. Unpinned, the check would fail
// intermittently and get "fixed" by loosening it, which is how a real discrepancy gets buried.
//
// ── what would silently be wrong, and how each is caught ────────────────────────────────────
//   · WRONG DECIMALS. Read from `Metadata`, never assumed, and asserted against three canaries
//     before any amount is scaled. An asset with no metadata gets `decimals: null` and
//     `supplyScaled: null` — never a raw integer rendered as if it were whole units.
//   · THE WRONG SOVEREIGN PREFIX. `sibl` and `para` accounts BOTH exist on Asset Hub. Sweeping
//     the `para` ones there returns ~20 DOT of existential deposits, renders perfectly, and is
//     off by a factor of half a million. The derivation comes from `src/core/topology.js`,
//     which self-checks against two independently verified addresses at import.
//   · `frozen` ADDED TO `free`. `frozen` is a LOCK ON PART OF `free`, not a separate pot. The
//     spendable-vs-total distinction is real but "held" is `free + reserved`, full stop.
//   · THE `flags` FIELD READ AS A BALANCE. `AccountInfo` ends in a 128-bit `flags` word whose
//     top bit is set; decoded with the pre-2023 `AccountData` schema it comes back as ~1.7e38
//     of something. That is the live Statescan account-index bug. The decoder here consumes
//     exactly 80 bytes and throws otherwise.
//   · SUMMING BY SYMBOL. There are two USDCs on Asset Hub with different issuers, two MYTHs,
//     two NEUROs, two XRTs and two tBTCs. Every asset here is keyed by its location hex and
//     the symbol is a label, never a key.
//   · A CHAIN THE ENUMERATION DID NOT MENTION. See the para-2004 note below.
//
// ── supply is NOT the sum of the accounts, and that is the chain's, not ours ────────────────
// `bridged-holders` reconciles the swept holder balances against `AssetDetails.supply`. Six of
// today's 34 bridged assets do not reconcile — USDC (Snowbridge) short by 11.15, USDT by
// 15.000000, KSM by 0.0910909, ETH by 0.0152193, TRAC by 0.5, and one metadata-less ERC-20 by
// 4e18 raw units. The sign is always the same: supply ABOVE the accounts, never below.
//
// It is not a gap in this read. For all 34 assets the number of holder keys swept equals
// `AssetDetails.accounts`, the pallet's own counter, so the map is read whole. It was then
// settled by probe rather than by argument (2026-08-20):
//
//   · Sampled back through history, the gap moves in STEPS, not as accumulated dust. Snowbridge
//     USDT: 0 at Asset Hub #13,681,483 (2026-03-22), 15.000000 at #16,681,483 (2026-06-05), and
//     15.000000 still today — while supply itself moved by tens of thousands.
//   · Bisected, the whole of that 15.000000 appears in ONE BLOCK: #14,915,236,
//     2026-04-24T06:10:36Z. Across that block `supply` rose 583,285.074178 → 583,300.074178
//     while all 44 holder balances and the account count were UNCHANGED.
//   · The only non-inherent extrinsic in that block is `ParachainSystem::set_validation_data` —
//     the inherent that carries inbound XCM.
//
// So `ForeignAssets` supply can be minted on this chain without any account being credited.
// What inside XCM does it is NOT established here and should not be guessed at. What follows
// for this module is concrete: `Σ ForeignAssets::Account == supply` is not an invariant, the
// residual `supply − Σ sovereign` is therefore reported SPLIT into `onAssetHubAccounts` (real
// holders) and `unaccounted` (in no account at all), and the second is never silently folded
// into the first — doing that would attribute tokens nobody holds to "somebody on Asset Hub".
//
// ── para 2004 (Moonbeam): investigated, and the answer is "deregistered" ────────────────────
// `Paras::ParaLifecycles` on the relay returns 89 ids and 2004 is not among them. Verified live
// on 2026-08-20 at relay #32,635,964, para 2004 is absent from EVERY relay storage item that
// would name a registered para:
//
//     Paras::ParaLifecycles(2004)   null      (89 keys, none of them 2004)
//     Paras::Heads(2004)            null      (90 keys)
//     Paras::CurrentCodeHash(2004)  null      (90 keys)
//     Registrar::Paras(2004)        null      (123 keys — the registration-deposit list)
//     Slots::Leases                 10 keys, none of them 2004
//
// So this is not a lifecycle quirk: the registration itself is gone from this relay chain. What
// is NOT gone is the money and the asset — also verified live the same day:
//
//     relay      System::Account(para 2004)  265.00 free + 50.00 reserved DOT
//     Asset Hub  System::Account(sibl 2004)    0.01 free + 10.20 reserved DOT
//     Asset Hub  ForeignAssets::Asset(Parachain(2004)/PalletInstance(10))  GLMR, supply 0
//
// A payload built from the 89-id enumeration alone would show Moonbeam as absent, and a reader
// would read that as "holds nothing" — while 315 DOT sits in accounts nobody enumerated. It is
// not alone: para 2039 (Integritee, whose TEER is a registered ForeignAsset) is likewise in no
// relay enumeration and holds ~2 DOT across the two legs.
//
// The fix is structural rather than a special case. `sovereign-dot` enumerates from FOUR
// independent sources — `Paras::ParaLifecycles`, `Registrar::Paras`, the sibling para ids named
// by Asset Hub's own `ForeignAssets` keys, and this repo's `topology.js` registry — reports on
// every row WHICH of them produced it, and lists in `missing` the ones the relay's own
// enumeration would have dropped. Nothing is hardcoded; the day Moonbeam re-registers, the row
// simply gains a source.
//
// What is still NOT established: WHY it deregistered, and whether it re-registered under
// another id. `Registrar::NextFreeParaId` is 3443 and nothing in relay state links an id to a
// chain name, so that question cannot be settled from these two endpoints.

import { jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { liveness } from '../../src/core/liveness.js'
import { CHAINS, chainOf, sovereignAccountHex, sovereignAddress, structuralLabel } from '../../src/core/topology.js'
import { twox128, xxhash64 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { encodeSs58 } from '../../src/core/codec/ss58.js'
import { toHex, fromHex, utf8, concat, u32le, leHexToNumber } from '../../src/core/codec/bytes.js'

/* ═══════════════════════════════════════════════════════════════════════════ the two hosts ═════ */

const AH = {
  id: 'asset-hub-rpc',
  label: 'Polkadot Asset Hub (Parity public RPC)',
  url: 'https://polkadot-asset-hub-rpc.polkadot.io',
}

const RELAY = {
  id: 'polkadot-rpc',
  label: 'Polkadot relay chain (Parity public RPC)',
  url: 'https://rpc.polkadot.io',
}

const LABEL = 'Polkadot Asset Hub + relay chain'

/**
 * A chain producing six-second blocks is behind long before the fifteen-minute default. These
 * are the thresholds for "the node we asked is following the chain", not for an indexer.
 */
const STALE_AFTER_MS = 5 * 60_000
const FROZEN_AFTER_MS = 60 * 60_000

/* ═══════════════════════════════════════════════════════════════════ substrate plumbing ═════ */

const palletPrefix = (pallet, item) => '0x' + toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))

/** `Blake2_128Concat` — the 16-byte digest, then the key ITSELF, which is why it reads back out. */
const blake2Concat = (bytes) => toHex(blake2b(bytes, 16)) + toHex(bytes)

/** `Twox64Concat` — eight little-endian bytes of the seed-0 digest, then the key. */
function twox64Concat(bytes) {
  const digest = new Uint8Array(8)
  new DataView(digest.buffer).setBigUint64(0, xxhash64(bytes, 0), true)
  return toHex(digest) + toHex(bytes)
}

const KEYS = {
  foreignAsset: palletPrefix('ForeignAssets', 'Asset'),
  foreignMetadata: palletPrefix('ForeignAssets', 'Metadata'),
  foreignAccount: palletPrefix('ForeignAssets', 'Account'),
  asset: palletPrefix('Assets', 'Asset'),
  metadata: palletPrefix('Assets', 'Metadata'),
  systemAccount: palletPrefix('System', 'Account'),
  totalIssuance: palletPrefix('Balances', 'TotalIssuance'),
  timestamp: palletPrefix('Timestamp', 'Now'),
  paraLifecycles: palletPrefix('Paras', 'ParaLifecycles'),
  registrarParas: palletPrefix('Registrar', 'Paras'),
}

/** `ForeignAssets::Asset(Location)` — the location is appended in plaintext, so it reads back. */
const foreignAssetKey = (locationHex) => KEYS.foreignAsset + blake2Concat(fromHex(locationHex))
const foreignMetadataKey = (locationHex) => KEYS.foreignMetadata + blake2Concat(fromHex(locationHex))

/**
 * `pallet_assets::Account` is a `StorageDoubleMap<Blake2_128Concat AssetId, Blake2_128Concat
 * AccountId>`, so the key is prefix ++ hash(location) ++ location ++ hash(account) ++ account.
 * Both halves concat, which is what makes a sweep under one asset's prefix hand back every
 * holder's account id without a second lookup.
 *
 * Verified live before anything was built on it (2026-08-20): the derived key for
 * `(WETH, sibl 2034)` returned `0x29bc70fc7b13ac0000000000000000000001`, and the same key
 * appears verbatim in a `state_getKeysPaged` sweep of the WETH prefix. The two derivations —
 * ours and the node's — agree byte for byte, and `assertDerivationAgrees()` below re-checks that
 * on every request rather than trusting a note.
 */
const foreignAccountKey = (locationHex, accountHex) =>
  KEYS.foreignAccount + blake2Concat(fromHex(locationHex)) + blake2Concat(fromHex(accountHex))

const localAssetKey = (id) => KEYS.asset + blake2Concat(u32le(id))
const localMetadataKey = (id) => KEYS.metadata + blake2Concat(u32le(id))
const systemAccountKey = (accountHex) => KEYS.systemAccount + blake2Concat(fromHex(accountHex))
const paraKey = (prefix, id) => prefix + twox64Concat(u32le(id))

/** The para id is the concat half of `Twox64Concat`: the last four bytes, little-endian. */
const paraIdFromKey = (key) => leHexToNumber(key.slice(-8))

const KEY_PAGE = 1000
const VALUE_BATCH = 250

/**
 * A `state_getKeysPaged` walk, pinned to a block. `budget` is a real ceiling rather than a
 * politeness: an unbounded sweep of `ForeignAssets::Account` for the wrong asset is 471,736
 * keys, which on a 256 MB container is an OOM rather than a slow page. Hitting it is REPORTED
 * (`complete: false`), never silently truncated, because a partial sweep that claims to be a
 * total is exactly the failure this repo exists to avoid.
 */
async function storageKeys(host, prefix, at, { budget = 8000 } = {}) {
  const keys = []
  let start = prefix
  for (;;) {
    const page = await jsonRpc({
      source: host.id,
      url: host.url,
      method: 'state_getKeysPaged',
      params: [prefix, KEY_PAGE, start, at],
      timeoutMs: 30_000,
    })
    if (!page?.length) break
    keys.push(...page)
    start = page[page.length - 1]
    if (page.length < KEY_PAGE) return { keys, complete: true }
    if (keys.length >= budget) return { keys, complete: false }
  }
  return { keys, complete: true }
}

/** @returns {Promise<Map<string,string>>} lowercase key → raw hex value. Absent keys are absent. */
async function storageValues(host, keys, at) {
  const out = new Map()
  for (let i = 0; i < keys.length; i += VALUE_BATCH) {
    const batch = keys.slice(i, i + VALUE_BATCH)
    const changes = await jsonRpc({
      source: host.id,
      url: host.url,
      method: 'state_queryStorageAt',
      params: [batch, at],
      timeoutMs: 45_000,
    })
    for (const [key, value] of changes?.[0]?.changes ?? []) {
      if (value !== null && value !== undefined) out.set(String(key).toLowerCase(), value)
    }
  }
  return out
}

const storageValue = (host, key, at) =>
  jsonRpc({ source: host.id, url: host.url, method: 'state_getStorage', params: [key, at], timeoutMs: 20_000 })

/**
 * The block every read in one operation is pinned to, plus the two things a payload has to be
 * able to state about it: how high it is and what runtime produced it.
 */
async function pin(host) {
  const hash = await jsonRpc({ source: host.id, url: host.url, method: 'chain_getFinalizedHead', timeoutMs: 20_000 })
  const [header, version, properties, now] = await Promise.all([
    jsonRpc({ source: host.id, url: host.url, method: 'chain_getHeader', params: [hash], timeoutMs: 20_000 }),
    jsonRpc({ source: host.id, url: host.url, method: 'state_getRuntimeVersion', params: [hash], timeoutMs: 20_000 }),
    jsonRpc({ source: host.id, url: host.url, method: 'system_properties', timeoutMs: 20_000 }),
    storageValue(host, KEYS.timestamp, hash),
  ])
  return {
    host,
    hash,
    block: parseInt(header?.number ?? '0x0', 16),
    specName: version?.specName ?? null,
    specVersion: version?.specVersion ?? null,
    // `Timestamp::Now` is a u64 of milliseconds, set by the block's own inherent. It is the
    // chain's clock, not ours, which is what makes a liveness assertion mean anything.
    timeMs: now ? Number(littleEndian(now, 0, 8)) : null,
    tokenSymbol: properties?.tokenSymbol ?? null,
    tokenDecimals: Number.isInteger(properties?.tokenDecimals) ? properties.tokenDecimals : null,
    ss58Format: Number.isInteger(properties?.ss58Format) ? properties.ss58Format : null,
  }
}

/* ═══════════════════════════════════════════════════════════════════════ the SCALE cursor ═════ */

/**
 * A cursor over a SCALE blob that knows how much is left.
 *
 * `done()` is the self-check every decoder in this file ends with. A runtime upgrade that adds
 * a field to `AssetDetails` does not error on its own — it shifts every field after it and
 * yields a supply that is a plausible number with the wrong meaning. Leftover bytes throw.
 */
function scale(hex, what, source) {
  const body = String(hex ?? '').replace(/^0x/, '')
  let at = 0 // nibbles
  const need = (nibbles) => {
    if (at + nibbles > body.length) throw new UpstreamError(`${what}: ran out of bytes`, { kind: 'decode', source })
  }
  const api = {
    /** unsigned little-endian integer of `bytes` width, as a BigInt */
    big(bytes) {
      need(bytes * 2)
      const value = littleEndian(body, at / 2, bytes)
      at += bytes * 2
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
    /**
     * SCALE compact, as a BigInt. Deliberately not `src/core/codec/scale.js#decodeCompact`,
     * which returns a Number: `GeneralIndex` is a `Compact<u128>` and an asset id above 2^53
     * would come back rounded and look entirely reasonable.
     */
    compact() {
      need(2)
      const first = parseInt(body.slice(at, at + 2), 16)
      const mode = first & 3
      if (mode === 0) {
        at += 2
        return BigInt(first >> 2)
      }
      if (mode === 1) {
        need(4)
        const value = littleEndian(body, at / 2, 2)
        at += 4
        return value >> 2n
      }
      if (mode === 2) {
        need(8)
        const value = littleEndian(body, at / 2, 4)
        at += 8
        return value >> 2n
      }
      const width = (first >> 2) + 4
      at += 2
      need(width * 2)
      const value = littleEndian(body, at / 2, width)
      at += width * 2
      return value
    },
    bool() {
      const byte = api.u(1)
      if (byte > 1) throw new UpstreamError(`${what}: ${byte} is not a bool`, { kind: 'decode', source })
      return byte === 1
    },
    text() {
      const length = Number(api.compact())
      if (length > 1024) throw new UpstreamError(`${what}: a ${length}-byte string is not a name`, { kind: 'decode', source })
      return new TextDecoder().decode(fromHex(api.bytes(length)))
    },
    left: () => (body.length - at) / 2,
    done() {
      if (at !== body.length) {
        throw new UpstreamError(
          `${what}: left ${(body.length - at) / 2} byte(s) undecoded — the runtime layout has changed. Refusing to publish a reading of a structure we no longer understand.`,
          { kind: 'decode', source },
        )
      }
    },
  }
  return api
}

/** A fixed-width little-endian unsigned integer read straight out of a hex STRING. */
function littleEndian(hex, byteOffset, byteLength) {
  const body = String(hex ?? '').replace(/^0x/, '')
  let value = 0n
  for (let i = (byteOffset + byteLength) * 2 - 2; i >= byteOffset * 2; i -= 2) {
    value = value * 256n + BigInt(parseInt(body.slice(i, i + 2), 16))
  }
  return value
}

/* ════════════════════════════════════════════════════════════════════ the XCM Location ═════ */

/**
 * `NetworkId`, and the reason its indices are written out one by one rather than as an array:
 * variants 4, 5 and 6 (Westend, Rococo, Wococo) were REMOVED and the ones after them were NOT
 * renumbered. An array literal would map `Ethereum` to 4 and silently relabel every bridged
 * Ethereum asset as a Westend one.
 */
const NETWORK_ID = {
  0: (r) => ({ name: 'ByGenesis', genesis: `0x${r.bytes(32)}` }),
  1: (r) => ({ name: 'ByFork', blockNumber: String(r.big(8)), blockHash: `0x${r.bytes(32)}` }),
  2: () => ({ name: 'Polkadot' }),
  3: () => ({ name: 'Kusama' }),
  7: (r) => ({ name: 'Ethereum', chainId: String(r.compact()) }),
  8: () => ({ name: 'BitcoinCore' }),
  9: () => ({ name: 'BitcoinCash' }),
  10: () => ({ name: 'PolkadotBulletin' }),
}

const REMOVED_NETWORK_ID = { 4: 'Westend', 5: 'Rococo', 6: 'Wococo' }

function decodeNetworkId(r, source) {
  const index = r.u(1)
  const removed = REMOVED_NETWORK_ID[index]
  if (removed) {
    throw new UpstreamError(
      `Location: NetworkId variant ${index} (${removed}) was removed from XCM and the later variants were not renumbered. A key carrying it means this decoder's variant table is wrong.`,
      { kind: 'decode', source },
    )
  }
  const decode = NETWORK_ID[index]
  if (!decode) throw new UpstreamError(`Location: unknown NetworkId variant ${index}`, { kind: 'decode', source })
  return decode(r)
}

/** `BodyId` and `BodyPart`, for `Plurality`. No live key on Asset Hub uses them (2026-08-20). */
const BODY_ID = {
  0: () => ({ name: 'Unit' }),
  1: (r) => ({ name: 'Moniker', moniker: `0x${r.bytes(4)}` }),
  2: (r) => ({ name: 'Index', index: String(r.compact()) }),
  3: () => ({ name: 'Executive' }),
  4: () => ({ name: 'Technical' }),
  5: () => ({ name: 'Legislative' }),
  6: () => ({ name: 'Judicial' }),
  7: () => ({ name: 'Defense' }),
  8: () => ({ name: 'Administration' }),
  9: () => ({ name: 'Treasury' }),
}

const BODY_PART = {
  0: () => ({ name: 'Voice' }),
  1: (r) => ({ name: 'Members', count: String(r.compact()) }),
  2: (r) => ({ name: 'Fraction', nom: String(r.compact()), denom: String(r.compact()) }),
  3: (r) => ({ name: 'AtLeastProportion', nom: String(r.compact()), denom: String(r.compact()) }),
  4: (r) => ({ name: 'MoreThanProportion', nom: String(r.compact()), denom: String(r.compact()) }),
}

const variant = (table, r, what, source) => {
  const index = r.u(1)
  const decode = table[index]
  if (!decode) throw new UpstreamError(`Location: unknown ${what} variant ${index}`, { kind: 'decode', source })
  return decode(r)
}

/** `Option<NetworkId>` — one byte of discriminant, then the network if there is one. */
const optionalNetwork = (r, source) => (r.bool() ? decodeNetworkId(r, source) : null)

const JUNCTION = {
  0: (r) => ({ type: 'Parachain', paraId: Number(r.compact()) }),
  1: (r, source) => ({ type: 'AccountId32', network: optionalNetwork(r, source), id: `0x${r.bytes(32)}` }),
  2: (r, source) => ({ type: 'AccountIndex64', network: optionalNetwork(r, source), index: String(r.compact()) }),
  3: (r, source) => ({ type: 'AccountKey20', network: optionalNetwork(r, source), key: `0x${r.bytes(20)}` }),
  4: (r) => ({ type: 'PalletInstance', index: r.u(1) }),
  5: (r) => ({ type: 'GeneralIndex', index: String(r.compact()) }),
  6: (r) => {
    // `GeneralKey { length: u8, data: [u8; 32] }` — the data is ALWAYS 32 bytes on the wire and
    // `length` says how much of it is meaningful. Reading only `length` bytes desynchronises
    // the cursor and every junction after it decodes as garbage.
    const length = r.u(1)
    const data = r.bytes(32)
    if (length > 32) throw new UpstreamError(`Location: GeneralKey length ${length} exceeds its 32-byte buffer`, { kind: 'decode', source: AH.id })
    return { type: 'GeneralKey', length, data: `0x${data.slice(0, length * 2)}` }
  },
  7: () => ({ type: 'OnlyChild' }),
  8: (r, source) => ({ type: 'Plurality', id: variant(BODY_ID, r, 'BodyId', source), part: variant(BODY_PART, r, 'BodyPart', source) }),
  9: (r, source) => ({ type: 'GlobalConsensus', network: decodeNetworkId(r, source) }),
}

/**
 * An XCM `Location`, decoded to exactly its own length.
 *
 *   Location  { parents: u8, interior: Junctions }
 *   Junctions enum { Here = 0, X1 = 1, … X8 = 8 } — the VARIANT INDEX IS THE JUNCTION COUNT,
 *             and the junctions follow as a fixed-size array with no length prefix of its own.
 *
 * @param {string} hex the plaintext location tail of a `ForeignAssets` storage key
 */
function decodeLocation(hex, source = AH.id) {
  const r = scale(hex, 'Location', source)
  const parents = r.u(1)
  const count = r.u(1)
  if (count > 8) throw new UpstreamError(`Location: Junctions variant ${count} is not one of Here…X8`, { kind: 'decode', source })
  const interior = []
  for (let i = 0; i < count; i += 1) {
    const index = r.u(1)
    const decode = JUNCTION[index]
    if (!decode) throw new UpstreamError(`Location: unknown Junction variant ${index}`, { kind: 'decode', source })
    interior.push(decode(r, source))
  }
  r.done()
  return { parents, interior }
}

const shortHex = (hex) => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex)

const networkText = (network) =>
  !network ? 'null' : network.name === 'Ethereum' ? `Ethereum{${network.chainId}}` : network.name === 'ByGenesis' ? `ByGenesis(${shortHex(network.genesis)})` : network.name

function junctionText(junction) {
  switch (junction.type) {
    case 'Parachain':
      return `Parachain(${junction.paraId})`
    case 'AccountKey20':
      return `AccountKey20(${shortHex(junction.key)})`
    case 'AccountId32':
      return `AccountId32(${shortHex(junction.id)})`
    case 'PalletInstance':
      return `PalletInstance(${junction.index})`
    case 'GeneralIndex':
      return `GeneralIndex(${junction.index})`
    case 'GeneralKey':
      return `GeneralKey(${junction.data})`
    case 'GlobalConsensus':
      return `GlobalConsensus(${networkText(junction.network)})`
    default:
      return junction.type
  }
}

/** One line a reader can check against a block explorer, never parsed by anything. */
const locationText = (location) =>
  !location ? null : `{parents: ${location.parents}, ${location.interior.length ? `X${location.interior.length}(${location.interior.map(junctionText).join(', ')})` : 'Here'}}`

/**
 * The consensus system an asset came from, as a stable key to group by.
 *
 * Only meaningful for `parents === 2`. Inside Polkadot's own consensus the answer is "Polkadot",
 * which is not a bridge and must not be grouped as one.
 */
function globalConsensusOf(location) {
  const junction = location?.interior?.find((j) => j.type === 'GlobalConsensus')
  if (!junction) return null
  const network = junction.network
  const key = network.name === 'Ethereum' ? `ethereum:${network.chainId}` : network.name === 'ByGenesis' ? `bygenesis:${network.genesis}` : network.name.toLowerCase()
  const label = network.name === 'Ethereum' ? (network.chainId === '1' ? 'Ethereum mainnet' : `Ethereum chain ${network.chainId}`) : network.name
  return { key, label, ...network }
}

/* ═══════════════════════════════════════════════════════════════════ pallet-assets values ═════ */

const ASSET_STATUS = ['Live', 'Frozen', 'Destroying']
const ACCOUNT_STATUS = ['Liquid', 'Frozen', 'Blocked']

/**
 * `pallet_assets::AssetDetails` — 190 bytes on Asset Hub today, and every one of them consumed.
 *
 *   owner/issuer/admin/freezer  4 × AccountId32           bytes   0..128
 *   supply                      u128                      bytes 128..144
 *   deposit                     u128                      bytes 144..160
 *   min_balance                 u128                      bytes 160..176
 *   is_sufficient               bool                      byte  176
 *   accounts / sufficients / approvals   3 × u32          bytes 177..189
 *   status                      AssetStatus               byte  189
 *
 * The four leading accounts matter beyond padding: for `Assets::Asset(1337)` they are Circle's
 * accounts, which is the on-chain evidence that USDC on Asset Hub is issued rather than wrapped.
 */
function decodeAssetDetails(hex, source) {
  const r = scale(hex, 'AssetDetails', source)
  const owner = `0x${r.bytes(32)}`
  const issuer = `0x${r.bytes(32)}`
  const admin = `0x${r.bytes(32)}`
  const freezer = `0x${r.bytes(32)}`
  const supply = r.big(16)
  const deposit = r.big(16)
  const minBalance = r.big(16)
  const isSufficient = r.bool()
  const accounts = r.u(4)
  const sufficients = r.u(4)
  const approvals = r.u(4)
  const statusIndex = r.u(1)
  r.done()
  return {
    owner,
    issuer,
    admin,
    freezer,
    supply,
    deposit,
    minBalance,
    isSufficient,
    accounts,
    sufficients,
    approvals,
    status: ASSET_STATUS[statusIndex] ?? `status-${statusIndex}`,
  }
}

/** `pallet_assets::AssetMetadata` — deposit, name, symbol, decimals, is_frozen. */
function decodeAssetMetadata(hex, source) {
  const r = scale(hex, 'AssetMetadata', source)
  r.big(16) // deposit
  const name = r.text()
  const symbol = r.text()
  const decimals = r.u(1)
  const isFrozen = r.bool()
  r.done()
  return { name, symbol, decimals, isFrozen }
}

/**
 * `pallet_assets::AssetAccount` — balance, status, existence reason, extra.
 *
 * NOT a fixed width: `ExistenceReason::DepositHeld(Balance)` carries 16 more bytes and
 * `DepositFrom(AccountId, Balance)` carries 48. Eighteen bytes is merely what `Sufficient` and
 * `Consumer` happen to encode to; a decoder that asserted 18 would throw on the first
 * deposit-held holder it met.
 */
const EXISTENCE_REASON = {
  0: () => ({ reason: 'Consumer' }),
  1: () => ({ reason: 'Sufficient' }),
  2: (r) => ({ reason: 'DepositHeld', deposit: String(r.big(16)) }),
  3: () => ({ reason: 'DepositRefunded' }),
  4: (r) => ({ reason: 'DepositFrom', depositor: `0x${r.bytes(32)}`, deposit: String(r.big(16)) }),
}

function decodeAssetAccount(hex, source) {
  const r = scale(hex, 'AssetAccount', source)
  const balance = r.big(16)
  const statusIndex = r.u(1)
  const reason = variant(EXISTENCE_REASON, r, 'ExistenceReason', source)
  r.done()
  return { balance, status: ACCOUNT_STATUS[statusIndex] ?? `status-${statusIndex}`, ...reason }
}

/**
 * `frame_system::AccountInfo` — exactly 80 bytes, and the last 16 are the trap.
 *
 *   nonce / consumers / providers / sufficients   4 × u32   bytes  0..16
 *   free                                          u128      bytes 16..32
 *   reserved                                      u128      bytes 32..48
 *   frozen                                        u128      bytes 48..64
 *   flags                                         u128      bytes 64..80
 *
 * `flags` is `ExtraFlags`, whose top bit is set — `0x80000000000000000000000000000000`, verified
 * live on Hydration's sibling account. Decoded with the pre-2023 `AccountData { free, reserved,
 * misc_frozen, fee_frozen }` schema it lands where a balance is expected and reads as 1.7e38.
 * That is not hypothetical: it is what Statescan's public account index currently shows.
 *
 * `frozen` is a LOCK ON PART OF `free`, not a fourth pot. `free + reserved` is what the account
 * holds; `free - frozen` is what it could spend. Adding `frozen` double-counts.
 */
function decodeAccountInfo(hex, source) {
  const r = scale(hex, 'AccountInfo', source)
  const nonce = r.u(4)
  const consumers = r.u(4)
  const providers = r.u(4)
  const sufficients = r.u(4)
  const free = r.big(16)
  const reserved = r.big(16)
  const frozen = r.big(16)
  const flags = r.big(16)
  r.done()
  return { nonce, consumers, providers, sufficients, free, reserved, frozen, flags }
}

/** Whole units, or `null` when nothing on chain says how many decimals. Never 0. */
function scaled(raw, decimals) {
  if (raw === null || raw === undefined) return null
  if (decimals === null || decimals === undefined) return null
  return Number(raw) / 10 ** decimals
}

const asString = (value) => (value === null || value === undefined ? null : String(value))

/* ══════════════════════════════════════════════════════════════════════════════ canaries ═════ */

/**
 * Three facts checked before ANY amount on the page is scaled, in the same spirit as
 * `arbs-hydration.mjs`'s registry self-check. Each one fails a different way silently:
 *
 *   1337 → USDC / 6   a wrong `Assets::Metadata` layout puts a byte from `name` where
 *                     `decimals` should be, and every stablecoin figure moves by 10ⁿ.
 *   1984 → USDt / 6   NOTE the lowercase `t`. The chain says `USDt`; a great deal of writing
 *                     about Asset Hub, including the brief this module was built from, says
 *                     `USDT`. Asserting the wrong spelling here would fail the whole page for
 *                     a cosmetic reason, so the assertion is case-insensitive and the exact
 *                     spelling is REPORTED instead.
 *   WETH              a location that must be present in `ForeignAssets` and must decode to
 *                     `parents: 2 / GlobalConsensus(Ethereum{1}) / AccountKey20(0xC02aaA…)`.
 *                     If the location decoder drifts, this is the first thing to break.
 */
const LOCAL_CANARIES = [
  { id: 1337, symbol: 'USDC', decimals: 6 },
  { id: 1984, symbol: 'USDT', decimals: 6 },
]

const WETH_LOCATION = '02020907040300c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

function assertLocationDecoder() {
  const weth = decodeLocation(WETH_LOCATION)
  const consensus = globalConsensusOf(weth)
  const key20 = weth.interior.find((j) => j.type === 'AccountKey20')
  const ok =
    weth.parents === 2 &&
    weth.interior.length === 2 &&
    consensus?.key === 'ethereum:1' &&
    key20?.key === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  if (!ok) {
    throw new UpstreamError(
      `the XCM Location decoder no longer reproduces the WETH key: ${locationText(weth)}. Every asset on this page is grouped by the network that decoder names, so nothing here can be published.`,
      { kind: 'decode', source: AH.id },
    )
  }
}

/**
 * The derivation self-check that costs nothing: for every holder key the node handed back, the
 * key we would have DERIVED for that (location, account) pair must be the same bytes. It proves
 * the double-map construction on live data on every request, and it is the check that would
 * have caught a `Twox64Concat` second hasher — which returns null for every derived key and
 * reads exactly like "no parachain holds any of this".
 */
function assertDerivationAgrees(locationHex, sweptKeys) {
  for (const key of sweptKeys) {
    const accountHex = `0x${key.slice(-64)}`
    const derived = foreignAccountKey(locationHex, accountHex)
    if (derived.toLowerCase() !== key.toLowerCase()) {
      throw new UpstreamError(
        `the ForeignAssets::Account key derivation disagrees with the node: derived ${derived} for account ${accountHex} under ${locationHex}, the node stores ${key}. Every per-chain balance on this page is read with that derivation.`,
        { kind: 'decode', source: AH.id },
      )
    }
  }
}

/* ══════════════════════════════════════════════════════════ the ForeignAssets inventory ═════ */

/**
 * Every entry in `ForeignAssets`, with its location decoded out of the key.
 *
 * The whole read is four requests for 52 assets, and that is a property of `Blake2_128Concat`:
 * the hasher appends the key in plaintext, so one `state_getKeysPaged` sweep returns every
 * asset's full identity. There is no reverse map on chain and none is needed.
 */
async function foreignAssets(chain) {
  const { keys, complete } = await storageKeys(AH, KEYS.foreignAsset, chain.hash, { budget: 4000 })
  const locations = keys.map((key) => key.slice(2 + 64 + 32))

  const [details, metadata] = await Promise.all([
    storageValues(AH, keys, chain.hash),
    storageValues(AH, locations.map(foreignMetadataKey), chain.hash),
  ])

  const rows = locations.map((locationHex) => {
    let location = null
    let decodeError = null
    try {
      location = decodeLocation(locationHex)
    } catch (error) {
      // `null`, not a guess. `parents` is byte zero and stays readable, so the asset can still
      // be classified; what we lose is which consensus system it came from, and we say so.
      decodeError = error.message
    }

    const rawDetails = details.get(foreignAssetKey(locationHex).toLowerCase()) ?? null
    const rawMetadata = metadata.get(foreignMetadataKey(locationHex).toLowerCase()) ?? null
    const decoded = rawDetails ? decodeAssetDetails(rawDetails, AH.id) : null
    const meta = rawMetadata ? decodeAssetMetadata(rawMetadata, AH.id) : null

    const parents = parseInt(locationHex.slice(0, 2), 16)
    const consensus = location ? globalConsensusOf(location) : null

    return {
      locationHex: `0x${locationHex}`,
      location,
      locationText: locationText(location),
      locationDecodeError: decodeError,
      parents,
      // `parents === 2` means "up past the relay chain", i.e. out of Polkadot's consensus
      // system. It is the whole discriminator, and it is EXACT rather than a heuristic — see
      // `classifyBridged()`.
      isBridged: parents === 2,
      network: consensus?.key ?? null,
      networkLabel: consensus?.label ?? null,
      siblingParaId: location?.interior?.find((j) => j.type === 'Parachain')?.paraId ?? null,
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      decimals: meta?.decimals ?? null,
      metadataFrozen: meta?.isFrozen ?? null,
      hasMetadata: Boolean(meta),
      supply: asString(decoded?.supply),
      supplyScaled: scaled(decoded?.supply ?? null, meta?.decimals ?? null),
      minBalance: asString(decoded?.minBalance),
      isSufficient: decoded?.isSufficient ?? null,
      accounts: decoded?.accounts ?? null,
      sufficients: decoded?.sufficients ?? null,
      approvals: decoded?.approvals ?? null,
      status: decoded?.status ?? null,
      owner: decoded?.owner ?? null,
      issuer: decoded?.issuer ?? null,
    }
  })

  return { rows, complete }
}

/**
 * The `parents === 2` discriminator, re-derived on every read.
 *
 * The rule itself is a runtime guarantee — see the `CreateOrigin` note at the top of this file:
 * `FromSiblingParachain` admits only `parents: 1`, and both `FromNetwork` and
 * `KusamaAssetFromAssetHubKusama` admit only `parents: 2` opening with `GlobalConsensus(X)`,
 * X ≠ Polkadot. That is a property of the code that creates these entries, not of the entries
 * that happen to exist today.
 *
 * It is checked here anyway, because `ForceOrigin` (governance) is not bound by those filters
 * and could `force_create` any location at all. All 34 of today's bridged keys satisfy both
 * halves; anything that does not is reported as an anomaly rather than quietly counted.
 */
function classifyBridged(rows) {
  const bridged = []
  const sibling = []
  const anomalies = []
  for (const row of rows) {
    if (!row.isBridged) {
      sibling.push(row)
      continue
    }
    const first = row.location?.interior?.[0]
    if (row.locationDecodeError) {
      anomalies.push({ locationHex: row.locationHex, why: `parents is 2 but the interior could not be decoded: ${row.locationDecodeError}` })
    } else if (first?.type !== 'GlobalConsensus') {
      anomalies.push({ locationHex: row.locationHex, why: `parents is 2 but the first junction is ${first?.type ?? 'nothing'}, not GlobalConsensus` })
    } else if (first.network?.name === 'Polkadot') {
      anomalies.push({ locationHex: row.locationHex, why: 'parents is 2 with GlobalConsensus(Polkadot) — a path out of Polkadot and back into it, which is not a bridge' })
    }
    bridged.push(row)
  }
  return { bridged, sibling, anomalies }
}

/**
 * The two locally-issued stablecoins, in their own block because their provenance is different
 * in kind. Asset 1337 is USDC issued by Circle and asset 1984 is USDt issued by Tether, both
 * directly on Asset Hub: there is no wrapper, no bridge and no custodian, and the owner/issuer
 * fields in `Assets::Asset` are the issuer's own accounts.
 *
 * This matters because Ethereum's USDC is ALSO on Asset Hub, in `ForeignAssets`, under
 * `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`. Two assets, both called USDC, both six
 * decimals, different ids, different provenance, and adding them together is wrong.
 */
async function localStables(chain) {
  const ids = LOCAL_CANARIES.map((c) => c.id)
  const [details, metadata] = await Promise.all([
    storageValues(AH, ids.map(localAssetKey), chain.hash),
    storageValues(AH, ids.map(localMetadataKey), chain.hash),
  ])

  const rows = ids.map((id) => {
    const rawDetails = details.get(localAssetKey(id).toLowerCase()) ?? null
    const rawMetadata = metadata.get(localMetadataKey(id).toLowerCase()) ?? null
    const decoded = rawDetails ? decodeAssetDetails(rawDetails, AH.id) : null
    const meta = rawMetadata ? decodeAssetMetadata(rawMetadata, AH.id) : null
    return {
      assetId: id,
      pallet: 'Assets',
      symbol: meta?.symbol ?? null,
      name: meta?.name ?? null,
      decimals: meta?.decimals ?? null,
      supply: asString(decoded?.supply),
      supplyScaled: scaled(decoded?.supply ?? null, meta?.decimals ?? null),
      accounts: decoded?.accounts ?? null,
      isSufficient: decoded?.isSufficient ?? null,
      status: decoded?.status ?? null,
      owner: decoded?.owner ?? null,
      issuer: decoded?.issuer ?? null,
      ownerAddress: decoded?.owner ? encodeSs58(fromHex(decoded.owner), chain.ss58Format ?? 0) : null,
      isBridged: false,
      provenance: 'issued directly on Asset Hub by the issuer named in owner/issuer — not wrapped, not bridged',
    }
  })

  // The canary. Everything scaled below this line depends on `Assets::Metadata` decoding the
  // way we think it does, so it is checked here rather than trusted.
  for (const canary of LOCAL_CANARIES) {
    const got = rows.find((row) => row.assetId === canary.id)
    const symbolOk = String(got?.symbol ?? '').toUpperCase() === canary.symbol
    if (!got || !symbolOk || got.decimals !== canary.decimals) {
      throw new UpstreamError(
        `Assets self-check failed: asset ${canary.id} decoded as ${got ? `${got.symbol}/${got.decimals}` : 'missing'}, expected ${canary.symbol}/${canary.decimals}. Refusing to publish amounts scaled by a layout we no longer understand.`,
        { kind: 'decode', source: AH.id },
      )
    }
  }

  return rows
}

/* ═══════════════════════════════════════════════════════════════════ operation: inventory ═════ */

async function bridgedInventory() {
  assertLocationDecoder()
  const chain = await pin(AH)
  const [{ rows, complete }, stables] = await Promise.all([foreignAssets(chain), localStables(chain)])
  const { bridged, sibling, anomalies } = classifyBridged(rows)

  const wethPresent = bridged.some((row) => row.locationHex === `0x${WETH_LOCATION}`)
  if (!wethPresent) {
    throw new UpstreamError(
      'the WETH location 0x…c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 is not in ForeignAssets. It is this module’s canary for the Snowbridge registry being readable at all; without it the bridged inventory below cannot be trusted to be an inventory.',
      { kind: 'upstream', source: AH.id },
    )
  }

  const networks = new Map()
  for (const row of bridged) {
    const key = row.network ?? 'undecoded'
    const group = networks.get(key) ?? { network: key, label: row.networkLabel ?? 'could not be decoded', assets: 0, withSupply: 0, unscaled: 0, symbols: [] }
    group.assets += 1
    if (row.supply !== null && row.supply !== '0') group.withSupply += 1
    if (row.supplyScaled === null) group.unscaled += 1
    if (row.symbol) group.symbols.push(row.symbol)
    networks.set(key, group)
  }

  const unscaled = bridged.filter((row) => row.supplyScaled === null)
  const duplicateSymbols = [...new Map(rows.filter((r) => r.symbol).map((r) => [r.symbol, r])).keys()].filter(
    (symbol) => rows.filter((row) => row.symbol === symbol).length > 1,
  )

  return {
    chain: chainMeta(chain),
    bridged: bridged.sort(bySupply),
    sibling: sibling.sort(bySupply),
    localStables: stables,
    networks: [...networks.values()].sort((a, b) => b.assets - a.assets),
    counts: {
      foreignAssets: rows.length,
      bridged: bridged.length,
      sibling: sibling.length,
      withoutMetadata: rows.filter((row) => !row.hasMetadata).length,
      undecodableLocations: rows.filter((row) => row.locationDecodeError).length,
      localStables: stables.length,
    },
    anomalies,
    duplicateSymbols,
    complete,
    fetchedAt: new Date().toISOString(),
    meta: { liveness: livenessOf(chain, null) },
    notes: inventoryNotes({ chain, rows, bridged, sibling, stables, unscaled, anomalies, duplicateSymbols, complete }),
  }
}

const bySupply = (a, b) => (b.supplyScaled ?? -1) - (a.supplyScaled ?? -1)

const chainMeta = (chain) => ({
  chain: chain === null ? null : chain.host === AH ? 'Polkadot Asset Hub' : 'Polkadot relay chain',
  block: chain.block,
  blockHash: chain.hash,
  specName: chain.specName,
  specVersion: chain.specVersion,
  blockTime: chain.timeMs === null ? null : new Date(chain.timeMs).toISOString(),
  tokenSymbol: chain.tokenSymbol,
  tokenDecimals: chain.tokenDecimals,
})

/* ═══════════════════════════════════════════════════════════════════ operation: holders ═════ */

/**
 * The per-chain decomposition of every bridged supply.
 *
 * The method is a full sweep of `ForeignAssets::Account` under each bridged location rather than
 * a derived read per (asset, para) pair, and that choice is the whole point: a sweep returns
 * EVERY holder, so the decomposition can be reconciled against `supply` instead of merely
 * asserted to sum by construction. `Σ holders == supply` is a real check on the decoder, on the
 * key derivation and on the pinning, and it is the check that catches a mistake none of the
 * others would.
 *
 * The sovereign rows are then the holders whose account bytes begin with `sibl`, identified by
 * `structuralLabel()` from the account itself — no name lookup, no list to fall out of date.
 *
 * ── the shape, and why it is flat ─────────────────────────────────────────────────────────
 * `holdings` is ONE ROW PER (chain, asset), each row self-contained and each row carrying the
 * block and timestamp it was read at. The reason is not this page — a page can group a flat
 * list in three lines — it is that this decomposition, snapshotted daily, IS a netflow series:
 * per chain, per token, including bridged assets. A row that is already the record a store
 * would keep needs no reshaping to become one, and reshaping is where a schema drifts. The
 * nested `assets` array below carries only what is genuinely per-asset: the supply and the
 * reconciliation.
 */
async function bridgedHolders() {
  assertLocationDecoder()
  const chain = await pin(AH)
  const { rows } = await foreignAssets(chain)
  const { bridged } = classifyBridged(rows)

  const assets = []
  const holdings = []
  const observedAt = new Date().toISOString()
  for (const asset of bridged) {
    const locationHex = asset.locationHex.replace(/^0x/, '')
    const prefix = KEYS.foreignAccount + blake2Concat(fromHex(locationHex))
    const { keys, complete } = await storageKeys(AH, prefix, chain.hash, { budget: 5000 })
    assertDerivationAgrees(locationHex, keys)

    const values = await storageValues(AH, keys, chain.hash)
    const holders = []
    for (const key of keys) {
      const raw = values.get(key.toLowerCase())
      if (!raw) continue
      const accountHex = `0x${key.slice(-64)}`
      const account = decodeAssetAccount(raw, AH.id)
      holders.push({ accountHex, ...account, label: structuralLabel(accountHex) })
    }

    const supply = asset.supply === null ? null : BigInt(asset.supply)
    const holderSum = holders.reduce((total, holder) => total + holder.balance, 0n)

    const chains = holders
      .filter((holder) => holder.label?.kind === 'sibl')
      .map((holder) => {
        const paraId = holder.label.paraId
        const named = chainOf(paraId, 'polkadot')
        return {
          // ── who ─────────────────────────────────────────────────────────────────────────
          paraId,
          chainName: named?.name ?? null,
          chainKind: named?.kind ?? null,
          account: holder.accountHex,
          address: encodeSs58(fromHex(holder.accountHex), chain.ss58Format ?? 0),
          derivation: 'sibl',
          // ── what ────────────────────────────────────────────────────────────────────────
          // `assetKey` is the location hex, which is the only join key that is correct across
          // chains. NOT the symbol: Asset Hub carries two MYTHs, two NEUROs and two USDCs.
          assetKey: asset.locationHex,
          pallet: 'ForeignAssets',
          location: asset.locationText,
          network: asset.network,
          symbol: asset.symbol,
          decimals: asset.decimals,
          // ── how much ────────────────────────────────────────────────────────────────────
          amount: String(holder.balance),
          amountScaled: scaled(holder.balance, asset.decimals),
          status: holder.status,
          reason: holder.reason,
          // ── when, so the row can be stamped without consulting anything else ────────────
          venue: 'asset-hub',
          block: chain.block,
          blockHash: chain.hash,
          blockTime: chain.timeMs === null ? null : new Date(chain.timeMs).toISOString(),
          observedAt,
        }
      })
      .sort((a, b) => (b.amountScaled ?? Number(b.amount)) - (a.amountScaled ?? Number(a.amount)))

    holdings.push(...chains)

    const sovereignTotal = chains.reduce((total, row) => total + BigInt(row.amount), 0n)
    // The residual as briefed: supply minus what the sovereign accounts hold. It is NOT one
    // account and it is NOT all in accounts — see the split immediately below, which is the
    // whole reason this operation exists in this shape.
    const onAssetHub = supply === null ? null : supply - sovereignTotal
    // What the residual is actually made of:
    //   · `nonSovereign` — every holder on Asset Hub that is not a parachain's sovereign
    //     account: users, `AssetConversion` pool accounts, pallet accounts. Real balances.
    //   · `unaccounted`  — supply that is in NO account at all. Verified to be a real property
    //     of this chain rather than a gap in our read; see `holderNotes()`.
    const nonSovereign = holderSum - sovereignTotal
    const unaccounted = supply === null ? null : supply - holderSum

    assets.push({
      locationHex: asset.locationHex,
      locationText: asset.locationText,
      network: asset.network,
      networkLabel: asset.networkLabel,
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      supply: asset.supply,
      supplyScaled: asset.supplyScaled,
      accountsClaimed: asset.accounts,
      holdersSwept: holders.length,
      holdersComplete: complete,
      // The per-chain rows are NOT nested here. They are in the flat top-level `holdings` list,
      // one row per (chain, asset), so the same array is both what the page groups and what a
      // daily snapshot would store. This is the count of them for this asset.
      chains: chains.length,
      sovereignTotal: String(sovereignTotal),
      sovereignTotalScaled: scaled(sovereignTotal, asset.decimals),
      onAssetHub: onAssetHub === null ? null : String(onAssetHub),
      onAssetHubScaled: onAssetHub === null ? null : scaled(onAssetHub, asset.decimals),
      // The residual, split into the part that is in accounts and the part that is not.
      onAssetHubAccounts: String(nonSovereign),
      onAssetHubAccountsScaled: scaled(nonSovereign, asset.decimals),
      unaccounted: unaccounted === null ? null : String(unaccounted),
      unaccountedScaled: unaccounted === null ? null : scaled(unaccounted, asset.decimals),
      reconciliation: {
        // True by construction, and stated so a reader knows the bars add up.
        segmentsSumToSupply: supply === null ? null : sovereignTotal + (onAssetHub ?? 0n) === supply,
        // The genuine test, and it does fail — for six of today's assets. See the notes.
        holderSum: String(holderSum),
        holderSumScaled: scaled(holderSum, asset.decimals),
        holderSumMatchesSupply: supply === null || !complete ? null : holderSum === supply,
        // Signed, and the sign matters: positive would mean accounts hold more than was ever
        // minted, which cannot be true and would mean our decoder is wrong. Every observed
        // value is negative — supply above the accounts, never below.
        difference: supply === null ? null : String(holderSum - supply),
        differenceScaled: supply === null ? null : scaled(holderSum - supply, asset.decimals),
        // Proof the sweep is complete, independent of the balances: the pallet's own holder
        // counter against the number of keys we actually read.
        accountsClaimed: asset.accounts,
        sweepMatchesAccountCount: asset.accounts === null ? null : asset.accounts === holders.length,
        negativeResidual: onAssetHub === null ? null : onAssetHub < 0n,
      },
    })
  }

  assets.sort(bySupply)

  const failed = assets.filter((asset) => asset.reconciliation.holderSumMatchesSupply === false)
  const unchecked = assets.filter((asset) => asset.reconciliation.holderSumMatchesSupply === null)
  const negative = assets.filter((asset) => asset.reconciliation.negativeResidual)
  // The sweep being complete is a separate claim from the balances adding up, and it is the one
  // that decides whether a mismatch is OUR bug or THEIR bookkeeping.
  const shortSweeps = assets.filter((asset) => asset.reconciliation.sweepMatchesAccountCount === false)
  const overAccounted = failed.filter((asset) => BigInt(asset.reconciliation.difference) > 0n)

  const byChain = new Map()
  for (const row of holdings) {
    const entry = byChain.get(row.paraId) ?? { paraId: row.paraId, chainName: row.chainName, chainKind: row.chainKind, assets: 0, symbols: [] }
    entry.assets += 1
    if (row.symbol) entry.symbols.push(row.symbol)
    byChain.set(row.paraId, entry)
  }

  return {
    chain: chainMeta(chain),
    // The flat list: one row per (chain, asset), each row self-contained and stamped with the
    // block it was read at. See the note on `bridgedHolders()`.
    holdings,
    assets,
    chains: [...byChain.values()].sort((a, b) => b.assets - a.assets),
    reconciliation: {
      assets: assets.length,
      exact: assets.filter((asset) => asset.reconciliation.holderSumMatchesSupply === true).length,
      mismatched: failed.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex, difference: asset.reconciliation.difference })),
      unchecked: unchecked.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex })),
      negativeResiduals: negative.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex, onAssetHub: asset.onAssetHub })),
      sweepsShort: shortSweeps.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex, claimed: asset.accountsClaimed, swept: asset.holdersSwept })),
      overAccounted: overAccounted.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex, difference: asset.reconciliation.difference })),
      unaccountedTotalBySymbol: failed.map((asset) => ({ symbol: asset.symbol, locationHex: asset.locationHex, unaccounted: asset.unaccounted, unaccountedScaled: asset.unaccountedScaled })),
    },
    counts: { assets: assets.length, holdings: holdings.length, chains: byChain.size },
    fetchedAt: observedAt,
    meta: { liveness: livenessOf(chain, null) },
    notes: holderNotes({ chain, assets, holdings, failed, unchecked, negative, shortSweeps, overAccounted }),
  }
}

/* ══════════════════════════════════════════════════════════════ operation: sovereign DOT ═════ */

/**
 * Four independent enumerations of "which parachains exist", because no single one of them is
 * complete and the gaps are not the same gaps. See the para-2004 note at the top of this file.
 */
const ENUMERATION = {
  lifecycles: 'Paras::ParaLifecycles on the relay chain — registered with a current lifecycle',
  registrar: 'Registrar::Paras on the relay chain — holds a registration deposit',
  foreignAssets: 'named by a Parachain junction in an Asset Hub ForeignAssets key',
  topology: 'named by this site’s own src/core/topology.js registry',
}

const PARA_LIFECYCLE = ['Onboarding', 'Parathread', 'Parachain', 'UpgradingParathreadToParachain', 'DowngradingParachainToParathread', 'OffboardingParathread', 'OffboardingParachain']

async function enumerateParas(relayChain, ahChain) {
  const [lifecycles, registrar, foreign] = await Promise.all([
    storageKeys(RELAY, KEYS.paraLifecycles, relayChain.hash, { budget: 2000 }),
    storageKeys(RELAY, KEYS.registrarParas, relayChain.hash, { budget: 2000 }),
    storageKeys(AH, KEYS.foreignAsset, ahChain.hash, { budget: 4000 }),
  ])

  const sources = new Map()
  const add = (paraId, source) => {
    if (!Number.isInteger(paraId) || paraId <= 0) return
    const entry = sources.get(paraId) ?? new Set()
    entry.add(source)
    sources.set(paraId, entry)
  }

  for (const key of lifecycles.keys) add(paraIdFromKey(key), 'lifecycles')
  for (const key of registrar.keys) add(paraIdFromKey(key), 'registrar')
  for (const key of foreign.keys) {
    const locationHex = key.slice(2 + 64 + 32)
    if (!locationHex.startsWith('01')) continue // parents 1 — a sibling of Asset Hub
    try {
      const junction = decodeLocation(locationHex).interior.find((j) => j.type === 'Parachain')
      if (junction) add(junction.paraId, 'foreignAssets')
    } catch {
      // An undecodable location contributes no para id. Counted by `bridged-inventory`, which
      // is where that fact belongs; here it is simply one fewer enumeration source.
    }
  }
  for (const entry of CHAINS) {
    if (entry.network === 'polkadot' && entry.paraId !== null) add(entry.paraId, 'topology')
  }

  const lifecycleValues = await storageValues(RELAY, lifecycles.keys, relayChain.hash)
  const lifecycleOf = new Map()
  for (const key of lifecycles.keys) {
    const raw = lifecycleValues.get(key.toLowerCase())
    if (!raw) continue
    const index = parseInt(raw.replace(/^0x/, '').slice(0, 2), 16)
    lifecycleOf.set(paraIdFromKey(key), PARA_LIFECYCLE[index] ?? `lifecycle-${index}`)
  }

  return {
    paraIds: [...sources.keys()].sort((a, b) => a - b),
    sourcesOf: sources,
    lifecycleOf,
    counts: {
      lifecycles: lifecycles.keys.length,
      registrar: registrar.keys.length,
      foreignAssets: [...sources.entries()].filter(([, set]) => set.has('foreignAssets')).length,
      topology: [...sources.entries()].filter(([, set]) => set.has('topology')).length,
      union: sources.size,
    },
    complete: lifecycles.complete && registrar.complete && foreign.complete,
  }
}

async function sovereignDot() {
  const [relayChain, ahChain] = await Promise.all([pin(RELAY), pin(AH)])

  // The two legs are added together, so they must be denominated in the same thing. Read, not
  // assumed: a chain that reported 12 decimals here would make every total wrong by 100×.
  for (const chain of [relayChain, ahChain]) {
    if (chain.tokenSymbol !== 'DOT' || chain.tokenDecimals !== 10) {
      throw new UpstreamError(
        `${chain.host.label} reports its native token as ${chain.tokenSymbol}/${chain.tokenDecimals}, not DOT/10. The relay and Asset Hub legs are summed on this page and cannot be summed across different units.`,
        { kind: 'upstream', source: chain.host.id },
      )
    }
  }

  const paras = await enumerateParas(relayChain, ahChain)

  const relayKeys = paras.paraIds.map((id) => systemAccountKey(sovereignAccountHex(id, { on: 'relay' })))
  const ahKeys = paras.paraIds.map((id) => systemAccountKey(sovereignAccountHex(id, { on: 'sibling' })))

  const [relayValues, ahValues, relayIssuance, ahIssuance] = await Promise.all([
    storageValues(RELAY, relayKeys, relayChain.hash),
    storageValues(AH, ahKeys, ahChain.hash),
    storageValue(RELAY, KEYS.totalIssuance, relayChain.hash),
    storageValue(AH, KEYS.totalIssuance, ahChain.hash),
  ])

  const PLANCK = 10 ** relayChain.tokenDecimals
  const dot = (raw) => Number(raw) / PLANCK
  const observedAt = new Date().toISOString()

  /**
   * One flat row per (chain, asset, venue) — the same shape `bridged-holders` emits, so a daily
   * snapshot of both operations is one table rather than two. DOT is split into two rows rather
   * than pre-summed because the two legs are read at DIFFERENT blocks on DIFFERENT chains, and
   * a stored row that carried one block height for two chains' balances would be a lie about
   * when it was true. `chains[].total` below is the sum, for the page.
   */
  const holdingRow = ({ paraId, named, info, venue, chain, on }) => ({
    paraId,
    chainName: named?.name ?? null,
    chainKind: named?.kind ?? null,
    account: sovereignAccountHex(paraId, { on }),
    address: sovereignAddress(paraId, { on, ss58Prefix: chain.ss58Format ?? 0 }),
    derivation: on === 'relay' ? 'para' : 'sibl',
    assetKey: 'native:polkadot:DOT',
    pallet: 'Balances',
    location: '{parents: 1, Here}',
    network: 'polkadot',
    symbol: chain.tokenSymbol,
    decimals: chain.tokenDecimals,
    // `free + reserved`. NOT `frozen`, which is a lock on part of `free`.
    amount: String((info?.free ?? 0n) + (info?.reserved ?? 0n)),
    amountScaled: dot((info?.free ?? 0n) + (info?.reserved ?? 0n)),
    free: dot(info?.free ?? 0n),
    reserved: dot(info?.reserved ?? 0n),
    frozen: dot(info?.frozen ?? 0n),
    accountExists: Boolean(info),
    venue,
    block: chain.block,
    blockHash: chain.hash,
    blockTime: chain.timeMs === null ? null : new Date(chain.timeMs).toISOString(),
    observedAt,
  })

  const holdings = []

  const chains = paras.paraIds.map((paraId, i) => {
    const named = chainOf(paraId, 'polkadot')
    const relayRaw = relayValues.get(relayKeys[i].toLowerCase()) ?? null
    const ahRaw = ahValues.get(ahKeys[i].toLowerCase()) ?? null
    const relayInfo = relayRaw ? decodeAccountInfo(relayRaw, RELAY.id) : null
    const ahInfo = ahRaw ? decodeAccountInfo(ahRaw, AH.id) : null

    // An absent `System::Account` entry is a real zero, not an unknown: the account has been
    // reaped or never existed, and it therefore holds no DOT. `relayExists` keeps that distinct
    // from an account that exists holding zero, which is a different fact about the chain.
    const relayFree = relayInfo?.free ?? 0n
    const relayReserved = relayInfo?.reserved ?? 0n
    const ahFree = ahInfo?.free ?? 0n
    const ahReserved = ahInfo?.reserved ?? 0n
    // `frozen` is deliberately NOT in this sum. It is a lock on part of `free`, so adding it
    // double-counts the locked portion.
    const total = relayFree + relayReserved + ahFree + ahReserved

    holdings.push(holdingRow({ paraId, named, info: relayInfo, venue: 'relay', chain: relayChain, on: 'relay' }))
    holdings.push(holdingRow({ paraId, named, info: ahInfo, venue: 'asset-hub', chain: ahChain, on: 'sibling' }))

    return {
      paraId,
      name: named?.name ?? null,
      kind: named?.kind ?? null,
      enumeratedBy: [...(paras.sourcesOf.get(paraId) ?? [])],
      lifecycle: paras.lifecycleOf.get(paraId) ?? null,
      relayAccount: sovereignAccountHex(paraId, { on: 'relay' }),
      relayAddress: sovereignAddress(paraId, { on: 'relay', ss58Prefix: relayChain.ss58Format ?? 0 }),
      relayExists: Boolean(relayInfo),
      relayFree: dot(relayFree),
      relayReserved: dot(relayReserved),
      relayFrozen: relayInfo ? dot(relayInfo.frozen) : 0,
      assetHubAccount: sovereignAccountHex(paraId, { on: 'sibling' }),
      assetHubAddress: sovereignAddress(paraId, { on: 'sibling', ss58Prefix: ahChain.ss58Format ?? 0 }),
      assetHubExists: Boolean(ahInfo),
      assetHubFree: dot(ahFree),
      assetHubReserved: dot(ahReserved),
      assetHubFrozen: ahInfo ? dot(ahInfo.frozen) : 0,
      totalRaw: String(total),
      total: dot(total),
    }
  })

  chains.sort((a, b) => b.total - a.total)

  // The rows the relay's own enumeration would have dropped. Not a curiosity: para 2004 is in
  // neither relay storage item and holds 315 DOT across the two legs.
  const missing = chains
    .filter((row) => !row.enumeratedBy.includes('lifecycles') && !row.enumeratedBy.includes('registrar'))
    .map((row) => ({
      paraId: row.paraId,
      name: row.name,
      total: row.total,
      enumeratedBy: row.enumeratedBy,
      why: 'absent from both Paras::ParaLifecycles and Registrar::Paras on the relay chain — it is not registered there today, whatever it once was',
    }))

  const totals = {
    chains: chains.length,
    withAnyAccount: chains.filter((row) => row.relayExists || row.assetHubExists).length,
    relayAccounts: chains.filter((row) => row.relayExists).length,
    assetHubAccounts: chains.filter((row) => row.assetHubExists).length,
    relayTotal: chains.reduce((sum, row) => sum + row.relayFree + row.relayReserved, 0),
    assetHubTotal: chains.reduce((sum, row) => sum + row.assetHubFree + row.assetHubReserved, 0),
    total: chains.reduce((sum, row) => sum + row.total, 0),
  }

  const issuance = {
    relay: dot(littleEndian(relayIssuance ?? '0x', 0, 16)),
    assetHub: dot(littleEndian(ahIssuance ?? '0x', 0, 16)),
  }

  return {
    relay: chainMeta(relayChain),
    assetHub: chainMeta(ahChain),
    issuance,
    enumeration: { ...paras.counts, describes: ENUMERATION, complete: paras.complete },
    // The flat list: two rows per chain (the `para` leg on the relay, the `sibl` leg on Asset
    // Hub), each stamped with the block of the chain it was read from.
    holdings,
    chains,
    missing,
    totals: {
      ...totals,
      shareOfAssetHubIssuance: issuance.assetHub > 0 ? totals.assetHubTotal / issuance.assetHub : null,
      holdings: holdings.length,
    },
    fetchedAt: observedAt,
    meta: { liveness: [livenessOf(ahChain, 'Asset Hub'), livenessOf(relayChain, 'relay chain')] },
    notes: sovereignNotes({ relayChain, ahChain, chains, missing, totals, issuance, paras }),
  }
}

/* ═════════════════════════════════════════════════════════════════════════════ liveness ═════ */

/**
 * How current this is, from the chain's own clock rather than from ours. `Timestamp::Now` is
 * set by the block's inherent, so the lag it produces is "how long ago the node we asked
 * finalized a block" — the one thing a state read cannot tell you by succeeding.
 */
function livenessOf(chain, which) {
  const label = which ? `${LABEL} — ${which}` : chain.host.label
  return liveness({
    source: 'asset-hub',
    label,
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

function inventoryNotes({ chain, rows, bridged, sibling, stables, unscaled, anomalies, duplicateSymbols, complete }) {
  const notes = [
    `${count(rows.length)} entries in \`ForeignAssets\` at Asset Hub block ${count(chain.block)} (runtime \`${chain.specName}\` ${chain.specVersion}). ${count(bridged.length)} of them have \`parents: 2\` — a path up past the relay chain and out of Polkadot's consensus system, which is what "bridged" means here — and ${count(sibling.length)} have \`parents: 1\`, which is a sibling parachain's own token and is NOT bridged. Lumping the two together doubles the apparent bridge inventory.`,
    'The split is a runtime guarantee, not a pattern in today’s data. Asset Hub’s `ForeignAssets` pallet accepts only three creation origins — `FromSiblingParachain`, which admits nothing but `parents: 1` with a leading `Parachain` junction, and `FromNetwork` and `KusamaAssetFromAssetHubKusama`, both of which admit nothing but `parents: 2` opening with a `GlobalConsensus` that is not Polkadot. (Read from `polkadot-fellows/runtimes` and `paritytech/polkadot-sdk` on 2026-08-20.) Governance can still `force_create` outside those filters, so the invariant is re-derived on every read here and any key that fails it is listed as an anomaly rather than counted.',
    'Every asset here is keyed by its LOCATION, never by its symbol. Asset Hub currently carries two assets called MYTH, two called NEURO, two called XRT, two spellings of tBTC and — across the two pallets — two called USDC, and they are different assets with different issuers. Summing by symbol adds an Ethereum ERC-20 to a parachain token.',
  ]

  if (duplicateSymbols.length) {
    notes.push(`${duplicateSymbols.length} symbol(s) appear on more than one asset: ${duplicateSymbols.join(', ')}. They are separate rows and are not added together anywhere on this page.`)
  }

  notes.push(
    `The two stablecoins are in their own block because their provenance is different in kind. ${stables
      .map((row) => `asset ${row.assetId} (${row.symbol})`)
      .join(' and ')} are issued directly on Asset Hub by Circle and Tether — no wrapper, no bridge, no custodian, and the \`owner\`/\`issuer\` fields are the issuers' own accounts. Ethereum's USDC is ALSO present, in \`ForeignAssets\` under \`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\`, and it is a different asset with a different id and a different backing.`,
  )

  if (unscaled.length) {
    notes.push(
      `${unscaled.length} bridged asset(s) have no \`ForeignAssets::Metadata\` entry at all, so nothing on chain says how many decimals they use: ${unscaled
        .map((row) => row.locationText ?? row.locationHex)
        .join('; ')}. Their supply is shown as a raw integer and \`supplyScaled\` is \`null\` — not zero. An unscaled u128 rendered as whole units is wrong by up to eighteen orders of magnitude and looks entirely ordinary.`,
    )
  }

  const undecodable = rows.filter((row) => row.locationDecodeError)
  if (undecodable.length) {
    notes.push(
      `${undecodable.length} location(s) could not be decoded: ${undecodable.map((row) => `${row.locationHex} (${row.locationDecodeError})`).join('; ')}. Their \`parents\` byte still classifies them, but the consensus system they came from is \`null\` rather than guessed, and they are grouped under "could not be decoded".`,
    )
  }

  if (anomalies.length) {
    notes.push(`⚠ ${anomalies.length} key(s) have \`parents: 2\` without a well-formed \`GlobalConsensus\` opening junction: ${anomalies.map((a) => `${a.locationHex} — ${a.why}`).join('; ')}. They are reported rather than counted as bridged.`)
  }

  if (!complete) {
    notes.push('⚠ The `ForeignAssets::Asset` sweep hit this module’s key budget, so the inventory below is a PREFIX of the registry rather than the whole of it. Treat every count as a floor.')
  }

  notes.push(
    'Supply is `AssetDetails.supply` — what the pallet has minted on Asset Hub. For a Snowbridge asset that is the amount currently locked on the Ethereum side, and it is not a claim about the asset’s total supply anywhere else. `accounts` is the pallet’s own holder count, which counts accounts and not people.',
  )

  return notes
}

function holderNotes({ chain, assets, holdings, failed, unchecked, negative, shortSweeps, overAccounted }) {
  const notes = [
    `${count(holdings.length)} (chain, asset) holdings across ${count(assets.length)} bridged assets, read at Asset Hub block ${count(chain.block)}. A parachain's holding lives at \`ForeignAssets::Account(location, sibl(paraId))\`, where \`sibl\` is the literal ASCII prefix plus the para id — not a hash. Both \`sibl\` and \`para\` accounts exist on Asset Hub and reading the wrong one returns existential-deposit dust, which renders perfectly and is off by orders of magnitude.`,
    'Each holding is one flat row carrying its own block height and block timestamp, keyed by the asset’s LOCATION rather than its symbol. That is deliberate: snapshotted daily, this list is a per-chain, per-token netflow series, and a row that is already the record a store would keep needs no reshaping to become one.',
    'The decomposition comes from a full sweep of each asset’s holder map, not from reading the sovereign keys we expect to exist. That is what makes the reconciliation below possible: `Σ every holder == supply` tests the decoder, the key derivation and the block pinning at once, where "the segments add up" would only test our own arithmetic.',
    '`onAssetHub` is a RESIDUAL — supply minus what the sovereign accounts hold. It is not one account and it is not "the treasury". It is split here into `onAssetHubAccounts`, which is every non-sovereign holder (users, `AssetConversion` pool accounts, pallet accounts), and `unaccounted`, which is supply that is in no account at all. The second is not a rounding artefact; see below.',
  ]

  const exact = assets.filter((asset) => asset.reconciliation.holderSumMatchesSupply === true).length
  notes.push(
    failed.length === 0 && unchecked.length === 0
      ? `All ${count(assets.length)} bridged assets reconcile exactly: the swept holder balances sum to \`AssetDetails.supply\` to the last planck for every one of them.`
      : `${count(exact)} of ${count(assets.length)} bridged assets reconcile exactly.`,
  )

  if (failed.length) {
    notes.push(
      `⚠ ${failed.length} asset(s) do NOT reconcile — their swept holder balances sum to LESS than the recorded supply: ${failed
        .map(
          (asset) =>
            `${asset.symbol ?? asset.locationHex} short by ${
              asset.unaccountedScaled === null ? `${asset.unaccounted} raw units` : asset.unaccountedScaled.toLocaleString('en-US', { maximumFractionDigits: 8 })
            }`,
        )
        .join('; ')}.`,
      shortSweeps.length === 0
        ? '⚠ That gap is NOT a gap in this read. For every asset the number of holder keys swept equals `AssetDetails.accounts`, the pallet’s own counter — so the map was read whole. `Σ ForeignAssets::Account == AssetDetails.supply` is simply not an invariant on this chain.'
        : `⚠ ${shortSweeps.length} of those sweeps returned fewer keys than \`AssetDetails.accounts\` claims, so for those the gap MAY be our read rather than the chain: ${shortSweeps
            .map((asset) => `${asset.symbol ?? asset.locationHex} ${asset.holdersSwept}/${asset.accountsClaimed}`)
            .join('; ')}.`,
      '⚠ It was settled by probe rather than by argument (Asset Hub, 2026-08-20). The gap appears in single blocks, not as accumulated dust: the whole of the Snowbridge USDT gap — exactly 15.000000 USDT — appeared at block 14,915,236 (2026-04-24T06:10:36Z), where `supply` rose by 15.000000 while every one of the 44 holder balances and the account count stayed unchanged. The only non-inherent extrinsic in that block is `ParachainSystem::set_validation_data`, i.e. inbound XCM. So supply on this pallet can be minted without any account being credited. The mechanism inside XCM is NOT established here.',
      'The consequence for reading this page: the sign is always the same — supply above the accounts, never below — so `unaccounted` is a ceiling on how much of a bridged asset is claimed to exist beyond what anybody demonstrably holds. It is at most a few thousandths of a percent of supply today. It is shown rather than absorbed into `onAssetHub`, because absorbing it would silently attribute tokens that are in no account to "somebody on Asset Hub".',
    )
  }

  if (overAccounted.length) {
    notes.push(
      `⚠⚠ ${overAccounted.length} asset(s) have holders summing to MORE than supply, which cannot be true and means a decoder here is wrong: ${overAccounted
        .map((asset) => `${asset.symbol ?? asset.locationHex} by ${asset.reconciliation.difference}`)
        .join('; ')}.`,
    )
  }

  if (unchecked.length) {
    notes.push(`${unchecked.length} asset(s) could not be reconciled at all — either their sweep hit the key budget or they carry no supply figure. Their per-chain rows are still exact; their totals are a floor.`)
  }

  if (negative.length) {
    notes.push(`⚠ ${negative.length} asset(s) have a NEGATIVE residual: the sovereign accounts hold more than the recorded supply. That cannot be true and means a decode is wrong: ${negative.map((a) => a.symbol ?? a.locationHex).join(', ')}.`)
  }

  const unscaled = assets.filter((asset) => asset.decimals === null)
  if (unscaled.length) {
    notes.push(`${unscaled.length} asset(s) have no metadata and therefore no decimals. Their balances are raw integers and every \`*Scaled\` field is \`null\` rather than a number that would be wrong by a power of ten.`)
  }

  notes.push('A parachain with no entry for an asset produces NO ROW at all rather than a row of zero — the sweep is complete, so absence here means the account was never opened or has been reaped, which is a different fact from a balance of nothing.')
  return notes
}

function sovereignNotes({ relayChain, ahChain, chains, missing, totals, issuance, paras }) {
  const notes = [
    `A parachain's sovereign DOT is the SUM of two accounts on two chains: \`para\` on the relay chain (${count(relayChain.block)}) and \`sibl\` on Asset Hub (${count(ahChain.block)}). Since the Asset Hub migration on 2025-11-04 the Asset Hub leg is almost all of it — ${totals.assetHubTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} DOT against ${totals.relayTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} DOT on the relay — but the relay leg is not zero and dropping it is a real, if small, undercount.`,
    '⚠ Both prefixes exist on BOTH chains. Sweeping the `para`-prefixed accounts on Asset Hub returns about 20 DOT of existential deposits, which is a chart that renders perfectly and is wrong by a factor of half a million. The derivation used here is `src/core/topology.js`, which checks itself at import against two independently verified addresses.',
    '`total` is `free + reserved`. `frozen` is deliberately excluded: it is a lock on part of `free`, not a fourth pot, and adding it double-counts. `AccountInfo` also ends in a 128-bit `flags` word whose top bit is set; read with the pre-2023 balance schema it appears as roughly 1.7e38 of DOT, which is the bug currently visible in Statescan’s public account index.',
    `The parachain set is the union of four independent enumerations, because no single one of them is complete: \`Paras::ParaLifecycles\` (${count(paras.counts.lifecycles)} ids), \`Registrar::Paras\` (${count(paras.counts.registrar)}), the sibling para ids named by Asset Hub's own \`ForeignAssets\` keys (${count(paras.counts.foreignAssets)}), and this site's \`topology.js\` registry (${count(paras.counts.topology)}) — ${count(paras.counts.union)} distinct ids in all. Every row says which of them produced it.`,
  ]

  if (missing.length) {
    notes.push(
      `${missing.length} chain(s) hold a sovereign account but appear in NEITHER relay enumeration — they are not registered on the relay chain today: ${missing
        .map((row) => `${row.name ?? `para ${row.paraId}`} (${row.total.toLocaleString('en-US', { maximumFractionDigits: 2 })} DOT, found via ${row.enumeratedBy.join(' + ')})`)
        .join('; ')}. A payload built from \`Paras::ParaLifecycles\` alone would have shown them as absent, and a reader would have read that as "holds nothing". Absent from an enumeration and holding nothing are different facts and this page keeps them apart.`,
    )
  }

  const noAccount = chains.filter((row) => !row.relayExists && !row.assetHubExists)
  if (noAccount.length) {
    notes.push(
      `${noAccount.length} of the ${count(chains.length)} enumerated chains have no \`System::Account\` entry on either chain. That is a genuine zero rather than a failed read — the account was reaped or never funded — and they are shown at 0 with \`relayExists\`/\`assetHubExists\` false so the two cases stay distinguishable.`,
    )
  }

  notes.push(
    `The ${totals.assetHubTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })} DOT in sovereign accounts on Asset Hub is ${((totals.assetHubTotal / issuance.assetHub) * 100).toFixed(2)}% of Asset Hub's \`Balances::TotalIssuance\` (${issuance.assetHub.toLocaleString('en-US', { maximumFractionDigits: 0 })} DOT). The relay chain's own issuance is now ${issuance.relay.toLocaleString('en-US', { maximumFractionDigits: 0 })} DOT, which is the migration visible in one number.`,
  )

  notes.push(
    'This is DOT only. A chain’s sovereign accounts also hold USDC, USDT and every bridged asset — that decomposition is `/api/asset-hub/bridged-holders`, and the two must not be added together.',
  )

  notes.push(
    'The `holdings` list is two flat rows per chain — the `para` leg and the `sibl` leg — rather than one pre-summed row, because the two are read at different blocks on different chains and a single row carrying one block height for both would be a claim that is not true of either.',
  )

  notes.push('Current state, read once. Nothing here says whether a balance is usual for that chain, because this site keeps no history of it yet.')
  return notes
}

/* ═══════════════════════════════════════════════════════════════════════════ registry ═════ */

export default {
  id: 'asset-hub',
  label: LABEL,
  homepage: 'https://polkadot.com/',
  transport: 'jsonrpc',
  doc: 'docs/platform/asset-hub.md',
  covers: [
    'Polkadot Asset Hub (para 1000) — ForeignAssets, Assets, sovereign account balances',
    'Polkadot relay chain — Paras::ParaLifecycles, Registrar::Paras, sovereign account balances',
  ],

  operations: {
    'bridged-inventory': {
      summary:
        'Everything registered in Asset Hub’s `ForeignAssets`, with each asset’s XCM location decoded out of its own storage key, split into bridged (parents 2, outside Polkadot’s consensus) and sibling-parachain assets, and grouped by the consensus system it came from. Includes the two locally-issued stablecoins in a separate block, because they are issued rather than bridged.',
      // Fifteen minutes. A Snowbridge registration is a governance-scale event, and supplies
      // move slowly enough that a fresher read would buy nothing at somebody else's expense.
      ttlMs: 900_000,
      schema: {},
      run: () => bridgedInventory(),
    },

    'bridged-holders': {
      summary:
        'Each bridged asset’s supply decomposed across the parachain sovereign accounts holding it on Asset Hub, with the residual sitting on Asset Hub itself, and a reconciliation of every swept holder balance against the pallet’s own supply figure.',
      ttlMs: 900_000,
      schema: {},
      run: () => bridgedHolders(),
    },

    'sovereign-dot': {
      summary:
        'DOT held by every enumerated parachain in its sovereign accounts, on the relay chain (`para`) and on Asset Hub (`sibl`), summed — plus both chains’ total issuance and an explicit list of the chains the relay’s own enumeration does not name.',
      // Ten minutes. Balances move with every block, but a public dashboard reading somebody
      // else's free endpoint does not need to.
      ttlMs: 600_000,
      schema: {},
      run: () => sovereignDot(),
    },
  },
}
