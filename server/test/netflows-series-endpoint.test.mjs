// The aggregate store-read endpoint: /api/asset-hub/netflows-series (decision 0020).
//
// Drives the REAL registry — the real `netflows-series` operation, the real `netflows-daily`
// handler, the real settle predicate — against a throwaway store. No upstream is ever touched:
// job creation is only a row, the worker is a spy, and where a month needs to BE stored the
// test runs the job engine with a synthetic handler that emits fake days for the real identity.
//
// What must hold, because the page is built on it:
//
//   · One GET behaves exactly as N per-month GETs did — same bounds, same envelopes. In
//     particular the live-jobs cap: an aggregate over an empty store may mint at most
//     MAX_LIVE_JOBS_PER_OPERATION jobs, not one per missing month.
//   · The per-month entry is envelope-compatible: `{data, coverage, job}` with the same
//     meanings, so the client's series shaper and the stream's frames are one decoding path.
//   · Completeness is the cache policy: partial → no-store, complete → max-age. A cached
//     partial is a reader stranded on a chart that never gains its months.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../index.mjs'
import { openStore } from '../lib/store.mjs'
import { runJob } from '../lib/job-worker.mjs'
import { MAX_LIVE_JOBS_PER_OPERATION } from '../lib/demand.mjs'
import assetHub, { netflowsMonthIsSettled } from '../sources/asset-hub.mjs'

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

/** An app over a throwaway store and the REAL registry, with the worker spy of api.test.mjs. */
function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-series-'))
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

/** Every settled month for a network, re-derived here through the real (exported) predicate so
 *  the test does not hardcode a list that grows every month. */
function settledMonths(network) {
  const out = []
  const thisYear = new Date().getUTCFullYear()
  for (let year = 2021; year <= thisYear; year += 1) {
    for (let index = 1; index <= 12; index += 1) {
      const month = `${year}-${String(index).padStart(2, '0')}`
      if (netflowsMonthIsSettled({ month, network })) out.push(month)
    }
  }
  return out
}

/** All ISO days of a month. */
function daysOf(month) {
  const [year, index] = month.split('-').map(Number)
  const days = []
  const end = index === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index, 1)
  for (let at = Date.UTC(year, index - 1, 1); at < end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10))
  }
  return days
}

/** Mark one REAL netflows identity `done`, via the real job engine and a synthetic handler that
 *  emits one fake payload per day of the month. The identity is real; only the fetch is fake. */
async function storeMonth({ store, queue }, month, network) {
  const days = daysOf(month)
  const job = queue.enqueue('asset-hub', 'netflows-daily', { month, network })
  const handler = {
    immutable: () => true,
    nextBatch: async () => ({
      rows: days.map((date) => ({
        segment: date,
        payload: { date, network, totals: { relay: '0', assetHub: '0', total: '0' }, chains: [], dust: { chains: 0 } },
        head: 'test',
      })),
      cursor: undefined,
      done: true,
      doneUnits: days.length,
      totalUnits: days.length,
    }),
  }
  const finished = await runJob(store, queue, queue.claim(job.id), { resolveHandler: () => handler })
  assert.equal(finished.state, 'done')
}

test('an empty store answers every settled month, minting at most the cap in jobs', async (t) => {
  const { app, queue } = rig(t)
  const months = settledMonths('polkadot')

  const answer = await get(app, '/api/asset-hub/netflows-series?network=polkadot')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['cache-control'], 'no-store')
  assert.equal(answer.headers['x-store'], 'partial')

  const body = answer.json()
  assert.equal(body.source, 'asset-hub')
  assert.equal(body.operation, 'netflows-series')
  assert.equal(body.data.network, 'polkadot')
  assert.equal(body.data.token, 'DOT')
  assert.equal(body.data.decimals, 10)

  // Every settled month is in the answer — the server's clock decides the list, and the first
  // entry is the network's floor.
  assert.equal(body.data.months.length, months.length)
  assert.equal(body.data.months[0].month, '2022-01')
  assert.equal(body.data.months.at(-1).month, months.at(-1))
  assert.equal(body.data.coverage.complete, false)
  assert.equal(body.data.coverage.incomplete, months.length)
  assert.equal(body.data.stream, '/api/stream/asset-hub/netflows-daily')

  // THE BOUND. One aggregate GET = at most MAX_LIVE_JOBS_PER_OPERATION jobs, exactly as if the
  // months had been fetched one request at a time. The months over the cap answer with a null
  // job and the busy note, not with silence.
  assert.equal(queue.countLive('asset-hub', 'netflows-daily'), MAX_LIVE_JOBS_PER_OPERATION)
  const withJob = body.data.months.filter((m) => m.job !== null)
  assert.equal(withJob.length, MAX_LIVE_JOBS_PER_OPERATION)
  const capped = body.data.months.find((m) => m.job === null)
  assert.match(capped.coverage.note, /queue is busy/)
})

test('a stored month comes back complete, envelope-compatible with the per-month endpoint', async (t) => {
  const { app, store, queue } = rig(t)
  await storeMonth({ store, queue }, '2022-01', 'polkadot')

  const body = (await get(app, '/api/asset-hub/netflows-series?network=polkadot')).json()
  const january = body.data.months.find((m) => m.month === '2022-01')
  assert.equal(january.coverage.complete, true)
  assert.equal(january.job, null)
  assert.equal(january.data.length, 31)
  assert.equal(january.data[0].segment, '2022-01-01')
  assert.equal(january.data[0].payload.date, '2022-01-01')

  // The same identity through the single-month endpoint answers the same facts — one decoding
  // path is a claim about bytes, so compare the bytes that matter.
  const single = (await get(app, '/api/asset-hub/netflows-daily?month=2022-01&network=polkadot')).json()
  assert.deepEqual(january.data, single.data)
  assert.deepEqual(january.coverage, single.coverage)
})

test('a fully stored series is complete and cacheable', async (t) => {
  const { app, store, queue } = rig(t)
  // Kusama's floor is earlier (2021-07) but the list is per network; store every settled month.
  for (const month of settledMonths('kusama')) await storeMonth({ store, queue }, month, 'kusama')

  const answer = await get(app, '/api/asset-hub/netflows-series?network=kusama')
  assert.equal(answer.headers['cache-control'], 'public, max-age=300')
  assert.equal(answer.headers['x-store'], 'complete')
  const body = answer.json()
  assert.equal(body.data.months[0].month, '2021-07')
  assert.equal(body.data.coverage.complete, true)
  assert.equal(body.data.coverage.incomplete, 0)
  assert.equal(body.data.stream, null)
  assert.equal(body.data.token, 'KSM')
  assert.equal(body.data.decimals, 12)
})

test('the watch refuses identities that can never land, so they cannot pin a watch slot', () => {
  const watch = assetHub.jobs['netflows-daily'].watch
  // A pre-floor month, the current month, and a future month all validate against the PATTERN —
  // and none of them can ever complete, so `identities` must drop them rather than watch them
  // for the stream's whole lifetime. An all-filtered list closes the stream immediately.
  const now = new Date()
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const identities = watch.identities({ network: 'polkadot', months: ['2021-06', '2022-01', current, '2999-01'] })
  assert.deepEqual(identities, [{ month: '2022-01', network: 'polkadot' }])
})

test('the schema is enforced: an unknown network is a 400, not a guess', async (t) => {
  const { app } = rig(t)
  const answer = await get(app, '/api/asset-hub/netflows-series?network=westend')
  assert.equal(answer.status, 400)
  assert.equal(answer.json().error.kind, 'request')
})

test('without a store the endpoint answers 503, and mode B stays unaffected', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-series-nostore-'))
  const app = createApp({ dev: true, store: null, ensureWorker: () => {}, deferStore: true })
  t.after(() => {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const answer = await get(app, '/api/asset-hub/netflows-series?network=polkadot')
  assert.equal(answer.status, 503)
  assert.match(answer.json().error.message, /persistent store/)
})
