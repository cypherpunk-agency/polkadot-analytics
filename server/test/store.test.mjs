// The store: canonical identity, idempotent facts, coverage, and surviving a reopen.
// Everything runs against a throwaway directory; nothing here touches any upstream.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, canonicalParams, MIGRATION_COUNT } from '../lib/store.mjs'

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
  // Each migration applied once — a re-run of migration 1 would have failed on CREATE TABLE.
  // Tracked against the list rather than a literal, so adding a migration does not need this
  // number edited (and cannot silently pass with the list half-applied).
  const version = second.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version
  assert.equal(version, MIGRATION_COUNT)
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, MIGRATION_COUNT)
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

/* ══════════════════════════ migration 2: netflows-daily gained a required `network` ══════ */

// Adding a parameter to a store-backed job does not extend the old rows, it ORPHANS them —
// `{"month":"2022-01"}` and `{"month":"2022-01","network":"polkadot"}` share no segment, no
// coverage and no `done` job. 1,673 already-fetched Polkadot days went invisible when `network`
// became required, and would have been re-derived from Parity's public RPC for nothing.
//
// A migration is the only place a fact's identity may change at all, so these tests are about
// the two ways that goes wrong quietly: a rewritten params string that merely LOOKS canonical
// (a fact nothing can ever find), and a rename into an occupied key (a constraint failure which,
// inside migrate(), means the store does not open AT ALL).

const NETFLOWS = ['asset-hub', 'netflows-daily']

/** A store at schema 1 exactly, holding whatever `seed` writes — i.e. the world as it was
 *  before this migration existed. Migration 2's SQL is then run by reopening. */
function atSchemaOne(t, seed) {
  const box = scratch(t)
  const store = box.open()
  // Rewind to just after migration 1, so reopening replays only migration 2 over the seed.
  store.db.exec('DELETE FROM schema_version WHERE version > 1')
  seed(store.db)
  store.close()
  return box
}

const oldParams = (month) => `{"month":"${month}"}`

function putRaw(db, { params, segment, payload = {}, codeVersion = null }) {
  db.prepare(
    `INSERT INTO facts (source, operation, params, segment, payload, head, code_version, stored_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 1)`,
  ).run(...NETFLOWS, params, segment, JSON.stringify(payload), codeVersion)
}

function putJob(db, { params, state }) {
  db.prepare(
    `INSERT INTO jobs (source, operation, params, state, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 3, 1, 1)`,
  ).run(...NETFLOWS, params, state)
}

test('migration 2 renames orphaned netflows facts to exactly what canonicalParams produces', async (t) => {
  const box = atSchemaOne(t, (db) => {
    for (const month of ['2022-01', '2025-12', '2026-07']) {
      for (let day = 1; day <= 3; day += 1) {
        putRaw(db, { params: oldParams(month), segment: `${month}-0${day}`, payload: { day } })
      }
      putJob(db, { params: oldParams(month), state: 'done' })
    }
  })

  const store = box.open()
  assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, MIGRATION_COUNT)

  // The identity a reader actually asks for now finds all of it — no refetch.
  const coverage = store.coverage(...NETFLOWS, { month: '2025-12', network: 'polkadot' })
  assert.equal(coverage.segments, 3)
  assert.equal((await store.readFacts(...NETFLOWS, { month: '2025-12', network: 'polkadot' })).length, 3)

  // BYTE-EXACT, not merely parseable: a params string that looks right but is not what
  // canonicalParams emits is a fact nothing can ever find again.
  const written = store.db
    .prepare('SELECT DISTINCT params FROM facts WHERE source = ? AND operation = ?')
    .all(...NETFLOWS)
    .map((row) => row.params)
    .sort()
  assert.deepEqual(written, [
    canonicalParams({ month: '2022-01', network: 'polkadot' }),
    canonicalParams({ month: '2025-12', network: 'polkadot' }),
    canonicalParams({ month: '2026-07', network: 'polkadot' }),
  ])

  // The `done` job moved too — completeness is a fact about a job, not about the rows, so a
  // migration that renamed only the facts would leave every month permanently "incomplete".
  const jobs = store.db
    .prepare('SELECT params, state FROM jobs WHERE source = ? AND operation = ?')
    .all(...NETFLOWS)
  assert.equal(jobs.length, 3)
  assert.ok(jobs.every((job) => job.params.includes('"network":"polkadot"') && job.state === 'done'))
})

test('migration 2 keeps the CURRENT row when both identities hold the same segment', (t) => {
  // An instance that served this month both before and after the change holds both. Renaming
  // into an occupied primary key is a constraint failure, and inside migrate() that means the
  // store does not open at all — so the orphan is dropped, and it is the orphan and not the row
  // the current code wrote.
  const box = atSchemaOne(t, (db) => {
    putRaw(db, { params: oldParams('2026-07'), segment: '2026-07-01', payload: { stale: true }, codeVersion: 'old' })
    putRaw(db, {
      params: canonicalParams({ month: '2026-07', network: 'polkadot' }),
      segment: '2026-07-01',
      payload: { stale: false },
      codeVersion: 'asset-hub/netflows-daily@1',
    })
    // A second day exists only under the old identity and must still be carried across.
    putRaw(db, { params: oldParams('2026-07'), segment: '2026-07-02', payload: { stale: true } })
  })

  const store = box.open()
  const params = { month: '2026-07', network: 'polkadot' }
  assert.equal(store.coverage(...NETFLOWS, params).segments, 2)
  assert.equal(store.getFact(...NETFLOWS, params, '2026-07-01').payload.stale, false, 'the current row survives')
  assert.equal(store.getFact(...NETFLOWS, params, '2026-07-01').codeVersion, 'asset-hub/netflows-daily@1')
  assert.equal(store.getFact(...NETFLOWS, params, '2026-07-02').payload.stale, true, 'and the orphan-only day comes across')
})

test('migration 2 drops a LIVE orphan job rather than breaking the one-live-job index', (t) => {
  // jobs_live_identity is a partial unique index over the live states, so two live rows for one
  // identity cannot both exist — and a failed rename here would take the whole store down.
  const box = atSchemaOne(t, (db) => {
    putJob(db, { params: oldParams('2026-06'), state: 'queued' })
    putJob(db, { params: canonicalParams({ month: '2026-06', network: 'polkadot' }), state: 'queued' })
    // A `done` twin is NOT a collision: the index only covers live states, and describeIdentity
    // already takes the newest `done` by id. It must survive, both of it.
    putJob(db, { params: oldParams('2026-05'), state: 'done' })
    putJob(db, { params: canonicalParams({ month: '2026-05', network: 'polkadot' }), state: 'done' })
  })

  const store = box.open()
  const live = store.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE params = ? AND state = 'queued'")
    .get(canonicalParams({ month: '2026-06', network: 'polkadot' })).n
  assert.equal(live, 1)
  const done = store.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE params = ? AND state = 'done'")
    .get(canonicalParams({ month: '2026-05', network: 'polkadot' })).n
  assert.equal(done, 2, 'two done jobs for one identity are legal and must not be discarded')
})

test('migration 2 touches nothing outside netflows-daily, and no params shape it cannot prove', (t) => {
  const box = atSchemaOne(t, (db) => {
    // Another operation whose params happen to have a `month` — must not gain a network.
    db.prepare(
      `INSERT INTO facts (source, operation, params, segment, payload, stored_at)
       VALUES ('hydration', 'swaps-daily', '{"month":"2026-07"}', '2026-07-01', '{}', 1)`,
    ).run()
    // A netflows params shape this migration cannot prove `replace()` is safe on: more than one
    // key, therefore more than one `}` is possible in general. Left alone, deliberately.
    putRaw(db, { params: '{"extra":"x","month":"2026-07"}', segment: '2026-07-01' })
    // Already migrated — running over it must be a no-op, not a double rename.
    putRaw(db, { params: canonicalParams({ month: '2026-04', network: 'kusama' }), segment: '2026-04-01' })
  })

  const store = box.open()
  // Mapped to plain objects: node:sqlite hands back null-prototype rows, which deepEqual
  // (strict) reports as a difference even when every field matches.
  const shapes = store.db
    .prepare('SELECT source, operation, params FROM facts ORDER BY source, params')
    .all()
    .map(({ source, operation, params }) => ({ source, operation, params }))
  assert.deepEqual(shapes, [
    { source: 'asset-hub', operation: 'netflows-daily', params: '{"extra":"x","month":"2026-07"}' },
    { source: 'asset-hub', operation: 'netflows-daily', params: canonicalParams({ month: '2026-04', network: 'kusama' }) },
    { source: 'hydration', operation: 'swaps-daily', params: '{"month":"2026-07"}' },
  ])
})

test('migration 2 run a SECOND time changes nothing', (t) => {
  const box = atSchemaOne(t, (db) => {
    putRaw(db, { params: oldParams('2024-03'), segment: '2024-03-01', payload: { n: 1 } })
    putJob(db, { params: oldParams('2024-03'), state: 'done' })
  })

  const once = box.open()
  const after = once.db.prepare('SELECT params, segment, payload FROM facts').all()
  // Rewind the bookkeeping and replay: the guard is in the SQL (`params NOT LIKE '%network%'`),
  // not only in schema_version, because a store half-converted by hand is a real state.
  once.db.exec('DELETE FROM schema_version WHERE version > 1')
  once.close()

  const twice = box.open()
  assert.deepEqual(twice.db.prepare('SELECT params, segment, payload FROM facts').all(), after)
  assert.equal(
    twice.db.prepare('SELECT params FROM jobs').get().params,
    canonicalParams({ month: '2024-03', network: 'polkadot' }),
  )
})
