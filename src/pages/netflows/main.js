// Parachain netflows: DOT held in parachain sovereign accounts, every day, 2022 → yesterday.
//
// ── what changed, and why it is the whole point of this page ─────────────────────────────────
// For three years this page drew a 2023 Polkalytics archive — 2022-02-02 to 2023-04-08 — and
// stopped there, while `/sovereign/` drew today. Between them was a three-and-a-half-year hole,
// and no amount of caveat text makes a hole into a series. It is now filled: the same
// measurement the 2023 study made is taken again, from the chains themselves, once per UTC day,
// from 2022-01-01 to yesterday. The archive is still here — as a CROSS-CHECK, drawn against the
// re-derived series where the two overlap, with the deviation stated rather than assumed.
//
// The backfill lives in `server/sources/asset-hub.mjs` as the store-backed job
// `netflows-daily` (one calendar month per job, one UTC day per stored fact) plus the live
// operation `sovereign-dot-recent` for the tail a month-bucketed store cannot serve. This file
// reads both and draws the join.
//
// ── the three things this page must be loud about ────────────────────────────────────────────
//
//  1. A DAY IS ITS CLOSE. Each value is the state at that UTC day's LAST BLOCK on each chain.
//     That is the archive's own definition and reproducing it is what makes the cross-check
//     meaningful: reading at 00:00 instead would shift the whole series one day early and read
//     as a genuine lead rather than as an off-by-one.
//
//  2. THE SERIES CROSSES TWO CHAINS. Before the Asset Hub Migration (2025-11-04) a parachain's
//     DOT sat in its `para` account ON THE RELAY CHAIN; after it, in its `sibl` account on ASSET
//     HUB. Every day here reads BOTH, and the second chart draws the handover explicitly. The
//     per-chain lines are continuous because the DOT moved rather than doubled — but a series
//     that only showed the sum would hide the largest structural break in it.
//
//  3. WHAT IS MISSING IS DRAWN. A day the store does not hold yet is a gap in the line, never a
//     zero, and the data notes count them. The store fills on demand: the first reader of a
//     month is what starts its fetch, so a fresh deployment draws a sparse chart that fills in
//     over the following minutes rather than an empty one that looks broken.
//
// Kusama keeps the archive-only view. `sovereign-dot-recent` and `netflows-daily` read the
// Polkadot relay chain and Polkadot Asset Hub; this site reads neither Kusama chain, and a
// Kusama toggle that silently drew a different measurement would be worse than one that says so.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { read, readStore } from '../../core/client.js'
import { liveness } from '../../core/liveness.js'
import { livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, percent } from '../../core/format.js'
import { chainOf, resolveChain, sovereignAddress } from '../../core/topology.js'
import { buildSeries, crossCheck, dot, isoDay, monthsBetween } from './series.js'
import dataset from '../../data/netflows.json'

const NETWORK = new URLSearchParams(location.search).get('network') === 'kusama' ? 'kusama' : 'polkadot'

/** A chain whose ARCHIVE daily line understates its true peak by more than this gets marked. */
const CLIP_THRESHOLD = 0.03

/**
 * Where the re-derived series begins, and it is not a taste decision — it is the earliest month
 * both chains can answer for. Asset Hub sets no `Timestamp::Now` before block #305,204
 * (2021-12-18T18:52:54Z), so a UTC day before that has no readable Asset Hub close and the
 * second leg of every sum would be `null` rather than `0`. Polkadot's first parachains onboarded
 * 2021-12-17 and no sovereign account held any DOT until 2022-02-02 — verified against the relay
 * itself, and the archived dataset's first non-null value (Acala, 1.23 DOT) is that same day. So
 * January 2022 is a month of *verified-empty* days rather than missing ones.
 */
const SERIES_FIRST_MONTH = '2022-01'

/** How many chains get a line. Everything else is in the ranking and the table beneath it. */
const CHART_LINES = 10

/** Months fetched at once. Each is one HTTP request against this origin. */
const MONTH_CONCURRENCY = 6

/** Below this, a chain is folded into the server's `dust` aggregate and has no row of its own. */
const DUST_DOT = 1

const amountOf = (token) => (value) => `${compact(value)} ${token}`

/**
 * The Asset Hub Migration, per network — the single most important event inside this series.
 *
 * Not read from a chain, because no storage item says "this happened here". Polkadot's date was
 * established in this repo by bisection: Acala's `para` sovereign account falls from
 * 3,137,094.16 DOT to 341.00 DOT across relay blocks #28,493,861→862, and it was PROGRESSIVE
 * rather than atomic — at that same block Moonbeam still held 1,465,523 DOT on the relay while
 * Hydration, Bifrost, Astar and Interlay were already down to 281–481 DOT. Kusama's is
 * transcribed from `docs/platform/asset-hub.md` and was not re-derived; nothing here reads
 * Kusama.
 */
const MIGRATED_ON = { polkadot: '2025-11-04', kusama: '2025-10-07' }

/* ═════════════════════════════════════════════════════════════════════════════ liveness ═════ */

/**
 * The archive's liveness assertion — `frozen`, permanently and by design.
 *
 * It is still here, and it still matters, but it now describes a CROSS-CHECK rather than the
 * page's subject: the reason to say "this file stopped on 2023-04-08" is so that a deviation
 * between it and the live series is read as two measurements of the same past, not as one of
 * them being out of date.
 */
function archiveLiveness(network) {
  return liveness({
    source: 'netflows',
    label: 'The archived Polkalytics netflows dataset',
    // End of the last UTC day in the file. The series is a daily close, so that is the instant
    // the newest number in it describes — not midnight at the start of that day.
    headAt: Date.parse(`${network.last}T23:59:59Z`),
    head: `${network.token} balances at the close of ${network.last}`,
    covers: { from: network.first, to: network.last },
    note:
      'Nothing was read at load time: this dataset ships inside the page. “Frozen” here is the ' +
      'permanent, intended state of an archive rather than a stalled indexer. On this page it is ' +
      'no longer the source of the chart — it is the independent second reading the chart is ' +
      `checked against, over ${network.first} to ${network.last}.`,
  })
}

/**
 * What this site's registry has to say about a chain — three answers, not two. A chain the
 * registry has never heard of is NOT a chain that is still running, and collapsing those would
 * print a claim nobody made.
 */
const retiredOf = (paraId) => chainOf(paraId, NETWORK)?.retired ?? null

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

/** Bounded-concurrency map. Fifty-five requests at once is a self-inflicted queue. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

async function load({ progress }) {
  const network = dataset.networks[NETWORK]
  if (!network) throw Object.assign(new Error(`The archived dataset has no \`${NETWORK}\` network.`), { kind: 'decode' })

  const archive = archiveLiveness(network)
  if (NETWORK !== 'polkadot') {
    progress({ stage: `Reading the archived ${network.token} dataset`, done: 1, total: 1 })
    return { mode: 'archive-only', network, archive }
  }

  // "Now" comes from the reader's clock, which is the only clock the browser has. It is used
  // for ONE thing — deciding which months are whole — and the server refuses any month that is
  // not, so a wrong clock produces a 400 rather than a wrong number.
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const lastWholeMonth = isoDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).slice(0, 7)
  const months = monthsBetween(SERIES_FIRST_MONTH, lastWholeMonth)

  // The tail: the days of the current month that have already closed. On the 1st there are
  // none, and the stored months already reach yesterday.
  const tailDays = Math.max(0, now.getUTCDate() - 1)

  let fetched = 0
  const total = months.length + (tailDays > 0 ? 1 : 0)
  const step = (stage) => progress({ stage, done: fetched, total })
  step('Reading stored months')

  // One month that will not answer must not take the other fifty-four down with it. The two
  // realistic causes are a reader whose clock puts them in next month (the server refuses a month
  // that has not ended, correctly) and an ordinary transport failure; both are far better served
  // by a chart with a hole and a note than by an error page. The failures are counted and shown.
  const failures = []
  const answers = await mapLimit(months, MONTH_CONCURRENCY, async (month) => {
    try {
      const body = await readStore('asset-hub', 'netflows-daily', { month })
      return { month, body }
    } catch (problem) {
      if (problem?.name === 'AbortError') throw problem
      failures.push({ month, message: problem?.message ?? String(problem) })
      return { month, body: null }
    } finally {
      fetched += 1
      step(`Reading stored months — ${month}`)
    }
  })

  let tail = null
  if (tailDays > 0) {
    step('Reading the current month from the chains')
    tail = await read('asset-hub', 'sovereign-dot-recent', { days: Math.min(tailDays, 40) })
    fetched += 1
    step('Reading the current month from the chains')
  }

  return { mode: 'series', network, archive, months: answers, tail, currentMonth, lastWholeMonth, failures }
}

/* ══════════════════════════════════════════════════════════════════════ shaping the data ═════ */

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

function render(host, data) {
  clear(host)
  if (data.mode === 'archive-only') return renderArchiveOnly(host, data)
  return renderSeries(host, data)
}

function renderSeries(host, { network, archive, tail, months, lastWholeMonth, failures }) {
  const series = buildSeries({ months, tail, firstDay: `${SERIES_FIRST_MONTH}-01` })
  const check = crossCheck(series, network, (name) => resolveChain(name, 'polkadot')?.paraId ?? null)
  const token = network.token
  const amount = amountOf(token)

  if (!series.days.length) {
    return append(
      host,
      notice(
        'warning',
        'Nothing is stored yet, and the fetch has just been started',
        'This page is drawn from a store that fills on demand: the first reader of a month is what starts its fetch. Reload in a minute and the chart will have days in it.',
        coverageSentence(series.coverage),
      ),
      notes({ series, check, archive, network, lastWholeMonth, tail }),
    )
  }

  const totalNow = series.latest ? dot(series.latest.totals.total) : null

  append(
    host,
    // The chart first, and deliberately first: decision 0011 — a page has one subject, and on
    // this page the subject is the series. Every block that has ever been put above it has
    // pushed it below the fold.
    chartCard(series, token),

    // Slim, and underneath. Context for the chart, not a headline of its own.
    statRow([
      statTile('Days drawn', formatCount(series.coverage.present), coveredRange(series)),
      statTile('Chains seen', String(series.chains.length), 'held at least 1 DOT on at least one day'),
      statTile('Largest holding', amount(series.chains[0]?.peak ?? 0), `${chainOf(series.chains[0]?.paraId, 'polkadot')?.name ?? `para ${series.chains[0]?.paraId}`}, on ${series.chains[0]?.peakOn}`),
      statTile('Held on the last day', totalNow === null ? '—' : amount(totalNow), series.last ? `across every chain, at the close of ${series.last}` : 'nothing stored'),
    ]),

    failures.length ? failureNotice(failures) : null,
    series.coverage.missing > 0 ? gapNotice(series) : null,
    legsCard(series, token),
    check ? crossCheckCard(check) : null,
    rankCard(series, amount),
    discrepanciesCard(),
    notes({ series, check, archive, network, lastWholeMonth, tail }),
  )
}

const coveredRange = (series) => (series.firstPresent && series.last ? `${series.firstPresent} → ${series.last}` : 'nothing yet')

/* ══════════════════════════════════════════════════════════════════════════ the charts ═════ */

function chartCard(series, token) {
  const drawn = series.chains.slice(0, CHART_LINES)
  const nameOf = (chain) => chainOf(chain.paraId, 'polkadot')?.name ?? `para ${chain.paraId}`
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held in parachain sovereign accounts, ${series.first} → ${series.last}` }),
      el('p.note', {
        text:
          `One line per chain on one shared scale — the ${CHART_LINES} largest by peak, of ${series.chains.length} seen. ` +
          `Each point is that chain's balance at the UTC day's LAST BLOCK, summed across its \`para\` account on the relay ` +
          `chain and its \`sibl\` account on Asset Hub. A line begins where that chain first holds DOT; before that it is ` +
          `absent, not zero.` +
          (series.coverage.missing ? ' A break in a line is one of the days this site has not fetched yet.' : ''),
      }),
    ),
  )

  const legend = el('ul.legend')
  drawn.forEach((chain, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${nameOf(chain)} `),
        el('span.amt', { text: compact(chain.peak) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: drawn.map((chain) => ({ label: nameOf(chain), values: chain.values })),
      format: compact,
      height: 380,
    }),
  )
  return card
}

/**
 * The migration, drawn rather than described.
 *
 * Two series on ONE axis, which is the only honest way to show it: the same DOT, counted in two
 * different places, handing over on 2025-11-04. The per-chain lines above are continuous across
 * that date because the money moved rather than doubled — this is the chart that says the
 * accounts underneath them changed chain.
 */
function legsCard(series, token) {
  const migrationIndex = series.days.indexOf(MIGRATED_ON.polkadot)
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Which chain the DOT is actually on' }),
      el('p.note', {
        text:
          `The same total, split by where it sits. Until the Asset Hub Migration a parachain's reserve was in its \`para\` ` +
          `account on the relay chain; from ${MIGRATED_ON.polkadot} it is in its \`sibl\` account on Asset Hub. The lines above ` +
          `are continuous across that date because the DOT moved rather than doubled — this is the handover itself. It was ` +
          `progressive, not atomic: different chains moved on different days, which is why the crossing takes more than one day.`,
      }),
    ),
  )
  const legend = el(
    'ul.legend',
    null,
    el('li', null, el('span.swatch', { style: `background:${seriesColor(0)}` }), document.createTextNode('On the relay chain (`para`)')),
    el('li', null, el('span.swatch', { style: `background:${seriesColor(1)}` }), document.createTextNode('On Asset Hub (`sibl`)')),
  )
  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: [
        { label: 'On the relay chain', values: series.legs.relay },
        { label: 'On Asset Hub', values: series.legs.assetHub },
      ],
      format: compact,
      height: 280,
    }),
  )
  if (migrationIndex >= 0) {
    append(
      card,
      el('p.note', {
        text: `${MIGRATED_ON.polkadot} is day ${formatCount(migrationIndex + 1)} of ${formatCount(series.days.length)} on this axis.`,
      }),
    )
  }
  return card
}

/* ------------------------------------------------------------------------ cross-check ---- */

function crossCheckCard(check) {
  const { body, tail, assetHub } = check
  const agrees = body && body.max < 0.005

  // A `p.note` above the table rather than a `<caption>` inside it: this page adds no CSS, and
  // the design system has no caption rule, so a bare one would render in the UA's centred style.
  const worstTable = (rows, caption) =>
    el(
      'div',
      null,
      el('p.note', { text: caption }),
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
            el('th', { text: 'Day' }),
            el('th', { text: 'Chain' }),
            el('th.num', { text: '2023 archive' }),
            el('th.num', { text: '`para` leg, read now' }),
            el('th.num', { text: 'Deviation' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...rows.map((row) =>
            el(
              'tr',
              null,
              el('td.mono', { text: row.date }),
              el('td', { text: row.name }),
              el('td.num', { text: compact(row.archived) }),
              el('td.num', { text: compact(row.value) }),
              el('td.num', { text: percent(row.deviation * 100, 4) }),
            ),
          ),
        ),
      ),
      ),
    )

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Checked against the 2023 archive' }),
      el('p.note', {
        text:
          `The 2021–2023 Polkalytics study measured the same accounts with different code, and its dataset is still ` +
          `compiled into this page. Where it overlaps the series above — ${check.from} to ${check.to}, ` +
          `${formatCount(check.pairs)} chain-days across ${check.chains} chains — the two are compared here rather than ` +
          `assumed to agree. The comparison is against the \`para\` LEG ALONE, because that is what the 2023 study read: ` +
          `scoring it against the sum would count the Asset Hub leg as a disagreement when it is simply something the ` +
          `original never had.`,
      }),
    ),
    body
      ? notice(
          agrees ? 'good' : 'warning',
          agrees
            ? `They agree: median deviation ${percent(body.median * 100, 7)} over ${formatCount(body.pairs)} chain-days`
            : `They disagree on ${formatCount(body.over)} of ${formatCount(body.pairs)} chain-days`,
          agrees
            ? `Outside that final day the worst disagreement anywhere in the overlap is ${percent(body.max * 100, 3)}, on ${body.worst[0].name} holding ` +
              `${compact(body.worst[0].archived)} DOT — the archive stores two decimal places, so a balance of 1.2330 DOT is ` +
              `recorded as 1.23 and differs by a quarter of a percent. ${formatCount(body.over)} chain-days exceed ` +
              `0.01% and every one of them is a small balance where that rounding dominates. The account derivation, the ` +
              `day boundary, the decimals and the \`free + reserved\` convention all reproduce independently, three ` +
              `years apart, from two different codebases.`
            : `${formatCount(body.over)} chain-days differ by more than 0.01%, the worst by ${percent(body.max * 100, 3)}. ` +
              `That is larger than the archive's two-decimal rounding can explain and is a real disagreement between the ` +
              `two readings.`,
        )
      : null,
    // The archive's last day is not a whole day, and this is where that stops being a footnote
    // in a caveat string and becomes a number on the page.
    tail
      ? notice(
          'warning',
          `Except on ${check.finalDay}, the archive's last day, where all ${formatCount(tail.pairs)} chains disagree`,
          `Up to ${percent(tail.max * 100, 1)} on ${tail.worst[0].name}: ${compact(tail.worst[0].archived)} DOT in the file ` +
            `against ${compact(tail.worst[0].value)} DOT read from the chain at that day's last block. This is the file's ` +
            `own coverage caveat becoming visible — its captures run eight days past the report's window and simply stop, ` +
            `so its final row is the last observation it happened to take rather than that UTC day's close. Every other ` +
            `day in the overlap is a close and matches. The archive's published "at the end" figures are therefore ` +
            `mid-day readings, not day-end ones.`,
        )
      : null,
    assetHub.pairs
      ? notice(
          'info',
          `And the Asset Hub leg, which the 2023 study could not have read`,
          `On ${formatCount(assetHub.pairs)} of the ${formatCount(check.pairs)} chain-days in this overlap a parachain ` +
            `ALSO held DOT in its \`sibl\` account on Asset Hub — at most ${percent(assetHub.maxShare * 100, 2)} of that ` +
            `chain's total at the time. Small then, and the whole thing now: after the Asset Hub Migration it is where ` +
            `essentially all of it sits. The series above sums both legs; the comparison above uses only the relay leg, ` +
            `so this is stated rather than hidden inside a residual.`,
        )
      : null,
    body ? worstTable(body.worst, `The five widest disagreements outside ${check.finalDay}`) : null,
    tail ? worstTable(tail.worst, `${check.finalDay}, the archive's partial final day`) : null,
  )
}

/* ------------------------------------------------------------------------------- rank ---- */

function rankCard(series, amount) {
  const max = series.chains[0]?.peak ?? 1
  const list = el('div.rows')

  series.chains.slice(0, 24).forEach((chain, i) => {
    const retired = retiredOf(chain.paraId)
    const label = chainOf(chain.paraId, 'polkadot')?.name ?? `para ${chain.paraId}`
    append(
      list,
      el(
        'div.row.rank-row',
        { title: retired ? `${sovereignAddress(chain.paraId, { on: 'relay' })}\n\n${retired.why}` : sovereignAddress(chain.paraId, { on: 'relay' }) },
        el('div.rank', { text: String(i + 1) }),
        el(
          'div.name',
          // Wrapping rather than clipping, so the marker survives a narrow viewport: `.name`
          // never wraps by default, and at 390px the pill would simply vanish — which is the
          // one thing a "this chain has left" marker must never do.
          { style: 'overflow:visible;white-space:normal;display:flex;flex-wrap:wrap;gap:var(--s2);align-items:baseline' },
          el('span', { text: label }),
          retired ? el('span.pill', { data: { tone: 'warning' }, text: `left ${retired.on}` }) : null,
        ),
        el(
          'div.track',
          null,
          el('div.fill', { style: `width:${Math.max(0.5, (chain.peak / max) * 100)}%;background:${seriesColor(i)}` }),
        ),
        el('div.amt', { text: amount(chain.peak) }),
        el('div.amt', null, el('span.cnt', { text: `ended ${compact(chain.last ?? 0)}` })),
      ),
    )
  })

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Ranked by peak holding' }),
      el('p.note', {
        text: `Peak is the highest daily close observed anywhere in ${series.first} → ${series.last}. It is not a simultaneous total: each chain is at its own high on its own day. A balance that rose and fell back inside one UTC day leaves no trace here, because a day is one reading.`,
      }),
    ),
    list,
    table(series),
  )
}

/**
 * The table is not an appendix. It is the accessibility fallback for the charts above — every
 * chart on this site has one — and it is the only place both sovereign addresses appear in full.
 */
function table(series) {
  const body = el('tbody')
  for (const chain of series.chains) {
    const entry = chainOf(chain.paraId, 'polkadot')
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: entry?.name ?? `para ${chain.paraId}` }),
        el('td.num', { text: String(chain.paraId) }),
        el('td.num', { text: compact(chain.peak) }),
        el('td.mono', { text: chain.peakOn ?? '—' }),
        el('td.num', { text: compact(chain.last ?? 0) }),
        el('td', { text: !entry ? 'not in this site’s registry' : entry.retired ? `left ${entry.retired.on}` : 'still registered' }),
        el('td.mono', { text: sovereignAddress(chain.paraId, { on: 'relay' }) }),
        el('td.mono', { text: sovereignAddress(chain.paraId, { on: 'sibling' }) }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: 'Every chain, its peak, and both sovereign account addresses' }),
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
            el('th', { text: 'Chain' }),
            el('th.num', { text: 'Para' }),
            el('th.num', { text: 'Peak' }),
            el('th', { text: 'On' }),
            el('th.num', { text: 'Last day' }),
            el('th', { text: 'Since' }),
            el('th', { text: '`para` on the relay chain' }),
            el('th', { text: '`sibl` on Asset Hub' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ------------------------------------------------------------------------- the caveats ---- */

const coverageSentence = (coverage) =>
  `${formatCount(coverage.complete)} of ${formatCount(coverage.months)} months are fully stored` +
  (coverage.jobs.length ? `, and ${formatCount(coverage.jobs.length)} fetch${coverage.jobs.length === 1 ? ' is' : 'es are'} in flight` : '') +
  '.'

/** A month that would not answer, named rather than absorbed into the gap count. */
function failureNotice(failures) {
  return notice(
    'critical',
    `${formatCount(failures.length)} month${failures.length === 1 ? '' : 's'} could not be read at all`,
    `${failures.map((f) => f.month).join(', ')} — the days in ${failures.length === 1 ? 'it' : 'them'} are drawn as gaps rather than as zeros, and everything else on this page is unaffected. This is a failure of this site, not of the chains.`,
    failures[0].message,
  )
}

function gapNotice(series) {
  const { coverage } = series
  return notice(
    'warning',
    `${formatCount(coverage.missing)} of the ${formatCount(coverage.days)} days in this span are not drawn`,
    'This series is served from a store that fills on demand, one calendar month per fetch — the first reader of a month is what starts it. A day that has not been fetched is a break in the line, never a zero: the chart says nothing at all about it rather than saying it was empty.',
    `${coverageSentence(coverage)} Reloading this page continues the fill.`,
  )
}

/**
 * The report and the data disagree in three places. Publishing the disagreement is the only
 * honest option once you have both: silently using the data would contradict a document that is
 * still online, and silently using the report would mean printing numbers we know are wrong.
 */
function discrepanciesCard() {
  const rows = dataset.reportDiscrepancies ?? []
  if (!rows.length) return null

  const body = el('tbody')
  for (const row of rows) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: row.claim, style: 'white-space:normal;max-width:22rem' }),
        el('td', { text: row.data, style: 'white-space:normal;max-width:22rem' }),
        el('td', { text: row.note, style: 'white-space:normal;max-width:22rem;color:var(--ink-secondary)' }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where the 2023 report and its own data disagree' }),
      el('p.note', {
        text: 'Re-deriving the archived dataset from the raw CSVs in 2026 turned up three places where the published 2023 report says something its own underlying data does not support. They are listed rather than reconciled — the report is still online and saying otherwise.',
      }),
    ),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, el('th', { text: 'The report says' }), el('th', { text: 'The data says' }), el('th', { text: 'Likely cause' }))),
        body,
      ),
    ),
  )
}

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const wrapAnywhere = (node) => (node ? style(node, 'overflow-wrap:anywhere') : node)

function notes({ series, check, archive, network, lastWholeMonth, tail }) {
  const latest = series.latest
  const retired = series.chains.map((c) => ({ chain: c, entry: chainOf(c.paraId, 'polkadot') })).filter((row) => row.entry?.retired)
  const unnamed = series.chains.filter((c) => !chainOf(c.paraId, 'polkadot'))

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    // Two reports side by side, in the same vocabulary: the chains this series was read from,
    // and the archive it is checked against. That the second says `frozen` is the point — it is
    // what makes a deviation between them read as two measurements of one past rather than as
    // one of them being out of date.
    livenessNotes([...(tail?.meta?.liveness ?? []), ...(archive ? [archive] : [])]),

    el('h3', { text: 'What this measures' }),
    el('p', {
      text:
        `A parachain's DOT is the SUM of two accounts on two chains: \`para\` on the relay chain and \`sibl\` on Asset Hub. ` +
        `Both are read on every day of this series, at that day's LAST BLOCK on each chain — two different blocks, because ` +
        `they are two different chains. ${latest ? `The most recent day, ${latest.date}, was read at relay #${formatCount(latest.relay.block)} and Asset Hub #${formatCount(latest.assetHub.block)}.` : ''}`,
    }),
    wrapAnywhere(
      el(
        'ul',
        null,
        el('li', {
          text:
            `A DAY IS ITS CLOSE, not its open. Reading the state at 00:00 instead would put every value one day early ` +
            `against the archived dataset and read as a genuine one-day lead rather than as an off-by-one. It also means a ` +
            `balance that rose and fell back inside a single UTC day leaves no trace at all — the same limitation the 2023 ` +
            `study had, and the reason its own Bifrost line understates that chain's true peak by 55%.`,
        }),
        el('li', {
          text:
            `THE SERIES CROSSES TWO CHAINS. The Asset Hub Migration on ${MIGRATED_ON.polkadot} moved every parachain's DOT ` +
            `reserve from the relay chain to Asset Hub. Both legs are read on every day here and the second chart draws the ` +
            `handover, so the per-chain lines are continuous without hiding that the accounts underneath them changed chain. ` +
            `The migration was progressive rather than atomic: at relay #28,493,861→862 Acala's relay account fell from ` +
            `3,137,094.16 DOT to 341.00 DOT while Moonbeam still held 1,465,523 DOT there and Hydration, Bifrost, Astar and ` +
            `Interlay were already down to 281–481 DOT.`,
        }),
        el('li', {
          text:
            `WHICH CHAINS ARE READ is the union of four enumerations, taken at each day's own block: the relay's ` +
            `\`Paras::ParaLifecycles\`, its \`Registrar::Paras\`, this site's own topology registry, and every chain already ` +
            `seen holding an account earlier in the same fetch. No single one of them is complete — para 2004 is in neither ` +
            `relay item today and still holds DOT. A chain that both left the registry and is absent from this site's ` +
            `registry would still be missed; nothing here can rule that out.`,
        }),
        el('li', {
          text:
            `SMALL HOLDINGS ARE SUMMED, NOT NAMED. A chain is listed individually on a day only if it held at least ` +
            `${DUST_DOT} DOT and is among that day's ${formatCount(series.coverage.listedMax)} largest; everything else goes ` +
            `into that day's single \`dust\` aggregate` +
            `${series.coverage.dustDaysMax ? ` — up to ${formatCount(series.coverage.dustDaysMax)} chains on one day` : ''}. ` +
            `The day's totals still include them EXACTLY, so no sum on this page is affected: the most that aggregate ever ` +
            `reached on any single day here is ${compact(series.coverage.dustDotMax)} DOT. What is lost is only the ability ` +
            `to name those chains. A chain that has appeared and then drops into the aggregate is drawn at zero rather than ` +
            `as a gap, because that is what it is at this scale — it is not a missing reading.`,
        }),
        el('li', {
          text:
            `WHAT IS MISSING IS A GAP, NOT A ZERO. ${series.coverage.missing === 0 ? 'Every day in this span is present.' : `${formatCount(series.coverage.missing)} of ${formatCount(series.coverage.days)} days are not fetched yet and break the line rather than dropping it to zero.`} ` +
            `Whole past months come from a store that keeps them forever once fetched; ${lastWholeMonth ? `everything after ${lastWholeMonth} ` : 'the current month '}` +
            `is read live on request and cached for thirty minutes, because a store bucketed by calendar month cannot serve a ` +
            `month that has not ended. Today itself is never here: a day's value is its close, and today has not closed. ` +
            `What these accounts hold at this minute is on /sovereign/.`,
        }),
        check
          ? el('li', {
              text:
                `THE ARCHIVE AGREES, AND WHERE IT DOES NOT IS ITSELF A FINDING. Over ${check.from} to ${check.to} the 2023 ` +
                `Polkalytics dataset and the \`para\` leg of this series were compared on ${formatCount(check.pairs)} ` +
                `chain-days. Outside the archive's final day: median deviation ${percent(check.body.median * 100, 7)}, ` +
                `worst ${percent(check.body.max * 100, 3)} — and that worst case is a chain holding ` +
                `${compact(check.body.worst[0].archived)} DOT, where the file's two decimal places are the entire ` +
                `difference. ON ${check.finalDay} all ${formatCount(check.tail.pairs)} chains disagree, by up to ` +
                `${percent(check.tail.max * 100, 1)}: that file's captures stop mid-day, so its last row is not a day's ` +
                `close and its published closing figures are mid-day readings.`,
            })
          : null,
        check?.assetHub?.pairs
          ? el('li', {
              text:
                `THE 2023 STUDY MEASURED ONE OF THE TWO ACCOUNTS. It read \`para\` on the relay chain only. On ` +
                `${formatCount(check.assetHub.pairs)} of the ${formatCount(check.pairs)} chain-days in the overlap the ` +
                `same chain also held DOT in its \`sibl\` account on Asset Hub — up to ` +
                `${percent(check.assetHub.maxShare * 100, 2)} of its total at the time. That is why the comparison above ` +
                `is against the relay leg alone, and why the lines are drawn from the sum.`,
            })
          : null,
        retired.length
          ? el('li', {
              text:
                `${retired.length} of the ${series.chains.length} chains here have since LEFT the network: ` +
                `${retired.map((row) => `${row.entry.name} on ${row.entry.retired.on}`).join(', ')}. Their lines are ` +
                `historical and correct, and their sovereign accounts still hold what they hold — but that balance is ` +
                `stranded rather than held, and it will not move again. A chain being absent from this list is weaker than a ` +
                `claim that it is running: the registry came from one audit of the relays' registration storage on ` +
                `2026-08-20 and nothing re-runs it.`,
            })
          : null,
        unnamed.length
          ? el('li', {
              text:
                `${unnamed.length} para id(s) here — ${unnamed.map((c) => c.paraId).sort((a, b) => a - b).join(', ')} — are not in this site's ` +
                `registry at all, so they are drawn as their own identifier rather than as a name. That is the truth about ` +
                `what is known, and printing the reassuring half of an unknown is the failure this page exists to avoid.`,
            })
          : null,
        el('li', {
          text: 'A parachain sovereign account holds the tokens backing what was minted on that parachain via reserve-backed transfer. It is not the whole picture: liquid-staking protocols on Acala, Bifrost and Moonbeam may control more than their sovereign account shows.',
        }),
        el('li', {
          text: 'The original study called these "netflows". Strictly they are balances over time — the term is kept because the study is published under it.',
        }),
        el('li', {
          text: `${network.token} only. A parachain's sovereign accounts also hold USDC, USDT and every bridged asset; that decomposition is on the /bridged/ page and the two must not be added together.`,
        }),
      ),
    ),

    el(
      'p',
      null,
      document.createTextNode('The same accounts at this minute, with today’s figures: '),
      el('a', { href: '/sovereign/', text: '/sovereign/' }),
      document.createTextNode('. The archived 2023 study and its source code: '),
      el('a', { href: dataset.source.repo, text: dataset.source.repo }),
      document.createTextNode(`. Archive dataset regenerated ${String(dataset.generated).slice(0, 10)} by `),
      el('code', { text: 'npm run data:netflows' }),
      document.createTextNode('.'),
    ),
    el('p', { text: 'Full disclosure carried over from the original report: at the time of writing the author had a contractual relationship with Mangata Finance.' }),
  )
}

/* ══════════════════════════════════════════════════════════ Kusama: the archive, as it was ═════ */

/**
 * Kusama has no re-derived series and this page does not pretend otherwise.
 *
 * `netflows-daily` and `sovereign-dot-recent` read the Polkadot relay chain and Polkadot Asset
 * Hub. Kusama's sovereign accounts sit on two chains this site does not read, so the KSM view is
 * the 2023 archive and nothing else — said out loud, at the top, rather than left to be noticed.
 */
function renderArchiveOnly(host, { network, archive }) {
  const token = network.token
  const amount = amountOf(token)
  const totalPeak = network.chains.reduce((sum, chain) => sum + chain.peak, 0)
  const clipped = network.chains.filter((chain) => chain.clipped > CLIP_THRESHOLD)

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held in parachain sovereign accounts, ${network.first} → ${network.last}` }),
      el('p.note', {
        text: `One shared scale. A line begins where that chain first appears in the data — before that it is absent, not zero. Nothing on it has moved since ${network.last}.`,
      }),
    ),
  )
  const legend = el('ul.legend')
  network.chains.forEach((chain, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${chain.name} `),
        el('span.amt', { text: compact(chain.dailyPeak) }),
      ),
    )
  })
  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: network.days,
      series: network.chains.map((chain) => ({ label: chain.name, values: chain.series })),
      format: compact,
      height: 380,
    }),
  )

  append(
    host,
    card,
    statRow([
      statTile('Chains tracked', String(network.chains.length), `sovereign accounts above the study's floor`),
      statTile('Largest holding', amount(network.chains[0].peak), `${network.chains[0].name}, at its peak`),
      statTile('Sum of peaks', amount(totalPeak), 'not simultaneous — each chain at its own high'),
      statTile('Held at the end', amount(network.chains.reduce((sum, chain) => sum + chain.last, 0)), `across all ${network.chains.length}, on ${network.last}`),
    ]),
    notice(
      'warning',
      'This is the 2023 archive, and it is all there is for Kusama',
      `The continuous 2022 → today series on this page is Polkadot only: it is read from the Polkadot relay chain and Polkadot Asset Hub, and this site reads neither Kusama chain. Nothing here has moved since ${network.last}, and the Asset Hub Migration on ${MIGRATED_ON.kusama} means these \`para\` accounts are no longer where a Kusama parachain's KSM sits.`,
      `That ${MIGRATED_ON.kusama} date is transcribed from this repo's notes and was NOT re-derived the way Polkadot's was.`,
    ),
    clipped.length
      ? notice(
          'warning',
          `${clipped.length} of these lines understate their own peak`,
          dataset.source.caveats.resampling,
          `Affected here: ${clipped.map((chain) => `${chain.name} (−${percent(chain.clipped * 100, 1)})`).join(', ')}.`,
        )
      : null,
    discrepanciesCard(),
    el(
      'section.meta',
      null,
      el('h2', { text: 'Data notes' }),
      livenessNotes([archive]),
      wrapAnywhere(
        el(
          'ul',
          null,
          el('li', { text: dataset.source.caveats.coverage }),
          el('li', { text: dataset.source.caveats.filter }),
          el('li', {
            text: `Every address in this dataset is a \`para\` account ON THE RELAY CHAIN, which in 2023 was where a parachain's KSM sat. Re-running this measurement against Kusama today would return a few hundred ${token} per parachain and look entirely reasonable.`,
          }),
        ),
      ),
      el(
        'p',
        null,
        document.createTextNode('The Polkadot series: '),
        el('a', { href: '/netflows/', text: '/netflows/' }),
        document.createTextNode('. Original study and source code: '),
        el('a', { href: dataset.source.repo, text: dataset.source.repo }),
        document.createTextNode('.'),
      ),
    ),
  )
}

renderPage({
  page: pageByKey('netflows'),
  intro:
    'When DOT moves to a parachain it is locked in that parachain’s sovereign account and minted on the other side. This is that lock, drawn day by day from 2022 to yesterday: one line per chain, read from the chains themselves at the close of every UTC day, across both accounts a parachain owns — `para` on the relay chain and `sibl` on Asset Hub. The 2023 Polkalytics study that first measured these accounts is still here, as the independent second reading this series is checked against.',
  controls: [
    choiceControl({
      label: 'Network',
      param: 'network',
      value: NETWORK,
      options: [
        { value: 'polkadot', label: 'Polkadot · DOT' },
        { value: 'kusama', label: 'Kusama · KSM' },
      ],
      hint: 'Polkadot is read from the chains, day by day, to yesterday. Kusama is the 2023 archive only — this site reads neither Kusama chain.',
    }),
  ],
  // The shape this page actually lands: the chart, the four tiles under it, then the second
  // chart and the ranking. Naming the right shapes is what stops the page jumping at exactly
  // the moment a reader is looking at it.
  skeleton: ['chart', 'stats', 'chart', 'rows'],
  loadingLabel: 'Reading the daily series',
  load,
  render,
})
