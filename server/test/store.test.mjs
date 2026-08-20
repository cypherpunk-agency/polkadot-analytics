// The store: canonical identity, idempotent facts, coverage, and surviving a reopen.
// Everything runs against a throwaway directory; nothing here touches any upstream.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, canonicalParams } from '../lib/store.mjs'

/**
 * A throwaway directory plus an `open` that tracks every store it hands out, so cleanup can
 * close them all BEFORE removing the directory — on Windows an open SQLite handle makes the
 * unlink an EBUSY, and `t.after` hooks run in registration order.
 */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-store-'))
  const opened = []
  t.after(() => {
    for (const store of opened) {
      try {
        store.close()
      } catch {
        /* already closed by the test */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir,
    open() {
      const store = openStore({ dir })
      opened.push(store)
      return store
    },
  }
}

test('canonicalParams: key order and undefined never change an identity', () => {
  assert.equal(canonicalParams({ a: 1, b: 2 }), canonicalParams({ b: 2, a: 1 }))
  assert.equal(canonicalParams({ a: 1, gone: undefined }), canonicalParams({ a: 1 }))
  assert.equal(
    canonicalParams({ outer: { z: 1, a: [{ y: 2, x: 3 }] } }),
    canonicalParams({ outer: { a: [{ x: 3, y: 2 }], z: 1 } }),
  )
  // null survives — "no value" is a value, distinct from the key being absent.
  assert.notEqual(canonicalParams({ a: null }), canonicalParams({}))
})

test('facts round-trip, and a re-put of the same segment is one row, not two', async (t) => {
  const store = scratch(t).open()

  const identity = ['orca', 'trades-window', { from: 100, to: 200 }]
  store.putFact({ source: 'orca', operation: 'trades-window', params: { to: 200, from: 100 }, segment: '2026-08-01', payload: { trades: 3 }, head: '8100000' })
  store.putFact({ source: 'orca', operation: 'trades-window', params: { from: 100, to: 200 }, segment: '2026-08-01', payload: { trades: 4 }, head: '8100001' })

  const fact = store.getFact(...identity, '2026-08-01')
  assert.equal(fact.payload.trades, 4) // the replay won
  assert.equal(fact.head, '8100001')
  assert.equal((await store.readFacts(...identity)).length, 1)
})

test('null head/codeVersion stay null — "not recorded" is not a value', async (t) => {
  const store = scratch(t).open()
  store.putFact({ source: 's', operation: 'o', params: {}, segment: 'a', payload: 0 })
  const fact = store.getFact('s', 'o', {}, 'a')
  assert.equal(fact.head, null)
  assert.equal(fact.codeVersion, null)
  assert.equal(fact.payload, 0) // and a payload that IS zero stays zero, not null
})

test('coverage counts segments without loading payloads; readFacts orders by segment', async (t) => {
  const store = scratch(t).open()

  for (const day of ['2026-08-03', '2026-08-01', '2026-08-02']) {
    store.putFact({ source: 's', operation: 'o', params: { days: 3 }, segment: day, payload: { day } })
  }
  assert.deepEqual(store.coverage('s', 'o', { days: 3 }), { segments: 3, earliest: '2026-08-01', latest: '2026-08-03' })
  assert.deepEqual(store.coverage('s', 'o', { days: 99 }), { segments: 0, earliest: null, latest: null })

  const facts = await store.readFacts('s', 'o', { days: 3 })
  assert.deepEqual(facts.map((fact) => fact.segment), ['2026-08-01', '2026-08-02', '2026-08-03'])
  assert.deepEqual(await store.listSegments('s', 'o', { days: 3 }), ['2026-08-01', '2026-08-02', '2026-08-03'])
})

test('a malformed fact is refused loudly', (t) => {
  const store = scratch(t).open()
  assert.throws(() => store.putFact({ source: 's', operation: 'o', params: {}, segment: 42, payload: {} }), /segment/)
  assert.throws(() => store.putFact({ source: 's', operation: 'o', params: {}, segment: 'a', payload: undefined }), /JSON/)
})

test('facts survive close and reopen; migrations do not re-run', async (t) => {
  const box = scratch(t)
  const first = box.open()
  first.putFact({ source: 's', operation: 'o', params: {}, segment: 'a', payload: { kept: true } })
  first.close()

  const second = box.open()
  assert.equal(second.getFact('s', 'o', {}, 'a').payload.kept, true)
  // One migration, applied once — a re-run would have failed on CREATE TABLE.
  const version = second.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version
  assert.equal(version, 1)
})

test('two concurrent draining reads do not bleed into each other', async (t) => {
  const store = scratch(t).open()

  // Both reads are large enough to yield mid-iteration (every 512 rows). With a shared cached
  // statement, the second .iterate() would rebind the first read's statement and the results
  // would silently mix — the exact concurrency the WAL design invites (HTTP thread reading
  // while another request reads too).
  store.transaction(() => {
    for (let i = 0; i < 1200; i += 1) {
      store.putFact({ source: 'a', operation: 'o', params: {}, segment: `a-${String(i).padStart(5, '0')}`, payload: 'A' })
    }
    for (let i = 0; i < 700; i += 1) {
      store.putFact({ source: 'b', operation: 'o', params: {}, segment: `b-${String(i).padStart(5, '0')}`, payload: 'B' })
    }
  })

  const [a, b, aSegments] = await Promise.all([
    store.readFacts('a', 'o', {}),
    store.readFacts('b', 'o', {}),
    store.listSegments('a', 'o', {}),
  ])
  assert.equal(a.length, 1200)
  assert.equal(b.length, 700)
  assert.equal(aSegments.length, 1200)
  assert.ok(a.every((fact) => fact.source === 'a' && fact.payload === 'A'))
  assert.ok(b.every((fact) => fact.source === 'b' && fact.payload === 'B'))
  assert.ok(aSegments.every((segment) => segment.startsWith('a-')))
})

test('a big read drains without monopolising the event loop', async (t) => {
  const store = scratch(t).open()

  store.transaction(() => {
    for (let i = 0; i < 3000; i += 1) {
      store.putFact({ source: 's', operation: 'o', params: {}, segment: `seg-${String(i).padStart(5, '0')}`, payload: i })
    }
  })

  // If readFacts yielded to the event loop at least once, a queued immediate runs before it
  // finishes; with a blocking .all() it could not.
  let interleaved = false
  setImmediate(() => {
    interleaved = true
  })
  const facts = await store.readFacts('s', 'o', {})
  assert.equal(facts.length, 3000)
  assert.equal(interleaved, true)
})
