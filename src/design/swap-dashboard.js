// One dashboard, two venues.
//
// This renders the canonical swap aggregate from `src/core/swaps.js`, whatever produced it.
// `/hyperfx/` and `/hydration/` are each about fifteen lines: fetch, hand the payload here,
// add whatever is genuinely venue-specific. Adding a third DEX adds a normaliser on the server
// and no dashboard code at all.
//
// The labels that differ between venues travel in `meta` — HyperFX counts "orders" stacked by
// "chain the order was placed on"; Hydration counts "trades" stacked by "how the trade was
// initiated". Those are the only differences that matter, and they are data, not branches.

import { append, clear, el, notice, statRow, statTile } from './dom.js'
import { lineChart, seriesColor, stackedBars } from './charts.js'
import { livenessNotes } from './liveness.js'
import { compact, fmtDay, money, money2, percent, shortAddr } from '../core/format.js'

export function renderSwapDashboard(host, data) {
  clear(host)
  const { meta } = data

  // How current the venue's index is, in the source's own words — built once here rather than
  // inside `dataNotes`, because the branch that matters most for it is the one that never
  // reaches `dataNotes`. "No trades in this window" and "the indexer stopped a fortnight ago"
  // render as the same empty page, and only this line tells them apart. A source that does not
  // assert liveness yields null and nothing is drawn.
  const line = livenessNotes(meta?.liveness)

  if (data.empty) {
    append(
      host,
      notice('warning', 'No trades in this window', `The source returned nothing for ${meta.window}.`),
      line ? el('section.meta', null, el('h2', { text: 'Data notes' }), line) : null,
    )
    return
  }

  append(
    host,
    headline(data),
    dailyCard(data),
    cumulativeCard(data),
    routesCard(data),
    accountsCard(data),
    concentrationCard(data),
    dailyTable(data),
    dataNotes(data, line),
  )
}

/* --------------------------------------------------------------------------- headline ---- */

function headline({ totals, meta }) {
  return statRow([
    statTile('Total volume', money2(totals.usd), `${compact(totals.trades)} ${meta.unitPlural}, ${totals.spanDays} days`, { hero: true }),
    statTile('Busiest day', money(totals.peak.usd), `${fmtDay(totals.peak.date)} · ${compact(totals.peak.count)} ${meta.unitPlural}`),
    statTile('Median active day', money(totals.medianActiveDay), `${totals.activeDays} days with activity`),
    statTile(
      'Settled',
      percent(totals.settledShare),
      `${compact(totals.settled)} of ${compact(totals.trades)} ${meta.unitPlural} completed`,
    ),
  ])
}

/* ------------------------------------------------------------------------ daily volume ---- */

function dailyCard(data) {
  const { venues, days, meta } = data
  const card = el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'Daily volume' }), el('p.note', { text: `Stacked by ${meta.venueLabel}. Days with no activity are drawn empty rather than dropped — a gap is information.` })),
  )

  // The legend carries the value, not just the name. That is the required relief for the three
  // palette hues that fall under 3:1 on the light surface, and it is the more useful legend.
  const legend = el('ul.legend')
  venues.forEach((venue, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${venue.venue} `),
        el('span.amt', { text: money(venue.usd) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot)
  // Deferred one frame: the chart measures its host, and inside this function the host is not
  // in the document yet, so every width would be zero.
  queueMicrotask(() => stackedBars(plot, { days, series: venues.map((v) => ({ label: v.venue })) }))
  return card
}

/* -------------------------------------------------------------------------- cumulative ---- */

function cumulativeCard({ days, meta }) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Cumulative volume' }),
      el('p.note', { text: `Every ${meta.unit} in ${meta.window}, added up in order.` }),
    ),
  )
  const plot = el('div.plot')
  append(card, plot)

  let running = 0
  const points = days.map((day) => (running += day.usd))
  queueMicrotask(() => lineChart(plot, { points, labelOf: (i) => days[i].date }))
  return card
}

/* ------------------------------------------------------------------------------ routes ---- */

/**
 * The top routes plus one "n others" row. The residual is grey rather than a ninth hue,
 * because it is a leftover and not a category.
 */
function routesCard({ routes, routesTotal }) {
  const top = routes.slice(0, 8)
  const rest = routes.slice(8)
  const rows = top.concat(
    rest.length
      ? [
          {
            route: `${(routesTotal ?? routes.length) - top.length} other routes`,
            usd: rest.reduce((s, r) => s + r.usd, 0),
            count: rest.reduce((s, r) => s + r.count, 0),
            rest: true,
          },
        ]
      : [],
  )
  const max = Math.max(...rows.map((r) => r.usd), 1)

  const list = el('div.rows')
  for (const row of rows) {
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: row.route }),
        el(
          'div.track',
          null,
          el('div.fill', {
            style: `width:${Math.max(0.4, (row.usd / max) * 100)}%;background:${row.rest ? 'var(--series-rest)' : 'var(--series-1)'}`,
          }),
        ),
        el('div.amt', null, document.createTextNode(money(row.usd)), el('span.cnt', { text: ` · ${compact(row.count)}` })),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Volume by route' }),
      el('p.note', { text: 'Which pair the money moved through, by value. The count after each bar tells a different story from the dollars.' }),
    ),
    list,
  )
}

/* ---------------------------------------------------------------------------- accounts ---- */

function accountsCard(data) {
  const { accounts, accountsTotal, totals, meta } = data
  const shown = accounts.length
  const total = accountsTotal ?? shown

  const stats = statRow([
    statTile('Active accounts', compact(totals.accounts), `addresses that placed ${meta.unitPlural}`),
    statTile('Top 4 share', percent(totals.topFourShare), `of all volume, ${money(totals.topFourUsd)}`),
    statTile('Median account', money2(totals.medianAccount), `${compact(totals.accountsUnderHundred)} accounts under $100`),
    statTile('Top 10 share', percent(totals.topTenShare), 'the rest is a long tail'),
  ])

  const max = Math.max(accounts[0]?.usd ?? 1, 1)
  const list = el('div.rows')
  accounts.forEach((account, i) => {
    const isPallet = account.account.startsWith('pallet:')
    append(
      list,
      el(
        'div.row.rank-row',
        { tabindex: '0', title: `${account.venues}\n${account.routes}\nactive ${account.first} – ${account.last}` },
        el('div.rank', { text: String(i + 1) }),
        el('div.name', { text: isPallet ? account.account : shortAddr(account.account, 8, 6) }),
        el(
          'div.track',
          null,
          el('div.fill', {
            // A pallet account is not a trader. Same bar, different hue, and the label says so
            // — leaving it indistinguishable would put "the fee processor" at the top of a
            // list titled "who trades here".
            style: `width:${Math.max(0.35, (account.usd / max) * 100)}%;background:${isPallet ? 'var(--series-rest)' : 'var(--series-1)'}`,
          }),
        ),
        el('div.amt', { text: account.usd >= 1 ? money(account.usd) : `$${account.usd.toFixed(2)}` }),
        el('div.amt', null, el('span.cnt', { text: compact(account.count) })),
      ),
    )
  })

  const coverage =
    total > shown
      ? el('p.note', { text: `Showing the top ${shown} of ${compact(total)} accounts. The rest are smaller than the last row here; the shares above are computed over all of them, not just these.` })
      : null

  return el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'Accounts ranked by volume' })),
    stats,
    el('p.note', {
      text: 'Bars are linear from zero, so the tail is meant to look like a tail. An account is the address on the trade, which is not the same as a person: some route a partner’s flow, and some are not people at all.',
    }),
    el('div.scroll-y', null, list),
    coverage,
  )
}

/* ----------------------------------------------------------------------- concentration ---- */

function concentrationCard({ concentration }) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'How concentrated it is' }),
      el('p.note', { text: 'Share of all volume held by the top n accounts. A curve that reaches the ceiling in a handful of steps is a venue with a handful of users.' }),
    ),
  )
  const plot = el('div.plot')
  append(card, plot)
  queueMicrotask(() =>
    lineChart(plot, {
      points: concentration.map((c) => c.share),
      labelOf: (i) => `top ${concentration[i].rank} accounts`,
      format: (v) => percent(v, 1),
      color: 'var(--series-7)',
    }),
  )
  return card
}

/* --------------------------------------------------------------------------- the table ---- */

function dailyTable({ days, meta }) {
  const body = el('tbody')
  let running = 0
  for (const day of days) {
    running += day.usd
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: day.date }),
        el('td.num', { text: day.count ? compact(day.count) : '—' }),
        el('td.num', { text: day.usd ? money2(day.usd) : '—' }),
        el('td.num', { text: money2(running) }),
      ),
    )
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
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { text: 'Date' }),
            el('th.num', { text: meta.unitPlural }),
            el('th.num', { text: 'Volume' }),
            el('th.num', { text: 'Cumulative' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* --------------------------------------------------------------------------- the notes ---- */

/**
 * Where the numbers came from and what is wrong with them. This is not a disclaimer section —
 * it is the part that makes the rest usable, and it is generated from the same payload the
 * charts are drawn from, so it cannot describe a different dataset than the one on screen.
 */
function dataNotes({ meta, totals, rates }, livenessLine = null) {
  const list = el('ul')
  for (const note of meta.notes ?? []) append(list, el('li', { text: note }))

  if (totals.unpricedTrades) {
    append(
      list,
      el('li', {
        text: `${compact(totals.unpricedTrades)} ${meta.unitPlural} could not be valued — no asset on either leg ever traded against a dollar-pegged one in this window. They are counted in the ${meta.unit} count and excluded from the dollar total, so the two disagree by exactly that much.`,
      }),
    )
  }

  if (meta.unknownAssets?.length) {
    append(
      list,
      el('li', {
        text: `The asset registry has no symbol or decimals for ${meta.unknownAssets.length} asset id(s) seen in this window (${meta.unknownAssets.slice(0, 8).join(', ')}). Those legs are valued at nothing rather than guessed at.`,
      }),
    )
  }

  if (meta.unpricedTokens?.length) {
    append(
      list,
      el('li', {
        text: `No decimals or symbol on file for: ${meta.unpricedTokens.map((t) => `${t.token} (${t.legs} legs)`).join('; ')}. Those legs are valued at $0, which makes the total quietly low — naming the address is how the next person fixes it.`,
      }),
    )
  }

  if (meta.palletTrades) {
    append(
      list,
      el('li', {
        text: `${compact(meta.palletTrades)} of the ${meta.unitPlural} here were placed by pallet accounts rather than people — protocol machinery recycling fees and executing schedules — worth ${money(meta.palletUsd)}. They are in the totals because the money did move, and labelled so they cannot be mistaken for traders.`,
      }),
    )
  }

  const derived = Object.entries(rates ?? {})
    .filter(([, rate]) => rate !== 1)
    .slice(0, 10)
    .map(([symbol, rate]) => `${symbol} $${rate < 0.01 ? rate.toPrecision(3) : rate.toFixed(rate < 100 ? 4 : 0)}`)

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Read from ${meta.sourceLabel} (${meta.sourceUrl}) covering ${meta.window}. Snapshot taken ${new Date(meta.fetchedAt).toUTCString()}.`,
    }),
    // Ahead of the caveats about the numbers, because it is the caveat about whether the
    // numbers are of today. Absent for a venue whose source asserts nothing.
    livenessLine,
    list,
    derived.length
      ? el('p', { text: `Rates derived from the trades themselves in this window: ${derived.join(' · ')}. Dollar-pegged assets are held at $1.` })
      : null,
    el('p', null, document.createTextNode('Venue: '), el('a', { href: meta.venueUrl, text: meta.venue })),
  )
}
