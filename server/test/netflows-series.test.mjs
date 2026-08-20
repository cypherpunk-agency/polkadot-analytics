// The netflows series shaper, tested without a browser.
//
// `src/pages/netflows/series.js` is the arithmetic behind `/netflows/`: it stitches fifty-odd
// stored months and one live tail into a single continuous day axis. Everything that could be
// silently WRONG on that page happens here — a missing day drawn as zero, a chain's line
// starting before it existed, an archive cross-check that skips the days it disagrees on — and
// none of it needs a DOM to check.
//
// The fixtures are the real payload shape: `chains` as `[paraId, relayPlanck, assetHubPlanck]`
// with `null` for an account that does not exist, and totals as exact planck strings.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSeries, crossCheck, dot, monthsBetween } from '../../src/pages/netflows/series.js'

const DOT = (n) => String(BigInt(Math.round(n * 1e4)) * 10n ** 6n)

const day = (date, chains, { relay = 0, assetHub = 0, dust = 0 } = {}) => ({
  date,
  relay: { block: 1, at: `${date}T23:59:54.000Z` },
  assetHub: { block: 2, at: `${date}T23:59:48.000Z` },
  paras: { enumerated: 3, read: 3, withAccount: chains.length },
  chains,
  dust: { chains: dust, relay: '0', assetHub: '0', floor: '10000000000' },
  totals: { relay: DOT(relay), assetHub: DOT(assetHub), total: DOT(relay + assetHub) },
})

const storedMonth = (month, days, complete = true) => ({
  month,
  body: {
    data: days.map((payload) => ({ segment: payload.date, payload, head: 'relay #1', storedAt: 0 })),
    coverage: { complete, segments: days.length },
    job: complete ? null : { id: 7, state: 'running', progress: { done: 1, total: 31, fraction: 1 / 31 } },
  },
})

test('planck decodes exactly, and null stays null', () => {
  // Past 2^53 planck, which a JSON number would round. This is why the payload stores strings.
  assert.equal(dot('45335271259102178'), 4533527.1259102179)
  assert.equal(dot(null), null)
  assert.equal(dot(undefined), null)
  assert.equal(dot('0'), 0)
})

test('monthsBetween spans years and stops at the last whole month', () => {
  assert.deepEqual(monthsBetween('2022-11', '2023-02'), ['2022-11', '2022-12', '2023-01', '2023-02'])
  assert.deepEqual(monthsBetween('2022-01', '2022-01'), ['2022-01'])
  assert.deepEqual(monthsBetween('2023-01', '2022-12'), [])
})

test('the axis spans the whole series, not just the days that are present', () => {
  // One month stored out of three. The gap must be DRAWN — "we have not fetched this" is not
  // "there was nothing here", and an axis that started at the first present day would hide it.
  const months = [storedMonth('2022-03', [day('2022-03-01', [[2000, DOT(10), null]], { relay: 10 })])]
  const series = buildSeries({ months, tail: null, firstDay: '2022-01-01' })

  assert.equal(series.days[0], '2022-01-01')
  assert.equal(series.days[series.days.length - 1], '2022-03-01')
  assert.equal(series.days.length, 60)
  assert.equal(series.coverage.present, 1)
  assert.equal(series.coverage.missing, 59)
  assert.equal(series.firstPresent, '2022-03-01')
})

test('a day nobody fetched is null on every line, never zero', () => {
  const months = [
    storedMonth('2022-01', [
      day('2022-01-01', [[2000, DOT(100), null]], { relay: 100 }),
      day('2022-01-03', [[2000, DOT(300), null]], { relay: 300 }),
    ]),
  ]
  const series = buildSeries({ months, tail: null, firstDay: '2022-01-01' })
  const acala = series.chains.find((c) => c.paraId === 2000)

  assert.deepEqual(acala.values, [100, null, 300])
  assert.deepEqual(series.legs.relay, [100, null, 300])
  assert.deepEqual(series.legs.total, [100, null, 300])
})

test('a chain is absent before it first appears, and zero after it drops below the dust floor', () => {
  const months = [
    storedMonth('2022-01', [
      day('2022-01-01', [[2000, DOT(100), null]], { relay: 100 }),
      // Bifrost appears on the second day only, and is dust on the third.
      day('2022-01-02', [
        [2000, DOT(100), null],
        [2030, DOT(50), null],
      ], { relay: 150 }),
      day('2022-01-03', [[2000, DOT(100), null]], { relay: 100, dust: 1 }),
    ]),
  ]
  const series = buildSeries({ months, tail: null, firstDay: '2022-01-01' })
  const bifrost = series.chains.find((c) => c.paraId === 2030)

  // Absent, then 50, then zero — not null, null, null and not 0, 50, 0.
  assert.deepEqual(bifrost.values, [null, 50, 0])
  assert.equal(bifrost.peak, 50)
  assert.equal(bifrost.peakOn, '2022-01-02')
  assert.equal(bifrost.last, 0)
  assert.equal(series.coverage.dustDaysMax, 1)
})

test('both legs are summed per chain, and kept apart in the totals', () => {
  // The Asset Hub Migration in miniature: the same chain, the same money, a different chain
  // holding it. The per-chain line must be continuous; the two leg lines must cross.
  const months = [
    storedMonth('2025-11', [
      day('2025-11-03', [[2000, DOT(1000), DOT(4)]], { relay: 1000, assetHub: 4 }),
      day('2025-11-04', [[2000, DOT(1), DOT(1003)]], { relay: 1, assetHub: 1003 }),
    ]),
  ]
  const series = buildSeries({ months, tail: null, firstDay: '2025-11-03' })
  const acala = series.chains.find((c) => c.paraId === 2000)

  assert.deepEqual(acala.values, [1004, 1004])
  assert.deepEqual(series.legs.relay, [1000, 1])
  assert.deepEqual(series.legs.assetHub, [4, 1003])
})

test('the live tail joins the stored months on the same axis and wins on a shared day', () => {
  const months = [storedMonth('2026-07', [day('2026-07-31', [[2000, DOT(10), null]], { relay: 10 })])]
  const tail = { days: [day('2026-08-01', [[2000, DOT(20), null]], { relay: 20 })] }
  const series = buildSeries({ months, tail, firstDay: '2026-07-31' })

  assert.deepEqual(series.days, ['2026-07-31', '2026-08-01'])
  assert.equal(series.last, '2026-08-01')
  assert.equal(series.latest.date, '2026-08-01')
  assert.deepEqual(series.chains.find((c) => c.paraId === 2000).values, [10, 20])
})

test('coverage counts complete months apart from the ones still filling', () => {
  const months = [
    storedMonth('2022-01', [day('2022-01-01', [], {})], true),
    storedMonth('2022-02', [day('2022-02-01', [], {})], false),
  ]
  const series = buildSeries({ months, tail: null, firstDay: '2022-01-01' })

  assert.equal(series.coverage.complete, 1)
  assert.equal(series.coverage.partial, 1)
  assert.equal(series.coverage.jobs.length, 1)
  assert.equal(series.coverage.jobs[0].state, 'running')
})

test('an empty store answers with an empty series rather than throwing', () => {
  const series = buildSeries({ months: [storedMonth('2022-01', [])], tail: null, firstDay: '2022-01-01' })
  assert.deepEqual(series.days, [])
  assert.equal(series.last, null)
  assert.equal(series.latest, null)
  assert.deepEqual(series.chains, [])
})

/* -------------------------------------------------------------------- the cross-check ---- */

const archive = {
  last: '2022-01-03',
  days: ['2022-01-01', '2022-01-02', '2022-01-03'],
  chains: [{ name: 'Acala', series: [null, 100, 200] }],
}
const paraIdOf = (name) => (name === 'Acala' ? 2000 : null)

test('the archive cross-check skips the days the archive says nothing about', () => {
  const months = [
    storedMonth('2022-01', [
      day('2022-01-01', [[2000, DOT(1), null]], { relay: 1 }),
      day('2022-01-02', [[2000, DOT(100), null]], { relay: 100 }),
      day('2022-01-03', [[2000, DOT(200), null]], { relay: 200 }),
    ]),
  ]
  const check = crossCheck(buildSeries({ months, tail: null, firstDay: '2022-01-01' }), archive, paraIdOf)

  // Three days in the file, but the first is `null` there — one reading declining to speak is
  // not a disagreement, so it is skipped rather than scored as a 100% deviation.
  assert.equal(check.pairs, 2)
  assert.equal(check.days, 2)
  assert.equal(check.from, '2022-01-02')
  assert.equal(check.to, '2022-01-03')
  assert.equal(check.body.pairs, 1)
  assert.equal(check.body.max, 0)
  assert.equal(check.tail.pairs, 1)
  assert.equal(check.tail.max, 0)
})

test('the archive is compared against the RELAY leg, not the sum', () => {
  // The 2023 study read `para` on the relay chain and nothing else. Scoring it against the sum
  // would count the `sibl` leg on Asset Hub as a disagreement when it is simply something the
  // original never had — which is exactly what the real overlap looked like before this split.
  const months = [
    storedMonth('2022-01', [
      day('2022-01-02', [[2000, DOT(100), DOT(9)]], { relay: 100, assetHub: 9 }),
    ]),
  ]
  const check = crossCheck(buildSeries({ months, tail: null, firstDay: '2022-01-01' }), archive, paraIdOf)

  assert.equal(check.body.pairs, 1)
  assert.equal(check.body.max, 0)
  assert.equal(check.assetHub.pairs, 1)
  assert.ok(Math.abs(check.assetHub.maxShare - 9 / 109) < 1e-12)
})

test("the archive's final day is scored apart from the rest", () => {
  // Its captures stop mid-day, so the last row is not that day's close. Averaging it into one
  // verdict would report a real, explainable artefact as a general disagreement.
  const months = [
    storedMonth('2022-01', [
      day('2022-01-02', [[2000, DOT(100), null]], { relay: 100 }),
      day('2022-01-03', [[2000, DOT(240), null]], { relay: 240 }),
    ]),
  ]
  const check = crossCheck(buildSeries({ months, tail: null, firstDay: '2022-01-01' }), archive, paraIdOf)

  assert.equal(check.finalDay, '2022-01-03')
  assert.equal(check.body.pairs, 1)
  assert.equal(check.body.over, 0)
  assert.equal(check.body.max, 0)
  assert.equal(check.tail.pairs, 1)
  assert.equal(check.tail.over, 1)
  assert.ok(Math.abs(check.tail.max - 0.2) < 1e-12)
  assert.equal(check.tail.worst[0].archived, 200)
  assert.equal(check.tail.worst[0].value, 240)
})

test('a day the series has not fetched is not counted as an archive disagreement', () => {
  const months = [storedMonth('2022-01', [day('2022-01-02', [[2000, DOT(100), null]], { relay: 100 })])]
  const check = crossCheck(buildSeries({ months, tail: null, firstDay: '2022-01-01' }), archive, paraIdOf)

  assert.equal(check.pairs, 1)
  assert.equal(check.body.over, 0)
  assert.equal(check.tail, null)
})

test('an overlap with nothing in it returns null rather than an empty verdict', () => {
  const months = [storedMonth('2023-01', [day('2023-01-01', [[2000, DOT(1), null]], { relay: 1 })])]
  const check = crossCheck(buildSeries({ months, tail: null, firstDay: '2023-01-01' }), archive, paraIdOf)
  assert.equal(check, null)
})

test('both legs are kept per chain, so the migration is visible chain by chain', () => {
  const months = [
    storedMonth('2025-11', [
      day('2025-11-03', [[2000, DOT(1000), DOT(4)]], { relay: 1000, assetHub: 4 }),
      day('2025-11-04', [[2000, DOT(1), DOT(1003)]], { relay: 1, assetHub: 1003 }),
    ]),
  ]
  const acala = buildSeries({ months, tail: null, firstDay: '2025-11-03' }).chains.find((c) => c.paraId === 2000)
  assert.deepEqual(acala.relayValues, [1000, 1])
  assert.deepEqual(acala.assetHubValues, [4, 1003])
  assert.deepEqual(acala.values, [1004, 1004])
})
