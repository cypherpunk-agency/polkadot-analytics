// The client's follow choreography (src/core/follow.js), tested from the server runner the same
// way series.js is: no DOM, no browser — `EventSource` is the one global it touches and a stub
// stands in for it. What is under test is the state machine whose two failure modes are both
// silent: settling on a `done` that did not mean completion (a page orphaned mid-fill), and
// never falling back when the stream is dead (a page waiting forever on a buffering proxy).

import test from 'node:test'
import assert from 'node:assert/strict'

import { followStore } from '../../src/core/follow.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A scriptable EventSource: tests drive frames and errors by hand. */
class FakeEventSource {
  static instances = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  constructor(url) {
    this.url = url
    this.readyState = FakeEventSource.CONNECTING
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn)
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
  emit(name, data) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) })
  }
  error(readyState) {
    this.readyState = readyState
    this.onerror?.()
  }
}

function rig(t, options = {}) {
  const original = globalThis.EventSource
  globalThis.EventSource = FakeEventSource
  FakeEventSource.instances = []
  const updates = []
  const settled = []
  const polls = []
  const follow = followStore({
    source: 'syn',
    operation: 'pulse',
    query: { days: '2026-01-01' },
    event: 'day',
    poll: async () => {
      const next = polls.shift() ?? { complete: false }
      return next
    },
    onUpdate: (u) => updates.push(u),
    onSettled: (why) => settled.push(why),
    pollMs: 10,
    maxMs: 5_000,
    ...options,
  })
  t.after(() => {
    follow.stop()
    globalThis.EventSource = original
  })
  return { follow, updates, settled, polls, es: () => FakeEventSource.instances.at(-1) }
}

test('a payload event reaches onUpdate parsed; done with reason complete settles once', async (t) => {
  const { updates, settled, es } = rig(t)
  es().emit('day', { params: { day: '2026-01-01' }, coverage: { complete: true } })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].kind, 'event')
  assert.equal(updates[0].data.coverage.complete, true)

  es().emit('done', { reason: 'complete', note: 'all landed' })
  es().emit('done', { reason: 'complete', note: 'again' }) // idempotent — settle guards itself
  assert.deepEqual(settled, ['done'])
  assert.equal(es().closed, true)
})

test('done for any reason but complete downgrades to polling instead of orphaning the page', async (t) => {
  const { updates, settled, polls, es } = rig(t)
  polls.push({ complete: false }, { complete: true })

  // The server hit its lifetime cap with months still pending. This must NOT read as finished.
  es().emit('done', { reason: 'lifetime', note: 'still pending' })
  assert.equal(settled.length, 0)
  assert.equal(es().closed, true) // the stream is over; the follow is not

  await sleep(60)
  // Polling took over, delivered its answers to onUpdate, and settled on the complete one.
  assert.ok(updates.some((u) => u.kind === 'poll'))
  assert.deepEqual(settled, ['complete'])
})

test('an unparseable done frame is not completion either', async (t) => {
  const { settled, polls, es } = rig(t)
  polls.push({ complete: true })
  es().listeners.get('done')({ data: 'not json' })
  assert.equal(settled.length, 0)
  await sleep(40)
  assert.deepEqual(settled, ['complete'])
})

test('a CLOSED stream falls back to polling immediately', async (t) => {
  const { settled, polls, es } = rig(t)
  polls.push({ complete: true })
  es().error(FakeEventSource.CLOSED) // e.g. the watch cap answered 503
  await sleep(40)
  assert.deepEqual(settled, ['complete'])
})

test('repeated errors with zero frames delivered — the buffering-proxy signature — fall back; a delivering stream does not', async (t) => {
  const quiet = rig(t)
  quiet.polls.push({ complete: true })
  quiet.es().error(FakeEventSource.CONNECTING)
  quiet.es().error(FakeEventSource.CONNECTING)
  await sleep(40)
  assert.deepEqual(quiet.settled, ['complete'])

  const healthy = rig(t)
  healthy.es().emit('day', { params: { day: '2026-01-01' } }) // one frame: the pipe works
  healthy.es().error(FakeEventSource.CONNECTING) // ordinary reconnect blips, many of them
  healthy.es().error(FakeEventSource.CONNECTING)
  healthy.es().error(FakeEventSource.CONNECTING)
  await sleep(40)
  assert.equal(healthy.settled.length, 0) // still following the stream, no fallback
  assert.equal(healthy.es().closed, false)
})

test('stalled frames are surfaced, not swallowed', (t) => {
  const { updates, es } = rig(t)
  es().emit('stalled', { params: { day: '2026-01-01' }, job: { id: 7, state: 'gave-up' } })
  assert.equal(updates[0].kind, 'stalled')
  assert.equal(updates[0].data.job.state, 'gave-up')
})

test('the lifetime cap settles as timeout, and stop() settles as stopped', async (t) => {
  const capped = rig(t, { maxMs: 20 })
  await sleep(50)
  assert.deepEqual(capped.settled, ['timeout'])

  const stopped = rig(t)
  stopped.follow.stop()
  assert.deepEqual(stopped.settled, ['stopped'])
  assert.equal(stopped.es().closed, true)
})
