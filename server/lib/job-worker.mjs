// The job engine, and the worker thread that runs it — plan §2.5.
//
// This file executes jobs; it decides NOTHING about upstreams. There is no URL here, no fetch,
// and no way to add one quietly: handlers are resolved through the source registry
// (server/sources/index.mjs) exactly as HTTP operations are, so `server/sources/` stays the
// one directory where the outside world exists. `npm run check` enforces that boundary and
// this file is on the wrong side of it on purpose.
//
// ── the invariant ────────────────────────────────────────────────────────────────────────────
// A batch of fetched rows and the cursor that covers them commit in ONE transaction. The
// handler never touches the database — it RETURNS `{ rows, cursor }` and the engine commits
// both or neither. There is no reachable state where the rows exist without the cursor or the
// cursor without the rows, and that is a property of the API shape, not of handler discipline.
//
// ── the handler contract ─────────────────────────────────────────────────────────────────────
// A source module may export, next to `operations`, a `jobs` object:
//
//   jobs: {
//     'trades-window': {
//       summary: 'Backfill routed trades for a block window, one day per segment.',
//         // SEGMENTS SORT AS STRINGS. readFacts/listSegments order lexicographically and
//         // coverage's earliest/latest are string MIN/MAX — so pick segment ids whose text
//         // order IS their real order: ISO dates ('2026-08-19') or zero-padded counters
//         // ('p00009', not 'p9'). An unpadded page number draws charts out of sequence with
//         // no error anywhere.
//       immutable: (params) => boolean,
//         // May the answer still change? Consulted before the first batch; a handler that
//         // answers false is refused — mutable data belongs in mode B (the TTL cache), and a
//         // predicate that is wrong in the permissive direction freezes a partial answer
//         // forever (plan §2.1). Be conservative.
//       warm: () => [params, …],
//         // OPTIONAL, and it is a deployment concern rather than a fetching one: the identities
//         // worth filling BEFORE a reader asks. Called once at boot (server/lib/warm.mjs),
//         // never on a request path. Everything it returns goes through this handler's own
//         // `schema` and `immutable`, and an identity that is already complete is skipped — so
//         // a warm list may safely be "every month of the series" and stay that way forever.
//         // May be async. Omitted means "nothing to warm", which is the right answer for an
//         // operation whose useful params are not knowable in advance.
//       plan: async ({ params, gate }) => ({ totalUnits }),
//         // Optional. Runs once, before the first batch, to size the work. `totalUnits: null`
//         // means "not knowable" — null, never 0.
//       nextBatch: async ({ params, cursor, gate }) => ({
//         rows,        // [{ segment, payload, head?, codeVersion? }] — facts for the store,
//                      //   keyed under this job's (source, operation, params). May be empty.
//         cursor,      // resume point AFTER these rows; JSON-serialisable. Committed with them.
//                      //   Required unless `done`; omitted on a done batch, the last committed
//                      //   cursor is KEPT (never erased), so a completed job's resume point
//                      //   still covers everything it fetched.
//         done,        // true when this was the final batch
//         doneUnits,   // optional absolute progress; null = not knowable; omit = unchanged
//         totalUnits,  // optional; same rules
//       }),
//     },
//   }
//
// `cursor` on entry is `null` at the start and thereafter exactly what the last committed
// batch returned — a crash between batches replays at most one page, and because facts insert
// idempotently on their segment key, the replay is free.
//
// `gate(host, fn)` is the politeness gate: at most ONE in-flight upstream request per host,
// across every job this worker runs. Handlers wrap each upstream call in it, naming the host —
// the hostname string lives in the source module, where hostnames belong, not here.

import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

import { openStore, defaultDataDir } from './store.mjs'
import { JobQueue, LeaseLostError } from './jobs.mjs'

/**
 * One in-flight request per host, enforced by chaining: each host maps to the promise of the
 * last call routed through it, and the next call starts when that one settles — pass or fail.
 * Politeness by construction, not by handlers counting.
 */
export class HostGate {
  #tails = new Map()

  /** @template T @param {string} host @param {() => Promise<T>} fn @returns {Promise<T>} */
  run = (host, fn) => {
    const tail = this.#tails.get(host) ?? Promise.resolve()
    const next = tail.then(fn, fn)
    // Track settlement without swallowing the rejection the caller is owed.
    const settled = next.then(
      () => {},
      () => {},
    )
    this.#tails.set(host, settled)
    settled.then(() => {
      if (this.#tails.get(host) === settled) this.#tails.delete(host)
    })
    return next
  }
}

/**
 * Resolve a job handler through the registry — imported lazily so that a test (or the CLI
 * against a synthetic handler) never has to load every source module just to run the engine.
 */
async function registryHandler(sourceId, operationId) {
  const { resolveJob } = await import('../sources/index.mjs')
  const { handler, error } = resolveJob(sourceId, operationId)
  if (error) throw new Error(error)
  return handler
}

/**
 * Run one claimed job to its end state. The engine owns every transition and every write;
 * the handler only ever answers "given this cursor, what is the next batch".
 *
 * @param {import('./store.mjs').Store} store
 * @param {import('./jobs.mjs').JobQueue} queue
 * @param {import('./jobs.mjs').Job} job          must already be in state `running` (claimed)
 * @param {object} [options]
 * @param {(sourceId: string, operationId: string) => Promise<object>|object} [options.resolveHandler]
 *        tests inject synthetic handlers here; production resolves through the registry
 * @param {HostGate} [options.gate]               shared across jobs for the per-host guarantee
 * @param {(job: import('./jobs.mjs').Job) => void} [options.onProgress]
 * @returns {Promise<import('./jobs.mjs').Job>}   the job in its final state for this run
 */
export async function runJob(store, queue, job, { resolveHandler = registryHandler, gate = new HostGate(), onProgress } = {}) {
  // Heartbeat the lease while batches are in flight. Without this, one slow nextBatch — a
  // single-node devnet taking its time, or the HostGate queueing this batch behind another
  // job's requests — would outlive the lease and hand the job to a second engine while this
  // one is still fetching. With it, a lapsed lease MEANS a dead owner. Unref'd: a heartbeat
  // must never be what keeps a process alive.
  const beat = setInterval(() => {
    try {
      queue.heartbeat(job.id)
    } catch {
      /* a failed heartbeat is discovered by the guarded writes, not here */
    }
  }, Math.max(250, Math.floor(queue.leaseMs / 3)))
  beat.unref?.()

  try {
    // A handler that cannot be resolved is a design error, not upstream weather — burning the
    // attempt budget on it would only reach the same surrender more slowly.
    let handler
    try {
      handler = await resolveHandler(job.source, job.operation)
    } catch (problem) {
      throw new EngineRefusal(problem?.message ?? String(problem))
    }
    if (typeof handler?.immutable !== 'function' || typeof handler?.nextBatch !== 'function') {
      throw new EngineRefusal(`${job.source}/${job.operation} does not implement the job contract (immutable + nextBatch).`)
    }
    // A handler that says its answer can still change does not belong here — that is mode B.
    // Refused permanently (gave-up), because retrying a design error is just a slower error.
    if (handler.immutable(job.params) !== true) {
      throw new EngineRefusal(`${job.source}/${job.operation} declares these params mutable — use the TTL cache, not a job.`)
    }

    let cursor = job.cursor
    if (cursor === null && handler.plan) {
      const planned = await handler.plan({ params: job.params, gate: gate.run })
      if (planned && planned.totalUnits !== undefined) {
        // Progress only — cursor omitted, so advance keeps whatever is there (nothing, here).
        queue.advance(job.id, { totalUnits: planned.totalUnits })
      }
    }

    for (;;) {
      // Cooperative cancellation, checked between batches against committed state — a cancel
      // issued by the CLI while the server's worker runs is seen here too.
      if (queue.cancelRequested(job.id)) {
        const parked = queue.markPartial(job.id)
        onProgress?.(parked)
        return parked
      }

      const batch = await handler.nextBatch({ params: job.params, cursor, gate: gate.run })
      if (!batch || !Array.isArray(batch.rows)) {
        throw new EngineRefusal(`${job.source}/${job.operation} returned a batch without a rows array.`)
      }
      if (!batch.done && batch.cursor === undefined) {
        throw new EngineRefusal(`${job.source}/${job.operation} returned an unfinished batch without a cursor — it could never resume.`)
      }

      // A done batch may omit its cursor; the last committed cursor is KEPT, never nulled —
      // erasing it would turn a crash at exactly the wrong instant into a full refetch.
      if (batch.cursor !== undefined) cursor = batch.cursor

      // THE one transaction: every row of the batch, then the cursor that covers them — and,
      // on the final batch, the `done` state itself, so "the work exists" and "the job says
      // so" are one atomic fact with no crash window between them. putFact throws on a
      // malformed row, which rolls the whole batch back — a half-batch is not a smaller
      // batch, it is a lie about coverage. advance/complete throw LeaseLostError if another
      // engine owns the job now, which rolls the batch back too: a deposed engine commits
      // nothing.
      store.transaction(() => {
        for (const row of batch.rows) {
          store.putFact({
            source: job.source,
            operation: job.operation,
            params: job.params,
            segment: row.segment,
            payload: row.payload,
            head: row.head ?? null,
            codeVersion: row.codeVersion ?? null,
          })
        }
        queue.advance(job.id, { cursor, doneUnits: batch.doneUnits, totalUnits: batch.totalUnits })
        if (batch.done) queue.complete(job.id)
      })

      const current = queue.get(job.id)
      onProgress?.(current)
      if (batch.done) return current
    }
  } catch (problem) {
    // Losing the lease is not a job failure — the job is alive and owned by someone else.
    // No transition; report the state the new owner is maintaining.
    if (problem instanceof LeaseLostError) return queue.get(job.id)
    // A refusal is a design error, not weather: it goes straight to gave-up rather than
    // burning the attempt budget on something a retry cannot fix.
    const failed =
      problem instanceof EngineRefusal
        ? queue.giveUp(job.id, problem.message)
        : queue.fail(job.id, problem?.message ?? String(problem))
    onProgress?.(failed)
    return failed
  } finally {
    clearInterval(beat)
  }
}

class EngineRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'EngineRefusal'
  }
}

/**
 * Drain the queue: claim, run, repeat, until nothing is claimable. This is the same loop for
 * the worker thread and for `scripts/job.mjs run` in the foreground — the tier-3 promise that
 * local and production execute identical code.
 *
 * Exactly one drainer at a time across the machine, via the store's engine lock: the HostGate
 * is per-process, so a server worker and a shell `job run` draining concurrently would be two
 * independent gates hitting the same volunteer-run host. Returns `null` (not an empty array)
 * when another live drainer holds the lock — "someone else is on it" is a different answer
 * from "nothing to do".
 */
export async function drainQueue(store, queue, options = {}) {
  if (!queue.acquireDrainLock()) return null
  try {
    const gate = options.gate ?? new HostGate()
    const results = []
    for (;;) {
      const job = queue.claim(options.id ?? null)
      if (!job) break
      results.push(await runJob(store, queue, job, { ...options, gate }))
      if (options.id !== undefined) break // a targeted run runs one job, not the world
    }
    return results
  } finally {
    queue.releaseDrainLock()
  }
}

/* ------------------------------------------------------------------ the worker thread ---- */

/**
 * Spawn (or reuse) the worker thread that drains the queue, then exits when idle. +17 MB
 * measured, versus ~47 MB for a child process — which is why it is a thread. The caller
 * checks `queue.hasRunnable()` first; an idle queue spawns nothing.
 *
 * The spawner and the worker open SEPARATE connections to the same WAL file — the HTTP
 * thread keeps its own read view while the worker writes.
 */
let activeWorker = null
let respawnRequested = false

export function ensureWorker({ dir = defaultDataDir() } = {}) {
  if (activeWorker) {
    // The existing worker may be mid-exit — its final empty claim() already made, the 'exit'
    // event not yet delivered — in which case whatever was just enqueued would sit unrun with
    // no poller to notice. Requesting a respawn closes that window: when THIS worker exits, a
    // fresh one spawns and drains (an already-empty queue costs it one claim and an exit).
    respawnRequested = true
    return activeWorker
  }
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { dir } })
  worker.unref() // the worker must never be what keeps the server process alive
  const finished = () => {
    if (activeWorker === worker) activeWorker = null
    if (respawnRequested) {
      respawnRequested = false
      ensureWorker({ dir })
    }
  }
  worker.on('exit', finished)
  worker.on('error', (problem) => {
    console.error('[job-worker]', problem)
    finished()
  })
  activeWorker = worker
  return worker
}

if (!isMainThread && workerData?.dir) {
  // We ARE the worker. Open our own handle, adopt any orphans, drain, and exit — an idle
  // worker holding 17 MB is 17 MB spent on nothing.
  const store = openStore({ dir: workerData.dir })
  const queue = new JobQueue(store)
  try {
    await drainQueue(store, queue, {
      onProgress: (job) => parentPort?.postMessage({ type: 'progress', job }),
    })
  } finally {
    store.close()
  }
}
