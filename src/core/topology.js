// The topology registry: what a para id is, and what account it owns on somebody else's chain.
//
// Two things live here and they belong together, because both answer "who is this?" about an
// identifier that arrives as a bare number or a bare 32 bytes:
//
//   1. `CHAINS` — para id to a name and a kind, for the chains this site already names.
//   2. The sovereign-account derivation — the `para`/`sibl` prefixes, which turn a para id
//      into the exact account that holds that chain's money on a relay chain or on a sibling.
//
// ── the registry is a transcription, and says so ──────────────────────────────────────────
// Nothing in this repo reads the relay chain's registrar. These ids come from public
// registrations and from the identifiers our own upstreams already send us. That makes this
// file the one place here where a fact could be quietly wrong, so:
//
//   · `chainOf()` returns `null` for an id it does not know. It NEVER invents a name, and a
//     caller that renders `null` as "para 2034" is telling the truth about what it knows.
//   · Ids are keyed by RELAY, not globally. Para 1000 is Asset Hub on Polkadot and Asset Hub
//     on Kusama, and para 2000 is Acala on one and Karura on the other. A registry keyed by
//     the number alone is a mislabelling machine.
//   · The XCM lane should reconcile this against what its upstream actually sends and fix
//     what disagrees. `unknownChains()` is here to make that reconciliation one call.
//
// ── the derivation is NOT a transcription ─────────────────────────────────────────────────
// It is verified, in docs/platform/xcm.md, against a live read on 2026-08-19: Hydration's
// sibling account on Asset Hub is `0x7369626cf2070000…` and reading `Assets::Account(1337,
// that)` gives 5,285,506.68 USDC. Older documentation claiming these are `blake2(b"para" ++
// id)` is wrong for the current converters — `ChildParachainConvertsVia` and
// `SiblingParachainConvertsVia` use `into_account_truncating`, which is literal bytes plus
// trailing zeros. Getting that wrong produces a valid-looking account that holds nothing,
// which reads on a page as "this chain has no money".

import { concat, toHex, fromHex, utf8, u32le } from './codec/bytes.js'
import { encodeSs58 } from './codec/ss58.js'

/* ------------------------------------------------------------------- the chain registry ---- */

/**
 * @typedef {'relay'|'system'|'parachain'} ChainKind
 *
 * relay      the relay chain itself. Has no para id.
 * system     a chain governed by the relay's own OpenGov — Asset Hub, Bridge Hub, People,
 *            Coretime, Collectives. The distinction is not cosmetic: system chains are the
 *            only ones that TELEPORT with the relay, because teleporting means trusting the
 *            other side's whole runtime, and that is only true under shared governance.
 * parachain  everything else. Reserve-backed transfers only.
 */

/**
 * @typedef {object} ChainEntry
 * @property {number|null} paraId    null for a relay chain
 * @property {string} network        'polkadot' | 'kusama'
 * @property {string} name           what this site calls it
 * @property {ChainKind} kind
 * @property {string[]} aliases      every other spelling an upstream has been seen to use.
 *                                   Dotlake still says `statemint` and `hydradx`; the netflows
 *                                   dataset says `HydraDX`. Resolving those here means one
 *                                   place to fix rather than a `CHAIN_LABEL` per page.
 * @property {'observed'|'repo'|'assumed'} evidence  where the id↔name pairing came from:
 *
 *   observed  Dotlake sent this exact `para_id` next to this exact chain name, in rows read on
 *             2026-08-20 across four windows spanning 2024–2026. The strongest thing this file
 *             has, and still only as good as Dotlake.
 *   repo      written down in this repository — docs/platform/xcm.md or the netflows dataset —
 *             and verified there against a chain.
 *   assumed   neither. Public knowledge, transcribed, never checked here. `assumedChains()`
 *             lists them so a page can say so out loud instead of implying a verification that
 *             did not happen.
 */

/**
 * The Polkadot rows marked `observed` were reconciled against Dotlake's own `xcm-transfers`
 * rows on 2026-08-20, over four windows in 2024, 2025 and 2026 — roughly 30,000 messages. The
 * `aliases` here are Dotlake's exact spellings, which is why several of them are historical or
 * ugly: `statemint`, `hydradx`, `kilt-spiritnet`, `polkadot-bridgehub`.
 *
 * What that reconciliation also showed, and why the NAME is the key on the `/xcm/` page rather
 * than the id: Dotlake's `origin_para_id`/`dest_para_id` disagrees with its own chain name on
 * a small minority of rows — para 1000 arriving labelled `polkadot-bridgehub`, para 2034
 * labelled `astar`, `moonbeam` or `polkadot`. Roughly 0.1–2% per chain, never the majority. The
 * name is right and the id is the field that slips, so the page keys on the name, resolves it
 * here, and counts the disagreements into its data notes.
 *
 * Three chain names arrive with NO para id ever attached — `sora`, `subsocial`, `polimec`.
 * They are deliberately absent rather than transcribed from memory: an entry here is a claim
 * about which account holds a chain's money, and a wrong para id produces a valid-looking
 * sovereign address that holds nothing, which reads on a page as "this chain has no money".
 * `chainLabel()` renders them as their own identifier and `unknownChains()` names them.
 *
 * @type {Array<Omit<ChainEntry,'aliases'> & {aliases?: string[]}>}
 */
const REGISTRY = [
  // ── Polkadot ────────────────────────────────────────────────────────────────────────────
  { paraId: null, network: 'polkadot', name: 'Polkadot', kind: 'relay', evidence: 'repo', aliases: ['relay', 'polkadot-relay', 'dot'] },
  { paraId: 1000, network: 'polkadot', name: 'Asset Hub', kind: 'system', evidence: 'repo', aliases: ['statemint', 'assethub', 'asset-hub', 'polkadot-asset-hub'] },
  { paraId: 1001, network: 'polkadot', name: 'Collectives', kind: 'system', evidence: 'observed', aliases: ['collectives'] },
  { paraId: 1002, network: 'polkadot', name: 'Bridge Hub', kind: 'system', evidence: 'observed', aliases: ['polkadot-bridgehub', 'bridgehub', 'bridge-hub'] },
  { paraId: 1004, network: 'polkadot', name: 'People Chain', kind: 'system', evidence: 'observed', aliases: ['people', 'people-chain'] },
  { paraId: 1005, network: 'polkadot', name: 'Coretime', kind: 'system', evidence: 'observed', aliases: ['coretime'] },
  { paraId: 2000, network: 'polkadot', name: 'Acala', kind: 'parachain', evidence: 'repo', aliases: ['acala'] },
  { paraId: 2004, network: 'polkadot', name: 'Moonbeam', kind: 'parachain', evidence: 'observed', aliases: ['moonbeam'] },
  { paraId: 2006, network: 'polkadot', name: 'Astar', kind: 'parachain', evidence: 'observed', aliases: ['astar'] },
  { paraId: 2008, network: 'polkadot', name: 'Crust', kind: 'parachain', evidence: 'observed', aliases: ['crust'] },
  { paraId: 2011, network: 'polkadot', name: 'Equilibrium', kind: 'parachain', evidence: 'assumed', aliases: ['equilibrium'] },
  { paraId: 2012, network: 'polkadot', name: 'Parallel', kind: 'parachain', evidence: 'observed', aliases: ['parallel'] },
  { paraId: 2026, network: 'polkadot', name: 'Nodle', kind: 'parachain', evidence: 'observed', aliases: ['nodle'] },
  { paraId: 2030, network: 'polkadot', name: 'Bifrost', kind: 'parachain', evidence: 'observed', aliases: ['bifrost', 'bifrost-polkadot'] },
  { paraId: 2031, network: 'polkadot', name: 'Centrifuge', kind: 'parachain', evidence: 'observed', aliases: ['centrifuge'] },
  { paraId: 2032, network: 'polkadot', name: 'Interlay', kind: 'parachain', evidence: 'observed', aliases: ['interlay'] },
  { paraId: 2034, network: 'polkadot', name: 'Hydration', kind: 'parachain', evidence: 'repo', aliases: ['hydradx', 'hydration', 'hydra-dx'] },
  { paraId: 2035, network: 'polkadot', name: 'Phala', kind: 'parachain', evidence: 'observed', aliases: ['phala'] },
  { paraId: 2037, network: 'polkadot', name: 'Unique', kind: 'parachain', evidence: 'observed', aliases: ['unique', 'unique-network'] },
  { paraId: 2040, network: 'polkadot', name: 'Polkadex', kind: 'parachain', evidence: 'observed', aliases: ['polkadex'] },
  { paraId: 2043, network: 'polkadot', name: 'OriginTrail', kind: 'parachain', evidence: 'observed', aliases: ['origintrail', 'neuroweb'] },
  { paraId: 2046, network: 'polkadot', name: 'Darwinia', kind: 'parachain', evidence: 'observed', aliases: ['darwinia'] },
  { paraId: 2051, network: 'polkadot', name: 'Ajuna', kind: 'parachain', evidence: 'observed', aliases: ['ajuna'] },
  { paraId: 2086, network: 'polkadot', name: 'KILT', kind: 'parachain', evidence: 'observed', aliases: ['kilt-spiritnet', 'kilt', 'spiritnet'] },
  { paraId: 2092, network: 'polkadot', name: 'Zeitgeist', kind: 'parachain', evidence: 'observed', aliases: ['zeitgeist'] },
  { paraId: 2094, network: 'polkadot', name: 'Pendulum', kind: 'parachain', evidence: 'observed', aliases: ['pendulum'] },
  { paraId: 2104, network: 'polkadot', name: 'Manta', kind: 'parachain', evidence: 'observed', aliases: ['manta'] },
  { paraId: 3338, network: 'polkadot', name: 'peaq', kind: 'parachain', evidence: 'observed', aliases: ['peaq'] },
  { paraId: 3345, network: 'polkadot', name: 'Energy Web X', kind: 'parachain', evidence: 'observed', aliases: ['energywebx', 'energy-web-x'] },
  { paraId: 3367, network: 'polkadot', name: 'Hyperbridge', kind: 'parachain', evidence: 'observed', aliases: ['hyperbridge', 'nexus'] },
  { paraId: 3369, network: 'polkadot', name: 'Mythos', kind: 'parachain', evidence: 'observed', aliases: ['mythos'] },
  { paraId: 3370, network: 'polkadot', name: 'LAOS', kind: 'parachain', evidence: 'observed', aliases: ['laos'] },
  { paraId: 3388, network: 'polkadot', name: 'Robonomics', kind: 'parachain', evidence: 'observed', aliases: ['robonomics'] },
  { paraId: 3397, network: 'polkadot', name: 'JAMTON', kind: 'parachain', evidence: 'observed', aliases: ['jamton'] },

  // ── Kusama ──────────────────────────────────────────────────────────────────────────────
  // Not reconciled against anything. `/xcm/` can be pointed at Kusama and nothing in this repo
  // has read a Kusama row, so every one of these is a transcription and says so.
  { paraId: null, network: 'kusama', name: 'Kusama', kind: 'relay', evidence: 'repo', aliases: ['relay', 'kusama-relay', 'ksm'] },
  { paraId: 1000, network: 'kusama', name: 'Asset Hub', kind: 'system', evidence: 'assumed', aliases: ['statemine', 'assethub', 'asset-hub', 'kusama-asset-hub'] },
  { paraId: 1001, network: 'kusama', name: 'Encointer', kind: 'system', evidence: 'assumed', aliases: ['encointer'] },
  { paraId: 1002, network: 'kusama', name: 'Bridge Hub', kind: 'system', evidence: 'assumed', aliases: ['kusama-bridgehub', 'bridgehub', 'bridge-hub'] },
  { paraId: 1004, network: 'kusama', name: 'People Chain', kind: 'system', evidence: 'assumed', aliases: ['people', 'people-chain'] },
  { paraId: 1005, network: 'kusama', name: 'Coretime', kind: 'system', evidence: 'assumed', aliases: ['coretime'] },
  { paraId: 2000, network: 'kusama', name: 'Karura', kind: 'parachain', evidence: 'assumed', aliases: ['karura'] },
  { paraId: 2001, network: 'kusama', name: 'Bifrost', kind: 'parachain', evidence: 'assumed', aliases: ['bifrost', 'bifrost-kusama'] },
  { paraId: 2007, network: 'kusama', name: 'Shiden', kind: 'parachain', evidence: 'assumed', aliases: ['shiden'] },
  { paraId: 2023, network: 'kusama', name: 'Moonriver', kind: 'parachain', evidence: 'assumed', aliases: ['moonriver'] },
  { paraId: 2085, network: 'kusama', name: 'Heiko', kind: 'parachain', evidence: 'assumed', aliases: ['heiko', 'parallel-heiko'] },
  { paraId: 2087, network: 'kusama', name: 'Picasso', kind: 'parachain', evidence: 'assumed', aliases: ['picasso'] },
  { paraId: 2090, network: 'kusama', name: 'Basilisk', kind: 'parachain', evidence: 'assumed', aliases: ['basilisk'] },
  { paraId: 2092, network: 'kusama', name: 'Kintsugi', kind: 'parachain', evidence: 'assumed', aliases: ['kintsugi'] },
  { paraId: 2110, network: 'kusama', name: 'Mangata', kind: 'parachain', evidence: 'assumed', aliases: ['mangata'] },
]

export const NETWORKS = /** @type {const} */ (['polkadot', 'kusama'])

/** `polkadot:2034`. The only correct key: a para id alone is ambiguous across relays. */
export const chainKey = (network, paraId) => `${network}:${paraId ?? 'relay'}`

/** @type {Map<string, ChainEntry>} */
const BY_KEY = new Map()
/** @type {Map<string, ChainEntry>} */
const BY_ALIAS = new Map()

for (const row of REGISTRY) {
  /** @type {ChainEntry} */
  const entry = Object.freeze({ ...row, aliases: Object.freeze(row.aliases ?? []) })
  BY_KEY.set(chainKey(entry.network, entry.paraId), entry)
  for (const alias of [entry.name, ...entry.aliases]) {
    const key = `${entry.network}:${alias.toLowerCase()}`
    if (!BY_ALIAS.has(key)) BY_ALIAS.set(key, entry)
  }
}

/** Every entry, in registration order. Frozen: this is a lookup table, not a scratchpad. */
export const CHAINS = Object.freeze(REGISTRY.map((row) => BY_KEY.get(chainKey(row.network, row.paraId))))

/**
 * @param {number|null} paraId
 * @param {'polkadot'|'kusama'} [network]
 * @returns {ChainEntry|null} null when we have never named it — never a guess
 */
export const chainOf = (paraId, network = 'polkadot') =>
  BY_KEY.get(chainKey(network, paraId === null || paraId === undefined ? null : Number(paraId))) ?? null

/**
 * Resolve whatever an upstream calls a chain: `statemint`, `hydradx`, `Asset Hub`, `2034`, or
 * the number 2034. Case-insensitive on names, exact on ids.
 *
 * @param {string|number} what
 * @param {'polkadot'|'kusama'} [network]
 * @returns {ChainEntry|null}
 */
export function resolveChain(what, network = 'polkadot') {
  if (what === null || what === undefined) return null
  if (typeof what === 'number') return chainOf(what, network)
  const text = String(what).trim()
  if (/^\d+$/.test(text)) return chainOf(Number(text), network)
  return BY_ALIAS.get(`${network}:${text.toLowerCase()}`) ?? null
}

/**
 * The label to put on a chart axis. Falls back to the identifier the upstream used rather
 * than to "unknown" — an axis reading `para 3344` is a fact a reader can act on, and an axis
 * reading `unknown` five times over is not.
 *
 * @param {string|number} what
 * @param {'polkadot'|'kusama'} [network]
 */
export function chainLabel(what, network = 'polkadot') {
  const entry = resolveChain(what, network)
  if (entry) return entry.name
  if (typeof what === 'number' || /^\d+$/.test(String(what ?? ''))) return `para ${what}`
  return String(what ?? 'unknown')
}

/**
 * Which of these identifiers this registry cannot name. The reconciliation call: run it over
 * the distinct chain identifiers in a payload and put the result in data-notes, so a chain
 * this file has never heard of is stated on the page rather than silently rendered as its id.
 *
 * @param {Array<string|number>} identifiers
 * @param {'polkadot'|'kusama'} [network]
 * @returns {string[]} the unresolvable ones, deduplicated, in first-seen order
 */
export function unknownChains(identifiers, network = 'polkadot') {
  const missing = []
  const seen = new Set()
  for (const id of identifiers ?? []) {
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    if (!resolveChain(id, network)) missing.push(key)
  }
  return missing
}

/**
 * Which of these identifiers this file names on hearsay rather than on evidence.
 *
 * The counterpart to `unknownChains()`: that one finds what the registry cannot name at all,
 * this one finds what it names without ever having checked. Both belong in a page's data
 * notes, because "we have never heard of this chain" and "we are repeating what we were told
 * about this chain" are different admissions and only the first is visible without asking.
 *
 * @param {Array<string|number>} identifiers
 * @param {'polkadot'|'kusama'} [network]
 * @returns {ChainEntry[]} the resolvable ones whose id↔name pairing is `assumed`
 */
export function assumedChains(identifiers, network = 'polkadot') {
  const out = []
  const seen = new Set()
  for (const id of identifiers ?? []) {
    const entry = resolveChain(id, network)
    if (!entry || entry.evidence !== 'assumed' || seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out
}

/** The kinds, in the fixed order a categorical palette should assign slots in. */
export const CHAIN_KINDS = /** @type {const} */ (['relay', 'system', 'parachain'])

/* --------------------------------------------------------------- sovereign derivation ---- */

/**
 * The two prefixes. Literal ASCII, not a hash.
 *
 *   para   what a parachain is called BY THE RELAY CHAIN it is a child of.
 *   sibl   what a parachain is called BY ANOTHER PARACHAIN.
 *
 * Same chain, two different accounts, on two different chains — which is exactly the fact the
 * netflows work got wrong in 2021: a chain's sovereign holding is the SUM of its `para`
 * account on the relay and its `sibl` account on Asset Hub, and the original series only had
 * the first. After the Asset Hub migration the second is where almost all of it is.
 */
export const PARA_PREFIX = 'para'
export const SIBL_PREFIX = 'sibl'

/** `0x70617261` and `0x7369626c`, precomputed once. */
const PREFIX_BYTES = {
  para: utf8(PARA_PREFIX),
  sibl: utf8(SIBL_PREFIX),
}

const ACCOUNT_BYTES = 32

/**
 * `on` names the chain the account exists ON, not the chain it belongs to — which is the way
 * round that stops the two being swapped:
 *
 *   sovereignAccount(2034, { on: 'relay' })     Hydration's account on Polkadot   → para
 *   sovereignAccount(2034, { on: 'sibling' })   Hydration's account on Asset Hub  → sibl
 *
 * @param {number} paraId
 * @param {{on?: 'relay'|'sibling'}} [options]
 * @returns {Uint8Array} 32 bytes
 */
export function sovereignAccount(paraId, { on = 'sibling' } = {}) {
  const id = Number(paraId)
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new Error(`sovereignAccount: para id must be a u32, got ${paraId}`)
  }
  if (on !== 'relay' && on !== 'sibling') {
    throw new Error(`sovereignAccount: \`on\` must be 'relay' or 'sibling', got ${on}`)
  }
  const prefix = on === 'relay' ? PREFIX_BYTES.para : PREFIX_BYTES.sibl
  const head = concat(prefix, u32le(id))
  // `into_account_truncating`: the prefix and the id, then zeros to 32 bytes. Not a hash.
  const account = new Uint8Array(ACCOUNT_BYTES)
  account.set(head, 0)
  return account
}

/** The same account as `0x…`, which is the form a storage query wants. */
export const sovereignAccountHex = (paraId, options) => `0x${toHex(sovereignAccount(paraId, options))}`

/**
 * The same account as SS58, which is the form a reader recognises.
 * @param {number} paraId
 * @param {{on?: 'relay'|'sibling', ss58Prefix?: number}} [options]
 */
export const sovereignAddress = (paraId, { on = 'sibling', ss58Prefix = 0 } = {}) =>
  encodeSs58(sovereignAccount(paraId, { on }), ss58Prefix)

/**
 * Everything about one sovereign account, for a table row.
 *
 * @param {number} paraId
 * @param {{on?: 'relay'|'sibling', network?: 'polkadot'|'kusama', ss58Prefix?: number}} [options]
 */
export function describeSovereign(paraId, { on = 'sibling', network = 'polkadot', ss58Prefix = 0 } = {}) {
  const account = sovereignAccount(paraId, { on })
  const chain = chainOf(paraId, network)
  return {
    paraId: Number(paraId),
    network,
    on,
    derivation: on === 'relay' ? PARA_PREFIX : SIBL_PREFIX,
    name: chain?.name ?? null,
    kind: chain?.kind ?? null,
    accountId: account,
    hex: `0x${toHex(account)}`,
    address: encodeSs58(account, ss58Prefix),
  }
}

/* --------------------------------------------------------------------- the self-check ---- */

/**
 * Two addresses this repository has already verified against a chain, checked at import.
 *
 *   sibl 2034  docs/platform/xcm.md — read live on 2026-08-19, and `Assets::Account(1337, …)`
 *              against it returned 5,285,506.68 USDC, so the account is not merely well-formed,
 *              it is the one holding Hydration's money on Asset Hub.
 *   para 2000  src/data/netflows.json — the address the 2021–2023 Polkalytics capture used for
 *              Acala's relay-chain sovereign account, i.e. an independent derivation.
 *
 * It throws, and that is deliberate — the same call as `decodeAssetDetails`. Every failure mode
 * of this derivation is silent: a wrong prefix, a big-endian id, a hash instead of truncation,
 * or an SS58 prefix of 42 instead of 0 all produce a perfectly valid address that belongs to
 * nobody, and every balance read against it comes back empty. "This chain holds nothing" is a
 * plausible sentence, which is exactly what makes it dangerous. The check is pure arithmetic
 * over two constants, so it either passes everywhere or fails everywhere.
 */
const DERIVATION_FIXTURES = [
  { paraId: 2034, on: 'sibling', address: '13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6', hex: '0x7369626cf2070000000000000000000000000000000000000000000000000000' },
  { paraId: 2000, on: 'relay', address: '13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy', hex: '0x70617261d0070000000000000000000000000000000000000000000000000000' },
]

for (const fixture of DERIVATION_FIXTURES) {
  const hex = `0x${toHex(sovereignAccount(fixture.paraId, { on: fixture.on }))}`
  const address = encodeSs58(sovereignAccount(fixture.paraId, { on: fixture.on }), 0)
  if (hex !== fixture.hex || address !== fixture.address) {
    throw new Error(
      `topology: the sovereign derivation no longer reproduces a verified account — ` +
        `para ${fixture.paraId} on ${fixture.on} derives ${address} (${hex}), expected ` +
        `${fixture.address} (${fixture.hex}). Every balance read with this is wrong and empty.`,
    )
  }
}

/** The `modl` prefix — a pallet account, not a person. `0x6d6f646c`. */
export const MODL_PREFIX = 'modl'
const MODL_HEX = toHex(utf8(MODL_PREFIX))

/**
 * What an account IS, from its bytes alone — the cheap, safe, structural label the plan chose
 * over identity resolution (Q2). No lookup, no network call, no name attached to a human: it
 * reads the prefix the runtime itself wrote and reports the derivation.
 *
 * Returns null for an ordinary account, which is the common case and must stay uncoloured.
 *
 * @param {Uint8Array|string} account  32 bytes, or hex with or without `0x`
 * @returns {{kind:'para'|'sibl'|'modl', paraId?: number, palletId?: string, label: string}|null}
 */
export function structuralLabel(account) {
  const hex = (typeof account === 'string' ? account.replace(/^0x/, '') : toHex(account)).toLowerCase()
  if (hex.length < 16) return null

  const tag = hex.slice(0, 8)
  const paraFromBytes = () => {
    const bytes = fromHex(hex.slice(8, 16))
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  if (tag === toHex(PREFIX_BYTES.para)) {
    const paraId = paraFromBytes()
    return { kind: 'para', paraId, label: `sovereign account of para ${paraId} on its relay chain` }
  }
  if (tag === toHex(PREFIX_BYTES.sibl)) {
    const paraId = paraFromBytes()
    return { kind: 'sibl', paraId, label: `sovereign account of sibling para ${paraId}` }
  }
  if (tag === MODL_HEX) {
    if (hex.length < 24) return { kind: 'modl', palletId: null, label: 'pallet account, not a person' }
    // `PalletId` is `[u8; 8]`: the eight bytes after `modl`, ASCII-ish. Rendered as text when
    // it is printable and as hex when it is not, rather than guessing.
    const raw = fromHex(hex.slice(8, 24))
    const printable = [...raw].every((b) => b >= 0x20 && b < 0x7f)
    const palletId = printable ? new TextDecoder().decode(raw).trim() : `0x${hex.slice(8, 24)}`
    return { kind: 'modl', palletId, label: `pallet account ${palletId}, not a person` }
  }
  return null
}
