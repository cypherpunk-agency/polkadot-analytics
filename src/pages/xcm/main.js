// XCM message flow across Polkadot.
//
// This is the only page whose numbers are somebody else's aggregate rather than our own
// arithmetic: Dotlake pre-computes them and we render them. That shapes what the page is
// allowed to claim, and the one that matters is the dollar figure — see the note on
// `total_value_usd` below.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { seriesColor, stackedBars } from '../../design/charts.js'
import { compact, money, money2, percent } from '../../core/format.js'

const params = new URLSearchParams(location.search)
const RELAY = params.get('relay') === 'kusama' ? 'kusama' : 'polkadot'
const DAYS = Math.min(90, Math.max(7, Number(params.get('days')) || 30))

const isoDay = (offsetDays) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

/** Chain ids as Dotlake spells them, which is not always how people say them out loud. */
const CHAIN_LABEL = {
  statemint: 'Asset Hub',
  statemine: 'Asset Hub',
  hydradx: 'Hydration',
  polkadot: 'Relay chain',
  kusama: 'Relay chain',
  bridgehub: 'Bridge Hub',
  coretime: 'Coretime',
  people: 'People Chain',
  collectives: 'Collectives',
  assethub: 'Asset Hub',
}

const label = (chain) => CHAIN_LABEL[chain] ?? (chain ?? 'unknown')

async function load() {
  const window_hours = DAYS * 24
  // Three calls, fired together. They are independent, all cached server-side, and the page
  // needs all three before it can draw anything — so there is nothing to gain by staging them.
  const [summary, routes, daily] = await Promise.all([
    read('dotlake', 'xcm-summary', { relay_chain: RELAY, window_hours: Math.min(720, window_hours) }),
    read('dotlake', 'xcm-top-routes', { relay_chain: RELAY, window_hours: Math.min(720, window_hours), limit: 24 }),
    read('dotlake', 'xcm-daily-stats', {
      relay_chain: RELAY,
      start_date: isoDay(DAYS),
      end_date: isoDay(0),
      group_by_route: false,
    }),
  ])
  return { summary: summary[0] ?? null, routes: routes ?? [], daily: daily ?? [] }
}

function render(host, { summary, routes, daily }) {
  clear(host)

  if (!summary) {
    append(host, notice('warning', 'No summary for this window', 'Dotlake returned no rows. The daily series below may still have data.'))
  } else {
    append(
      host,
      statRow([
        statTile('Messages', compact(summary.total_messages), `in the last ${DAYS} days`, { hero: true }),
        statTile('Delivered', percent(summary.success_rate, 1), `${compact(summary.completed_messages)} completed, ${compact(summary.failed_messages)} failed`),
        statTile('Median latency', `${Math.round(summary.median_latency_seconds)}s`, `p95 ${Math.round(summary.p95_latency_seconds)}s`),
        statTile('Matched', percent((summary.matched_messages / Math.max(1, summary.total_messages)) * 100, 1), 'origin and arrival both observed'),
      ]),
    )
  }

  append(host, dailyCard(daily), routesCard(routes), valueNote(summary, routes), notes())
}

/* ------------------------------------------------------------------------ daily volume ---- */

function dailyCard(rows) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Messages per day' }),
      el('p.note', {
        text: 'Counted on the origin side, so a message that never arrived is still counted here. That is deliberate — a spike in messages that did not land is exactly the thing worth seeing.',
      }),
    ),
  )

  // Field names vary a little across Dotlake's endpoints, so read defensively rather than
  // assuming one spelling. A renamed field must surface as an empty chart with a notice, never
  // as NaN quietly drawing nothing.
  const days = rows
    .map((row) => {
      const total = Number(row.total_messages ?? row.message_count ?? row.messages ?? 0)
      const failed = Number(row.failed_messages ?? 0)
      const completed = Number(row.completed_messages ?? Math.max(0, total - failed))
      // Neither completed nor failed: observed leaving, never observed arriving or reverting.
      // Its own segment, because "in flight or lost" is a third outcome and folding it into
      // either of the other two would be a claim we cannot support.
      const unresolved = Math.max(0, total - completed - failed)
      return {
        date: String(row.date ?? row.day ?? '').slice(0, 10),
        count: total,
        // `usd` is what the shared chart scales the column height by. Here the measure is
        // messages, not money — the axis formatter is swapped to match.
        usd: total,
        stack: [completed, unresolved, failed],
      }
    })
    .filter((row) => row.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  if (!days.length) {
    append(card, notice('warning', 'No daily rows', 'Dotlake returned an empty daily series for this window.'))
    return card
  }

  const series = [{ label: 'delivered' }, { label: 'unresolved' }, { label: 'failed' }]
  // Reserved status palette, not categorical hues: these segments are states, and a reader who
  // sees green-amber-red already knows which is which before reading the legend.
  const stateColors = ['var(--good)', 'var(--warning)', 'var(--critical)']
  const totals = series.map((_, i) => days.reduce((sum, day) => sum + day.stack[i], 0))
  const legend = el('ul.legend')
  series.forEach((entry, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${stateColors[i]}` }),
        document.createTextNode(`${entry.label} `),
        el('span.amt', { text: compact(totals[i]) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot, dailyTable(days))
  queueMicrotask(() => stackedBars(plot, { days, series, format: compact, colors: stateColors }))
  return card
}

function dailyTable(days) {
  const body = el('tbody')
  for (const day of [...days].reverse()) {
    append(body, el('tr', null, el('td', { text: day.date }), el('td.num', { text: compact(day.count) })))
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `Daily figures — ${days.length} days` }),
    el(
      'div.tablewrap.scroll-y',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, el('th', { text: 'Date' }), el('th.num', { text: 'Messages' }))),
        body,
      ),
    ),
  )
}

/* ----------------------------------------------------------------------------- routes ---- */

function routesCard(routes) {
  const rows = routes
    .map((route) => ({
      from: label(route.origin_chain),
      to: label(route.dest_chain),
      count: Number(route.message_count ?? 0),
      completed: Number(route.completed_messages ?? 0),
      usd: Number(route.total_value_usd ?? 0),
      latency: Number(route.avg_latency_seconds ?? 0),
    }))
    .sort((a, b) => b.count - a.count)

  const max = Math.max(...rows.map((r) => r.count), 1)
  const list = el('div.rows')
  rows.forEach((route, i) => {
    const delivered = route.count ? (route.completed / route.count) * 100 : 0
    append(
      list,
      el(
        'div.row',
        { title: `${compact(route.completed)} of ${compact(route.count)} delivered · avg ${Math.round(route.latency)}s` },
        el('div.name', { text: `${route.from} → ${route.to}` }),
        el(
          'div.track',
          null,
          el('div.fill', { style: `width:${Math.max(0.5, (route.count / max) * 100)}%;background:${seriesColor(Math.min(i, 7))}` }),
        ),
        el(
          'div.amt',
          null,
          document.createTextNode(compact(route.count)),
          el('span.cnt', { text: ` · ${percent(delivered)} landed · ${route.usd > 0 ? money(route.usd) : 'unpriced'}` }),
        ),
      ),
    )
  })

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Busiest routes' }),
      el('p.note', {
        text: 'Restricted to matched messages — ones whose arrival was actually observed, not just their departure. Counting unmatched messages would overstate every destination.',
      }),
    ),
    list,
  )
}

/* ------------------------------------------------------------------------------ notes ---- */

/**
 * The USD figure needs its own explanation rather than a footnote, because it is the number a
 * reader will quote and it is the number most likely to be wrong. Dotlake prices only the
 * assets it can resolve; unpriced routes come back as exactly 0.0, which reads as "no value
 * moved" when it means "we could not value it".
 */
function valueNote(summary, routes) {
  const unpriced = routes.filter((r) => !(Number(r.total_value_usd) > 0)).length
  return el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'What moved, in dollars' })),
    statRow([
      statTile('Priced value', summary ? money2(summary.total_value_usd) : '—', 'a floor, not a total'),
      statTile('Unpriced routes', `${unpriced} of ${routes.length}`, 'came back as exactly $0'),
    ]),
    notice(
      'info',
      'Read the dollar figure as a floor',
      'Dotlake values a message only when it can resolve the asset that moved. Everything it cannot resolve is reported as 0.0, which is indistinguishable from a message that genuinely moved nothing. So the message counts on this page are exact and the dollar figures are a lower bound — the true value moved is higher by an unknown amount.',
      'This is why the page leads with counts. A dashboard that led with the dollar number would be quoting a figure that is confidently, invisibly low.',
    ),
  )
}

function notes() {
  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Read from Parity's Dotlake API (api.data.parity.io), anonymous and public, covering the last ${DAYS} days on ${RELAY === 'kusama' ? 'Kusama' : 'Polkadot'}.`,
    }),
    el(
      'ul',
      null,
      el('li', { text: 'A "matched" message is one where both the departure and the arrival were observed. An unmatched message may have arrived and gone unrecorded, or may never have arrived — from the index alone the two are indistinguishable.' }),
      el('li', { text: 'Latency is measured between the observed origin and destination events, so it includes block time on both sides and is not a measure of the messaging layer alone.' }),
      el('li', { text: 'Chain names come from Dotlake and use the historical parachain identifiers — statemint is Asset Hub, hydradx is Hydration. They are relabelled here; the underlying data is not changed.' }),
    ),
    // The knowledge base, not the GitHub blob: the same file, rendered on this site, with the
    // "edit on GitHub" link on the page for anyone who wants to correct it.
    el('p', null, document.createTextNode('How XCM actually works is documented in '), el('a', { href: '/knowledge/platform/xcm/', text: 'docs/platform/xcm.md' }), document.createTextNode(', published in the knowledge base.')),
  )
}

renderPage({
  page: pageByKey('xcm'),
  intro:
    'Cross-consensus messages are how the chains in a Polkadot network talk to each other: a transfer, a remote call, a governance instruction. This is the traffic between them — who talks to whom, how much of it lands, and how long it takes.',
  controls: [
    choiceControl({
      label: 'Network',
      param: 'relay',
      value: RELAY,
      options: [
        { value: 'polkadot', label: 'Polkadot' },
        { value: 'kusama', label: 'Kusama' },
      ],
    }),
    choiceControl({
      label: 'Window',
      param: 'days',
      value: String(DAYS),
      options: [7, 14, 30, 90].map((n) => ({ value: n, label: `${n}d` })),
      hint: 'Summary and route figures cap at 30 days (720 hours), which is Dotlake’s limit; the daily series runs the full window.',
    }),
  ],
  load,
  render,
})
