// The identity-watch stream: /api/stream/<source>/<operation> (decision 0020).
//
// Driven through the real `handle()` with a recorder that — unlike api.test.mjs's — implements
// `write()`, because a stream is the one response in this service that is not writeHead + end.
//
// The clocks are injected (`stream: { pollMs: 10, ... }`) so a tick is milliseconds, and the
// synthetic source keeps the registry out of it: what is under test is the watch choreography —
// validation, the read-only contract, frames, heartbeat, done, the cap, and shutdown — not any
// particular handler.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../index.mjs'
import { openStore } from '../lib/store.mjs'
import { runJob } from '../lib/job-worker.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A response recorder with a write() surface and the close-event plumbing serveStream uses. */
function streamRecorder() {
  const listeners = new Map()
  const res = {
    status: null,
    headers: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      return res
    },
    write(chunk) {
      res.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      res.writableEnded = true
    },
    on(event, fn) {
      listeners.set(event, fn)
    },
    emitClose() {
      res.destroyed = true
      listeners.get('close')?.()
    },
    text: () => res.chunks.join(''),
  }
  return res
}

/** Parse SSE frames out of the recorded text: [{event, id, data}] — comments dropped. */
function frames(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim() && !block.startsWith(':') && !block.startsWith('retry:'))
    .map((block) => {
      const out = {}
      for (const line of block.split('\n')) {
        const at = line.indexOf(': ')
        if (at > 0) out[line.slice(0, at)] = line.slice(at + 2)
      }
      if (out.data !== undefined) out.data = JSON.parse(out.data)
      return out
    })
}

/** A watchable synthetic job: identities are {day}, segments land via the real job engine. */
function watchableJob() {
  return {
    summary: 'A synthetic watchable backfill. Touches nothing.',
    schema: { day: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, maxLength: 10, required: true } },
    immutable: () => true,
    nextBatch: async ({ params }) => ({
      rows: [{ segment: params.day, payload: { day: params.day }, head: 'test' }],
      cursor: undefined,
      done: true,
      doneUnits: 1,
    }),
    watch: {
      event: 'day',
      schema: { days: { type: 'list', pattern: /^\d{4}-\d{2}-\d{2}$/, maxItems: 10, required: true } },
      identities: ({ days }) => days.map((day) => ({ day })),
    },
  }
}

function rig(t, { stream, jobs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stream-'))
  const store = openStore({ dir })
  const handlers = jobs ?? { pulse: watchableJob() }
  const app = createApp({
    dev: true,
    store,
    ensureWorker: () => {},
    // No backoff, so a test grinding a job to gave-up can re-claim without a fake clock.
    queueOptions: { backoffBaseMs: 0 },
    stream: { pollMs: 10, heartbeatEvery: 2, maxMs: 60_000, maxConcurrent: 32, retryMs: 100, ...stream },
    registry: {
      resolve: () => ({ error: 'no operations here' }),
      resolveJob: (sourceId, operationId) => {
        const handler = sourceId === 'syn' ? handlers[operationId] : undefined
        return handler ? { source: { id: 'syn' }, handler } : { error: 'no job' }
      },
    },
  })
  t.after(() => {
    app.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { app, store, queue: app.queue }
}

/** Complete one synthetic identity through the real engine, so `done` means what it means. */
async function land({ store, queue }, day) {
  const job = queue.enqueue('syn', 'pulse', { day })
  const finished = await runJob(store, queue, queue.claim(job.id), { resolveHandler: () => watchableJob() })
  assert.equal(finished.state, 'done')
}

test('an already-complete identity is delivered on connect; a later one on a tick; then done', async (t) => {
  const ctx = rig(t)
  await land(ctx, '2026-01-01')

  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-01-01,2026-01-02' }, res)

  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  // The security headers ride along on the stream exactly as on every other response.
  assert.equal(res.headers['x-content-type-options'], 'nosniff')

  // The first pump ran inside handle(): the stored identity is already delivered.
  let seen = frames(res.text())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].event, 'day')
  assert.equal(seen[0].id, JSON.stringify({ day: '2026-01-01' }))
  assert.equal(seen[0].data.coverage.complete, true)
  assert.equal(seen[0].data.data[0].segment, '2026-01-01')
  assert.equal(seen[0].data.job, null)

  // The reconnect hint is the first thing on the wire — it is what makes a shutdown-severed
  // stream recover on its own, so it is asserted, not assumed.
  assert.match(res.text(), /^retry: 100\n\n/)

  // The second identity lands; a tick notices; the watch is empty and closes with `done` —
  // whose `reason` is the machine-readable field the client dispatches on. Only `complete`
  // means "stop following"; the lifetime and failure ends reuse the event with other reasons.
  await land(ctx, '2026-01-02')
  await sleep(80)
  seen = frames(res.text())
  assert.equal(seen.length, 3)
  assert.equal(seen[1].event, 'day')
  assert.equal(seen[1].data.data[0].payload.day, '2026-01-02')
  assert.equal(seen[2].event, 'done')
  assert.equal(seen[2].data.reason, 'complete')
  assert.equal(res.writableEnded, true)
})

test('a quiet watch heartbeats, so proxies do not reap an idle pipe', async (t) => {
  const ctx = rig(t) // heartbeatEvery: 2 ticks of 10ms
  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-06-01' }, res)
  await sleep(80)
  assert.match(res.text(), /\n: watching 1\n\n/)
  res.emitClose()
})

test('the watch is read-only: holding it open creates no job, ever', async (t) => {
  const ctx = rig(t)
  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-02-01' }, res)
  await sleep(60) // several ticks over an identity nothing is fetching
  assert.equal(ctx.queue.countLive('syn', 'pulse'), 0)
  assert.equal(ctx.queue.list().length, 0)
  res.emitClose()
})

test('a gave-up identity is reported as stalled and dropped, not watched forever', async (t) => {
  const ctx = rig(t)
  // Grind the identity to gave-up through the real engine: a handler that always throws, run
  // until the queue stops re-claiming it.
  const doomed = { ...watchableJob(), nextBatch: async () => { throw new Error('no') } }
  const job = ctx.queue.enqueue('syn', 'pulse', { day: '2026-03-01' })
  for (;;) {
    const claimed = ctx.queue.claim(job.id)
    if (!claimed) break
    await runJob(ctx.store, ctx.queue, claimed, { resolveHandler: () => doomed })
  }
  assert.equal(ctx.queue.get(job.id).state, 'gave-up')

  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-03-01' }, res)
  const seen = frames(res.text())
  assert.equal(seen[0].event, 'stalled')
  assert.equal(seen[0].data.job.state, 'gave-up')
  assert.equal(seen[1].event, 'done')
  assert.equal(res.writableEnded, true)
})

test('validation and refusals answer JSON, never a held-open stream', async (t) => {
  const ctx = rig(t)

  const noWatch = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/nothing?days=2026-01-01' }, noWatch)
  assert.equal(noWatch.status, 404)

  const badParam = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=not-a-day' }, badParam)
  assert.equal(badParam.status, 400)
  assert.equal(JSON.parse(badParam.text()).error.kind, 'request')

  const badShape = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn' }, badShape)
  assert.equal(badShape.status, 404)
})

test('over the cap: a flat 503, and the pipe is never opened', async (t) => {
  const ctx = rig(t, { stream: { maxConcurrent: 0 } })
  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-01-01' }, res)
  assert.equal(res.status, 503)
  assert.match(JSON.parse(res.text()).error.message, /cap/)
})

test('HEAD gets the stream headers and a clean end, not a held connection', async (t) => {
  const ctx = rig(t)
  const res = streamRecorder()
  await ctx.app.handle({ method: 'HEAD', url: '/api/stream/syn/pulse?days=2026-01-01' }, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.writableEnded, true)
  assert.equal(res.chunks.length, 0)
})

test('a client disconnect stops the ticking; shutdown ends what is still open', async (t) => {
  const ctx = rig(t)

  const gone = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-04-01' }, gone)
  gone.emitClose()

  const open = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-04-02' }, open)

  ctx.app.endStreams()
  // Shutdown ends the response with NO `done` frame, deliberately: `done` is the protocol's
  // "stop following", and a redeploy is the opposite. A severed stream is what EventSource's
  // reconnection exists for — the client waits out the `retry:` hint and re-subscribes to the
  // new instance. A farewell frame here was this change's worst reviewed finding: it read as
  // completion and permanently orphaned every mid-fill page, once per redeploy.
  assert.equal(frames(open.text()).some((f) => f.event === 'done'), false)
  assert.equal(open.writableEnded, true)

  // The disconnected one was already unregistered — shutdown neither wrote to it nor threw.
  assert.equal(frames(gone.text()).some((f) => f.event === 'done'), false)
})

test('the lifetime cap closes a watch that will not finish, saying how much was pending', async (t) => {
  const ctx = rig(t, { stream: { maxMs: 30 } })
  const res = streamRecorder()
  await ctx.app.handle({ method: 'GET', url: '/api/stream/syn/pulse?days=2026-05-01,2026-05-02' }, res)
  await sleep(100)
  const seen = frames(res.text())
  assert.equal(seen.at(-1).event, 'done')
  assert.equal(seen.at(-1).data.reason, 'lifetime')
  assert.match(seen.at(-1).data.note, /2 identities still pending/)
  assert.equal(res.writableEnded, true)
})
