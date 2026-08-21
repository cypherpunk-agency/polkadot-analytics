// Boot: opening the store must never cost the listener, and filling it must not need a reader.
//
// Three things are asserted here, and each is a bug that shipped rather than a hypothetical:
//
//   1. `openStore` on a directory it cannot create RETURNS — it throws, promptly, naming the
//      path. `mkdirSync(recursive: true)` did not: it read ENOENT as "make the parent and try
//      again" and, where creating a child of an existing directory is refused with ENOENT,
//      alternated between the two forever at 100% CPU. Nothing threw, so the try/catch that
//      exists to degrade mode A never ran and `server.listen` was never reached.
//   2. `createApp({deferStore:true})` builds a serving app with no store, and `openStore()`
//      attaches one afterwards — which is what lets the entry point bind the port before it
//      touches a mounted volume.
//   3. `warmStore` enqueues what a reader would have enqueued, and REFUSES the three cases
//      that would make a boot hook expensive: a complete identity (a refetch of everything),
//      a mutable one (a job the engine surrenders), a surrendered one (an undone decision).
//
// Nothing here touches an upstream, and nothing binds a port.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../index.mjs'
import { openStore } from '../lib/store.mjs'
import { JobQueue } from '../lib/jobs.mjs'
import { warmStore, MAX_WARM_IDENTITIES } from '../lib/warm.mjs'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-warm-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/* ------------------------------------------------------- 1: the open cannot run away ---- */

test('openStore throws promptly when the directory cannot exist, rather than looping', (t) => {
  const dir = scratch(t)

  // A FILE, then a directory asked for underneath it. Portable, needs no privileges, and no
  // filesystem can satisfy it.
  const file = join(dir, 'a-file')
  writeFileSync(file, 'not a directory')

  const started = Date.now()
  assert.throws(
    () => openStore({ dir: join(file, 'store') }),
    (problem) => problem.message.includes(join(file, 'store')),
    'the error must name the path, because the remedy is to change ANALYTICS_DATA_DIR',
  )
  // Generous by three orders of magnitude: the point is bounded-versus-unbounded, not speed.
  assert.ok(Date.now() - started < 5_000, 'opening an impossible directory must not hang')
})

test('a path that exists as a file is refused by name, not by SQLite', (t) => {
  const dir = scratch(t)
  const file = join(dir, 'occupied')
  writeFileSync(file, '')
  assert.throws(() => openStore({ dir: file }), /exists but is not a directory/)
})

/* ------------------------------------------------ 2: the port does not wait for a disk ---- */

test('deferStore builds a serving app with no store, and openStore() attaches one later', async (t) => {
  const dir = scratch(t)
  const app = createApp({ dev: true, dataDir: dir, deferStore: true, ensureWorker: () => {}, registry: none() })
  t.after(() => app.close())

  assert.equal(app.store, null, 'construction must not touch the filesystem')
  assert.equal(app.queue, null)

  const store = app.openStore()
  assert.ok(store, 'the store attaches on demand')
  assert.equal(app.store, store)
  assert.ok(app.queue instanceof JobQueue, 'and the queue is constructed with it — recovery runs once')

  // Idempotent: the entry point calls it without knowing whether construction already did.
  assert.equal(app.openStore(), store)
})

test('a deferred open that fails leaves the app serving with mode A off', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'a-file')
  writeFileSync(file, '')

  const app = createApp({
    dev: true,
    dataDir: join(file, 'store'),
    deferStore: true,
    ensureWorker: () => {},
    registry: none(),
  })
  t.after(() => app.close())

  assert.equal(app.openStore(), null)
  assert.equal(app.store, null)
  assert.equal(app.queue, null)
  // And startBackgroundWork is a no-op rather than a throw — a warm-up must never be able to
  // take down a server that is already answering.
  assert.deepEqual(await app.startBackgroundWork(), { warmed: null, resumed: false })
})

test('the poll picks up a job whose lease had not yet lapsed at boot', async (t) => {
  const dir = scratch(t)

  // A job left `running` by a process that died with its lease still in the future — exactly
  // what a SIGKILL or an OOM leaves behind, and what a redeploy comes back up to. At boot it is
  // NOT runnable, so a one-shot check finds nothing and a backfill that was 30/31 sits there.
  {
    const store = openStore({ dir })
    const queue = new JobQueue(store)
    const job = queue.enqueue('syn', 'daily', { month: '2026-07', network: 'polkadot' })
    queue.claim(job.id)
    store.db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?').run(Date.now() + 60_000, job.id)
    store.close()
  }

  const spawned = []
  const app = createApp({
    dev: true,
    dataDir: dir,
    deferStore: true,
    ensureWorker: (options) => spawned.push(options),
    registry: none(),
  })
  t.after(() => app.close())
  app.openStore()

  const { resumed } = await app.startBackgroundWork({ sources: {}, log: quiet, pollMs: 20 })
  assert.equal(resumed, false, 'at boot the lease is still live, so there is correctly nothing to run')
  assert.equal(spawned.length, 0)

  // Let the lease lapse, and let the tick notice. Nothing makes a request.
  app.store.db.prepare('UPDATE jobs SET lease_expires_at = 1 WHERE id = 1').run()
  await new Promise((settle) => setTimeout(settle, 120))
  assert.ok(spawned.length > 0, 'the poll found the orphan and started the drain worker')
})

/* --------------------------------------------------------------- 3: what warm enqueues ---- */

/**
 * A synthetic source, in the shape the registry hands warmStore. No upstream, no fetch: warming
 * only ever reads `schema`, `immutable` and `warm`.
 */
function syntheticSources(warm, { immutable = (p) => p.month < '2026-08' } = {}) {
  return {
    syn: {
      id: 'syn',
      jobs: {
        daily: {
          summary: 'synthetic',
          schema: {
            month: { type: 'string', required: true, pattern: /^\d{4}-\d{2}$/, maxLength: 7 },
            network: { type: 'string', required: true, oneOf: ['polkadot', 'kusama'] },
          },
          immutable,
          warm,
          nextBatch: async () => ({ rows: [], done: true }),
        },
      },
    },
  }
}

function rig(t) {
  const dir = scratch(t)
  const store = openStore({ dir })
  t.after(() => store.close())
  return { store, queue: new JobQueue(store) }
}

const quiet = () => {}

test('warmStore enqueues the identities a handler names, validated exactly as a request is', async (t) => {
  const { store, queue } = rig(t)
  const sources = syntheticSources(() => [
    { month: '2026-06', network: 'polkadot' },
    { month: '2026-07', network: 'polkadot' },
  ])

  const result = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(result.considered, 2)
  assert.equal(result.enqueued, 2)

  // THE identity test: a warmed job must be the SAME row a reader's request finds, or the
  // backfill runs twice and the page still starts empty.
  const found = queue.describeIdentity('syn', 'daily', { network: 'polkadot', month: '2026-07' })
  assert.ok(found.live, 'a reader asking for the same params (in any key order) joins the warmed job')
  assert.equal(found.live.state, 'queued')
})

test('warmStore refuses a mutable identity, exactly as the request path does', async (t) => {
  const { store, queue } = rig(t)
  const sources = syntheticSources(() => [
    { month: '2026-08', network: 'polkadot' }, // not settled
    { month: '2026-07', network: 'polkadot' },
  ])

  const result = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(result.enqueued, 1)
  assert.equal(result.skipped.mutable, 1)
  assert.equal(queue.describeIdentity('syn', 'daily', { month: '2026-08', network: 'polkadot' }).live, undefined)
})

test('warmStore never re-enqueues a COMPLETE identity — the whole point of the store', async (t) => {
  const { store, queue } = rig(t)
  const params = { month: '2026-07', network: 'polkadot' }
  const sources = syntheticSources(() => [params])

  // Fill it once, the way a finished job leaves things.
  const first = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(first.enqueued, 1)
  const job = queue.claim(first.jobs[0])
  queue.complete(job.id)
  assert.equal(queue.get(job.id).state, 'done')

  // Boot again. `enqueue` is find-or-create over LIVE states only, so without the completeness
  // check this would mint a SECOND job and refetch every segment — on every redeploy, with
  // correct answers and nothing anywhere reporting it.
  const second = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(second.enqueued, 0)
  assert.equal(second.skipped.complete, 1)
  assert.equal(queue.describeIdentity('syn', 'daily', params).live, undefined)
})

test('warmStore does not undo a surrender', async (t) => {
  const { store, queue } = rig(t)
  const params = { month: '2026-07', network: 'polkadot' }
  const sources = syntheticSources(() => [params])

  const first = await warmStore({ store, queue, sources, log: quiet })
  const job = queue.claim(first.jobs[0])
  queue.giveUp(job.id, 'the upstream has no such range')
  assert.equal(queue.get(job.id).state, 'gave-up')

  const second = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(second.enqueued, 0)
  assert.equal(second.skipped['gave-up'], 1)
})

test('warmStore resumes a parked job in place rather than minting a second identity', async (t) => {
  const { store, queue } = rig(t)
  const params = { month: '2026-07', network: 'polkadot' }
  const sources = syntheticSources(() => [params])

  const first = await warmStore({ store, queue, sources, log: quiet })
  const job = queue.claim(first.jobs[0])
  queue.markPartial(job.id)
  assert.equal(queue.get(job.id).state, 'partial')

  const second = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(second.enqueued, 1)
  assert.deepEqual(second.jobs, [job.id], 'same row, cursor intact — not a new job')
  assert.equal(queue.get(job.id).state, 'queued')
})

test('warmStore reports an invalid warm entry instead of storing it under a different identity', async (t) => {
  const { store, queue } = rig(t)
  const lines = []
  const sources = syntheticSources(() => [
    { month: '2026-07' }, // network missing — a different identity from what the page asks for
    { month: '2026-07', network: 'moonbeam' }, // not in oneOf
  ])

  const result = await warmStore({ store, queue, sources, log: (line) => lines.push(line) })
  assert.equal(result.enqueued, 0)
  assert.equal(result.skipped.invalid, 2)
  assert.equal(lines.length, 2)
})

test('a warm list over the ceiling enqueues NOTHING, rather than a silently truncated backfill', async (t) => {
  const { store, queue } = rig(t)
  const lines = []
  const sources = syntheticSources(() =>
    Array.from({ length: MAX_WARM_IDENTITIES + 1 }, (_, i) => ({
      month: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      network: 'polkadot',
    })),
  )

  const result = await warmStore({ store, queue, sources, log: (line) => lines.push(line) })
  assert.equal(result.enqueued, 0)
  assert.equal(result.considered, 0)
  assert.match(lines.join('\n'), /ceiling/)
})

test('a handler with no warm() is simply not warmed', async (t) => {
  const { store, queue } = rig(t)
  const sources = syntheticSources(undefined)
  delete sources.syn.jobs.daily.warm
  const result = await warmStore({ store, queue, sources, log: quiet })
  assert.equal(result.considered, 0)
  assert.equal(result.enqueued, 0)
  assert.deepEqual(result.jobs, [])
})

test('a warm() that throws costs its own source and nothing else', async (t) => {
  const { store, queue } = rig(t)
  const lines = []
  const sources = syntheticSources(() => {
    throw new Error('the month generator is broken')
  })
  const result = await warmStore({ store, queue, sources, log: (line) => lines.push(line) })
  assert.equal(result.enqueued, 0)
  assert.match(lines.join('\n'), /the month generator is broken/)
})

/* ------------------------------------------------------------- the whole boot sequence ---- */

test('boot: listen, then open, then warm — and the worker is started without any request', async (t) => {
  const dir = scratch(t)
  const spawned = []
  const app = createApp({
    dev: true,
    dataDir: dir,
    deferStore: true,
    ensureWorker: (options) => spawned.push(options),
    registry: none(),
  })
  t.after(() => app.close())

  // What the entry point does, in order.
  app.openStore()
  const { warmed, resumed } = await app.startBackgroundWork({
    sources: syntheticSources(() => [{ month: '2026-07', network: 'polkadot' }]),
    log: quiet,
  })

  assert.equal(warmed.enqueued, 1)
  assert.equal(resumed, true, 'the queue has runnable work after warming')
  assert.equal(spawned.length, 1, 'and the drain worker was started — nobody had to load a page')
  assert.equal(spawned[0].dir, dir, 'the worker opens its own handle on the same directory')
})

test('boot with nothing to do spawns no worker — an idle queue costs 0 MB, not 17', async (t) => {
  const dir = scratch(t)
  const spawned = []
  const app = createApp({
    dev: true,
    dataDir: dir,
    deferStore: true,
    ensureWorker: (options) => spawned.push(options),
    registry: none(),
  })
  t.after(() => app.close())

  app.openStore()
  const { warmed, resumed } = await app.startBackgroundWork({ sources: {}, log: quiet })
  assert.equal(warmed.enqueued, 0)
  assert.equal(resumed, false)
  assert.equal(spawned.length, 0)
})

function none() {
  return { resolve: () => ({ error: 'none' }), resolveJob: () => ({ error: 'none' }) }
}
