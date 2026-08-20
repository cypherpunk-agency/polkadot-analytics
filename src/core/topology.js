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
 */

/** @type {Array<Omit<ChainEntry,'aliases'> & {aliases?: string[]}>} */
const REGISTRY = [
  // ── Polkadot ────────────────────────────────────────────────────────────────────────────
  { paraId: null, network: 'polkadot', name: 'Polkadot', kind: 'relay', aliases: ['relay', 'polkadot-relay', 'dot'] },
  { paraId: 1000, network: 'polkadot', name: 'Asset Hub', kind: 'system', aliases: ['statemint', 'assethub', 'asset-hub', 'polkadot-asset-hub'] },
  { paraId: 1001, network: 'polkadot', name: 'Collectives', kind: 'system', aliases: ['collectives'] },
  { paraId: 1002, network: 'polkadot', name: 'Bridge Hub', kind: 'system', aliases: ['bridgehub', 'bridge-hub'] },
  { paraId: 1004, network: 'polkadot', name: 'People Chain', kind: 'system', aliases: ['people', 'people-chain'] },
  { paraId: 1005, network: 'polkadot', name: 'Coretime', kind: 'system', aliases: ['coretime'] },
  { paraId: 2000, network: 'polkadot', name: 'Acala', kind: 'parachain', aliases: ['acala'] },
  { paraId: 2004, network: 'polkadot', name: 'Moonbeam', kind: 'parachain', aliases: ['moonbeam'] },
  { paraId: 2006, network: 'polkadot', name: 'Astar', kind: 'parachain', aliases: ['astar'] },
  { paraId: 2011, network: 'polkadot', name: 'Equilibrium', kind: 'parachain', aliases: ['equilibrium'] },
  { paraId: 2012, network: 'polkadot', name: 'Parallel', kind: 'parachain', aliases: ['parallel'] },
  { paraId: 2030, network: 'polkadot', name: 'Bifrost', kind: 'parachain', aliases: ['bifrost', 'bifrost-polkadot'] },
  { paraId: 2031, network: 'polkadot', name: 'Centrifuge', kind: 'parachain', aliases: ['centrifuge'] },
  { paraId: 2032, network: 'polkadot', name: 'Interlay', kind: 'parachain', aliases: ['interlay'] },
  { paraId: 2034, network: 'polkadot', name: 'Hydration', kind: 'parachain', aliases: ['hydradx', 'hydration', 'hydra-dx'] },
  { paraId: 2035, network: 'polkadot', name: 'Phala', kind: 'parachain', aliases: ['phala'] },
  { paraId: 3367, network: 'polkadot', name: 'Hyperbridge', kind: 'parachain', aliases: ['hyperbridge', 'nexus'] },

  // ── Kusama ──────────────────────────────────────────────────────────────────────────────
  { paraId: null, network: 'kusama', name: 'Kusama', kind: 'relay', aliases: ['relay', 'kusama-relay', 'ksm'] },
  { paraId: 1000, network: 'kusama', name: 'Asset Hub', kind: 'system', aliases: ['statemine', 'assethub', 'asset-hub', 'kusama-asset-hub'] },
  { paraId: 1001, network: 'kusama', name: 'Encointer', kind: 'system', aliases: ['encointer'] },
  { paraId: 1002, network: 'kusama', name: 'Bridge Hub', kind: 'system', aliases: ['bridgehub', 'bridge-hub'] },
  { paraId: 1004, network: 'kusama', name: 'People Chain', kind: 'system', aliases: ['people', 'people-chain'] },
  { paraId: 1005, network: 'kusama', name: 'Coretime', kind: 'system', aliases: ['coretime'] },
  { paraId: 2000, network: 'kusama', name: 'Karura', kind: 'parachain', aliases: ['karura'] },
  { paraId: 2001, network: 'kusama', name: 'Bifrost', kind: 'parachain', aliases: ['bifrost', 'bifrost-kusama'] },
  { paraId: 2007, network: 'kusama', name: 'Shiden', kind: 'parachain', aliases: ['shiden'] },
  { paraId: 2023, network: 'kusama', name: 'Moonriver', kind: 'parachain', aliases: ['moonriver'] },
  { paraId: 2085, network: 'kusama', name: 'Heiko', kind: 'parachain', aliases: ['heiko', 'parallel-heiko'] },
  { paraId: 2087, network: 'kusama', name: 'Picasso', kind: 'parachain', aliases: ['picasso'] },
  { paraId: 2090, network: 'kusama', name: 'Basilisk', kind: 'parachain', aliases: ['basilisk'] },
  { paraId: 2092, network: 'kusama', name: 'Kintsugi', kind: 'parachain', aliases: ['kintsugi'] },
  { paraId: 2110, network: 'kusama', name: 'Mangata', kind: 'parachain', aliases: ['mangata'] },
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
