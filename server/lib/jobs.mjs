// The persisted job queue — plan §2.5. State only; execution lives in job-worker.mjs.
//
// A job is an intention: "fetch (source, operation, params) into the store". The queue's whole
// job is to make that intention durable — across a SIGTERM, a redeploy, a crashed worker and a
// reader who closed the tab — and to make it SINGULAR: ten readers asking for the same year
// produce one job. This is the single-flight property of the TtlCache, made durable, and it is
// enforced twice: by find-or-create inside a transaction here, and by a partial unique index in
// the schema (store.mjs) for whatever this code gets wrong.
//
// States, and who moves a job between them:
//
//   queued   ──claim──▶ running ──complete──▶ done
//     ▲                   │ │
//     │        fail (budget left, backoff)    ──▶ failed ──(next_attempt_at due)──▶ claimed again
//     │                   │ │
//     │        fail (budget spent) ──────────────▶ gave-up          ──retry──▶ queued
//     │                   │
//     │        cancel observed / owner died ─────▶ partial (cursor intact)
//     └──────── enqueue of the same identity resumes a partial ◀────┘
//
// `gave-up` is a PERSISTED surrender. A timeout is indistinguishable from "no rows in this
// range", so a queue that silently retried forever would grind against an empty window at 12 s
// an attempt for the rest of its life. Three failed attempts get written down as a fact about
// the job, inspectable in `job list` and reversible only by an explicit `job retry`.
//
// Progress is `done_units / total_units`, and either may be NULL — "not knowable" — which is a
// different fact from 0 and is never collapsed into it. A handler that cannot count total pages
// reports null and the coverage UI says "in progress", not "0%".
//
// ── ownership ────────────────────────────────────────────────────────────────────────────────
// Every JobQueue instance has a random `owner` id, stamped onto a job at claim. Every write a
// running engine makes — advance, complete, fail, giveUp, markPartial, heartbeat — is guarded
// by `state = 'running' AND lease_owner = me`. A lease that lapses (a batch slower than the
// engine's heartbeat should ever allow, i.e. the owner is genuinely dead or wedged) makes the
// job claimable by someone else, and from that moment the OLD owner's writes are refused: it
// cannot regress the cursor, cannot flip a done job to failed, cannot collide with a fresh
// sibling on the live-identity index. advance/complete THROW `LeaseLostError` on refusal so the
// engine's surrounding transaction rolls back — a deposed engine's batch commits nothing.

import { randomUUID } from 'node:crypto'
import { canonicalParams } from './store.mjs'

/** States under which a second request for the same identity joins the existing job. */
const LIVE_STATES = ['queued', 'running', 'partial', 'failed']

/**
 * Claimable: queued/failed past their backoff — plus a `running` job whose lease has lapsed.
 * The lease case makes orphan adoption a property of `claim()` itself rather than of
 * `recover()` having happened to run: a worker SIGKILLed mid-job leaves a row any later
 * claimer picks up directly, instead of a corpse only a constructor could revive.
 */
const RUNNABLE_WHERE = `(
  (state IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
  OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
)`

/** Backoff never exceeds an hour, and the exponent is capped so a large `maxAttempts` cannot
 *  overflow into an int64 that no later read can represent as a JS number (observed: attempt
 *  40 at the default base poisons the row for every subsequent SELECT). */
const MAX_BACKOFF_MS = 3_600_000
const BACKOFF_EXPONENT_CAP = 20

/** Thrown by advance/complete when the caller no longer owns the job. The engine lets this
 *  abort (and roll back) the surrounding transaction, then walks away without a transition. */
export class LeaseLostError extends Error {
  constructor(id) {
    super(`Job ${id}: lease no longer held — another worker owns this job now.`)
    this.name = 'LeaseLostError'
  }
}

export class JobQueue {
  /**
   * @param {import('./store.mjs').Store} store  the queue lives in the store's SQLite file,
   *        on the store's connection — that shared connection is what lets the engine commit
   *        fact rows and a cursor in one transaction.
   * @param {object} [options]
   * @param {number} [options.maxAttempts]   failures before a job is marked gave-up
   * @param {number} [options.backoffBaseMs] first retry delay; doubles per attempt
   * @param {number} [options.leaseMs]       heartbeat lease; a running job past it is orphaned
   * @param {() => number} [options.now]     injectable clock, for tests
   */
  constructor(store, { maxAttempts = 3, backoffBaseMs = 30_000, leaseMs = 60_000, now = Date.now } = {}) {
    this.store = store
    this.db = store.db
    this.maxAttempts = maxAttempts
    this.backoffBaseMs = backoffBaseMs
    this.leaseMs = leaseMs
    this.now = now
    /** This instance's identity for lease ownership — see the header. */
    this.owner = randomUUID()
    this.recover()
  }

  /**
   * Adopt the orphans. A `running` job whose lease has lapsed belongs to a process that died —
   * SIGKILL, OOM, a yanked power cable — and reverts to `queued` with its cursor intact, so
   * the next worker resumes where the dead one stopped rather than starting over. Runs at
   * every open as tidiness (so `job list` shows the truth); correctness no longer depends on
   * it, because `claim()` adopts lapsed leases directly.
   */
  recover() {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', lease_expires_at = NULL, lease_owner = NULL, updated_at = ?
         WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(this.now(), this.now())
    return Number(result.changes)
  }

  /**
   * Find-or-create — the only way a job comes into existence. An identical request while a
   * live job exists returns that job; a request for a `partial` one additionally re-queues it,
   * because a new request IS the demand that resuming was waiting for. Only a `done` or
   * `gave-up` history permits a genuinely new row (an explicit re-derive, or a retry after a
   * fix — either way, deliberate).
   */
  enqueue(source, operation, params = {}) {
    const key = canonicalParams(params)
    return this.store.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM jobs WHERE source = ? AND operation = ? AND params = ?
           AND state IN (${LIVE_STATES.map(() => '?').join(', ')})`,
        )
        .get(source, operation, key, ...LIVE_STATES)

      if (existing) {
        if (existing.state === 'partial') {
          // Re-queued NOW: clear the cancel flag AND any backoff left over from the attempt
          // that was cancelled — a demand that resumes a parked job should not silently wait
          // out the schedule of an attempt somebody explicitly abandoned.
          this.db
            .prepare(
              `UPDATE jobs SET state = 'queued', cancel_requested = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(this.now(), existing.id)
          return this.get(existing.id)
        }
        // A queued/failed job can carry a stale cancel flag (cancel requested, owner died,
        // recover re-queued it). Fresh demand clears it — otherwise the next claim would park
        // the job as `partial` having fetched nothing. A RUNNING job keeps its flag: that
        // cancel is addressed to a live engine, and this enqueue does not overrule it.
        if (existing.cancel_requested === 1 && existing.state !== 'running') {
          this.db.prepare('UPDATE jobs SET cancel_requested = 0, updated_at = ? WHERE id = ?').run(this.now(), existing.id)
          return this.get(existing.id)
        }
        return toJob(existing)
      }

      const created = this.db
        .prepare(
          `INSERT INTO jobs (source, operation, params, state, max_attempts, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(source, operation, key, this.maxAttempts, this.now(), this.now())
      return this.get(Number(created.lastInsertRowid))
    })
  }

  /** @returns {Job | undefined} */
  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? toJob(row) : undefined
  }

  /**
   * Recent jobs, newest first. Bounded by `limit`, so a plain read — the iterate-and-yield
   * pattern is for reads without a ceiling, and this one has one.
   */
  list({ state, limit = 50 } = {}) {
    const rows = state
      ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY id DESC LIMIT ?').all(state, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit)
    return rows.map(toJob)
  }

  /**
   * Take the next runnable job (or, with `id`, that specific job if runnable) and mark it
   * `running` under a lease owned by THIS queue instance. One transaction, so two workers
   * cannot claim the same row. A lapsed-lease `running` job is runnable too — claiming it IS
   * the recovery, and stamping a new owner is what fences the old one out.
   */
  claim(id = null) {
    return this.store.transaction(() => {
      const row = id === null
        ? this.db
            .prepare(`SELECT * FROM jobs WHERE ${RUNNABLE_WHERE} ORDER BY id LIMIT 1`)
            .get(this.now(), this.now())
        : this.db
            .prepare(`SELECT * FROM jobs WHERE id = ? AND ${RUNNABLE_WHERE}`)
            .get(id, this.now(), this.now())
      if (!row) return undefined

      this.db
        .prepare(`UPDATE jobs SET state = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(this.owner, this.now() + this.leaseMs, this.now(), row.id)
      return this.get(row.id)
    })
  }

  /**
   * Renew the lease on a job this instance owns (and the drain lock, if held). The engine
   * calls this on a timer while a batch is in flight, so a slow upstream never lapses the
   * lease of a LIVE owner — lapse now means "dead or wedged", which is what claim() assumes.
   * @returns {boolean} whether the lease is still ours
   */
  heartbeat(id) {
    const result = this.db
      .prepare(`UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_owner = ?`)
      .run(this.now() + this.leaseMs, this.now(), id, this.owner)
    this.db
      .prepare('UPDATE engine_lock SET expires_at = ? WHERE id = 1 AND owner = ?')
      .run(this.now() + this.leaseMs, this.owner)
    return Number(result.changes) > 0
  }

  /**
   * Record a committed batch: the new cursor, progress, and a fresh lease. The engine calls
   * this INSIDE the same transaction that inserted the batch's fact rows — that is the
   * invariant this whole design exists for, and it is why this method does not open a
   * transaction of its own. Ownership-guarded: a deposed engine gets `LeaseLostError`, which
   * rolls that transaction back — rows and cursor vanish together.
   *
   * `cursor`: `undefined` means "keep what is there"; an explicit `null` resets to the start —
   * the same undefined/null distinction `doneUnits`/`totalUnits` already observe, so a
   * progress-only advance cannot silently erase the resume point.
   */
  advance(id, { cursor, doneUnits, totalUnits }) {
    const sets = ['lease_expires_at = ?', 'updated_at = ?']
    const values = [this.now() + this.leaseMs, this.now()]
    if (cursor !== undefined) {
      sets.push('cursor = ?')
      values.push(cursor === null ? null : JSON.stringify(cursor))
    }
    if (doneUnits !== undefined) {
      sets.push('done_units = ?')
      values.push(doneUnits)
    }
    if (totalUnits !== undefined) {
      sets.push('total_units = ?')
      values.push(totalUnits)
    }
    const result = this.db
      .prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND state = 'running' AND lease_owner = ?`)
      .run(...values, id, this.owner)
    if (Number(result.changes) === 0) throw new LeaseLostError(id)
  }

  /**
   * The job finished everything it set out to fetch. Called INSIDE the final batch's
   * transaction (job-worker.mjs), so rows, cursor and `done` are one atomic fact — there is
   * no crash window in which the work happened but the job does not say so. Ownership-guarded
   * like advance, and throws for the same reason.
   */
  complete(id) {
    const result = this.db
      .prepare(
        `UPDATE jobs SET state = 'done', lease_expires_at = NULL, lease_owner = NULL, next_attempt_at = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(this.now(), id, this.owner)
    if (Number(result.changes) === 0) throw new LeaseLostError(id)
  }

  /**
   * An attempt failed. Inside the budget the job becomes `failed` with an exponential-backoff
   * `next_attempt_at`; past it, `gave-up` — written down, so a range that times out forever is
   * ground three times and then never again until a human says `retry`.
   *
   * Read-modify-write inside one transaction, and only if this instance still owns the job:
   * a deposed engine reporting a stale failure changes nothing (and cannot flip a `done` job
   * back, or collide with a fresh sibling on the live-identity index).
   */
  fail(id, message) {
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
      if (!row) return undefined
      if (row.state !== 'running' || row.lease_owner !== this.owner) return toJob(row)
      const attempts = Number(row.attempts) + 1
      const spent = attempts >= Number(row.max_attempts)
      const backoff = Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** Math.min(attempts - 1, BACKOFF_EXPONENT_CAP))
      this.db
        .prepare(
          `UPDATE jobs SET state = ?, attempts = ?, next_attempt_at = ?, error = ?, lease_expires_at = NULL, lease_owner = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          spent ? 'gave-up' : 'failed',
          attempts,
          spent ? null : this.now() + backoff,
          String(message ?? 'unknown failure'),
          this.now(),
          id,
        )
      return this.get(id)
    })
  }

  /**
   * Surrender immediately, budget or no budget. For failures a retry cannot fix — a handler
   * that does not exist, params declared mutable — where burning three attempts on a design
   * error would only delay the same answer. Ownership-guarded like fail: only the live owner
   * of a running job may surrender it.
   */
  giveUp(id, message) {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'gave-up', attempts = max_attempts, next_attempt_at = NULL, error = ?, lease_expires_at = NULL, lease_owner = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(String(message ?? 'gave up'), this.now(), id, this.owner)
    return this.get(id)
  }

  /**
   * Ask a job to stop. A job that is not running stops right here — `partial`, cursor intact.
   * A running one keeps its flag set until the engine observes it between batches and calls
   * `markPartial`; cancellation is cooperative because the alternative is killing a worker
   * mid-transaction.
   */
  cancel(id) {
    return this.store.transaction(() => {
      const job = this.get(id)
      if (!job) return undefined
      if (job.state === 'running') {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(this.now(), id)
      } else if (job.state === 'queued' || job.state === 'failed') {
        this.db
          .prepare(
            `UPDATE jobs SET state = 'partial', cancel_requested = 0, lease_expires_at = NULL, lease_owner = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(this.now(), id)
      }
      return this.get(id)
    })
  }

  /** The engine observed the cancel flag (or is parking an interrupted run). Cursor stays.
   *  Ownership-guarded; a deposed engine parks nothing and just gets the current state back. */
  markPartial(id) {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'partial', cancel_requested = 0, lease_expires_at = NULL, lease_owner = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(this.now(), id, this.owner)
    return this.get(id)
  }

  /**
   * Reset a surrendered (or failed, or parked) job: attempts back to zero, claimable now,
   * cursor untouched — the work already done stays done. This is the CLI's `retry`, and it is
   * the ONLY path out of `gave-up`; that state means nothing if the machine can leave it on
   * its own.
   *
   * Refused (loudly, with the sibling named) when a LIVE job for the same identity already
   * exists — the database's unique index would reject the flip anyway; this turns that raw
   * constraint error into an answer.
   */
  retry(id) {
    return this.store.transaction(() => {
      const job = this.get(id)
      if (!job) return undefined
      if (!['gave-up', 'failed', 'partial'].includes(job.state)) return job
      const sibling = this.db
        .prepare(
          `SELECT id, state FROM jobs WHERE source = ? AND operation = ? AND params = ? AND id != ?
           AND state IN (${LIVE_STATES.map(() => '?').join(', ')})`,
        )
        .get(job.source, job.operation, job.paramsKey, id, ...LIVE_STATES)
      if (sibling) {
        throw new Error(
          `Job ${id} cannot be retried: job ${sibling.id} (${sibling.state}) already covers the same request.`,
        )
      }
      this.db
        .prepare(
          `UPDATE jobs SET state = 'queued', attempts = 0, next_attempt_at = NULL, cancel_requested = 0, error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(this.now(), id)
      return this.get(id)
    })
  }

  /**
   * Everything the queue knows about ONE identity, in the three facts a reader's request needs
   * (server/lib/demand.mjs):
   *
   *   · `live`   — the queued/running/partial/failed job, if any. At most one can exist, and
   *                that is the database's guarantee (the `jobs_live_identity` partial unique
   *                index), not this query's.
   *   · `done`   — the most recent job for this identity that ran to completion. Its existence
   *                is what "coverage is complete" MEANS here: the store cannot know what it was
   *                never asked to fetch, so completeness is a fact about a job, not the world.
   *   · `latest` — the newest job of any state, which is how a `gave-up` surrender stays
   *                visible. Without it the next reader would mint a fresh job and grind the
   *                same empty range again, which is the exact failure `gave-up` exists to stop.
   *
   * Three small indexed lookups rather than one clever one: each is a primary-key-ish read on
   * (source, operation, params), and the clever version would have to be re-read every time
   * someone changes what LIVE_STATES means.
   */
  describeIdentity(source, operation, params) {
    const key = canonicalParams(params)
    const live = this.db
      .prepare(
        `SELECT * FROM jobs WHERE source = ? AND operation = ? AND params = ?
         AND state IN (${LIVE_STATES.map(() => '?').join(', ')})`,
      )
      .get(source, operation, key, ...LIVE_STATES)
    const done = this.db
      .prepare(
        `SELECT * FROM jobs WHERE source = ? AND operation = ? AND params = ? AND state = 'done'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(source, operation, key)
    const latest = this.db
      .prepare('SELECT * FROM jobs WHERE source = ? AND operation = ? AND params = ? ORDER BY id DESC LIMIT 1')
      .get(source, operation, key)
    return {
      live: live ? toJob(live) : undefined,
      done: done ? toJob(done) : undefined,
      latest: latest ? toJob(latest) : undefined,
    }
  }

  /**
   * How many jobs for this (source, operation) are live right now — across ALL params.
   *
   * The dedup in `enqueue` bounds N identical readers to one job; it does nothing about one
   * caller walking a parameter through a thousand distinct values, each of which is honestly
   * a different identity. This count is what the HTTP layer caps that with. See
   * MAX_LIVE_JOBS_PER_OPERATION in demand.mjs for the number and why.
   */
  countLive(source, operation) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS live FROM jobs WHERE source = ? AND operation = ?
         AND state IN (${LIVE_STATES.map(() => '?').join(', ')})`,
      )
      .get(source, operation, ...LIVE_STATES)
    return Number(row?.live ?? 0)
  }

  /** Is anything claimable right now? What the server checks before spawning the worker.
   *  Same predicate as claim(), so a lapsed-lease orphan counts — it IS runnable. */
  hasRunnable() {
    const row = this.db
      .prepare(`SELECT id FROM jobs WHERE ${RUNNABLE_WHERE} LIMIT 1`)
      .get(this.now(), this.now())
    return row !== undefined
  }

  /** The running engine polls this between batches; it reads committed state, so a cancel
   *  issued from another process (the CLI, say) is seen too. */
  cancelRequested(id) {
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id)
    return row ? row.cancel_requested === 1 : false
  }

  /* ------------------------------------------------------------------- the drain lock ---- */

  /**
   * At most one drainer across the machine — the server's worker thread and a shell running
   * `job run` must not both fetch, or the per-host politeness gate (per-process, in memory)
   * silently becomes two gates. Lease semantics: a dead drainer's lock expires with its
   * heartbeats. Re-acquiring one's own lock refreshes it.
   */
  acquireDrainLock() {
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT owner, expires_at FROM engine_lock WHERE id = 1').get()
      if (row && row.owner !== this.owner && Number(row.expires_at) > this.now()) return false
      this.db
        .prepare(
          `INSERT INTO engine_lock (id, owner, expires_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
        )
        .run(this.owner, this.now() + this.leaseMs)
      return true
    })
  }

  releaseDrainLock() {
    this.db.prepare('DELETE FROM engine_lock WHERE id = 1 AND owner = ?').run(this.owner)
  }
}

/**
 * @typedef {object} Job
 * @property {number} id
 * @property {string} source
 * @property {string} operation
 * @property {Record<string, unknown>} params   parsed back from canonical JSON
 * @property {string} paramsKey                  the canonical JSON itself — the identity
 * @property {'queued'|'running'|'partial'|'done'|'failed'|'gave-up'} state
 * @property {unknown} cursor                    parsed; null = start
 * @property {number|null} doneUnits             null = not knowable
 * @property {number|null} totalUnits            null = not knowable
 */
function toJob(row) {
  return {
    id: Number(row.id),
    source: row.source,
    operation: row.operation,
    params: JSON.parse(row.params),
    paramsKey: row.params,
    state: row.state,
    cursor: row.cursor === null ? null : JSON.parse(row.cursor),
    doneUnits: row.done_units,
    totalUnits: row.total_units,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    cancelRequested: row.cancel_requested === 1,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
