// HyperFX swap volume. Fifteen lines, because the dashboard is shared — see
// src/design/swap-dashboard.js and docs/architecture/middleware.md.

import '../../design/app.css'
import { renderSwapDashboard } from '../../design/swap-dashboard.js'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'

renderPage({
  page: pageByKey('hyperfx'),
  intro:
    'Every order behind the HyperFX history page, valued on the input leg, then broken down by day, by route, and by the accounts behind them. HyperFX shows a different headline total; the data notes at the bottom explain why, and why this one sums the orders.',
  load: () => read('hyperbridge', 'swaps'),
  render: renderSwapDashboard,
})
