// The demand-driven read path — plan §2.1 and §2.5, at the HTTP boundary.
//
// This is the half of mode A a reader can actually see. The store (store.mjs) holds the facts,
// the queue (jobs.mjs) holds the intentions and the worker (job-worker.mjs) does the fetching;
// this file is the one place that decides, for one request:
//
//     what do we have  ·  is that everything  ·  and if not, is something already getting it
//
// and answers **200 with all three stated**. Never a spinner, never an error, never a bare
// empty array. A partial answer is an answer — the reader learns which segments exist, which
// do not, and what is being done about it. That is rule 3 of CLAUDE.md applied to time: a
// number without its caveat is worse than no number, and "this is 60 days of a year you asked
// for" is exactly such a caveat.
//
// There is no HTTP in here — no `res`, no headers, no status codes beyond the one field the
// caller turns into a status. The seam is deliberate: server/index.mjs owns the wire format
// and this file owns the decision, so the decision can be tested by calling a function.
//
// ── what "complete" means, precisely ─────────────────────────────────────────────────────────
// Completeness is a fact about a JOB, not about the world. The store cannot know what it was
// never asked to fetch: an identity with 60 stored days and no job is indistinguishable, from
// inside SQLite, from an identity whose upstream only ever had 60 days. So:
//
//     complete  ⟺  a job for exactly this identity reached `done`, and no live job supersedes it
//
// The handler decided what "everything" meant when it returned `done: true`, and the engine
// committed that decision in the same transaction as the final batch. This function does not
// second-guess it, and it does not invent a denominator it cannot derive.
//
// ── abuse posture ────────────────────────────────────────────────────────────────────────────
// Job creation is the one thing an anonymous GET on a public site can do here that costs real
// money — upstream bandwidth against volunteer-run infrastructure (plan §3.1: "client-triggered
// server ingest is a DoS amplification path"). Five bounds, each enforced by code that runs
// before a row is inserted, not by hope:
//
//   1. THE REGISTRY ALLOWLIST. Only a (source, operation) with a `jobs` entry in
//      server/sources/index.mjs can reach this file at all — the caller resolves through
//      `resolveJob` first. There is no code path from a client-supplied string to a new job
//      kind, exactly as there is none to a URL.
//   2. PARAM VALIDATION. The caller has already run readParams against the handler's declared
//      schema, so the params reaching `enqueue` are normalised and in range. A handler with no
//      schema accepts NO parameters (readParams rejects unknown names) — the safe default.
//   3. THE IMMUTABILITY PREDICATE. A handler that says these params can still change is refused
//      here, before a job exists. Without this check, "give me today" mints a job that the
//      engine will only surrender three attempts later — a free amplifier with a delay on it.
//   4. FIND-OR-CREATE. N identical readers produce ONE job (jobs.mjs `enqueue`, inside a
//      transaction, backed by a partial unique index). Refreshing the page in a loop is free.
//   5. THE ATTEMPT BUDGET, AND ITS MARKER. A job that spent its budget is `gave-up` and this
//      file does NOT enqueue past it. A surrender that the next anonymous GET could undo is
//      not a surrender.
//
// Bounds 4 and 5 say nothing about a caller walking a parameter through a thousand distinct
// values — each one is honestly a different identity, so dedup cannot help. That is what
// MAX_LIVE_JOBS_PER_OPERATION below is for.

import { canonicalParams } from './store.mjs'

/**
 * How many jobs for one (source, operation) may be live at once, across all params.
 *
 * Named once, here, because a cap that appears twice is a cap that disagrees with itself.
 *
 * Eight, and the number follows from the machine rather than from taste. Exactly one drainer
 * runs across the whole host (the engine lock), and inside it the HostGate allows exactly one
 * in-flight request per upstream host. So jobs against the same upstream execute *serially* no
 * matter how many are queued: a ninth live job would not make anything finish sooner, it would
 * only add a row and a lengthening backlog nobody is watching. Eight leaves genuine
 * concurrent readers — each looking at a different window — room to each have their own fetch
 * pending, while capping what a distinct-params flood can mint at a number a human can read in
 * `job list`.
 *
 * Over the cap the reader still gets a real answer: whatever the store holds, plus a coverage
 * note saying the queue is busy. No job is created, and nothing is queued for later.
 */
export const MAX_LIVE_JOBS_PER_OPERATION = 8

/**
 * Answer one request for a store-backed (mode A) operation.
 *
 * @param {object} args
 * @param {import('./store.mjs').Store} args.store
 * @param {import('./jobs.mjs').JobQueue} args.queue
 * @param {string} args.sourceId
 * @param {string} args.operationId
 * @param {Record<string, unknown>} args.params   already validated and normalised
 * @param {object} args.handler                   the registry's job handler for this operation
 * @param {() => void} [args.startWorker]         called ONLY when a job was just created
 * @returns {Promise<{ status: number, body: object, complete: boolean }>}
 */
export async function serveFromStore({ store, queue, sourceId, operationId, params, handler, startWorker }) {
  const identity = queue.describeIdentity(sourceId, operationId, params)
  const stored = store.coverage(sourceId, operationId, params)

  // ── complete ───────────────────────────────────────────────────────────────────────────────
  // A job for this identity finished and nothing live supersedes it. Answer as a normal
  // payload: the data is here, nothing is being fetched, and `job` is null because there is
  // nothing to poll.
  if (!identity.live && identity.done) {
    return {
      status: 200,
      complete: true,
      body: await envelope({
        store,
        sourceId,
        operationId,
        params,
        stored,
        complete: true,
        job: null,
        note:
          `Complete: the fetch for this request finished, and the store holds all ` +
          `${stored.segments} ${plural(stored.segments, 'segment')} it produced${range(stored)}. ` +
          `Immutable data is fetched once and never again.`,
      }),
    }
  }

  // ── something is already on it ─────────────────────────────────────────────────────────────
  // Find-or-create's read half. A live job means this exact request is being filled right now
  // (or is queued, or is backing off after a failure); joining it is the whole point, and it
  // costs one indexed lookup rather than an insert.
  if (identity.live) {
    // A `partial` job is parked — cancelled, or interrupted with its cursor intact — and a
    // fresh reader IS the demand it was waiting for. `enqueue` re-queues it in place (same id,
    // cursor kept) rather than minting a second identity, so this stays idempotent.
    const job = identity.live.state === 'partial' ? queue.enqueue(sourceId, operationId, params) : identity.live
    if (job.state === 'queued' || job.state === 'failed') startWorker?.()
    return {
      status: 200,
      complete: false,
      body: await envelope({
        store,
        sourceId,
        operationId,
        params,
        stored,
        complete: false,
        job,
        note: partialNote(stored, job),
      }),
    }
  }

  // ── surrendered, and it stays surrendered ──────────────────────────────────────────────────
  // `gave-up` is a persisted decision (jobs.mjs header): three attempts were spent and written
  // down. Enqueueing a fresh job here would make that decision meaningless — every anonymous
  // GET would restart the grind — so this path answers with what exists and names the failure.
  // Only `job retry <id>` on the CLI leaves this state, deliberately.
  if (identity.latest?.state === 'gave-up') {
    return {
      status: 200,
      complete: false,
      body: await envelope({
        store,
        sourceId,
        operationId,
        params,
        stored,
        complete: false,
        job: identity.latest,
        note:
          `Stalled: the store holds ${stored.segments} ${plural(stored.segments, 'segment')}` +
          `${range(stored)}, and the fetch for the rest was attempted ` +
          `${identity.latest.attempts} ${plural(identity.latest.attempts, 'time')} and abandoned` +
          `${identity.latest.error ? ` (${identity.latest.error})` : ''}. It will not restart on ` +
          `its own — this needs a maintainer, not another request.`,
      }),
    }
  }

  // ── nothing exists yet: this request is the demand ─────────────────────────────────────────

  // Bound 3. Asked before a row is inserted, because a job the engine will refuse three
  // attempts from now is a job that should never have been created. A predicate that throws
  // counts as "no" — conservative, per plan §2.1, where the permissive direction is the one
  // that produces silently wrong data forever.
  let immutable = false
  try {
    immutable = handler.immutable(params) === true
  } catch {
    immutable = false
  }
  if (!immutable) {
    return {
      status: 400,
      complete: false,
      body: {
        error: {
          kind: 'request',
          message:
            `\`${sourceId}/${operationId}\` cannot answer these parameters from the store: the ` +
            `answer can still change, so there is nothing here to fetch once and keep.`,
        },
      },
    }
  }

  // The cap. Checked only on the create path — a request that joins an existing job never
  // counts against it, so dedup stays the cheap answer it is supposed to be.
  if (queue.countLive(sourceId, operationId) >= MAX_LIVE_JOBS_PER_OPERATION) {
    return {
      status: 200,
      complete: false,
      body: await envelope({
        store,
        sourceId,
        operationId,
        params,
        stored,
        complete: false,
        job: null,
        note:
          `The queue is busy: \`${sourceId}/${operationId}\` already has ` +
          `${MAX_LIVE_JOBS_PER_OPERATION} fetches in flight, which is the cap, so no fetch was ` +
          `started for this request. The store holds ${stored.segments} ` +
          `${plural(stored.segments, 'segment')}${range(stored)} of it. Ask again shortly.`,
      }),
    }
  }

  const job = queue.enqueue(sourceId, operationId, params)
  // Only now. An idle queue must spawn nothing — the worker costs 17 MB and exists to drain
  // work that exists.
  startWorker?.()
  return {
    status: 200,
    complete: false,
    body: await envelope({
      store,
      sourceId,
      operationId,
      params,
      stored,
      complete: false,
      job,
      note: partialNote(stored, job),
    }),
  }
}

/**
 * Job status, for polling. The same object the partial envelope's `job` field carries, plus
 * the coverage it is filling and the timestamps a reader needs to tell "working" from "stuck".
 */
export function describeJob(store, job) {
  const stored = store.coverage(job.source, job.operation, job.params)
  return {
    id: job.id,
    source: job.source,
    operation: job.operation,
    params: job.params,
    state: job.state,
    progress: progressOf(job),
    coverage: { segments: stored.segments, ...pickRange(stored) },
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    // The last failure, in the reader's words. It is not a secret: every hostname this service
    // talks to is in a public repo, and a reader staring at a stalled coverage bar deserves to
    // know whether the upstream timed out or the range was empty.
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt ?? null,
  }
}

/**
 * Progress, with `null` meaning NOT KNOWABLE and never standing in for zero (CLAUDE.md: `null`
 * is not `0`). A handler that cannot count its pages reports null all the way up to here, and
 * the coverage UI must say "in progress", not "0%".
 *
 * `fraction` is separately nullable: a job can know it has done 4 units without knowing how
 * many there are, and 4/unknown is not 0% either.
 */
export function progressOf(job) {
  if (job.doneUnits === null || job.doneUnits === undefined) return null
  const done = Number(job.doneUnits)
  const total = job.totalUnits === null || job.totalUnits === undefined ? null : Number(job.totalUnits)
  return { done, total, fraction: total !== null && total > 0 ? done / total : null }
}

/* -------------------------------------------------------------------------- internals ---- */

/**
 * The one envelope shape, complete or partial. Same keys either way — a reader parses one
 * thing, and "is it finished" is a field rather than a shape difference.
 *
 * `data` carries the segment id next to each payload because the segment IS the identity of
 * the chunk (a day, a page, a block window); a bare payload array would leave the reader
 * unable to say which day is missing, which is the whole point of answering partially.
 *
 * The read goes through `store.readFacts`, which yields to the event loop every 512 rows — a
 * year of days on the HTTP thread must not stall every other request behind it (store.mjs).
 *
 * KNOWN LIMIT, stated rather than discovered: this returns EVERY stored segment for the
 * identity, with no paging. That is correct for a request whose params already bound the range
 * (a year of days is ~365 rows), and it is the wrong shape the first time an operation's
 * identity covers an unbounded span. The fix then is a range parameter on the operation — a
 * narrower identity — not a cursor bolted onto this envelope.
 */
async function envelope({ store, sourceId, operationId, params, stored, complete, job, note }) {
  const facts = await store.readFacts(sourceId, operationId, params)
  return {
    source: sourceId,
    operation: operationId,
    params,
    identity: canonicalParams(params),
    data: facts.map((fact) => ({
      segment: fact.segment,
      payload: fact.payload,
      // What the row was computed against, carried through rather than dropped: a store you
      // cannot audit is a store you cannot re-derive (plan §6.1). null = not recorded.
      head: fact.head,
      storedAt: fact.storedAt,
    })),
    coverage: {
      complete,
      segments: stored.segments,
      ...pickRange(stored),
      note,
    },
    job: job === null ? null : { id: job.id, state: job.state, progress: progressOf(job) },
  }
}

function partialNote(stored, job) {
  const head =
    stored.segments === 0
      ? 'Nothing is stored for this request yet'
      : `Partial: the store holds ${stored.segments} ${plural(stored.segments, 'segment')}${range(stored)}`
  const progress = progressOf(job)
  const units =
    progress === null
      ? 'progress is not knowable for this fetch'
      : progress.total === null
        ? `${progress.done} ${plural(progress.done, 'unit')} fetched of an unknown total`
        : `${progress.done} of ${progress.total} ${plural(progress.total, 'unit')} fetched`
  return `${head}. Job ${job.id} is \`${job.state}\` — ${units}. Poll /api/jobs/${job.id}.`
}

/** earliest/latest only when there is something to bound; nulls are kept as nulls. */
function pickRange(stored) {
  return { earliest: stored.earliest ?? null, latest: stored.latest ?? null }
}

function range(stored) {
  if (!stored.earliest || !stored.latest) return ''
  return stored.earliest === stored.latest
    ? ` (${stored.earliest})`
    : ` (${stored.earliest} to ${stored.latest})`
}

function plural(count, word) {
  return Number(count) === 1 ? word : `${word}s`
}
