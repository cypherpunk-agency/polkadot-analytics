// The HyperFX drill-down: individual orders, the rates they actually got, and one address at a
// time. Built entirely from `src/design` components — this file adds no CSS, and every dynamic
// dimension goes through the `style` prop on `el()`, never `setAttribute('style', …)`.
//
// Two things this view is careful about, because both are easy to get wrong and neither is
// visible when you do:
//
//   1. THE FILTER IS THE INDEXER'S, NOT OURS. Address, chain, status and day are applied
//      upstream, so the count beside the filter ("89 orders match") is a fact about the whole
//      history and the table under it is one page of that. Those are labelled as two different
//      numbers because they are.
//   2. AMOUNTS ARE PER-CHAIN. Every symbol/decimals pair arriving here was resolved on the
//      server against the chain the leg was on, and re-checked against the indexer's own token
//      registry. Nothing on this page keys anything by symbol.

import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { choiceControl } from '../../design/page.js'
import { compact, fmtDay, formatCount, formatDuration, formatUtc, money2, shortAddr } from '../../core/format.js'

/**
 * A count of things. `compact()` is built for chart axes and renders 3 as "3.00", which on a
 * page that says "3 orders" reads as a measurement rather than a tally. Exact below ten
 * thousand, where every digit is readable and the exact number is the useful one.
 */
const count = (value) => (Math.abs(Number(value) || 0) >= 10_000 ? compact(value) : formatCount(Math.round(Number(value) || 0)))

/**
 * A dollar figure small enough that rounding it to whole dollars would print "$0". Protocol
 * fees on this venue are cents; `money2` would erase them entirely.
 */
const usdExact = (value) => (Math.abs(Number(value) || 0) >= 1000 ? money2(value) : `$${(Number(value) || 0).toFixed(2)}`)

/* ------------------------------------------------------------------------------- links ---- */

/** The site's own URLs. Every filter lives in the query string, so any view here is linkable. */
export function hyperfxHref(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    query.set(key, String(value))
  }
  return `/hyperfx/${query.size ? `?${query}` : ''}`
}

/** The parameters the `orders` operation accepts. Anything else the URL carries stays here —
 *  the API rejects unknown parameters, and it is right to. */
export function ordersParamsFromUrl(search = location.search) {
  const query = new URLSearchParams(search)
  const params = {}
  for (const name of ['address', 'role', 'chain', 'status', 'date']) {
    const value = query.get(name)
    if (value) params[name] = value
  }
  const offset = Number(query.get('offset'))
  if (Number.isFinite(offset) && offset > 0) params.offset = Math.floor(offset)
  params.limit = 50
  return params
}

/** An address, as a link into this site's own view of it. This is the drill-down the research
 *  recommended: the indexer filters by address server-side, so following one costs one query
 *  rather than a download of everything. */
function addressLink(address, { chars = 6 } = {}) {
  if (!address) return el('span', { text: '—' })
  return el('a.mono', {
    href: hyperfxHref({ view: 'orders', address: String(address).toLowerCase() }),
    text: shortAddr(address, chars, 4),
    title: address,
  })
}

/** A transaction, as a link to the explorer of the chain it happened on. This is a LINK, not a
 *  fetch — the page never talks to an explorer, and `connect-src 'self'` would stop it if it
 *  tried. The URL was built server-side, where third-party hosts are allowed to be named. */
function txLink(hash, url, label) {
  if (!hash) return el('span', { text: '—' })
  const text = label ?? shortAddr(hash, 6, 4)
  return url ? el('a.mono', { href: url, text, title: hash, rel: 'noopener' }) : el('span.mono', { text, title: hash })
}

/* -------------------------------------------------------------------------- formatting ---- */

/** A token amount, in the token's own units. Adaptive rather than compacted: on this page the
 *  digits are the point — "193.3k cNGN" hides the rate the reader came to check. */
function tokenAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** An exchange rate, with enough significant figures to be worth reading at any magnitude. */
function rateText(rate, tokenIn, tokenOut) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  const shown = rate >= 1000 ? rate.toLocaleString('en-US', { maximumFractionDigits: 2 }) : rate.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '')
  return `1 ${tokenIn} = ${shown} ${tokenOut}`
}

const TONE = { FILLED: 'good', REDEEMED: 'good', REFUNDED: 'warning' }

function statusPill(status) {
  return el('span.pill', { text: status ?? '—', data: TONE[status] ? { tone: TONE[status] } : null })
}

/** A dollar figure that may legitimately be unknown. `null` is not `$0` and never renders as it. */
const usdOrUnknown = (value) => (value === null || value === undefined ? 'not valued' : usdExact(value))

/* ------------------------------------------------------------------------- the controls ---- */

/**
 * `choiceControl` deliberately rebuilds the WHOLE query string, so a page with two controls
 * cannot silently reset the other one. `offset` is the one parameter that must not survive:
 * it is paging, not a filter. Carried across a filter change it lands the reader on page three
 * of a result set with two rows in it — an empty table that is nobody's fault and looks like
 * an outage. Stripped here rather than in `choiceControl`, because "changing a filter returns
 * you to the first page" is this page's rule, not the design system's.
 */
function resetsPaging(control) {
  for (const link of control.querySelectorAll('a')) {
    const url = new URL(link.getAttribute('href'), location.href)
    url.searchParams.delete('offset')
    link.setAttribute('href', url.searchParams.size ? `?${url.searchParams}` : location.pathname)
  }
  return control
}

/**
 * The filter row. Every option is counted from the same snapshot the rows come from, so a
 * control can never offer a choice that returns an empty table, and each label carries its
 * count — the same "the legend carries the value" rule the charts follow.
 */
function controls(data) {
  const { facets, filter } = data
  const control = (spec) => resetsPaging(choiceControl(spec))

  return el(
    'div',
    null,
    control({
      label: 'View',
      param: 'view',
      value: 'orders',
      options: [
        { value: 'volume', label: 'Volume' },
        { value: 'orders', label: 'Transactions' },
      ],
    }),
    control({
      label: 'Chain',
      param: 'chain',
      value: filter.chain ?? '',
      options: [{ value: '', label: `all · ${count(facets.chains.reduce((s, c) => s + c.orders, 0))}` }].concat(
        facets.chains.map((chain) => ({ value: chain.key, label: `${chain.name} · ${count(chain.orders)}` })),
      ),
      hint: 'the chain the order was placed on',
    }),
    control({
      label: 'Status',
      param: 'status',
      value: filter.status ?? '',
      options: [{ value: '', label: 'any' }].concat(
        facets.statuses.map((s) => ({ value: s.status, label: `${s.status} · ${count(s.orders)}` })),
      ),
    }),
    control({
      label: 'Day',
      param: 'date',
      value: filter.date ?? '',
      options: [{ value: '', label: 'all days' }].concat(
        facets.days.slice(0, 10).map((d) => ({ value: d.date, label: `${fmtDay(d.date)} · ${count(d.orders)}` })),
      ),
      hint: 'UTC days, most recent first',
    }),
    // Only meaningful once an address is in focus: an address can be the trader on some orders
    // and the market maker on others, and 421 "orders" for one address is 3 of the first and
    // 418 of the second.
    filter.address
      ? control({
          label: 'Role',
          param: 'role',
          value: filter.role ?? 'either',
          options: [
            { value: 'either', label: 'either side' },
            { value: 'trader', label: 'placed by' },
            { value: 'filler', label: 'filled by' },
          ],
          hint: 'an address can be both',
        })
      : null,
  )
}

/* --------------------------------------------------------------------------- an account ---- */

function accountCard(account) {
  const chains = account.placedChains.length
    ? account.placedChains.map((c) => `${c.name} ${c.orders}`).join(' · ')
    : 'none in this snapshot'

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'This address' }),
      el('p.note', {
        text: 'Every dollar figure here is the side this address PLACED. The same address can also fill other people’s orders, and several here do both.',
      }),
    ),
    el(
      'p.mono',
      null,
      document.createTextNode(account.address + '  '),
      account.explorerUrl ? el('a', { href: account.explorerUrl, text: '↗ explorer', rel: 'noopener' }) : null,
    ),
    statRow([
      statTile('Orders placed', count(account.placed ?? 0), `${account.placedRefunded} refunded`, { hero: true }),
      statTile('Placed volume', usdExact(account.placedUsd), account.placedUnpriced ? `${account.placedUnpriced} could not be valued` : 'every one valued'),
      // Deliberately not "$0". The indexer gives the fill side as a count and no amounts.
      statTile('Orders filled for others', count(account.filled ?? 0), 'value moved as a filler: not published'),
      statTile(
        'Active',
        account.placedFirst ? `${fmtDay(account.placedFirst)} – ${fmtDay(account.placedLast)}` : '—',
        chains,
      ),
    ]),
    el(
      'p.note',
      null,
      el('a', { href: hyperfxHref({ view: 'orders' }), text: '← every order, unfiltered' }),
    ),
  )
}

/* -------------------------------------------------------------------------- the summary ---- */

function summaryCard(data) {
  const { shown, filter, totals } = data
  const described = [
    filter.address ? `address ${shortAddr(filter.address, 6, 4)}` : null,
    filter.chain ? `on ${filter.chain}` : null,
    filter.status ? `status ${filter.status}` : null,
    filter.date ? `on ${filter.date}` : null,
  ].filter(Boolean)

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: described.length ? `Filtered: ${described.join(', ')}` : 'Every order' }),
      el('p.note', {
        text: `The indexer holds ${count(shown.matching)} order(s) matching this filter, out of ${count(totals.orders)} ever placed. The table below is the ${count(shown.rows)} on this page; the totals in this row are over those rows only, never over the whole filter.`,
      }),
    ),
    statRow([
      statTile('On this page', count(shown.rows), `of ${count(shown.matching)} matching`, { hero: true }),
      statTile(
        'Value on this page',
        usdExact(shown.usd),
        shown.unpriced ? `${shown.unpriced} row(s) could not be valued and are excluded` : 'every row valued',
      ),
      statTile(
        'Fees on this page',
        usdExact(shown.feeUsd),
        'each fee converted with its own chain’s decimals before adding',
      ),
      statTile(
        'Median time to fill',
        shown.medianLatencySeconds === null ? 'not filled' : formatDuration(shown.medianLatencySeconds * 1000),
        `${shown.traders} trader(s), ${shown.fillers} filler(s) on this page`,
      ),
    ]),
  )
}

/* ------------------------------------------------------------------------- the rate board -- */

/**
 * What the venue actually delivered, per route, over the whole history — not the USD rate
 * table. Median over the recent window so one fat-fingered order cannot move it, beside the
 * single latest observation so drift is visible rather than averaged away.
 */
function rateBoardCard(rateBoard) {
  if (!rateBoard?.length) return null

  const body = el('tbody')
  for (const row of rateBoard) {
    const drift = row.drift === null ? '—' : `${row.drift >= 0 ? '+' : ''}${row.drift.toFixed(2)}%`
    append(
      body,
      el(
        'tr',
        null,
        el('td.mono', { text: row.route }),
        el('td.num', { text: rateText(row.latest, row.tokenIn, row.tokenOut) }),
        el('td.num', { text: formatUtc(row.latestAt * 1000, { seconds: false }) }),
        el('td.num', { text: rateText(row.median, row.tokenIn, row.tokenOut) }),
        el('td.num', { text: drift }),
        el('td.num', { text: `${count(row.settledObservations)} / ${count(row.observations)}` }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Latest rates' }),
      el('p.note', {
        text: 'The rate each route last traded at, against the median of its recent settled orders. Medians are taken over settled orders where there are any — a refunded order states a price nobody paid.',
      }),
    ),
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
            el('th', { text: 'Route' }),
            el('th.num', { text: 'Latest' }),
            el('th.num', { text: 'When (UTC)' }),
            el('th.num', { text: 'Median, recent' }),
            el('th.num', { text: 'Drift' }),
            el('th.num', { text: 'Settled / seen' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* --------------------------------------------------------------------------- the orders ---- */

/** The status timeline, flattened into the row's tooltip. Every step has its own transaction. */
function timelineTitle(row) {
  const steps = row.timeline.map((step) => `${step.status} ${formatUtc(step.at * 1000)} ${step.tx ? shortAddr(step.tx, 8, 6) : ''}`)
  const extra = [
    row.partialFills ? `${row.partialFills} partial fill(s)` : null,
    row.escrowRefunds ? `${row.escrowRefunds} escrow refund(s)` : null,
    row.escrowReleases ? `${row.escrowReleases} escrow release(s)` : null,
    row.referrer ? `referrer ${row.referrer}` : null,
  ].filter(Boolean)
  return steps.concat(extra).join('\n')
}

function ordersTable(rows) {
  const body = el('tbody')

  for (const row of rows) {
    append(
      body,
      el(
        'tr',
        { title: timelineTitle(row), tabindex: '0' },
        el('td.mono', { text: formatUtc(row.placedAt * 1000, { seconds: false }) }),
        el('td', null, statusPill(row.status)),
        el('td', { text: row.crossChain ? `${row.chain} → ${row.destination}` : row.chain }),
        el('td', null, addressLink(row.trader)),
        el('td.num', { text: `${tokenAmount(row.amountIn)} ${row.tokenIn ?? '?'}` }),
        el('td.num', { text: `${tokenAmount(row.amountOut)} ${row.tokenOut ?? '?'}` }),
        el('td.num', { text: rateText(row.rate, row.tokenIn ?? '?', row.tokenOut ?? '?') }),
        // `usd` is null when no leg could be valued. It says so rather than printing $0.
        el('td.num', { text: usdOrUnknown(row.usd) }),
        el('td.num', { text: row.fee ? `${tokenAmount(row.fee.amount)} ${row.fee.symbol ?? '?'}` : '—' }),
        el('td.num', {
          text: row.latencySeconds === null ? 'not filled' : formatDuration(row.latencySeconds * 1000),
        }),
        el('td', null, addressLink(row.filler)),
        el(
          'td',
          null,
          txLink(row.tx, row.txUrl, 'place'),
          document.createTextNode(' '),
          row.fillTx ? txLink(row.fillTx, row.fillTxUrl, 'fill') : null,
        ),
      ),
    )
  }

  return el(
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
          el('th', { text: 'Placed (UTC)' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Route' }),
          el('th', { text: 'Trader' }),
          el('th.num', { text: 'Sent' }),
          el('th.num', { text: 'Received' }),
          el('th.num', { text: 'Rate' }),
          el('th.num', { text: 'Value' }),
          el('th.num', { text: 'Fee (its own token)' }),
          el('th.num', { text: 'Time to fill' }),
          el('th', { text: 'Filler' }),
          el('th', { text: 'Tx' }),
        ),
      ),
      body,
    ),
  )
}

function pager(data) {
  const { filter, shown } = data
  const base = { view: 'orders', address: filter.address, role: filter.role, chain: filter.chain, status: filter.status, date: filter.date }
  const prev = filter.offset > 0 ? Math.max(0, filter.offset - filter.limit) : null
  const next = filter.offset + shown.rows < shown.matching ? filter.offset + filter.limit : null

  return el(
    'div',
    { style: 'display:flex;gap:var(--s2);align-items:baseline;margin-top:var(--s4)' },
    prev === null
      ? null
      : el('a.theme-btn', { href: hyperfxHref({ ...base, offset: prev || null }), text: '← newer' }),
    el('span.note', {
      style: 'margin:0',
      text: `${count(filter.offset + 1)}–${count(filter.offset + shown.rows)} of ${count(shown.matching)}`,
    }),
    next === null ? null : el('a.theme-btn', { href: hyperfxHref({ ...base, offset: next }), text: 'older →' }),
  )
}

/* ---------------------------------------------------------------------------- the notes ---- */

/**
 * Generated from the same payload the table is drawn from, so it cannot describe a different
 * dataset than the one on screen. See rule 3 in CLAUDE.md.
 */
function dataNotes(data) {
  const { meta, shown, rateBoard } = data
  const list = el('ul')
  for (const note of meta.notes ?? []) append(list, el('li', { text: note }))

  if (shown.unpriced) {
    append(
      list,
      el('li', {
        text: `${shown.unpriced} row(s) on this page have no rate for either leg and are shown as “not valued” rather than as $0. They are counted in the row count and excluded from the value total, so the two disagree by exactly that much.`,
      }),
    )
  }
  if (shown.unpricedFees) {
    append(
      list,
      el('li', {
        text: `${shown.unpricedFees} fee(s) on this page are in a token with no rate, so they are missing from the dollar fee total rather than counted as zero.`,
      }),
    )
  }
  const thin = (rateBoard ?? []).filter((r) => r.window < 5)
  if (thin.length) {
    append(
      list,
      el('li', {
        text: `The median for ${thin.map((r) => `${r.route} (${r.window} observation(s))`).join(', ')} is taken over too few orders to be a rate anybody should quote. It is shown because the alternative is an empty row, not because it is reliable.`,
      }),
    )
  }

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Rows read live from ${meta.sourceLabel} (${meta.sourceUrl}) at ${new Date(meta.fetchedAt).toUTCString()}. Prices and the rate board come from a snapshot of the full order history taken ${new Date(meta.snapshotAt).toUTCString()}, so an order placed in the last minute can appear in the table before it moves any total.`,
    }),
    list,
    el('p', null, document.createTextNode('Venue: '), el('a', { href: meta.venueUrl, text: meta.venue, rel: 'noopener' })),
  )
}

/* --------------------------------------------------------------------------- the render ---- */

export function renderOrders(host, data) {
  clear(host)

  // An address the indexer has never seen gets no account card. A row of zeroes under a
  // heading that says "This address" reads as "it traded nothing", which is a different claim
  // from "there is no such trader here" — the empty notice below makes the right one.
  const known = data.account && ((data.account.placed ?? 0) > 0 || (data.account.filled ?? 0) > 0)
  append(host, controls(data), known ? accountCard(data.account) : null, summaryCard(data))

  if (!data.rows.length) {
    // The state a data page usually forgets: the request succeeded and there is nothing in it.
    // Without this the reader sees an empty table and reads it as an outage.
    //
    // And two different nothings, because they need different actions from the reader: a
    // filter that matches no orders, and a page number past the end of one that does.
    const pastEnd = data.shown.matching > 0
    append(
      host,
      pastEnd
        ? notice(
            'warning',
            'Nothing on this page',
            `This filter matches ${count(data.shown.matching)} order(s), but the page you asked for starts after the last of them.`,
            'The link below goes back to the first page with the same filter.',
          )
        : notice(
            'warning',
            'No orders match this filter',
            'The indexer answered, and answered with nothing. That is a fact about the filter rather than a failure — widen it, or clear it below.',
            'Every filter on this page lives in the URL, so this exact empty result is linkable.',
          ),
      el(
        'p',
        null,
        pastEnd
          ? el('a', {
              href: hyperfxHref({
                view: 'orders',
                address: data.filter.address,
                role: data.filter.role,
                chain: data.filter.chain,
                status: data.filter.status,
                date: data.filter.date,
              }),
              text: '← back to the first page of this filter',
            })
          : el('a', { href: hyperfxHref({ view: 'orders' }), text: '← every order, unfiltered' }),
      ),
      dataNotes(data),
    )
    return
  }

  append(
    host,
    rateBoardCard(data.rateBoard),
    el(
      'section.card',
      null,
      el(
        'header',
        null,
        el('h2', { text: 'Orders' }),
        el('p.note', {
          text: 'Newest first. Addresses link to this site’s own view of that address; transaction hashes link out to the explorer of the chain each one happened on. Hover a row for its full status timeline.',
        }),
      ),
      ordersTable(data.rows),
      pager(data),
    ),
    dataNotes(data),
  )
}

/* ------------------------------------------- the strip that sits on the volume dashboard ---- */

/**
 * A compact "what just happened" card for the volume view, plus the three-numbers card. Both
 * are appended to the dashboard the shared renderer drew, ahead of its data-notes section, so
 * the notes stay last where a reader expects them.
 */
export function latestOrdersCard(data) {
  const rows = data.rows.slice(0, 8)
  const body = el('tbody')
  for (const row of rows) {
    append(
      body,
      el(
        'tr',
        { title: timelineTitle(row) },
        el('td.mono', { text: formatUtc(row.placedAt * 1000, { seconds: false }) }),
        el('td', null, statusPill(row.status)),
        el('td', { text: row.chain }),
        el('td', null, addressLink(row.trader)),
        el('td.num', { text: `${tokenAmount(row.amountIn)} ${row.tokenIn ?? '?'}` }),
        el('td.num', { text: rateText(row.rate, row.tokenIn ?? '?', row.tokenOut ?? '?') }),
        el('td.num', { text: usdOrUnknown(row.usd) }),
        el('td', null, txLink(row.tx, row.txUrl, 'tx')),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Latest orders' }),
      el('p.note', {
        text: 'The most recent orders and the rate each one got. Every address here opens that address’s own page; every filter on that page is applied by the indexer rather than in the browser.',
      }),
    ),
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
            el('th', { text: 'Placed (UTC)' }),
            el('th', { text: 'Status' }),
            el('th', { text: 'Chain' }),
            el('th', { text: 'Trader' }),
            el('th.num', { text: 'Sent' }),
            el('th.num', { text: 'Rate' }),
            el('th.num', { text: 'Value' }),
            el('th', { text: 'Tx' }),
          ),
        ),
        body,
      ),
    ),
    el(
      'p.note',
      null,
      el('a', { href: hyperfxHref({ view: 'orders' }), text: 'Every order, filterable by address, chain, status and day →' }),
    ),
  )
}

/**
 * The three figures that all call themselves "HyperFX volume", side by side with the method
 * that produced each. This is rule 3 as a chart rather than as a sentence: a reader who has
 * seen HyperFX's own headline and this page's total deserves to see why they differ, not to be
 * told that one of them is wrong.
 */
export function volumeComparisonCard(volume) {
  if (!volume) return null
  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Three numbers for one thing' }),
      el('p.note', {
        text: '“HyperFX volume” means three different quantities depending on who is adding it up. All three are computed here from the same orders, so the gap is visible instead of being an argument.',
      }),
    ),
    statRow([
      statTile('This page', money2(volume.orderSum), 'every order valued on its input leg, at rates derived from the orders themselves', { hero: true }),
      statTile(
        'The indexer’s own figure',
        money2(volume.indexerUsd),
        `its inputUSD column, over the ${count(volume.indexerPriced)} orders it priced — it writes a literal $0 for the other ${count(volume.indexerZero)}, so this is a floor`,
      ),
      statTile(
        'HyperFX’s headline method',
        money2(volume.headlineUsd),
        `cumulative protocol dust × ${count(volume.multiplier)}; the dust these orders paid is ${usdExact(volume.dustUsd)}`,
      ),
      statTile(
        'Protocol fees collected',
        usdExact(volume.dustUsd),
        `${count(volume.pricedFees)} order fees, each converted with its own chain’s decimals before adding — the raw column is never summed`,
      ),
    ]),
  )
}
