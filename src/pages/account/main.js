// Follow one account through Hydration.
//
//   /account/?address=0x…            one account, the default window
//   /account/?address=…&days=14      the same account, a longer window
//
// The address may be hex or SS58 in ANY network prefix: the server normalises it to the public
// key before it looks anything up (see server/lib/params.mjs). That is not a convenience — the
// same account is a different string on every chain, so a page that matched on the display
// string would answer "this account never traded here" for a perfectly active account whose
// address the reader happened to copy from the relay chain.
//
// WHAT THIS PAGE IS BOUNDED BY, stated here because the whole page depends on it: it sees
// routed trades on Hydration inside one window. Not other parachains, not transfers, not
// anything before orca's index begins. The bound is drawn at the top of the page rather than
// buried in the notes, because a drill-down that looks complete is worse than no drill-down.

import '../../design/app.css'
import { renderPage, choiceControl } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { el, append, notice, statRow, statTile } from '../../design/dom.js'
import { segmentedRows, segmentedLegend } from '../../design/charts.js'
import { compact, money, percent, shortAddr } from '../../core/format.js'

const query = new URLSearchParams(location.search)
const address = query.get('address') ?? query.get('account')
const days = Number(query.get('days')) || 7

const page = pageByKey('account')

if (!address) {
  renderPage({
    page,
    intro:
      'This page follows one account. Pick one from the ranked traders on any swap dashboard — every name there links here.',
    load: async () => null,
    render: (host) =>
      append(
        host,
        notice(
          'info',
          'No account named',
          'Add an address to the URL — /account/?address=0x… — or click any account on the Hydration dashboard.',
        ),
        el('p', null, el('a', { href: '/hydration/', text: 'Go to the Hydration dashboard →' })),
      ),
  })
} else {
  renderPage({
    page,
    intro:
      'One account on Hydration: what flowed in and out by asset, the trades behind it, and — stated first, because it decides what everything else means — how much of this account’s history the window actually covers.',
    controls: [
      choiceControl({
        label: 'Window',
        param: 'days',
        value: String(days),
        options: [
          { value: '1', label: '1 day' },
          { value: '7', label: '7 days' },
          { value: '14', label: '14 days' },
        ],
        hint: 'The window is a cost decision, not a limit of the data — see the notes.',
      }),
    ],
    loadingLabel: 'Reading orca for this account',
    skeleton: ['stats', 'rows'],
    load: () => read('hydration', 'account', { account: address, days }),
    render,
  })
}

/* ══════════════════════════════════════════════════════════════════════════ the page ═════ */

function render(host, data) {
  const { account, window: win, activity, totals, flows, trades, tradesShown } = data

  append(
    host,
    identityCard(account, activity),
    boundCard(win, activity),
    statRow([
      statTile('Traded in the window', money(totals.usdIn), `${compact(activity.tradesInWindow)} trades`, {
        hero: true,
      }),
      statTile('Trades ever', compact(activity.tradesEver), `since ${(activity.firstEverAt ?? '').slice(0, 10)}`),
      statTile('Active days', String(activity.activeDays), `of ${win.days} in the window`),
      statTile(
        'Assets touched',
        String(flows.length),
        flows.some((f) => !f.priced) ? `${flows.filter((f) => !f.priced).length} without a price` : 'all priced',
      ),
    ]),
    flowsCard(flows),
    tradesCard(trades, tradesShown, activity),
    venuesCard(totals),
    notes(data),
  )
}

/**
 * Who this is, structurally and only structurally. `modl` and the sovereign prefixes are
 * arithmetic on the bytes — they cannot be wrong. Nothing here guesses at an operator, and
 * nothing here names a person: this site is ungated, anonymous and indexed, and a behavioural
 * label ("looks like an exchange") is a claim with higher stakes than any number on the page.
 */
function identityCard(account, activity) {
  const kind = account.isPallet
    ? 'Pallet account — machinery, not a person'
    : account.structural
      ? account.structural
      : account.orcaType === 'User'
        ? 'No structural marker — an ordinary account'
        : (account.orcaType ?? 'Unclassified')

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: shortAddr(account.address ?? account.hex, 10, 8) }),
      el('p.note', {
        text: account.isPallet
          ? 'Accounts beginning with the ASCII “modl” are pallet accounts — the fee processor, the DCA machinery and similar. They are not traders, and on a normal day they are two thirds of the “trades” on this chain.'
          : 'Classified from the bytes of the address alone, with no network call and no claim about who operates it.',
      }),
    ),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el(
          'tbody',
          null,
          row('Kind', kind),
          row('Address', account.address ?? '—'),
          row('Public key', account.hex),
          account.ss58Prefix != null ? row('Shown with prefix', `${account.ss58Prefix} (Hydration)`) : null,
          row(
            'First seen',
            activity.firstEverAt ? `${activity.firstEverAt.slice(0, 10)} · block ${compact(activity.firstEverBlock)}` : '—',
          ),
          row(
            'Last seen',
            activity.lastEverAt ? `${activity.lastEverAt.slice(0, 10)} · block ${compact(activity.lastEverBlock)}` : '—',
          ),
        ),
      ),
    ),
  )
}

const row = (k, v) =>
  el('tr', null, el('th', { text: k, scope: 'row' }), el('td', { text: String(v), style: 'overflow-wrap:anywhere' }))

/**
 * The bound, drawn before any number it qualifies.
 *
 * `windowShare` is the whole point of this card: an account with 603,533 trades in orca's index
 * and 2,859 in the window is being shown 0.5 % of itself, and every total below is a total of
 * that 0.5 %. A drill-down that renders those figures without this sentence is not slightly
 * misleading, it is wrong about its own subject.
 */
function boundCard(win, activity) {
  const share = activity.windowShare
  const outside = Math.max(0, (activity.tradesEver ?? 0) - (activity.tradesInWindow ?? 0))

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'What this page is showing you — and what it is not' }),
      el('p.note', {
        text:
          `Everything below is this account’s routed trades on Hydration between ${win.text}. ` +
          `That is ${compact(activity.tradesInWindow)} of ${compact(activity.tradesEver)} trades orca has indexed for it` +
          (share != null ? ` — ${percent(share, 2)} of them` : '') +
          `${outside > 0 ? `, leaving ${compact(outside)} outside the window` : ''}.`,
      }),
      el('p.note', {
        text:
          'Hydration only, and swaps only. Transfers, liquidity provision, money-market positions and anything this account did on another parachain are not here and are not counted as zero — they are simply not measured. Orca’s index itself begins at ' +
          `${win.coverageFrom}, so nothing before that date exists for any account.`,
      }),
    ),
    outside > 0
      ? notice(
          'warning',
          'The totals on this page are window totals',
          `Widen the window to see more of this account, but the figures will still be a slice: ${compact(activity.tradesEver)} trades cannot be summed by a page that fetches a fortnight.`,
        )
      : null,
  )
}

/**
 * What flowed in and out, per asset.
 *
 * `sentUsd + receivedUsd === grossUsd` by construction upstream, so the segments genuinely sum
 * to the stated total and an unfilled bar would be a real finding rather than a rounding
 * artefact. Net is carried in the table beside it, signed, because a bar cannot show a negative
 * and pretending otherwise is how a chart lies.
 */
function flowsCard(flows) {
  const priced = flows.filter((f) => f.priced && f.grossUsd > 0)
  const unpriced = flows.filter((f) => !f.priced || !(f.grossUsd > 0))
  const host = el('div')
  const series = [{ label: 'sent' }, { label: 'received' }]

  const tally = segmentedRows(host, {
    rows: priced.map((f) => ({
      label: f.symbol ?? f.asset,
      sublabel: `${compact(f.legsOut)} out · ${compact(f.legsIn)} in`,
      total: f.grossUsd,
      segments: [f.sentUsd, f.receivedUsd],
      note: `${f.asset}: sent ${money(f.sentUsd)}, received ${money(f.receivedUsd)}, net ${money(f.netUsd)}`,
    })),
    series,
    format: money,
    residualLabel: 'not attributed to either direction',
  })

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'What flowed in and out, by asset' }),
      el('p.note', {
        text: 'One bar per asset, split into what this account sent and what it received, both valued in dollars. The bar is the two added together, so its length is how much of this asset moved through the account rather than how much it kept.',
      }),
    ),
    priced.length
      ? segmentedLegend(
          series,
          [priced.reduce((n, f) => n + f.sentUsd, 0), priced.reduce((n, f) => n + f.receivedUsd, 0)],
          money,
        )
      : null,
    priced.length ? host : notice('info', 'Nothing priced in this window', 'No asset this account touched could be valued in dollars.'),
    flowsTable(flows),
    unpriced.length
      ? notice(
          'info',
          `${unpriced.length} asset${unpriced.length === 1 ? '' : 's'} without a dollar value`,
          'Their amounts are in the table. They are absent from the bars rather than drawn at zero — “we could not value this” and “this was worth nothing” are different facts.',
        )
      : null,
    tally.short > 0
      ? notice(
          'warning',
          `${tally.short} bar${tally.short === 1 ? '' : 's'} did not fill`,
          'The two directions should add up to the stated total. Where they do not, some legs carried no stated balance.',
        )
      : null,
  )
}

function flowsTable(flows) {
  return el(
    'details',
    null,
    el('summary', { text: `Every asset, with the amounts (${flows.length})` }),
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
            el('th', { text: 'Asset' }),
            el('th', { text: 'Sent' }),
            el('th', { text: 'Received' }),
            el('th', { text: 'Net' }),
            el('th', { text: 'Net $' }),
            el('th', { text: 'Moved $' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...flows.map((f) =>
            el(
              'tr',
              null,
              el('td', { text: f.symbol ?? f.asset, title: f.asset }),
              el('td', { text: compact(f.sent) }),
              el('td', { text: compact(f.received) }),
              el('td', { text: `${f.net > 0 ? '+' : ''}${compact(f.net)}` }),
              // `null` is not `0`: an asset we could not price gets an em dash, not a zero.
              el('td', { text: f.priced ? `${f.netUsd > 0 ? '+' : ''}${money(f.netUsd)}` : '—' }),
              el('td', { text: f.priced ? money(f.grossUsd) : '—' }),
            ),
          ),
        ),
      ),
    ),
  )
}

function tradesCard(trades, tradesShown, activity) {
  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'The trades behind those flows' }),
      el('p.note', {
        text:
          tradesShown < activity.tradesInWindow
            ? `The ${compact(tradesShown)} most recent of ${compact(activity.tradesInWindow)} in the window. The flows above are computed from all of them, not from this table.`
            : `All ${compact(tradesShown)} trades in the window.`,
      }),
    ),
    el(
      'details',
      null,
      el('summary', { text: `Show the ${compact(tradesShown)} trades` }),
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
            el('th', { text: 'When' }),
            el('th', { text: 'Sent' }),
            el('th', { text: 'Received' }),
            el('th', { text: 'Value' }),
            el('th', { text: 'Venue' }),
            el('th', { text: 'Block' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...trades.map((t) =>
            el(
              'tr',
              null,
              el('td', { text: new Date(t.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') }),
              el('td', { text: `${compact(t.amountIn)} ${t.tokenIn}` }),
              el('td', { text: `${compact(t.amountOut)} ${t.tokenOut}` }),
              el('td', { text: t.usd == null ? '—' : money(t.usd) }),
              el('td', { text: t.venue, title: `${t.hops} hop${t.hops === 1 ? '' : 's'}` }),
              el('td', { text: compact(t.height) }),
            ),
          ),
        ),
      ),
      ),
    ),
  )
}

function venuesCard(totals) {
  const routes = (totals.routes ?? []).slice(0, 12)
  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where it traded, and along what routes' }),
      el('p.note', { text: 'Venues are the pallet that executed the swap; routes are the asset pair as the router resolved it.' }),
    ),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, el('th', { text: 'Route' }), el('th', { text: 'Value' }), el('th', { text: 'Trades' }))),
        el(
          'tbody',
          null,
          ...(totals.venues ?? []).map((v) =>
            el('tr', null, el('td', null, el('strong', { text: v.venue })), el('td', { text: money(v.usd) }), el('td', { text: compact(v.count) })),
          ),
          ...routes.map((r) => el('tr', null, el('td', { text: r.route }), el('td', { text: money(r.usd) }), el('td', { text: compact(r.count) }))),
        ),
      ),
    ),
    (totals.routes ?? []).length > routes.length
      ? el('p.note', { text: `${(totals.routes ?? []).length - routes.length} further routes not shown.` })
      : null,
  )
}

/**
 * Rule 3, in its own section: every caveat that changes what a number on this page means.
 */
function notes(data) {
  const { account, window: win, activity, totals, flows } = data
  const items = []

  items.push(
    `Bounded to Hydration routed trades between ${win.text}. Orca's index starts at ${win.coverageFrom}; there is no data before it for anyone.`,
  )
  items.push(
    `${compact(activity.tradesInWindow)} of ${compact(activity.tradesEver)} trades this account has ever made are in the window. Every total here is a total of those.`,
  )
  if (activity.legInflation > 1) {
    items.push(
      `The window's ${compact(activity.tradesInWindow)} trades were executed as ${compact(activity.legs)} legs — ${activity.legInflation.toFixed(2)}× — and are grouped back into trades before anything is counted. Counting legs would multiply this account's volume by that factor.`,
    )
  }
  if (totals.unpricedTrades > 0) {
    items.push(`${compact(totals.unpricedTrades)} trades could not be valued and are excluded from every dollar figure, not counted as zero.`)
  }
  const unpriced = flows.filter((f) => !f.priced)
  if (unpriced.length) {
    items.push(`${unpriced.length} of ${flows.length} assets have no dollar price: ${unpriced.map((f) => f.symbol ?? f.asset).join(', ')}.`)
  }
  if (account.isPallet) {
    items.push('This is a pallet account — protocol machinery rather than a trader. Its "trades" are the chain doing its own work.')
  }
  if (activity.notFirstSwapper > 0) {
    items.push(
      `${compact(activity.notFirstSwapper)} trades name more than one participant, and the whole trade is attributed to the first. Those rows overstate this account's share.`,
    )
  }
  if (activity.tradesWithoutBalances > 0) {
    items.push(`${compact(activity.tradesWithoutBalances)} trades carried no stated balances, so they contribute to counts but not to the flows above.`)
  }
  items.push(
    'Dollar values use Hydration’s own oracle at read time, not the price at the moment of each trade. Over a fortnight that is a small error; over a year it would not be.',
  )
  items.push('Addresses are matched on the public key, so the same account resolves whatever network prefix you paste.')

  return el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'Data notes' })),
    el('ul', null, ...items.map((t) => el('li', { text: t, style: 'overflow-wrap:anywhere' }))),
  )
}
