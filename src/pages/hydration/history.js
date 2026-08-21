// Hydration trading history, over months and years rather than days.
//
// The short view on this page walks every routed trade in the window and prices it, which costs
// about three seconds a day and is why it stops at fourteen. This is the other half: the same
// venue over its whole indexed life, drawn from two sources that meet at a seam.
//
// ── the seam, which is the design problem and is on the page ────────────────────────────────
// `hydration/swaps-daily` is a store-backed job keyed by CALENDAR MONTH (decision 0012, and
// docs/architecture/jobs.md). A month that has not ended can never be immutable, so the store
// cannot serve the current one — it never will, by construction, not because nobody has run it.
// So:
//
//     whole past months  ->  /api/hydration/swaps-daily?month=YYYY-MM   (mode A, the store)
//     this month so far  ->  /api/hydration/swaps-recent-daily          (mode B, TTL cached)
//
// The two are NOT the same fidelity, and pretending otherwise is the mistake this file exists
// to avoid. A stored day was WALKED: every trade fetched and priced, so it carries this
// repository's own dollar volume, the routes, the accounts and the day's derived rates. A tail
// day was COUNTED: three aliased queries, so it carries trades, legs and orca's own published
// pool volume, and its `usd` is `null`. `null` is not `0` — the dollar line BREAKS at the seam
// rather than falling to the floor, and the page says where the break is and why.
//
// The one series that is identical on both sides is the trade count, which is why it is the
// chart drawn first.
//
// ── the store fills on demand, and may not be there at all ──────────────────────────────────
// The first reader of a month is what starts its fetch (decision 0006). An empty answer is the
// normal FIRST response, not a failure. And an instance with no writable data directory serves
// mode B perfectly and mode A not at all — every stored month comes back 503. Both states are
// rendered as coverage, with the tail still drawn, rather than as an error page.

import { append, el, notice, statRow, statTile } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { livenessNotes } from '../../design/liveness.js'
import { read, readStore } from '../../core/client.js'
import { compact, formatCount, formatUtc, money, percent } from '../../core/format.js'

const DAY_MS = 86_400_000
/** Fifty-five at once is a self-inflicted queue; the browser opens six connections anyway. */
const MONTH_CONCURRENCY = 5

export const RANGES = { '3m': 3, '12m': 12, all: null }

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`)
const monthOf = (day) => day.slice(0, 7)

/** Every month from `first` to `last` inclusive, as `YYYY-MM`. */
export function monthsBetween(first, last) {
  const months = []
  let [year, index] = first.split('-').map(Number)
  for (;;) {
    const month = `${year}-${String(index).padStart(2, '0')}`
    if (month > last) break
    months.push(month)
    index += 1
    if (index > 12) {
      index = 1
      year += 1
    }
  }
  return months
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        out[index] = await fn(items[index], index)
      }
    }),
  )
  return out
}

/* ═══════════════════════════════════════════════════════════════════════════════ load ═════ */

export async function loadHistory(range, { progress }) {
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const lastWholeMonth = isoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).slice(0, 7)
  // Days of the current month that have already closed. On the 1st there are none and the tail
  // is asked for one day anyway, which lands in the previous month and is simply overwritten by
  // the stored copy of the same day — the higher-fidelity reading always wins.
  const tailDays = Math.max(1, now.getUTCDate() - 1)

  progress({ stage: 'Reading the days since the last whole month', done: 0, total: 2 })
  const tail = await read('hydration', 'swaps-recent-daily', { days: Math.min(tailDays, 31) })

  // The floor is READ, never hardcoded: orca groups swap legs into routed trades only from a
  // specific block, and a chart that starts on a date for a reason nobody wrote down is the
  // failure rule 3 exists to prevent.
  const floorMonth = monthOf(tail.floorDay)
  const span = RANGES[range] ?? null
  const firstMonth =
    span === null
      ? floorMonth
      : (() => {
          const [year, index] = lastWholeMonth.split('-').map(Number)
          const start = new Date(Date.UTC(year, index - 1 - (span - 1), 1))
          const candidate = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`
          return candidate < floorMonth ? floorMonth : candidate
        })()

  const months = firstMonth > lastWholeMonth ? [] : monthsBetween(firstMonth, lastWholeMonth)

  let fetched = 1
  const total = months.length + 1
  const step = (stage) => progress({ stage, done: fetched, total })
  step('Reading stored months')

  // One month that will not answer must not take the others down with it. The realistic causes
  // are an instance with no writable store (every month 503s) and an ordinary transport failure,
  // and both are far better served by a chart with a hole and a note than by an error page.
  const failures = []
  const answers = await mapLimit(months, MONTH_CONCURRENCY, async (month) => {
    try {
      const body = await readStore('hydration', 'swaps-daily', { month })
      return { month, body }
    } catch (problem) {
      if (problem?.name === 'AbortError') throw problem
      failures.push({ month, status: problem?.status ?? null, message: problem?.message ?? String(problem) })
      return { month, body: null }
    } finally {
      fetched += 1
      step(`Reading stored months — ${month}`)
    }
  })

  return { mode: 'history', range, tail, months: answers, failures, currentMonth, lastWholeMonth, firstMonth }
}

/* ══════════════════════════════════════════════════════════════════════════════ shape ═════ */

/**
 * One continuous day axis out of stored months and one counted tail.
 *
 * The axis runs from the first requested day to the newest day anything returned, NOT from the
 * first day that happens to be present: a store that has filled four months of nineteen must
 * draw as four months inside a nineteen-month span, because "not fetched yet" and "nothing
 * happened" are different facts and only the first is temporary.
 */
export function buildHistory({ months, tail, firstMonth }) {
  const byDate = new Map()
  const coverage = { requested: months.length, complete: 0, partial: 0, jobs: [], storedDays: 0, countedDays: 0 }

  // Tail first, store second: where both have a day, the WALKED reading wins over the counted one.
  for (const day of tail?.days ?? []) byDate.set(day.date, { ...day, from: 'tail' })
  for (const { body } of months) {
    if (!body) continue
    if (body.coverage?.complete) coverage.complete += 1
    else coverage.partial += 1
    if (body.job) coverage.jobs.push(body.job)
    for (const fact of body.data ?? []) {
      if (fact?.payload?.date) byDate.set(fact.payload.date, { ...fact.payload, from: 'store' })
    }
  }

  const present = [...byDate.keys()].sort()
  const last = present[present.length - 1] ?? null
  const days = []
  if (last) for (let at = dayMs(`${firstMonth}-01`); at <= dayMs(last); at += DAY_MS) days.push(isoDay(at))

  const trades = []
  const legs = []
  const ourUsd = []
  const orcaUsd = []
  const seam = { first: null, last: null }
  let missing = 0
  let beforeFloor = 0
  let totalTrades = 0
  let totalOurUsd = 0
  let totalOrcaUsd = 0
  let inflationSum = 0
  let inflationDays = 0

  for (const date of days) {
    const day = byDate.get(date)
    if (!day) {
      // Empty days are DRAWN, not dropped, and a day nobody fetched is a break in the line
      // rather than a zero. A month whose job has not run yet looks like a hole, which is what
      // it is.
      missing += 1
      trades.push(null)
      legs.push(null)
      ourUsd.push(null)
      orcaUsd.push(null)
      continue
    }
    if (day.coverage === 'before-source-floor') beforeFloor += 1
    if (day.from === 'store') coverage.storedDays += 1
    else {
      coverage.countedDays += 1
      if (!seam.first) seam.first = date
      seam.last = date
    }
    trades.push(day.trades ?? null)
    legs.push(day.legs ?? null)
    ourUsd.push(day.usd ?? null)
    orcaUsd.push(day.platform?.total ?? null)
    totalTrades += day.trades ?? 0
    totalOurUsd += day.usd ?? 0
    totalOrcaUsd += day.platform?.total ?? 0
    if (day.legInflation) {
      inflationSum += day.legInflation
      inflationDays += 1
    }
  }

  // Per calendar month, for the table — the unit a reader actually compares over years.
  const byMonth = new Map()
  for (const date of days) {
    const month = monthOf(date)
    const day = byDate.get(date)
    const entry = byMonth.get(month) ?? {
      month,
      days: 0,
      present: 0,
      stored: 0,
      counted: 0,
      trades: 0,
      legs: 0,
      ourUsd: 0,
      ourUsdDays: 0,
      orcaUsd: 0,
      orcaUsdDays: 0,
    }
    entry.days += 1
    if (day) {
      entry.present += 1
      if (day.from === 'store') entry.stored += 1
      else entry.counted += 1
      entry.trades += day.trades ?? 0
      entry.legs += day.legs ?? 0
      if (day.usd !== null && day.usd !== undefined) {
        entry.ourUsd += day.usd
        entry.ourUsdDays += 1
      }
      if (day.platform?.total !== null && day.platform?.total !== undefined) {
        entry.orcaUsd += day.platform.total
        entry.orcaUsdDays += 1
      }
    }
    byMonth.set(month, entry)
  }

  const busiest = days.reduce(
    (best, date, i) => (trades[i] !== null && trades[i] > (best.trades ?? -1) ? { date, trades: trades[i] } : best),
    { date: null, trades: null },
  )

  return {
    days,
    trades,
    legs,
    ourUsd,
    orcaUsd,
    months: [...byMonth.values()],
    coverage,
    seam,
    missing,
    beforeFloor,
    totalTrades,
    totalOurUsd,
    totalOrcaUsd,
    meanInflation: inflationDays ? inflationSum / inflationDays : null,
    first: days[0] ?? null,
    last: days[days.length - 1] ?? null,
    busiest,
  }
}

/* ═════════════════════════════════════════════════════════════════════════════ render ═════ */

export function renderHistory(host, data) {
  const series = buildHistory(data)
  const { tail, failures, lastWholeMonth } = data
  const storeDown = failures.length > 0 && failures.every((failure) => failure.status === 503)

  if (!series.days.length) {
    append(
      host,
      notice(
        'warning',
        'Nothing is stored yet, and the fetch has just been started',
        'This view is drawn from a store that fills on demand: the first reader of a month is what starts its fetch. Reload in a minute and the chart will have days in it.',
      ),
      historyNotes(data, series, storeDown),
    )
    return
  }

  append(
    host,
    // The chart first — decision 0011. The subject of a long window is the series.
    tradeChart(series),
    statRow([
      statTile('Routed trades', formatCount(series.totalTrades), `over ${formatCount(series.days.length - series.missing)} days drawn`),
      statTile(
        'Days on the chart',
        `${formatCount(series.coverage.storedDays)} + ${formatCount(series.coverage.countedDays)}`,
        'walked from the store, plus counted live',
      ),
      statTile(
        'Busiest day',
        series.busiest.date ? formatCount(series.busiest.trades) : '—',
        series.busiest.date ?? 'nothing drawn',
      ),
      statTile(
        'Legs per trade',
        series.meanInflation ? series.meanInflation.toFixed(2) : '—',
        'mean over the days drawn; one trade is several chain events',
      ),
    ]),
    storeDown ? storeDownNotice(failures) : failures.length ? failureNotice(failures) : null,
    series.missing ? gapNotice(series) : null,
    volumeChart(series),
    monthTable(series, lastWholeMonth),
    historyNotes(data, series, storeDown),
  )
}

function tradeChart(series) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `Routed trades per day, ${series.first} → ${series.last}` }),
      el('p.note', {
        text:
          'The one measurement that is identical on both sides of the store/live seam, which is why it is drawn ' +
          'first. A routed trade is one thing a person did; Hydration emits one event per LEG, and the leg count ' +
          'is drawn beside it so the factor between them stays visible rather than becoming an assumption. ' +
          'A day nobody has fetched is a break in the line, not a zero.',
      }),
    ),
  )
  const plot = el('div.plot')
  append(card, plot)
  multiLine(plot, {
    days: series.days,
    series: [
      { label: 'routed trades', values: series.trades },
      { label: 'swap legs', values: series.legs },
    ],
    format: compact,
    height: 320,
  })
  append(
    card,
    el(
      'ul.legend',
      null,
      el('li', null, el('span.swatch', { style: `background:${seriesColor(0)}` }), document.createTextNode('routed trades'), el('span.amt', { text: formatCount(series.totalTrades) })),
      el('li', null, el('span.swatch', { style: `background:${seriesColor(1)}` }), document.createTextNode('swap legs'), el('span.amt', { text: series.meanInflation ? `${series.meanInflation.toFixed(2)}× per trade` : '—' })),
    ),
  )
  return card
}

function volumeChart(series) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Dollar volume per day — two measurements, and one of them stops at the seam' }),
      el('p.note', {
        text:
          'These are NOT the same number and are not meant to converge. Orca publishes the notional that crossed ' +
          'each POOL, so a route through a stableswap and the Omnipool counts in both; this site sums what the ' +
          'traders actually sent, once. On a fourteen-day window the two differ by about 2.6×. The second line ' +
          'needs every trade in the day, which only a walked day has — so it stops where the store stops, and ' +
          'that break is the seam.',
      }),
    ),
  )
  const plot = el('div.plot')
  append(card, plot)
  multiLine(plot, {
    days: series.days,
    series: [
      { label: 'orca’s published pool volume', values: series.orcaUsd },
      { label: 'trade volume, summed here', values: series.ourUsd },
    ],
    format: money,
    height: 300,
  })
  append(
    card,
    el(
      'ul.legend',
      null,
      el('li', null, el('span.swatch', { style: `background:${seriesColor(0)}` }), document.createTextNode('orca’s pool volume'), el('span.amt', { text: money(series.totalOrcaUsd) })),
      el('li', null, el('span.swatch', { style: `background:${seriesColor(1)}` }), document.createTextNode('trade volume, walked'), el('span.amt', { text: money(series.totalOurUsd) })),
    ),
  )
  return card
}

function monthTable(series, lastWholeMonth) {
  return el(
    'details.data-table',
    { open: true },
    el('summary', { text: `By calendar month — ${formatCount(series.months.length)} of them` }),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { text: 'Month' }),
            el('th.num', { text: 'Days' }),
            el('th.num', { text: 'Trades' }),
            el('th.num', { text: 'Legs' }),
            el('th.num', { text: 'Legs/trade' }),
            el('th.num', { text: 'Orca pool volume' }),
            el('th.num', { text: 'Trade volume, walked' }),
            el('th', { text: 'Read from' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...series.months.map((month) =>
            el(
              'tr',
              null,
              el('td', { text: month.month }),
              el('td.num', { text: `${formatCount(month.present)} / ${formatCount(month.days)}` }),
              el('td.num', { text: month.present ? formatCount(month.trades) : '—' }),
              el('td.num', { text: month.present ? formatCount(month.legs) : '—' }),
              el('td.num', { text: month.trades ? (month.legs / month.trades).toFixed(2) : '—' }),
              el('td.num', { text: month.orcaUsdDays ? money(month.orcaUsd) : '—' }),
              el('td.num', {
                text: month.ourUsdDays
                  ? `${money(month.ourUsd)}${month.ourUsdDays < month.present ? ` (${formatCount(month.ourUsdDays)} d)` : ''}`
                  : '—',
              }),
              el('td', {
                text: !month.present
                  ? 'not fetched yet'
                  : month.stored && month.counted
                    ? `${formatCount(month.stored)} stored + ${formatCount(month.counted)} counted`
                    : month.stored
                      ? 'the store'
                      : 'counted live',
              }),
            ),
          ),
        ),
      ),
    ),
    el('p.note', {
      text:
        `Whole months up to ${lastWholeMonth} come from a store that keeps them forever once fetched. ` +
        'Everything after it is counted live on each read, because a month that has not ended cannot be stored ' +
        'as final — that is the seam, and it moves by one day every day.',
    }),
  )
}

function storeDownNotice(failures) {
  return notice(
    'warning',
    `The store is not available on this instance — ${formatCount(failures.length)} months could not be read`,
    'Every stored month answered HTTP 503: this container has no writable data directory, so the store-backed half of this view cannot be served. The days below are the live tail alone, which is real but short.',
    'Nothing is wrong with the data. The long history exists and is re-derivable; this instance simply cannot hold it.',
  )
}

function failureNotice(failures) {
  return notice(
    'warning',
    `${formatCount(failures.length)} months could not be read`,
    failures
      .slice(0, 6)
      .map((failure) => `${failure.month}: ${failure.message}`)
      .join(' · '),
    'Those months are drawn as gaps rather than as zeros. The rest of the chart is unaffected.',
  )
}

function gapNotice(series) {
  const jobs = series.coverage.jobs.length
  return notice(
    'info',
    `${formatCount(series.missing)} of ${formatCount(series.days.length)} days are not on the chart yet`,
    'This history fills on demand: the first reader of a month is what starts its fetch, and a month takes a few minutes to walk. ' +
      (jobs ? `${formatCount(jobs)} fetches are running right now — reload in a minute and there will be more days.` : 'Reload in a minute and there will be more days.'),
    'The axis spans the whole requested range rather than only the part that is present, so a half-filled history reads as half-filled rather than as short.',
  )
}

function historyNotes(data, series, storeDown) {
  const { tail, lastWholeMonth } = data
  const notes = []

  notes.push(
    `Two sources, one axis. Whole past months up to ${lastWholeMonth} are read from ` +
      '`/api/hydration/swaps-daily`, a store-backed job that WALKED every routed trade in the day and priced it. ' +
      `The ${formatCount(series.coverage.countedDays)} days since are read from ` +
      '`/api/hydration/swaps-recent-daily`, which COUNTED them — three aliased queries per day instead of a walk. ' +
      (series.seam.first ? `The seam is at ${series.seam.first}.` : 'There is no tail today.'),
  )
  notes.push(
    'A counted day has no dollar volume of our own, because that figure needs every trade in the day. It is `null`, ' +
      'not zero, so the second line on the volume chart BREAKS at the seam rather than falling to the floor. Orca’s ' +
      'own published pool volume is available on both sides and is the continuous line.',
  )
  notes.push(
    `A month bucket is the identity of a stored fact, and it is the reason for the seam: a month that has not ended ` +
      `cannot be immutable, so the store will never serve the current one. That is a property of the design rather ` +
      `than of how far anyone has got — see decision 0012, which /netflows/ reached independently.`,
  )
  notes.push(
    `The chart starts at ${series.first} because orca groups swap legs into routed trades only from ${tail.floorDay} ` +
      `— read on every request, never hardcoded. Before that block this source has nothing, which is a different ` +
      `fact from a market with no trading, and those days carry \`coverage: "before-source-floor"\` and a null trade ` +
      `count rather than a zero.` +
      (series.beforeFloor ? ` ${formatCount(series.beforeFloor)} such days are on the chart.` : ''),
  )
  notes.push(
    `Every day’s block window is read from the chain’s own timestamps and then PROVED: the first block of a day must ` +
      `be at or after that day’s start, and the block before it must not be. Block time on this chain has moved by a ` +
      `factor of 2.9 across this range — a day has held as few as 6,188 blocks and as many as 17,702 — so nothing ` +
      `here multiplies out an assumed rate. ${formatCount(tail.gaplessDays)} of ${formatCount(tail.days.length)} ` +
      `counted days also pass a completeness check: a parachain numbers blocks consecutively, so a block count that ` +
      `is not exactly the window's width means the index has a hole.`,
  )
  if (storeDown) {
    notes.push(
      'The store is unavailable on this instance and every stored month returned 503. What is drawn is the live ' +
        'tail alone. This is a deployment state, not a data state: the history exists and is re-derivable.',
    )
  }
  notes.push(
    'The mean trades-per-day over the whole of orca’s index is 11,050, and August 2025 ran at 19,046 — nearly ' +
      'three times the quietest month. A fourteen-day window measured 8,527, so sizing anything off the short view ' +
      'understates it by about a third.',
  )

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text:
        `Read from ${tail.meta.orcaHost}, ${formatUtc(Date.parse(tail.meta.fetchedAt))}. The live tail took ` +
        `${formatCount(tail.meta.elapsedMs)} ms for ${formatCount(tail.days.length)} days and is cached for thirty ` +
        `minutes; a stored month is fetched once and kept forever.`,
    }),
    el('ul', null, ...notes.map((note) => el('li', { text: note }))),
    livenessNotes(tail.meta.liveness),
  )
}
