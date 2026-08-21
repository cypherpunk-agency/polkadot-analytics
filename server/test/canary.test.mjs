// The durability canaries — server/lib/canary.mjs, and `hydration/swaps-daily`'s orca floor.
//
// What is being defended here is the whole DR position: the store has no backup because it is a
// CACHE of public upstreams, and that is true only while every stored segment can still be
// fetched again. orca publishes a floor, and if it moves forward past days we hold, those days
// stop being re-derivable and the volume quietly becomes their only copy. Nothing else in the
// system would notice — every request still answers and every chart still draws.
//
// So the tests are about the two ways the canary itself could fail quietly:
//
//   1. FALSE GREEN. A canary that reports `ok` when it could not check, or when the state it
//      returned was not one this code understands. `unknown` is a real answer and is never
//      collapsed into `ok`.
//   2. FALSE ALARM ON DAY ONE. The healthy store deliberately holds pre-floor days — 2025-01-01
//      to 2025-01-24 as `coverage: 'before-source-floor'` — so counting "stored days below the
//      floor" fires immediately and is then ignored for ever after. The discriminator has to be
//      whether the day holds INDEXED CONTENT.
//
// Nothing here touches an upstream: `connect` is injected, and the store is a temp file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../lib/store.mjs'
import { runCanaries, CANARY_STATES } from '../lib/canary.mjs'
import { createApp } from '../index.mjs'
import hydration from '../sources/hydration.mjs'

const SWAPS = ['hydration', 'swaps-daily']
const handler = hydration.jobs['swaps-daily']

function scratchStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-canary-'))
  const store = openStore({ dir })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, dir }
}

/** The floor as `connect()` reports it: para block height plus the block's own timestamp. */
const floorAt = (block, timestamp) => async () => ({
  head: { height: block + 1_000_000, timestamp: '2026-08-21T00:00:00.000Z' },
  floor: { paraBlockHeight: block, block: { timestamp } },
})

/** One stored day, under the month identity the real handler uses. */
function putDay(store, day, coverage) {
  store.putFact({
    source: SWAPS[0],
    operation: SWAPS[1],
    params: { month: day.slice(0, 7) },
    segment: day,
    payload: { date: day, coverage, trades: coverage === 'before-source-floor' ? null : 1234 },
  })
}

/* ------------------------------------------------- the floor as it actually stands today ---- */

// Read live off orca-prod-pool-01 on 2026-08-21 and carried on all 24 `before-source-floor` days
// of this store's own 2025-01. The canary does not hardcode it — this test does, so that the
// arithmetic is exercised against the real shape rather than a rounded stand-in.
const FLOOR_BLOCK = 6_837_788
const FLOOR_AT = '2025-01-25T05:58:36.000Z'

test('the healthy store: pre-floor days are below the floor and are NOT an alarm', async (t) => {
  const { store } = scratchStore(t)

  // Exactly what a real 2025-01 backfill puts in the store: 24 days that were always below the
  // floor and hold nothing, the straddling day, then indexed days above it.
  for (let day = 1; day <= 24; day += 1) putDay(store, `2025-01-${String(day).padStart(2, '0')}`, 'before-source-floor')
  putDay(store, '2025-01-25', 'partial-source-floor')
  for (const day of ['2025-01-26', '2025-01-27']) putDay(store, day, 'indexed')

  const report = await handler.canary({ store, sourceId: SWAPS[0], operationId: SWAPS[1], connect: floorAt(FLOOR_BLOCK, FLOOR_AT) })

  assert.equal(report.state, 'ok')
  assert.equal(report.detail.floorDay, '2025-01-25')
  assert.equal(report.detail.storedDaysBelowFloor, 24, 'the pre-floor days ARE below it — that is not the question')
  assert.equal(report.detail.daysNoLongerDerivable, 0, '…and none of them holds anything that could be lost')
  // The straddling day is excluded because the comparison is strict and its own date IS the
  // floor's date. It is still re-derivable: orca has the part of it that is above the floor.
  assert.ok(report.message.includes('still a cache'))
})

test('the floor moving past indexed days is `at-risk`, and the message states the CONSEQUENCE', async (t) => {
  const { store } = scratchStore(t)

  for (let day = 1; day <= 24; day += 1) putDay(store, `2025-01-${String(day).padStart(2, '0')}`, 'before-source-floor')
  putDay(store, '2025-01-25', 'partial-source-floor')
  for (const day of ['2025-01-26', '2025-01-27', '2025-01-28']) putDay(store, day, 'indexed')
  putDay(store, '2025-02-01', 'indexed')

  // orca has pruned to a one-year retention: its first routed trade is now in 2025-01-28.
  const report = await handler.canary({
    store,
    sourceId: SWAPS[0],
    operationId: SWAPS[1],
    connect: floorAt(7_500_000, '2025-01-28T09:00:00.000Z'),
  })

  assert.equal(report.state, 'at-risk')
  // 24 pre-floor + the straddling day + two indexed days are now below the floor; only the three
  // that hold something are at risk, and the straddling one counts because the floor has moved
  // out of it.
  assert.equal(report.detail.storedDaysBelowFloor, 27)
  assert.equal(report.detail.daysNoLongerDerivable, 3)
  assert.equal(report.detail.earliestAtRisk, '2025-01-25')
  assert.equal(report.detail.latestAtRisk, '2025-01-27')

  // A reading is not actionable and an alert full of readings is an alert people scroll past.
  assert.ok(report.message.includes('CAN NO LONGER BE RE-DERIVED'), report.message)
  assert.ok(report.message.includes('only copy'), report.message)
  assert.ok(report.message.includes('2025-01-25'), 'name the days, so the loss can be sized')
})

test('an empty store is `ok` without reading a single payload', async (t) => {
  const { store } = scratchStore(t)
  const report = await handler.canary({ store, sourceId: SWAPS[0], operationId: SWAPS[1], connect: floorAt(FLOOR_BLOCK, FLOOR_AT) })
  assert.equal(report.state, 'ok')
  assert.equal(report.detail.storedDaysBelowFloor, 0)
})

/* ---------------------------------------------------------- never a false green ---- */

test('an upstream that will not say where its floor is becomes `unknown`, never `ok`', async (t) => {
  const { store } = scratchStore(t)
  putDay(store, '2025-01-26', 'indexed')

  // orca answered, but with something no floor can be read out of.
  await assert.rejects(
    () => handler.canary({ store, sourceId: SWAPS[0], operationId: SWAPS[1], connect: floorAt(1, 'not-a-timestamp') }),
    /not a timestamp/,
  )

  // …and the throw becomes a report rather than vanishing, which is what runCanaries is for.
  const sources = {
    hydration: {
      id: 'hydration',
      jobs: {
        'swaps-daily': {
          canary: () => {
            throw new Error('no orca host answered')
          },
        },
      },
    },
  }
  const result = await runCanaries({ store, sources, log: () => {} })
  assert.equal(result.ok, false, 'could-not-check is not fine')
  assert.equal(result.reports[0].state, 'unknown')
  assert.ok(result.reports[0].message.includes('no orca host answered'))
  assert.ok(result.reports[0].message.includes('UNKNOWN, not fine'))
})

test('a malformed report degrades to `unknown` instead of publishing as a confident green', async (t) => {
  const { store } = scratchStore(t)
  const sources = {
    syn: {
      id: 'syn',
      jobs: {
        // A state this file does not know, and no message.
        a: { canary: () => ({ state: 'fine' }) },
        // A known state, but nothing said — an alert with no sentence in it is not an alert.
        b: { canary: () => ({ state: 'ok', message: '   ' }) },
        // Nothing to report is allowed, and produces no row at all.
        c: { canary: () => null },
      },
    },
  }
  const result = await runCanaries({ store, sources, log: () => {} })
  assert.equal(result.reports.length, 2)
  assert.deepEqual(result.reports.map((entry) => entry.state), ['unknown', 'unknown'])
  assert.equal(result.ok, false)
  for (const entry of result.reports) assert.ok(CANARY_STATES.includes(entry.state))
})

test('nothing to check is null, and null is not true', async (t) => {
  const { store } = scratchStore(t)
  const result = await runCanaries({ store, sources: {}, log: () => {} })
  assert.equal(result.ok, null)
  assert.deepEqual(result.reports, [])

  // No store at all — a container with no volume. Same rule.
  assert.equal((await runCanaries({ store: null })).ok, null)
})

/* ---------------------------------------------------------------- where it surfaces ---- */

test('/api/health publishes the canaries beside `store`, and never computes them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-canary-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const app = createApp({
    dev: true,
    dataDir: dir,
    ensureWorker: () => {},
    registry: { resolve: () => ({ error: 'none' }), resolveJob: () => ({}) },
  })
  t.after(() => app.close())

  // Before any background work has run. `/api/health` must answer immediately, with no upstream
  // call of its own, and must not claim everything is fine merely because nothing has looked.
  const before = await get(app, '/api/health')
  assert.equal(before.status, 200)
  assert.equal(before.body.ok, true, 'the app is wired; a durability warning is not a liveness failure')
  assert.deepEqual(before.body.store, { available: true }, 'infra greps this shape — it must stay flat')
  assert.equal(before.body.canaries.ok, null)
  assert.equal(before.body.canaries.checkedAt, null)

  // Now let the background pass run, against a synthetic handler rather than orca.
  const sources = {
    syn: {
      id: 'syn',
      jobs: {
        floor: {
          canary: () => ({ subject: 'a floor', state: 'at-risk', message: 'the floor moved past 3 stored days', detail: { n: 3 } }),
        },
      },
    },
  }
  await app.startBackgroundWork({ pollMs: 0, sources, log: () => {} })

  const after = await get(app, '/api/health')
  assert.equal(after.body.ok, true, 'an at-risk canary must NOT take the service down')
  assert.equal(after.body.canaries.ok, false, '…but it must be one field an alert can read')
  assert.equal(typeof after.body.canaries.checkedAt, 'number')
  assert.equal(after.body.canaries.reports[0].source, 'syn')
  assert.equal(after.body.canaries.reports[0].state, 'at-risk')
  assert.ok(after.body.canaries.reports[0].message.includes('3 stored days'))
})

/** Drive the real routing without binding a port, the way api.test.mjs does. */
async function get(app, path) {
  const chunks = []
  let status = 0
  const res = {
    writeHead(code) {
      status = code
      return res
    },
    end(body) {
      if (body !== undefined) chunks.push(body)
    },
  }
  await app.handle({ method: 'GET', url: path }, res)
  const text = chunks.map((chunk) => (typeof chunk === 'string' ? chunk : String(chunk))).join('')
  return { status, body: text ? JSON.parse(text) : null }
}
