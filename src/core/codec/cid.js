// CID reconstruction. The chain does not store CIDs — it stores the ingredients.
//
// `TransactionInfo` carries a 32-byte `content_hash`, a one-byte `hashing` enum and an
// 8-byte `cid_codec`. A CIDv1 is exactly those three plus framing:
//
//   multibase 'b' ++ base32( varint(1) varint(codec) varint(multihash) varint(32) hash )
//
// So every object in the index is addressable without a single extra request. This is the
// piece that turns a storage map of opaque records into a browsable list of content.

import { base32Encode, base32Decode, varint, readVarint } from './base.js'
import { toHex } from './bytes.js'

/** The `hashing` enum, as the pallet stores it, mapped to multihash codes. */
export const MULTIHASH = { 0: 0xb220, 1: 0x12, 2: 0x1b }
export const HASH_NAME = { 0: 'blake2b-256', 1: 'sha2-256', 2: 'keccak-256' }

/**
 * Codec names we have actually seen or can name with confidence. Anything else renders
 * as its raw hex — never invent a label for a number we have not verified.
 */
export const CODEC_NAME = {
  0x55: 'raw',
  0x70: 'dag-pb',
  0x71: 'dag-cbor',
  0x0129: 'dag-json',
  0x00: 'identity',
}

export const codecLabel = (codec) => CODEC_NAME[codec] ?? `codec 0x${codec.toString(16)}`

/**
 * @param {Uint8Array} contentHash 32 bytes
 * @param {number} hashing the pallet's enum, 0..2
 * @param {number} codec
 * @returns {string|null} null when `hashing` is a variant we cannot map — better no CID
 *          than a confidently wrong one.
 */
export function buildCid(contentHash, hashing, codec) {
  const multihash = MULTIHASH[hashing]
  if (multihash === undefined || contentHash.length !== 32) return null
  const body = [...varint(1), ...varint(codec), ...varint(multihash), ...varint(32), ...contentHash]
  return `b${base32Encode(Uint8Array.from(body))}`
}

/**
 * Inverse, for the CID lookup box. Returns the parts we can match against the index.
 * @returns {{version,codec,multihash,digestHex}|null}
 */
export function parseCid(text) {
  const clean = String(text ?? '').trim()
  if (!clean.startsWith('b')) return null // only multibase base32; we never emit anything else
  const bytes = base32Decode(clean.slice(1))
  if (!bytes || bytes.length < 6) return null

  let offset = 0
  let version
  let codec
  let multihash
  let digestLength
  ;[version, offset] = readVarint(bytes, offset)
  if (version !== 1) return null
  ;[codec, offset] = readVarint(bytes, offset)
  ;[multihash, offset] = readVarint(bytes, offset)
  ;[digestLength, offset] = readVarint(bytes, offset)
  const digest = bytes.slice(offset, offset + digestLength)
  if (digest.length !== digestLength) return null

  return { version, codec, multihash, digestHex: toHex(digest) }
}

/** EIP-1577 namespace code for IPFS. Encodes as the TWO-byte varint 0xe3 0x01. */
const IPFS_NS = 0xe3

/**
 * EIP-1577 contenthash, as DotNS stores it: varint(0xe3) ++ the CID bytes.
 *
 * ⚠️ The namespace code is a VARINT, so `0xe3` occupies two bytes — `e3 01` — and a real
 * record reads `0xe301 01 70 1220 <32>`: ipfs-ns, CIDv1, dag-pb, sha2-256. Consuming only the
 * single byte `e3` shifts every field one position and yields a CID that is well-formed,
 * base32-clean and completely wrong (version 1, codec 1, digest length 18). It resolves to
 * nothing and matches nothing in the index, which looks exactly like an expired bundle.
 *
 * The decode is otherwise general, so a future resolver record does not silently mis-render.
 * @returns {{cid,codec,multihash,digestHex}|null}
 */
export function parseContenthash(hex) {
  const clean = String(hex ?? '').replace(/^0x/, '')
  if (clean.length < 12) return null
  const bytes = []
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16))
  const all = Uint8Array.from(bytes)

  let offset = 0
  let namespace
  ;[namespace, offset] = readVarint(all, offset)
  if (namespace !== IPFS_NS) return null

  // Everything after the namespace varint is the CID verbatim — so the CID string is just a
  // re-encode of these bytes, never a reassembly from the parsed parts.
  const body = all.slice(offset)

  let at = 0
  let version
  let codec
  let multihash
  let digestLength
  ;[version, at] = readVarint(body, at)
  if (version !== 1) return null
  ;[codec, at] = readVarint(body, at)
  ;[multihash, at] = readVarint(body, at)
  ;[digestLength, at] = readVarint(body, at)
  const digest = body.slice(at, at + digestLength)
  if (digest.length !== digestLength) return null

  return { cid: `b${base32Encode(body)}`, codec, multihash, digestHex: toHex(digest) }
}
