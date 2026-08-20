// The HTTP API: the store-backed (mode A) read path, job status, and proof that the cached
// (mode B) path is exactly what it was.
//
// Nothing here binds a port and nothing here touches an upstream. `createApp()` returns the
// real request handler, so these tests drive the real routing — the same `handle` the listener
// at the bottom of server/index.mjs is handed — against a synthetic source injected through
// the same factory-parameter seam `runJob` uses for handlers.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../index.mjs'
import { openStore } from '../lib/store.mjs'
import { runJob } from '../lib/job-worker.mjs'
import { MAX_LIVE_JOBS_PER_OPERATION } from '../lib/demand.mjs'

/* ---------------------------------------------------------------------------- the rig ---- */

/**
 * A response object with exactly the surface `send()` uses. Cheaper and more honest than a
 * loopback socket: what is asserted is what the handler wrote, not what a client re-parsed.
 */
function recorder() {
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      return res
    },
    end(body) {
      res.body = body === undefined ? '' : String(body)
    },
  }
  return res
}

/** `handle` awaits everything before it calls end(), so awaiting it is the whole wait. */
async function get(app, url) {
  const res = recorder()
  await app.handle({ method: 'GET', url }, res)
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    json: () => JSON.parse(res.body),
  }
}

/** A synthetic paged job handler: `pages` batches of one segment each, ISO-date segments. */
function pagedJob({ pages = 3, immutable = () => true, schema } = {}) {
  return {
    summary: 'A synthetic paged backfill. Touches nothing.',
    schema: schema ?? { days: { type: 'int', min: 1, max: 400, default: 3 } },
    immutable,
    plan: async () => ({ totalUnits: pages }),
    nextBatch: async ({ cursor }) => {
      const page = cursor === null ? 0 : cursor.page
      return {
        rows: [{ segment: `2026-01-${String(page + 1).padStart(2, '0')}`, payload: { page }, head: `head-${page}` }],
        cursor: { page: page + 1 },
        done: page + 1 >= pages,
        doneUnits: page + 1,
      }
    },
  }
}

/** A synthetic mode-B operation. `run` counts its calls so single-flight stays observable. */
function cachedOperation() {
  const calls = { n: 0 }
  return {
    calls,
    operation: {
      summary: 'A synthetic cached read. Touches nothing.',
      ttlMs: 30_000,
      schema: { days: { type: 'int', min: 1, max: 90, default: 7 } },
      run: async (params) => {
        calls.n += 1
        return { echoed: params.days }
      },
    },
  }
}

/**
 * An app over a throwaway store, with a synthetic registry and a worker that only records that
 * it was asked for. Spawning a real worker thread here would resolve handlers through the REAL
 * registry (which has never heard of `syn`) and immediately surrender the job — the spy keeps
 * the wiring assertion honest without that noise.
 */
function rig(t, { jobs = {}, operations = {}, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-api-'))
  const store = openStore({ dir })
  const spawns = []
  const app = createApp({
    dev: true,
    store,
    ensureWorker: (arg) => spawns.push(arg),
    registry: {
      resolve: (sourceId, operationId) => {
        if (sourceId !== 'syn') return { error: `Unknown source \`${sourceId}\`.` }
        const operation = operations[operationId]
        if (!operation) return { error: `Source \`syn\` has no operation \`${operationId}\`.` }
        return { source: { id: 'syn' }, operation }
      },
      resolveJob: (sourceId, operationId) => {
        const handler = sourceId === 'syn' ? jobs[operationId] : undefined
        return handler ? { source: { id: 'syn' }, handler } : { error: 'no job' }
      },
    },
    ...options,
  })
  t.after(() => {
    app.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { app, store, dir, spawns, queue: app.queue }
}

/* ------------------------------------------------------------------------- mode B ---- */

test('mode B: a non-jobs operation answers exactly as it did before the store existed', async (t) => {
  const cached = cachedOperation()
  const { app, spawns, queue } = rig(t, { operations: { echo: cached.operation } })

  const first = await get(app, '/api/syn/echo?days=7')
  assert.equal(first.status, 200)
  // The envelope, byte for byte. No coverage, no job, no identity — a mode-B answer must not
  // grow a field because mode A exists.
  assert.equal(first.body, JSON.stringify({ source: 'syn', operation: 'echo', params: { days: 7 }, data: { echoed: 7 } }))
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(first.headers['cache-control'], 'public, max-age=30')
  assert.equal(first.headers['x-cache'], 'miss')
  assert.equal(first.headers['x-store'], undefined)

  const second = await get(app, '/api/syn/echo?days=7')
  assert.equal(second.body, first.body)
  assert.equal(second.headers['x-cache'], 'hit')
  assert.equal(cached.calls.n, 1, 'the TTL cache still serves the second read')

  // And it stays clear of the job system entirely.
  assert.equal(queue.list().length, 0)
  assert.deepEqual(spawns, [])

  // Validation and 404s are unchanged too.
  assert.equal((await get(app, '/api/syn/echo?days=900')).status, 400)
  assert.equal((await get(app, '/api/syn/nope')).status, 404)
  assert.equal((await get(app, '/api/nosuch/echo')).status, 404)
})

test('/healthz stays a flat, dependency-free `ok`', async (t) => {
  const { app } = rig(t)
  const res = await get(app, '/healthz')
  assert.equal(res.status, 200)
  assert.equal(res.body, 'ok')
  assert.equal(res.headers['cache-control'], 'no-store')
})

/* ------------------------------------------------------------------------- mode A ---- */

test('mode A: an empty store answers 200 with no rows, a coverage note and a job to poll', async (t) => {
  const { app, spawns, queue } = rig(t, { jobs: { pages: pagedJob({ pages: 3 }) } })

  const res = await get(app, '/api/syn/pages?days=3')
  assert.equal(res.status, 200, 'a partial answer is an answer, not an error')
  const body = res.json()

  assert.deepEqual(body.data, [])
  assert.equal(body.params.days, 3)
  assert.equal(body.coverage.complete, false)
  assert.equal(body.coverage.segments, 0)
  assert.equal(body.coverage.earliest, null)
  assert.equal(body.coverage.latest, null)
  assert.match(body.coverage.note, /Nothing is stored/)

  // The job is named, and its progress is NOT KNOWABLE yet — null, never 0.
  assert.equal(typeof body.job.id, 'number')
  assert.equal(body.job.state, 'queued')
  assert.equal(body.job.progress, null)

  assert.equal(res.headers['cache-control'], 'no-store', 'a partial answer must not be cached')
  assert.equal(res.headers['x-store'], 'partial')

  // Exactly one job, and the worker was asked for exactly once.
  assert.equal(queue.list().length, 1)
  assert.equal(spawns.length, 1)
})

test('mode A: a half-filled store answers with the rows it has plus live progress', async (t) => {
  const handler = pagedJob({ pages: 4 })
  const { app, store, queue } = rig(t, { jobs: { pages: handler } })

  // First request creates the job; run two batches of it by hand, then park it.
  await get(app, '/api/syn/pages?days=4')
  const job = queue.list()[0]
  let batches = 0
  await runJob(store, queue, queue.claim(job.id), {
    resolveHandler: () => handler,
    onProgress: () => {
      batches += 1
      if (batches === 2) queue.cancel(job.id)
    },
  })
  assert.equal(queue.get(job.id).state, 'partial')

  const res = await get(app, '/api/syn/pages?days=4')
  const body = res.json()
  assert.equal(body.coverage.complete, false)
  assert.equal(body.coverage.segments, 2)
  assert.equal(body.coverage.earliest, '2026-01-01')
  assert.equal(body.coverage.latest, '2026-01-02')
  assert.deepEqual(
    body.data.map((row) => row.segment),
    ['2026-01-01', '2026-01-02'],
  )
  assert.deepEqual(body.data[0].payload, { page: 0 })
  assert.equal(body.data[0].head, 'head-0')

  // Same job id — the parked job was resumed in place, not replaced.
  assert.equal(body.job.id, job.id)
  assert.equal(body.job.state, 'queued')
  assert.deepEqual(body.job.progress, { done: 2, total: 4, fraction: 0.5 })
  assert.match(body.coverage.note, /2 of 4 units fetched/)
  assert.equal(queue.list().length, 1, 'resuming a partial job must not mint a second identity')
})

test('mode A: once the job is done the answer is complete, cacheable, and has no job', async (t) => {
  const handler = pagedJob({ pages: 3 })
  const { app, store, queue, spawns } = rig(t, { jobs: { pages: handler } })

  await get(app, '/api/syn/pages?days=3')
  const job = queue.list()[0]
  const finished = await runJob(store, queue, queue.claim(job.id), { resolveHandler: () => handler })
  assert.equal(finished.state, 'done')

  const spawnsBefore = spawns.length
  const res = await get(app, '/api/syn/pages?days=3')
  const body = res.json()

  assert.equal(body.coverage.complete, true)
  assert.equal(body.coverage.segments, 3)
  assert.equal(body.job, null)
  assert.deepEqual(
    body.data.map((row) => row.payload.page),
    [0, 1, 2],
  )
  assert.match(body.coverage.note, /Complete/)
  assert.equal(res.headers['cache-control'], 'public, max-age=300')
  assert.equal(res.headers['x-store'], 'complete')

  // Fetched once, ever: no second job, and no reason to wake the worker.
  assert.equal(queue.list().length, 1)
  assert.equal(spawns.length, spawnsBefore)
})

test('mode A: N concurrent identical requests produce ONE job', async (t) => {
  const { app, queue } = rig(t, { jobs: { pages: pagedJob() } })

  const answers = await Promise.all(Array.from({ length: 12 }, () => get(app, '/api/syn/pages?days=3')))
  const ids = new Set(answers.map((res) => res.json().job.id))
  assert.equal(ids.size, 1, 'find-or-create, not create')
  assert.equal(queue.list().length, 1)

  // Key order and equivalent spellings are the same identity, so they join too.
  const same = await get(app, '/api/syn/pages?days=3')
  assert.equal(same.json().job.id, [...ids][0])
})

test('mode A: distinct params are capped, and over the cap nothing is enqueued', async (t) => {
  const { app, queue } = rig(t, { jobs: { pages: pagedJob({ pages: 2 }) } })

  // Walk `days` through distinct values — each honestly a different identity, so dedup cannot
  // help and the cap is the only thing between this and an unbounded queue.
  for (let days = 1; days <= MAX_LIVE_JOBS_PER_OPERATION; days += 1) {
    const res = await get(app, `/api/syn/pages?days=${days}`)
    assert.equal(res.json().job.state, 'queued', `request ${days} should have been accepted`)
  }
  assert.equal(queue.list().length, MAX_LIVE_JOBS_PER_OPERATION)

  const over = await get(app, `/api/syn/pages?days=${MAX_LIVE_JOBS_PER_OPERATION + 1}`)
  assert.equal(over.status, 200, 'over the cap is still an answer')
  const body = over.json()
  assert.equal(body.job, null, 'no job is created over the cap')
  assert.equal(body.coverage.complete, false)
  assert.deepEqual(body.data, [])
  assert.match(body.coverage.note, /queue is busy/)
  assert.equal(queue.list().length, MAX_LIVE_JOBS_PER_OPERATION, 'and nothing was queued for later')

  // A repeat of an ALREADY live identity still joins its job — the cap must not break dedup.
  const existing = await get(app, '/api/syn/pages?days=1')
  assert.equal(existing.json().job.state, 'queued')
})

test('mode A: params are validated before anything is enqueued', async (t) => {
  const { app, queue, spawns } = rig(t, { jobs: { pages: pagedJob() } })

  assert.equal((await get(app, '/api/syn/pages?days=0')).status, 400)
  assert.equal((await get(app, '/api/syn/pages?days=99999')).status, 400)
  assert.equal((await get(app, '/api/syn/pages?days=abc')).status, 400)
  assert.equal((await get(app, '/api/syn/pages?nonsense=1')).status, 400)
  assert.equal(queue.list().length, 0)
  assert.deepEqual(spawns, [])
})

test('mode A: a handler that declares its params mutable is refused, not queued', async (t) => {
  const { app, queue } = rig(t, { jobs: { live: pagedJob({ immutable: () => false }) } })

  const res = await get(app, '/api/syn/live?days=3')
  assert.equal(res.status, 400)
  assert.match(res.json().error.message, /can still change/)
  assert.equal(queue.list().length, 0, 'a job the engine would refuse must never be created')
})

test('mode A: a gave-up job is not restarted by the next reader', async (t) => {
  // No backoff delay, so the three attempts of the budget can be spent in a loop here.
  const { app, store, queue } = rig(t, { jobs: { pages: pagedJob() }, queueOptions: { backoffBaseMs: 0 } })
  const doomed = {
    immutable: () => true,
    nextBatch: async () => {
      throw new Error('synthetic upstream timeout')
    },
  }

  await get(app, '/api/syn/pages?days=3')
  const job = queue.list()[0]
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = queue.claim(job.id)
    if (!claimed) break
    await runJob(store, queue, claimed, { resolveHandler: () => doomed })
  }
  assert.equal(queue.get(job.id).state, 'gave-up')

  const res = await get(app, '/api/syn/pages?days=3')
  const body = res.json()
  assert.equal(res.status, 200)
  assert.equal(body.coverage.complete, false)
  assert.equal(body.job.id, job.id)
  assert.equal(body.job.state, 'gave-up')
  assert.match(body.coverage.note, /abandoned/)
  assert.match(body.coverage.note, /synthetic upstream timeout/)
  assert.equal(queue.list().length, 1, 'a surrender an anonymous GET can undo is not a surrender')
})

/* ---------------------------------------------------------------------- job status ---- */

test('/api/jobs/:id: state, progress, coverage and timestamps; 404 for anything else', async (t) => {
  const handler = pagedJob({ pages: 3 })
  const { app, store, queue } = rig(t, { jobs: { pages: handler } })

  const created = (await get(app, '/api/syn/pages?days=3')).json()
  const queued = await get(app, `/api/jobs/${created.job.id}`)
  assert.equal(queued.status, 200)
  assert.equal(queued.headers['cache-control'], 'no-store')
  const body = queued.json()
  assert.equal(body.id, created.job.id)
  assert.equal(body.state, 'queued')
  assert.equal(body.progress, null, 'not knowable is null, never 0')
  assert.deepEqual(body.coverage, { segments: 0, earliest: null, latest: null })
  assert.equal(body.attempts, 0)
  assert.equal(body.error, null)
  assert.equal(typeof body.createdAt, 'number')
  assert.equal(typeof body.updatedAt, 'number')

  await runJob(store, queue, queue.claim(created.job.id), { resolveHandler: () => handler })
  const done = (await get(app, `/api/jobs/${created.job.id}`)).json()
  assert.equal(done.state, 'done')
  assert.deepEqual(done.progress, { done: 3, total: 3, fraction: 1 })
  assert.equal(done.coverage.segments, 3)
  assert.equal(done.coverage.earliest, '2026-01-01')

  assert.equal((await get(app, '/api/jobs/999999')).status, 404)
  // No listing endpoint, and no path that could become one.
  assert.equal((await get(app, '/api/jobs')).status, 404)
  assert.equal((await get(app, '/api/jobs/all')).status, 404)
  assert.equal((await get(app, '/api/jobs/1/cancel')).status, 404)
})

test('the job system is GET-only over HTTP: no cancel, no retry, no enqueue', async (t) => {
  const handler = pagedJob()
  const { app, queue } = rig(t, { jobs: { pages: handler } })
  const created = (await get(app, '/api/syn/pages?days=3')).json()

  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
    const res = recorder()
    await app.handle({ method, url: `/api/jobs/${created.job.id}` }, res)
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, HEAD')
  }
  assert.equal(queue.get(created.job.id).state, 'queued', 'still queued — nothing over HTTP moved it')
})

/* -------------------------------------------------------------------------- startup ---- */

test('startup recovers stale leases exactly once, and mode A degrades to 503 without a store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-api-recover-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // Leave a job stranded in `running` with a lapsed lease — a worker that was SIGKILLed.
  {
    const store = openStore({ dir })
    const app = createApp({ dev: true, store, ensureWorker: () => {}, registry: emptyRegistry() })
    const job = app.queue.enqueue('syn', 'pages', { days: 3 })
    app.queue.claim(job.id)
    store.db.prepare('UPDATE jobs SET lease_expires_at = 1 WHERE id = ?').run(job.id)
    assert.equal(app.queue.get(job.id).state, 'running')
    app.close()
    store.close()
  }

  // A fresh app over the same directory adopts it: JobQueue's constructor recovers, and that
  // constructor runs once per app.
  {
    const store = openStore({ dir })
    const app = createApp({ dev: true, store, ensureWorker: () => {}, registry: emptyRegistry() })
    assert.equal(app.queue.get(1).state, 'queued')
    assert.equal(app.queue.get(1).leaseOwner, null)
    app.close()
    store.close()
  }

  // No store at all: mode A says so plainly, /healthz and /api/health keep working.
  const app = createApp({
    dev: true,
    store: null,
    dataDir: join(dir, 'definitely', 'not', 'creatable', '\0'),
    ensureWorker: () => {},
    registry: {
      resolve: () => ({ error: 'Unknown source `syn`.' }),
      resolveJob: (s, o) => (s === 'syn' && o === 'pages' ? { source: { id: 'syn' }, handler: pagedJob() } : { error: 'no job' }),
    },
  })
  t.after(() => app.close())
  assert.equal(app.store, null)
  assert.equal(app.queue, null)
  assert.equal((await get(app, '/healthz')).body, 'ok')
  assert.equal((await get(app, '/api/health')).json().store.available, false)
  assert.equal((await get(app, '/api/syn/pages?days=3')).status, 503)
  assert.equal((await get(app, '/api/jobs/1')).status, 503)
})

function emptyRegistry() {
  return { resolve: () => ({ error: 'none' }), resolveJob: () => ({ error: 'none' }) }
}
