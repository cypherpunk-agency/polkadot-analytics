// The DOT whale cohort's series: /api/asset-hub/whales-series and the `whales-daily` job behind
// it (decisions 0021 + 0012 + 0020).
//
// Drives the REAL registry — the real operation, the real job handler, the real settle predicate,
// the real committed cohort — against a throwaway store. No upstream is ever touched: job
// creation is only a row, the worker is a spy, and where a month needs to BE stored the test runs
// the job engine with a synthetic handler that emits fake days for the real identity.
//
// What must hold, because the page is built on it:
//
//   · The aggregate response carries DAY HEADERS ONLY. The per-account detail is ~990 rows a day;
//     fifty-five months of it in one response is tens of megabytes, which is not a slow page, it
//     is an outage. This is asserted as an absence, because an absence is what regresses quietly.
//   · `null` is not `0`. A day whose header cannot be read draws as a gap; a zero would draw as
//     "the whales held nothing", which is a completely different claim about the chain.
//   · The arithmetic — sum, both legs, `nonzero`, `top10Planck` — is exact planck BigInt, because
//     the first row of the cohort is past 2^53 planck on its own.
//   · A month that can never settle is never watched, and the job's name never collides with the
//     operation's (a `jobs` entry WINS at /api/<source>/<name>).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../index.mjs'
import { openStore } from '../lib/store.mjs'
import { runJob } from '../lib/job-worker.mjs'
import { MAX_LIVE_JOBS_PER_OPERATION } from '../lib/demand.mjs'
import assetHub, { whalesMonthIsSettled, whaleCohort, summariseWhaleDay } from '../sources/asset-hub.mjs'

/** The one cohort that exists, read from the committed file rather than typed here — the file is
 *  the identity, and a literal that drifted from it would test a cohort nobody can ask for. */
const COHORT = whaleCohort().id

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

async function get(app, url) {
  const res = recorder()
  await app.handle({ method: 'GET', url }, res)
  return { status: res.status, headers: res.headers, json: () => JSON.parse(res.body) }
}

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-whales-'))
  const store = openStore({ dir })
  const spawns = []
  const app = createApp({ dev: true, store, ensureWorker: (arg) => spawns.push(arg) })
  t.after(() => {
    app.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { app, store, queue: app.queue, spawns }
}

/** Every settled month, re-derived through the real (exported) predicate so the test does not
 *  hardcode a list that grows every month. */
function settledMonths() {
  const out = []
  const thisYear = new Date().getUTCFullYear()
  for (let year = 2021; year <= thisYear; year += 1) {
    for (let index = 1; index <= 12; index += 1) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (whalesMonthIsSettled({ month, cohort: COHORT })) out.push(month)
    }
  }
  return out
}

function daysOf(month) {
  const [year, index] = month.split('-').map(Number)
  const days = []
  const end = index === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index, 1)
  for (let at = Date.UTC(year, index - 1, 1); at < end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10))
  }
  return days
}

/** A stored day, shaped exactly as `summariseWhaleDay` shapes one — including the per-account
 *  detail, so the test can assert that the aggregate endpoint does NOT ship it. */
const fakeDay = (date, over = {}) => ({
  date,
  cohort: COHORT,
  network: 'polkadot',
  token: 'DOT',
  decimals: 10,
  accounts: whaleCohort().accounts.length,
  relay: { block: 1, at: `${date}T23:59:54.000Z` },
  assetHub: { block: 2, at: `${date}T23:59:48.000Z` },
  aggregate: { sumPlanck: '30', relayPlanck: '10', ahPlanck: '20', nonzero: 2, top10Planck: '30', top: 10 },
  holders: { relay: [[0, '10', '0']], assetHub: [[1, '20', '0']] },
  ...over,
})

/** Mark one REAL whales identity `done`, via the real job engine and a synthetic handler. The
 *  identity is real; only the fetch is fake. */
async function storeMonth({ store, queue }, month, make = fakeDay) {
  const days = daysOf(month)
  const job = queue.enqueue('asset-hub', 'whales-daily', { month, cohort: COHORT })
  const handler = {
    immutable: () => true,
    nextBatch: async () => ({
      rows: days.map((date) => ({ segment: date, payload: make(date), head: 'test' })),
      cursor: undefined,
      done: true,
      doneUnits: days.length,
      totalUnits: days.length,
    }),
  }
  const finished = await runJob(store, queue, queue.claim(job.id), { resolveHandler: () => handler })
  assert.equal(finished.state, 'done')
}

/* ------------------------------------------------------------------ the request contract ---- */

test('the schema is enforced: a missing or unknown cohort is a 400, not a guess', async (t) => {
  const { app } = rig(t)

  const missing = await get(app, '/api/asset-hub/whales-series')
  assert.equal(missing.status, 400)
  assert.equal(missing.json().error.kind, 'request')

  // A plausible-looking cohort id that does not exist. Accepting it would answer for a set of
  // accounts nobody committed.
  const unknown = await get(app, '/api/asset-hub/whales-series?cohort=2025-01-01')
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json().error.kind, 'request')
})

test('an empty store answers every settled month, minting at most the cap in jobs', async (t) => {
  const { app, queue } = rig(t)
  const months = settledMonths()

  const answer = await get(app, `/api/asset-hub/whales-series?cohort=${COHORT}`)
  assert.equal(answer.status, 200)
  // Partial → no-store. A reader polling for fill-in progress handed their own browser cache is
  // a chart frozen at "3 months missing" for the length of the TTL.
  assert.equal(answer.headers['cache-control'], 'no-store')
  assert.equal(answer.headers['x-store'], 'partial')

  const body = answer.json()
  assert.equal(body.source, 'asset-hub')
  assert.equal(body.operation, 'whales-series')
  assert.equal(body.data.cohort, COHORT)
  assert.equal(body.data.network, 'polkadot')
  assert.equal(body.data.token, 'DOT')
  assert.equal(body.data.decimals, 10)
  assert.equal(body.data.accounts, whaleCohort().accounts.length)

  assert.equal(body.data.months.length, months.length)
  assert.equal(body.data.months[0].month, '2022-01')
  assert.equal(body.data.months.at(-1).month, months.at(-1))
  assert.equal(body.data.coverage.complete, false)
  assert.equal(body.data.coverage.incomplete, months.length)
  // Where to subscribe for the rest, published by the server rather than derived by the page.
  assert.equal(body.data.stream, '/api/stream/asset-hub/whales-daily')

  // THE BOUND. One aggregate GET = at most MAX_LIVE_JOBS_PER_OPERATION jobs, exactly as if the
  // months had been fetched one request at a time.
  assert.equal(queue.countLive('asset-hub', 'whales-daily'), MAX_LIVE_JOBS_PER_OPERATION)
  const withJob = body.data.months.filter((m) => m.job !== null)
  assert.equal(withJob.length, MAX_LIVE_JOBS_PER_OPERATION)
  assert.match(body.data.months.find((m) => m.job === null).coverage.note, /queue is busy/)
})

/* --------------------------------------------------------------- aggregates, never detail ---- */

test('a stored month comes back as day headers only — the per-account detail never ships', async (t) => {
  const { app, store, queue } = rig(t)
  await storeMonth({ store, queue }, '2022-01')

  const body = (await get(app, `/api/asset-hub/whales-series?cohort=${COHORT}`)).json()
  const january = body.data.months.find((m) => m.month === '2022-01')
  assert.equal(january.coverage.complete, true)
  assert.equal(january.job, null)
  assert.equal(january.days.length, 31)

  assert.deepEqual(january.days[0], {
    day: '2022-01-01',
    relayBlock: 1,
    assetHubBlock: 2,
    sumPlanck: '30',
    relayPlanck: '10',
    ahPlanck: '20',
    nonzero: 2,
    top10Planck: '30',
  })

  // The absence, asserted rather than assumed. `holders` is in the STORE for this month — the
  // single-month endpoint answers it — and must not be anywhere in this response.
  // (The prose notes do say "holders" — the accounts are DOT holders. It is the months that must
  //  not carry the detail.)
  const text = JSON.stringify(body.data.months)
  assert.equal(text.includes('holders'), false)
  assert.equal(text.includes('"10"'), true) // the header's planck strings ARE there
  for (const day of january.days) {
    assert.equal(Object.prototype.hasOwnProperty.call(day, 'holders'), false)
    assert.equal(Object.keys(day).length, 8)
  }

  // The detail IS still reachable, one month at a time, through the job's own URL.
  const single = (await get(app, `/api/asset-hub/whales-daily?month=2022-01&cohort=${COHORT}`)).json()
  assert.equal(single.data.length, 31)
  assert.deepEqual(single.data[0].payload.holders, { relay: [[0, '10', '0']], assetHub: [[1, '20', '0']] })
})

test('a fully stored series is complete and cacheable', async (t) => {
  const { app, store, queue } = rig(t)
  for (const month of settledMonths()) await storeMonth({ store, queue }, month)

  const answer = await get(app, `/api/asset-hub/whales-series?cohort=${COHORT}`)
  assert.equal(answer.headers['cache-control'], 'public, max-age=300')
  assert.equal(answer.headers['x-store'], 'complete')
  const body = answer.json()
  assert.equal(body.data.months[0].month, '2022-01')
  assert.equal(body.data.coverage.complete, true)
  assert.equal(body.data.coverage.incomplete, 0)
  assert.equal(body.data.stream, null)
  // The seed's provenance travels with the numbers, because the page is required to state it.
  // Asserted against the cohort file rather than a literal: a re-seed is a new pinned block, and
  // a hardcoded height here failed the first time one happened.
  assert.equal(body.data.seed.block, whaleCohort().seedBlock)
  assert.match(body.data.notes.join(' '), /survivorship|invisible here by construction/)
})

test('a day header keeps `null` apart from `0`', async (t) => {
  const { app, store, queue } = rig(t)
  // A fact written by an older codeVersion, with no aggregate header at all. It must read as
  // "we cannot summarise this day" — a gap — and never as a day the whales held nothing.
  await storeMonth({ store, queue }, '2022-01', (date) => {
    const day = fakeDay(date)
    delete day.aggregate
    return day
  })

  const body = (await get(app, `/api/asset-hub/whales-series?cohort=${COHORT}`)).json()
  const first = body.data.months.find((m) => m.month === '2022-01').days[0]
  assert.equal(first.day, '2022-01-01')
  assert.equal(first.sumPlanck, null)
  assert.equal(first.relayPlanck, null)
  assert.equal(first.ahPlanck, null)
  assert.equal(first.nonzero, null)
  assert.equal(first.top10Planck, null)
})

/* ------------------------------------------------------------------------ the arithmetic ---- */

/** An 80-byte SCALE `AccountInfo`: nonce/consumers/providers/sufficients (4 × u32), then free,
 *  reserved, frozen and flags as little-endian u128s. */
function accountInfo(free, reserved) {
  const u128 = (value) => {
    let v = BigInt(value)
    let out = ''
    for (let i = 0; i < 16; i += 1) {
      out += (v & 0xffn).toString(16).padStart(2, '0')
      v >>= 8n
    }
    return out
  }
  return '0x' + '00000000'.repeat(4) + u128(free) + u128(reserved) + u128(0) + u128(0)
}

test('the day arithmetic: exact planck, both legs, nonzero, and the top ten', () => {
  const cohort = whaleCohort()
  const frame = (height) => ({ closeHeight: height, closeAt: Date.parse('2026-07-31T23:59:54.000Z') })

  // Twelve accounts hold something on Asset Hub, one of them also on the relay. Every amount is
  // past 2^53 planck, which is the whole reason these are BigInt and strings.
  const big = 1_000_000_000_000_000_000n
  const relay = new Map()
  const ah = new Map()
  for (let i = 0; i < 12; i += 1) ah.set(cohort.keys[i], accountInfo(big + BigInt(i) * 10n ** 12n, 0))
  relay.set(cohort.keys[0], accountInfo(0, 500n * 10n ** 10n))

  // Two accounts that must NOT be counted: one present but holding nothing (an account that
  // exists and is empty), one absent entirely. Both are zero — the day is refused outright if a
  // chain's close block is unreadable, so "unreadable" never reaches this function.
  ah.set(cohort.keys[900], accountInfo(0, 0))

  const day = summariseWhaleDay({
    cohort,
    date: '2026-07-31',
    relayFrame: frame(32355844),
    ahFrame: frame(18908726),
    relayValues: relay,
    ahValues: ah,
  })

  const ahTotal = Array.from({ length: 12 }, (_, i) => big + BigInt(i) * 10n ** 12n).reduce((a, b) => a + b, 0n)
  const relayTotal = 500n * 10n ** 10n
  assert.equal(day.aggregate.ahPlanck, String(ahTotal))
  assert.equal(day.aggregate.relayPlanck, String(relayTotal))
  assert.equal(day.aggregate.sumPlanck, String(ahTotal + relayTotal))

  // Twelve accounts held something; the empty one and the 977 absent ones did not.
  assert.equal(day.aggregate.nonzero, 12)

  // The top ten are by COMBINED holding across both chains, so account 0 — the smallest Asset Hub
  // balance of the twelve — is carried into the top ten by its relay leg only if the sum says so.
  const combined = Array.from({ length: 12 }, (_, i) => big + BigInt(i) * 10n ** 12n + (i === 0 ? relayTotal : 0n))
  const top10 = combined.sort((a, b) => (a < b ? 1 : -1)).slice(0, 10).reduce((a, b) => a + b, 0n)
  assert.equal(day.aggregate.top10Planck, String(top10))
  assert.equal(day.aggregate.top, 10)

  // Sparse: an account holding nothing is omitted rather than written as a zero row.
  assert.equal(day.holders.assetHub.length, 12)
  assert.equal(day.holders.relay.length, 1)
  assert.deepEqual(day.holders.relay[0], [0, '0', String(relayTotal)])
  assert.equal(day.holders.assetHub.some(([index]) => index === 900), false)

  // The provenance every row carries, so a payload can never be read as the wrong chain's.
  assert.equal(day.cohort, cohort.id)
  assert.equal(day.token, 'DOT')
  assert.equal(day.decimals, 10)
  assert.equal(day.accounts, cohort.accounts.length)
  assert.equal(day.relay.block, 32355844)
  assert.equal(day.assetHub.block, 18908726)
})

/* ------------------------------------------------------------- the registry's own contract ---- */

test('the watch refuses identities that can never land, so they cannot pin a watch slot', () => {
  const watch = assetHub.jobs['whales-daily'].watch
  const now = new Date()
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const identities = watch.identities({ cohort: COHORT, months: ['2021-12', '2022-01', current, '2999-01'] })
  assert.deepEqual(identities, [{ month: '2022-01', cohort: COHORT }])

  // A cohort that does not exist can never land either, however well-formed its months are.
  assert.deepEqual(watch.identities({ cohort: '1999-01-01', months: ['2022-01'] }), [])
})

test('the job and the operation are different names, and warming asks for what the reader asks for', () => {
  // A `jobs` entry WINS over an `operations` entry of the same name (server/index.mjs), so a
  // collision would take the URL away from the operation and the page would draw nothing while
  // answering 200. `npm run check` fails on this too; it is asserted here so the reason survives.
  const jobs = Object.keys(assetHub.jobs)
  const ops = Object.keys(assetHub.operations)
  assert.ok(jobs.includes('whales-daily'))
  assert.ok(ops.includes('whales-series'))
  assert.equal(jobs.some((name) => ops.includes(name)), false)

  // Warming and reading must ask for the SAME identities. One key of difference is a second
  // identity: the backfill runs twice, both copies are correct, and the page still starts empty.
  // (The mirror of warm.test.mjs's netflows assertion, scoped to this handler rather than to
  // everything `asset-hub` warms — the source now warms two jobs.)
  const handler = assetHub.jobs['whales-daily']
  assert.equal(typeof handler.warm, 'function', 'the boot warm-up is inert without this')
  const warmed = handler.warm()
  assert.deepEqual(
    warmed,
    settledMonths().map((month) => ({ month, cohort: COHORT })),
  )

  // Every entry is settled, every entry names the one cohort that exists, and the current month
  // is therefore absent — nothing here has to know the settling rule, which is the point of
  // deriving both lists from one predicate.
  const now = Date.now()
  const currentMonth = new Date(now).toISOString().slice(0, 7)
  assert.ok(warmed.length > 0)
  for (const identity of warmed) {
    assert.equal(whalesMonthIsSettled(identity, now), true, `${JSON.stringify(identity)} must be immutable to be warmed`)
    assert.equal(identity.cohort, COHORT)
    assert.notEqual(identity.month, currentMonth)
  }
  assert.equal(warmed[0].month, '2022-01')
})

test('without a store the endpoint answers 503, and mode B stays unaffected', async (t) => {
  const app = createApp({ dev: true, store: null, ensureWorker: () => {}, deferStore: true })
  t.after(() => app.close())
  const answer = await get(app, `/api/asset-hub/whales-series?cohort=${COHORT}`)
  assert.equal(answer.status, 503)
  assert.match(answer.json().error.message, /persistent store/)
})
