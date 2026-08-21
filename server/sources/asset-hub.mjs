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
// ── four hosts, one module, and why that is not a violation ─────────────────────────────────
// The rule is one module per upstream, and this module names four hostnames: Polkadot's relay
// and Asset Hub, and Kusama's. They are one upstream in every sense that matters: the same
// operator's public RPC, the same runtime release (`1.24.1-8ae9775dc43` on all four, verified
// 2026-08-21), and — decisively — a single figure. Post-Asset-Hub-Migration a chain's sovereign
// balance is `para` on its relay PLUS `sibl` on its Asset Hub; splitting that across modules
// would mean neither could compute the number anybody wants.
//
// The Kusama pair is here for the DAILY SERIES ONLY (`netflows-daily`, `sovereign-dot-recent`),
// because that measurement is identical on both networks and the alternative was a second copy
// of ~900 lines of block-boundary search whose only differences are two URLs, two decimals and
// one SS58 prefix — that is, two places for the same off-by-one. The three Polkadot-specific
// operations above it (`bridged-inventory`, `bridged-holders`, `sovereign-dot`) read Polkadot
// and nothing else: `ForeignAssets` on Kusama Asset Hub is a different registry answering a
// different question, and pretending otherwise would be the mislabelling this module is built
// to avoid.
//
// WHAT DIFFERS BETWEEN THE TWO NETWORKS, and each of these is a silent factor if it is missed:
//   · KSM IS 12 DECIMALS, DOT IS 10. A Kusama series divided by 1e10 is exactly 100× too large
//     and renders perfectly. The divisor is never a constant here — it comes from the network
//     table, and `netflowsHeads` refuses to run if the chain disagrees with the table.
//   · KUSAMA'S SS58 PREFIX IS 2. An address rendered at prefix 0 is a valid-looking Polkadot
//     address for a Kusama account. The prefix comes from `system_properties`, per chain.
//   · THE MIGRATION DATES DIFFER — Polkadot 2025-11-04, Kusama 2025-10-07 (both bisected out of
//     their own relay chains; see the network table below).
//   · THE SERIES FLOORS DIFFER, and both are set by a chain that has state but no clock.
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

import { readFileSync } from 'node:fs'

import { callUpstream, jsonRpc, UpstreamError } from '../lib/upstream.mjs'
import { serveFromStore } from '../lib/demand.mjs'
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
  chainLabel: 'Polkadot Asset Hub',
  url: 'https://polkadot-asset-hub-rpc.polkadot.io',
}

const RELAY = {
  id: 'polkadot-rpc',
  label: 'Polkadot relay chain (Parity public RPC)',
  chainLabel: 'Polkadot relay chain',
  url: 'https://rpc.polkadot.io',
}

/**
 * Kusama's two, for the daily series only.
 *
 * Identity verified rather than inferred from the hostname (2026-08-21): `system_chain` answers
 * `Kusama` and `Kusama Asset Hub`, `system_version` is `1.24.1-8ae9775dc43` on both — the same
 * runtime release the two Polkadot hosts serve. This repo has already been bitten by a hostname
 * that resolved, answered, and served a different chain (CLAUDE.md), so the check is in
 * `netflowsHeads` on every read and not in a comment.
 */
const KUSAMA_AH = {
  id: 'kusama-asset-hub-rpc',
  label: 'Kusama Asset Hub (Parity public RPC)',
  chainLabel: 'Kusama Asset Hub',
  url: 'https://kusama-asset-hub-rpc.polkadot.io',
}

const KUSAMA_RELAY = {
  id: 'kusama-rpc',
  label: 'Kusama relay chain (Parity public RPC)',
  chainLabel: 'Kusama relay chain',
  url: 'https://kusama-rpc.polkadot.io',
}

const LABEL = 'Polkadot Asset Hub + relay chain (and Kusama’s two, for the daily series)'

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
    meta: { liveness: livenessOf(chain) },
    notes: inventoryNotes({ chain, rows, bridged, sibling, stables, unscaled, anomalies, duplicateSymbols, complete }),
  }
}

const bySupply = (a, b) => (b.supplyScaled ?? -1) - (a.supplyScaled ?? -1)

const chainMeta = (chain) => ({
  // The chain names ITSELF, from the host record, rather than being inferred by comparing the
  // host against `AH`. With four hosts in this module that comparison silently labelled every
  // Kusama chain "Polkadot relay chain".
  chain: chain === null ? null : chain.host.chainLabel,
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
    meta: { liveness: livenessOf(chain) },
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
    meta: { liveness: [livenessOf(ahChain), livenessOf(relayChain)] },
    notes: sovereignNotes({ relayChain, ahChain, chains, missing, totals, issuance, paras }),
  }
}

/* ═════════════════════════════════════════════════════════════════════════════ liveness ═════ */

/**
 * How current this is, from the chain's own clock rather than from ours. `Timestamp::Now` is
 * set by the block's inherent, so the lag it produces is "how long ago the node we asked
 * finalized a block" — the one thing a state read cannot tell you by succeeding.
 */
function livenessOf(chain) {
  return liveness({
    source: 'asset-hub',
    label: chain.host.label,
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

/* ═══════════════════════════════ the daily series: sovereign balances over time, per network ═════ */
//
// `sovereign-dot` above answers "how much DOT is in these accounts right now", on Polkadot. This
// section answers the question `/netflows/` is named for — how much was in them on every day
// since the first parachain — and it is the same measurement, taken ~3,500 times across TWO
// networks. Everything below is parameterised by `NETFLOW_NETWORKS`; nothing below names a host,
// a token, a decimal count or a date directly.
//
// ── one request per chain per day, not one per account ───────────────────────────────────────
// `state_queryStorageAt` reads MANY keys at ONE block, so a day costs a handful of requests
// rather than one per sovereign account. And because the JSON-RPC endpoints accept a BATCH
// (an array of calls in one POST, verified against all four hosts), the day loop batches across
// DAYS as well: ten days' block-boundary probes are two HTTP requests, not twenty.
//
// MEASURED, 2026-08-21, by counting real fetches through the job handler with the hint carried
// across batches exactly as the engine carries it:
//
//   kusama   2026-06   30 days   163 requests   5.43 per day   0.75 s/day
//   polkadot 2026-06   30 days   171 requests   5.70 per day   1.09 s/day
//
// End to end, the whole Kusama backfill — 61 months, 1,857 days, 2021-07-01 → 2026-07-31 —
// took 33.1 minutes through the engine's politeness gate: **1.07 s per day**, 1,542 B mean
// stored per day, 2.73 MB in total.
//
// THIS CORRECTS THE FIGURE THAT WAS HERE. It said "~2.2 HTTP requests and ~1.4 s per day",
// measured on 2026-08-20; re-measured on the same Polkadot path the next day it is 5.70. The
// arithmetic that gives 2.2 counts the boundary search and the account reads and forgets that
// `netflowsHeads` runs on EVERY batch — `pin()` is five un-batched calls per host, so ten
// requests per ten-day batch, a full request per day spent re-reading two heads that moved by
// a few hundred blocks since the last batch. Whether that can be hoisted out of the batch loop
// is docs/concept/research-queue.md; what matters here is that the cost of this backfill is
// two and a half times what this comment claimed.
//
// ── the day's value is its CLOSE, and that is not a stylistic choice ─────────────────────────
// The 2023 Polkalytics dataset in `src/data/netflows.json` defines a day as "the last balance
// observed at or before the end of that UTC day". Reading the state at the LAST BLOCK of the
// UTC day reproduces it EXACTLY — Acala 1,462,204.186283087 DOT, Moonbeam 257,493.0765709934,
// Parallel 649,004.9792496555, Astar 103,221.2311821044 all agree to the planck with that file's
// 2022-05-31 row (verified 2026-08-20). Reading at 00:00 of the same day instead would line the
// series up one day early against the archive and read as a genuine one-day lead, not as an
// off-by-one. This is the same trap CLAUDE.md records for oracle bars, in the other direction.
//
// ── never extrapolate a block height from a date ─────────────────────────────────────────────
// The day's last block is found by SEARCHING on `Timestamp::Now`, seeded with the previous
// day's own measured block count and then corrected by a secant step against real timestamps.
// Every answer is verified against the chain's own clock before it is used: the close block's
// timestamp must fall inside the UTC day, and the block after it must fall outside. A height
// multiplied out of an assumed block time has already produced two wrong-but-plausible numbers
// in this repo (CLAUDE.md), and neither chain's rate is constant: the relay ran 14,173 blocks on
// 2022-05-31 and 14,398 on 2023-01-15, and ASSET HUB has gone from 12.51 s a block in 2022 to
// 2.24 s on 2026-08-19 — a factor of six inside the range this backfills. A rate averaged over
// the whole span sits between Asset Hub's two regimes and is wrong in both halves, so the search
// measures it LOCALLY, from the samples nearest the target.
//
// ── what a pruned read looks like, and why it cannot pass ────────────────────────────────────
// A node that has discarded historical state answers a balance query with `null`, which is
// indistinguishable from "this account holds nothing" — a whole chart of zeros that renders
// perfectly. The guard is `Timestamp::Now`, which EVERY block has: a day whose close block
// cannot produce a timestamp inside that UTC day is refused outright, and no row is written.
// All four public endpoints were probed down to their floors and serve full archive state:
//
//   relay      #1 = 2020-05-26 (Polkadot), #1 = 2019-11-28T17:27:54Z (Kusama)
//   Asset Hub  a clockless prefix on BOTH, which is the interesting case. Polkadot Asset Hub's
//              clock starts at #305,204 = 2021-12-18T18:52:54Z (2026-08-20) and Kusama Asset
//              Hub's at #66,687 = 2021-06-03T15:36:00.509Z (2026-08-21). Below those the chain
//              answers `state_getRuntimeVersion` (`statemint 601` / `statemine 1`) and answers
//              `Timestamp::Now` with `null` — a pre-launch period that is indistinguishable
//              from a pruned archive, and a balance read there is indistinguishable from an
//              empty account. That is what sets each network's `firstMonth`.
//
// ── the Asset Hub Migration is drawn, not hidden ─────────────────────────────────────────────
// Before the migration a parachain's reserve sat in its `para` account on the relay; after it,
// in its `sibl` account on Asset Hub. Both legs are read on every day of the range and stored
// SEPARATELY, so the page can draw the handover rather than assert a continuous line through
// it. Summing them is correct — the migration moved the money, it did not duplicate it — but a
// series that only reported the sum would hide the single largest structural break in it. The
// two networks migrated on different days (Polkadot 2025-11-04, Kusama 2025-10-07) and both
// dates were bisected out of the relay chains themselves — see the network table below.

/**
 * Stamped on every stored row. Bump when the payload's meaning changes.
 *
 * `@2` adds `network` and `token` to each day. The bump is honest rather than defensive: making
 * `network` a parameter changed the store IDENTITY of every Polkadot day too (see the registry
 * entry below), so nothing stored under `@1` is reachable any more and a reader comparing two
 * rows can tell which code wrote each.
 */
const NETFLOWS_VERSION = 'asset-hub/netflows-daily@2'

/**
 * The two networks, and everything that differs between them.
 *
 * This table is the whole of the parameterisation: one implementation reads it and nothing else
 * below names a host, a token or a date. Two of its fields are canaries rather than
 * configuration — `token` and `decimals` are ASSERTED against `system_properties` on every read
 * in `netflowsHeads`, because a Kusama figure divided by Polkadot's 1e10 is exactly 100× too
 * large and looks entirely reasonable.
 *
 * `firstMonth` is not a taste decision on either network. It is the first WHOLE calendar month
 * whose every UTC day has a readable close on BOTH chains, and on both networks the binding
 * constraint is the same one: an Asset Hub that has state but sets no `Timestamp::Now`, which is
 * indistinguishable from a pruned archive and whose balance reads come back `null`, which is
 * indistinguishable from an empty account.
 *
 *   polkadot  Asset Hub's clock starts at #305,204 = 2021-12-18T18:52:54.582Z (verified live
 *             2026-08-20). Polkadot's first parachains onboarded 2021-12-17 and NO sovereign
 *             account held DOT until 2022-02-02, so 2022-01 is a month of verified-empty days
 *             rather than missing ones.
 *   kusama    Kusama Asset Hub's clock starts at #66,687 = 2021-06-03T15:36:00.509Z (bisected
 *             live 2026-08-21; #66,686 answers `statemine 1` to `state_getRuntimeVersion` and
 *             `null` to `Timestamp::Now`). June 2021 therefore cannot be a whole month and the
 *             series opens at 2021-07 — which is also, by coincidence rather than by design, the
 *             archived 2023 dataset's own first day.
 *
 * `migratedOn` is the Asset Hub Migration, and NO storage item says it. Both dates were
 * established by bisecting a large sovereign account's balance out of the relay chain itself:
 *
 *   polkadot  Acala's `para` account falls 3,137,094.16 → 341.00 DOT across relay
 *             #28,493,861→862 (2025-11-04).
 *   kusama    Karura's `para` account falls 40,394.8 → 160.0 KSM across relay
 *             #30,424,405→#30,424,406, dated 2025-10-07T14:47:54.001Z (verified 2026-08-21).
 *             Progressive rather than atomic, exactly as Polkadot's was: at that same block
 *             Bifrost still held 19,525.2 KSM on the relay, Kintsugi 6,481.3, Basilisk 2,528.5
 *             and Picasso 2,470.8, while Moonriver, Heiko and Mangata were already at 40–90 KSM.
 *             The handover completes inside that UTC day — by its close the fifteen relay legs
 *             sum to 1,210 KSM against 102,581 KSM on Asset Hub.
 *
 * The Kusama date had been carried in `docs/platform/` as an unverified transcription until this
 * read. It was right; it is no longer a transcription.
 */
const NETFLOW_NETWORKS = {
  polkadot: {
    id: 'polkadot',
    label: 'Polkadot',
    relay: RELAY,
    assetHub: AH,
    token: 'DOT',
    decimals: 10,
    firstMonth: '2022-01',
    migratedOn: '2025-11-04',
  },
  kusama: {
    id: 'kusama',
    label: 'Kusama',
    relay: KUSAMA_RELAY,
    assetHub: KUSAMA_AH,
    token: 'KSM',
    decimals: 12,
    firstMonth: '2021-07',
    migratedOn: '2025-10-07',
  },
}

const NETFLOW_NETWORK_IDS = Object.keys(NETFLOW_NETWORKS)

/** The network, or a throw. Never a default: a silent one would attribute Kusama days to
 *  Polkadot's identity in the store, and both would render. */
function netflowNetwork(id) {
  const net = NETFLOW_NETWORKS[id]
  if (!net) {
    throw new UpstreamError(`\`network\` must be one of: ${NETFLOW_NETWORK_IDS.join(', ')} — got \`${id}\`.`, {
      kind: 'decode',
      source: 'asset-hub',
    })
  }
  return net
}

const NETFLOWS_MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/

const DAY_MS = 86_400_000

/**
 * How long after a month ends before its days are treated as settled. An hour is ~60× Polkadot's
 * worst observed finality lag and costs nothing: the days it delays are days nobody could have
 * read yet. The real guarantee is in the handler, which cannot resolve a day's close block at
 * all unless the chain has produced a block past the day's end.
 */
const NETFLOWS_SETTLE_MS = 60 * 60_000

/** Days fetched per committed batch. The boundary search costs two HTTP requests per ROUND no
 *  matter how many days are in flight, so a batch of ten pays for one search instead of ten —
 *  measured at ~1.9 s per day at six and ~1.4 s at ten. A failed batch costs at most this many
 *  days of work, and the facts insert idempotently, so a replay is free. */
const DAYS_PER_BATCH = 10

/** Sub-calls per JSON-RPC batch. Two ceilings, because the two kinds of call cost the upstream
 *  very different amounts: a header lookup is free, a state read is not. */
const RPC_BATCH_LIGHT = 240
const RPC_BATCH_STATE = 60

/** Keys per `state_queryStorageAt` HTTP request, across however many days it covers. */
const KEYS_PER_REQUEST = 300

/**
 * A chain holding less than this is folded into one `dust` row rather than getting its own entry
 * on every one of ~1,700 days. The aggregate keeps every total exact; what it costs is the
 * ability to NAME a chain that held less than the floor.
 *
 * It is a fixed PLANCK amount, deliberately, and that means it is a different amount of money on
 * each network: 1 DOT (10 decimals) and 0.01 KSM (12 decimals). One whole token per network was
 * the alternative and it is not obviously better — the cap below binds on most days anyway, and a
 * finer floor errs towards naming a chain rather than absorbing it, which is the safe direction.
 * What matters is that nothing ANYWHERE says "1 token": the floor is written into every stored
 * day as `dust.floor` and every note that mentions it is generated from that value, so the page
 * cannot describe a floor the data was not built with.
 */
const DUST_PLANCK = 10_000_000_000n

/** Per-day cap on individually listed chains, after the dust floor. Measured over the whole
 *  2022→2026 series: it binds on 816 of 1,662 days, the largest holding at the fortieth row is
 *  50.1 DOT, and the most ever folded into one day's `dust` is 175.05 DOT against a ten-million
 *  DOT total. The totals are unaffected either way — only the ability to name those chains is. */
const MAX_CHAIN_ROWS = 40

/** Most days `sovereign-dot-recent` will read in one request. */
const RECENT_MAX_DAYS = 40

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`)
const addDaysIso = (day, n) => isoDay(dayStartMs(day) + n * DAY_MS)
const monthOfDay = (day) => day.slice(0, 7)

function monthEndMs(month) {
  const [year, index] = month.split('-').map(Number)
  return index === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index, 1)
}

/** Every UTC day of the month, as ISO dates — which is also the segment id. ISO dates sort as
 *  strings in their real order; a counter here would draw the chart out of sequence. */
function daysOfMonth(month) {
  const [year, index] = month.split('-').map(Number)
  const days = []
  for (let at = Date.UTC(year, index - 1, 1); at < monthEndMs(month); at += DAY_MS) days.push(isoDay(at))
  return days
}

/**
 * The most dangerous line in this section. Total by construction: anything unparseable, an
 * unknown network, a month before THAT network's floor, or a month not yet finished is NOT
 * immutable and is refused before a job exists. A predicate wrong in the permissive direction
 * freezes a partial answer forever.
 *
 * The floor is per network and that matters here rather than only in the reader: Kusama can
 * answer for 2021-07 and Polkadot cannot, and a single floor would either lock Kusama out of
 * five readable months or let Polkadot mint a job for a month whose Asset Hub leg has no clock.
 */
export function netflowsMonthIsSettled(params, now = Date.now()) {
  const month = params?.month
  const net = NETFLOW_NETWORKS[params?.network]
  if (!net) return false
  if (typeof month !== 'string' || !NETFLOWS_MONTH_RE.test(month)) return false
  if (month < net.firstMonth) return false
  return now >= monthEndMs(month) + NETFLOWS_SETTLE_MS
}

/**
 * Every month the store can answer for on one network, oldest first: the network's own floor up
 * to the last month `netflowsMonthIsSettled` accepts. This is THE month list — `warm()` enqueues
 * it, `netflows-series` reads it, and the identity-watch stream validates against the same
 * predicate — derived in one place because two derivations of "which months exist" that disagree
 * by one entry produce a page that is permanently missing its newest month with no error anywhere.
 */
function netflowsSettledMonths(networkId, now = Date.now()) {
  const net = netflowNetwork(networkId)
  const months = []
  const ceiling = new Date(now).getUTCFullYear()
  for (let year = Number(net.firstMonth.slice(0, 4)); year <= ceiling; year += 1) {
    for (let index = 1; index <= 12; index += 1) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (month < net.firstMonth) continue
      if (!netflowsMonthIsSettled({ month, network: net.id }, now)) continue
      months.push(month)
    }
  }
  return months
}

/* ------------------------------------------------------------------ batched JSON-RPC ---- */

/**
 * Many JSON-RPC calls in one POST.
 *
 * Substrate's HTTP endpoint answers a JSON array with an array, and both public endpoints used
 * here were verified to do so on 2026-08-20. Everything is matched back by `id` rather than by
 * position — a server is permitted to reorder a batch response, and reading it positionally
 * would silently attribute one block's balances to another day.
 *
 * A sub-call error is a real error: it throws, exactly as a single-call error does. A batch that
 * swallowed one failed member would hand back `undefined` where a balance belongs, and
 * `undefined` scales to `null`, which draws as a gap in a series that is actually wrong.
 */
async function jsonRpcBatch({ host, calls, timeoutMs = 60_000 }) {
  if (!calls.length) return []
  const answer = await callUpstream({
    source: host.id,
    url: host.url,
    method: 'POST',
    body: calls.map((call, id) => ({ jsonrpc: '2.0', id, method: call.method, params: call.params ?? [] })),
    timeoutMs,
  })
  if (!Array.isArray(answer)) {
    throw new UpstreamError(`${host.label} answered a JSON-RPC batch of ${calls.length} with a single object.`, {
      kind: 'upstream',
      source: host.id,
    })
  }
  const out = new Array(calls.length)
  const filled = new Set()
  for (const item of answer) {
    const id = Number(item?.id)
    if (!Number.isInteger(id) || id < 0 || id >= calls.length) {
      throw new UpstreamError(`${host.label} answered a batch with an id (${item?.id}) that was not in it.`, {
        kind: 'decode',
        source: host.id,
      })
    }
    if (item.error) {
      throw new UpstreamError(`${calls[id].method} was rejected: ${item.error.message ?? JSON.stringify(item.error)}`, {
        kind: 'upstream',
        source: host.id,
      })
    }
    out[id] = item.result
    filled.add(id)
  }
  if (filled.size !== calls.length) {
    throw new UpstreamError(
      `${host.label} answered ${filled.size} of the ${calls.length} calls in one batch. A short batch would leave a balance undefined, which renders as a gap rather than as an error.`,
      { kind: 'upstream', source: host.id },
    )
  }
  return out
}

/** Chunk a call list and run the chunks one after another through `run` (the politeness gate,
 *  or a bare call when there is no job around it). */
async function batchCalls(run, host, calls, perRequest, timeoutMs) {
  const out = []
  for (let i = 0; i < calls.length; i += perRequest) {
    const slice = calls.slice(i, i + perRequest)
    out.push(...(await run(host, () => jsonRpcBatch({ host, calls: slice, timeoutMs }))))
  }
  return out
}

/* ------------------------------------------------------------- the day's last block ---- */

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi)

/**
 * For each instant, the FIRST block at or after it — resolved for many instants at once.
 *
 * Every round probes `guess` and `guess - 1` for every unresolved target, in two HTTP requests
 * total no matter how many targets there are: one batch of `chain_getBlockHash` and one batch of
 * `Timestamp::Now`. A target is resolved only when the chain's own clock says `ts(guess) >=
 * target` AND `ts(guess-1) < target`, which is the entire definition of "first block at or
 * after" and is checked rather than assumed.
 *
 * The next guess is a secant step over that target's own widest pair of samples, falling back
 * to `blockMs` on the first round and to a bisection whenever the secant leaves the bracket. The
 * bracket `[lo, hi]` is maintained from real observations, so the search cannot fail to
 * terminate — it can only run out of rounds, which throws.
 */
async function firstBlocksAtOrAfter(host, { targets, hints, head, headAt, blockMs, run }) {
  const state = targets.map((target, i) => {
    // The head is a real observation and it is free, so every target starts with one sample
    // already in hand. That is what makes the FIRST secant step useful on a cold start, where
    // the only alternative is a 24-deep bisection over twenty million blocks.
    const seen = new Map()
    if (Number.isFinite(headAt)) seen.set(head, { at: headAt, hash: null })
    const hint = Math.round(hints[i])
    // A hint that lands outside the chain is not a hint. Falling back to the middle of the
    // range costs one bisection step; trusting it costs a walk from block 1 upwards.
    const guess = Number.isFinite(hint) && hint >= 2 && hint <= head ? hint : Math.floor(head / 2)
    return { target, lo: 1, hi: head, guess, seen, done: null }
  })

  for (let round = 0; round < 48; round += 1) {
    const pending = state.filter((s) => !s.done)
    if (!pending.length) break

    const heights = new Set()
    for (const s of pending) {
      heights.add(s.guess)
      if (s.guess > 1) heights.add(s.guess - 1)
    }
    const wanted = [...heights]
    const hashes = await batchCalls(
      run,
      host,
      wanted.map((height) => ({ method: 'chain_getBlockHash', params: [height] })),
      RPC_BATCH_LIGHT,
      30_000,
    )
    const hashOf = new Map()
    wanted.forEach((height, i) => hashOf.set(height, hashes[i] ?? null))

    const unread = [...new Set(wanted.map((h) => hashOf.get(h)).filter(Boolean))]
    const stamps = await batchCalls(
      run,
      host,
      unread.map((hash) => ({ method: 'state_getStorage', params: [KEYS.timestamp, hash] })),
      RPC_BATCH_STATE,
      45_000,
    )
    const timeOf = new Map()
    unread.forEach((hash, i) => timeOf.set(hash, stamps[i] ? Number(littleEndian(stamps[i], 0, 8)) : null))

    for (const s of pending) {
      for (const height of [s.guess - 1, s.guess]) {
        if (height < 1 || s.seen.has(height)) continue
        const hash = hashOf.get(height)
        // No hash: past this node's head. No timestamp: pruned state, or a chain that had not
        // started its clock. Both are "we cannot read here" — recorded as such, never as zero.
        s.seen.set(height, { hash: hash ?? null, at: hash ? (timeOf.get(hash) ?? null) : null })
      }
      resolveOrNarrow(s)
      if (s.done) continue
      s.guess = nextGuess(s, blockMs)
      if (s.guess === null) {
        throw new UpstreamError(
          `${host.label}: every block between ${s.lo} and ${s.hi} has been read and none of them is the first at or after ` +
            `${new Date(s.target).toISOString()}. ${describeSamples(s)}`,
          { kind: 'decode', source: host.id },
        )
      }
    }
  }

  const stuck = state.find((s) => !s.done)
  if (stuck) {
    throw new UpstreamError(
      `${host.label}: could not locate the block at or after ${new Date(stuck.target).toISOString()} in 48 rounds ` +
        `(bracket ${stuck.lo}–${stuck.hi}). ${describeSamples(stuck)}`,
      { kind: 'upstream', source: host.id },
    )
  }
  return state.map((s) => s.done)
}

/**
 * The answer, read out of everything sampled so far — not just out of the pair probed this
 * round.
 *
 * This is what makes the search terminate. An earlier version only tested the current guess
 * against its own predecessor, so a bracket could narrow to a handful of blocks whose
 * timestamps were all already known, and the loop would spend its remaining rounds re-reading
 * them. Testing every ADJACENT pair in the sample set instead means a boundary that has been
 * observed is recognised immediately, whichever round observed the two halves of it.
 *
 * The bracket is narrowed from the same samples: below the first observation at or after the
 * target, and above the last observation before it.
 */
function resolveOrNarrow(s) {
  const points = [...s.seen.entries()]
    .filter(([, sample]) => sample.at !== null && sample.hash)
    .sort((a, b) => a[0] - b[0])

  for (let i = 1; i < points.length; i += 1) {
    const [height, sample] = points[i]
    const [prevHeight, prev] = points[i - 1]
    if (prevHeight !== height - 1) continue
    if (prev.at < s.target && sample.at >= s.target) {
      s.done = {
        height,
        hash: sample.hash,
        at: sample.at,
        closeHeight: prevHeight,
        closeHash: prev.hash,
        closeAt: prev.at,
      }
      return
    }
  }

  for (const [height, sample] of points) {
    if (sample.at < s.target) s.lo = Math.max(s.lo, height + 1)
    else s.hi = Math.min(s.hi, height)
  }
  // A height whose state could not be read is below every target this series asks for — the
  // chain's clock had not started — so it only ever raises the floor.
  for (const [height, sample] of s.seen) {
    if (sample.at === null) s.lo = Math.max(s.lo, height + 1)
  }
}

/**
 * Where to probe next: a secant step from the sample nearest the target in TIME, using the rate
 * measured across the widest pair of samples this target has. Falls back to the bracket's
 * midpoint, and then to the nearest unread height inside the bracket — which is what guarantees
 * every round adds a NEW observation and the loop cannot spin.
 */
function nextGuess(s, blockMs) {
  const points = [...s.seen.entries()].filter(([, sample]) => sample.at !== null).sort((a, b) => a[0] - b[0])
  if (!points.length) return midpointOrScan(s)

  // The rate is measured LOCALLY, from the two samples nearest the target. A rate averaged
  // across the whole chain is worse than useless here: Asset Hub produced twelve-second blocks
  // before the migration and six-second blocks after it, so the global average sits between the
  // two and is wrong in both halves of the range by a factor of two.
  const byCloseness = [...points].sort((a, b) => Math.abs(a[1].at - s.target) - Math.abs(b[1].at - s.target))
  const anchor = byCloseness[0]
  let rate = blockMs
  for (const other of byCloseness.slice(1)) {
    const span = Math.abs(other[0] - anchor[0])
    const elapsed = Math.abs(other[1].at - anchor[1].at)
    if (span >= 2 && elapsed > 0) {
      rate = elapsed / span
      break
    }
  }

  // A secant step is only taken when it lands INSIDE the bracket. Clamping it to the edge
  // instead is what turned a cold start into a one-block-per-round walk from block 1.
  if (Number.isFinite(rate) && rate > 0) {
    const projected = Math.round(anchor[0] + (s.target - anchor[1].at) / rate)
    if (projected >= s.lo && projected <= s.hi) {
      for (const height of [projected, projected + 1, projected - 1, projected + 2, projected - 2]) {
        if (height < s.lo || height > s.hi) continue
        if (!s.seen.has(height) || (height > 1 && !s.seen.has(height - 1))) return height
      }
    }
  }
  return midpointOrScan(s)
}

/** Bisection, and behind it a scan — the two steps that cannot fail to add a new observation. */
function midpointOrScan(s) {
  const mid = clamp(Math.floor((s.lo + s.hi) / 2), s.lo, s.hi)
  if (!s.seen.has(mid) || (mid > 1 && !s.seen.has(mid - 1))) return mid
  for (let height = s.lo; height <= s.hi; height += 1) {
    if (!s.seen.has(height) || (height > 1 && !s.seen.has(height - 1))) return height
  }
  return null
}

/** The eight samples nearest the bracket, for an error message a maintainer can act on. */
function describeSamples(s) {
  const points = [...s.seen.entries()]
    .sort((a, b) => Math.abs(a[0] - s.lo) - Math.abs(b[0] - s.lo))
    .slice(0, 8)
    .sort((a, b) => a[0] - b[0])
    .map(([height, sample]) => `${height}=${sample.at === null ? 'unreadable' : new Date(sample.at).toISOString()}`)
  return `Nearest reads: ${points.join(', ')}.`
}

/**
 * Milliseconds per block near the head, MEASURED — two reads, one per host, and only when there
 * is no cursor to carry a rate forward.
 *
 * Worth its four requests for exactly one caller: `sovereign-dot-recent`, whose targets are days
 * old rather than years old, so a rate taken at the head is the right rate for them. Asset Hub's
 * has moved from 12.5 s/block in 2022 to 2.24 s/block today, and a hint built on the wrong one
 * costs several extra search rounds per request. For a backfill reaching years back this measures
 * the wrong era and is worth nothing — which is why it is a hint and the search verifies anyway.
 */
async function headBlockMs(host, head, headAt, run, span = 20_000) {
  const from = Math.max(1, head - span)
  if (from >= head || !Number.isFinite(headAt)) return null
  const [hash] = await batchCalls(run, host, [{ method: 'chain_getBlockHash', params: [from] }], RPC_BATCH_LIGHT, 30_000)
  if (!hash) return null
  const [raw] = await batchCalls(run, host, [{ method: 'state_getStorage', params: [KEYS.timestamp, hash] }], RPC_BATCH_STATE, 30_000)
  if (!raw) return null
  const rate = (headAt - Number(littleEndian(raw, 0, 8))) / (head - from)
  return Number.isFinite(rate) && rate > 100 ? rate : null
}

/* ------------------------------------------------------------------- reading the days ---- */

/**
 * Which para ids to read on a given day. Four sources, unioned, for the same reason
 * `sovereign-dot` uses four: no single enumeration is complete, and the gaps are not the same
 * gaps. The fourth — every id seen holding an account earlier in this backfill — is what stops a
 * chain that leaves the registry mid-series from vanishing out of the chart while its sovereign
 * account still holds DOT.
 */
const topologyParaIds = (network) => CHAINS.filter((c) => c.network === network && c.paraId !== null).map((c) => c.paraId)

async function enumerateParasAt(run, net, hashes) {
  const calls = []
  for (const hash of hashes) {
    calls.push({ method: 'state_getKeysPaged', params: [KEYS.paraLifecycles, KEY_PAGE, KEYS.paraLifecycles, hash] })
    calls.push({ method: 'state_getKeysPaged', params: [KEYS.registrarParas, KEY_PAGE, KEYS.registrarParas, hash] })
  }
  const out = await batchCalls(run, net.relay, calls, 24, 60_000)
  return hashes.map((_, i) => {
    const lifecycles = out[i * 2] ?? []
    const registrar = out[i * 2 + 1] ?? []
    if (lifecycles.length >= KEY_PAGE || registrar.length >= KEY_PAGE) {
      throw new UpstreamError(
        `${net.relay.label} returned a full page of parachain registrations (${KEY_PAGE}); the enumeration for this day would be truncated and the day short.`,
        { kind: 'upstream', source: net.relay.id },
      )
    }
    return {
      lifecycles: lifecycles.map(paraIdFromKey),
      registrar: registrar.map(paraIdFromKey),
    }
  })
}

/**
 * `System::Account` for a list of para ids, at one block, for several days at once. Keys per
 * HTTP request are capped so a six-day batch is a handful of ordinary requests rather than one
 * enormous one.
 */
async function accountsAt(run, host, on, frames, idsPerDay) {
  const calls = frames.map((frame, i) => ({
    method: 'state_queryStorageAt',
    params: [[KEYS.timestamp, ...idsPerDay[i].map((id) => systemAccountKey(sovereignAccountHex(id, { on })))], frame.closeHash],
  }))
  // Group days into requests by total key count rather than by day count.
  const results = new Array(calls.length)
  let at = 0
  while (at < calls.length) {
    let keys = 0
    let end = at
    while (end < calls.length && (end === at || keys + calls[end].params[0].length <= KEYS_PER_REQUEST)) {
      keys += calls[end].params[0].length
      end += 1
    }
    const answer = await batchCalls(run, host, calls.slice(at, end), end - at, 60_000)
    for (let i = 0; i < answer.length; i += 1) results[at + i] = answer[i]
    at = end
  }
  return results.map((result) => {
    const map = new Map()
    for (const [key, value] of result?.[0]?.changes ?? []) {
      if (value !== null && value !== undefined) map.set(String(key).toLowerCase(), value)
    }
    return map
  })
}

const planck = (info) => (info ? (info.free ?? 0n) + (info.reserved ?? 0n) : null)

/**
 * One UTC day, both legs, as the payload that is actually stored.
 *
 * Amounts are exact planck as decimal STRINGS, never doubles: a post-migration sovereign holding
 * is past 2^53 planck and a JSON number would round it silently. `null` means the account does
 * not exist on that chain that day, which is a different fact from `"0"` — an account that
 * exists holding nothing — and the two must not be collapsed.
 */
function summariseDay({ net, date, relayFrame, ahFrame, ids, enumerated, relayValues, ahValues }) {
  const rows = []
  let relayTotal = 0n
  let assetHubTotal = 0n
  let withAccount = 0

  for (const id of ids) {
    const relayRaw = relayValues.get(systemAccountKey(sovereignAccountHex(id, { on: 'relay' })).toLowerCase()) ?? null
    const ahRaw = ahValues.get(systemAccountKey(sovereignAccountHex(id, { on: 'sibling' })).toLowerCase()) ?? null
    if (!relayRaw && !ahRaw) continue
    const relayAmount = relayRaw ? planck(decodeAccountInfo(relayRaw, net.relay.id)) : null
    const ahAmount = ahRaw ? planck(decodeAccountInfo(ahRaw, net.assetHub.id)) : null
    relayTotal += relayAmount ?? 0n
    assetHubTotal += ahAmount ?? 0n
    withAccount += 1
    rows.push([id, relayAmount, ahAmount])
  }

  rows.sort((a, b) => Number((b[1] ?? 0n) + (b[2] ?? 0n) - ((a[1] ?? 0n) + (a[2] ?? 0n))))
  const kept = []
  let dustChains = 0
  let dustRelay = 0n
  let dustAssetHub = 0n
  for (const row of rows) {
    const total = (row[1] ?? 0n) + (row[2] ?? 0n)
    if (total >= DUST_PLANCK && kept.length < MAX_CHAIN_ROWS) {
      kept.push([row[0], row[1] === null ? null : String(row[1]), row[2] === null ? null : String(row[2])])
    } else {
      dustChains += 1
      dustRelay += row[1] ?? 0n
      dustAssetHub += row[2] ?? 0n
    }
  }

  return {
    date,
    // Which network this day is, carried in the row rather than only in the store key. A payload
    // that does not say which chain it came from is one copy-paste away from a KSM series drawn
    // as DOT, and the divisor differs by a factor of a hundred.
    network: net.id,
    token: net.token,
    decimals: net.decimals,
    // The LAST block of the UTC day on each chain, with the chain's own clock reading for it.
    // Two chains, two blocks: a single height for both would be a claim that is true of neither.
    relay: { block: relayFrame.closeHeight, at: new Date(relayFrame.closeAt).toISOString() },
    assetHub: { block: ahFrame.closeHeight, at: new Date(ahFrame.closeAt).toISOString() },
    paras: { enumerated, read: ids.length, withAccount },
    // [paraId, relay planck | null, Asset Hub planck | null]. `null` = no such account.
    chains: kept,
    // Two reasons a chain is folded in here and both are recorded: it held less than `floor`,
    // or it fell outside the day's largest `cap` holdings. The day's `totals` still include it
    // exactly, so no sum is affected — what is lost is the ability to NAME it.
    dust: {
      chains: dustChains,
      relay: String(dustRelay),
      assetHub: String(dustAssetHub),
      floor: String(DUST_PLANCK),
      cap: MAX_CHAIN_ROWS,
    },
    totals: { relay: String(relayTotal), assetHub: String(assetHubTotal), total: String(relayTotal + assetHubTotal) },
  }
}

/**
 * A run of consecutive UTC days, on both chains.
 *
 * `hint` carries the previous day's resolved boundary and measured block count per chain, which
 * is what keeps the search to two or three rounds. It is a HINT in the strict sense: every value
 * it produces is checked against the chain's own timestamps before anything is stored.
 */
async function readSovereignDays({ net, days, run, heads, hint, sticky }) {
  const targets = days.map((day) => dayStartMs(day) + DAY_MS)

  // With no cursor there is no rate to carry forward, so one is measured at the head.
  const cold = !hint?.relay?.blocksPerDay || !hint?.assetHub?.blocksPerDay
  const measured = cold
    ? await Promise.all([
        headBlockMs(net.relay, heads.relay.block, heads.relay.timeMs, run),
        headBlockMs(net.assetHub, heads.assetHub.block, heads.assetHub.timeMs, run),
      ]).then(([relay, assetHub]) => ({ relay, assetHub }))
    : { relay: null, assetHub: null }

  const rateFor = (side) =>
    hint?.[side]?.blocksPerDay ? DAY_MS / hint[side].blocksPerDay : (measured[side] ?? DAY_MS / 14_400)

  // The hint, and nothing more than a hint: the previous batch's last resolved boundary plus
  // its own measured blocks-per-day, stepped forward. Every value it produces is checked
  // against the chain's clock in `firstBlocksAtOrAfter` before it is used for anything.
  const hintsFor = (side) => {
    const base = hint?.[side]
    const head = heads[side]
    return days.map((_, i) => {
      if (!base?.height || !base?.blocksPerDay) {
        return Math.round(head.block - (head.timeMs - targets[i]) / rateFor(side))
      }
      const daysAhead = Math.round((targets[i] - base.target) / DAY_MS)
      return base.height + daysAhead * base.blocksPerDay
    })
  }

  const [relayFrames, ahFrames] = await Promise.all([
    firstBlocksAtOrAfter(net.relay, {
      targets,
      hints: hintsFor('relay'),
      head: heads.relay.block,
      headAt: heads.relay.timeMs,
      blockMs: rateFor('relay'),
      run,
    }),
    firstBlocksAtOrAfter(net.assetHub, {
      targets,
      hints: hintsFor('assetHub'),
      head: heads.assetHub.block,
      headAt: heads.assetHub.timeMs,
      blockMs: rateFor('assetHub'),
      run,
    }),
  ])

  // THE guard. Both close blocks must carry a timestamp INSIDE the UTC day. A pruned archive
  // answers a balance query with `null`, which is indistinguishable from an empty account; it
  // cannot answer this check, because every block has a `Timestamp::Now`.
  days.forEach((day, i) => {
    const from = dayStartMs(day)
    for (const [side, frame, host] of [
      ['relay', relayFrames[i], net.relay],
      ['Asset Hub', ahFrames[i], net.assetHub],
    ]) {
      if (!frame.closeHash || frame.closeAt === null || frame.closeAt === undefined) {
        throw new UpstreamError(
          `${host.label} has no readable block at the close of ${day} (would-be block ${frame.closeHeight}). Refusing to store a day whose state could not be read — an unreadable balance is not a zero one.`,
          { kind: 'upstream', source: host.id },
        )
      }
      if (frame.closeAt < from || frame.closeAt >= from + DAY_MS) {
        throw new UpstreamError(
          `${host.label}: block ${frame.closeHeight} is dated ${new Date(frame.closeAt).toISOString()}, which is not inside ${day}. The ${side} leg of this day cannot be the day's close.`,
          { kind: 'decode', source: host.id },
        )
      }
    }
  })

  const enumerations = await enumerateParasAt(run, net, relayFrames.map((f) => f.closeHash))

  const carried = new Set(sticky ?? [])
  const idsPerDay = enumerations.map((row) => {
    const ids = new Set([...row.lifecycles, ...row.registrar, ...topologyParaIds(net.id), ...carried])
    return [...ids].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b)
  })

  const [relayValues, ahValues] = await Promise.all([
    accountsAt(run, net.relay, 'relay', relayFrames, idsPerDay),
    accountsAt(run, net.assetHub, 'sibling', ahFrames, idsPerDay),
  ])

  const payloads = days.map((day, i) =>
    summariseDay({
      net,
      date: day,
      relayFrame: relayFrames[i],
      ahFrame: ahFrames[i],
      ids: idsPerDay[i],
      enumerated: new Set([...enumerations[i].lifecycles, ...enumerations[i].registrar]).size,
      relayValues: relayValues[i],
      ahValues: ahValues[i],
    }),
  )

  // The sticky set: any id that had an account today is read again tomorrow, whatever the
  // relay's registration storage says about it by then.
  const nextSticky = new Set(carried)
  for (const payload of payloads) {
    for (const row of payload.chains) nextSticky.add(row[0])
  }

  const last = days.length - 1
  return {
    payloads,
    sticky: [...nextSticky].sort((a, b) => a - b),
    hint: {
      relay: {
        height: relayFrames[last].height,
        target: targets[last],
        blocksPerDay: days.length > 1 ? Math.round((relayFrames[last].height - relayFrames[0].height) / (days.length - 1)) : hint?.relay?.blocksPerDay ?? null,
      },
      assetHub: {
        height: ahFrames[last].height,
        target: targets[last],
        blocksPerDay: days.length > 1 ? Math.round((ahFrames[last].height - ahFrames[0].height) / (days.length - 1)) : hint?.assetHub?.blocksPerDay ?? null,
      },
    },
  }
}

/**
 * Both chains' finalized heads, and the two assertions that make the pair usable.
 *
 * The first is the canary the network table exists for: each chain must report the token and the
 * decimals this network says it has. It catches three failures that all render perfectly — the
 * two legs summed across different units, a hostname that resolves to the wrong chain (this repo
 * has already had one: `rpc-composable.luckyfriday.io` serving Centrifuge), and a Kusama figure
 * divided by Polkadot's 1e10, which is exactly 100× too large.
 */
async function netflowsHeads(run, net) {
  const [relay, assetHub] = await Promise.all([
    run(net.relay, () => pin(net.relay)),
    run(net.assetHub, () => pin(net.assetHub)),
  ])
  for (const chain of [relay, assetHub]) {
    if (chain.tokenSymbol !== net.token || chain.tokenDecimals !== net.decimals) {
      throw new UpstreamError(
        `${chain.host.label} reports its native token as ${chain.tokenSymbol}/${chain.tokenDecimals}, not ${net.token}/${net.decimals}. Either this is not the chain it claims to be, or the two legs of this series are denominated differently and cannot be summed.`,
        { kind: 'upstream', source: chain.host.id },
      )
    }
    if (chain.timeMs === null) {
      throw new UpstreamError(`${chain.host.label} served a finalized head with no \`Timestamp::Now\`.`, {
        kind: 'upstream',
        source: chain.host.id,
      })
    }
  }
  return { relay, assetHub }
}

/**
 * How an upstream call is made, and it is the ONLY difference between the job and the live
 * operation below. Inside a job every call goes through the engine's politeness gate — one
 * in-flight request per host, across every job on the machine. Outside one there is no gate to
 * go through, and the TTL cache is what keeps the request rate down instead.
 */
const hostnameOf = (url) => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const gatedRun = (gate) => (host, fn) => gate(hostnameOf(host.url), fn)
const directRun = (host, fn) => fn()

/* ------------------------------------------------------------- operation: the live tail ---- */

/**
 * The most recent CLOSED UTC days, by the same method and in the same payload shape as the
 * stored months.
 *
 * This exists because of the cost the month bucket imposes, stated here rather than discovered:
 * a store identity of `{month}` cannot serve the current month at all — a job that reached
 * `done` frees nothing, so "everything up to now" can never be an identity. The page therefore
 * reads whole past months from the store and this operation for the tail, and the seam between
 * them is at most one month wide and moves to zero on the first of every month.
 *
 * Today itself is deliberately absent. A day's value here is its CLOSE, and today has not
 * closed; `sovereign-dot` is the operation that answers "right now".
 */
async function sovereignDotRecent({ days, network }) {
  const net = netflowNetwork(network)
  const heads = await netflowsHeads(directRun, net)

  // The last day that has ENDED on both chains. Both, not either: a day whose Asset Hub close
  // has not happened yet would be half a reading.
  const edge = Math.min(heads.relay.timeMs, heads.assetHub.timeMs)
  const lastClosed = addDaysIso(isoDay(edge), -1)
  const firstDay = `${net.firstMonth}-01`

  const wanted = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addDaysIso(lastClosed, -i)
    if (day >= firstDay) wanted.push(day)
  }

  const meta = () => ({
    network: net.id,
    token: net.token,
    decimals: net.decimals,
    migratedOn: net.migratedOn,
    firstMonth: net.firstMonth,
    relay: chainMeta(heads.relay),
    assetHub: chainMeta(heads.assetHub),
    fetchedAt: new Date().toISOString(),
    meta: { liveness: [livenessOf(heads.assetHub), livenessOf(heads.relay)] },
  })

  if (!wanted.length) {
    return {
      days: [],
      first: null,
      last: null,
      requested: days,
      ...meta(),
      notes: [`Neither chain has closed a UTC day at or after ${firstDay}, which is where this series begins.`],
    }
  }

  const { payloads } = await readSovereignDays({ net, days: wanted, run: directRun, heads, hint: null, sticky: [] })

  return {
    days: payloads,
    first: wanted[0],
    last: wanted[wanted.length - 1],
    requested: days,
    ...meta(),
    notes: netflowsNotes({ net, payloads, first: wanted[0], last: wanted[wanted.length - 1], live: true }),
  }
}

/**
 * How wrong the OTHER network's divisor would be here, computed from the table rather than
 * asserted, so it stays true if a third network is ever added.
 */
function otherDivisorNote(net) {
  const others = NETFLOW_NETWORK_IDS.filter((id) => id !== net.id).map((id) => NETFLOW_NETWORKS[id])
  const worst = others.reduce((max, other) => Math.max(max, Math.abs(other.decimals - net.decimals)), 0)
  if (!worst) return 'Every network this series covers uses the same number of decimals.'
  return `Scaling these by another network's divisor is a factor of ${(10 ** worst).toLocaleString('en-US')} that renders perfectly.`
}

/**
 * The caveats that come out of the payload itself, so they cannot describe a different reading
 * than the one on screen.
 */
function netflowsNotes({ net, payloads, first, last, live }) {
  const notes = [
    `Each day is the state at that UTC day's LAST BLOCK on each chain — its close, not its open. That is the same definition the archived 2021–2023 dataset uses, and reading it at 00:00 instead would shift this series one day earlier against that file and read as a genuine lead rather than as an off-by-one.`,
    `A chain's figure is the SUM of two accounts on two chains: \`para\` on ${net.label} and \`sibl\` on ${net.label} Asset Hub, read at two different blocks because they are two different chains. Both legs are kept separately in the payload — the Asset Hub Migration on ${net.migratedOn} moved the money from one to the other, and a series that reported only the sum would hide the largest structural break in it.`,
    `Amounts are exact planck as decimal strings, and ${net.token} is ${net.decimals} decimals. ${otherDivisorNote(net)} \`null\` means the account does not exist on that chain that day, which is not the same fact as \`"0"\` — an account that exists holding nothing — and the two are never collapsed.`,
  ]
  const dusty = payloads.filter((day) => day.dust.chains > 0)
  if (dusty.length) {
    const most = Math.max(...dusty.map((day) => day.dust.chains))
    // The floor comes out of the payload, never out of the constant: the same planck figure is
    // 1 DOT and 0.01 KSM, and a note that said "1 token" would be wrong on one of them.
    const floor = Number(BigInt(payloads[0].dust.floor)) / 10 ** net.decimals
    notes.push(
      `Chains holding less than ${floor} ${net.token} on a given day are summed into that day's single \`dust\` row rather than listed — up to ${most} of them on one day here. The day's totals still include them exactly, so nothing is lost from any sum; what is lost is the ability to name a chain that held under ${floor} ${net.token}.`,
    )
  }
  notes.push(
    `Which chains are read on a day is the union of four enumerations at that day's own block: ${net.label}'s \`Paras::ParaLifecycles\`, its \`Registrar::Paras\`, this site's own topology registry for ${net.label}, and every chain already seen holding an account earlier in the same fetch. No single one of them is complete — on Polkadot, para 2004 is in neither relay item today and still holds DOT.`,
  )
  if (live) {
    notes.push(
      `This is the live tail, computed on request and cached for thirty minutes. Whole past months come from the store instead, fetched once and never again; ${first} to ${last} is the part that is not a whole month yet.`,
    )
  }
  return notes
}

/* --------------------------------------------- operation: the whole series, one request ---- */

/**
 * Every settled month of one network's daily series, in ONE response — the read-layer answer to
 * research queue O41 (decision 0020). The month bucket stays the storage identity, exactly as
 * decision 0012 chose it; what changes is that a page no longer turns that identity into one
 * HTTP request per month. Fifty-six requests per load was fine until the edge rate limit
 * (30/min per IP, docs/architecture/security.md) started answering the page's own tail with
 * 429s — the page was DoSing itself, politely, through its own front door.
 *
 * Each month is served through `serveFromStore` — a function call now instead of an HTTP
 * request, and deliberately the SAME function: find-or-create, the reader-priority raise, the
 * gave-up refusal, the live-jobs cap and the settle predicate all apply to this one GET exactly
 * as they applied to the fifty-six. One aggregate read can therefore mint at most
 * MAX_LIVE_JOBS_PER_OPERATION jobs, same as one page load could before.
 *
 * The per-month entry carries `{ data, coverage, job }` byte-compatible with the single-month
 * envelope, so the page's series shaper reads both shapes with one code path — and so a month
 * that later arrives over the identity-watch stream (the same envelope again) drops into place
 * without translation.
 */
async function netflowsSeries({ network }, { store, queue, startWorker }) {
  const net = netflowNetwork(network)
  const months = []
  let incomplete = 0
  let stalled = 0
  for (const month of netflowsSettledMonths(network)) {
    const answer = await serveFromStore({
      store,
      queue,
      sourceId: 'asset-hub',
      operationId: 'netflows-daily',
      params: { month, network },
      handler: NETFLOWS_DAILY,
      startWorker,
    })
    if (answer.status !== 200) {
      // Defensive only: the settle predicate admitted this month moments ago, so a refusal here
      // needs the clock to have crossed backwards between the two reads. Kept because the cost
      // of the branch is nil and the cost of an uncaught non-envelope answer is a page that
      // cannot draw. (The REAL month-boundary behaviour is the `pending` field below, not this.)
      months.push({ month, data: [], coverage: { complete: false, segments: 0, note: answer.body?.error?.message ?? 'Refused.' }, job: null })
      incomplete += 1
      continue
    }
    const { data, coverage, job } = answer.body
    months.push({ month, data, coverage, job })
    if (!coverage.complete) incomplete += 1
    if (job?.state === 'gave-up') stalled += 1
    // A month under 512 rows never trips readFacts' own yield, so without this the whole
    // composition — fifty-five reads and their decoding — runs as ONE macrotask on the HTTP
    // thread. One yield per month keeps every other request interleaved.
    await new Promise((resolve) => setImmediate(resolve))
  }

  // The month that has ENDED but not yet SETTLED — for one hour after each month boundary the
  // newest whole month is in nobody's list: too old for the live tail (which serves only the
  // current month's days), too young for the store. Saying so is what stops that hour reading
  // as "the series just got a month shorter". The page prints this; it must not infer it.
  const now = Date.now()
  const lastEnded = isoDay(now - DAY_MS).slice(0, 7)
  const pending =
    lastEnded !== isoDay(now).slice(0, 7) && !netflowsMonthIsSettled({ month: lastEnded, network }, now) ? lastEnded : null

  const complete = incomplete === 0
  return {
    complete,
    body: {
      network: net.id,
      token: net.token,
      decimals: net.decimals,
      firstMonth: net.firstMonth,
      migratedOn: net.migratedOn,
      months,
      coverage: {
        complete,
        months: months.length,
        incomplete,
        stalled,
        pending,
        note: complete
          ? `Complete: all ${months.length} settled months of the ${net.token} series are stored. Immutable data is fetched once and never again.` +
            (pending ? ` ${pending} ended less than an hour ago and is not yet fetchable; it will appear here once it settles.` : '')
          : `Partial: ${months.length - incomplete} of ${months.length} settled months are stored.` +
            (stalled
              ? ` ${stalled} of the missing month${stalled === 1 ? '' : 's'} ${stalled === 1 ? 'has' : 'have'} surrendered after repeated failures and will NOT land without a maintainer — the rest are being fetched.`
              : '') +
            ` Each incomplete month's own coverage says what is being done about it; subscribe to /api/stream/asset-hub/netflows-daily to be handed each month as it lands, or re-ask this endpoint.`,
      },
      // Where to subscribe for the rest. Published in the payload rather than documented,
      // so the page never has to derive the stream URL — rule: the server names its own doors.
      stream: complete ? null : '/api/stream/asset-hub/netflows-daily',
    },
  }
}

/* ═════════════════════════════════════════════════ the DOT whale cohort's daily series ═════ */
//
// The netflows treatment, generalised from sovereign accounts to arbitrary holders: the same
// boundary search, the same batching, the same guards, a different set of keys. What is NOT the
// same is where the account list comes from, and that is decision 0021's whole subject.
//
// ── discovery is an INPUT, measurement is an upstream ────────────────────────────────────────
// No upstream this repo may use serves "accounts ranked by balance" — the chain indexes
// `System::Account` by key, Dotlake has no balance endpoint, SQD carries events and not state,
// and the explorers that do rank holders put it behind a key (rule 1). So WHICH accounts to
// watch is seeded once, by a human, from Subscan's public holder list, and committed to
// `src/data/dot-whales.json` with its date and its provenance on it — the same standing as the
// 2021–2023 archive in `src/data/netflows.json`. WHAT they hold is read from the chains here and
// only here. The seed could vanish tomorrow and nothing on this site would break or notice.
//
// The consequence the page must state, because the payload cannot hide it: the cohort is TODAY'S
// whales, so the series answers "what did today's whales hold on each past day". An account that
// was large in 2023 and exited before 2026-08-21 is invisible by construction. That is
// survivorship, not error, and it is only honest if it is said out loud.
//
// ── two legs, again, and the near-empty one is correct ───────────────────────────────────────
// Every day is read on BOTH chains at that day's own close, exactly as the sovereign series is,
// because the Asset Hub Migration (2025-11-04 on Polkadot) moved user balances relay → Asset Hub
// progressively. Before it the relay leg carries essentially the whole cohort and the Asset Hub
// leg nearly nothing; after it the reverse — the relay's whole `System::Account` map holds 1,493
// accounts and 220,772 DOT today (docs/platform/asset-hub.md). Both legs are stored separately so
// the handover is drawn rather than asserted through.

/** Stamped on every stored row. Bump when the payload's meaning changes. */
const WHALES_VERSION = 'asset-hub/whales-daily@1'

/**
 * The cohort implies the network: `dot-whales.json` is a Polkadot Asset Hub reading, so there is
 * no `network` parameter here — one would be a second identity for a question with one answer.
 * The Polkadot row of the netflows table is reused rather than restated so that the token and
 * decimals canary in `netflowsHeads` (DOT/10, asserted against `system_properties` on both hosts
 * on every read) covers this series too.
 */
const WHALES_NET = NETFLOW_NETWORKS.polkadot

/**
 * The first whole month both chains can answer for — Polkadot's netflows floor, and it is the
 * same constraint rather than a coincidence: Asset Hub has state but no `Timestamp::Now` below
 * #305,204 (2021-12-18T18:52:54.582Z), which looks exactly like a pruned archive.
 */
const WHALES_FIRST_MONTH = WHALES_NET.firstMonth

/** How many of the cohort's largest holdings the stored per-day header sums. */
const WHALES_TOP = 10

/**
 * The committed cohort, read once at import. Parsed here rather than `import`ed so this stays a
 * plain Node module with no JSON-module flag, and so a malformed file is a startup error naming
 * the file rather than a syntax error naming the loader.
 */
const WHALE_COHORT_FILE = JSON.parse(readFileSync(new URL('../../src/data/dot-whales.json', import.meta.url), 'utf8'))

/**
 * The schema's `oneOf`, derived from the file rather than written beside it. A hardcoded list
 * that drifted from the file would refuse the only cohort that exists — or, worse, accept a
 * cohort id whose accounts are somebody else's.
 */
const WHALE_COHORT_IDS = [WHALE_COHORT_FILE.cohort]

let whaleCohortMemo = null

/**
 * The cohort, verified — decoders self-check, and a committed dataset is a decoder's input.
 *
 * Four checks, each catching something that would otherwise render perfectly:
 *
 *   · `accountHex` must be 64 lowercase hex characters. `fromHex` returns an EMPTY array for
 *     anything else, so a stray `0x`, an uppercase digit or a truncated row would produce a
 *     storage key for the empty account — a valid-looking key that matches nothing, i.e. a whale
 *     that reads as holding zero on every day of the series.
 *   · The SS58 `address` must be what that hex encodes at prefix 0. The two fields are redundant
 *     on purpose: the hex is what we query with and the address is what a page will show, and a
 *     mismatched pair would attribute one account's balance to another's name.
 *   · The keys must be distinct. A duplicated account is counted twice in every total.
 *   · The file's own `cohortPlanck` must equal the sum of its rows. This is the arithmetic canary
 *     for the whole series: it is the number today's totals are compared against, and a file that
 *     lost rows in an edit would move the benchmark along with the data, silently.
 *
 * Lazy and memoised: 990 blake2b hashes at import time would be paid by every `npm run check`
 * and every process boot for a series nobody may ask for.
 *
 * Exported for `server/test/whales-series.test.mjs`, which checks the day arithmetic below
 * against the REAL cohort without touching a chain.
 */
export function whaleCohort() {
  if (whaleCohortMemo) return whaleCohortMemo

  const file = WHALE_COHORT_FILE
  const accounts = file?.accounts
  const fail = (message) => {
    throw new UpstreamError(`src/data/dot-whales.json: ${message}`, { kind: 'decode', source: 'asset-hub' })
  }
  if (typeof file?.cohort !== 'string' || !file.cohort) fail('has no `cohort` id, which is the store identity.')
  if (!Array.isArray(accounts) || accounts.length === 0) fail('has no `accounts`.')

  const keys = []
  const indexOfKey = new Map()
  let summed = 0n
  accounts.forEach((account, index) => {
    const hex = account?.accountHex
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
      fail(`row ${index} (rank ${account?.rank}) has \`accountHex\` \`${hex}\`, which is not 64 lowercase hex characters. fromHex would answer an empty array and the key would match nothing.`)
    }
    const address = encodeSs58(fromHex(hex), 0)
    if (address !== account?.address) {
      fail(`row ${index} says \`${account?.address}\` but its \`accountHex\` encodes \`${address}\` at prefix 0. One of the two names a different account.`)
    }
    const key = systemAccountKey(hex).toLowerCase()
    if (indexOfKey.has(key)) fail(`rows ${indexOfKey.get(key)} and ${index} are the same account, which would be counted twice in every total.`)
    indexOfKey.set(key, index)
    keys.push(key)
    summed += BigInt(account.free ?? 0) + BigInt(account.reserved ?? 0)
  })

  if (file.cohortPlanck !== undefined && String(file.cohortPlanck) !== String(summed)) {
    fail(`declares \`cohortPlanck\` ${file.cohortPlanck} but its ${accounts.length} rows sum to ${summed}. The published benchmark and the data disagree.`)
  }

  whaleCohortMemo = {
    id: file.cohort,
    accounts,
    keys,
    indexOfKey,
    seededAt: file.readAt ?? null,
    seedBlock: file.blockNumber ?? null,
    seedPlanck: String(summed),
    seedIssuancePlanck: file.totalIssuancePlanck ?? null,
    seed: file.seed ?? null,
  }
  return whaleCohortMemo
}

/** The cohort, or a throw. Never a default — a wrong cohort id must not silently become this one. */
function whaleCohortOf(id) {
  const cohort = whaleCohort()
  if (id !== cohort.id) {
    throw new UpstreamError(`\`cohort\` must be one of: ${WHALE_COHORT_IDS.join(', ')} — got \`${id}\`.`, {
      kind: 'decode',
      source: 'asset-hub',
    })
  }
  return cohort
}

/**
 * The settle predicate, and the same total-by-construction rule as `netflowsMonthIsSettled`:
 * anything unparseable, an unknown cohort, a month before the floor, or a month not yet finished
 * is NOT immutable and is refused before a job exists.
 *
 * The cohort id is checked against the committed file, not merely against a pattern: a job minted
 * for a cohort that does not exist would fetch nothing forever, and a job minted for a cohort id
 * that later gets REUSED for a different account list would answer with somebody else's whales.
 */
export function whalesMonthIsSettled(params, now = Date.now()) {
  const month = params?.month
  if (params?.cohort !== WHALE_COHORT_IDS[0]) return false
  if (typeof month !== 'string' || !NETFLOWS_MONTH_RE.test(month)) return false
  if (month < WHALES_FIRST_MONTH) return false
  return now >= monthEndMs(month) + NETFLOWS_SETTLE_MS
}

/**
 * Every month the store can answer for, oldest first. THE month list: `warm()` enqueues it,
 * `whales-series` reads it, the identity watch validates against the same predicate. Two
 * derivations that disagree by one entry produce a page permanently missing its newest month
 * with no error anywhere.
 */
function whalesSettledMonths(cohortId, now = Date.now()) {
  const cohort = whaleCohortOf(cohortId)
  const months = []
  const ceiling = new Date(now).getUTCFullYear()
  for (let year = Number(WHALES_FIRST_MONTH.slice(0, 4)); year <= ceiling; year += 1) {
    for (let index = 1; index <= 12; index += 1) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (!whalesMonthIsSettled({ month, cohort: cohort.id }, now)) continue
      months.push(month)
    }
  }
  return months
}

/**
 * The cohort's `System::Account` values at one block per day, on one chain.
 *
 * The keys are identical on both chains — `System::Account` is `System::Account` — so they are
 * built once, by `whaleCohort()`, and used for the relay and for Asset Hub alike.
 *
 * Chunked by KEYS_PER_REQUEST across the whole batch rather than per day: 990 keys is more than
 * one request's worth on its own, so a day is four requests and ten days are forty, per chain.
 * A missing key in the answer is an account that does not exist at that block — which, at a
 * block that DID produce a timestamp, genuinely means it held nothing. That is the whole force of
 * the close-block guard below: without it, `null` from a pruned archive and `null` from an empty
 * account are the same bytes.
 */
async function whaleValuesAt(run, host, frames, keys) {
  const calls = []
  const owner = []
  frames.forEach((frame, day) => {
    for (let i = 0; i < keys.length; i += KEYS_PER_REQUEST) {
      calls.push({ method: 'state_queryStorageAt', params: [keys.slice(i, i + KEYS_PER_REQUEST), frame.closeHash] })
      owner.push(day)
    }
  })

  // Group sub-calls into HTTP requests by TOTAL key count, never by call count: a batch of ten
  // 300-key queries is three thousand keys in one POST against somebody else's free endpoint.
  const results = new Array(calls.length)
  let at = 0
  while (at < calls.length) {
    let keyed = 0
    let end = at
    while (end < calls.length && (end === at || keyed + calls[end].params[0].length <= KEYS_PER_REQUEST)) {
      keyed += calls[end].params[0].length
      end += 1
    }
    const answer = await batchCalls(run, host, calls.slice(at, end), end - at, 90_000)
    for (let i = 0; i < answer.length; i += 1) results[at + i] = answer[i]
    at = end
  }

  const maps = frames.map(() => new Map())
  results.forEach((result, i) => {
    for (const [key, value] of result?.[0]?.changes ?? []) {
      if (value !== null && value !== undefined) maps[owner[i]].set(String(key).toLowerCase(), value)
    }
  })
  return maps
}

/**
 * One UTC day, both legs, as the payload that is actually stored.
 *
 * SPARSE by construction: an account holding nothing on a chain is omitted from that chain's
 * list rather than written as a zero. Pre-migration the Asset Hub side is nearly empty and
 * post-migration the relay side is, so a dense 990-row pair would be mostly zeroes — about twice
 * the bytes to say the same thing on every one of ~1,700 days.
 *
 * Amounts are exact planck as decimal STRINGS. A whale's holding is past 2^53 planck on the first
 * row of the cohort, and a JSON number would round it silently.
 *
 * The day's header is computed HERE, at fetch time, and stored beside the detail. `whales-series`
 * composes fifty-five months of it and must never have to open the detail to do so: 55 × ~31 ×
 * 990 rows is tens of megabytes through one HTTP response.
 *
 * Exported so the arithmetic — which is what every figure on a whales page will be — can be
 * checked against synthetic `AccountInfo` blobs with no chain in the loop. A sum that is wrong by
 * one account renders perfectly.
 */
export function summariseWhaleDay({ cohort, date, relayFrame, ahFrame, relayValues, ahValues }) {
  const relayRows = []
  const ahRows = []
  const combined = []
  let relayPlanck = 0n
  let ahPlanck = 0n
  let nonzero = 0

  cohort.keys.forEach((key, index) => {
    let total = 0n
    for (const [rows, values, host, add] of [
      [relayRows, relayValues, WHALES_NET.relay, (n) => { relayPlanck += n }],
      [ahRows, ahValues, WHALES_NET.assetHub, (n) => { ahPlanck += n }],
    ]) {
      const raw = values.get(key)
      if (!raw) continue
      const info = decodeAccountInfo(raw, host.id)
      const held = info.free + info.reserved
      if (held <= 0n) continue
      rows.push([index, String(info.free), String(info.reserved)])
      add(held)
      total += held
    }
    if (total > 0n) {
      nonzero += 1
      combined.push(total)
    }
  })

  combined.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  let top = 0n
  for (const amount of combined.slice(0, WHALES_TOP)) top += amount

  return {
    date,
    cohort: cohort.id,
    network: WHALES_NET.id,
    token: WHALES_NET.token,
    decimals: WHALES_NET.decimals,
    accounts: cohort.accounts.length,
    // The LAST block of the UTC day on each chain, with that chain's own clock reading for it.
    relay: { block: relayFrame.closeHeight, at: new Date(relayFrame.closeAt).toISOString() },
    assetHub: { block: ahFrame.closeHeight, at: new Date(ahFrame.closeAt).toISOString() },
    // The header `whales-series` reads. Everything in it is derived from the detail below at the
    // moment the detail was decoded, so the two can never describe different readings.
    aggregate: {
      sumPlanck: String(relayPlanck + ahPlanck),
      relayPlanck: String(relayPlanck),
      ahPlanck: String(ahPlanck),
      nonzero,
      top10Planck: String(top),
      top: WHALES_TOP,
    },
    // [cohort index, free planck, reserved planck] for every account holding something. Absent =
    // held nothing at that block on that chain.
    holders: { relay: relayRows, assetHub: ahRows },
  }
}

/**
 * A run of consecutive UTC days, on both chains. The sovereign series' `readSovereignDays`
 * without the four-source para enumeration — the account list is fixed, which is what makes the
 * cohort cheap to read and is also exactly what the survivorship caveat is about.
 */
async function readWhaleDays({ cohort, days, run, heads, hint }) {
  const targets = days.map((day) => dayStartMs(day) + DAY_MS)

  const cold = !hint?.relay?.blocksPerDay || !hint?.assetHub?.blocksPerDay
  const measured = cold
    ? await Promise.all([
        headBlockMs(WHALES_NET.relay, heads.relay.block, heads.relay.timeMs, run),
        headBlockMs(WHALES_NET.assetHub, heads.assetHub.block, heads.assetHub.timeMs, run),
      ]).then(([relay, assetHub]) => ({ relay, assetHub }))
    : { relay: null, assetHub: null }

  const rateFor = (side) =>
    hint?.[side]?.blocksPerDay ? DAY_MS / hint[side].blocksPerDay : (measured[side] ?? DAY_MS / 14_400)

  const hintsFor = (side) => {
    const base = hint?.[side]
    const head = heads[side]
    return days.map((_, i) => {
      if (!base?.height || !base?.blocksPerDay) {
        return Math.round(head.block - (head.timeMs - targets[i]) / rateFor(side))
      }
      const daysAhead = Math.round((targets[i] - base.target) / DAY_MS)
      return base.height + daysAhead * base.blocksPerDay
    })
  }

  const [relayFrames, ahFrames] = await Promise.all([
    firstBlocksAtOrAfter(WHALES_NET.relay, {
      targets,
      hints: hintsFor('relay'),
      head: heads.relay.block,
      headAt: heads.relay.timeMs,
      blockMs: rateFor('relay'),
      run,
    }),
    firstBlocksAtOrAfter(WHALES_NET.assetHub, {
      targets,
      hints: hintsFor('assetHub'),
      head: heads.assetHub.block,
      headAt: heads.assetHub.timeMs,
      blockMs: rateFor('assetHub'),
      run,
    }),
  ])

  // THE guard, unchanged and not weakened: both close blocks must carry a timestamp INSIDE the
  // UTC day. A pruned archive answers a balance query with `null`, which is indistinguishable
  // from an empty account — and here that would be 990 empty accounts, a day of zero whales
  // drawn as a real reading.
  days.forEach((day, i) => {
    const from = dayStartMs(day)
    for (const [side, frame, host] of [
      ['relay', relayFrames[i], WHALES_NET.relay],
      ['Asset Hub', ahFrames[i], WHALES_NET.assetHub],
    ]) {
      if (!frame.closeHash || frame.closeAt === null || frame.closeAt === undefined) {
        throw new UpstreamError(
          `${host.label} has no readable block at the close of ${day} (would-be block ${frame.closeHeight}). Refusing to store a day whose state could not be read — an unreadable balance is not a zero one.`,
          { kind: 'upstream', source: host.id },
        )
      }
      if (frame.closeAt < from || frame.closeAt >= from + DAY_MS) {
        throw new UpstreamError(
          `${host.label}: block ${frame.closeHeight} is dated ${new Date(frame.closeAt).toISOString()}, which is not inside ${day}. The ${side} leg of this day cannot be the day's close.`,
          { kind: 'decode', source: host.id },
        )
      }
    }
  })

  const [relayValues, ahValues] = await Promise.all([
    whaleValuesAt(run, WHALES_NET.relay, relayFrames, cohort.keys),
    whaleValuesAt(run, WHALES_NET.assetHub, ahFrames, cohort.keys),
  ])

  const payloads = days.map((day, i) =>
    summariseWhaleDay({
      cohort,
      date: day,
      relayFrame: relayFrames[i],
      ahFrame: ahFrames[i],
      relayValues: relayValues[i],
      ahValues: ahValues[i],
    }),
  )

  const last = days.length - 1
  return {
    payloads,
    hint: {
      relay: {
        height: relayFrames[last].height,
        target: targets[last],
        blocksPerDay: days.length > 1 ? Math.round((relayFrames[last].height - relayFrames[0].height) / (days.length - 1)) : hint?.relay?.blocksPerDay ?? null,
      },
      assetHub: {
        height: ahFrames[last].height,
        target: targets[last],
        blocksPerDay: days.length > 1 ? Math.round((ahFrames[last].height - ahFrames[0].height) / (days.length - 1)) : hint?.assetHub?.blocksPerDay ?? null,
      },
    },
  }
}

/**
 * The day header, read out of a stored fact — defensively, because a fact written by an older
 * `codeVersion` is still in the store and must not become a zero.
 *
 * `null` is not `0` here and it matters: a day whose header cannot be read is a day this endpoint
 * could not summarise, which draws as a gap. A zero would draw as "the whales held nothing".
 */
function whaleDayHeader(fact) {
  const payload = fact?.payload ?? {}
  const aggregate = payload.aggregate ?? {}
  const value = (name) => (aggregate[name] === undefined ? null : aggregate[name])
  return {
    day: payload.date ?? fact?.segment ?? null,
    relayBlock: payload.relay?.block ?? null,
    assetHubBlock: payload.assetHub?.block ?? null,
    sumPlanck: value('sumPlanck'),
    relayPlanck: value('relayPlanck'),
    ahPlanck: value('ahPlanck'),
    nonzero: value('nonzero'),
    top10Planck: value('top10Planck'),
  }
}

/**
 * Every settled month of the cohort's daily series, in ONE response — the same shape as
 * `netflows-series` (decision 0020) and served through the same `serveFromStore`, so the bounds
 * are identical: find-or-create, the reader-priority raise, the gave-up refusal, the live-jobs
 * cap and the settle predicate all apply to this one GET.
 *
 * The one deliberate difference from `netflowsSeries`, and it is the reason this endpoint can
 * exist at all: the per-month entry carries `days` — the stored HEADERS — not `data`, the stored
 * facts. A month of this series is ~990 rows × 31 days of per-account detail; fifty-five of them
 * in one response is tens of megabytes, which is not a page, it is an outage. The detail is
 * composed and DISCARDED month by month, so peak memory is one month. A future per-account
 * endpoint reads the same store by month and hands back the detail for the accounts asked for.
 */
async function whalesSeries({ cohort: cohortId }, { store, queue, startWorker }) {
  const cohort = whaleCohortOf(cohortId)
  const months = []
  let incomplete = 0
  let stalled = 0
  for (const month of whalesSettledMonths(cohort.id)) {
    const answer = await serveFromStore({
      store,
      queue,
      sourceId: 'asset-hub',
      operationId: 'whales-daily',
      params: { month, cohort: cohort.id },
      handler: WHALES_DAILY,
      startWorker,
    })
    if (answer.status !== 200) {
      // Defensive only, exactly as in `netflowsSeries`: the settle predicate admitted this month
      // moments ago. Kept because an uncaught non-envelope answer is a page that cannot draw.
      months.push({ month, days: [], coverage: { complete: false, segments: 0, note: answer.body?.error?.message ?? 'Refused.' }, job: null })
      incomplete += 1
      continue
    }
    const { data, coverage, job } = answer.body
    months.push({ month, days: (data ?? []).map(whaleDayHeader), coverage, job })
    if (!coverage.complete) incomplete += 1
    if (job?.state === 'gave-up') stalled += 1
    // One yield per month. Without it the whole composition — fifty-five store reads and their
    // decoding — runs as ONE macrotask on the HTTP thread, and this series' facts are an order of
    // magnitude larger than netflows', so the block would be too.
    await new Promise((resolve) => setImmediate(resolve))
  }

  const now = Date.now()
  const lastEnded = isoDay(now - DAY_MS).slice(0, 7)
  const pending =
    lastEnded !== isoDay(now).slice(0, 7) && !whalesMonthIsSettled({ month: lastEnded, cohort: cohort.id }, now) ? lastEnded : null

  const complete = incomplete === 0
  return {
    complete,
    body: {
      cohort: cohort.id,
      network: WHALES_NET.id,
      token: WHALES_NET.token,
      decimals: WHALES_NET.decimals,
      firstMonth: WHALES_FIRST_MONTH,
      migratedOn: WHALES_NET.migratedOn,
      accounts: cohort.accounts.length,
      // The seed's provenance, in the payload, because the page is required to state it and must
      // not have to carry its own copy of a date that lives in a committed file.
      seed: { source: cohort.seed, readAt: cohort.seededAt, block: cohort.seedBlock, cohortPlanck: cohort.seedPlanck },
      months,
      coverage: {
        complete,
        months: months.length,
        incomplete,
        stalled,
        pending,
        note: complete
          ? `Complete: all ${months.length} settled months of the ${cohort.id} whale cohort are stored. Immutable data is fetched once and never again.` +
            (pending ? ` ${pending} ended less than an hour ago and is not yet fetchable; it will appear here once it settles.` : '')
          : `Partial: ${months.length - incomplete} of ${months.length} settled months are stored.` +
            (stalled
              ? ` ${stalled} of the missing month${stalled === 1 ? '' : 's'} ${stalled === 1 ? 'has' : 'have'} surrendered after repeated failures and will NOT land without a maintainer — the rest are being fetched.`
              : '') +
            ` Each incomplete month's own coverage says what is being done about it; subscribe to /api/stream/asset-hub/whales-daily to be handed each month as it lands, or re-ask this endpoint.`,
      },
      // What this series cannot see, stated from the data rather than from a page's memory.
      notes: [
        `Each day is the state at that UTC day's LAST BLOCK on each chain — its close, not its open — read as \`System::Account\` for all ${cohort.accounts.length} cohort accounts on the Polkadot relay chain AND on Asset Hub, at two different blocks because they are two different chains.`,
        `The cohort is SEEDED and dated: the ${cohort.accounts.length} accounts are the top DOT holders on ${cohort.seededAt ? cohort.seededAt.slice(0, 10) : cohort.id}, and this series therefore answers "what did today's whales hold on each past day". An account that was large earlier and exited before then is invisible here by construction. ${cohort.seed ?? ''}`.trim(),
        `Amounts are exact planck as decimal strings, \`top10Planck\` is the sum of the ${WHALES_TOP} largest holdings that day, and ${WHALES_NET.token} is ${WHALES_NET.decimals} decimals. An account absent from a day's detail held nothing at that block — the day itself is refused outright if either chain's close block cannot produce a timestamp inside the day, so "unreadable" never reaches the store as "zero".`,
        `The Asset Hub Migration on ${WHALES_NET.migratedOn} moved user balances from the relay chain to Asset Hub. Before it the relay leg carries nearly the whole cohort and the Asset Hub leg nearly nothing; afterwards the reverse. Both legs are stored separately, so the handover is drawn rather than asserted through.`,
      ],
      stream: complete ? null : '/api/stream/asset-hub/whales-daily',
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ registry ═════ */

const REGISTRY = {
  id: 'asset-hub',
  label: LABEL,
  homepage: 'https://polkadot.com/',
  transport: 'jsonrpc',
  doc: 'docs/platform/asset-hub.md',
  covers: [
    'Polkadot Asset Hub (para 1000) — ForeignAssets, Assets, sovereign account balances',
    'Polkadot relay chain — Paras::ParaLifecycles, Registrar::Paras, sovereign account balances',
    'Kusama Asset Hub (para 1000) — sovereign account balances, daily series only',
    'Kusama relay chain — Paras::ParaLifecycles, Registrar::Paras, sovereign account balances, daily series only',
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

    'sovereign-dot-recent': {
      summary:
        'The same daily reading the `netflows-daily` store holds, for the most recent CLOSED UTC days on one network — the tail a month-bucketed store cannot serve. Both sovereign legs, per parachain, at each day’s last block on each chain.',
      // Thirty minutes. The days it returns are closed and can never change; the TTL exists to
      // bound how often a public page re-derives the same forty block boundaries, not because
      // the answer goes stale.
      ttlMs: 1_800_000,
      schema: {
        // Forty days is the ceiling because the seam this fills is at most one calendar month
        // wide. Asking for a year here would be a backfill on the request path.
        days: { type: 'int', min: 1, max: RECENT_MAX_DAYS, default: 32 },
        // Required, and not defaulted, for the same reason as the job below: a default would
        // make `?days=7` and `?days=7&network=polkadot` two cache entries for one answer, and
        // there is no reading of a missing `network` that is not a guess about which chain a
        // number came from.
        network: { type: 'string', required: true, oneOf: NETFLOW_NETWORK_IDS },
      },
      run: ({ days, network }) => sovereignDotRecent({ days, network }),
    },

    'netflows-series': {
      summary:
        'Every settled month of the `netflows-daily` series for one network, in one response — each month carrying the same `{data, coverage, job}` envelope the single-month endpoint answers, plus an overall coverage statement. Reading this is the demand that fills missing months (same bounds as reading them one by one); subscribe to `/api/stream/asset-hub/netflows-daily` for the ones that are not stored yet.',
      // No `ttlMs`, deliberately: this is served from the persistent store, not the TTL cache.
      // `store: true` routes it through `serveStoreRead` (server/index.mjs), where completeness
      // IS the cache policy — a complete series is immutable and held for five minutes, an
      // incomplete one is `no-store` so a reader polling for progress is never handed their own
      // browser cache. A TTL here would freeze "3 months missing" for its whole duration.
      store: true,
      schema: {
        // Required and not defaulted, same reasoning as everywhere else in this file: a default
        // would make `/netflows-series` and `/netflows-series?network=polkadot` two answers for
        // one question, and a URL that does not say which chain its numbers came from.
        network: { type: 'string', required: true, oneOf: NETFLOW_NETWORK_IDS },
      },
      run: (params, ctx) => netflowsSeries(params, ctx),
    },

    'whales-series': {
      summary:
        'Every settled month of the DOT whale cohort’s daily balance series, in one response — per-day AGGREGATES only (the day’s summed holding, its two legs, how many of the cohort held anything, and the top ten), plus each month’s coverage envelope. The per-account detail stays in the store: fifty-five months of 990 accounts a day is tens of megabytes. Reading this is the demand that fills missing months; subscribe to `/api/stream/asset-hub/whales-daily` for the ones that are not stored yet.',
      // No `ttlMs`, deliberately — `store: true` means completeness IS the cache policy
      // (server/index.mjs `serveStoreRead`). See the note on `netflows-series` above; `npm run
      // check` fails a store-read operation that also declares a TTL.
      store: true,
      schema: {
        // Required, never defaulted, and validated against the committed file rather than a
        // pattern: the cohort id is half the store identity, and a future re-seed is a NEW id
        // filling beside this one rather than a mutation of it (decision 0021).
        cohort: { type: 'string', required: true, oneOf: WHALE_COHORT_IDS, maxLength: 32 },
      },
      run: (params, ctx) => whalesSeries(params, ctx),
    },
  },

  /**
   * The daily series `/netflows/` is named for. Not called `sovereign-dot`: a `jobs` entry WINS
   * over an `operations` entry of the same name (server/index.mjs), so reusing that name would
   * silently take `/api/asset-hub/sovereign-dot` away from the live operation `/sovereign/`
   * reads — 200s all the way down, carrying an envelope the page cannot draw.
   */
  jobs: {
    'netflows-daily': {
      summary:
        'The native token in every parachain sovereign account at the close of one UTC day, on one network, one stored fact per day, a calendar month at a time. Both legs — `para` on the relay and `sibl` on that network’s Asset Hub — read at that day’s last block on each chain. Fetched once and never again.',
      schema: {
        // A month, and only a month. The params are part of the fact key, so a free {from, to}
        // range would refetch and re-store the same day once per distinct window a reader asks
        // for — see docs/architecture/jobs.md.
        month: { type: 'string', required: true, pattern: NETFLOWS_MONTH_RE, maxLength: 7 },
        // REQUIRED, deliberately, and this is the whole of the Kusama support.
        //
        // The params ARE the store identity, so a default would be filled in by readParams and
        // `?month=2026-01` and `?month=2026-01&network=polkadot` would become two identities
        // holding the same days — the duplicated-segments mistake docs/architecture/jobs.md
        // names as the expensive one, with correct answers and nothing anywhere reporting it.
        // Required means one identity per (network, month) and a URL that says which chain its
        // numbers came from.
        //
        // The cost, stated rather than discovered: this change ORPHANS the Polkadot days
        // already stored under `{"month":…}` — 1,673 of them across 55 identities in the
        // development store on 2026-08-21. They are re-derived once, on demand, and the old rows
        // sit there until somebody deletes them. A forward-only store migration rewriting
        // `{"month":X}` to `{"month":X,"network":"polkadot"}` avoids the re-derivation entirely
        // and produces exactly what `canonicalParams` does; it belongs in server/lib/store.mjs
        // rather than here.
        network: { type: 'string', required: true, oneOf: NETFLOW_NETWORK_IDS },
      },

      immutable: (params) => netflowsMonthIsSettled(params),

      /**
       * The identity-watch contract for `/api/stream/asset-hub/netflows-daily` (server/index.mjs
       * `serveStream`, decision 0020). A reader who was answered a partial series subscribes with
       * the months it is missing and is handed each one's complete envelope as it lands — the
       * same envelope the HTTP endpoint answers, so the two arrival paths are one decoding path.
       *
       * The watch is READ-ONLY by contract: it observes jobs, it never creates or raises one.
       * The aggregate read (or the per-month read) is what turns a reader into demand; holding a
       * connection open must not be a way to hold a job open.
       */
      watch: {
        event: 'month',
        schema: {
          network: { type: 'string', required: true, oneOf: NETFLOW_NETWORK_IDS },
          // Comma-separated months still wanted. Capped well above any real series (Kusama is 61
          // months in 2026-08 and grows by twelve a year) but capped, because an uncapped list
          // parameter is a free way to make one GET cost N store probes per poll tick.
          months: { type: 'list', required: true, pattern: NETFLOWS_MONTH_RE, maxItems: 200 },
        },
        // Only months the settle predicate admits. A month that can never land — the current
        // one, a future one, one below the network's floor — would otherwise sit in the wanted
        // set for the watch's whole lifetime, and 32 such requests would pin the global watch
        // cap doing nothing. Filtered here rather than refused, so a client whose clock is
        // slightly ahead loses one month from its watch instead of the whole subscription; an
        // all-filtered list closes immediately with `done`.
        identities: ({ network, months }) =>
          months.filter((month) => netflowsMonthIsSettled({ month, network })).map((month) => ({ month, network })),
      },

      /**
       * Fill this without waiting for a reader — see server/lib/warm.mjs and decision 0014.
       *
       * Every settled month of every network, which is the same set `/netflows/` asks for and
       * must stay the same set: a warm identity that differs from a requested one by so much as
       * a key is a SECOND identity, so the backfill runs twice, both copies are correct, and the
       * page still starts empty. Warming, the `netflows-series` aggregate and the identity-watch
       * stream therefore all read `netflowsSettledMonths` — one derivation of "which months
       * exist", built on `netflowsMonthIsSettled`, the same predicate `immutable` uses and the
       * one warmStore re-applies — so the current month falls out on its own without this
       * function knowing the rule.
       *
       * BOTH NETWORKS, deliberately, and the deciding argument is not the one about cost.
       * `MAX_LIVE_JOBS_PER_OPERATION` is counted per (source, operation) ACROSS ALL PARAMS
       * (jobs.mjs `countLive`), so warming Polkadot alone would put 55 live jobs on this
       * operation and a Kusama reader arriving during the drain would be refused with "the queue
       * is busy" for the whole of it — warming half the page would make the other half HARDER to
       * fetch than warming nothing. Warming both is also what the page is: `/netflows/` is one
       * chart with a network toggle, and a cold half is not a state worth shipping. The cost is
       * one-time and measured — 33.1 min / 2.73 MB for Kusama's 61 months, ~39 min / 2.33 MB for
       * Polkadot's 55 (2026-08-21) — and the two networks are different hosts, so neither drain
       * slows the other through the per-host gate.
       *
       * Safe to leave as "everything, forever": warmStore skips an identity that is already
       * complete, so once the series is filled this costs one indexed lookup per month per boot.
       */
      warm: () =>
        Object.values(NETFLOW_NETWORKS).flatMap((net) =>
          // From each network's own floor to its last settled month. Per network, because Kusama
          // can answer for 2021-07 and Polkadot cannot — a shared floor would either lock Kusama
          // out of five readable months or mint a Polkadot job for a month with no clock.
          netflowsSettledMonths(net.id).map((month) => ({ month, network: net.id })),
        ),

      // Knowable without asking anybody. The engine records it before the first batch so the
      // coverage bar has a denominator from the start.
      plan: async ({ params }) => ({ totalUnits: daysOfMonth(params?.month ?? '').length || null }),

      async nextBatch({ params, cursor, gate }) {
        const run = gatedRun(gate)
        const net = netflowNetwork(params.network)
        const days = daysOfMonth(params.month)
        const state = cursor ?? { day: days[0], hint: null, sticky: [] }
        const index = days.indexOf(state.day)
        if (index < 0) {
          // A cursor from another month's job, or a hand-edited one. Not weather — say so.
          throw new UpstreamError(`the stored cursor names ${state.day}, which is not a day of ${params.month}.`, {
            kind: 'decode',
            source: net.relay.id,
          })
        }

        const heads = await netflowsHeads(run, net)
        const slice = days.slice(index, index + DAYS_PER_BATCH)
        const lastEnd = dayStartMs(slice[slice.length - 1]) + DAY_MS

        // THE guarantee, and it is not the `immutable` predicate above — that one only knows
        // the wall clock. A chain can answer every call and still be weeks behind (CLAUDE.md),
        // and a day summarised from a chain that has not reached its end would be a wrong
        // number stored forever.
        for (const chain of [heads.relay, heads.assetHub]) {
          if (chain.timeMs < lastEnd) {
            throw new UpstreamError(
              `${chain.host.label} has not produced a block past ${new Date(lastEnd).toISOString()} — its finalized head #${chain.block} is dated ${new Date(chain.timeMs).toISOString()}. Refusing to store days it has not reached.`,
              { kind: 'upstream', source: chain.host.id },
            )
          }
        }

        const { payloads, sticky, hint } = await readSovereignDays({
          net,
          days: slice,
          run,
          heads,
          hint: state.hint,
          sticky: state.sticky,
        })

        const finished = index + slice.length >= days.length
        const head =
          `${net.relay.chainLabel} #${heads.relay.block} @ ${new Date(heads.relay.timeMs).toISOString()}; ` +
          `${net.assetHub.chainLabel} #${heads.assetHub.block} @ ${new Date(heads.assetHub.timeMs).toISOString()}`

        return {
          rows: payloads.map((payload) => ({ segment: payload.date, payload, head, codeVersion: NETFLOWS_VERSION })),
          // The next batch starts where this one stopped, carrying the resolved boundary and the
          // measured blocks-per-day forward so the search does not start cold every day.
          cursor: finished ? undefined : { day: days[index + slice.length], hint, sticky },
          done: finished,
          doneUnits: index + slice.length,
          totalUnits: days.length,
        }
      },
    },

    /**
     * The whale cohort's daily series. Named `whales-daily` against the operation `whales-series`
     * for the same reason `netflows-daily` is not called `sovereign-dot`: a `jobs` entry WINS over
     * an `operations` entry of the same name, so a collision does not sit beside the operation, it
     * takes the URL away from it — 200s all the way down, carrying an envelope the page cannot
     * draw. `npm run check` fails the registry group on a collision; this comment is why.
     */
    'whales-daily': {
      summary:
        'What every account in one dated DOT whale cohort held at the close of one UTC day, one stored fact per day, a calendar month at a time. Both legs — `System::Account` on the Polkadot relay chain and on Asset Hub — read at that day’s last block on each chain, sparse (an account holding nothing is omitted), with the day’s aggregate header computed at fetch time. Fetched once and never again.',
      schema: {
        // A month, and only a month: the params ARE the fact key, so a free {from, to} range
        // would refetch and re-store the same day once per distinct window a reader asks for.
        month: { type: 'string', required: true, pattern: NETFLOWS_MONTH_RE, maxLength: 7 },
        // REQUIRED, and this is the whole of the re-seed story. The cohort id is half the store
        // identity, so a new cohort in 2027 mints a SECOND set of identities beside this one and
        // orphans nothing; a defaulted cohort would instead make `?month=X` and
        // `?month=X&cohort=2026-08-21` two identities holding the same days, with correct answers
        // and nothing anywhere reporting the duplication (docs/architecture/jobs.md).
        //
        // No `network`: the cohort is a Polkadot Asset Hub reading and says so, so a network
        // parameter would be a second identity for a question that has one answer.
        cohort: { type: 'string', required: true, oneOf: WHALE_COHORT_IDS, maxLength: 32 },
      },

      immutable: (params) => whalesMonthIsSettled(params),

      /**
       * The identity-watch contract for `/api/stream/asset-hub/whales-daily` (decision 0020),
       * mirroring `netflows-daily`'s. Read-only by contract: it observes jobs, it never creates or
       * raises one — the aggregate read is what turns a reader into demand.
       */
      watch: {
        event: 'month',
        schema: {
          cohort: { type: 'string', required: true, oneOf: WHALE_COHORT_IDS, maxLength: 32 },
          // Comma-separated months still wanted, capped well above any real series (55 in
          // 2026-08, growing by twelve a year) but capped: an uncapped list parameter is a free
          // way to make one GET cost N store probes per poll tick.
          months: { type: 'list', required: true, pattern: NETFLOWS_MONTH_RE, maxItems: 200 },
        },
        // Only months the settle predicate admits. A month that can never land — the current one,
        // a future one, one below the floor — would otherwise sit in the wanted set for the
        // watch's whole lifetime and pin a watch slot doing nothing.
        identities: ({ cohort, months }) =>
          months.filter((month) => whalesMonthIsSettled({ month, cohort })).map((month) => ({ month, cohort })),
      },

      /**
       * Fill this without waiting for a reader (server/lib/warm.mjs, decision 0014). The same set
       * `whales-series` asks for and it must stay the same set: a warm identity differing from a
       * requested one by so much as a key is a SECOND identity, so the backfill runs twice, both
       * copies are correct, and the page still starts empty. Both read `whalesSettledMonths`.
       *
       * Safe to leave as "everything, forever": warmStore asks `describeIdentity` first and skips
       * an identity that is already complete, so once filled this costs one indexed lookup per
       * month per boot. Enqueuing a `done` identity would instead MINT A NEW JOB and refetch every
       * segment already stored (CLAUDE.md) — the check is in warm.mjs, not here.
       */
      warm: () => whalesSettledMonths(WHALE_COHORT_IDS[0]).map((month) => ({ month, cohort: WHALE_COHORT_IDS[0] })),

      plan: async ({ params }) => ({ totalUnits: daysOfMonth(params?.month ?? '').length || null }),

      async nextBatch({ params, cursor, gate }) {
        const run = gatedRun(gate)
        const cohort = whaleCohortOf(params.cohort)
        const days = daysOfMonth(params.month)
        const state = cursor ?? { day: days[0], hint: null }
        const index = days.indexOf(state.day)
        if (index < 0) {
          throw new UpstreamError(`the stored cursor names ${state.day}, which is not a day of ${params.month}.`, {
            kind: 'decode',
            source: WHALES_NET.relay.id,
          })
        }

        // Both heads, and the DOT/10 canary on both hosts — shared with the netflows series
        // rather than restated, so there is one place that can catch a hostname resolving to the
        // wrong chain.
        const heads = await netflowsHeads(run, WHALES_NET)
        const slice = days.slice(index, index + DAYS_PER_BATCH)
        const lastEnd = dayStartMs(slice[slice.length - 1]) + DAY_MS

        // THE guarantee, and it is not `immutable` above — that one only knows the wall clock. A
        // chain can answer every call and still be weeks behind (CLAUDE.md), and a day summarised
        // from a chain that has not reached its end would be a wrong number stored forever.
        for (const chain of [heads.relay, heads.assetHub]) {
          if (chain.timeMs < lastEnd) {
            throw new UpstreamError(
              `${chain.host.label} has not produced a block past ${new Date(lastEnd).toISOString()} — its finalized head #${chain.block} is dated ${new Date(chain.timeMs).toISOString()}. Refusing to store days it has not reached.`,
              { kind: 'upstream', source: chain.host.id },
            )
          }
        }

        const { payloads, hint } = await readWhaleDays({ cohort, days: slice, run, heads, hint: state.hint })

        const finished = index + slice.length >= days.length
        const head =
          `${WHALES_NET.relay.chainLabel} #${heads.relay.block} @ ${new Date(heads.relay.timeMs).toISOString()}; ` +
          `${WHALES_NET.assetHub.chainLabel} #${heads.assetHub.block} @ ${new Date(heads.assetHub.timeMs).toISOString()}`

        return {
          rows: payloads.map((payload) => ({ segment: payload.date, payload, head, codeVersion: WHALES_VERSION })),
          cursor: finished ? undefined : { day: days[index + slice.length], hint },
          done: finished,
          doneUnits: index + slice.length,
          totalUnits: days.length,
        }
      },
    },
  },
}

/**
 * The `netflows-daily` handler, by name. `netflowsSeries` serves each month through the SAME
 * handler object the registry resolves for HTTP requests — captured from the registry rather
 * than defined beside it, so there is exactly one handler and no way for the two paths to
 * drift. Assigned before export, used only at request time, so the reference is always live.
 */
const NETFLOWS_DAILY = REGISTRY.jobs['netflows-daily']

/** The `whales-daily` handler, by name — same reasoning as `NETFLOWS_DAILY` above: one handler
 *  object, captured from the registry, so the aggregate and the HTTP path cannot drift apart. */
const WHALES_DAILY = REGISTRY.jobs['whales-daily']

export default REGISTRY
