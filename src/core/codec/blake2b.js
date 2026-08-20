// BLAKE2b with a variable digest length, ~110 lines, no dependencies.
//
// Two callers, two digest sizes, and they are NOT interchangeable:
//   - blake2b(bytes, 16)  — the `Blake2_128Concat` half of a Substrate storage map key.
//                           Getting this wrong means every computed key misses and the
//                           live tail silently shows nothing, with no error anywhere.
//   - blake2b(bytes, 64)  — the SS58 checksum, over 'SS58PRE' ++ payload.
//
// Why hand-rolled: the alternative is pulling in @polkadot/util-crypto (WASM, ~1 MB) into
// a bundle whose entire job is to read public data anonymously. Same reasoning, and the
// same 32-bit-word technique, as apps/plaza/src/lib/keccak.js.
//
// 64-bit lanes are held as PAIRS of 32-bit words in a Uint32Array, little-endian
// (`h[i]` = low word, `h[i+1]` = high word). BigInt would be simpler to read and roughly
// an order of magnitude slower — and this runs once per block key on every tail poll.

// IV, pre-split into 32-bit halves in [lo, hi] order.
const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

// The message schedule, already doubled so it indexes the 32-bit word array directly.
//
// ⚠️ TWELVE rows, not ten. BLAKE2b runs 12 rounds over a 10-row schedule, so rounds 10 and 11
// reuse rows 0 and 1. Writing only the 10 canonical rows leaves `SIGMA[160…]` undefined, every
// lookup past round 9 mixes in NaN, and the digest is silently wrong — not obviously garbage,
// just wrong, which here means every computed storage key misses and the tail renders empty
// with no error anywhere. The last two rows below are duplicates of the first two, on purpose.
const SIGMA = new Uint8Array(
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    // rounds 10 and 11 — rows 0 and 1 again
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  ].map((x) => x * 2),
)

// Scratch, reused across calls. Single-threaded JS, and blake2b never yields mid-compress.
const v = new Uint32Array(32)
const m = new Uint32Array(32)

/** v[a] += v[b], carrying low into high. */
function add64(a, b) {
  const lo = v[a] + v[b]
  let hi = v[a + 1] + v[b + 1]
  if (lo >= 0x100000000) hi += 1
  v[a] = lo
  v[a + 1] = hi
}

/** v[a] += (hi,lo) constant. `lo` may arrive sign-extended from a Uint32Array read. */
function add64c(a, lo, hi) {
  let low = v[a] + lo
  if (lo < 0) low += 0x100000000
  let high = v[a + 1] + hi
  if (low >= 0x100000000) high += 1
  v[a] = low
  v[a + 1] = high
}

/** The G mixing function, with the four rotations (32, 24, 16, 63) unrolled. */
function mix(a, b, c, d, ix, iy) {
  add64(a, b)
  add64c(a, m[ix], m[ix + 1])

  // rotr 32 is a word swap.
  let x = v[d] ^ v[a]
  let y = v[d + 1] ^ v[a + 1]
  v[d] = y
  v[d + 1] = x

  add64(c, d)
  x = v[b] ^ v[c]
  y = v[b + 1] ^ v[c + 1]
  v[b] = (x >>> 24) ^ (y << 8)
  v[b + 1] = (y >>> 24) ^ (x << 8)

  add64(a, b)
  add64c(a, m[iy], m[iy + 1])

  x = v[d] ^ v[a]
  y = v[d + 1] ^ v[a + 1]
  v[d] = (x >>> 16) ^ (y << 16)
  v[d + 1] = (y >>> 16) ^ (x << 16)

  add64(c, d)
  x = v[b] ^ v[c]
  y = v[b + 1] ^ v[c + 1]
  // rotr 63 == rotl 1.
  v[b] = (y >>> 31) ^ (x << 1)
  v[b + 1] = (x >>> 31) ^ (y << 1)
}

function compress(ctx, last) {
  for (let i = 0; i < 16; i += 1) {
    v[i] = ctx.h[i]
    v[i + 16] = IV32[i]
  }
  v[24] ^= ctx.t
  v[25] ^= ctx.t / 0x100000000
  if (last) {
    v[28] = ~v[28]
    v[29] = ~v[29]
  }

  for (let i = 0; i < 32; i += 1) {
    const b = 4 * i
    m[i] = ctx.b[b] ^ (ctx.b[b + 1] << 8) ^ (ctx.b[b + 2] << 16) ^ (ctx.b[b + 3] << 24)
  }

  for (let round = 0; round < 12; round += 1) {
    const s = round * 16
    mix(0, 8, 16, 24, SIGMA[s], SIGMA[s + 1])
    mix(2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3])
    mix(4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5])
    mix(6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7])
    mix(0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9])
    mix(2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11])
    mix(4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13])
    mix(6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15])
  }

  for (let i = 0; i < 16; i += 1) ctx.h[i] ^= v[i] ^ v[i + 16]
}

/**
 * @param {Uint8Array} input
 * @param {number} outLength digest bytes, 1..64
 * @returns {Uint8Array}
 */
export function blake2b(input, outLength = 32) {
  const ctx = { b: new Uint8Array(128), h: new Uint32Array(IV32), t: 0, c: 0 }
  // Parameter block, keyless: 0x01010000 ^ (keylen << 8) ^ digest length.
  ctx.h[0] ^= 0x01010000 ^ outLength

  for (let i = 0; i < input.length; i += 1) {
    if (ctx.c === 128) {
      ctx.t += ctx.c
      compress(ctx, false)
      ctx.c = 0
    }
    ctx.b[ctx.c] = input[i]
    ctx.c += 1
  }

  ctx.t += ctx.c
  while (ctx.c < 128) {
    ctx.b[ctx.c] = 0
    ctx.c += 1
  }
  compress(ctx, true)

  const out = new Uint8Array(outLength)
  for (let i = 0; i < outLength; i += 1) out[i] = ctx.h[i >> 2] >> (8 * (i & 3))
  return out
}
