// Parachain netflows, 2021–2023. The one page on this site that reads no live endpoint.
//
// The dataset is a 2023 Polkalytics study by Tommi Enenkel of the DOT and KSM held in parachain
// sovereign accounts. The original produced 25 MB of plotly HTML; the charts here are redrawn
// from the source CSVs into an 83 KB committed dataset, which is both far lighter and the only
// version that renders at all under this site's CSP (the plotly output relies on inline script).
//
// ── the thing this page has to be loud about ────────────────────────────────────────────────
// It is an ARCHIVE. Every number on it stopped moving in April 2023. A visitor who lands here
// from the front page and reads the lines as current holdings has been misled by the page, not
// by themselves — so the window is stated in the title, the eyebrow, the notice at the top and
// the axis. Redundant on purpose.
//
// Re-deriving the dataset from the raw CSVs also turned up three places where the written
// report and the data disagree. Those are rendered rather than quietly reconciled: the numbers
// in `reportDiscrepancies` come out of the same file the charts are drawn from.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { compact, percent } from '../../core/format.js'
import dataset from '../../data/netflows.json'

const NETWORK = new URLSearchParams(location.search).get('network') === 'kusama' ? 'kusama' : 'polkadot'

/** A chain whose daily line understates its true peak by more than this gets marked on the row. */
const CLIP_THRESHOLD = 0.03

function render(host) {
  clear(host)
  const network = dataset.networks[NETWORK]
  const { token } = network
  const amount = (value) => `${compact(value)} ${token}`

  const totalPeak = network.chains.reduce((sum, chain) => sum + chain.peak, 0)
  const totalLast = network.chains.reduce((sum, chain) => sum + chain.last, 0)
  const clipped = network.chains.filter((chain) => chain.clipped > CLIP_THRESHOLD)

  append(
    host,
    notice(
      'info',
      `This is an archive: it ends ${network.last}`,
      `Nothing on this page has moved since ${network.last}. It is a re-rendering of a study published in 2023, kept because the shape of the era is still worth looking at — not because these are anyone's current holdings.`,
    ),

    statRow([
      statTile('Chains tracked', String(network.chains.length), `sovereign accounts above the study's floor`, { hero: true }),
      statTile('Largest holding', amount(network.chains[0].peak), `${network.chains[0].name}, at its peak`),
      statTile('Sum of peaks', amount(totalPeak), 'not simultaneous — each chain at its own high'),
      statTile('Held at the end', amount(totalLast), `across all ${network.chains.length}, on ${network.last}`),
    ]),

    chartCard(network, token),
    rankCard(network, amount, clipped),
    clipped.length ? clipNotice(clipped, token) : null,
    discrepanciesCard(),
    notes(network),
  )
}

/* ------------------------------------------------------------------------------ chart ---- */

function chartCard(network, token) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held in parachain sovereign accounts` }),
      el('p.note', {
        text: 'One shared scale, which is the point: it is what makes the difference between the top two and everyone else legible. A line begins where that chain first appears in the data — before that it is absent, not zero.',
      }),
    ),
  )

  const legend = el('ul.legend')
  network.chains.forEach((chain, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${chain.name} `),
        el('span.amt', { text: compact(chain.dailyPeak) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: network.days,
      series: network.chains.map((chain) => ({ label: chain.name, values: chain.series })),
      format: compact,
      height: 380,
    }),
  )
  return card
}

/* ------------------------------------------------------------------------------- rank ---- */

function rankCard(network, amount, clipped) {
  const max = network.chains[0].peak
  const list = el('div.rows')
  network.chains.forEach((chain, i) => {
    const isClipped = chain.clipped > CLIP_THRESHOLD
    append(
      list,
      el(
        'div.row.rank-row',
        { title: chain.address },
        el('div.rank', { text: String(i + 1) }),
        el('div.name', { text: chain.name }),
        el(
          'div.track',
          null,
          el('div.fill', { style: `width:${Math.max(0.5, (chain.peak / max) * 100)}%;background:${seriesColor(i)}` }),
        ),
        el('div.amt', { text: amount(chain.peak) }),
        el(
          'div.amt',
          null,
          el('span.cnt', {
            // The clip figure travels with the row rather than living only in a caveat, because
            // the reader who needs it is the one looking at this specific line.
            text: isClipped ? `↕ −${percent(chain.clipped * 100, 1)} clipped` : `ended ${compact(chain.last)}`,
          }),
        ),
      ),
    )
  })

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Ranked by peak holding' }),
      el('p.note', { text: 'Peak is the highest balance ever observed at full resolution, which is not always visible on the chart above — see below.' }),
    ),
    list,
    table(network),
  )
}

function table(network) {
  const body = el('tbody')
  for (const chain of network.chains) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: chain.name }),
        el('td.num', { text: compact(chain.peak) }),
        el('td.num', { text: compact(chain.dailyPeak) }),
        el('td.num', { text: percent(chain.clipped * 100, 2) }),
        el('td.num', { text: compact(chain.last) }),
        el('td.mono', { text: chain.address }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: 'Figures and sovereign account addresses' }),
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
            el('th.num', { text: 'Peak' }),
            el('th.num', { text: 'Peak (daily)' }),
            el('th.num', { text: 'Clipped' }),
            el('th.num', { text: 'At the end' }),
            el('th', { text: 'Sovereign account' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ------------------------------------------------------------------------- the caveats ---- */

function clipNotice(clipped, token) {
  return notice(
    'warning',
    `${clipped.length} of these lines understate their own peak`,
    dataset.source.caveats.resampling,
    `Affected here: ${clipped.map((chain) => `${chain.name} (−${percent(chain.clipped * 100, 1)})`).join(', ')}. Everything else on this ${token} chart is within ${percent(CLIP_THRESHOLD * 100)} of its true high.`,
  )
}

/**
 * The report and the data disagree in three places. Publishing the disagreement is the only
 * honest option once you have both: silently using the data would contradict a document that is
 * still online, and silently using the report would mean printing numbers we know are wrong.
 */
function discrepanciesCard() {
  const rows = dataset.reportDiscrepancies ?? []
  if (!rows.length) return null

  const body = el('tbody')
  for (const row of rows) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: row.claim, style: 'white-space:normal;max-width:22rem' }),
        el('td', { text: row.data, style: 'white-space:normal;max-width:22rem' }),
        el('td', { text: row.note, style: 'white-space:normal;max-width:22rem;color:var(--ink-secondary)' }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where the 2023 report and the data disagree' }),
      el('p.note', {
        text: 'Re-deriving this dataset from the raw CSVs in 2026 turned up three places where the published report says something the underlying data does not support. They are listed rather than reconciled — the report is still online and saying otherwise.',
      }),
    ),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, el('th', { text: 'The report says' }), el('th', { text: 'The data says' }), el('th', { text: 'Likely cause' }))),
        body,
      ),
    ),
  )
}

function notes(network) {
  const { caveats, rows } = dataset.source
  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Derived from ${compact(rows[NETWORK])} balance observations of ${network.chains.length} sovereign accounts, covering ${network.first} to ${network.last}. Balances are read at ${network.decimals} decimals.`,
    }),
    el(
      'ul',
      null,
      el('li', { text: caveats.coverage }),
      el('li', { text: caveats.filter }),
      el('li', {
        text: 'A parachain sovereign account holds the tokens backing what was minted on that parachain via reserve-backed transfer. It is not the whole picture: liquid-staking protocols on Acala, Parallel, Bifrost and Moonbeam may control more than their sovereign account shows.',
      }),
      el('li', {
        text: 'The original called these "netflows". Strictly they are balances over time — the term is kept because the study is published under it.',
      }),
    ),
    el(
      'p',
      null,
      document.createTextNode('Original study and source code: '),
      el('a', { href: dataset.source.repo, text: dataset.source.repo }),
      document.createTextNode(`. Dataset regenerated ${String(dataset.generated).slice(0, 10)} by `),
      el('code', { text: 'npm run data:netflows' }),
      document.createTextNode('.'),
    ),
    el('p', { text: 'Full disclosure carried over from the original report: at the time of writing the author had a contractual relationship with Mangata Finance.' }),
  )
}

renderPage({
  page: pageByKey('netflows'),
  intro:
    'When DOT moves to a parachain it does not leave the relay chain — it is locked in that parachain’s sovereign account and minted on the other side. Watching those accounts is the closest thing to watching capital move across the network. This is that history, from the first parachain to April 2023.',
  controls: [
    choiceControl({
      label: 'Network',
      param: 'network',
      value: NETWORK,
      options: [
        { value: 'polkadot', label: 'Polkadot · DOT' },
        { value: 'kusama', label: 'Kusama · KSM' },
      ],
    }),
  ],
  // Committed dataset, bundled at build time — there is no request to fail. The harness still
  // wraps it, so a malformed dataset surfaces as an error state rather than a blank page.
  load: async () => dataset,
  render,
})
