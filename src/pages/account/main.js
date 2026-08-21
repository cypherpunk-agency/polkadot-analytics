// Follow one account — who it moved value WITH, and what it traded.
//
//   /account/?address=0x…                  one account, the default windows
//   /account/?address=…&tdays=7            a longer transfer window
//   /account/?address=…&days=14            a longer Hydration swap window
//
// The address may be hex or SS58 in ANY network prefix: the server normalises it to the public
// key before it looks anything up (see server/lib/params.mjs). That is not a convenience — the
// same account is a different string on every chain, so a page that matched on the display
// string would answer "this account never traded here" for a perfectly active account whose
// address the reader happened to copy from the relay chain.
//
// ── the page has two subjects and they are bounded differently ──────────────────────────────
// This is the one place on the site where the "one page, one subject" rule bends, and the
// reason is that the subject IS the account rather than a chain:
//
//   · TRANSFERS — who this account sent value to and received it from, on Polkadot Asset Hub
//     and the relay chain, folded from transfer EVENTS. Every counterparty is a link back to
//     this page, which is what makes the graph walkable one hop at a time.
//   · SWAPS — what it traded on Hydration, from orca.
//
// Two upstreams, two windows, two sets of caveats, and they are never mixed into one number.
// Each section states its own bound above its own figures rather than deferring to a shared
// sentence at the top, because a bound that is one scroll away from the number it qualifies is
// a bound the reader has already forgotten.
//
// Either half may fail on its own and the other still renders: a dead orca must not take the
// transfer graph down with it, and vice versa.

import '../../design/app.css'
import { renderPage, choiceControl } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { el, append, notice, statRow, statTile } from '../../design/dom.js'
import { segmentedRows, segmentedLegend, flowGraph } from '../../design/charts.js'
import { livenessBanner, livenessNotes } from '../../design/liveness.js'
import { compact, money, percent, shortAddr, tokenAmount, formatUtc } from '../../core/format.js'

const query = new URLSearchParams(location.search)
const address = query.get('address') ?? query.get('account')
const days = Number(query.get('days')) || 7
const tdays = Number(query.get('tdays')) || 2

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
      'Who this account moved value with, and what it traded. The transfer graph comes first: every counterparty is a link, so the graph can be walked one hop at a time. Each section states what it is bounded by directly above its own numbers — they are different chains, different windows and different upstreams, and nothing here is summed across them.',
    controls: [
      choiceControl({
        label: 'Transfer window',
        param: 'tdays',
        value: String(tdays),
        options: [
          { value: '1', label: '1 day' },
          { value: '2', label: '2 days' },
          { value: '7', label: '7 days' },
        ],
        hint: 'Asset Hub + relay chain. Seven days is ~270,000 Asset Hub blocks; the ceiling is politeness to a free archive, not a limit of the data.',
      }),
      choiceControl({
        label: 'Swap window',
        param: 'days',
        value: String(days),
        options: [
          { value: '1', label: '1 day' },
          { value: '7', label: '7 days' },
          { value: '14', label: '14 days' },
        ],
        hint: 'Hydration only. A separate control because it is a separate upstream with separate limits — one slider clamped for both would silently shorten one of them.',
      }),
    ],
    loadingLabel: 'Reading the SQD archive and orca for this account',
    skeleton: ['stats', 'rows'],
    // Both halves at once, and neither can take the other down. `allSettled`, not `all`: orca
    // going dark must not blank the transfer graph, and an archive that refuses a window must
    // not blank the trades. Each section renders its own failure where its numbers would be.
    load: async () => {
      const [graph, hydration] = await Promise.allSettled([
        read('transfers', 'account-graph', { account: address, days: tdays }),
        read('hydration', 'account', { account: address, days }),
      ])
      return { graph: settle(graph), hydration: settle(hydration) }
    },
    render,
  })
}

/** A settled promise as `{ value, error }` — the error kept whole, because `ApiError` already
 *  distinguishes "could not reach them" from "they answered with an error", and the page says
 *  which. Collapsing them into a boolean throws that away. */
const settle = (result) =>
  result.status === 'fulfilled' ? { value: result.value, error: null } : { value: null, error: result.reason }

/* ══════════════════════════════════════════════════════════════════════════ the page ═════ */

function render(host, data) {
  const { graph, hydration } = data

  append(
    host,
    identityCard(graph.value, hydration.value),
    graph.value ? livenessBanner(graph.value.meta?.liveness) : null,
    transfersSection(graph),
    hydrationSection(hydration),
    notesCard(graph.value, hydration.value),
  )
}

/* ═══════════════════════════════════════════════════════════ what this account IS ═════════ */

/**
 * Structural identity, and nothing else. `modl`, `para` and `sibl` are arithmetic on the bytes
 * of the address — they cannot be wrong about whose account this is. Nothing here guesses at an
 * operator and nothing here names a person: this site is ungated, anonymous and indexed, and a
 * behavioural label ("looks like an exchange") is a claim with higher stakes than any number on
 * the page. See docs/concept/plan.md §8.3.
 *
 * Both spellings of the address are shown when both upstreams answered, because that is the
 * trap this page is built on made visible: one public key, two completely different strings.
 */
function identityCard(graph, hydration) {
  const acct = graph?.account ?? hydration?.account ?? null
  if (!acct) return null

  const structural = graph?.account?.structural ?? null
  const kind = structural
    ? structural.label.charAt(0).toUpperCase() + structural.label.slice(1)
    : hydration?.account?.isPallet
      ? 'Pallet account — machinery, not a person'
      : 'No structural marker — an ordinary account'

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: shortAddr(acct.address ?? acct.hex, 10, 8) }),
      el('p.note', {
        text: structural
          ? 'Classified from the bytes of the address alone, with no network call. This much cannot be wrong — it is the derivation the runtime itself used to make the account.'
          : 'No structural marker in the bytes. That means it is not a pallet or sovereign account; it says nothing about who operates it, and this page will not guess.',
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
          row('Public key', acct.hex),
          graph?.account?.address ? row('On Polkadot / Asset Hub (prefix 0)', graph.account.address) : null,
          hydration?.account?.address ? row('On Hydration (prefix 63)', hydration.account.address) : null,
          hydration?.activity?.firstEverAt
            ? row('First seen on Hydration', `${hydration.activity.firstEverAt.slice(0, 10)} · block ${compact(hydration.activity.firstEverBlock)}`)
            : null,
          hydration?.activity?.lastEverAt
            ? row('Last seen on Hydration', `${hydration.activity.lastEverAt.slice(0, 10)} · block ${compact(hydration.activity.lastEverBlock)}`)
            : null,
        ),
      ),
    ),
    graph?.account?.address && hydration?.account?.address
      ? el('p.note', {
          text: 'Those two strings are the same 32 bytes. Everything on this page is joined on the public key, never on a display address — an address copied from the wrong chain would otherwise return a confident, empty page.',
        })
      : null,
  )
}

/* ═════════════════════════════════════════════════════════════ the Hydration section ══════ */

/** The existing swap drill-down, unchanged in substance and now carrying its own failure state. */
function hydrationSection({ value: data, error }) {
  if (error) {
    return el(
      'section.card',
      null,
      el('header', null, el('h2', { text: 'What it traded on Hydration' })),
      notice(
        error.kind === 'transport' ? 'warning' : 'critical',
        error.message ?? 'Hydration’s indexer could not be read',
        'The transfer graph above is unaffected — it comes from a different upstream. Nothing here is being shown as zero.',
      ),
    )
  }

  const { window: win, activity, totals, flows, trades, tradesShown } = data
  return el(
    'div',
    null,
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
 * The Hydration half of rule 3, as a list of sentences rather than a card. Both halves land in
 * one `Data notes` section at the foot of the page: two separately-titled caveat lists is how a
 * reader learns to skip the second one.
 */
function hydrationNoteItems(data) {
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

  return items
}

/* ══════════════════════════════════════════════════════ the transfer graph ════════════════ */

/**
 * Who this account moved value WITH.
 *
 * This is the one section on the site that draws an EDGE rather than a level, and the two are
 * not the same kind of fact. A balance is state and can be read; an edge is not in the state at
 * all, so it is folded out of transfer events (docs/platform/sqd-portal.md). What follows from
 * that is the bound stated at the top of this card, and it is not a small one: transfer events
 * are under a third of what moves. `Deposit`, `Withdraw` and `Minted` are single-ended — one
 * account and an amount, no second party — so fees, staking rewards and the mint/burn half of
 * XCM have no counterparty to draw and are simply not here.
 */
function transfersSection({ value: data, error }) {
  if (error) {
    return el(
      'section.card',
      null,
      el('header', null, el('h2', { text: 'Who it moved value with' })),
      notice(
        error.kind === 'transport' ? 'warning' : 'critical',
        error.message ?? 'The transfer archive could not be read',
        error.advice ?? 'No counterparty on this page is being shown as zero — none of them could be read at all.',
      ),
    )
  }

  const { window: win, totals, counterparties, denomination, assets, chains } = data
  const reached = chains.filter((c) => c.reachable)

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Who it moved value with' }),
      el('p.note', {
        text:
          `Every transfer this account was one end of, on ${reached.map((c) => c.label).join(' and ')}, between ${win.text}. ` +
          'Each counterparty below is a link to its own page, so the graph can be walked one hop at a time.',
      }),
    ),
    transferBoundCard(win, chains, totals),
    statRow([
      statTile('Counterparties', compact(totals.counterparties), `over ${win.days} day${win.days === 1 ? '' : 's'}`, { hero: true }),
      statTile('Transfers out', compact(totals.sent), 'this account was the sender'),
      statTile('Transfers in', compact(totals.received), 'this account was the recipient'),
      statTile(
        'Pallet counterparties',
        compact(totals.palletCounterparties),
        totals.palletCounterparties ? 'machinery, not people' : 'none — all ordinary accounts',
      ),
    ]),
    totals.transfers === 0 ? noTransfersNotice(win, chains) : null,
    totals.transfers > 0 ? counterpartyBars(counterparties, denomination) : null,
    totals.transfers > 0 ? egoGraph(data) : null,
    totals.transfers > 0 ? counterpartyTable(counterparties, totals, denomination) : null,
    totals.transfers > 0 ? assetsTable(assets) : null,
    totals.transfers > 0 ? recentTransfersTable(data.transfers, data.transfersShown, totals) : null,
  )
}

/**
 * The edges of the view, drawn before anything they qualify.
 *
 * Three bounds and each one changes what the numbers mean:
 *
 *   · WHICH CHAINS. Asset Hub and the relay, and nothing else. A transfer on Hydration, Moonbeam
 *     or Bifrost is not here and is not counted as zero.
 *   · WHICH WINDOW. The last few days, ending wherever the archive's head is — which is not the
 *     chain's head. The relay/Asset Hub seam matters too: everything happened on the relay until
 *     2025-11-04 and almost nothing has since.
 *   · WHICH EVENTS. Named in full, per chain, with the chain-wide count each one matched. That
 *     last column is the defence against the quietest failure in this pipeline: the archive
 *     accepts an event name that does not exist and answers 200 with nothing, so a name that has
 *     silently stopped matching shows up here as a zero instead of as an empty graph.
 */
function transferBoundCard(win, chains, totals) {
  const rows = []
  for (const chain of chains) {
    const names = win.eventNames[chain.key] ?? []
    for (const name of names) {
      rows.push({
        chain: chain.label,
        name,
        onChain: win.eventCounts[`${chain.key}/${name}`] ?? 0,
        reachable: chain.reachable,
      })
    }
  }
  const zero = rows.filter((r) => r.reachable && r.onChain === 0)

  return el(
    'div',
    null,
    el('p.note', {
      text:
        'This is the transfer graph, not this account’s balance history. Transfer events are the ones that name two parties; ' +
        'in a sample of Asset Hub taken on 2026-08-21 they were 29% of all balance-changing events. `Deposit`, `Withdraw` and ' +
        '`Minted` — fees, staking rewards, the mint and burn halves of XCM execution — name only one party, so they have no ' +
        'edge to draw and are absent here rather than zero.',
    }),
    win.spansMigration
      ? notice(
          'warning',
          'This window crosses the Asset Hub Migration',
          `Everything happened on the relay chain until ${win.migrationDay} and almost nothing has since. A graph spanning that date is two chains stitched together, and the chain column below is the only thing keeping them apart.`,
        )
      : null,
    el(
      'details',
      null,
      el('summary', { text: `Exactly what was read: ${chains.length} chains, ${rows.length} event types` }),
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
              el('th', { text: 'Event folded' }),
              el('th.num', { text: 'Matched chain-wide' }),
            ),
          ),
          el(
            'tbody',
            null,
            ...rows.map((r) =>
              el(
                'tr',
                null,
                el('td', { text: r.chain }),
                el('td', null, el('code', { text: r.name })),
                el('td.num', { text: r.reachable ? compact(r.onChain) : 'not read' }),
              ),
            ),
          ),
        ),
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
              el('th', { text: 'Chain' }),
              el('th', { text: 'Archive head' }),
              el('th', { text: 'Read from block' }),
              el('th.num', { text: 'Measured s/block' }),
              el('th.num', { text: 'Portal requests' }),
            ),
          ),
          el(
            'tbody',
            null,
            ...chains.map((c) =>
              el(
                'tr',
                null,
                el('td', { text: c.label }),
                el('td', { text: c.reachable ? `${compact(c.headBlock)} · ${(c.headAt ?? '').slice(0, 16).replace('T', ' ')}` : 'did not answer' }),
                el('td', { text: c.reachable ? `${compact(c.fromBlock)} · ${(c.fromAt ?? '').slice(0, 16).replace('T', ' ')}` : '—' }),
                // Measured from the archive's own timestamps at read time, never assumed. Asset
                // Hub's rate has moved by a factor of six since 2022, so a fixed divisor would
                // put the window's edge days away from where it is drawn.
                el('td.num', { text: c.msPerBlock ? (c.msPerBlock / 1000).toFixed(3) : '—' }),
                el('td.num', { text: c.reachable ? `${compact(c.requests)} · ${c.bucketsCached}/${c.buckets} cached` : '—' }),
              ),
            ),
          ),
        ),
      ),
    ),
    zero.length
      ? notice(
          'info',
          `${zero.length} of the ${rows.length} event types matched nothing chain-wide`,
          `${zero.map((r) => r.name).join(', ')} — rare rather than absent, most likely, but the archive answers 200 with no rows for an event name that does not exist at all, so a zero here is worth reading as "check the name" and not only as "quiet week".`,
        )
      : null,
    chains.some((c) => c.reachable && c.reachesCutoff === false)
      ? notice(
          'warning',
          'One chain could not be read back as far as the window asks',
          'Its earliest readable block is later than the start of the window, so that chain contributes less than the stated number of days.',
        )
      : null,
    totals.selfTransfers > 0
      ? el('p.note', {
          text: `${compact(totals.selfTransfers)} transfer${totals.selfTransfers === 1 ? '' : 's'} had this account at both ends. They are counted but have no counterparty, so they are not in the graph below.`,
        })
      : null,
  )
}

function noTransfersNotice(win, chains) {
  const reached = chains.filter((c) => c.reachable).map((c) => c.label)
  return notice(
    'info',
    'No transfers in this window',
    `This account was neither sender nor recipient of a transfer on ${reached.join(' or ')} between ${win.text}. ` +
      'That is a fact about this window and these two chains only — it says nothing about other parachains, about earlier ' +
      'periods, or about value that arrived by mint, deposit or fee rather than by a transfer.',
    'Widen the transfer window above, or check the swaps section below.',
  )
}

/**
 * Counterparties, ranked, with each bar split into what this account sent and what it received.
 *
 * ONE UNIT, and that is the whole design constraint. A bar length is a magnitude claim, so the
 * bars are denominated in a single asset — the one this account moved most often — and every
 * other asset lives in the table. Adding DOT to USDt to get a bar length would be the exact
 * category error this site refuses everywhere else.
 *
 * Linear from zero and shared-scale, so two bars are comparable to each other. An account that
 * moved only an asset the chain could not scale has no bar at all rather than a zero-length one:
 * `null` is not `0` here as everywhere.
 */
function counterpartyBars(counterparties, denomination) {
  if (!denomination) {
    return notice(
      'info',
      'Nothing here could be given a scale',
      'Every asset this account moved is one whose decimals are not published on chain, so there is no honest bar length to draw. The raw integer amounts are in the table below.',
    )
  }

  const drawable = counterparties.filter((c) => c.grossDenom !== null && c.grossDenom > 0)
  const top = drawable.slice(0, 25)
  const withoutBar = counterparties.length - drawable.length
  const series = [{ label: `sent by this account` }, { label: `received by this account` }]
  const host = el('div')
  const fmt = (n) => `${tokenAmount(n)} ${denomination.symbol}`

  const tally = segmentedRows(host, {
    rows: top.map((c) => ({
      label: shortAddr(c.address, 8, 6),
      sublabel: `${compact(c.transfers)} transfer${c.transfers === 1 ? '' : 's'}${c.structural ? ` · ${c.structural.kind}` : ''}`,
      total: c.grossDenom,
      segments: [c.sentDenom ?? 0, c.receivedDenom ?? 0],
      note: `${c.address}${c.structural ? ` — ${c.structural.label}` : ''}`,
    })),
    series,
    format: fmt,
    residualLabel: 'not attributed to either direction',
  })

  return el(
    'div',
    null,
    el('h3', { text: `Ranked by ${denomination.symbol} moved` }),
    el('p.note', {
      text:
        `The bar is what this account sent plus what it received, in ${denomination.symbol} — ${denomination.reason}. ` +
        'It is how much moved through the pair, not what either side kept. Other assets are in the table below and are ' +
        'deliberately not added in: one bar, one unit.',
    }),
    segmentedLegend(
      series,
      [top.reduce((n, c) => n + (c.sentDenom ?? 0), 0), top.reduce((n, c) => n + (c.receivedDenom ?? 0), 0)],
      fmt,
    ),
    top.length ? host : notice('info', `No counterparty moved any ${denomination.symbol}`, 'Every one of them moved a different asset. The table below has the amounts.'),
    counterparties.length > top.length
      ? el('p.note', { text: `The ${top.length} largest of ${compact(counterparties.length)} counterparties. Every one of them is in the table below.` })
      : null,
    withoutBar > 0
      ? el('p.note', {
          text: `${compact(withoutBar)} counterparties moved no ${denomination.symbol} at all and have no bar. They are absent from the ranking rather than drawn at zero — they moved a different asset, which is not the same as moving nothing.`,
        })
      : null,
    tally.short > 0
      ? notice(
          'warning',
          `${tally.short} bar${tally.short === 1 ? '' : 's'} did not fill`,
          'Sent and received should add up to the stated total. Where they do not, an amount could not be read.',
        )
      : null,
  )
}

/**
 * The ego network: this account in the ring with its largest counterparties, one arc per
 * direction.
 *
 * `flowGraph` is used exactly as it is — a deterministic circular layout, fixed node radius,
 * width and colour band carrying the magnitude. Two properties of it matter here and both are
 * the reason a Sankey would have been wrong: it bows A→B and B→A into two separate visible
 * arcs, and this graph is overwhelmingly cyclic — the same pair sends both ways. `plan.md` B7
 * records that an origin × destination view comes before a flow diagram for exactly this
 * reason.
 *
 * Node colour is the STRUCTURAL kind and nothing else, in fixed slot order, so it never encodes
 * rank and filtering never repaints the survivors.
 */
const GRAPH_NODES = 13

function egoGraph(data) {
  const { account, counterparties, denomination } = data
  if (!denomination) return null

  const top = counterparties.filter((c) => c.grossDenom !== null && c.grossDenom > 0).slice(0, GRAPH_NODES)
  if (top.length < 2) return null

  const groupOf = (c) => (c.isPallet ? 'pallet' : c.structural ? 'sovereign' : 'plain')
  const groups = [
    { key: 'self', label: 'this account' },
    { key: 'plain', label: 'no structural marker' },
    { key: 'pallet', label: 'pallet account (modl)' },
    { key: 'sovereign', label: 'sovereign account (para/sibl)' },
  ]

  // The ego first, so it sits at the top of the ring where a reader looks first.
  const nodes = [
    { id: 'self', label: shortAddr(account.address, 6, 4), group: 'self' },
    ...top.map((c) => ({ id: c.hex, label: shortAddr(c.address, 6, 4), group: groupOf(c) })),
  ]

  const edges = []
  for (const c of top) {
    if (c.sentDenom > 0) edges.push({ from: 'self', to: c.hex, value: c.sentDenom, count: c.sentCount })
    if (c.receivedDenom > 0) edges.push({ from: c.hex, to: 'self', value: c.receivedDenom, count: c.receivedCount })
  }
  if (!edges.length) return null

  const host = el('div')
  flowGraph(host, {
    nodes,
    edges,
    groups,
    format: tokenAmount,
    unit: denomination.symbol,
  })

  const both = top.filter((c) => c.direction === 'both').length
  return el(
    'div',
    null,
    el('h3', { text: 'The same thing as a graph' }),
    el('p.note', {
      text:
        `This account and its ${top.length} largest counterparties, valued in ${denomination.symbol}. Each pair can have two ` +
        `arcs, one per direction${both ? `, and ${both} of these ${top.length} pairs do` : ''} — which is why this is drawn as a ` +
        'graph and not as a Sankey: value flows both ways between the same accounts, and a Sankey has to pretend it does not.',
    }),
    host,
    el('p.note', {
      text: 'Node colour is the structural kind of the account, read from its bytes. Node size carries nothing. The table below is where the links are — click a counterparty there to make it the subject of this page.',
    }),
  )
}

/** The hop. Preserves both windows so a walk keeps the settings the reader chose. */
function hopLink(address, text) {
  const q = new URLSearchParams(location.search)
  q.set('address', address)
  return el('a', { href: `/account/?${q}`, text, title: address, style: 'overflow-wrap:anywhere' })
}

/**
 * Every counterparty, with the amounts, and each one a link back to this page.
 *
 * This table is the feature. The bars rank and the graph shapes, but neither is clickable, and
 * "follow the money" means the next hop is one click away rather than a copy-paste into a
 * search box. Sorted by the denominating asset with the count as the tiebreak, so the row a
 * reader wants is near the top under either reading of "biggest".
 */
function counterpartyTable(counterparties, totals, denomination) {
  const unit = denomination?.symbol ?? '—'
  const dropped = totals.counterparties - totals.counterpartiesShown

  const amounts = (c) =>
    c.assets.length === 0
      ? '—'
      : c.assets
          .map((a) => {
            const name = assetLabel(a)
            // `null` is not `0`: an asset with no published decimals shows its raw integer and
            // says so, rather than being silently divided by one.
            const sent = a.sent === null ? `${a.sentRaw} raw` : tokenAmount(a.sent)
            const recv = a.received === null ? `${a.receivedRaw} raw` : tokenAmount(a.received)
            return `${name} −${sent} / +${recv}`
          })
          .join('  ·  ')

  return el(
    'div',
    null,
    el('h3', { text: 'Every counterparty — click one to make it the subject of this page' }),
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
            el('th', { text: 'Counterparty' }),
            el('th', { text: 'Kind' }),
            el('th.num', { text: 'Transfers' }),
            el('th', { text: 'Direction' }),
            el('th.num', { text: `Sent ${unit}` }),
            el('th.num', { text: `Received ${unit}` }),
            el('th', { text: 'Every asset, sent / received' }),
            el('th', { text: 'Last seen' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...counterparties.map((c) =>
            el(
              'tr',
              null,
              el('td', null, hopLink(c.address, shortAddr(c.address, 10, 8))),
              el('td', { text: c.structural ? c.structural.label : '—', title: c.structural ? 'Read from the bytes of the address' : 'No structural marker' }),
              el('td.num', { text: compact(c.transfers) }),
              el('td', { text: c.direction === 'both' ? 'both ways' : c.direction === 'out' ? 'out only' : 'in only' }),
              el('td.num', { text: c.sentDenom === null ? '—' : tokenAmount(c.sentDenom) }),
              el('td.num', { text: c.receivedDenom === null ? '—' : tokenAmount(c.receivedDenom) }),
              el('td', { text: amounts(c), style: 'overflow-wrap:anywhere' }),
              el('td', { text: c.lastAt.slice(0, 16).replace('T', ' ') }),
            ),
          ),
        ),
      ),
    ),
    dropped > 0
      ? el('p.note', {
          text: `The ${compact(totals.counterpartiesShown)} largest of ${compact(totals.counterparties)} counterparties. The remaining ${compact(dropped)} are real and are counted in the totals above; they are not listed here.`,
        })
      : el('p.note', { text: `All ${compact(totals.counterparties)} counterparties in the window.` }),
  )
}

/**
 * What moved, per asset. `decimals` is read from the chain on every request — `system_properties`
 * for the native token and `Assets::Metadata` under a computed key for everything else — and the
 * `Scale` column says which, because a decimals error is a silent factor of 10ⁿ on every figure
 * above and an asset with no published decimals must be visibly different from one with a scale
 * of 1.
 */
function assetsTable(assets) {
  if (!assets.length) return null
  const unscalable = assets.filter((a) => a.decimals === null)

  return el(
    'div',
    null,
    el(
      'details',
      null,
      el('summary', { text: `Every asset this account moved (${assets.length})` }),
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
              el('th', { text: 'Chain' }),
              el('th', { text: 'Scale' }),
              el('th.num', { text: 'Transfers' }),
              el('th.num', { text: 'Counterparties' }),
              el('th.num', { text: 'Sent' }),
              el('th.num', { text: 'Received' }),
            ),
          ),
          el(
            'tbody',
            null,
            ...assets.map((a) =>
              el(
                'tr',
                null,
                el('td', { text: assetLabel(a), title: a.key, style: 'overflow-wrap:anywhere' }),
                el('td', { text: a.chain }),
                el('td', { text: a.decimals === null ? 'none published' : `10^${a.decimals}`, title: a.source }),
                el('td.num', { text: compact(a.transfers) }),
                el('td.num', { text: compact(a.counterparties) }),
                el('td.num', { text: a.sent === null ? `${a.sentRaw} raw` : tokenAmount(a.sent) }),
                el('td.num', { text: a.received === null ? `${a.receivedRaw} raw` : tokenAmount(a.received) }),
              ),
            ),
          ),
        ),
      ),
    ),
    unscalable.length
      ? notice(
          'info',
          `${unscalable.length} asset${unscalable.length === 1 ? '' : 's'} could not be scaled`,
          'Nothing on chain publishes their decimals, so their amounts are shown as raw integers and are excluded from every bar. That is different from being worth nothing, and they are not drawn at zero.',
        )
      : null,
  )
}

/** The individual transfers, newest first. The bars and the graph are computed from all of
 *  them in the window, not from this list. */
function recentTransfersTable(transfers, shown, totals) {
  if (!transfers?.length) return null
  return el(
    'details',
    null,
    el('summary', {
      text:
        shown < totals.transfers
          ? `The ${compact(shown)} most recent of ${compact(totals.transfers)} transfers`
          : `All ${compact(shown)} transfers in the window`,
    }),
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
            el('th', { text: 'When' }),
            el('th', { text: 'Chain' }),
            el('th', { text: 'Direction' }),
            el('th', { text: 'Counterparty' }),
            el('th.num', { text: 'Amount' }),
            el('th', { text: 'Event' }),
            el('th.num', { text: 'Block' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...transfers.map((t) =>
            el(
              'tr',
              null,
              el('td', { text: t.at.slice(0, 16).replace('T', ' ') }),
              el('td', { text: t.chain }),
              el('td', { text: t.direction === 'out' ? 'sent' : 'received' }),
              el('td', null, hopLink(t.counterparty, shortAddr(t.counterparty, 8, 6))),
              el('td.num', { text: t.amount === null ? `${t.amountRaw} raw` : `${tokenAmount(t.amount)} ${t.symbol ?? ''}`.trim() }),
              el('td', null, el('code', { text: t.event })),
              el('td.num', { text: compact(t.block) }),
            ),
          ),
        ),
      ),
    ),
  )
}

/* ═══════════════════════════════════════════════════════════════════════ data notes ═══════ */

/**
 * Rule 3, once, at the foot of the page, covering both halves. Two separately-titled caveat
 * lists is how a reader learns to skip the second one.
 */
function notesCard(graph, hydration) {
  const items = []

  if (graph) {
    const { window: win, totals, chains, denomination, assets } = graph
    const reached = chains.filter((c) => c.reachable)

    items.push(
      `Transfers are bounded to ${reached.map((c) => c.label).join(' and ')} between ${win.text} — the last ${win.days} day${win.days === 1 ? '' : 's'} ending at the ARCHIVE's head, which is not the chain's head.`,
    )
    items.push(
      'They are folded from transfer events, which name two parties. `Deposit`, `Withdraw` and `Minted` name only one, so fees, staking rewards and the mint/burn halves of XCM have no counterparty and are not here at all — in an Asset Hub sample on 2026-08-21 those made up 65% of balance-changing events. This is a transfer graph, not a balance history.',
    )
    items.push(
      'Nothing on any other parachain is here. A transfer on Hydration, Bifrost or Moonbeam is not measured and is not counted as zero.',
    )
    if (win.spansMigration) {
      items.push(
        `This window crosses the Asset Hub Migration of ${win.migrationDay}. Before it the relay chain carried the traffic; after it Asset Hub does. The two are shown separately and are never added together.`,
      )
    } else {
      const relay = chains.find((c) => c.key === 'relay')
      if (relay?.reachable) {
        items.push(
          `The relay chain carried ${compact(relay.transfersOnChain)} transfers in total, chain-wide, in this window — against ${compact(chains.find((c) => c.key === 'asset-hub')?.transfersOnChain ?? 0)} on Asset Hub. That collapse is the Asset Hub Migration of ${win.migrationDay}, not an error.`,
        )
      }
    }
    if (denomination) {
      items.push(
        `The counterparty bars are denominated in ${denomination.symbol} alone — ${denomination.reason}. Other assets are in the tables and are deliberately never added to it: there is no exchange rate anywhere on this page.`,
      )
    }
    if (totals.palletCounterparties > 0) {
      items.push(
        `${compact(totals.palletCounterparties)} of ${compact(totals.counterparties)} counterparties are pallet accounts — the ASCII "modl" prefix — which is protocol machinery rather than people. They are labelled, not filtered: on a busy chain they dominate a naive graph and hiding them would misstate the totals.`,
      )
    }
    if (totals.sovereignCounterparties > 0) {
      items.push(
        `${compact(totals.sovereignCounterparties)} counterparties are parachain sovereign accounts — the "para" or "sibl" prefix. Value moving to one of those is usually a cross-chain transfer leaving this chain.`,
      )
    }
    items.push(
      'Counterparty labels are STRUCTURAL only: they are decoded from the bytes of the address and cannot be wrong about what kind of account it is. Nothing here claims to know who operates any address, and no exchange, service or person is named anywhere on this page.',
    )
    if (totals.unscalableAssets > 0) {
      items.push(
        `${totals.unscalableAssets} of ${assets.length} assets have no decimals published on chain. Their amounts are raw integers and they are absent from the bars rather than drawn at zero.`,
      )
    }
    items.push(
      'Amounts are per asset in the asset’s own units. There are no dollar figures in the transfer section, because pricing every asset at every block is a different problem and a wrong price is worse than none.',
    )
    if (totals.counterparties > totals.counterpartiesShown) {
      items.push(
        `The counterparty table lists ${compact(totals.counterpartiesShown)} of ${compact(totals.counterparties)} rows. The totals above count all of them.`,
      )
    }
  }

  if (hydration) items.push(...hydrationNoteItems(hydration))
  items.push('Addresses are matched on the 32-byte public key, so the same account resolves whatever network prefix you paste.')

  const liveness = graph ? livenessNotes(graph.meta?.liveness) : null

  return el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'Data notes' })),
    liveness ? el('h3', { text: 'How current each upstream is' }) : null,
    liveness,
    liveness
      ? el('p.note', {
          text: 'The archive answers every query in under a second whether it is current or four months old — its own `real_time` flag is false for every Polkadot dataset, including the live ones — so its head timestamp is checked against the clock on every request. See docs/platform/sqd-portal.md.',
        })
      : null,
    el('ul', null, ...items.map((t) => el('li', { text: t, style: 'overflow-wrap:anywhere' }))),
  )
}

/**
 * A short name for an asset, for a table cell.
 *
 * `ForeignAssets` is keyed by an XCM location rather than an integer, and the raw key is a
 * hundred characters of JSON that makes a table unreadable. This restates the location
 * compactly — it does not name it. `GlobalConsensus: Kusama` is what the chain said; "the
 * Kusama bridge" would be an interpretation, and interpretations of an asset id are how two
 * different USDCs end up added together. The full key stays in the cell's `title`.
 */
function assetLabel(asset) {
  if (asset.symbol) return asset.symbol
  const key = String(asset.key ?? '')
  const at = key.indexOf('foreign:')
  if (at < 0) return key.split('/').pop()
  try {
    const location = JSON.parse(key.slice(at + 'foreign:'.length))
    const junctions = [].concat(location?.interior?.value ?? [])
    const parts = junctions
      .map((j) => {
        const value = j?.value
        const name = value?.__kind ?? (typeof value === 'object' ? null : value)
        const chainId = value?.chainId
        return j?.__kind ? `${j.__kind}:${name ?? '?'}${chainId ? `/${chainId}` : ''}` : null
      })
      .filter(Boolean)
    return `foreign(${location?.parents ?? '?'}, ${parts.join(', ') || location?.interior?.__kind || '?'})`
  } catch {
    return 'foreign asset'
  }
}
