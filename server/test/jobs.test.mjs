// The job system: find-or-create, the rows+cursor invariant, the attempt budget, cancellation
// and crash recovery — all against synthetic handlers. Nothing here touches any upstream.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../lib/store.mjs'
import { JobQueue, LeaseLostError } from '../lib/jobs.mjs'
import { runJob, drainQueue, HostGate } from '../lib/job-worker.mjs'

/** A store in a throwaway directory, a queue with no backoff delay, and a fake clock. */
function rig(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-jobs-'))
  const store = openStore({ dir })
  const clock = { at: 1_000_000 }
  const queue = new JobQueue(store, { backoffBaseMs: 0, now: () => clock.at, ...options })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, queue, clock, dir }
}

/**
 * A synthetic paged upstream: `pages` batches of `rowsPerPage` facts each, resuming from
 * `cursor.page`. `failures` maps a page number to how many times fetching it should throw
 * before succeeding — a timeout that clears, in miniature.
 */
function pagedHandler({ pages = 5, rowsPerPage = 2, failures = {}, fetched = [] } = {}) {
  return {
    immutable: () => true,
    plan: async () => ({ totalUnits: pages }),
    nextBatch: async ({ cursor }) => {
      const page = cursor === null ? 0 : cursor.page
      fetched.push(page)
      if (failures[page] > 0) {
        failures[page] -= 1
        throw new Error(`synthetic timeout on page ${page}`)
      }
      const rows = Array.from({ length: rowsPerPage }, (_, i) => ({
        segment: `p${page}-r${i}`,
        payload: { page, row: i },
        head: `head-${page}`,
      }))
      return { rows, cursor: { page: page + 1 }, done: page + 1 >= pages, doneUnits: page + 1 }
    },
  }
}

const handlerFor = (handler) => () => handler

test('find-or-create: concurrent identical requests share one job; done permits a new one', async (t) => {
  const { store, queue } = rig(t)

  const [a, b] = await Promise.all([
    Promise.resolve().then(() => queue.enqueue('syn', 'pages', { days: 7 })),
    Promise.resolve().then(() => queue.enqueue('syn', 'pages', { days: 7 })),
  ])
  assert.equal(a.id, b.id)
  // Key order must not mint a second identity either.
  assert.equal(queue.enqueue('syn', 'pages', { days: 7 }).id, a.id)
  assert.equal(queue.list().length, 1)
  // Different params ARE a different job.
  assert.notEqual(queue.enqueue('syn', 'pages', { days: 30 }).id, a.id)

  // Once done, the identity is free again — a re-derive is a new job, deliberately.
  const finished = await runJob(store, queue, queue.claim(a.id), { resolveHandler: handlerFor(pagedHandler({ pages: 1 })) })
  assert.equal(finished.state, 'done')
  assert.notEqual(queue.enqueue('syn', 'pages', { days: 7 }).id, a.id)
})

test('resumability: a mid-run throw leaves rows and cursor consistent; the resume duplicates nothing', async (t) => {
  const { store, queue } = rig(t)
  const fetched = []
  const handler = pagedHandler({ pages: 5, failures: { 2: 1 }, fetched })

  const job = queue.enqueue('syn', 'pages', { days: 5 })
  const failed = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })

  // Pages 0 and 1 committed; page 2 threw. The cursor points exactly past what the store holds.
  assert.equal(failed.state, 'failed')
  assert.deepEqual(failed.cursor, { page: 2 })
  assert.equal(failed.doneUnits, 2)
  assert.equal(failed.totalUnits, 5)
  const before = await store.readFacts('syn', 'pages', { days: 5 })
  assert.equal(before.length, 4) // 2 pages x 2 rows

  // Backoff is 0 in this rig, so the retry is claimable immediately — and resumes AT the
  // cursor: page 2 again, never pages 0-1.
  const done = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(done.state, 'done')
  assert.deepEqual(fetched, [0, 1, 2, 2, 3, 4])

  const facts = await store.readFacts('syn', 'pages', { days: 5 })
  assert.equal(facts.length, 10)
  assert.equal(new Set(facts.map((fact) => fact.segment)).size, 10) // no duplicates
})

test('atomicity: a batch that fails mid-insert leaves no rows and no cursor', async (t) => {
  const { store, queue } = rig(t)
  const handler = {
    immutable: () => true,
    // Two well-formed rows, then one the store must refuse — the transaction has already
    // inserted the first two when the third throws, and all of it must vanish.
    nextBatch: async () => ({
      rows: [
        { segment: 'ok-1', payload: 1 },
        { segment: 'ok-2', payload: 2 },
        { segment: 42, payload: 3 },
      ],
      cursor: { page: 1 },
      done: false,
    }),
  }

  const job = queue.enqueue('syn', 'broken-batch', {})
  const failed = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })

  assert.equal(failed.state, 'failed')
  assert.equal(failed.cursor, null) // the cursor did not advance without its rows...
  assert.equal((await store.readFacts('syn', 'broken-batch', {})).length, 0) // ...nor rows without a cursor
})

test('attempt budget: three failures persist as gave-up; retry resets it and the job completes', async (t) => {
  const { store, queue, clock } = rig(t, { backoffBaseMs: 1000, maxAttempts: 3 })
  const fetched = []
  const handler = pagedHandler({ pages: 2, failures: { 0: 99 }, fetched })

  const job = queue.enqueue('syn', 'pages', {})
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = queue.claim(job.id)
    assert.ok(claimed, `attempt ${attempt} should be claimable`)
    await runJob(store, queue, claimed, { resolveHandler: handlerFor(handler) })
    if (attempt < 3) {
      // Exponential backoff: not claimable until the delay has passed.
      assert.equal(queue.get(job.id).state, 'failed')
      assert.equal(queue.claim(job.id), undefined)
      clock.at += 1000 * 2 ** (attempt - 1)
    }
  }

  const surrendered = queue.get(job.id)
  assert.equal(surrendered.state, 'gave-up')
  assert.equal(surrendered.attempts, 3)
  assert.match(surrendered.error, /synthetic timeout/)
  assert.equal(queue.claim(job.id), undefined) // gave-up is not silently re-ground
  // Still one job row: the surrender is a persisted marker, and an identical enqueue after it
  // creates a NEW job only because a human could also have fixed the world meanwhile.

  // The CLI's retry path: back to queued, budget restored, cursor intact.
  const reset = queue.retry(job.id)
  assert.equal(reset.state, 'queued')
  assert.equal(reset.attempts, 0)

  handler.nextBatch = pagedHandler({ pages: 2, fetched }).nextBatch // the upstream recovered
  const done = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(done.state, 'done')
  assert.equal((await store.readFacts('syn', 'pages', {})).length, 4)
})

test('cancellation between batches leaves partial with a valid cursor; re-enqueueing resumes it', async (t) => {
  const { store, queue } = rig(t)
  const fetched = []
  const handler = pagedHandler({ pages: 10, fetched })

  const job = queue.enqueue('syn', 'pages', {})
  let cancelled = false
  const parked = await runJob(store, queue, queue.claim(job.id), {
    resolveHandler: handlerFor(handler),
    onProgress: () => {
      // Cancel after the first committed batch — from "elsewhere", as the CLI would.
      if (!cancelled) {
        cancelled = true
        queue.cancel(job.id)
      }
    },
  })

  assert.equal(parked.state, 'partial')
  assert.deepEqual(parked.cursor, { page: 1 })
  assert.equal(parked.cancelRequested, false)
  assert.equal((await store.readFacts('syn', 'pages', {})).length, 2) // exactly the committed batch

  // A new identical request is the demand that resumes it — same job, not a duplicate.
  const resumed = queue.enqueue('syn', 'pages', {})
  assert.equal(resumed.id, job.id)
  assert.equal(resumed.state, 'queued')
  const done = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(done.state, 'done')
  assert.deepEqual(fetched, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) // no page fetched twice
})

test('a running job whose owner died reverts to queued, cursor intact, on the next open', (t) => {
  const { store, queue, clock } = rig(t, { leaseMs: 5_000 })

  const job = queue.enqueue('syn', 'pages', { days: 1 })
  const claimed = queue.claim(job.id)
  assert.equal(claimed.state, 'running')
  // The dead worker had committed one batch — cursor and rows are already durable.
  store.transaction(() => {
    store.putFact({ source: 'syn', operation: 'pages', params: { days: 1 }, segment: 'p0-r0', payload: 0 })
    queue.advance(job.id, { cursor: { page: 1 }, doneUnits: 1 })
  })

  // A fresh queue within the lease adopts nothing — the owner may still be alive.
  new JobQueue(store, { now: () => clock.at })
  assert.equal(queue.get(job.id).state, 'running')

  // Past the lease, the next open reverts it to queued with the cursor untouched.
  clock.at += 60_000
  new JobQueue(store, { now: () => clock.at })
  const recovered = queue.get(job.id)
  assert.equal(recovered.state, 'queued')
  assert.deepEqual(recovered.cursor, { page: 1 })
  assert.equal(recovered.doneUnits, 1)
})

test('progress that is not knowable stays null — never 0', async (t) => {
  const { store, queue } = rig(t)
  const handler = {
    immutable: () => true,
    nextBatch: async ({ cursor }) => {
      const page = cursor === null ? 0 : cursor.page
      // This upstream cannot count its total, and says so with null.
      return { rows: [{ segment: `p${page}`, payload: page }], cursor: { page: page + 1 }, done: page >= 1, doneUnits: null, totalUnits: null }
    },
  }
  const job = queue.enqueue('syn', 'unbounded', {})
  const done = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(done.state, 'done')
  assert.equal(done.doneUnits, null)
  assert.equal(done.totalUnits, null)
})

test('a handler that declares its params mutable is refused permanently, not retried', async (t) => {
  const { store, queue } = rig(t)
  const handler = { immutable: () => false, nextBatch: async () => ({ rows: [], cursor: null, done: true }) }
  const job = queue.enqueue('syn', 'tvl-now', {})
  const refused = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(refused.state, 'gave-up')
  assert.match(refused.error, /mutable/)
  assert.equal(queue.claim(job.id), undefined)
})

test('the host gate never lets two requests to one host overlap, across jobs', async () => {
  const gate = new HostGate()
  let inFlight = 0
  let peak = 0
  const call = (host) =>
    gate.run(host, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((settle) => setImmediate(settle))
      inFlight -= 1
    })

  await Promise.all([call('a.example'), call('a.example'), call('a.example'), call('b.example')])
  // Three calls to one host serialised; the second host was free to run alongside — the gate
  // is per host, not a global choke.
  assert.equal(peak, 2)
})

test('a deposed engine commits nothing: its batch rolls back, its verdicts are refused', async (t) => {
  const { store, queue: a, clock } = rig(t, { leaseMs: 5_000 })
  const b = new JobQueue(store, { backoffBaseMs: 0, leaseMs: 5_000, now: () => clock.at })

  const job = a.enqueue('syn', 'pages', {})
  const claimed = a.claim(job.id)
  assert.equal(claimed.state, 'running')

  // A's one nextBatch takes "longer than the lease" (the fake clock jumps past it) and B
  // adopts the orphan through claim() — no recover() needed. A then tries to commit.
  const stolenDuringFetch = {
    immutable: () => true,
    nextBatch: async () => {
      clock.at += 6_000
      const adopted = b.claim(job.id)
      assert.ok(adopted, 'the lapsed lease should be claimable directly')
      assert.equal(adopted.state, 'running')
      return { rows: [{ segment: 'p0', payload: 0 }], cursor: { page: 1 }, done: false }
    },
  }
  const outcome = await runJob(store, a, claimed, { resolveHandler: handlerFor(stolenDuringFetch) })

  // THE invariant, under contention: the deposed engine's rows and cursor vanished together.
  assert.equal(outcome.state, 'running') // B's run, reported as-is; A made no transition
  assert.equal((await store.readFacts('syn', 'pages', {})).length, 0)
  assert.equal(a.get(job.id).cursor, null)

  // A's late verdicts change nothing: fail is a no-op, complete/advance throw.
  assert.equal(a.fail(job.id, 'zombie says timeout').state, 'running')
  assert.equal(a.get(job.id).attempts, 0)
  assert.throws(() => a.complete(job.id), LeaseLostError)
  assert.throws(() => a.advance(job.id, { cursor: { page: 99 } }), LeaseLostError)

  // B finishes; a fresh enqueue then creates a NEW row — and A's stale fail() against the
  // done job must neither revive it nor explode on the live-identity unique index.
  const done = await runJob(store, b, b.get(job.id), { resolveHandler: handlerFor(pagedHandler({ pages: 1 })) })
  assert.equal(done.state, 'done')
  const fresh = b.enqueue('syn', 'pages', {})
  assert.notEqual(fresh.id, job.id)
  assert.equal(a.fail(job.id, 'very late zombie').state, 'done')
})

test('hasRunnable and claim both see a lapsed-lease orphan; a live lease is left alone', (t) => {
  const { store, queue, clock } = rig(t, { leaseMs: 5_000 })
  const job = queue.enqueue('syn', 'pages', {})
  queue.claim(job.id)
  store.transaction(() => queue.advance(job.id, { cursor: { page: 3 } }))

  const other = new JobQueue(store, { backoffBaseMs: 0, leaseMs: 5_000, now: () => clock.at })
  assert.equal(other.hasRunnable(), false) // within the lease the owner may be alive
  assert.equal(other.claim(), undefined)

  clock.at += 6_000
  assert.equal(other.hasRunnable(), true) // the orphan IS runnable, no recover() required
  const adopted = other.claim()
  assert.equal(adopted.id, job.id)
  assert.equal(adopted.state, 'running')
  assert.deepEqual(adopted.cursor, { page: 3 }) // resumes where the dead owner stopped
})

test('a done batch may omit its cursor: the last committed cursor survives completion', async (t) => {
  const { store, queue } = rig(t)
  const handler = {
    immutable: () => true,
    nextBatch: async ({ cursor }) => {
      const page = cursor === null ? 0 : cursor.page
      const rows = [{ segment: `p${page}`, payload: page }]
      if (page === 0) return { rows, cursor: { page: 1 }, done: false }
      return { rows, done: true } // no cursor — explicitly allowed by the contract
    },
  }
  const job = queue.enqueue('syn', 'open-ended', {})
  const done = await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(handler) })
  assert.equal(done.state, 'done')
  assert.deepEqual(done.cursor, { page: 1 }) // kept, not nulled
  assert.equal((await store.readFacts('syn', 'open-ended', {})).length, 2)
})

test('backoff is capped: a generous attempt budget cannot write an unreadable delay', async (t) => {
  const { store, queue, clock } = rig(t, { backoffBaseMs: 30_000, maxAttempts: 60, leaseMs: 5_000 })
  const alwaysFails = { immutable: () => true, nextBatch: async () => { throw new Error('synthetic outage') } }

  const job = queue.enqueue('syn', 'flaky', {})
  for (let attempt = 0; attempt < 45; attempt += 1) {
    clock.at += 3_600_001 // past the one-hour cap, so every attempt is claimable
    const claimed = queue.claim(job.id)
    assert.ok(claimed, `attempt ${attempt + 1} should be claimable`)
    await runJob(store, queue, claimed, { resolveHandler: handlerFor(alwaysFails) })
  }

  const after = queue.get(job.id) // at attempt 45 an uncapped 30000·2^44 would be unreadable
  assert.equal(after.attempts, 45)
  assert.ok(after.nextAttemptAt - clock.at <= 3_600_000, 'delay is capped at one hour')
})

test('re-enqueueing a job cancelled during backoff is claimable now, not after the dead backoff', async (t) => {
  const { store, queue } = rig(t, { backoffBaseMs: 60_000 })
  const failing = { immutable: () => true, nextBatch: async () => { throw new Error('once') } }

  const job = queue.enqueue('syn', 'pages', {})
  await runJob(store, queue, queue.claim(job.id), { resolveHandler: handlerFor(failing) })
  assert.equal(queue.get(job.id).state, 'failed') // in backoff for 60 s

  queue.cancel(job.id)
  assert.equal(queue.get(job.id).state, 'partial')

  const resumed = queue.enqueue('syn', 'pages', {})
  assert.equal(resumed.id, job.id)
  assert.equal(resumed.state, 'queued')
  assert.equal(resumed.nextAttemptAt, null) // the abandoned attempt's schedule is gone
  assert.ok(queue.claim(job.id), 'claimable immediately — the demand is fresh')
})

test('fresh demand clears a stale cancel flag left by a dead owner', (t) => {
  const { queue, clock } = rig(t, { leaseMs: 5_000 })
  const job = queue.enqueue('syn', 'pages', {})
  queue.claim(job.id)
  queue.cancel(job.id) // running → flag set, awaiting the engine...
  clock.at += 6_000
  queue.recover() // ...but the owner died; back to queued, flag still set
  assert.equal(queue.get(job.id).cancelRequested, true)

  const joined = queue.enqueue('syn', 'pages', {})
  assert.equal(joined.id, job.id)
  assert.equal(joined.cancelRequested, false) // the new demand is not pre-cancelled
})

test('retry against a live sibling is refused with an answer, not a constraint error', (t) => {
  const { queue } = rig(t)
  const job = queue.enqueue('syn', 'pages', {})
  queue.claim(job.id)
  queue.giveUp(job.id, 'design error')
  assert.equal(queue.get(job.id).state, 'gave-up')

  const sibling = queue.enqueue('syn', 'pages', {}) // legal: gave-up freed the identity
  assert.notEqual(sibling.id, job.id)
  assert.throws(() => queue.retry(job.id), /already covers the same request/)
  assert.equal(queue.get(job.id).state, 'gave-up') // unchanged
})

test('one drainer at a time: a held drain lock turns drainQueue into null, and expires with its owner', async (t) => {
  const { store, queue: a, clock } = rig(t)
  const b = new JobQueue(store, { backoffBaseMs: 0, now: () => clock.at })

  assert.equal(a.acquireDrainLock(), true)
  assert.equal(a.acquireDrainLock(), true) // re-acquiring one's own lock refreshes it
  assert.equal(b.acquireDrainLock(), false)
  assert.equal(await drainQueue(store, b), null) // "someone else is on it", not "nothing to do"

  a.releaseDrainLock()
  assert.equal(b.acquireDrainLock(), true)
  b.releaseDrainLock()

  a.acquireDrainLock()
  clock.at += 61_000 // past the default lease: a dead drainer's lock is claimable
  assert.equal(b.acquireDrainLock(), true)
  b.releaseDrainLock()
})

test('drainQueue runs everything claimable and stops', async (t) => {
  const { store, queue } = rig(t)
  queue.enqueue('syn', 'pages', { days: 1 })
  queue.enqueue('syn', 'pages', { days: 2 })
  const results = await drainQueue(store, queue, { resolveHandler: () => pagedHandler({ pages: 2 }) })
  assert.deepEqual(results.map((job) => job.state), ['done', 'done'])
  assert.equal(queue.hasRunnable(), false)
})
