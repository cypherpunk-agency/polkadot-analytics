// Hydration DEX activity. Same dashboard as /hyperfx/, different normaliser on the server.

import '../../design/app.css'
import { renderSwapDashboard } from '../../design/swap-dashboard.js'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'

// The window is short and capped on purpose: every extra day is another ~11,000 events pulled
// from an archive we do not own. The control says so rather than presenting seven days as a
// free preference.
const DAYS = new URLSearchParams(location.search).get('days') ?? '3'

renderPage({
  page: pageByKey('hydration'),
  intro:
    'Hydration emits one event per swap leg, not per trade — a single router route through four pools is four events. These are the legs regrouped into the trades people actually made, priced against the dollar-pegged legs in the same window.',
  controls: [
    choiceControl({
      label: 'Window',
      param: 'days',
      value: DAYS,
      options: [1, 2, 3, 5, 7].map((n) => ({ value: n, label: `${n}d` })),
      hint: 'Capped at seven days: each day is ~11,000 events fetched from a public archive.',
    }),
  ],
  load: () => read('hydration', 'swaps', { days: DAYS }),
  render: renderSwapDashboard,
})
