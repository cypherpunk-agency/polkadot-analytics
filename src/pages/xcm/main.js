// XCM message flow across Polkadot.
//
// Two kinds of number share this page and they are not equally trustworthy, so they are not
// drawn the same way.
//
// **Message counts are exact.** Dotlake either saw a message or it did not. They lead, and the
// matrix — the first chart, and the biggest — is drawn in them.
//
// **Dollars are our arithmetic over somebody else's rows, and rows get thrown away.** The
// aggregate `total_value_usd` is unusable: it is 0.0 for anything Dotlake could not price AND
// it carries rows where an 18-decimal amount was labelled with 6 or 12, one of which is worth
// more than a whole honest year. So the value on this page is computed row by row by
// `dotlake.xcm-value`, under a stated exclusion rule, and every row it removed is named
// underneath the figure it was removed from. See "What moved, in dollars".

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { flowGraph, flowTable, matrix, matrixTable, seriesColor, stackedBars } from '../../design/charts.js'
import { livenessBanner } from '../../design/liveness.js'
import { isStale } from '../../core/liveness.js'
import { assumedChains, chainLabel, describeSovereign, resolveChain, unknownChains } from '../../core/topology.js'
import { compact, formatCount, money, money2, percent, shortAddr } from '../../core/format.js'

/** Exact digits for a dollar figure in a table, without collapsing 30 cents to "$0". */
const exactUsd = (value) => (Math.abs(Number(value)) >= 1 ? money2(value) : money(value))

const params = new URLSearchParams(location.search)
const RELAY = params.get('relay') === 'kusama' ? 'kusama' : 'polkadot'
const DAYS = Math.min(90, Math.max(7, Number(params.get('days')) || 14))
const EDGES = params.get('edges') === 'messages' ? 'messages' : 'value'

/** How many chains the two pictures draw. The tables always carry every one of them. */
const MATRIX_CHAINS = 22
const GRAPH_CHAINS = 22
/** Categorical slots before the residual. Nine hues would be eight hues and a lie. */
const ASSET_SLOTS = 7

const isoDay = (offsetDays) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

/** Every UTC day from `from` to `to` inclusive. */
function daySpan(from, to) {
  const out = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end && out.length < 400) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Every chain identifier on this page goes through the topology registry, so `statemint` reads
 * as Asset Hub and an id this repo has never heard of reads as itself rather than as "unknown".
 */
const label = (name) => chainLabel(name, RELAY)

async function load({ progress }) {
  const window_hours = Math.min(720, DAYS * 24)
  progress({ stage: 'Reading Dotlake — summary, routes and the daily series' })

  const [summary, routes, daily] = await Promise.all([
    read('dotlake', 'xcm-summary', { relay_chain: RELAY, window_hours }),
    read('dotlake', 'xcm-top-routes', { relay_chain: RELAY, window_hours, limit: 24 }),
    read('dotlake', 'xcm-daily-stats', {
      relay_chain: RELAY,
      // DAYS - 1: `isoDay(7)` to `isoDay(0)` is eight calendar days, and a control labelled
      // "7d" that draws eight bars is a chart nobody can reconcile with its own axis.
      start_date: isoDay(DAYS - 1),
      end_date: isoDay(0),
      group_by_route: false,
    }),
  ])

  // Deliberately second and alone: it pages the row-level endpoint up to twenty times, so it is
  // the slow half, and saying so is the difference between a wait and a hang.
  progress({ stage: `Reading ${DAYS} days of individual XCM messages`, note: 'Value is computed row by row, which means reading the rows.' })
  const value = await read('dotlake', 'xcm-value', {
    relay_chain: RELAY,
    start_date: isoDay(DAYS - 1),
    end_date: isoDay(0),
  })

  return { summary: summary[0] ?? null, routes: routes ?? [], daily: daily ?? [], value }
}

function render(host, { summary, routes, daily, value }) {
  clear(host)

  if (isStale(value?.liveness)) append(host, livenessBanner(value.liveness))

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

  const days = buildDaily(daily)
  append(
    host,
    dailyCard(days),
    matrixCard(value),
    graphCard(value),
    valueCard(value),
    sovereignCard(value),
    routesCard(routes),
    notes(value, days),
  )
}

/* ------------------------------------------------------------------------ daily volume ---- */

/**
 * The daily series, one entry per UTC day in the requested window — including the days Dotlake
 * did not return a row for at all.
 *
 * This is not a formality. Dotlake has a seven-day hole at 2026-07-09…07-15, and its daily
 * endpoint answers a 90-day window with 83 rows: the hole is simply absent. Drawing only what
 * came back compresses it out, and a fortnight of missing index reads as an ordinary fortnight
 * of traffic. A missing day is drawn as an empty column and counted, and `missing` keeps it
 * distinguishable from a genuine zero — Dotlake never returned a row saying "no messages".
 */
function buildDaily(rows) {
  // Field names vary a little across Dotlake's endpoints, so read defensively rather than
  // assuming one spelling. A renamed field must surface as an empty chart with a notice, never
  // as NaN quietly drawing nothing.
  const byDate = new Map()
  for (const row of rows ?? []) {
    const date = String(row.date ?? row.day ?? '').slice(0, 10)
    if (!date) continue
    const total = Number(row.total_messages ?? row.message_count ?? row.messages ?? 0)
    const failed = Number(row.failed_messages ?? 0)
    const completed = Number(row.completed_messages ?? Math.max(0, total - failed))
    // Neither completed nor failed: observed leaving, never observed arriving or reverting.
    // Its own segment, because "in flight or lost" is a third outcome and folding it into
    // either of the other two would be a claim we cannot support.
    const unresolved = Math.max(0, total - completed - failed)
    byDate.set(date, {
      date,
      count: total,
      missing: false,
      // `usd` is what the shared chart scales the column height by. Here the measure is
      // messages, not money — the axis formatter is swapped to match.
      usd: total,
      stack: [completed, unresolved, failed],
    })
  }
  if (!byDate.size) return []
  const dates = [...byDate.keys()].sort()
  const from = dates[0] < isoDay(DAYS - 1) ? dates[0] : isoDay(DAYS - 1)
  const to = dates.at(-1) > isoDay(0) ? dates.at(-1) : isoDay(0)
  return daySpan(from, to).map(
    (date) => byDate.get(date) ?? { date, count: 0, missing: true, usd: 0, stack: [0, 0, 0] },
  )
}

function dailyCard(days) {
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

  if (!days.length) {
    append(card, notice('warning', 'No daily rows', 'Dotlake returned an empty daily series for this window.'))
    return card
  }

  const series = [{ label: 'delivered' }, { label: 'unresolved' }, { label: 'failed' }]
  // Reserved status palette, not categorical hues: these segments are states, and a reader who
  // sees green-amber-red already knows which is which before reading the legend.
  const stateColors = ['var(--good)', 'var(--warning)', 'var(--critical)']
  const totals = series.map((_, i) => days.reduce((sum, day) => sum + day.stack[i], 0))
  append(card, legendOf(series.map((entry, i) => ({ label: entry.label, color: stateColors[i], amount: compact(totals[i]) }))))

  const missing = days.filter((day) => day.missing)
  if (missing.length) {
    append(
      card,
      notice(
        'warning',
        `${missing.length} day${missing.length === 1 ? '' : 's'} in this window returned no row at all`,
        `Dotlake's daily endpoint answered with ${days.length - missing.length} rows for a ${days.length}-day span. The missing days are drawn as empty columns rather than skipped, because dropping them compresses the gap out and a fortnight of missing index then reads as an ordinary fortnight of traffic.`,
        `An empty column here means "no row was returned", which is not the same as "no messages were sent" — nothing in the response says the second. Missing: ${missing.map((day) => day.date).join(', ')}.`,
      ),
    )
  }

  const plot = el('div.plot')
  append(card, plot, dailyTable(days))
  queueMicrotask(() => stackedBars(plot, { days, series, format: compact, colors: stateColors }))
  return card
}

function dailyTable(days) {
  const body = el('tbody')
  for (const day of [...days].reverse()) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: day.date }),
        // Not `0`. Dotlake returned nothing for this day, and writing a zero into the column
        // would be this page inventing a measurement.
        el('td.num', { text: day.missing ? 'no row' : formatCount(day.count) }),
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
        el('thead', null, el('tr', null, el('th', { text: 'Date' }), el('th.num', { text: 'Messages' }))),
        body,
      ),
    ),
  )
}

/** A `.legend` where every entry carries its value, which is what makes colour non-load-bearing. */
function legendOf(entries) {
  const list = el('ul.legend')
  for (const entry of entries) {
    append(
      list,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${entry.color}` }),
        document.createTextNode(`${entry.label} `),
        el('span.amt', { text: entry.amount }),
      ),
    )
  }
  return list
}

/* ------------------------------------------------------------- origin × destination ---- */

/** The chains this window saw, busiest first — the fixed order both pictures lay out in. */
const chainNodes = (value) =>
  (value?.chains ?? []).map((chain) => ({
    key: chain.name,
    id: chain.name,
    label: label(chain.name),
    group: resolveChain(chain.name, RELAY)?.kind ?? null,
    chain,
  }))

function matrixCard(value) {
  const card = el('section.card', null, el('header', null, el('h2', { text: 'Who talks to whom' })))
  const nodes = chainNodes(value)
  const corridors = value?.corridors ?? []

  if (!nodes.length || !corridors.length) {
    append(card, notice('warning', 'No corridors in this window', 'The row-level read returned no messages, so there is no matrix to draw.'))
    return card
  }

  const drawn = nodes.slice(0, MATRIX_CHAINS)
  const drawnKeys = new Set(drawn.map((node) => node.key))
  // Messages, not dollars. The matrix is the exact chart on this page and it stays exact: a
  // pair is either observed or it is not, and a pair with no entry is drawn as an outline
  // rather than as an empty-looking zero.
  const cells = corridors.map((c) => ({ row: c.from, col: c.to, value: c.messages, count: c.priced }))
  const hidden = corridors.filter((c) => !drawnKeys.has(c.from) || !drawnKeys.has(c.to))

  append(
    card,
    el('p.note', {
      text: `Origin down the side, destination across the top; the shade is how many messages went that way. A cyclic relation with two independent values per pair — what Asset Hub sends a parachain is not what that parachain sends back — which is why this is a matrix and not a Sankey. ${nodes.length} chains, ${corridors.length} corridors observed.`,
    }),
  )

  if (hidden.length) {
    append(
      card,
      el('p.note', {
        text: `The picture draws the ${drawn.length} busiest chains. ${hidden.length} corridor${hidden.length === 1 ? '' : 's'} touching a quieter chain ${hidden.length === 1 ? 'is' : 'are'} not in it, and ${hidden.length === 1 ? 'is' : 'are'} in the table below.`,
      }),
    )
  }

  const plot = el('div.plot')
  const table = el('div')
  append(card, plot, table)
  queueMicrotask(() => {
    matrix(plot, {
      rows: drawn,
      cols: drawn,
      cells: cells.filter((cell) => drawnKeys.has(cell.row) && drawnKeys.has(cell.col)),
      format: formatCount,
      unit: 'messages',
    })
    matrixTable(table, { rows: nodes, cols: nodes, cells, format: formatCount, unit: 'Messages' })
  })
  return card
}

/* ------------------------------------------------------------------------ corridor graph ---- */

function graphCard(value) {
  const card = el('section.card', null, el('header', null, el('h2', { text: 'The corridor graph' })))
  const nodes = chainNodes(value).slice(0, GRAPH_CHAINS)
  const keys = new Set(nodes.map((node) => node.id))
  const corridors = (value?.corridors ?? []).filter((c) => keys.has(c.from) && keys.has(c.to))

  if (!nodes.length) {
    append(card, notice('warning', 'Nothing to draw', 'The row-level read returned no corridors.'))
    return card
  }

  const byValue = EDGES === 'value'
  // A corridor whose every message was unpriced has `usd === 0`, and that is "we could not
  // value any of this", not "this moved nothing". It is dropped from the value view rather
  // than drawn as a hairline at zero — and the count of what was dropped is on the card.
  const edges = corridors
    .map((c) => ({ from: c.from, to: c.to, value: byValue ? (c.usd > 0 ? c.usd : null) : c.messages, count: c.messages }))
    .filter((edge) => edge.value !== null)
  const unvalued = byValue ? corridors.length - edges.length : 0

  append(
    card,
    el('p.note', {
      text: byValue
        ? 'Edge width and shade are the dollars that moved along a corridor, after the exclusions below. Nodes sit on a circle in a fixed order and their size means nothing — a circle’s area is the encoding people misread, and the number is one hover away.'
        : 'Edge width and shade are the number of messages along a corridor. Nodes sit on a circle in a fixed order and their size means nothing.',
    }),
  )

  if (unvalued) {
    append(
      card,
      notice(
        'info',
        `${unvalued} of ${corridors.length} corridors carried no message we could value`,
        'They are absent from this picture rather than drawn at zero, because "nothing we could price" and "nothing moved" are different facts and a zero-width edge would state the second. Every one of them appears in the matrix table above, with its exact message count.',
      ),
    )
  }

  const groups = [
    { key: 'relay', label: 'relay chain' },
    { key: 'system', label: 'system chain' },
    { key: 'parachain', label: 'parachain' },
  ]

  const plot = el('div.plot')
  const table = el('div')
  append(card, plot, table)
  queueMicrotask(() => {
    flowGraph(plot, { nodes, edges, groups, format: byValue ? money : formatCount, unit: byValue ? 'USD' : 'messages' })
    flowTable(table, { nodes, edges, format: byValue ? exactUsd : formatCount, unit: byValue ? 'USD' : 'Messages' })
  })
  return card
}

/* ------------------------------------------------------------------------------ value ---- */

function valueCard(value) {
  const card = el('section.card', null, el('header', null, el('h2', { text: 'What moved, in dollars' })))
  if (!value) {
    append(card, notice('critical', 'No row-level read', 'The value figures on this page come from individual message records, and none were returned.'))
    return card
  }

  const { totals, coverage } = value
  const pricedShare = totals.messages ? (totals.valued / totals.messages) * 100 : 0

  append(
    card,
    statRow([
      statTile('Value moved', money2(totals.includedUsd), `${compact(totals.included)} messages we could price and believe`, { hero: true }),
      statTile('Priced at all', percent(pricedShare, 1), `${compact(totals.noAsset)} carried no asset record, ${compact(totals.unpriced)} carried one with no price`),
      statTile('Rows excluded', formatCount(totals.excluded), totals.excluded ? `worth ${money(totals.excludedUsd)} if believed` : 'nothing tripped the rules'),
      statTile('Messages read', formatCount(coverage.read), coverage.complete ? 'every message in the window' : `of ${formatCount(coverage.matching)} in the window`),
    ]),
  )

  append(card, valueChart(value), assetTable(value), exclusionNotice(value), excludedTable(value))
  return card
}

/** Daily value, stacked by asset. Empty days inside the covered range are drawn as empty. */
function valueChart(value) {
  const days = value.daily ?? []
  if (!days.length) return notice('warning', 'No daily value', 'No day in the covered range carried a message we could price.')

  const top = (value.assets ?? []).filter((a) => a.usd > 0).slice(0, ASSET_SLOTS).map((a) => a.symbol)
  const series = [...top.map((symbol) => ({ label: symbol }))]
  const restCount = (value.assets ?? []).filter((a) => a.usd > 0).length - top.length
  if (restCount > 0) series.push({ label: `${restCount} other asset${restCount === 1 ? '' : 's'}` })

  const rows = days.map((day) => {
    const stack = top.map((symbol) => Number(day.byAsset?.[symbol] ?? 0))
    if (restCount > 0) {
      const rest = Object.entries(day.byAsset ?? {})
        .filter(([symbol]) => !top.includes(symbol))
        .reduce((sum, [, usd]) => sum + Number(usd), 0)
      stack.push(rest)
    }
    return { date: day.date, count: day.priced, usd: day.usd, stack }
  })

  const totals = series.map((_, i) => rows.reduce((sum, row) => sum + row.stack[i], 0))
  const wrap = el('div')
  append(
    wrap,
    el('p.note', {
      text: `Daily value by asset, over the ${rows.length} days the row-level read actually covered. A day with no bar is a day on which nothing we could price moved — it is drawn, not dropped, because a gap is information.`,
    }),
    legendOf(series.map((entry, i) => ({ label: entry.label, color: seriesColor(i), amount: money(totals[i]) }))),
  )
  const plot = el('div.plot')
  append(wrap, plot)
  queueMicrotask(() => stackedBars(plot, { days: rows, series, format: money }))
  return wrap
}

function assetTable(value) {
  const assets = value.assets ?? []
  if (!assets.length) return null
  const body = el('tbody')
  for (const asset of assets) {
    const conflicted = (asset.declaredDecimals ?? []).length > 1
    append(
      body,
      el(
        'tr',
        null,
        el('td', null, el('span.mono', { text: asset.symbol })),
        el('td.num', { text: formatCount(asset.messages) }),
        el('td.num', { text: asset.usd > 0 ? exactUsd(asset.usd) : '—' }),
        el('td.num', { text: asset.excluded ? formatCount(asset.excluded) : '—' }),
        el(
          'td',
          null,
          el('span.mono', { text: String(asset.decimals ?? '—') }),
          conflicted ? el('span.pill', { data: { tone: 'critical' }, text: `also ${asset.declaredDecimals.filter((d) => d !== asset.decimals).join(', ')}` }) : null,
        ),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `Assets — ${assets.length} symbols carried a value` }),
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
            el('th', { text: 'Asset' }),
            el('th.num', { text: 'Messages' }),
            el('th.num', { text: 'Value' }),
            el('th.num', { text: 'Excluded' }),
            el('th', { text: 'Decimals' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/**
 * The rule, in words, on the page. A dollar figure with rows removed from it is only honest if
 * the reader is told which rows and why — otherwise it is a second silent error replacing the
 * first one.
 */
function exclusionNotice(value) {
  const { rules, totals } = value
  const reasons = Object.entries(rules.reasons ?? {})
  if (!totals.excluded) {
    return notice(
      'good',
      'Nothing was excluded from this window',
      `Every one of the ${compact(totals.included)} priced messages passed all three checks: its asset's decimals agreed with the rest of that asset's rows, its amount was not a detached outlier among them, and none was worth more than ${money(rules.ceilingUsd)}. The figure above is the sum of them.`,
      'That is not a guarantee of correctness. It means the corruption this rule detects is absent here; longer windows do contain it.',
    )
  }
  return notice(
    'warning',
    `${compact(totals.excluded)} row${totals.excluded === 1 ? '' : 's'} left out, worth ${money(totals.excludedUsd)} if believed`,
    `Dotlake's per-message value is internally consistent — value is exactly raw_amount ÷ 10^decimals, every time — but the decimals themselves are sometimes wrong, and an 18-decimal amount labelled as 6 is a million times too big. Three checks, applied per row: ${reasons.map(([reason, n]) => `${n} ${reason}`).join(', ')}.`,
    `A row is out if its asset's declared decimals disagree with the rest of that asset's rows; or if its amount sits in a detached cluster at least ${rules.outlierDecades} orders of magnitude above every other amount of the same asset, and that cluster is under ${Math.round(rules.outlierMaxShare * 100)}% of them; or if the single message is worth more than ${money(rules.ceilingUsd)}. The ceiling is a judgement — the largest single message we have read and believe is about $1.05M — and it is the backstop for an asset whose rows are all corrupt.`,
    'Every excluded row is listed below with its amount. If one of them is real, it is visible here rather than deleted.',
  )
}

function excludedTable(value) {
  const rows = value.excluded ?? []
  if (!rows.length) return null
  const body = el('tbody')
  for (const row of rows) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: row.date }),
        el('td', null, el('span.mono', { text: row.symbol })),
        el('td', { text: `${label(row.from)} → ${label(row.to)}` }),
        el('td.num', { text: exactUsd(row.usd) }),
        el('td.num', null, el('span.mono', { text: row.rawAmount })),
        el('td.num', { text: String(row.decimals ?? '—') }),
        el('td', null, el('span.pill', { data: { tone: 'warning' }, text: row.reason })),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `Excluded rows — ${rows.length} shown, largest first` }),
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
            el('th', { text: 'Asset' }),
            el('th', { text: 'Corridor' }),
            el('th.num', { text: 'Booked at' }),
            el('th.num', { text: 'Raw amount' }),
            el('th.num', { text: 'Decimals' }),
            el('th', { text: 'Rule' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ------------------------------------------------------------------ sovereign accounts ---- */

/**
 * The accounts the corridors above actually move money into, derived rather than looked up.
 *
 * The distinction that carries this table: a chain has TWO sovereign accounts, and they hold
 * different money. `para` is what the relay chain calls it; `sibl` is what a sibling parachain
 * calls it. Since the Asset Hub migration completed on 2025-11-04 almost all of it is on Asset
 * Hub, under `sibl` — the relay `para` accounts hold about 23,677 DOT between all of them,
 * against 9.9M DOT on the Asset Hub side. A netflows chart that reads only the relay leg today
 * draws a few hundred DOT per parachain and is plausibly, completely wrong.
 */
function sovereignCard(value) {
  const known = (value?.chains ?? [])
    .map((chain) => ({ chain, entry: resolveChain(chain.name, RELAY) }))
    .filter(({ entry }) => entry && entry.paraId !== null)

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where the money sits' }),
      el('p.note', {
        text: 'Every chain above owns two accounts elsewhere, and a reserve-backed transfer moves real assets into one of them. They are derived here — literal `para`/`sibl` bytes plus the para id and trailing zeros, not a hash — and the derivation checks itself at load against two accounts this repository has already read on-chain.',
      }),
    ),
  )

  if (!known.length) {
    append(card, notice('info', 'No para ids to derive from', 'None of the chains in this window resolves to a para id in the topology registry.'))
    return card
  }

  const prefix = RELAY === 'kusama' ? 2 : 0
  const body = el('tbody')
  for (const { chain, entry } of known) {
    const relayAccount = describeSovereign(entry.paraId, { on: 'relay', network: RELAY, ss58Prefix: prefix })
    const sibling = describeSovereign(entry.paraId, { on: 'sibling', network: RELAY, ss58Prefix: prefix })
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: entry.name }),
        el('td.num', null, el('span.mono', { text: String(entry.paraId) })),
        el('td', { text: entry.kind }),
        el('td', null, el('span.mono', { text: shortAddr(relayAccount.address, 8, 6), title: relayAccount.address })),
        el('td', null, el('span.mono', { text: shortAddr(sibling.address, 8, 6), title: sibling.address })),
        el('td.num', { text: formatCount(chain.messages) }),
      ),
    )
  }

  append(
    card,
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
            el('th', { text: 'Chain' }),
            el('th.num', { text: 'Para' }),
            el('th', { text: 'Kind' }),
            el('th', { text: `On the relay (para)` }),
            el('th', { text: 'On Asset Hub (sibl)' }),
            el('th.num', { text: 'Messages' }),
          ),
        ),
        body,
      ),
    ),
    notice(
      'info',
      'Two accounts, and since November 2025 only one of them matters',
      'The Asset Hub migration completed on 2025-11-04. The relay-chain `para` accounts of all 89 registered paras held about 23,677 DOT between them when this repository last measured; the Asset Hub `sibl` accounts held 9,896,679. A chain\'s sovereign holding is the sum of both, and a chart built on the relay leg alone is not slightly low — it is off by two and a half orders of magnitude.',
      'These addresses are derived, not read. No balance on this page comes from them; they are here so a reader can go and look.',
    ),
  )
  return card
}

/* ----------------------------------------------------------------------------- routes ---- */

function routesCard(routes) {
  const rows = routes
    .map((route) => ({
      from: label(route.origin_chain),
      to: label(route.dest_chain),
      count: Number(route.message_count ?? 0),
      completed: Number(route.completed_messages ?? 0),
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
        { title: `${formatCount(route.completed)} of ${formatCount(route.count)} delivered · avg ${Math.round(route.latency)}s` },
        el('div.name', { text: `${route.from} → ${route.to}` }),
        el(
          'div.track',
          null,
          el('div.fill', { style: `width:${Math.max(0.5, (route.count / max) * 100)}%;background:${seriesColor(Math.min(i, 7))}` }),
        ),
        el(
          'div.amt',
          null,
          document.createTextNode(formatCount(route.count)),
          el('span.cnt', { text: ` · ${percent(delivered)} landed · avg ${Math.round(route.latency)}s` }),
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
      el('h2', { text: 'Busiest routes, and whether they land' }),
      el('p.note', {
        text: 'Restricted to matched messages — ones whose arrival was actually observed, not just their departure. Counting unmatched messages would overstate every destination. The dollar figure is deliberately absent here: this table is Dotlake’s own aggregate, and its value column is the one we do not use.',
      }),
    ),
    list,
  )
}

/* ------------------------------------------------------------------------------ notes ---- */

function notes(value, days = []) {
  const coverage = value?.coverage
  const missingDays = days.filter((day) => day.missing)
  const chains = (value?.chains ?? []).map((chain) => chain.name)
  const unnamed = unknownChains(chains, RELAY)
  const assumed = assumedChains(chains, RELAY)
  const conflicts = (value?.chains ?? []).filter((chain) => chain.paraIdConflicts > 0)
  const conflictRows = conflicts.reduce((sum, chain) => sum + chain.paraIdConflicts, 0)
  const emptyDays = (value?.daily ?? []).filter((day) => day.messages > 0 && day.usd === 0)

  const items = [
    `The four figures at the top of the page cover a rolling ${DAYS * 24}-hour window; everything below them covers ${DAYS} whole UTC days, the last of which is still in progress. The two do not have to agree, and on most days they will not — the headline count is not the sum of the bars.`,
    'A "matched" message is one where both the departure and the arrival were observed. An unmatched message may have arrived and gone unrecorded, or may never have arrived — from the index alone the two are indistinguishable.',
    'Latency is measured between the observed origin and destination events, so it includes block time on both sides and is not a measure of the messaging layer alone.',
    'Chain names come from Dotlake and use the historical parachain identifiers — statemint is Asset Hub, hydradx is Hydration. They are relabelled through src/core/topology.js; the underlying data is not changed.',
  ]

  if (coverage) {
    items.push(
      coverage.complete
        ? `The value figures read every one of the ${compact(coverage.matching)} messages in this window, ${coverage.coveredFrom} to ${coverage.coveredTo}.`
        : `The value figures read ${compact(coverage.read)} of the ${compact(coverage.matching)} messages in this window — the endpoint returns newest first and the read stops at ${compact(coverage.budget)} rows. What they cover is ${coverage.coveredFrom} to ${coverage.coveredTo}, and the daily value chart is drawn over that range only. The message counts above are unaffected; they come from Dotlake's own daily aggregate, which counts the whole window.`,
    )
  }

  if (missingDays.length) {
    items.push(
      `Dotlake's daily aggregate returned no row for ${missingDays.length} of the ${days.length} days in this window (${missingDays.map((day) => day.date).join(', ')}). Those columns are drawn empty. A known hole of this shape runs 2026-07-09 to 2026-07-15, and it is missing index rather than a quiet week — the totals in the legend above do not include whatever moved on those days.`,
    )
  }

  if (emptyDays.length) {
    items.push(
      `${emptyDays.length} day${emptyDays.length === 1 ? '' : 's'} in the covered range carried messages but no value at all (${emptyDays.map((day) => day.date).join(', ')}). Dotlake has known holes of this shape — a seven-day one in July 2026 — and a bar of zero height on those days means "no asset record", not "no value moved".`,
    )
  }

  if (conflicts.length) {
    items.push(
      `Dotlake's own para id disagrees with its own chain name on ${formatCount(conflictRows)} row${conflictRows === 1 ? '' : 's'}, across ${conflicts.length} chain${conflicts.length === 1 ? '' : 's'} (${conflicts.slice(0, 4).map((c) => `${label(c.name)}: ${c.paraIdConflicts} of ${c.paraIdRows}`).join('; ')}). The name is the field that holds up, so this page keys on the name and reports the disagreement rather than resolving it.`,
    )
  }

  if (unnamed.length) {
    items.push(
      `${unnamed.length} chain identifier${unnamed.length === 1 ? '' : 's'} in this window ${unnamed.length === 1 ? 'is' : 'are'} not in the topology registry, and appear${unnamed.length === 1 ? 's' : ''} above exactly as Dotlake sent ${unnamed.length === 1 ? 'it' : 'them'}: ${unnamed.map((name) => `“${name}”`).join(', ')}. “(unnamed)” is a row whose chain-name field was blank. None of them has a para id here, so none has a derived sovereign account either — an invented one would be a valid-looking address holding nothing.`,
    )
  }

  if (assumed.length) {
    items.push(
      `${assumed.length} chain name${assumed.length === 1 ? '' : 's'} on this page ${assumed.length === 1 ? 'is' : 'are'} transcribed rather than verified (${assumed.map((entry) => entry.name).join(', ')}) — nothing in this repository has checked that para id against a chain, and their derived sovereign accounts inherit that doubt.`,
    )
  }

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Read from Parity's Dotlake API (api.data.parity.io), anonymous and public, covering the last ${DAYS} days on ${RELAY === 'kusama' ? 'Kusama' : 'Polkadot'}. Message counts come from Dotlake's aggregates; every dollar figure is computed here from the individual message records.`,
    }),
    el('ul', null, ...items.map((text) => el('li', { text }))),
    el('p', null, document.createTextNode('How XCM actually works is documented in '), el('a', { href: '/knowledge/platform/xcm/', text: 'docs/platform/xcm.md' }), document.createTextNode(', published in the knowledge base.')),
  )
}

renderPage({
  page: pageByKey('xcm'),
  intro:
    'Cross-consensus messages are how the chains in a Polkadot network talk to each other: a transfer, a remote call, a governance instruction. This is the traffic between them — who talks to whom, how much of it lands, how long it takes, and what it was worth, minus the rows that could not be believed.',
  skeleton: ['stats', 'chart', 'chart'],
  loadingLabel: 'Reading Dotlake',
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
      hint: 'Summary and route figures cap at 30 days (720 hours), which is Dotlake’s limit. The row-level value read caps at 10,000 messages — about a fortnight — and says on the page how much of the window it reached.',
    }),
    choiceControl({
      label: 'Corridor graph',
      param: 'edges',
      value: EDGES,
      options: [
        { value: 'value', label: 'by value' },
        { value: 'messages', label: 'by messages' },
      ],
    }),
  ],
  load,
  render,
})
