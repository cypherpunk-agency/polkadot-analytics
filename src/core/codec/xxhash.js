// xxHash64 and Substrate's twox128, ~60 lines, no dependencies.
//
// One job: build the `TransactionStorage.Transactions` storage prefix, which is
// twox128("TransactionStorage") ++ twox128("Transactions"). That prefix is the entry
// point to the entire index — without it there is no app.
//
// BigInt here, not the 32-bit word trick used in blake2b.js, and deliberately: this runs
// exactly twice, at boot, over two short ASCII strings. Readability wins where speed does
// not matter, and 64-bit multiply-with-wraparound is genuinely nasty in 32-bit halves.

const MASK = (1n << 64n) - 1n
const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P3 = 1609587929392839161n
const P4 = 9650029242287828579n
const P5 = 2870177450012600261n

const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK
const mul = (a, b) => (a * b) & MASK

const readU64 = (bytes, at) => {
  let out = 0n
  for (let i = 7; i >= 0; i -= 1) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}
const readU32 = (bytes, at) => {
  let out = 0n
  for (let i = 3; i >= 0; i -= 1) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}

const round = (acc, lane) => mul(rotl((acc + mul(lane, P2)) & MASK, 31), P1)

/** @returns {bigint} the 64-bit digest. */
export function xxhash64(input, seed = 0) {
  const seed64 = BigInt(seed)
  const length = input.length
  let position = 0
  let h

  if (length >= 32) {
    let v1 = (seed64 + P1 + P2) & MASK
    let v2 = (seed64 + P2) & MASK
    let v3 = seed64
    let v4 = (seed64 - P1) & MASK

    while (position + 32 <= length) {
      v1 = round(v1, readU64(input, position))
      v2 = round(v2, readU64(input, position + 8))
      v3 = round(v3, readU64(input, position + 16))
      v4 = round(v4, readU64(input, position + 24))
      position += 32
    }

    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & MASK
    for (const lane of [v1, v2, v3, v4]) {
      h = (mul(h ^ mul(rotl(mul(lane, P2), 31), P1), P1) + P4) & MASK
    }
  } else {
    h = (seed64 + P5) & MASK
  }

  h = (h + BigInt(length)) & MASK

  while (position + 8 <= length) {
    h = (mul(rotl(h ^ mul(rotl(mul(readU64(input, position), P2), 31), P1), 27), P1) + P4) & MASK
    position += 8
  }
  if (position + 4 <= length) {
    h = (mul(rotl(h ^ mul(readU32(input, position), P1), 23), P2) + P3) & MASK
    position += 4
  }
  while (position < length) {
    h = mul(rotl(h ^ mul(BigInt(input[position]), P5), 11), P1)
    position += 1
  }

  h = mul(h ^ (h >> 33n), P2)
  h = mul(h ^ (h >> 29n), P3)
  return h ^ (h >> 32n)
}

/** Substrate writes each 64-bit half LITTLE-endian, then concatenates. */
export function twox128(input) {
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, xxhash64(input, 0), true)
  view.setBigUint64(8, xxhash64(input, 1), true)
  return out
}
