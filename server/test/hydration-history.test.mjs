// The long-window view on /hydration/, as arithmetic.
//
// Everything here could be WRONG rather than merely ugly: stitching store-backed months to a
// counted live tail on one day axis, deciding what a missing day means, and keeping the two
// fidelities apart. The failure this file guards against is the one this repo exists to prevent
// — a day the store has not fetched yet drawn as a day with no trading, which renders perfectly.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHistory, monthsBetween, RANGES } from '../../src/pages/hydration/history.js'

/** A stored (WALKED) day: the shape `summariseDay` produces, cut to what the chart reads. */
const stored = (date, trades, legs, usd) => ({
  date,
  coverage: 'indexed',
  blocks: { from: 1, to: 2, count: 1 },
  trades,
  legs,
  legInflation: trades ? legs / trades : null,
  usd,
  platform: { total: usd * 2.5 },
})

/** A counted (TAIL) day: same axis, fewer fields, and `usd` is null rather than zero. */
const counted = (date, trades, legs, orca) => ({
  date,
  coverage: 'counted',
  blocks: { from: 1, to: 2, count: 1, gapless: true },
  trades,
  legs,
  legInflation: trades ? legs / trades : null,
  usd: null,
  platform: { total: orca },
})

const monthBody = (days) => ({ coverage: { complete: true }, job: null, data: days.map((day) => ({ payload: day })) })

test('the axis spans the whole requested range, not the part that happens to be present', () => {
  const series = buildHistory({
    months: [{ month: '2025-01', body: monthBody([stored('2025-01-30', 10, 20, 100)]) }],
    tail: { days: [] },
    firstMonth: '2025-01',
  })
  // One day of data, thirty days of axis. A store that has filled a sliver must READ as a sliver.
  assert.equal(series.days.length, 30)
  assert.equal(series.days[0], '2025-01-01')
  assert.equal(series.days[29], '2025-01-30')
  assert.equal(series.missing, 29)
})

test('a day nobody has fetched is null, never zero — the line breaks rather than falling', () => {
  const series = buildHistory({
    months: [{ month: '2025-01', body: monthBody([stored('2025-01-01', 10, 20, 100), stored('2025-01-03', 30, 60, 300)]) }],
    tail: { days: [] },
    firstMonth: '2025-01',
  })
  assert.equal(series.trades[0], 10)
  // 2025-01-02 was never fetched. `0` here would draw a day of no trading that never happened.
  assert.equal(series.trades[1], null)
  assert.equal(series.ourUsd[1], null)
  assert.equal(series.orcaUsd[1], null)
  assert.equal(series.trades[2], 30)
})

test('a counted tail day contributes trades but a NULL dollar volume', () => {
  const series = buildHistory({
    months: [],
    tail: { days: [counted('2026-08-01', 100, 230, 5000)] },
    firstMonth: '2026-08',
  })
  assert.equal(series.trades[0], 100)
  assert.equal(series.legs[0], 230)
  // The measurement this repo makes needs the trades themselves, which a counted day lacks.
  assert.equal(series.ourUsd[0], null)
  // Orca's own published figure exists on both sides of the seam, so it is the continuous line.
  assert.equal(series.orcaUsd[0], 5000)
  assert.equal(series.coverage.countedDays, 1)
  assert.equal(series.coverage.storedDays, 0)
})

test('where a day exists on both sides, the WALKED reading wins over the counted one', () => {
  // This is the whole reason the merge order is tail-then-store. On the 1st of a month the tail
  // reaches back into the previous month, which the store already holds at full fidelity; taking
  // the counted copy would silently drop that day's dollar volume, routes and accounts.
  const series = buildHistory({
    months: [{ month: '2026-07', body: monthBody([stored('2026-07-31', 500, 1200, 9999)]) }],
    tail: { days: [counted('2026-07-31', 500, 1200, 12345)] },
    firstMonth: '2026-07',
  })
  assert.equal(series.days.length, 31)
  assert.equal(series.ourUsd[30], 9999, 'the stored day must survive the tail')
  assert.equal(series.coverage.storedDays, 1)
  assert.equal(series.coverage.countedDays, 0)
  assert.equal(series.seam.first, null, 'nothing is on the live side of the seam')
})

test('the seam is reported as the span of counted days', () => {
  const series = buildHistory({
    months: [{ month: '2026-07', body: monthBody([stored('2026-07-31', 1, 2, 3)]) }],
    tail: { days: [counted('2026-08-01', 1, 2, 3), counted('2026-08-02', 1, 2, 3)] },
    firstMonth: '2026-07',
  })
  assert.deepEqual(series.seam, { first: '2026-08-01', last: '2026-08-02' })
})

test('a day before the source floor carries null, and is counted apart from a gap', () => {
  const before = { ...counted('2025-01-01', null, null, null), coverage: 'before-source-floor', trades: null, legs: null, platform: null }
  const series = buildHistory({ months: [], tail: { days: [before, counted('2025-01-02', 7, 14, 1)] }, firstMonth: '2025-01' })
  assert.equal(series.beforeFloor, 1)
  assert.equal(series.trades[0], null, 'before the floor is not zero trading')
  // It is PRESENT — orca answered about it — so it is not a gap either.
  assert.equal(series.missing, 0)
  assert.equal(series.trades[1], 7)
})

test('the month roll-up partitions the axis exactly, and separates stored from counted', () => {
  const series = buildHistory({
    months: [{ month: '2026-07', body: monthBody([stored('2026-07-01', 10, 20, 5), stored('2026-07-02', 10, 20, 5)]) }],
    tail: { days: [counted('2026-08-01', 3, 9, 77)] },
    firstMonth: '2026-07',
  })
  const total = series.months.reduce((sum, month) => sum + month.days, 0)
  assert.equal(total, series.days.length, 'every day on the axis belongs to exactly one month row')
  const july = series.months.find((month) => month.month === '2026-07')
  assert.equal(july.days, 31)
  assert.equal(july.present, 2)
  assert.equal(july.stored, 2)
  assert.equal(july.counted, 0)
  // Two of thirty-one days carry a dollar figure, and the table must be able to say so rather
  // than presenting a two-day total as a month.
  assert.equal(july.ourUsdDays, 2)
  const august = series.months.find((month) => month.month === '2026-08')
  assert.equal(august.counted, 1)
  assert.equal(august.ourUsdDays, 0)
})

test('totals ignore nulls rather than treating them as zero', () => {
  const series = buildHistory({
    months: [{ month: '2026-07', body: monthBody([stored('2026-07-01', 10, 23, 100)]) }],
    tail: { days: [counted('2026-08-01', 5, 10, 50)] },
    firstMonth: '2026-07',
  })
  assert.equal(series.totalTrades, 15)
  assert.equal(series.totalOurUsd, 100, 'the counted day adds nothing to our own volume')
  assert.equal(series.totalOrcaUsd, 100 * 2.5 + 50)
  assert.equal(series.busiest.date, '2026-07-01')
  assert.equal(series.busiest.trades, 10)
})

test('an unfetched month is a hole in the middle, not a shortened axis', () => {
  const series = buildHistory({
    months: [
      { month: '2026-06', body: monthBody([stored('2026-06-30', 1, 2, 3)]) },
      { month: '2026-07', body: null },
    ],
    tail: { days: [counted('2026-08-01', 1, 2, 3)] },
    firstMonth: '2026-06',
  })
  assert.equal(series.first, '2026-06-01')
  assert.equal(series.last, '2026-08-01')
  const july = series.months.find((month) => month.month === '2026-07')
  assert.equal(july.present, 0)
  assert.equal(july.days, 31)
  assert.equal(series.trades[series.days.indexOf('2026-07-15')], null)
})

test('nothing anywhere yields an empty axis rather than a one-day chart', () => {
  const series = buildHistory({ months: [], tail: { days: [] }, firstMonth: '2025-01' })
  assert.deepEqual(series.days, [])
  assert.equal(series.first, null)
  assert.equal(series.last, null)
})

test('monthsBetween is inclusive and crosses years', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
  assert.deepEqual(monthsBetween('2026-03', '2026-03'), ['2026-03'])
  assert.deepEqual(monthsBetween('2026-04', '2026-03'), [])
})

test('the range keys the page offers are the ones it can resolve', () => {
  // `all` is null-spanned deliberately: its start is the SOURCE FLOOR read at request time, not
  // a number in this file. A hardcoded start date is the thing docs/platform/hydration.md warns
  // about — a chart that begins on a date for a reason nobody wrote down.
  assert.deepEqual(Object.keys(RANGES).sort(), ['12m', '3m', 'all'])
  assert.equal(RANGES.all, null)
  assert.equal(RANGES['3m'], 3)
})
