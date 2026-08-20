// The Polkadot Bulletin chain on the Products Devnet — content-addressed storage with a lease.
//
// This is the analytics half of `yolodot/apps/bulletin-explorer`, moved server-side. The
// explorer itself stays in yolodot; what lives here is the part that answers "what is actually
// stored on this chain, and what happens to it".
//
// ── why this one HAD to move behind a cache ─────────────────────────────────────────────────
// The explorer's own source says it plainly: resolving the full window is ~7,600 requests, and
// a read-only explorer firing thousands of calls at the single shared devnet node "would be the
// heaviest client on the chain". That is fine for a tool one person opens. Published at a public
// URL with no gate, it is a denial-of-service with our name on it. The index is loaded here,
// once per TTL, and every visitor reads the same snapshot.
//
// ⚠️ NOT `paseo-bulletin-next-rpc.polkadot.io`. That is a DIFFERENT chain with a different
// history; pointing this at it produces a plausible, fully-rendering, entirely wrong view.

import { jsonRpc } from '../lib/upstream.mjs'
import { decodeTransactionInfoVec, KIND_NAME } from '../../src/core/codec/scale.js'
import { buildCid, codecLabel, HASH_NAME } from '../../src/core/codec/cid.js'
import { fromHex } from '../../src/core/codec/bytes.js'
import { classifyShape } from '../../src/core/codec/shapes.js'
import { TRANSACTIONS_PREFIX, blockOfKey, NOMINAL_BLOCK_MS, readRetentionBlocks, timestampOfBlock } from './bulletin-chain.js'

/** The ONLY devnet Bulletin RPC endpoint we know of. Its absence is a first-class state. */
const RPC = 'https://bulletin-paseo.tservices.es:8443'

const KEY_PAGE = 1000
const VALUE_BATCH = 250

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

async function rpc(method, params, timeoutMs = 60_000) {
  return jsonRpc({ source: 'bulletin', url: RPC, method, params, timeoutMs, maxBytes: 48 * 1024 * 1024 })
}

/** Every key under `TransactionStorage.Transactions`, i.e. every block that stored something. */
async function allKeys() {
  const keys = []
  let start = TRANSACTIONS_PREFIX
  for (;;) {
    const page = await rpc('state_getKeysPaged', [TRANSACTIONS_PREFIX, KEY_PAGE, start])
    if (!page?.length) break
    keys.push(...page)
    if (page.length < KEY_PAGE) break
    start = page[page.length - 1]
  }
  return keys
}

/**
 * Size buckets are powers of two because the population spans 60-byte chat messages and 2 MiB
 * bundle chunks in one list; a linear histogram would be a single bar and a long empty tail.
 */
const bucketSpec = [
  { label: '< 1 KiB', max: 1024 },
  { label: '1–4 KiB', max: 4096 },
  { label: '4–16 KiB', max: 16_384 },
  { label: '16–64 KiB', max: 65_536 },
  { label: '64–256 KiB', max: 262_144 },
  { label: '256 KiB–1 MiB', max: 1_048_576 },
  { label: '≥ 1 MiB', max: Infinity },
]

/**
 * The exact wall-clock time of one block, read from its timestamp inherent.
 *
 * Only two blocks are timed this way — the oldest indexed one and the head — because each costs
 * two requests. Everything between is interpolated from the rate they imply. A failure here
 * degrades the day buckets to the pallet's nominal rate; it must not take the page down.
 */
async function blockTime(block) {
  try {
    const hash = await rpc('chain_getBlockHash', [block])
    const signed = await rpc('chain_getBlock', [hash])
    return timestampOfBlock(signed?.block?.extrinsics)
  } catch {
    return null
  }
}

const rank = (map) => [...map.values()].sort((a, b) => b.count - a.count)

const fmtCount = (n) => Number(n).toLocaleString('en-US')

/** Coarse on purpose: "47 minutes ago" implies a precision this staleness does not need. */
function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * The retention caveat, written from the reading itself rather than beside it.
 *
 * This is rule 3 at its sharpest. The retention period is the input to every expiry number on
 * the page, and the three ways it can arrive — read now, read earlier, never read — produce
 * identical-looking output. If the note were a fixed string it would eventually describe a
 * provenance the number does not have, which is worse than no note.
 */
function retentionNote(retention) {
  const why =
    'RetentionPeriod is a STORAGE value rather than a runtime constant, so it does not appear in the runtime metadata at ' +
    'all. The one 201,600 the metadata does contain belongs to AuthorizationPeriod, a different constant governing how long ' +
    'an upload allowance lasts — so reading "the retention constant" out of metadata yields a plausible number that is not ' +
    'the retention period. Being storage also means governance can change it with no runtime upgrade and no specVersion ' +
    'bump, which is why it is re-read rather than trusted.'

  const blocks = fmtCount(retention.blocks)

  if (retention.source !== 'chain') {
    return (
      `The retention figure is the INHERITED literal ${blocks} blocks, not a reading — ${retention.reason}. Every block and ` +
      'day figure on this page therefore rests on a number this load could not confirm, and it would be wrong in the same ' +
      `direction for all of them at once. ${why}`
    )
  }

  if (retention.stale || retention.unreachable) {
    return (
      `The retention figure is ${blocks} blocks and it is NOT a fresh reading: the key ${retention.key} returned ` +
      `${retention.raw} (a little-endian u32) at ${retention.readAt}, ${ago(retention.ageMs)}, and the devnet node did not ` +
      'answer when this load tried to re-read it. For a single-node devnet that is an ordinary state rather than an outage, ' +
      `but what is drawn below is that earlier reading. It comes from chain STATE, not from a constant. ${why}`
    )
  }

  return (
    `The retention figure is ${blocks} blocks, read live from chain state on this load: the key ${retention.key} returned ` +
    `${retention.raw}, a little-endian u32, at ${retention.readAt}. It is read from STATE rather than taken from a runtime ` +
    `constant, and that distinction is the whole point. ${why}`
  )
}

export default {
  id: 'bulletin',
  label: 'Polkadot Bulletin chain (Products Devnet)',
  homepage: 'https://docs.polkadotcommunity.foundation/',
  transport: 'jsonrpc',
  doc: 'docs/platform/bulletin.md',
  covers: ['Polkadot Products Devnet — Bulletin'],

  operations: {
    index: {
      summary: 'Every object in the Bulletin transaction index, rolled up.',
      // Ten minutes. The index changes as blocks land, but the aggregate shape does not move
      // meaningfully inside ten minutes, and a full load is ~40 calls at the one shared node.
      ttlMs: 600_000,
      schema: {},

      async run() {
        // Measure the block rate rather than assuming it. Every expiry countdown on the page is
        // derived from this number, and the pallet's nominal 6.03 s is not what the chain does.
        const headHeader = await rpc('chain_getHeader', [])
        const headBlock = parseInt(headHeader.number, 16)

        // And read the retention period rather than trusting the literal. One extra call, on a
        // shorter timeout than the index reads: it is the input to every expiry figure here, it
        // lives in mutable storage that governance can change without a specVersion bump, and if
        // the node does not answer it the page says "inherited" instead of quietly implying a
        // measurement. Short timeout because unreachable is an ordinary state for this node and
        // waiting a minute to discover it would be a minute of nothing.
        const retention = await readRetentionBlocks((method, params) => rpc(method, params, 15_000))

        const keys = await allKeys()
        if (!keys.length) {
          return { empty: true, headBlock, retention, fetchedAt: new Date().toISOString() }
        }

        const blocks = keys.map(blockOfKey).sort((a, b) => a - b)
        const oldestBlock = blocks[0]

        // Two real timestamps, far apart, give the measured rate; everything between them is
        // interpolated. This is why the per-day buckets carry a caveat and the totals do not:
        // an object stored near midnight can land in the neighbouring day, but the COUNTS are
        // exact regardless of what time we think they happened.
        const [oldestTime, headTime] = await Promise.all([
          blockTime(oldestBlock),
          blockTime(headBlock),
        ])
        const span = Math.max(1, headBlock - oldestBlock)
        const blockMs =
          oldestTime && headTime ? (headTime - oldestTime) / span : NOMINAL_BLOCK_MS
        const timeOf = (block) => (headTime ?? Date.now()) - (headBlock - block) * blockMs

        /* ------------------------------------------------------------- load values ---- */

        const byDay = new Map()
        const byCodec = new Map()
        const byHash = new Map()
        const byShape = new Map()
        const byContent = new Map()
        const buckets = bucketSpec.map((b) => ({ ...b, count: 0, bytes: 0 }))

        let count = 0
        let totalBytes = 0
        let renewals = 0
        let largest = null

        for (let i = 0; i < keys.length; i += VALUE_BATCH) {
          const slice = keys.slice(i, i + VALUE_BATCH)
          const changes = (await rpc('state_queryStorageAt', [slice]))?.[0]?.changes ?? []

          for (const [key, value] of changes) {
            const block = blockOfKey(key)
            const at = timeOf(block)
            for (const record of decodeTransactionInfoVec(value)) {
              count += 1
              totalBytes += record.size
              if (KIND_NAME[record.kind] === 'renew') renewals += 1

              const day = utcDay(at)
              const dayEntry = byDay.get(day) ?? { day, count: 0, bytes: 0 }
              dayEntry.count += 1
              dayEntry.bytes += record.size
              byDay.set(day, dayEntry)

              const codec = byCodec.get(record.codec) ?? { key: record.codec, label: codecLabel(record.codec), count: 0, bytes: 0 }
              codec.count += 1
              codec.bytes += record.size
              byCodec.set(record.codec, codec)

              const hash = byHash.get(record.hashing) ?? {
                key: record.hashing,
                label: HASH_NAME[record.hashing] ?? `hashing ${record.hashing}`,
                count: 0,
                bytes: 0,
              }
              hash.count += 1
              hash.bytes += record.size
              byHash.set(record.hashing, hash)

              const shape = classifyShape(record)
              const shapeEntry = byShape.get(shape.id) ?? {
                key: shape.id,
                label: shape.label,
                certain: shape.certain,
                precision: shape.precision,
                count: 0,
                bytes: 0,
              }
              shapeEntry.count += 1
              shapeEntry.bytes += record.size
              byShape.set(shape.id, shapeEntry)

              const content = byContent.get(record.contentHashHex) ?? { copies: 0, size: record.size }
              content.copies += 1
              byContent.set(record.contentHashHex, content)

              for (const bucket of buckets) {
                if (record.size < bucket.max) {
                  bucket.count += 1
                  bucket.bytes += record.size
                  break
                }
              }

              if (!largest || record.size > largest.size) {
                largest = {
                  size: record.size,
                  block,
                  cid: buildCid(fromHex(record.contentHashHex), record.hashing, record.codec),
                }
              }
            }
          }
        }

        /* --------------------------------------------------------------- duplication ---- */
        // A fifth of this chain is stored twice. With zero `Renew` transactions ever submitted,
        // re-uploading identical bytes is the only way anyone has been able to extend a lease —
        // so the duplicate share is not waste, it is the visible shape of a missing feature.
        let distinctContent = 0
        let duplicateBytes = 0
        let repeatedContent = 0
        let maxCopies = 0
        for (const entry of byContent.values()) {
          distinctContent += 1
          if (entry.copies > 1) {
            repeatedContent += 1
            duplicateBytes += entry.size * (entry.copies - 1)
          }
          if (entry.copies > maxCopies) maxCopies = entry.copies
        }

        return {
          empty: false,
          fetchedAt: new Date().toISOString(),
          chain: {
            headBlock,
            headTime,
            oldestBlock,
            blockKeyCount: keys.length,
            blockMs,
            nominalBlockMs: NOMINAL_BLOCK_MS,
            retentionBlocks: retention.blocks,
            retentionDays: (retention.blocks * blockMs) / 86_400_000,
            /** Where `retentionBlocks` came from. The page renders the difference. */
            retention,
          },
          totals: {
            count,
            totalBytes,
            meanBytes: count ? totalBytes / count : 0,
            distinctContent,
            repeatedContent,
            duplicateBytes,
            maxCopies,
            renewals,
            largest,
          },
          days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
          codecs: rank(byCodec),
          hashes: rank(byHash),
          shapes: rank(byShape),
          buckets: buckets.map(({ label, count: c, bytes }) => ({ label, count: c, bytes })),
          notes: [
            'Per-day buckets use interpolated timestamps: only two blocks are timed exactly and the rest are placed by the measured block rate, so an object stored near midnight can land in the neighbouring day. The totals come from exact counts and do not have this problem.',
            'Every expiry figure is denominated in BLOCKS, which is exact. The figure in days is a projection off the measured rate and is only as good as that rate.',
            retentionNote(retention),
            'Submitter leaderboards are not here. A signer lives inside its block’s signed extrinsic, so reading them costs two requests per block — about 7,600 for this window. That is a reasonable thing for one person to opt into in the explorer, and an unreasonable thing to do on every load of a public page.',
          ],
        }

      },
    },
  },
}
