// keccak256, ~90 lines, no dependencies. Lifted verbatim from apps/plaza/src/lib/keccak.js;
// the two apps share no code because plaza's `src/lib` is another app's private surface.
//
// Needed here for the app-expiry board, which is the only part of this explorer that talks to
// Asset Hub rather than Bulletin: every `eth_call` needs a 4-byte selector (keccak of the
// signature) and every DotNS record is keyed by a namehash (a keccak tree over the labels).
// Pulling viem in for it would put a general-purpose ABI/crypto library into a bundle whose
// entire job is anonymous reads.
//
// This is Keccak-f[1600] with the ORIGINAL padding (0x01), which is what Ethereum uses — NOT
// SHA3-256's 0x06. Getting that wrong produces plausible-looking hashes that match nothing.
//
// Lanes are held as 32-bit hi/lo pairs rather than BigInt: ~20× faster and avoids allocating a
// BigInt per round, which matters when hashing a scope id on every render.

const ROUND_CONSTANTS = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
]

// The ρ rotation offsets and π lane permutation, in the order the combined ρ∘π loop walks them.
// Both are 24 long and must stay index-aligned with each other.
const ROTATION = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44]
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]

/** Rotate a 64-bit lane held as [hi, lo] left by n. */
function rotl(hi, lo, n) {
  if (n === 0) return [hi, lo]
  if (n < 32) return [((hi << n) | (lo >>> (32 - n))) >>> 0, ((lo << n) | (hi >>> (32 - n))) >>> 0]
  if (n === 32) return [lo >>> 0, hi >>> 0]
  const m = n - 32
  return [((lo << m) | (hi >>> (32 - m))) >>> 0, ((hi << m) | (lo >>> (32 - m))) >>> 0]
}

function keccakF(state) {
  const c = new Array(10)
  for (let round = 0; round < 24; round += 1) {
    // θ
    for (let x = 0; x < 5; x += 1) {
      c[x * 2] = state[x * 2] ^ state[(x + 5) * 2] ^ state[(x + 10) * 2] ^ state[(x + 15) * 2] ^ state[(x + 20) * 2]
      c[x * 2 + 1] =
        state[x * 2 + 1] ^ state[(x + 5) * 2 + 1] ^ state[(x + 10) * 2 + 1] ^ state[(x + 15) * 2 + 1] ^ state[(x + 20) * 2 + 1]
    }
    for (let x = 0; x < 5; x += 1) {
      const [rhi, rlo] = rotl(c[((x + 1) % 5) * 2], c[((x + 1) % 5) * 2 + 1], 1)
      const dhi = c[((x + 4) % 5) * 2] ^ rhi
      const dlo = c[((x + 4) % 5) * 2 + 1] ^ rlo
      for (let y = 0; y < 25; y += 5) {
        state[(x + y) * 2] ^= dhi
        state[(x + y) * 2 + 1] ^= dlo
      }
    }

    // ρ and π
    let lastHi = state[2]
    let lastLo = state[3]
    for (let i = 0; i < 24; i += 1) {
      const j = PI[i]
      const tmpHi = state[j * 2]
      const tmpLo = state[j * 2 + 1]
      const [rhi, rlo] = rotl(lastHi, lastLo, ROTATION[i])
      state[j * 2] = rhi
      state[j * 2 + 1] = rlo
      lastHi = tmpHi
      lastLo = tmpLo
    }

    // χ
    for (let y = 0; y < 25; y += 5) {
      const t = []
      for (let x = 0; x < 5; x += 1) {
        t[x * 2] = state[(y + x) * 2]
        t[x * 2 + 1] = state[(y + x) * 2 + 1]
      }
      for (let x = 0; x < 5; x += 1) {
        state[(y + x) * 2] = t[x * 2] ^ (~t[((x + 1) % 5) * 2] & t[((x + 2) % 5) * 2])
        state[(y + x) * 2 + 1] = t[x * 2 + 1] ^ (~t[((x + 1) % 5) * 2 + 1] & t[((x + 2) % 5) * 2 + 1])
      }
    }

    // ι
    state[0] ^= ROUND_CONSTANTS[round][0]
    state[1] ^= ROUND_CONSTANTS[round][1]
  }
}

/** @param {Uint8Array} input @returns {Uint8Array} 32 bytes */
export function keccak256(input) {
  const RATE = 136 // 1088 bits, the rate for keccak-256
  const state = new Int32Array(50)
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE)
  padded.set(input)
  padded[input.length] = 0x01 // Keccak padding, NOT SHA3's 0x06
  padded[padded.length - 1] |= 0x80

  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i += 1) {
      const b = offset + i * 8
      // Little-endian lanes: lo word is the first four bytes.
      state[i * 2 + 1] ^=
        (padded[b] | (padded[b + 1] << 8) | (padded[b + 2] << 16) | (padded[b + 3] << 24)) >>> 0
      state[i * 2] ^=
        (padded[b + 4] | (padded[b + 5] << 8) | (padded[b + 6] << 16) | (padded[b + 7] << 24)) >>> 0
    }
    keccakF(state)
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i += 1) {
    const lo = state[i * 2 + 1]
    const hi = state[i * 2]
    out[i * 8] = lo & 0xff
    out[i * 8 + 1] = (lo >>> 8) & 0xff
    out[i * 8 + 2] = (lo >>> 16) & 0xff
    out[i * 8 + 3] = (lo >>> 24) & 0xff
    out[i * 8 + 4] = hi & 0xff
    out[i * 8 + 5] = (hi >>> 8) & 0xff
    out[i * 8 + 6] = (hi >>> 16) & 0xff
    out[i * 8 + 7] = (hi >>> 24) & 0xff
  }
  return out
}

const encoder = new TextEncoder()

export const toHex = (bytes) => {
  let out = '0x'
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** keccak256 of a UTF-8 string, as 0x-prefixed hex. This is PlazaHeads' `scopeId(name)`. */
export const keccakHex = (text) => toHex(keccak256(encoder.encode(text)))
