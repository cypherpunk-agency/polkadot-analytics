// The transfer graph — value moving BETWEEN accounts, as edges rather than as balances.
//
// Everything else on this site answers "how much is here". This module answers "who did it come
// from and where did it go", which is a different question with a different transport, and the
// difference is not a matter of degree:
//
//   · A balance is state. `System::Account` for one account is one storage read.
//   · An edge is NOT in the state. Recovering it by diffing balances means guessing which fall
//     matches which rise — indistinguishable for two transfers in one block — and it does not
//     fit anyway: a full Asset Hub `System::Account` sweep measures ~1,746 MiB and 58–85 min
//     over WebSocket for ~3.9M accounts (docs/concept/plan.md §8.2). You cannot diff 3.9M
//     balances daily.
//
// So this folds the EVENT stream instead. `Balances.Transfer` carries `{from, to, amount}` — the
// edge is already in the event, the way `Issued`/`Burned` already carry a supply change. The
// upstream is SQD's public portal, anonymous and keyless, decoded from block 0.
//
// ── the four traps, all of which fail silently ────────────────────────────────────────────
// Written out in full in docs/platform/sqd-portal.md, measured 2026-08-21. In brief:
//
//   1. THE STREAM TRUNCATES AND SAYS NOTHING. Ask for 39,000 blocks, get 25,699, with HTTP 200,
//      well-formed NDJSON and no header saying it stopped. `fetchRange` loops until the last
//      block returned reaches `toBlock`, and throws if the portal ever fails to advance.
//   2. AN EVENT NAME THAT DOES NOT EXIST RETURNS ZERO ROWS. `Bananas.Wobbled` is a 200 with no
//      events. A typo, or a name a runtime upgrade moved, renders as "this account never
//      transferred anything". The per-name counts are published on the payload so a name that
//      has stopped matching shows up on the page as a zero instead of as an empty graph.
//   3. THE ARGUMENT SHAPE FLIPS ACROSS RUNTIME ERAS — positional arrays before roughly relay
//      block 8–12M, named objects after. `args.from` on the old shape is `undefined`, which
//      folds to an empty graph rather than an error. Asserted, and it throws.
//   4. `real_time: false` IS ON EVERY POLKADOT DATASET, INCLUDING THE LIVE ONES. The portal's
//      own `hydradx` dataset has not advanced since 2026-05-08 and answers every query
//      perfectly. The flag cannot tell them apart; only the head TIMESTAMP can. Every payload
//      carries a liveness assertion per chain, built from a block this module actually read.
//
// ── and one that is not the portal's fault ────────────────────────────────────────────────
// The relay chain is not where the history is and it is not where the present is either.
// Everything happened on the relay until the Asset Hub Migration on 2025-11-04 and almost
// nothing has since: over a full day on 2026-08-21 the relay carried THREE `Balances.Transfer`
// events, chain-wide. Both chains are read here, both are labelled, and the page says so.
//
// ── the labelling line ────────────────────────────────────────────────────────────────────
// docs/concept/plan.md §8.3. Only STRUCTURAL labels ship: `modl`, `para`, `sibl`, decoded from
// the bytes of the address by `structuralLabel()` with no network call. They are arithmetic and
// cannot be wrong about whose account it is. Behavioural labels ("looks like an exchange") are
// defensible and are not built here. Attributed labels ("this is Binance") are not in scope at
// all — this site is ungated, anonymous and indexed, and a wrong attribution is a false public
// claim about a real company.
//
// This is not decoration: ranked by degree over 25,699 Asset Hub blocks, five of the top six
// accounts in the transfer graph are pallet accounts doing the chain's own bookkeeping.

import { callUpstream, jsonRpc, ndjson, UpstreamError } from '../lib/upstream.mjs'
import { TtlCache } from '../lib/cache.mjs'
import { liveness, unreachable } from '../../src/core/liveness.js'
import { structuralLabel } from '../../src/core/topology.js'
import { encodeSs58 } from '../../src/core/codec/ss58.js'
import { twox128 } from '../../src/core/codec/xxhash.js'
import { blake2b } from '../../src/core/codec/blake2b.js'
import { concat, fromHex, toHex, utf8, u32le } from '../../src/core/codec/bytes.js'

const PORTAL = 'https://portal.sqd.dev'
const SQD = 'sqd-portal'

/* ═══════════════════════════════════════════════════════════════════ the two chains ═════ */

/**
 * The event names are a CONSTANT, deliberately, and they are covered by a test. Trap 2 above is
 * why: the portal validates nothing, so a name that is wrong is a page that says "no transfers"
 * rather than a page that fails. A constant can be diffed against a runtime; a string built at
 * call time cannot.
 *
 * `ForeignAssets.Transferred` and `PoolAssets.Transferred` are asked for and were seen ZERO
 * times in every probe on 2026-08-21 (20,000 and 26,749 blocks). They are asked for anyway —
 * costing nothing when they do not match — and their count is published, so "rare" and
 * "silently no longer matching" stay distinguishable.
 */
const ASSET_HUB_EVENTS = ['Balances.Transfer', 'Assets.Transferred', 'ForeignAssets.Transferred', 'PoolAssets.Transferred']
const RELAY_EVENTS = ['Balances.Transfer']

const CHAINS = [
  {
    key: 'asset-hub',
    dataset: 'asset-hub-polkadot',
    label: 'Polkadot Asset Hub',
    rpc: 'https://polkadot-asset-hub-rpc.polkadot.io',
    events: ASSET_HUB_EVENTS,
    // Measured 2.24 s/block on 2026-08-19 and 2.28 s/block on 2026-08-21. This is a SEED for the
    // first probe only — the real rate is measured from the chain on every request and the
    // window's edge is decided by timestamps, never by this number. See `resolveWindow`.
    seedMsPerBlock: 2250,
  },
  {
    key: 'relay',
    dataset: 'polkadot',
    label: 'Polkadot relay chain',
    rpc: 'https://rpc.polkadot.io',
    events: RELAY_EVENTS,
    seedMsPerBlock: 6000,
  },
]

const chainOf = (key) => CHAINS.find((chain) => chain.key === key)

/** The Asset Hub Migration. Anything spanning it is two chains stitched together. */
const MIGRATION_DAY = '2025-11-04'

/* ═════════════════════════════════════════════════════════════════════════ the caches ═════ */

/**
 * Decoded blocks are cached by BLOCK BUCKET, not by account — and that is the whole reason the
 * page can be walked hop by hop.
 *
 * An operation keyed only by its parameters re-fetches everything for every distinct account:
 * clicking a counterparty would re-download the same ten megabytes from somebody else's free
 * endpoint, with a correct answer and nothing anywhere reporting the waste (the same failure
 * CLAUDE.md records for a `{from,to}`-keyed store fact). Bucketing on fixed block boundaries
 * means the SECOND account in a window costs zero requests and zero bytes, which is what makes
 * "follow the money, one click per hop" a real feature rather than a link.
 *
 * The cache key carries the bucket's LAST BLOCK. A bucket cut short because the archive head
 * fell inside it is therefore a different key from the same bucket once it is whole — a partial
 * answer can never be served as a complete one, which is the other half of the same lesson.
 */
const BUCKET_BLOCKS = 20_000
const buckets = new TtlCache({ maxEntries: 48, maxBytes: 48 * 1024 * 1024 })
const BUCKET_TTL_MS = 2 * 60 * 60_000

/** Chain constants — token decimals, ss58 prefix, asset metadata. Slow-moving, read live. */
const constants = new TtlCache({ maxEntries: 16, maxBytes: 2 * 1024 * 1024 })
const CONSTANTS_TTL_MS = 6 * 60 * 60_000

/**
 * The archive head and the window it implies. Cached for the same reason the buckets are: the
 * six single-block timestamp probes that resolve a window are identical for every account asked
 * about in the same minute, and paying them again on each hop is the difference between a link
 * that feels instant and one that does not. Five minutes, because the portal publishes in
 * batches roughly an hour apart — a tighter TTL re-asks for an answer that has not changed.
 */
const windows = new TtlCache({ maxEntries: 32, maxBytes: 512 * 1024 })
const WINDOW_TTL_MS = 5 * 60_000

/**
 * A ceiling on what one request will hold in memory at once. A 256 MB container turns an
 * unbounded fold into an OOM crash-loop, and a crash-loop is a worse answer than "ask for a
 * shorter window".
 */
const MAX_EDGES = 900_000
/** Rows in the counterparty table. Beyond this the page says how many it dropped. */
const MAX_COUNTERPARTIES = 400
/** Individual transfers listed under the table. */
const MAX_TRANSFERS = 250

/* ═══════════════════════════════════════════════════════════════════ portal plumbing ═════ */

const headUrl = (dataset) => `${PORTAL}/datasets/${dataset}/head`
const streamUrl = (dataset) => `${PORTAL}/datasets/${dataset}/stream`

/**
 * The archive's head. A block NUMBER only — the portal publishes no timestamp here, and
 * converting a height with an assumed block rate is the trap CLAUDE.md records twice.
 *
 * Cached for a minute. That does not soften the liveness assertion: `observedAt` is still the
 * real clock at the moment the payload is built, so a head that stops moving still grows a
 * visible lag. It only stops two hops in the same minute asking the same question twice.
 */
async function portalHead(dataset) {
  return windows.resolve(`head:${dataset}`, 60_000, async () => {
    const body = await callUpstream({ source: SQD, url: headUrl(dataset), timeoutMs: 20_000, maxBytes: 64 * 1024 })
    const number = Number(body?.number)
    if (!Number.isInteger(number) || number <= 0) {
      throw new UpstreamError(`${SQD} answered for \`${dataset}\` without a head block number.`, { kind: 'decode', source: SQD })
    }
    return { number, hash: body?.hash ?? null }
  })
}

/**
 * One stream call. `fromBlock === toBlock` with no event filter is the cheapest exact way to
 * turn a block number into a timestamp — ~60 bytes and 0.3–0.6 s — because the portal always
 * returns the first and last block of a range whether or not anything matched.
 */
async function stream(dataset, { fromBlock, toBlock, names = null, maxBytes = 24 * 1024 * 1024 }) {
  const body = {
    type: 'substrate',
    fromBlock,
    toBlock,
    fields: names ? { block: { number: true, timestamp: true }, event: { name: true, args: true } } : { block: { number: true, timestamp: true } },
  }
  if (names) body.events = [{ name: names }]
  const { lines, headers, bytes } = await ndjson({ source: SQD, url: streamUrl(dataset), body, timeoutMs: 90_000, maxBytes })
  return { lines, bytes, archiveHead: Number(headers.get('x-sqd-head-number')) || null }
}

/** The timestamp of exactly one block, in ms. `null` when the archive has no such block. */
async function blockStamp(dataset, number) {
  const { lines } = await stream(dataset, { fromBlock: number, toBlock: number })
  const at = lines[0]?.header?.timestamp
  return Number.isFinite(at) ? at : null
}

/**
 * A block range, complete — the loop that trap 1 makes mandatory.
 *
 * Returns every line the portal has for `[from, to]`, having re-issued from `last + 1` until the
 * last block returned reaches `to`. Two guards, because both failures are silent otherwise:
 * a portal that stops advancing would spin forever, and a portal that returns nothing at all in
 * the middle of a range would look like an empty stretch of chain.
 */
async function fetchRange(dataset, from, to, names) {
  const out = []
  let cursor = from
  let requests = 0
  let bytes = 0
  let archiveHead = null

  while (cursor <= to) {
    const page = await stream(dataset, { fromBlock: cursor, toBlock: to, names })
    requests += 1
    bytes += page.bytes
    archiveHead = page.archiveHead ?? archiveHead

    if (!page.lines.length) {
      throw new UpstreamError(
        `${SQD} returned nothing for \`${dataset}\` blocks ${cursor}–${to}, mid-range. An empty ` +
          'answer here is indistinguishable from a stretch of chain with no transfers, so it is refused.',
        { kind: 'upstream', source: SQD },
      )
    }

    const last = page.lines[page.lines.length - 1]?.header?.number
    if (!Number.isFinite(last) || last < cursor) {
      throw new UpstreamError(
        `${SQD} answered for \`${dataset}\` from block ${cursor} and its last row was ${last}. The ` +
          'stream is not advancing, and continuing would loop forever.',
        { kind: 'upstream', source: SQD },
      )
    }

    out.push(...page.lines)
    if (last >= to) break
    cursor = last + 1

    if (requests > 200) {
      throw new UpstreamError(
        `${SQD} needed more than 200 continuations for \`${dataset}\` blocks ${from}–${to}. Refusing ` +
          'to keep paging an upstream we do not own.',
        { kind: 'upstream', source: SQD },
      )
    }
  }

  return { lines: out, requests, bytes, archiveHead }
}

/* ═══════════════════════════════════════════════════════════════════ decoding an edge ═════ */

/**
 * One transfer event, as this module models it. `from`/`to` are the raw 32-byte public keys the
 * portal sends — no SS58 anywhere near the join, because the same account is a different string
 * on every chain and joining on the display form silently finds nothing.
 *
 * @typedef {object} Edge
 * @property {number} block
 * @property {number} at        ms epoch, from the block header
 * @property {string} from      64 hex chars, no `0x`
 * @property {string} to
 * @property {string} amount    the integer as a decimal STRING. Never a Number: DOT is 10
 *                              decimals and a whale's transfer overflows a double.
 * @property {string} asset     `native`, or `assets:1984`, or `foreign`/`pool` + an index
 * @property {string} event     the event name it came from
 */

/**
 * Decode one block's worth of lines into edges.
 *
 * The `Array.isArray(args)` check is trap 3. It throws rather than returning nothing, because
 * `args.from` on a positional-array event is `undefined`, `undefined` matches no account, and
 * the result is a page that says this account never transferred anything.
 */
function decodeLines(lines, { intern, counts, cutoffAt = null }) {
  const edges = []
  for (const line of lines) {
    const at = line?.header?.timestamp
    const block = line?.header?.number
    if (!Number.isFinite(at) || !Number.isFinite(block)) continue
    for (const event of line.events ?? []) {
      const name = event?.name ?? 'unknown'
      counts.set(name, (counts.get(name) ?? 0) + 1)
      if (cutoffAt !== null && at < cutoffAt) continue

      const args = event?.args
      if (Array.isArray(args)) {
        throw new UpstreamError(
          `${SQD} decoded \`${name}\` at block ${block} with POSITIONAL arguments (${JSON.stringify(args).slice(0, 120)}). ` +
            'That is the pre-2022 runtime shape; reading it as a named object yields `undefined` for every ' +
            'account and folds to an empty graph. Refusing to publish it.',
          { kind: 'decode', source: SQD },
        )
      }
      if (!args || typeof args !== 'object') continue

      const from = normalise(args.from)
      const to = normalise(args.to)
      const amount = args.amount
      if (!from || !to || amount === undefined || amount === null) continue

      edges.push({
        block,
        at,
        from: intern(from),
        to: intern(to),
        amount: String(amount),
        asset: intern(assetKeyOf(name, args)),
        event: name,
      })
    }
  }
  return edges
}

/** 64 lowercase hex characters, or null. Anything else is not an AccountId32. */
function normalise(value) {
  if (typeof value !== 'string') return null
  const hex = value.startsWith('0x') ? value.slice(2) : value
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : null
}

/**
 * The asset an event moved, as a stable key.
 *
 * `ForeignAssets` carries an XCM location object rather than an integer, and this module does
 * NOT try to name it: it keys on a stable JSON form and reports it as unnamed, with no decimals.
 * `null` decimals means "we could not scale this", which is a different fact from a scale of 1
 * and must not become one.
 */
function assetKeyOf(name, args) {
  if (name === 'Balances.Transfer') return 'native'
  const id = args.assetId
  if (name === 'Assets.Transferred') return `assets:${String(id)}`
  if (name === 'PoolAssets.Transferred') return `pool:${String(id)}`
  if (name === 'ForeignAssets.Transferred') {
    try {
      return `foreign:${JSON.stringify(id)}`
    } catch {
      return 'foreign:unreadable'
    }
  }
  return `other:${name}`
}

/* ══════════════════════════════════════════════════════════════════ bucketed fetching ═════ */

/**
 * One bucket of decoded edges, cached. `to` is in the key: a bucket cut short by the archive
 * head is a different entry from the same bucket once whole.
 */
async function bucket(chain, index, headBlock, names) {
  const from = index * BUCKET_BLOCKS
  const to = Math.min(from + BUCKET_BLOCKS - 1, headBlock)
  if (to < from) return { edges: [], counts: new Map(), requests: 0, bytes: 0 }

  const key = `${chain.dataset}:${from}:${to}`
  const hit = buckets.peek(key) !== undefined
  const cached = await buckets.resolve(key, BUCKET_TTL_MS, async () => {
    const strings = new Map()
    const intern = (s) => {
      const seen = strings.get(s)
      if (seen !== undefined) return seen
      strings.set(s, s)
      return s
    }
    const counts = new Map()
    const { lines, requests, bytes } = await fetchRange(chain.dataset, from, to, names)
    const edges = decodeLines(lines, { intern, counts })
    return { edges, counts: [...counts], requests, bytes }
  })
  return { edges: cached.edges, counts: new Map(cached.counts), requests: cached.requests, bytes: cached.bytes, cached: hit }
}

/* ═════════════════════════════════════════════════════════════════════ the window ═════════ */

/**
 * Where to start reading, for a window of `days` ending at the archive head.
 *
 * CLAUDE.md records two separate incidents of a date→height extrapolation rendering as a
 * plausible, wrong number, and Asset Hub is the worse of the two chains for it — its block rate
 * has moved by a factor of six inside 2022–2026, and by 7 % across the last four months alone
 * (2.285 vs 2.135 s/block, measured 2026-08-21).
 *
 * So the estimate is never allowed to decide the answer:
 *
 *   1. read the head block's timestamp from the archive itself;
 *   2. MEASURE the local rate from a sample ~200,000 blocks back;
 *   3. estimate the start and then bias it 20 % EARLIER, so it can only overshoot backwards;
 *   4. verify the start block's timestamp is actually at or before the cutoff, and step back
 *      again if it is not;
 *   5. filter the returned rows on THEIR OWN timestamps.
 *
 * A rate that is wrong then costs a few extra kilobytes and cannot move the window's edge.
 */
async function resolveWindow(chain, headBlock, days) {
  const headAt = await blockStamp(chain.dataset, headBlock)
  if (headAt === null) {
    throw new UpstreamError(
      `${SQD} has no timestamp for \`${chain.dataset}\` block ${headBlock}, which it reports as its own head. ` +
        'Without a timestamp there is no way to say how current this data is, so it is refused.',
      { kind: 'upstream', source: SQD },
    )
  }
  const cutoffAt = headAt - days * 86_400_000

  const sampleBack = Math.min(200_000, Math.max(1, Math.floor(headBlock / 2)))
  const sampleAt = await blockStamp(chain.dataset, headBlock - sampleBack)
  // A measured rate, or the seed if the archive would not answer for the sample. The seed is a
  // starting point for a search that verifies itself, never a divisor anyone trusts.
  const msPerBlock =
    sampleAt !== null && headAt > sampleAt ? (headAt - sampleAt) / sampleBack : chain.seedMsPerBlock

  let start = Math.max(0, Math.floor(headBlock - ((days * 86_400_000) / msPerBlock) * 1.2))
  let startAt = await blockStamp(chain.dataset, start)
  let steps = 0
  // Step back a further 20 % of the window until the start is genuinely before the cutoff. Six
  // steps doubles the reach; if the archive still disagrees, read from its first block rather
  // than publish a window that is silently short at its old end.
  while (start > 0 && (startAt === null || startAt > cutoffAt) && steps < 6) {
    const back = Math.max(1, Math.floor(((days * 86_400_000) / msPerBlock) * 0.2))
    start = Math.max(0, start - back)
    startAt = await blockStamp(chain.dataset, start)
    steps += 1
  }
  const reachesCutoff = startAt !== null && startAt <= cutoffAt

  return { headAt, cutoffAt, start, startAt, msPerBlock, steps, reachesCutoff }
}

/* ═══════════════════════════════════════════════════════════ one chain's contribution ═════ */

async function readChain(chain, days) {
  const observedAt = Date.now()
  let head
  try {
    head = await portalHead(chain.dataset)
  } catch (error) {
    return {
      key: chain.key,
      label: chain.label,
      dataset: chain.dataset,
      reachable: false,
      edges: [],
      counts: new Map(),
      liveness: unreachable({
        source: SQD,
        label: `SQD Portal — ${chain.label} (${chain.dataset})`,
        reason: error.message,
        observedAt,
      }),
    }
  }

  const win = await windows.resolve(`${chain.dataset}:${days}:${head.number}`, WINDOW_TTL_MS, () =>
    resolveWindow(chain, head.number, days),
  )

  const firstBucket = Math.floor(win.start / BUCKET_BLOCKS)
  const lastBucket = Math.floor(head.number / BUCKET_BLOCKS)

  const edges = []
  const counts = new Map()
  let requests = 0
  let bytes = 0
  let cachedBuckets = 0
  for (let index = firstBucket; index <= lastBucket; index += 1) {
    const part = await bucket(chain, index, head.number, chain.events)
    if (part.cached) cachedBuckets += 1
    requests += part.requests
    bytes += part.bytes
    for (const [name, n] of part.counts) counts.set(name, (counts.get(name) ?? 0) + n)
    for (const edge of part.edges) {
      // The timestamps decide the window, not the block estimate.
      if (edge.at < win.cutoffAt) continue
      edges.push(edge)
    }
    if (edges.length > MAX_EDGES) {
      throw new UpstreamError(
        `${chain.label} carried more than ${MAX_EDGES.toLocaleString('en-US')} transfers in the last ` +
          `${days} day${days === 1 ? '' : 's'}, past what this service will hold at once. Ask for a shorter window ` +
          'rather than being served a silently short graph.',
        { kind: 'upstream', source: SQD },
      )
    }
  }

  const firstAt = edges.length ? Math.min(...edges.map((e) => e.at)) : null
  const lastAt = edges.length ? Math.max(...edges.map((e) => e.at)) : null

  return {
    key: chain.key,
    label: chain.label,
    dataset: chain.dataset,
    reachable: true,
    headBlock: head.number,
    headAt: win.headAt,
    fromBlock: win.start,
    fromAt: win.startAt,
    cutoffAt: win.cutoffAt,
    msPerBlock: win.msPerBlock,
    reachesCutoff: win.reachesCutoff,
    stepsBack: win.steps,
    buckets: lastBucket - firstBucket + 1,
    bucketsCached: cachedBuckets,
    // Portal requests that BUILT these buckets, whether this call made them or an earlier one
    // did. Reported next to `bucketsCached` so the two together say what this call actually cost
    // rather than implying every hop re-reads the archive.
    requests,
    bytes,
    transfers: edges.length,
    firstAt,
    lastAt,
    edges,
    counts,
    liveness: liveness({
      source: SQD,
      label: `SQD Portal — ${chain.label} (${chain.dataset})`,
      observedAt,
      headAt: win.headAt,
      head: `block ${head.number.toLocaleString('en-US')}`,
      covers: {
        from: firstAt ? new Date(firstAt).toISOString() : new Date(win.cutoffAt).toISOString(),
        to: lastAt ? new Date(lastAt).toISOString() : new Date(win.headAt).toISOString(),
      },
      // The portal publishes in batches: the two live Polkadot datasets sat ~90 minutes behind
      // and did not move across twelve minutes of observation on 2026-08-21, while `hydradx` in
      // the same portal has been still for 105 days. Two hours separates "batched" from "this
      // index has stopped", and the second is the one that must never render as a green tick.
      staleAfterMs: 30 * 60_000,
      frozenAfterMs: 6 * 60 * 60_000,
    }),
  }
}

/* ═════════════════════════════════════════════════════════════════ asset decimals ═════════ */

const palletPrefix = (pallet, item) => `0x${toHex(concat(twox128(utf8(pallet)), twox128(utf8(item))))}`
const blake2Concat = (bytes) => toHex(concat(blake2b(bytes, 16), bytes))
/** Computed, never hardcoded — a runtime upgrade that moves the prefix must read as an error,
 *  not as "this map is empty". Same rule as hydration.mjs and bulletin-chain.js. */
const localMetadataKey = (id) => palletPrefix('Assets', 'Metadata') + blake2Concat(u32le(id))

/** A minimal SCALE reader. `rest()` is the self-check: `AssetMetadata` must consume exactly. */
function scaleReader(hex, what) {
  const bytes = fromHex(String(hex).replace(/^0x/, ''))
  let at = 0
  const need = (n) => {
    if (at + n > bytes.length) throw new UpstreamError(`${what}: ran off the end of ${bytes.length} bytes.`, { kind: 'decode', source: 'asset-hub-rpc' })
  }
  const compact = () => {
    need(1)
    const first = bytes[at]
    const mode = first & 3
    if (mode === 0) { at += 1; return first >> 2 }
    if (mode === 1) { need(2); const v = (bytes[at] | (bytes[at + 1] << 8)) >> 2; at += 2; return v }
    if (mode === 2) { need(4); const v = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | bytes[at + 3] * 0x1000000) >>> 2; at += 4; return v }
    const len = (first >> 2) + 4
    at += 1
    need(len)
    let v = 0n
    for (let i = 0; i < len; i += 1) v |= BigInt(bytes[at + i]) << BigInt(8 * i)
    at += len
    return Number(v)
  }
  return {
    skip: (n) => { need(n); at += n },
    u8: () => { need(1); return bytes[at++] },
    bool: () => { need(1); return bytes[at++] === 1 },
    text: () => { const len = compact(); need(len); const s = new TextDecoder().decode(bytes.slice(at, at + len)); at += len; return s },
    rest: () => bytes.length - at,
  }
}

/** `pallet_assets::AssetMetadata` — deposit(u128), name, symbol, decimals(u8), is_frozen(bool). */
function decodeAssetMetadata(hex) {
  const r = scaleReader(hex, 'AssetMetadata')
  r.skip(16)
  const name = r.text()
  const symbol = r.text()
  const decimals = r.u8()
  const isFrozen = r.bool()
  if (r.rest() !== 0) {
    throw new UpstreamError(
      `Assets::Metadata decoded with ${r.rest()} bytes left over. The layout has moved, and every amount ` +
        'scaled with it would be wrong by a factor of ten to the something. Refusing to publish.',
      { kind: 'decode', source: 'asset-hub-rpc' },
    )
  }
  return { name, symbol, decimals, isFrozen }
}

/**
 * The chain's own answer for how to scale a number. Nothing here is transcribed: the native
 * token comes from `system_properties`, and every `pallet-assets` id comes from
 * `Assets::Metadata` under a computed key.
 *
 * The canaries are the same call `decodeAssetDetails` makes in asset-hub.mjs: USDC (1337) and
 * USDt (1984) are both 6 decimals, and a layout change that silently moved a byte would show up
 * here as a wrong symbol or a wrong scale rather than as a chart that is quietly a million times
 * too big. Note the pairing is checked by ID: never by symbol, because Asset Hub has two
 * different USDCs with different provenance (CLAUDE.md).
 */
const CANARIES = [
  { id: 1337, symbol: 'USDC', decimals: 6 },
  { id: 1984, symbol: 'USDT', decimals: 6 },
]

async function nativeToken(chain) {
  return constants.resolve(`native:${chain.key}`, CONSTANTS_TTL_MS, async () => {
    const props = await jsonRpc({ source: `${chain.key}-rpc`, url: chain.rpc, method: 'system_properties', timeoutMs: 20_000 })
    const decimals = Array.isArray(props?.tokenDecimals) ? Number(props.tokenDecimals[0]) : Number(props?.tokenDecimals)
    const symbol = Array.isArray(props?.tokenSymbol) ? String(props.tokenSymbol[0]) : String(props?.tokenSymbol ?? '')
    const ss58Prefix = Number(props?.ss58Format)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30 || !symbol) {
      throw new UpstreamError(
        `${chain.label} answered system_properties without usable token decimals (${JSON.stringify(props)}).`,
        { kind: 'decode', source: `${chain.key}-rpc` },
      )
    }
    return { symbol, decimals, ss58Prefix: Number.isInteger(ss58Prefix) ? ss58Prefix : 0 }
  })
}

async function localAssets(chain, ids) {
  const wanted = [...new Set([...ids, ...CANARIES.map((c) => c.id)])].filter((id) => Number.isInteger(id) && id >= 0)
  if (!wanted.length) return new Map()

  const key = `assets:${chain.key}:${wanted.slice().sort((a, b) => a - b).join(',')}`
  const rows = await constants.resolve(key, CONSTANTS_TTL_MS, async () => {
    const out = []
    for (const id of wanted) {
      const raw = await jsonRpc({
        source: `${chain.key}-rpc`,
        url: chain.rpc,
        method: 'state_getStorage',
        params: [localMetadataKey(id)],
        timeoutMs: 20_000,
      })
      out.push([id, raw ? decodeAssetMetadata(raw) : null])
    }
    // The canary. Everything scaled below this line depends on the layout above being right.
    for (const canary of CANARIES) {
      const got = out.find(([id]) => id === canary.id)?.[1]
      const symbolOk = String(got?.symbol ?? '').toUpperCase() === canary.symbol
      if (!got || !symbolOk || got.decimals !== canary.decimals) {
        throw new UpstreamError(
          `Assets::Metadata self-check failed: asset ${canary.id} decoded as ` +
            `${got ? `${got.symbol}/${got.decimals}` : 'missing'}, expected ${canary.symbol}/${canary.decimals}. ` +
            'Refusing to publish amounts scaled by a layout we no longer understand.',
          { kind: 'decode', source: `${chain.key}-rpc` },
        )
      }
    }
    return out
  })
  return new Map(rows)
}

/* ═════════════════════════════════════════════════════════════════════════ the fold ═══════ */

/** Whole units, or `null`. Never 0 — "we could not scale this" is not "this was nothing". */
function scaled(raw, decimals) {
  if (decimals === null || decimals === undefined) return null
  return Number(raw) / 10 ** decimals
}

const addressOf = (hex, prefix) => encodeSs58(fromHex(hex), prefix)

/** Structural only. `null` for an ordinary account, which is the common case and stays plain. */
function describeAccount(hex, prefix) {
  const label = structuralLabel(hex)
  return {
    hex: `0x${hex}`,
    address: addressOf(hex, prefix),
    structural: label ? { kind: label.kind, label: label.label, paraId: label.paraId ?? null, palletId: label.palletId ?? null } : null,
    isPallet: label?.kind === 'modl',
  }
}

/* ══════════════════════════════════════════════════════════════════════ the payload ═══════ */

async function accountGraph({ account, days }) {
  const target = String(account).replace(/^0x/, '').toLowerCase()

  const chains = []
  for (const chain of CHAINS) chains.push(await readChain(chain, days))

  if (chains.every((c) => !c.reachable)) {
    throw new UpstreamError(
      `${SQD} did not answer for either ${CHAINS.map((c) => c.dataset).join(' or ')}. Nothing on this page could be read.`,
      { kind: 'transport', source: SQD },
    )
  }

  /* ---- which assets this account touched, and what scales them ---- */

  const mine = []
  for (const chain of chains) {
    for (const edge of chain.edges) {
      if (edge.from !== target && edge.to !== target) continue
      mine.push({ ...edge, chain: chain.key })
    }
  }

  const localIds = [
    ...new Set(
      mine
        .filter((e) => e.chain === 'asset-hub' && e.asset.startsWith('assets:'))
        .map((e) => Number(e.asset.slice('assets:'.length)))
        .filter((id) => Number.isInteger(id)),
    ),
  ]

  const assetHub = chainOf('asset-hub')
  const relay = chainOf('relay')
  const [ahNative, relayNative, ahLocals] = await Promise.all([
    nativeToken(assetHub).catch(() => null),
    nativeToken(relay).catch(() => null),
    localIds.length ? localAssets(assetHub, localIds) : Promise.resolve(new Map()),
  ])

  const ss58Prefix = ahNative?.ss58Prefix ?? relayNative?.ss58Prefix ?? 0

  /** Symbol and decimals for an asset key, on a chain. `decimals: null` where nothing said. */
  function describeAsset(chainKey, assetKey) {
    if (assetKey === 'native') {
      const native = chainKey === 'relay' ? relayNative : ahNative
      return {
        key: `${chainKey}/${assetKey}`,
        chain: chainKey,
        symbol: native?.symbol ?? null,
        decimals: native?.decimals ?? null,
        id: null,
        kind: 'native',
        source: native ? 'system_properties, read live' : 'unavailable',
      }
    }
    if (assetKey.startsWith('assets:')) {
      const id = Number(assetKey.slice('assets:'.length))
      const meta = ahLocals.get(id) ?? null
      return {
        key: `${chainKey}/${assetKey}`,
        chain: chainKey,
        symbol: meta?.symbol ?? null,
        decimals: meta?.decimals ?? null,
        id,
        kind: 'local asset',
        source: meta ? 'Assets::Metadata, read live' : 'no Assets::Metadata entry',
      }
    }
    return {
      key: `${chainKey}/${assetKey}`,
      chain: chainKey,
      symbol: null,
      decimals: null,
      id: null,
      kind: assetKey.startsWith('foreign:') ? 'foreign asset' : assetKey.startsWith('pool:') ? 'pool asset' : 'unrecognised',
      source: 'not resolved — amounts are raw integers',
    }
  }

  /* ---- fold into counterparties ---- */

  /** @type {Map<string, any>} */
  const assets = new Map()
  /** @type {Map<string, any>} */
  const parties = new Map()
  let selfTransfers = 0

  for (const edge of mine) {
    const assetKey = `${edge.chain}/${edge.asset}`
    let asset = assets.get(assetKey)
    if (!asset) {
      asset = { ...describeAsset(edge.chain, edge.asset), transfers: 0, sentRaw: 0n, receivedRaw: 0n, counterparties: new Set() }
      assets.set(assetKey, asset)
    }

    const out = edge.from === target
    const inn = edge.to === target
    const other = out ? edge.to : edge.from
    let amount
    try {
      amount = BigInt(edge.amount)
    } catch {
      continue
    }

    asset.transfers += 1
    if (out && inn) {
      // An account paying itself. Real, rare, and it is not a counterparty — counting it as one
      // would put the account in its own graph as its own biggest partner.
      selfTransfers += 1
      continue
    }
    if (out) asset.sentRaw += amount
    else asset.receivedRaw += amount
    asset.counterparties.add(other)

    let party = parties.get(other)
    if (!party) {
      party = { hex: other, transfers: 0, sent: 0, received: 0, firstAt: edge.at, lastAt: edge.at, assets: new Map(), chains: new Set() }
      parties.set(other, party)
    }
    party.transfers += 1
    party.chains.add(edge.chain)
    if (out) party.sent += 1
    else party.received += 1
    party.firstAt = Math.min(party.firstAt, edge.at)
    party.lastAt = Math.max(party.lastAt, edge.at)

    let bag = party.assets.get(assetKey)
    if (!bag) {
      bag = { key: assetKey, transfers: 0, sentRaw: 0n, receivedRaw: 0n }
      party.assets.set(assetKey, bag)
    }
    bag.transfers += 1
    if (out) bag.sentRaw += amount
    else bag.receivedRaw += amount
  }

  /* ---- the denominating asset: the one this account moved most often ---- */

  const assetRows = [...assets.values()]
    .map((a) => ({
      key: a.key,
      chain: a.chain,
      kind: a.kind,
      id: a.id,
      symbol: a.symbol,
      decimals: a.decimals,
      source: a.source,
      transfers: a.transfers,
      counterparties: a.counterparties.size,
      sentRaw: a.sentRaw.toString(),
      receivedRaw: a.receivedRaw.toString(),
      sent: scaled(a.sentRaw, a.decimals),
      received: scaled(a.receivedRaw, a.decimals),
    }))
    .sort((a, b) => b.transfers - a.transfers || String(a.key).localeCompare(String(b.key)))

  // A bar needs ONE unit. Cross-asset sums are the thing this repo refuses to draw, so the bars
  // are denominated in a single asset and the table carries the rest. The pick is the asset this
  // account moved most often, among those the chain could actually scale — an unscalable asset
  // cannot be a bar length, and drawing its raw integer next to a DOT figure would be a lie
  // about magnitude.
  const denominated = assetRows.find((a) => a.decimals !== null) ?? null
  const denomination = denominated
    ? {
        key: denominated.key,
        symbol: denominated.symbol,
        decimals: denominated.decimals,
        chain: denominated.chain,
        reason:
          assetRows.length > 1
            ? `the asset this account moved most often here (${denominated.transfers} of ${assetRows.reduce((n, a) => n + a.transfers, 0)} transfers)`
            : 'the only asset this account moved here',
      }
    : null

  /* ---- the counterparty rows ---- */

  const assetByKey = new Map(assetRows.map((a) => [a.key, a]))
  const rows = [...parties.values()].map((party) => {
    const bags = [...party.assets.values()]
      .map((bag) => {
        const meta = assetByKey.get(bag.key)
        return {
          key: bag.key,
          symbol: meta?.symbol ?? null,
          decimals: meta?.decimals ?? null,
          chain: meta?.chain ?? null,
          transfers: bag.transfers,
          sentRaw: bag.sentRaw.toString(),
          receivedRaw: bag.receivedRaw.toString(),
          sent: scaled(bag.sentRaw, meta?.decimals ?? null),
          received: scaled(bag.receivedRaw, meta?.decimals ?? null),
        }
      })
      .sort((a, b) => b.transfers - a.transfers)

    const denom = denomination ? bags.find((b) => b.key === denomination.key) : null
    const sentDenom = denom?.sent ?? null
    const receivedDenom = denom?.received ?? null

    return {
      ...describeAccount(party.hex, ss58Prefix),
      transfers: party.transfers,
      sentCount: party.sent,
      receivedCount: party.received,
      direction: party.sent && party.received ? 'both' : party.sent ? 'out' : 'in',
      firstAt: new Date(party.firstAt).toISOString(),
      lastAt: new Date(party.lastAt).toISOString(),
      chains: [...party.chains],
      assets: bags,
      sentDenom,
      receivedDenom,
      // `null` is not `0`: an account that moved only an unscalable asset has no bar, and that
      // is drawn as an absence rather than as a zero-length one.
      grossDenom: sentDenom === null && receivedDenom === null ? null : (sentDenom ?? 0) + (receivedDenom ?? 0),
    }
  })

  rows.sort((a, b) => (b.grossDenom ?? -1) - (a.grossDenom ?? -1) || b.transfers - a.transfers)
  const shown = rows.slice(0, MAX_COUNTERPARTIES)

  /* ---- the individual transfers, newest first ---- */

  const recent = mine
    .filter((e) => e.from !== e.to)
    .sort((a, b) => b.block - a.block)
    .slice(0, MAX_TRANSFERS)
    .map((e) => {
      const meta = assetByKey.get(`${e.chain}/${e.asset}`)
      const out = e.from === target
      const other = out ? e.to : e.from
      return {
        chain: e.chain,
        block: e.block,
        at: new Date(e.at).toISOString(),
        direction: out ? 'out' : 'in',
        counterparty: addressOf(other, ss58Prefix),
        counterpartyHex: `0x${other}`,
        event: e.event,
        symbol: meta?.symbol ?? null,
        amountRaw: e.amount,
        amount: scaled(BigInt(e.amount), meta?.decimals ?? null),
      }
    })

  /* ---- the bound, stated in the payload so the page cannot forget it ---- */

  const reachable = chains.filter((c) => c.reachable)
  const from = reachable.length ? Math.min(...reachable.map((c) => c.cutoffAt)) : null
  const to = reachable.length ? Math.max(...reachable.map((c) => c.headAt)) : null
  const palletParties = rows.filter((r) => r.isPallet).length
  const sovereignParties = rows.filter((r) => r.structural && r.structural.kind !== 'modl').length

  const eventCounts = {}
  for (const chain of chains) {
    for (const [name, n] of chain.counts) {
      const key = `${chain.key}/${name}`
      eventCounts[key] = (eventCounts[key] ?? 0) + n
    }
  }

  const spansMigration = from !== null && new Date(from).toISOString().slice(0, 10) < MIGRATION_DAY

  return {
    account: describeAccount(target, ss58Prefix),
    window: {
      days,
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      text:
        from === null || to === null
          ? 'an unknown window — no chain answered with a head'
          : `${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} and ${new Date(to).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      spansMigration,
      migrationDay: MIGRATION_DAY,
      // Exactly what was folded, named. A reader can check this against a block explorer.
      eventNames: Object.fromEntries(CHAINS.map((c) => [c.key, c.events])),
      eventCounts,
    },
    chains: chains.map((c) => ({
      key: c.key,
      label: c.label,
      dataset: c.dataset,
      reachable: c.reachable,
      headBlock: c.headBlock ?? null,
      headAt: c.headAt ? new Date(c.headAt).toISOString() : null,
      fromBlock: c.fromBlock ?? null,
      fromAt: c.fromAt ? new Date(c.fromAt).toISOString() : null,
      msPerBlock: c.msPerBlock ?? null,
      reachesCutoff: c.reachesCutoff ?? null,
      buckets: c.buckets ?? 0,
      bucketsCached: c.bucketsCached ?? 0,
      requests: c.requests ?? 0,
      bytes: c.bytes ?? 0,
      // Chain-wide, not this account's — the denominator that says how busy the chain was.
      transfersOnChain: c.transfers ?? 0,
      transfersForAccount: mine.filter((e) => e.chain === c.key).length,
    })),
    assets: assetRows,
    denomination,
    counterparties: shown,
    totals: {
      counterparties: rows.length,
      counterpartiesShown: shown.length,
      transfers: mine.length,
      sent: mine.filter((e) => e.from === target && e.to !== target).length,
      received: mine.filter((e) => e.to === target && e.from !== target).length,
      selfTransfers,
      palletCounterparties: palletParties,
      sovereignCounterparties: sovereignParties,
      unscalableAssets: assetRows.filter((a) => a.decimals === null).length,
    },
    transfers: recent,
    transfersShown: recent.length,
    meta: { liveness: chains.map((c) => c.liveness) },
  }
}

/* ═══════════════════════════════════════════════════════════════════════ the source ═══════ */

export default {
  id: 'transfers',
  label: 'SQD Portal (Polkadot & Asset Hub transfer events)',
  homepage: 'https://portal.sqd.dev',
  transport: 'ndjson stream + substrate rpc',
  doc: 'docs/platform/sqd-portal.md',
  covers: [
    'Polkadot Asset Hub — Balances.Transfer, Assets.Transferred, ForeignAssets.Transferred, PoolAssets.Transferred',
    'Polkadot relay chain — Balances.Transfer',
  ],

  operations: {
    'account-graph': {
      summary:
        'One account’s transfer counterparties on Polkadot Asset Hub and the relay chain in a recent window: ' +
        'who it sent value to, who it received value from, how much of which asset, and the structural kind of ' +
        'each counterparty. Folded from transfer events, not from balance differences.',
      // Ten minutes. The archive itself publishes in batches roughly an hour behind the chain, so
      // a tighter TTL would only re-ask for the same rows; the decoded blocks underneath are
      // cached separately, by block bucket, and shared across every account in the window.
      ttlMs: 600_000,
      schema: {
        // Hex or SS58 in ANY network prefix, normalised to the public key by readParams. That is
        // the whole ballgame: the same account is a different string on every chain, and a graph
        // joined on the display form finds nothing and renders as "never transacted".
        account: { type: 'account', required: true },
        // Seven days is roughly 270,000 Asset Hub blocks and ~70 MB off somebody else's free
        // endpoint on a cold cache. The ceiling is a politeness limit, not a limit of the data.
        days: { type: 'int', min: 1, max: 7, default: 2 },
      },
      run: accountGraph,
    },
  },
}

/** Exported for the tests: the names folded, and the bucket size the cache is keyed on. */
export const TRANSFER_EVENTS = { assetHub: ASSET_HUB_EVENTS, relay: RELAY_EVENTS }
export const BUCKET_SIZE = BUCKET_BLOCKS
export const __test = { decodeLines, assetKeyOf, normalise, decodeAssetMetadata, localMetadataKey }
