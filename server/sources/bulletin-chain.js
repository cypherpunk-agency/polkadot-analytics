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
import { concat, toHex, fromHex, leHexToNumber, u32le, utf8 } from '../../src/core/codec/bytes.js'

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
 * ⚠️ **FALLBACK ONLY — never import this to compute with.** Call `readRetentionBlocks()`, which
 * reads the live value and hands back the provenance alongside it. This literal exists for one
 * case: the single-node devnet is unreachable and there is no earlier reading to serve. It is
 * then LABELLED as inherited everywhere it reaches the screen, because an unlabelled 201,600 is
 * indistinguishable from a measured one and would be wrong in the same direction for every
 * expiry figure on the page at once.
 */
export const RETENTION_BLOCKS_FALLBACK = 201_600

/**
 * `TransactionStorage.RetentionPeriod` — a STORAGE key, and the fact that it is storage rather
 * than a runtime constant is the whole point of this block.
 *
 * ⚠️ **It is NOT in `state_getMetadata`, and looking for it there is the trap.** Storage values
 * never appear in metadata. Verified against the Products Devnet (`specVersion` 2003001,
 * `system_chain` = "Bulletin Paseo") on 2026-08-20: in the whole 166,531-byte metadata blob the
 * u32-LE byte pattern for 201,600 (`80 13 03 00`) occurs exactly ONCE, 22 bytes after the name
 * `AuthorizationPeriod` — so the only 201,600 the metadata contains belongs to a DIFFERENT
 * constant governing a DIFFERENT mechanism (how long an upload allowance lasts). The string
 * `RetentionPeriod` occurs in that blob only as a storage-entry name and inside doc comments,
 * never with a value. Reading "the retention constant" out of metadata therefore returns a
 * plausible number that is not the retention period, and nothing downstream would reveal it.
 *
 * ⚠️ **And because it is storage, governance can change it at any moment** — no runtime upgrade,
 * no `specVersion` bump, no signal of any kind. That is why it is re-read rather than trusted.
 *
 * Verified live 2026-08-20: this computes to
 * `0x0e7b504e5df47062be129a8958a7a1278d69b77f53c8c31f3b84d472fdb7de2b`, and `state_getStorage`
 * on it returns `0x80130300` = 201,600. The same derivation, run against the pallet's other
 * items, reproduces `ByteFee` and `EntryFee` correctly, so this is not a lucky offset.
 */
export const RETENTION_PERIOD_KEY = `0x${toHex(concat(twox128(utf8('TransactionStorage')), twox128(utf8('RetentionPeriod'))))}`

/**
 * How long a live reading stays good. An hour: governance CAN move a storage value at any time,
 * but it does not do so often enough to justify a read on every request — and the read is a
 * round-trip at a node that is one machine.
 */
const RETENTION_TTL_MS = 3_600_000

/** @type {{ blocks: number, raw: string, readAt: number } | null} The last reading that worked. */
let lastLiveRetention = null

/** @typedef {{
 *   blocks: number,
 *   source: 'chain'|'fallback',
 *   key: string,
 *   raw: string|null,
 *   readAt: string|null,
 *   ageMs: number|null,
 *   stale: boolean,
 *   unreachable: boolean,
 *   reason: string|null,
 * }} Retention */

/** @returns {Retention} */
function fromReading(entry, ttlMs, unreachable) {
  const ageMs = Date.now() - entry.readAt
  return {
    blocks: entry.blocks,
    source: 'chain',
    key: RETENTION_PERIOD_KEY,
    raw: entry.raw,
    readAt: new Date(entry.readAt).toISOString(),
    ageMs,
    stale: ageMs >= ttlMs,
    unreachable,
    reason: null,
  }
}

/**
 * @param {string} reason stated on the page verbatim — it is the difference between "we read
 *   this" and "we inherited this", and a reader is owed which one they are looking at.
 * @returns {Retention}
 */
function fromLiteral(reason, unreachable = false) {
  return {
    blocks: RETENTION_BLOCKS_FALLBACK,
    source: 'fallback',
    key: RETENTION_PERIOD_KEY,
    raw: null,
    // null rather than 0 or "now": there was no read, and a zero-age would read as a fresh one.
    readAt: null,
    ageMs: null,
    stale: false,
    unreachable,
    reason,
  }
}

/**
 * The retention period, read from chain state, with where it came from attached.
 *
 * ONE attempt, never a retry. The Products Devnet is a single node and it does go down — it was
 * unreachable for several minutes on 2026-08-19 and answering normally later the same day. That
 * is an ordinary state to report, not a fault to hammer through; a retry loop here would turn a
 * node taking a nap into a slow page and still produce the same answer.
 *
 * Degradation is in two steps, and both are labelled:
 *   1. the last reading that worked, if there is one — stale, dated, but a real measurement;
 *   2. the inherited literal, which is the only case where the page is showing a number nobody
 *      on this deployment has ever confirmed.
 *
 * An answer that arrives but is not a u32 goes straight to (2) rather than being coerced. A
 * wrong retention is invisible downstream — every block and day figure would be consistently,
 * plausibly wrong — so anything surprising has to fail to the labelled literal.
 *
 * @param {(method: string, params?: unknown[]) => Promise<unknown>} call
 * @returns {Promise<Retention>}
 */
export async function readRetentionBlocks(call, { ttlMs = RETENTION_TTL_MS } = {}) {
  const cached = lastLiveRetention
  if (cached && Date.now() - cached.readAt < ttlMs) return fromReading(cached, ttlMs, false)

  let raw
  try {
    raw = await call('state_getStorage', [RETENTION_PERIOD_KEY])
  } catch {
    return cached
      ? fromReading(cached, ttlMs, true)
      : fromLiteral('the devnet node could not be reached for the storage read', true)
  }

  if (raw === null || raw === undefined) {
    return fromLiteral('the chain answered, and has nothing stored under the RetentionPeriod key')
  }
  const hex = String(raw).replace(/^0x/, '')
  if (hex.length !== 8) {
    return fromLiteral(`the RetentionPeriod key holds ${hex.length / 2} bytes, not the u32 this item is`)
  }
  const blocks = leHexToNumber(hex)
  if (!Number.isFinite(blocks) || blocks <= 0) {
    return fromLiteral(`the chain returned RetentionPeriod = ${blocks}, which is not a lease length`)
  }

  lastLiveRetention = { blocks, raw: `0x${hex}`, readAt: Date.now() }
  return fromReading(lastLiveRetention, ttlMs, false)
}

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

  // Read, not assumed — and the provenance travels with it, because a caller that gets a bare
  // number back has no way to tell a measurement from an inherited literal.
  const retention = await readRetentionBlocks((method, params) => rpc.call(method, params))

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
    /** Where the retention figure came from — `chain` or the labelled `fallback`. */
    retention,
    timeOf(block) {
      return this.headTime + (block - this.anchorBlock) * this.blockMs
    },
    /** The block at which the index entry for `block` is pruned, and when that lands. */
    expiryBlockOf: (block) => block + retention.blocks,
    retentionMs() {
      return retention.blocks * this.blockMs
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
