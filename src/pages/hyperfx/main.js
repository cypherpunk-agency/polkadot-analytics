// HyperFX. Two views of one venue, both at `/hyperfx/` and both selected by the query string,
// so any of them can be linked, bookmarked and quoted in a bug report:
//
//   /hyperfx/                          the volume dashboard — the shared swap dashboard, plus
//                                      the latest orders and the three rival "total volume"
//                                      figures side by side.
//   /hyperfx/?view=orders              every order, filtered BY THE INDEXER on address, chain,
//                                      status and day.
//   /hyperfx/?view=orders&address=0x…  one address: what it placed, what it filled for others.
//
// The dashboard itself is shared with /hydration/ — see src/design/swap-dashboard.js and
// docs/architecture/middleware.md. This file adds the venue-specific drill-down around it and
// no CSS at all.

import '../../design/app.css'
import { renderSwapDashboard } from '../../design/swap-dashboard.js'
import { renderPage, choiceControl } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { latestOrdersCard, ordersParamsFromUrl, renderOrders, volumeComparisonCard } from './orders.js'

const query = new URLSearchParams(location.search)
// `address` alone is enough: a link to an address is a link to that address's transactions.
const showOrders = query.get('view') === 'orders' || query.has('address')

const page = pageByKey('hyperfx')

if (showOrders) {
  renderPage({
    page,
    intro:
      'Every intent order behind the HyperFX history page, one row at a time: what was sent, what came back, the rate it got, who filled it and how long that took. The address, chain, status and day filters are applied by the indexer rather than in this browser, so the count beside the filter is the whole history and the table is one page of it.',
    load: () => read('hyperbridge', 'orders', ordersParamsFromUrl()),
    render: renderOrders,
  })
} else {
  renderPage({
    page,
    intro:
      'Every order behind the HyperFX history page, valued on the input leg, then broken down by day, by route, and by the accounts behind them. HyperFX shows a different headline total; the data notes at the bottom explain why, and why this one sums the orders.',
    load: async () => {
      const [swaps, latest] = await Promise.all([
        read('hyperbridge', 'swaps'),
        // Eight rows is the strip, not the table. The full feed is one click away and pages
        // fifty at a time; fetching more here would be paid for by every visitor to the chart.
        read('hyperbridge', 'orders', { limit: 8 }),
      ])
      return { swaps, latest }
    },
    render: (host, { swaps, latest }) => {
      renderSwapDashboard(host, swaps)

      // The shared renderer puts its data-notes section last, and that is where a reader looks
      // for them. Insert ahead of it rather than appending, so nothing lands below the notes.
      const notes = host.querySelector('section.meta')
      const before = (node) => {
        if (!node) return
        if (notes) notes.before(node)
        else host.append(node)
      }

      // Content first, caveat second: the latest orders, then the three rival totals, then the
      // shared renderer's data notes that explain them.
      before(latestOrdersCard(latest))
      before(volumeComparisonCard(swaps.meta?.volume))

      host.prepend(
        choiceControl({
          label: 'View',
          param: 'view',
          value: 'volume',
          options: [
            { value: 'volume', label: 'Volume' },
            { value: 'orders', label: 'Transactions' },
          ],
          hint: 'the transactions view filters by address, chain, status and day',
        }),
      )
    },
  })
}
