// Capital on Hydration — the stock question, where /hydration/ asks the flow question.
// Twenty lines, because the board lives next door in `board.js`, which is what lets the
// arithmetic and the rendering be exercised without a browser.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { renderCapital } from './board.js'

renderPage({
  page: pageByKey('hydration-capital'),
  intro:
    'Hydration holds capital in four places — the Omnipool, seventeen stableswap pools, two hundred and ninety XYK pools, and an Aave-fork money market — and those four places hold each other’s receipt tokens, several layers deep. Adding them up counts the same money about one and a half times. This page reads every position, resolves each one to the base asset behind it, and counts each unit once. It shows the gross figure too, and exactly what had to come out of it.',
  load: () => read('hydration', 'capital'),
  render: renderCapital,
  skeleton: ['stats', 'chart', 'chart'],
  loadingLabel: 'Reading Hydration’s four venues',
})
