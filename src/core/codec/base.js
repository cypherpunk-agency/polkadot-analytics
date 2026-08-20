// base32 (RFC 4648 lowercase, unpadded) and base58btc — the two alphabets this app needs.
//
// base32 is multibase 'b', the prefix every CIDv1 the Bulletin chain produces is written in.
// base58btc is what SS58 addresses are written in. Neither is in the platform, and pulling
// a multiformats package in for 40 lines of table lookup would be silly.
//
// Both are ENCODE-heavy and DECODE-light here: we build CIDs and addresses from raw bytes,
// and only ever decode a CID when the user pastes one into the lookup box.

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Lowercase, unpadded — the form CIDv1 uses. Padding would make the CID invalid. */
export function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** @returns {Uint8Array|null} — null for any character outside the alphabet. */
export function base32Decode(text) {
  const clean = String(text ?? '').toLowerCase()
  const out = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = B32.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/**
 * Long division on the byte array rather than BigInt, because base58 has to preserve
 * LEADING ZERO BYTES as literal '1' characters — and a BigInt round-trip loses them.
 * An SS58 address for an account whose first byte is zero would come out short.
 */
export function base58Encode(bytes) {
  if (bytes.length === 0) return ''

  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const digits = [0]
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]]
  return out
}

/** Unsigned LEB128 — the varint multiformats uses inside a CID. */
export function varint(value) {
  const out = []
  let n = value
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

/** @returns {[number, number]} [value, nextOffset]. */
export function readVarint(bytes, at) {
  let value = 0
  let shift = 1
  let offset = at
  for (;;) {
    const byte = bytes[offset]
    if (byte === undefined) return [value, offset]
    offset += 1
    value += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) return [value, offset]
    shift *= 128
  }
}
