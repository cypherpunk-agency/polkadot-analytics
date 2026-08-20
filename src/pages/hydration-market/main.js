// Hydration money market. Twenty lines, because the board lives next door in `board.js` —
// splitting it out is what lets the rendering be exercised outside a browser.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { renderMoneyMarket } from './board.js'

renderPage({
  page: pageByKey('hydration-market'),
  intro:
    'Hydration’s lending market is an Aave v3 fork living in EVM contracts, not a pallet — which is why its numbers are so often reported wrong. Everything here is read over the chain’s own eth_* endpoint: every reserve with its rates, utilisation and caps; HOLLAR’s real supply and the five facilitators allowed to mint it; and the Omnipool balance sheet read by all three storage paths, because reading it by one silently loses two thirds of the pool.',
  load: () => read('hydration-evm', 'market'),
  render: renderMoneyMarket,
})
