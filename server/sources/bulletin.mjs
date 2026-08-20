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
import { liveness } from '../../src/core/liveness.js'
import { decodeTransactionInfoVec, KIND_NAME } from '../../src/core/codec/scale.js'
import { buildCid, codecLabel, HASH_NAME } from '../../src/core/codec/cid.js'
import { fromHex } from '../../src/core/codec/bytes.js'
import { classifyShape } from '../../src/core/codec/shapes.js'
import { TRANSACTIONS_PREFIX, blockOfKey, NOMINAL_BLOCK_MS, readRetentionBlocks, timestampOfBlock } from './bulletin-chain.js'

/** The ONLY devnet Bulletin RPC endpoint we know of. Its absence is a first-class state. */
const RPC = 'https://bulletin-paseo.tservices.es:8443'

const KEY_PAGE = 1000
const VALUE_BATCH = 250

/** The upstream's human name, as `/api` and every liveness line spell it. Declared once. */
const LABEL = 'Polkadot Bulletin chain (Products Devnet)'

/**
 * Liveness thresholds for THIS chain rather than the generic defaults in src/core/liveness.js.
 *
 * Bulletin produces a block roughly every six seconds, so a head five minutes old is not lag —
 * it is a chain that has stopped producing — and the fifteen-minute default would go on calling
 * that `live` for another ten minutes.
 *
 * `frozen` is held out to six hours in the other direction. This is a single node that is
 * restarted by hand and has been observed unreachable for several minutes at a time; escalating
 * to "stop building on this" at every maintenance window is how a banner becomes wallpaper, and
 * then nobody reads the one that matters.
 */
const STALE_AFTER_MS = 5 * 60_000
const FROZEN_AFTER_MS = 6 * 60 * 60_000

/** A day of chain silence in the index. Below this, an idle index is not worth a sentence. */
const IDLE_INDEX_MS = 86_400_000

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

/**
 * The liveness assertion for one index load. See src/core/liveness.js for why a source asserts
 * this at all: transport / upstream / decode catch an upstream that fails, and cannot catch one
 * that succeeds and is wrong.
 *
 * Two facts are kept apart here, because on this chain they come apart:
 *
 *   · THE HEAD is the chain's, read from the head block's timestamp inherent. That is what
 *     `state` is decided on, and it is the exact figure — no interpolation touches it.
 *   · THE INDEX may be much older than the head. Bulletin only gains an entry when somebody
 *     stores something, so a chain producing blocks every six seconds can sit on a transaction
 *     index that has not moved in a fortnight. Every chart on the page is drawn from the index,
 *     so a `live` pill on its own would be a true statement about the wrong thing. The gap goes
 *     in `note`, and the day range the payload actually covers goes in `covers`.
 *
 * @param {object} spec
 * @param {number} spec.observedAt
 * @param {number} spec.headBlock
 * @param {number|null} spec.headTime          epoch ms of the head block, or null if undecodable
 * @param {{from: string|null, to: string|null}|null} spec.covers
 * @param {number|null} spec.idleMs            headTime − time of the newest block that stored anything
 * @param {number|null} spec.newestStoredBlock
 */
function livenessOf({ observedAt, headBlock, headTime, covers, idleMs, newestStoredBlock }) {
  let note = null
  if (headTime === null) {
    // NOT collapsed into "live". The chain answered; we could not read a clock out of it, and
    // `unknown` is the honest word for that. The day buckets below fall back to the pallet's
    // nominal rate, which is a different number from the one this chain actually runs at.
    note =
      'The head block’s timestamp inherent could not be decoded, so how current this is cannot be established from the chain itself; the per-day buckets fall back to the pallet’s nominal block time rather than the measured rate.'
  } else if (idleMs !== null && idleMs >= IDLE_INDEX_MS && newestStoredBlock !== null) {
    const days = Math.round(idleMs / IDLE_INDEX_MS)
    note =
      `The chain is producing blocks, but nothing has been stored since block ${newestStoredBlock.toLocaleString('en-US')} — ` +
      `${days} day${days === 1 ? '' : 's'} before the head. Every chart on this page is drawn from the transaction index, ` +
      'so it is that date, not the head, that the numbers describe.'
  }

  return liveness({
    source: 'bulletin',
    label: LABEL,
    observedAt,
    headAt: headTime,
    // The chain's own words, and `best` rather than `finalized` on purpose: `chain_getHeader`
    // with no argument returns the best head, which can still be reorganised away.
    head: `best block #${headBlock.toLocaleString('en-US')}`,
    covers,
    staleAfterMs: STALE_AFTER_MS,
    frozenAfterMs: FROZEN_AFTER_MS,
    note,
  })
}

export default {
  id: 'bulletin',
  // The same constant the liveness assertion names itself with: the contract says `label` is
  // "the upstream's human name, as it appears at /api", and two string literals is how that
  // stops being true.
  label: LABEL,
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
        // When WE asked. Captured before the first call rather than after the last: the full
        // index load is ~40 requests and can take tens of seconds, and dating the assertion from
        // the end would quietly shave that off every lag figure it reports.
        const observedAt = Date.now()

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
          // An empty index is an ANSWER about the chain, not a failed read, and the liveness
          // line is what makes the difference visible: a live head with nothing under it says
          // "nobody has stored anything", which is a fact worth printing.
          return {
            empty: true,
            headBlock,
            retention,
            fetchedAt: new Date().toISOString(),
            meta: {
              liveness: livenessOf({
                observedAt,
                headBlock,
                headTime: await blockTime(headBlock),
                covers: null,
                idleMs: null,
                newestStoredBlock: null,
              }),
            },
          }
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

        /* ----------------------------------------------------------------- liveness ---- */
        // The newest block that stored ANYTHING, which is where the index stops even when the
        // chain does not. `timeOf` falls back to our clock when `headTime` is unreadable, so the
        // gap is only computed when there is a real head timestamp to measure it against.
        const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
        const newestStoredBlock = blocks[blocks.length - 1]
        const idleMs = headTime === null ? null : headTime - timeOf(newestStoredBlock)

        return {
          empty: false,
          fetchedAt: new Date().toISOString(),
          meta: {
            liveness: livenessOf({
              observedAt,
              headBlock,
              headTime,
              // The first and last DAY BUCKET, which is the window the charts actually draw.
              covers: { from: days[0]?.day ?? null, to: days[days.length - 1]?.day ?? null },
              idleMs,
              newestStoredBlock,
            }),
          },
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
          days,
          codecs: rank(byCodec),
          hashes: rank(byHash),
          shapes: rank(byShape),
          buckets: buckets.map(({ label, count: c, bytes }) => ({ label, count: c, bytes })),
          notes: [
            'Per-day buckets use interpolated timestamps: only two blocks are timed exactly and the rest are placed by the measured block rate, so an object stored near midnight can land in the neighbouring day. The totals come from exact counts and do not have this problem.',
            'Every expiry figure is denominated in BLOCKS, which is exact. The figure in days is a projection off the measured rate and is only as good as that rate.',
            retentionNote(retention),
            'The liveness line reports the CHAIN’s head, read from that block’s own timestamp inherent, which is exact. The window it says this payload covers is the first and last day bucket, so both of its edges inherit the interpolation caveat above — and the two are separate facts: this chain can be producing blocks normally while its transaction index has not gained an entry in days.',
            'Submitter leaderboards are not here. A signer lives inside its block’s signed extrinsic, so reading them costs two requests per block — about 7,600 for this window. That is a reasonable thing for one person to opt into in the explorer, and an unreasonable thing to do on every load of a public page.',
          ],
        }

      },
    },
  },
}
