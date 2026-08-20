// The SCALE subset this app needs: compact integers, and `Vec<TransactionInfo>`.
//
// Decoding happens directly on the HEX STRING the RPC returns rather than on bytes. That
// sounds backwards, but the index arrives as ~700 KiB of hex in one response and every
// field we want is at a fixed nibble offset inside a fixed-width record — so slicing the
// string skips an entire 350 KiB Uint8Array allocation and a second pass over it. The
// helpers below take (hex, nibbleOffset) for that reason. Byte offsets are 2× nibbles;
// the constants are written out doubled so the arithmetic stays visible.

import { fromHex } from './bytes.js'

const leSlice = (hex, at, nibbles) => {
  let out = 0
  for (let i = at + nibbles - 2; i >= at; i -= 2) out = out * 256 + parseInt(hex.slice(i, i + 2), 16)
  return out
}

/**
 * SCALE compact integer. Two low bits select the width:
 *   00 single byte (6-bit value) · 01 two bytes · 10 four bytes · 11 big-integer mode
 * @returns {[number, number]} [value, nibble offset just past it]
 */
export function decodeCompact(hex, at = 0) {
  const first = parseInt(hex.slice(at, at + 2), 16)
  const mode = first & 3
  if (mode === 0) return [first >> 2, at + 2]
  if (mode === 1) return [leSlice(hex, at, 4) >> 2, at + 4]
  if (mode === 2) return [leSlice(hex, at, 8) >>> 2, at + 8]
  // Big-integer mode: the top six bits are (byte count − 4). Timestamps land here.
  const byteCount = (first >> 2) + 4
  let value = 0n
  for (let i = at + 2 + byteCount * 2 - 2; i >= at + 2; i -= 2) {
    value = value * 256n + BigInt(parseInt(hex.slice(i, i + 2), 16))
  }
  return [Number(value), at + 2 + byteCount * 2]
}

/**
 * `TransactionInfo` — 86 fixed bytes, no compacts, so a `Vec` of them is a flat stride.
 *
 *   chunk_root[32] content_hash[32] hashing[1] cid_codec[8 LE] size[4] extrinsic_index[4]
 *   block_chunks[4] kind[1]
 *
 * `kind` is the pallet's Store/Renew discriminant. We surface it rather than assume Store:
 * on this chain every single record has been Store so far, and an app that hid the field
 * would quietly misreport the day that changes.
 */
export const TRANSACTION_INFO_BYTES = 86
const RECORD_NIBBLES = TRANSACTION_INFO_BYTES * 2

/**
 * @param {string} value the 0x-hex of one `Transactions[block]` entry
 * @returns {Array<{chunkRootHex,contentHashHex,hashing,codec,size,extrinsicIndex,blockChunks,kind}>}
 */
export function decodeTransactionInfoVec(value) {
  const hex = String(value ?? '').replace(/^0x/, '')
  if (!hex) return []

  const [count, start] = decodeCompact(hex, 0)
  const out = []
  let at = start
  for (let i = 0; i < count; i += 1) {
    // A truncated tail means the node handed us something we do not understand. Stop and
    // return what decoded cleanly rather than emitting records made of undefined.
    if (at + RECORD_NIBBLES > hex.length) break
    out.push({
      chunkRootHex: hex.slice(at, at + 64),
      contentHashHex: hex.slice(at + 64, at + 128),
      hashing: parseInt(hex.slice(at + 128, at + 130), 16),
      codec: leSlice(hex, at + 130, 16),
      size: leSlice(hex, at + 146, 8),
      extrinsicIndex: leSlice(hex, at + 154, 8),
      blockChunks: leSlice(hex, at + 162, 8),
      kind: parseInt(hex.slice(at + 170, at + 172), 16),
    })
    at += RECORD_NIBBLES
  }
  return out
}

export const KIND_NAME = { 0: 'store', 1: 'renew' }

/** Hex of a 32-byte content hash, as a Uint8Array — for CID construction. */
export const hashBytes = (contentHashHex) => fromHex(contentHashHex)
