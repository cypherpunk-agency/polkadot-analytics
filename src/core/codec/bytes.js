// Byte plumbing. Everything downstream speaks Uint8Array; the RPC speaks 0x-hex.
//
// The whole app is a decoder, so these four functions are on the hot path of every
// screen. They stay allocation-light and never throw on odd input — a malformed
// hex string from a node we do not control must degrade to empty bytes, not blow
// up a render.

/** '0xdeadbeef' | 'deadbeef' -> Uint8Array. Non-hex input yields an empty array. */
export function fromHex(hex) {
  const text = String(hex ?? '').replace(/^0x/i, '')
  if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) return new Uint8Array(0)
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Uint8Array -> lowercase hex, no 0x prefix. Prefix at the call site if you want one. */
export function toHex(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export const hex0x = (bytes) => `0x${toHex(bytes)}`

export function concat(...parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** u32 little-endian, the encoding SCALE uses for a fixed-width block number. */
export function u32le(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}

/** Read a fixed-width little-endian unsigned integer out of a hex STRING slice. */
export function leHexToNumber(hex) {
  let out = 0
  for (let i = hex.length - 2; i >= 0; i -= 2) out = out * 256 + parseInt(hex.slice(i, i + 2), 16)
  return out
}

export const utf8 = (text) => new TextEncoder().encode(text)
