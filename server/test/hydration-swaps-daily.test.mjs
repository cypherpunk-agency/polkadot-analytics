// The first store-backed handler, tested where it can be tested without an upstream.
//
// Nothing here makes a network call. What is checked is the part of `hydration/swaps-daily`
// that decides things rather than fetches them: the immutability predicate (the most dangerous
// line in the handler — wrong in the permissive direction it freezes a partial answer forever),
// the segment ids (they sort as strings or the charts come out shuffled with no error anywhere),
// and the per-day roll-up's arithmetic, including the places where `null` must not become `0`.
//
// The fetching half is covered by the engine's own tests against synthetic handlers
// (jobs.test.mjs) plus a real run: `node scripts/job.mjs enqueue hydration swaps-daily
// month=2026-07 && node scripts/job.mjs run`.

import test from 'node:test'
import assert from 'node:assert/strict'

import hydration, { daysOfMonth, monthIsSettled, summariseDay } from '../sources/hydration.mjs'

const handler = hydration.jobs['swaps-daily']

test('the handler implements the contract the engine enforces', () => {
  assert.equal(typeof handler.immutable, 'function')
  assert.equal(typeof handler.nextBatch, 'function')
  assert.equal(typeof handler.summary, 'string')
  // A jobs entry that shadowed an operation of the same name would take the URL away from it,
  // silently. `npm run check` guards this too; asserting it here names the reason.
  assert.ok(!Object.prototype.hasOwnProperty.call(hydration.operations, 'swaps-daily'))
})

test('immutable: a month is settled only once it is wholly past, and never on bad input', () => {
  const at = (iso) => Date.parse(iso)

  // The boundary. 2026-07 ends at 2026-08-01T00:00:00Z; the settling margin is two hours.
  assert.equal(monthIsSettled({ month: '2026-07' }, at('2026-07-31T23:59:59Z')), false)
  assert.equal(monthIsSettled({ month: '2026-07' }, at('2026-08-01T00:00:00Z')), false, 'the margin has not passed')
  assert.equal(monthIsSettled({ month: '2026-07' }, at('2026-08-01T01:59:59Z')), false)
  assert.equal(monthIsSettled({ month: '2026-07' }, at('2026-08-01T02:00:00Z')), true)

  // December rolls the year, not the month index.
  assert.equal(monthIsSettled({ month: '2025-12' }, at('2025-12-31T23:00:00Z')), false)
  assert.equal(monthIsSettled({ month: '2025-12' }, at('2026-01-01T03:00:00Z')), true)

  // Total on anything else: a predicate that throws would burn the attempt budget on a design
  // error, and one that answers true would freeze a partial month forever.
  for (const params of [{}, null, undefined, { month: '' }, { month: '2026-13' }, { month: '2026-7' }, { month: '2026-07-01' }, { month: 7 }]) {
    assert.equal(monthIsSettled(params, at('2030-01-01T00:00:00Z')), false, `refused: ${JSON.stringify(params)}`)
  }

  // And the same predicate through the handler, which is how the engine and demand.mjs ask.
  assert.equal(handler.immutable({ month: '2025-01' }), true)
  assert.equal(handler.immutable({ month: '9999-01' }), false)
  assert.equal(handler.immutable({}), false)
})

test('segments are ISO days that sort as strings, one per day, leap year included', async () => {
  const july = daysOfMonth('2026-07')
  assert.equal(july.length, 31)
  assert.equal(july[0], '2026-07-01')
  assert.equal(july[30], '2026-07-31')
  // Lexicographic order IS chronological order. An unpadded counter is the trap this avoids.
  assert.deepEqual([...july].sort(), july)

  assert.equal(daysOfMonth('2025-02').length, 28)
  assert.equal(daysOfMonth('2024-02').length, 29)
  assert.equal(daysOfMonth('2025-12').at(-1), '2025-12-31')

  // The plan's unit count is the day count, and it is knowable without asking anybody.
  assert.deepEqual(await handler.plan({ params: { month: '2025-02' } }), { totalUnits: 28 })
})

test('nextBatch refuses a cursor that belongs to another month rather than fetching', async () => {
  await assert.rejects(
    () => handler.nextBatch({ params: { month: '2026-07' }, cursor: { day: '2026-06-04' }, gate: (_h, fn) => fn() }),
    /not a day of 2026-07/,
  )
})

/* ---------------------------------------------------------------- the daily roll-up ---- */

const trade = (over = {}) => ({
  id: 'x',
  account: '0xabc',
  venue: 'Omnipool',
  tokenIn: 'DOT',
  tokenOut: 'USDT',
  amountIn: 1,
  usd: 100,
  hops: 2,
  isPallet: false,
  ...over,
})

const summarise = (trades, rates = { USDT: 1 }) =>
  summariseDay({
    date: '2026-07-01',
    trades,
    rates,
    blocks: { from: 1, to: 3, count: 2 },
    platform: null,
    quality: { expectedTrades: trades.length },
  })

test('the roll-up keeps an unpriced trade out of the dollars and in the count', () => {
  const day = summarise([trade(), trade({ usd: null, id: 'y' }), trade({ usd: 50, id: 'z' })])
  assert.equal(day.trades, 3)
  assert.equal(day.usd, 150, 'the unpriced trade contributes nothing to the total...')
  assert.equal(day.unpricedTrades, 1, '...and is counted, so the two numbers disagree by exactly this much')
  assert.equal(day.legs, 6)
  assert.equal(day.legInflation, 2)
})

test('the roll-up separates pallet flow, ranks by volume, and shares are of everything', () => {
  const trades = [
    trade({ account: 'pallet:fees', isPallet: true, usd: 400, venue: 'DCA' }),
    trade({ account: '0xa', usd: 300 }),
    trade({ account: '0xb', usd: 200, tokenIn: 'USDT', tokenOut: 'DOT' }),
    trade({ account: '0xc', usd: 100 }),
    trade({ account: '0xd', usd: 50 }),
  ]
  const day = summarise(trades)

  assert.equal(day.usd, 1050)
  assert.deepEqual(day.pallet, { trades: 1, usd: 400 })
  assert.equal(day.accounts, 5)
  assert.equal(day.topAccounts[0].account, 'pallet:fees')
  assert.equal(day.topAccounts[0].pallet, true)
  // Ranked by volume, not by first appearance: Omnipool's four trades outweigh DCA's one.
  assert.deepEqual(
    day.venues.map((v) => `${v.venue}:${v.usd}/${v.count}`),
    ['Omnipool:650/4', 'DCA:400/1'],
  )
  // Both directions of an asset are recorded, and the volume is the INPUT side only.
  const usdt = day.assets.find((a) => a.symbol === 'USDT')
  assert.deepEqual(usdt, { symbol: 'USDT', usd: 200, tradesIn: 1, tradesOut: 4 })
  assert.equal(day.routesTotal, 2)
  // The share is computed over EVERY account and only then is the list trimmed, so "top four
  // share" stays a share of everything rather than a share of what survived the trim.
  assert.equal(day.topFourShare, Number(((1000 / 1050) * 100).toPrecision(6)))
  assert.equal(day.topTenShare, 100)
})

test('a day with no trades is a real day, not a hole; shares stay null rather than 0', () => {
  const day = summarise([])
  assert.equal(day.trades, 0)
  assert.equal(day.usd, 0)
  assert.equal(day.accounts, 0)
  assert.equal(day.legInflation, null, 'no trades means no leg factor — null, not 0')
  assert.equal(day.topFourShare, null, 'a share of nothing is not knowable, and 0% would be a claim')
  assert.deepEqual(day.venues, [])
  assert.equal(day.coverage, 'indexed')
})
