// Hydration DEX activity. Same dashboard as /hyperfx/, different normaliser on the server.

import '../../design/app.css'
import { renderSwapDashboard } from '../../design/swap-dashboard.js'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'

// The window is a count of whole UTC days ending with today, and the server resolves both edges
// to real block heights before it fetches anything. Fourteen is a cost cap of ours, not the edge
// of the data — the source holds routed trades back to January 2025, and the page's data notes
// say so along with the exact days and blocks drawn.
const DAYS = new URLSearchParams(location.search).get('days') ?? '7'

renderPage({
  page: pageByKey('hydration'),
  intro:
    'Hydration emits one event per swap leg, not per trade — a single router route through four pools is four events. These are the trades those legs add up to, as Hydration’s own indexer groups them, priced against the dollar-pegged legs in the same window. The newest day is still in progress.',
  controls: [
    choiceControl({
      label: 'Window',
      param: 'days',
      value: DAYS,
      options: [1, 3, 7, 14].map((n) => ({ value: n, label: `${n}d` })),
      hint: 'Whole UTC days, ending with today. Capped at fourteen because a day is ~8,500 trades pulled from an indexer we do not own — not because the history stops there.',
    }),
  ],
  load: () => read('hydration', 'swaps', { days: DAYS }),
  // The ranked list answers "who trades here". `accountHref` turns each name into "and what did
  // this one do", which is the only reason to show the list. A pallet account is deliberately
  // NOT linked: its rows are the chain doing its own work, and /account/ is about a trader.
  render: (host, data) =>
    renderSwapDashboard(host, data, {
      accountHref: (account) =>
        account.account.startsWith('pallet:')
          ? null
          : `/account/?address=${encodeURIComponent(account.account)}&days=${encodeURIComponent(DAYS)}`,
    }),
})
