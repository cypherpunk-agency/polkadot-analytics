// What a stored object actually IS — and which objects are pieces of the same upload.
//
// ── the question this file answers ────────────────────────────────────────────────────────
// The index tells you a 262,144-byte raw object landed in block 214,901. It does not tell you
// that it is piece 7 of 34 of an 18.7 MB site bundle. Without that, a `pad` deploy reads as
// thirty-four mystery rows. This file turns them back into one upload.
//
// Everything here comes from a census of the whole chain taken at head 271,314 and written up
// in docs/platform/bulletin-content-shapes.md. The percentages in the rule table below are
// measured against 100 % ground truth (every distinct CID's bytes were fetched and sniffed),
// not estimated.
//
// ── three things the chain record does NOT mean ──────────────────────────────────────────
// These were the obvious hypotheses and all three are wrong, so they are written down here
// where the next reader will find them:
//
//   `kind`         is `TransactionKind { Store = 0, Renew = 1 }`. It does NOT distinguish a
//                  leaf from a manifest. All 9,272 entries are Store; there has never been a
//                  Renew on this chain.
//   `block_chunks` is the CUMULATIVE `Σ ceil(size/256)` of every store in the block up to and
//                  including this one — the pallet's storage-proof bookkeeping. Confirmed
//                  9,272/9,272. It is not "how many chunks my file was split into".
//   `chunk_root`   is the merkle root over those 256-byte proof chunks. It is deterministic
//                  per content and never equals `content_hash`, but it is not a second content
//                  identifier you can look up anywhere.
//
// ── two tiers, and only the first is free ────────────────────────────────────────────────
// TIER 1 (this file's `classifyShape`) reads the index row alone — codec, size, hashing — and
// labels 100 % of objects for zero requests. TIER 2 fetches the DAG-PB bodies (the only
// objects whose bytes describe other objects) and upgrades a fingerprint into a fact.

import { readVarint } from './base.js'
import { toHex } from './bytes.js'
import { blake2b } from './blake2b.js'
import { keccak256 } from './keccak.js'

export const CODEC_DAG_PB = 0x70
export const CODEC_RAW = 0x55

/** The pallet's `hashing` enum. */
const HASH_BLAKE2B = 0
const HASH_SHA2 = 1
const HASH_KECCAK = 2

/**
 * Tier-1 rules, IN ORDER. The first match wins, and the order matters: the exact-size rules
 * are facts and must be tested before the fingerprints that would also match them.
 *
 * `certain` marks a rule that measured 100 % precision against ground truth — it is a
 * structural fact about the record, not a guess. Everything else is a PRODUCER FINGERPRINT:
 * `hashing` says which tool wrote the object (sha2-256 ⇒ IPFS-native tooling like `pad` or
 * kubo, 98.7 % leaf; blake2b ⇒ `@parity/bulletin-sdk` `store()`, 98.7 % standalone), and the
 * UI must show that difference rather than flattening both into one confident label.
 *
 * Coverage is 100 % — the last rule catches everything, and `unknown` is only reachable for a
 * codec this chain has never carried.
 */
export const SHAPE_RULES = [
  {
    id: 'dag-node',
    label: 'DAG node',
    family: 'dag',
    certain: true,
    precision: 1,
    why: 'cid_codec is 0x70 (dag-pb). Measured across all 5,363 distinct CIDs: codec 0x70 and DAG-PB bytes agree exactly, with zero disagreements — so this is a fact about the object, not an inference.',
    test: (o) => o.codec === CODEC_DAG_PB,
  },
  {
    id: 'leaf-256k',
    label: 'leaf chunk',
    family: 'leaf',
    certain: true,
    precision: 1,
    why: 'Exactly 262,144 bytes — the kubo default UnixFS chunk size. All 208 distinct CIDs at this size are referenced by a DAG-PB manifest: every one of them is a piece of something larger.',
    test: (o) => o.codec === CODEC_RAW && o.size === 262144,
  },
  {
    id: 'car-section',
    label: 'CAR section',
    family: 'leaf',
    certain: true,
    precision: 1,
    why: '262,183 = 3 + 36 + 262,144: a CAR section holding exactly one 256 KiB block — a 3-byte varint length, a 36-byte CIDv1, then the payload. All 175 are leaves of a manifest.',
    test: (o) => o.codec === CODEC_RAW && o.size === 262183,
  },
  {
    id: 'leaf-max',
    label: 'leaf chunk (at the 2 MiB cap)',
    family: 'leaf',
    certain: true,
    precision: 1,
    why: 'Exactly 2,097,152 bytes — pressed against the runtime’s MaxTransactionSize. All 15 are leaves.',
    test: (o) => o.codec === CODEC_RAW && o.size === 2097152,
  },
  {
    id: 'bundle-piece',
    label: 'bundle piece',
    family: 'leaf',
    certain: false,
    precision: 0.966,
    why: 'Raw, sha2-256, ≥ 128 KiB. This is the dominant shape on the chain: a `pad` CAR section at roughly 0.8–1.0 MiB. 61.5 % of every byte stored here is one of these. Measured 96.6 % leaf — a fingerprint, not a fact.',
    test: (o) => o.codec === CODEC_RAW && o.hashing === HASH_SHA2 && o.size >= 131072,
  },
  {
    id: 'deploy-file',
    label: 'deploy file',
    family: 'leaf',
    certain: false,
    precision: 0.994,
    why: 'Raw, sha2-256, under 128 KiB — one file inside an IPFS tree that a directory node points at. Measured 99.4 % leaf. sha2-256 is the fingerprint of IPFS-native tooling; the SDK defaults to blake2b.',
    test: (o) => o.codec === CODEC_RAW && o.hashing === HASH_SHA2,
  },
  {
    id: 'app-record',
    label: 'app record',
    family: 'standalone',
    certain: false,
    precision: 0.932,
    why: 'Raw, blake2b-256, ≤ 4 KiB — the shape of an SDK `store()` write: a small JSON or text record an app wrote directly. Measured 93.2 %.',
    test: (o) => o.codec === CODEC_RAW && o.hashing === HASH_BLAKE2B && o.size <= 4096,
  },
  {
    id: 'app-blob',
    label: 'SDK object',
    family: 'standalone',
    certain: false,
    precision: 0.983,
    why: 'Raw, blake2b-256 — written whole by `@parity/bulletin-sdk` rather than chunked by IPFS tooling. Measured 98.3 % standalone, i.e. referenced by no manifest.',
    test: (o) => o.codec === CODEC_RAW && o.hashing === HASH_BLAKE2B,
  },
  {
    id: 'unknown',
    label: 'unclassified',
    family: 'unknown',
    certain: false,
    precision: null,
    why: 'Neither dag-pb nor raw, or a hashing algorithm this chain has not used before. Nothing in the census landed here; if a row shows this, the chain is carrying something new.',
    test: () => true,
  },
]

const RULE_BY_ID = new Map(SHAPE_RULES.map((rule) => [rule.id, rule]))

export const FAMILY_LABEL = {
  dag: 'DAG node / manifest',
  leaf: 'piece of a larger upload',
  standalone: 'standalone object',
  unknown: 'unclassified',
}

/**
 * Tier 1: what this object is, from the index row alone. Zero requests, 100 % coverage.
 * @param {{codec:number, hashing:number, size:number}} record
 * @returns {typeof SHAPE_RULES[number]}
 */
export function classifyShape(record) {
  for (const rule of SHAPE_RULES) if (rule.test(record)) return rule
  return RULE_BY_ID.get('unknown')
}

export const shapeById = (id) => RULE_BY_ID.get(id) ?? null

/* ============================================================== DAG-PB decoding ========= */

/** UnixFS `Data.Type`. */
const UNIXFS_TYPE = { 0: 'Raw', 1: 'Directory', 2: 'File', 3: 'Metadata', 4: 'Symlink', 5: 'HAMTShard' }

/** Multihash codes the CID builder in cid.js emits, keyed the same way. */
const MULTIHASH_LENGTHS = new Set([34, 36, 38])

/**
 * Is this a well-formed binary CID of exactly `length` bytes?
 *
 * 34 = CIDv0 (`12 20` + 32) · 36 = CIDv1 sha2-256 · 38 = CIDv1 blake2b-256 (whose multihash
 * code 0xb220 is a THREE-byte varint). Anything else is not a link this chain produces.
 */
function isCidBytes(bytes, length) {
  if (bytes.length !== length) return false
  if (bytes[0] === 0x12 && bytes[1] === 0x20) return length === 34
  if (bytes[0] !== 0x01) return false
  let at = 1
  let codec
  ;[codec, at] = readVarint(bytes, at)
  if (![0x55, 0x70, 0x71, 0x0129].includes(codec)) return false
  let multihash
  ;[multihash, at] = readVarint(bytes, at)
  if (![0x12, 0xb220, 0x1b].includes(multihash)) return false
  return bytes[at] === 0x20 && at + 1 + 32 === length
}

/**
 * THE STRICT DAG-PB TEST. Use this one; the naive version is wrong.
 *
 * ⚠️ The obvious rule — "first byte is 0x12 or 0x0a, followed by a plausible varint" —
 * produced 101 false positives out of 3,658 raw-coded objects (2.8 %), overwhelmingly HTML
 * files that happen to begin with a newline (0x0a). This version additionally requires the
 * INNER field to be right: a links entry must open with a real CID of a length dag-pb
 * actually uses, and a data-first node must open with a UnixFS `Type` in range. Measured:
 * zero codec/bytes disagreements across all 5,363 distinct CIDs.
 */
export function looksLikeDagPb(bytes) {
  if (!bytes || bytes.length < 6) return false

  if (bytes[0] === 0x12) {
    // field 2 (Links), wire type 2 — a PBLink, whose own field 1 is the 34/36/38-byte CID.
    const [outer, afterOuter] = readVarint(bytes, 1)
    if (outer <= 0 || afterOuter + outer > bytes.length) return false
    if (bytes[afterOuter] !== 0x0a) return false
    const [hashLength, afterHash] = readVarint(bytes, afterOuter + 1)
    if (!MULTIHASH_LENGTHS.has(hashLength)) return false
    return isCidBytes(bytes.subarray(afterHash, afterHash + hashLength), hashLength)
  }

  if (bytes[0] === 0x0a) {
    // field 1 (Data), wire type 2 — a UnixFS Data message opening with field 1 (Type).
    const [outer, afterOuter] = readVarint(bytes, 1)
    if (outer <= 0 || afterOuter + outer > bytes.length) return false
    return bytes[afterOuter] === 0x08 && bytes[afterOuter + 1] <= 5
  }

  return false
}

/**
 * A bare CAR section: a varint length, then a block that opens with a valid CID. This is what
 * `pad` writes — the CAR's own header lives in a separate first object, so every section after
 * it has no framing of its own beyond the length prefix.
 */
export function looksLikeCarSection(bytes) {
  if (!bytes || bytes.length < 40) return false
  const [length, at] = readVarint(bytes, 0)
  if (length < 36 || at + length > bytes.length) return false
  for (const cidLength of [36, 38, 34]) {
    if (isCidBytes(bytes.subarray(at, at + cidLength), cidLength)) return true
  }
  return false
}

/** protobuf: read one key, return [fieldNumber, wireType, nextOffset]. */
function readKey(bytes, at) {
  const [key, next] = readVarint(bytes, at)
  return [Math.floor(key / 8), key & 7, next]
}

function parseLink(bytes) {
  const link = { digestHex: null, cidBytes: null, name: null, tsize: null }
  let at = 0
  while (at < bytes.length) {
    const [field, wire, afterKey] = readKey(bytes, at)
    if (afterKey === at) return null
    at = afterKey
    if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, at)
      at = afterLength
      if (at + length > bytes.length) return null
      const slice = bytes.subarray(at, at + length)
      at += length
      if (field === 1) {
        link.cidBytes = slice
        // Match on the DIGEST, not the CID string: the index is keyed by `content_hash`, and
        // the digest is the last 32 bytes of every CID form this chain uses. That avoids
        // having to re-encode CIDv0 (base58) just to look something up.
        link.digestHex = slice.length >= 32 ? toHex(slice.subarray(slice.length - 32)) : null
      } else if (field === 2) {
        link.name = new TextDecoder('utf-8', { fatal: false }).decode(slice)
      }
    } else if (wire === 0) {
      const [value, afterValue] = readVarint(bytes, at)
      at = afterValue
      if (field === 3) link.tsize = value
    } else return null
  }
  return link.digestHex ? link : null
}

function parseUnixfs(bytes) {
  const data = { type: null, typeName: null, filesize: null, blocksizes: [] }
  let at = 0
  while (at < bytes.length) {
    const [field, wire, afterKey] = readKey(bytes, at)
    if (afterKey === at) break
    at = afterKey
    if (wire === 0) {
      const [value, afterValue] = readVarint(bytes, at)
      at = afterValue
      if (field === 1) data.type = value
      else if (field === 3) data.filesize = value
      else if (field === 4) data.blocksizes.push(value)
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, at)
      at = afterLength
      if (at + length > bytes.length) break
      // field 4 packed — kubo writes it unpacked, but the encoding permits both.
      if (field === 4) {
        let inner = at
        while (inner < at + length) {
          const [value, next] = readVarint(bytes, inner)
          if (next === inner) break
          data.blocksizes.push(value)
          inner = next
        }
      }
      at += length
    } else break
  }
  data.typeName = UNIXFS_TYPE[data.type] ?? null
  return data
}

/**
 * Decode a DAG-PB node into its links and its UnixFS payload.
 *
 * `PBNode { optional bytes Data = 1; repeated PBLink Links = 2; }` — note that canonical
 * dag-pb serialises Links (field 2) BEFORE Data (field 1), which is why this reads fields in
 * whatever order they appear rather than assuming one.
 *
 * @returns {{links: Array<{digestHex,name,tsize}>, unixfs: object|null}|null} null when the
 *          bytes are not a parseable DAG-PB node — never a partial guess.
 */
export function decodeDagPb(bytes) {
  if (!bytes?.length) return null
  const links = []
  let data = null
  let at = 0
  while (at < bytes.length) {
    const [field, wire, afterKey] = readKey(bytes, at)
    if (afterKey === at || wire !== 2) return null // dag-pb has no scalar fields at this level
    at = afterKey
    const [length, afterLength] = readVarint(bytes, at)
    at = afterLength
    if (at + length > bytes.length) return null
    const slice = bytes.subarray(at, at + length)
    at += length
    if (field === 2) {
      const link = parseLink(slice)
      if (!link) return null
      links.push(link)
    } else if (field === 1) {
      data = slice
    } else return null
  }
  return { links, unixfs: data ? parseUnixfs(data) : null }
}

/* ============================================================ content verification ====== */

/**
 * Hash bytes with the algorithm the index says produced them, so a body fetched from a public
 * gateway can be checked against `content_hash` rather than trusted.
 *
 * This is what makes the link graph CHAIN-VERIFIED rather than gateway-asserted, and it is the
 * same distinction this app already draws between a signed submitter and a self-asserted
 * author field. A manifest that fails this check is a finding, not a fetch error.
 *
 * @returns {Promise<string|null>} hex digest, or null for an algorithm we cannot compute
 */
export async function digestOf(bytes, hashing) {
  if (hashing === HASH_SHA2) {
    // WebCrypto only exists in a secure context; the app is https-only, but degrade rather
    // than throw if it is ever opened over plain http.
    if (!globalThis.crypto?.subtle) return null
    return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)))
  }
  if (hashing === HASH_BLAKE2B) return toHex(blake2b(bytes, 32))
  if (hashing === HASH_KECCAK) return toHex(keccak256(bytes))
  return null
}

/* ==================================================================== grouping ========== */

/**
 * How far apart two consecutive pieces may sit for the ADJACENCY heuristic to keep them in the
 * same run. Deliberately tight.
 *
 * ⚠️ Proximity is a bad way to find chunk runs in general and the census says so: only 14 % of
 * multi-leaf manifests have all their leaves in one block, block spans reach 174,436, and the
 * gap between consecutive leaf blocks has p90 = 1,946. That is because leaves are DEDUPLICATED
 * across versions — re-deploying a site re-uses every unchanged section, so a fresh manifest
 * can point at leaves from 170k blocks earlier. A generous window would confidently merge two
 * unrelated deploys. 64 blocks (~7 minutes) catches the single-upload case and little else,
 * and every group it produces is labelled `inferred`, never `verified`.
 */
const ADJACENCY_MAX_GAP = 64

/**
 * @typedef {object} ChunkGroup
 * @property {string} id
 * @property {import('./index-store.js').StoredObject|null} manifest  the root DAG node, when known
 * @property {import('./index-store.js').StoredObject[]} members      pieces, newest first
 * @property {import('./index-store.js').StoredObject} anchor         where the row sits in a newest-first list
 * @property {'links'|'adjacency'} basis
 * @property {number} totalBytes    manifest + members
 * @property {number|null} fileSize UnixFS `filesize` off the manifest, when it is a File
 * @property {number} linkCount     links the manifest declares (0 for an inferred group)
 * @property {number} missing       links that resolve to nothing in the current window
 * @property {string|null} name
 * @property {string|null} kindName UnixFS node type
 * @property {number} expiryBlock   the SOONEST expiry in the group — when the upload breaks
 */

/**
 * Collapse the index into uploads.
 *
 * Two bases, and they are never presented as the same thing:
 *
 *   'links'      the manifest's own bytes were fetched and verified against `content_hash`,
 *                and these are the objects it points at, transitively. Ground truth.
 *   'adjacency'  no manifest body in hand, so a run of consecutive leaf-shaped entries from
 *                the same producer is offered as a guess. Inferred, and labelled as such.
 *
 * @param {import('./index-store.js').StoredObject[]} objects newest-first
 * @param {Map<string, {links: Array<{digestHex,name}>, unixfs: object|null}>} nodes
 *        digest hex -> decoded DAG-PB body, for however many have been fetched
 * @returns {{groups: ChunkGroup[], groupOf: Map<object, ChunkGroup>, roles: Map<string,string>,
 *            names: Map<string,string>, parts: Map<string,{parent:string,index:number,count:number}>}}
 */
export function computeGroups(objects, nodes) {
  /** digest -> 'leaf' | 'standalone' | 'dag-root' | 'dag-inner' | 'dag-unread' */
  const roles = new Map()
  const groups = []
  const groupOf = new Map()

  /* ---------------------------------------------------- tier 2: the real link graph ---- */

  // Which digests are pointed AT by something. A digest can be linked by several manifests
  // (that is what dedup across versions looks like), so the first parent wins for display and
  // the role is simply "referenced".
  const referencedBy = new Map()
  const linkName = new Map()
  /** digest -> "piece k of N of <parent>", from the parent's own link ORDER. */
  const parts = new Map()
  for (const [digest, node] of nodes) {
    const links = node.links ?? []
    links.forEach((link, i) => {
      if (!referencedBy.has(link.digestHex)) referencedBy.set(link.digestHex, digest)
      // A Directory names its children; a File's links are unnamed and ordered instead.
      if (link.name && !linkName.has(link.digestHex)) linkName.set(link.digestHex, link.name)
      if (!parts.has(link.digestHex)) parts.set(link.digestHex, { parent: digest, index: i + 1, count: links.length })
    })
  }

  for (const object of objects) {
    const digest = object.contentHashHex
    if (nodes.has(digest)) roles.set(digest, referencedBy.has(digest) ? 'dag-inner' : 'dag-root')
    else if (referencedBy.has(digest)) roles.set(digest, 'leaf')
    else if (object.shape.family === 'dag') roles.set(digest, 'dag-unread')
    else roles.set(digest, 'standalone')
  }

  const claimed = new Set()

  // EVERY index entry per digest, not just the first.
  //
  // ⚠️ `index.byContentHash` deliberately keeps the EARLIEST entry for a digest, because that
  // is the one that dies first and the app must never overstate how long a specific entry
  // lives. For an upload the question is the opposite one: a bundle can be reassembled while
  // AT LEAST ONE copy of each piece survives, so the piece's real deadline is its LATEST copy.
  // Re-storing is how people extend a lease on this chain, and a group that ignored the second
  // copy would report a site as broken while it still works.
  const byDigest = new Map()
  for (const object of objects) {
    const list = byDigest.get(object.contentHashHex)
    if (list) list.push(object)
    else byDigest.set(object.contentHashHex, [object])
  }
  const lastExpiry = (entries) => entries.reduce((latest, entry) => Math.max(latest, entry.expiryBlock), 0)

  // One group per ROOT manifest — the whole transitive tree, because a `pad` deploy is a
  // directory pointing at file manifests pointing at sections, and a reader wants "one
  // upload", not three levels of nesting.
  const rooted = new Set()
  for (const object of objects) {
    const digest = object.contentHashHex
    if (roles.get(digest) !== 'dag-root') continue
    // A re-store of the same root is the same upload; group it once, from its newest entry.
    if (rooted.has(digest)) continue
    rooted.add(digest)

    const seen = new Set([digest])
    const members = []
    let missing = 0
    let deadline = Infinity
    const walk = (nodeDigest) => {
      const node = nodes.get(nodeDigest)
      if (!node) return
      for (const link of node.links ?? []) {
        if (seen.has(link.digestHex)) continue
        seen.add(link.digestHex)
        const entries = byDigest.get(link.digestHex)
        if (!entries) {
          // A link into content the window no longer holds. Ordinary near the prune floor —
          // said plainly rather than counted as a group member that is not there.
          missing += 1
          continue
        }
        members.push(...entries)
        deadline = Math.min(deadline, lastExpiry(entries))
        walk(link.digestHex)
      }
    }
    walk(digest)
    if (!members.length) continue

    const manifestEntries = byDigest.get(digest) ?? [object]
    const node = nodes.get(digest)
    const extraManifestCopies = manifestEntries.filter((entry) => entry !== object)
    const all = [...manifestEntries, ...members]
    members.push(...extraManifestCopies)
    members.sort((a, b) => b.block - a.block || b.indexInBlock - a.indexInBlock)

    const group = {
      id: `links:${digest}`,
      manifest: object,
      members,
      /** Distinct CONTENT in the upload, as opposed to index entries holding it. */
      pieceCount: seen.size,
      anchor: all.reduce((newest, candidate) => (candidate.block > newest.block ? candidate : newest), object),
      basis: 'links',
      // The size of the UPLOAD — distinct content, counted once. `storedBytes` is what the
      // chain is actually holding, which is larger wherever a piece was stored twice.
      totalBytes: [...seen].reduce((sum, pieceDigest) => sum + (byDigest.get(pieceDigest)?.[0]?.size ?? 0), 0),
      storedBytes: all.reduce((sum, member) => sum + member.size, 0),
      fileSize: node?.unixfs?.filesize ?? null,
      linkCount: node?.links?.length ?? 0,
      missing,
      name: linkName.get(digest) ?? null,
      kindName: node?.unixfs?.typeName ?? null,
      // The upload breaks when some piece has no surviving copy left — the earliest of the
      // per-piece deadlines, each of which is that piece's LAST copy.
      expiryBlock: Math.min(deadline, lastExpiry(manifestEntries)),
      verified: object.bodyVerified === true,
    }
    groups.push(group)
    for (const member of all) {
      claimed.add(member)
      groupOf.set(member, group)
    }
  }

  /* ------------------------------------------- tier 1: adjacency, offered as a guess ---- */

  // Ascending, because an upload is written leaves-first and closed by its manifest: measured
  // at or after its last leaf in 887 / 887 cases.
  const ascending = objects.slice().reverse()
  let run = []
  const flush = (manifest) => {
    if (manifest && run.length >= 1 && run.length + 1 >= 2) {
      const all = [manifest, ...run]
      const group = {
        id: `adj:${manifest.contentHashHex}`,
        manifest,
        members: run.slice().sort((a, b) => b.block - a.block || b.indexInBlock - a.indexInBlock),
        pieceCount: all.length,
        anchor: manifest,
        basis: 'adjacency',
        totalBytes: all.reduce((sum, member) => sum + member.size, 0),
        storedBytes: all.reduce((sum, member) => sum + member.size, 0),
        fileSize: null,
        linkCount: 0,
        missing: 0,
        name: null,
        kindName: null,
        expiryBlock: Math.min(...all.map((member) => member.expiryBlock)),
        verified: false,
      }
      groups.push(group)
      for (const member of all) {
        claimed.add(member)
        groupOf.set(member, group)
      }
    }
    run = []
  }

  for (const object of ascending) {
    if (claimed.has(object)) {
      run = []
      continue
    }
    if (object.shape.family === 'dag') {
      // A manifest closes whatever run led up to it — but only one from the same producer,
      // since a blake2b writer and a sha2 writer are different tools that happen to interleave.
      if (run.length && object.hashing === run[0].hashing && object.block - run[run.length - 1].block <= ADJACENCY_MAX_GAP) flush(object)
      else run = []
      continue
    }
    if (object.shape.family !== 'leaf') {
      run = []
      continue
    }
    if (run.length && (object.hashing !== run[0].hashing || object.block - run[run.length - 1].block > ADJACENCY_MAX_GAP)) run = []
    run.push(object)
  }

  groups.sort((a, b) => b.anchor.block - a.anchor.block || b.anchor.indexInBlock - a.anchor.indexInBlock)
  return { groups, groupOf, roles, names: linkName, parts }
}

export const ROLE_LABEL = {
  leaf: 'piece of a manifest',
  standalone: 'referenced by nothing',
  'dag-root': 'root manifest',
  'dag-inner': 'manifest inside another',
  'dag-unread': 'manifest, body not read',
}
