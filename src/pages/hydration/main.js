// Hydration DEX activity. Two views of one venue, chosen by the window control.
//
// ── the short windows: 1–14 days ─────────────────────────────────────────────────────────────
// The same dashboard as /hyperfx/, different normaliser on the server. Every routed trade in the
// window is fetched and priced, which is what makes the routes, the accounts and the dollar
// volume possible — and what caps it at fourteen days: a day is ~3 s of upstream, so a month
// would be a minute of page load. That cap is OURS and is a cost decision.
//
// ── the long ranges: 3 months, 12 months, everything ─────────────────────────────────────────
// "You want to actually compare very long time frames" — and the data for that already existed
// with nothing rendering it. `hydration/swaps-daily` has been storing one walked, priced day per
// fact, a calendar month at a time, since 2026-08-20; orca's index reaches back to 2025-01-25.
//
// A long range cannot use the short view's machinery: nineteen months is 6.6 million routed
// trades and about 84 minutes of fetching. It reads the STORE for whole past months and a
// counted live tail for the days since — decision 0012, the same shape /netflows/ uses. The two
// meet at a seam that moves by a day every day, and `history.js` draws it and says where it is.
//
// Both views share this file and nothing else: they answer different questions at different
// fidelities, and merging their renderers would mean one of the two lying about what it has.

import '../../design/app.css'
import { renderSwapDashboard } from '../../design/swap-dashboard.js'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { loadHistory, RANGES, renderHistory } from './history.js'

const WINDOW = new URLSearchParams(location.search).get('days') ?? '7'
const isLong = Object.hasOwn(RANGES, WINDOW)

renderPage({
  page: pageByKey('hydration'),
  intro: isLong
    ? 'Hydration emits one event per swap leg, not per trade — a single router route through four pools is four events. Over months and years, these are the trades those legs add up to: whole past months walked once and kept, and the days since counted live. The two halves are not the same fidelity and the page says where they meet.'
    : 'Hydration emits one event per swap leg, not per trade — a single router route through four pools is four events. These are the trades those legs add up to, as Hydration’s own indexer groups them, priced against the dollar-pegged legs in the same window. The newest day is still in progress.',
  controls: [
    choiceControl({
      label: 'Window',
      param: 'days',
      value: WINDOW,
      options: [
        ...[1, 3, 7, 14].map((n) => ({ value: n, label: `${n}d` })),
        { value: '3m', label: '3m' },
        { value: '12m', label: '12m' },
        { value: 'all', label: 'all' },
      ],
      hint: 'Up to 14 days is every trade in the window, fetched and priced on the spot — routes, accounts and dollars. From three months up it is the daily series instead: whole past months from a store that keeps them, plus the days since counted live. The data reaches back to January 2025.',
    }),
  ],
  skeleton: isLong ? ['stats', 'chart', 'chart'] : ['stats', 'chart'],
  loadingLabel: isLong ? 'Reading the daily history' : 'Reading Hydration’s indexer',
  load: (ctx) => (isLong ? loadHistory(WINDOW, ctx) : read('hydration', 'swaps', { days: WINDOW })),
  // The ranked list answers "who trades here". `accountHref` turns each name into "and what did
  // this one do", which is the only reason to show the list. A pallet account is deliberately
  // NOT linked: its rows are the chain doing its own work, and /account/ is about a trader.
  render: (host, data) =>
    isLong
      ? renderHistory(host, data)
      : renderSwapDashboard(host, data, {
          accountHref: (account) =>
            account.account.startsWith('pallet:')
              ? null
              : `/account/?address=${encodeURIComponent(account.account)}&days=${encodeURIComponent(WINDOW)}`,
        }),
})
