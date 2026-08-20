// Everything this app knows about the Bulletin chain's shape: where the index lives, how to
// address one block of it, how to turn a block number into a wall-clock time, and how to find
// out who signed a store.
//
// All of it is measured, not assumed — the constants below were verified live against
// `bulletin-paseo.tservices.es:8443` and the checks are in the comments so a future reader can
// re-run them instead of trusting this file.

import { twox128 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { encodeSs58 } from '../../src/core/codec/ss58.js'
import { decodeCompact } from '../../src/core/codec/scale.js'
import { concat, toHex, fromHex, u32le, utf8 } from '../../src/core/codec/bytes.js'

/**
 * `TransactionStorage.Transactions: BlockNumber -> Vec<TransactionInfo>`.
 *
 * Verified: this computes to
 * 0x0e7b504e5df47062be129a8958a7a127ab1e1015a9876a8ce71a2f1cfd772bc9
 * which is the prefix a `state_getKeysPaged` sweep of the live chain returns keys under.
 */
export const TRANSACTIONS_PREFIX = `0x${toHex(concat(twox128(utf8('TransactionStorage')), twox128(utf8('Transactions'))))}`

/**
 * The pallet's `RetentionPeriod`, in blocks. This is the number that actually governs expiry:
 * the index self-prunes the entry for block `n - RetentionPeriod - 1`, so an object's lifetime
 * is denominated in BLOCKS and is exact. Any figure in days is a projection off the current
 * block rate and is only as good as that rate — which is why `blockMs` is measured rather than
 * assumed, and why the UI leads with blocks and offers days as the derived number.
 *
 * ⚠️ **INHERITED, NOT VERIFIED BY THIS REPO.** The value came from `yolodot/bulletin-explorer`,
 * where it is documented as read from the live devnet chain. We have not re-read it here, and
 * there is a specific reason to be careful: on the sibling chain `paseo-bulletin-next`,
 * `AuthorizationPeriod` is *also* 201,600 while `RetentionPeriod` is a different number. A
 * transcription that grabbed the wrong constant would be invisible — the figure is plausible,
 * the arithmetic downstream is correct, and the resulting "≈ 15.7 days" would simply be wrong.
 *
 * To settle it: fetch `state_getMetadata` from the Bulletin RPC and read the
 * `TransactionStorage` pallet's constants, rather than trusting either this line or the sibling
 * chain. The page states the caveat until someone does.
 */
export const RETENTION_BLOCKS = 201_600

/** The pallet's nominal block time. Kept only to show the drift against the measured rate. */
export const NOMINAL_BLOCK_MS = 6_030

/**
 * The storage key for one block's entry. `Blake2_128Concat` = blake2b-128(encoded key) ++ the
 * encoded key itself, and the key here is a plain fixed-width u32 little-endian (NOT a SCALE
 * compact — this is a map key, not a call argument).
 *
 * That the key is COMPUTABLE is what makes a live tail cheap: polling the newest 20 blocks is
 * one `state_queryStorageAt` over 20 derived keys, ~50 ms, with no key enumeration at all.
 */
export function transactionsKey(blockNumber) {
  const encoded = u32le(blockNumber)
  return TRANSACTIONS_PREFIX + toHex(blake2b(encoded, 16)) + toHex(encoded)
}

/** Inverse: the last 4 bytes of a key are the block number, little-endian. */
export function blockOfKey(key) {
  const hex = String(key).replace(/^0x/, '')
  const le = hex.slice(TRANSACTIONS_PREFIX.length - 2 + 32) // prefix (64 nibbles) + hash (32)
  let out = 0
  for (let i = le.length - 2; i >= 0; i -= 2) out = out * 256 + parseInt(le.slice(i, i + 2), 16)
  return out
}

/* ------------------------------------------------------------------- block timestamps ---- */

/**
 * The timestamp inherent, found by SHAPE rather than by position or pallet index.
 *
 * ⚠️ It is NOT extrinsic 0 on this chain. Bulletin's inherent set puts an ~8 KiB storage-proof
 * extrinsic first and the timestamp SECOND, so the usual `extrinsics[0]` shortcut silently
 * decodes the wrong thing. It is also not safe to hardcode the pallet index, which is a
 * runtime-layout detail that can move across an upgrade.
 *
 * So: scan for a BARE (unsigned) extrinsic whose payload, read as a compact integer starting
 * just past the version/pallet/call bytes, consumes the extrinsic EXACTLY and lands in a
 * plausible epoch-millisecond range. Timestamp.set is the only inherent shaped like that, and
 * the "consumes exactly" test is what makes the match self-verifying rather than a guess.
 *
 * Verified against blocks 254107 and 252288: 2026-07-27T14:15:06Z and 2026-07-27T11:09:06Z.
 * @returns {number|null} epoch ms
 */
export function timestampOfBlock(extrinsics) {
  for (const extrinsic of extrinsics ?? []) {
    const hex = String(extrinsic).replace(/^0x/, '')
    const [, afterLength] = decodeCompact(hex, 0)
    const version = parseInt(hex.slice(afterLength, afterLength + 2), 16)
    if (Number.isNaN(version) || version & 0x80) continue // 0x80 is the signed bit

    // version(1) + pallet(1) + call(1) = 6 nibbles, then the compact u64.
    const [ms, end] = decodeCompact(hex, afterLength + 6)
    if (end !== hex.length) continue
    // ~2017-07 to ~2096. Wide enough not to be a calendar assumption, narrow enough that no
    // other compact field in an inherent lands inside it.
    if (ms > 1_500_000_000_000 && ms < 4_000_000_000_000) return ms
  }
  return null
}

/**
 * Two-point calibration: read the real timestamp at the head and at a block far behind it, and
 * interpolate everything in between.
 *
 * Why not just multiply by 6.03 s: the measured rate over the last 200,000 blocks is 6.457 s,
 * 7% slower than nominal. Across a 201,600-block retention window that is a ~1-day error at
 * the far end — enough to put an object in the wrong day bucket and to misstate an expiry
 * countdown by hours. Two points cost two extra round-trips and remove almost all of it.
 *
 * The result is still an ESTIMATE for every block we did not actually read, and the UI says so.
 * The detail view fetches the true timestamp for the one block you are looking at.
 */
export async function calibrateClock(rpc, { spanBlocks = 200_000 } = {}) {
  const header = await rpc.call('chain_getHeader')
  const headBlock = parseInt(header.number, 16)

  const timestampAt = async (block) => {
    const hash = await rpc.call('chain_getBlockHash', [block])
    if (!hash) return null
    const signed = await rpc.call('chain_getBlock', [hash])
    return timestampOfBlock(signed?.block?.extrinsics)
  }

  // One back from the head: the very newest block occasionally races the RPC's own view.
  const headTime = await timestampAt(headBlock - 1)
  const farBlock = Math.max(1, headBlock - spanBlocks)
  const farTime = farBlock < headBlock - 1 ? await timestampAt(farBlock) : null

  const blockMs =
    headTime && farTime && headBlock - 1 > farBlock
      ? (headTime - farTime) / (headBlock - 1 - farBlock)
      : NOMINAL_BLOCK_MS

  return {
    headBlock,
    headTime: headTime ?? Date.now(),
    /** Measured; falls back to nominal only if a timestamp could not be read at all. */
    blockMs,
    measured: Boolean(headTime && farTime),
    /** Anchor is head-1, the block we actually read. */
    anchorBlock: headBlock - 1,
    timeOf(block) {
      return this.headTime + (block - this.anchorBlock) * this.blockMs
    },
    /** The block at which the index entry for `block` is pruned, and when that lands. */
    expiryBlockOf: (block) => block + RETENTION_BLOCKS,
    retentionMs() {
      return RETENTION_BLOCKS * this.blockMs
    },
  }
}

/* ------------------------------------------------------------------------- submitters ---- */

/**
 * The account that signed a store, read out of the extrinsic itself.
 *
 * Layout: compact length prefix, then `0x84` (extrinsic v4, signed bit set), then the
 * `MultiAddress` enum — `0x00` is `Id`, the only variant that carries a bare 32-byte AccountId.
 * Anything else (Index, Raw, Address32, Address20) means the signer was not addressed by
 * account id and we must not pretend to know who it was, hence the nulls rather than a guess.
 *
 * ⚠️ This is the ONLY authorship signal in the whole app that is chain-verified. A `.a` field
 * inside a Plaza object body is self-asserted by whoever wrote the bytes and is not evidence.
 * The UI must never render the two in the same style.
 *
 * Verified: block 254107 xt#2 -> 5DPsbkWF92281nHpm7RhYTR1Ws3bc7CS9cnR3rCJzL7HFtNU,
 *           block 252288 xt#2 -> 5Ge8cjAnPcsZqiYEKJFXtDfeGYDRgLg1feMmenN2fak8bcgA.
 * @returns {string|null} SS58, prefix 42
 */
export function submitterOfExtrinsic(extrinsic) {
  const hex = String(extrinsic ?? '').replace(/^0x/, '')
  if (!hex) return null
  const [, at] = decodeCompact(hex, 0)
  if (hex.slice(at, at + 2) !== '84') return null // unsigned, or a version we do not know
  if (hex.slice(at + 2, at + 4) !== '00') return null // MultiAddress variant other than Id
  const accountId = fromHex(hex.slice(at + 4, at + 4 + 64))
  return accountId.length === 32 ? encodeSs58(accountId, 42) : null
}

/**
 * Every submitter in one block, keyed by extrinsic index — one round-trip serves every object
 * stored in that block rather than one per object.
 * @returns {Promise<{submitters: Map<number,string>, timestamp: number|null}>}
 */
export async function readBlock(rpc, blockNumber) {
  const hash = await rpc.call('chain_getBlockHash', [blockNumber])
  if (!hash) return { submitters: new Map(), timestamp: null, hash: null }
  const signed = await rpc.call('chain_getBlock', [hash])
  const extrinsics = signed?.block?.extrinsics ?? []

  const submitters = new Map()
  extrinsics.forEach((extrinsic, index) => {
    const address = submitterOfExtrinsic(extrinsic)
    if (address) submitters.set(index, address)
  })
  return { submitters, timestamp: timestampOfBlock(extrinsics), hash }
}
