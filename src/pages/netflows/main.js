// Parachain netflows: DOT and KSM held in parachain sovereign accounts, day by day, 2021–2023.
//
// The dataset is a 2023 Polkalytics study by Tommi Enenkel of the DOT and KSM held in parachain
// sovereign accounts. The original produced 25 MB of plotly HTML; the charts here are redrawn
// from the source CSVs into an 83 KB committed dataset, which is both far lighter and the only
// version that renders at all under this site's CSP (the plotly output relies on inline script).
//
// ── one page, one chart, and why the rest of it left ─────────────────────────────────────────
// For a day this page also carried a live read of the same accounts: today's balances, the gap
// between the two readings drawn to scale, a then/now comparison per chain. All of it was true,
// and none of it was netflows — a reader arrived at the top of a page named for a time series
// and scrolled past eight blocks before reaching one. The live half now has its own page at
// `/sovereign/`, which is where today's figures, the gap card, the then/now comparison and the
// Asset Hub Migration caveat went. What is left here is the archive, and the archive opens on
// its chart. `/sovereign/` is the page that reads a chain; this one reads a file.
//
// ── the caveats that stayed, because they are about this dataset rather than about today ─────
//
//  1. IT STOPPED. The series ends 2023-04-08 on Polkadot and 2023-03-12 on Kusama, and nothing
//     here has moved since. That is asserted as a `frozen` liveness report in the same
//     vocabulary the live pages use, because this is the page where a reader is most likely to
//     take old numbers for current ones.
//
//  2. THE ACCOUNTS IT MEASURED ARE NO LONGER WHERE THE MONEY IS. It read `System::Account` for
//     each chain's `para` account ON THE RELAY CHAIN, which in 2023 was where a parachain's DOT
//     actually sat. The Asset Hub Migration moved that money to the `sibl` account on Asset Hub.
//     Re-running the 2023 method against the relay today returns a few hundred DOT per
//     parachain and looks entirely reasonable — which is why the addresses in the table below
//     are a historical record rather than somewhere to go and look now.
//
//  3. CHAINS LEAVE. Three of the eight chains the Polkadot archive tracks have been
//     deregistered since it ended — Equilibrium 2025-07-08, Parallel 2025-12-20, Moonbeam
//     2026-08-10 — and so has Moonriver on the Kusama side. Their lines are not wrong and are
//     not removed; the row says the chain has since left, because a 2023 line for a chain that
//     no longer exists reads as a current holding otherwise.
//
// Re-deriving the dataset from the raw CSVs also turned up three places where the written
// report and the data disagree. Those are rendered rather than quietly reconciled: the numbers
// in `reportDiscrepancies` come out of the same file the charts are drawn from.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { liveness } from '../../core/liveness.js'
import { livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, percent } from '../../core/format.js'
import { resolveChain } from '../../core/topology.js'
import dataset from '../../data/netflows.json'

const NETWORK = new URLSearchParams(location.search).get('network') === 'kusama' ? 'kusama' : 'polkadot'

/** A chain whose daily line understates its true peak by more than this gets marked on the row. */
const CLIP_THRESHOLD = 0.03

/**
 * The date the money left the accounts this dataset measured.
 *
 * Two dates and nothing else. The full account of the Asset Hub Migration — what moved, the
 * bisection that dated it, and the fact that it was progressive rather than atomic — lives on
 * `/sovereign/` beside the numbers it changed, and in `docs/platform/asset-hub.md`. The archive
 * needs it for exactly one sentence: the `para` accounts charted below stopped being where a
 * parachain's reserve sits, so nobody re-runs this measurement expecting it to still work.
 *
 * Polkadot's date was bisected in this repo (relay #28,493,861→862: Acala 3,137,094.16 DOT →
 * 341.00 DOT). Kusama's is transcribed from `docs/platform/asset-hub.md` and was not re-derived
 * here — the difference is stated on the page rather than smoothed over.
 */
const MIGRATED_ON = { polkadot: '2025-11-04', kusama: '2025-10-07' }

const amountOf = (token) => (value) => `${compact(value)} ${token}`

/**
 * The liveness assertion for an archive.
 *
 * Every other page on this site asserts liveness about an upstream it just read. This one has
 * no upstream — the dataset is compiled into the bundle — and the assertion is *more* useful
 * here, not less, because this is the page where a reader is most likely to mistake old numbers
 * for current ones. Stating the age in the same vocabulary the live pages use ("frozen", a lag
 * in days, the window covered) is what makes the two comparable at a glance.
 *
 * `frozen` is the correct state and it is arrived at honestly: the head is the last observation
 * in the file and the lag is measured against now, so this line gets older every day the page is
 * open, exactly as it should. The note is what stops it reading as a broken indexer — here the
 * stop is the point, and it will not resolve itself.
 *
 * Built from the same `network` object the charts are drawn from, so it cannot describe a
 * different dataset than the one on screen, and it changes when the network toggle does.
 */
function archiveLiveness(network) {
  return liveness({
    source: 'netflows',
    label: 'The archived Polkalytics netflows dataset',
    // End of the last UTC day in the file. The series is a daily close, so that is the instant
    // the newest number in it describes — not midnight at the start of that day.
    headAt: Date.parse(`${network.last}T23:59:59Z`),
    head: `${network.token} balances at the close of ${network.last}`,
    covers: { from: network.first, to: network.last },
    note:
      'Nothing was read at load time: this dataset ships inside the page. So “frozen” here is the ' +
      'permanent, intended state of an archive rather than a stalled indexer — it will not catch ' +
      `up, and no figure on this page has moved since ${network.last}. The file itself was ` +
      `regenerated on ${String(dataset.generated).slice(0, 10)} from the original CSVs.`,
  })
}

/**
 * What this site's registry has to say about an archived row's chain — three answers, not two.
 *
 * A chain the registry has never heard of is NOT a chain that is still running: `resolveChain`
 * returns `null` for both "no such alias" and would return an entry with no `retired` for a chain
 * it knows to be live. Collapsing those into "still registered" would print a claim nobody made,
 * on a page whose whole job is saying what is wrong with the number. All sixteen archived names
 * resolve today (verified 2026-08-20); the third state exists so that the day one stops
 * resolving, the table says so rather than vouching for it.
 */
const registryOf = (chain) => resolveChain(chain.name, NETWORK)
const retiredOf = (chain) => registryOf(chain)?.retired ?? null

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

/**
 * Nothing is fetched. The dataset is bundled, so it is either there or the build is broken —
 * which is why the only failure this can produce is a `decode` one, and why it is worth
 * throwing rather than rendering an empty chart: a network that is not in the file is a bad URL
 * parameter, not an upstream having a bad day.
 */
async function load({ progress }) {
  const network = dataset.networks[NETWORK]
  if (!network) throw Object.assign(new Error(`The archived dataset has no \`${NETWORK}\` network.`), { kind: 'decode' })

  progress({ stage: `Reading the archived ${network.token} dataset`, done: 1, total: 1 })
  return { network, archive: archiveLiveness(network) }
}

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

function render(host, { network, archive }) {
  clear(host)
  const { token } = network
  const amount = amountOf(token)

  const totalPeak = network.chains.reduce((sum, chain) => sum + chain.peak, 0)
  const totalLast = network.chains.reduce((sum, chain) => sum + chain.last, 0)
  const clipped = network.chains.filter((chain) => chain.clipped > CLIP_THRESHOLD)

  append(
    host,
    // The chart first, and deliberately first: it is the whole reason this page exists, and
    // every block that has ever been put above it has pushed it below the fold.
    chartCard(network, token),

    // Slim, and underneath. These four numbers are context for the chart, not a headline of
    // their own — as a hero row above it they were most of a screen before anything was drawn.
    statRow([
      statTile('Chains tracked', String(network.chains.length), `sovereign accounts above the study's floor`),
      statTile('Largest holding', amount(network.chains[0].peak), `${network.chains[0].name}, at its peak`),
      statTile('Sum of peaks', amount(totalPeak), 'not simultaneous — each chain at its own high'),
      statTile('Held at the end', amount(totalLast), `across all ${network.chains.length}, on ${network.last}`),
    ]),

    rankCard(network, amount, clipped),
    clipped.length ? clipNotice(clipped, token) : null,
    discrepanciesCard(),
    notes({ network, archive }),
  )
}

/* ══════════════════════════════════════════════════════════════════════════ the chart ═════ */

function chartCard(network, token) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      // The real window rather than "2021–2023": the two networks do not cover the same one
      // (Kusama starts seven months earlier and ends four weeks sooner), and a heading that
      // does not change with the toggle is a heading a reader stops reading.
      el('h2', { text: `${token} held in parachain sovereign accounts, ${network.first} → ${network.last}` }),
      el('p.note', {
        text: `One shared scale, which is the point: it is what makes the difference between the top two and everyone else legible. A line begins where that chain first appears in the data — before that it is absent, not zero. Nothing on it has moved since ${network.last}.`,
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
    const retired = retiredOf(chain)
    append(
      list,
      el(
        'div.row.rank-row',
        { title: retired ? `${chain.address}\n\n${retired.why}` : chain.address },
        el('div.rank', { text: String(i + 1) }),
        el(
          'div.name',
          // Wrapping rather than clipping, so the marker survives a narrow viewport: `.name`
          // never wraps by default, and at 390px the pill would simply vanish — which is the
          // one thing a "this chain has left" marker must never do.
          { style: 'overflow:visible;white-space:normal;display:flex;flex-wrap:wrap;gap:var(--s2);align-items:baseline' },
          el('span', { text: chain.name }),
          // The departure travels with the row, for the same reason the clip figure does: the
          // reader who needs it is the one looking at this specific line, and a chain that has
          // left is the strongest caveat any row here carries.
          retired ? el('span.pill', { data: { tone: 'warning' }, text: `left ${retired.on}` }) : null,
        ),
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
      el('p.note', {
        text: `Peak is the highest balance ever observed at full resolution, which is not always visible on the chart above${
          clipped.length ? ' — see below' : ''
        }.`,
      }),
    ),
    list,
    table(network),
  )
}

/**
 * The table is not an appendix. It is the accessibility fallback for the chart above — every
 * chart on this site has one — and it is the only place the sovereign addresses appear in full.
 */
function table(network) {
  const body = el('tbody')
  for (const chain of network.chains) {
    const entry = registryOf(chain)
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
        el('td', { text: !entry ? 'not in this site’s registry' : entry.retired ? `left ${entry.retired.on}` : 'still registered' }),
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
            el('th', { text: 'Since' }),
            el('th', { text: 'Sovereign account (2023)' }),
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

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const wrapAnywhere = (node) => (node ? style(node, 'overflow-wrap:anywhere') : node)

function notes({ network, archive }) {
  const { caveats, rows: sourceRows } = dataset.source
  const resolved = network.chains.map((chain) => ({ chain, entry: registryOf(chain) }))
  const retired = resolved.filter((row) => row.entry?.retired).map((row) => ({ chain: row.chain, retired: row.entry.retired }))
  const unknown = resolved.filter((row) => !row.entry).map((row) => row.chain.name)

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    // One report, and it says `frozen`. That is the honest state of every number on this page
    // and it is stated in the same vocabulary a live page uses, so the two are comparable.
    livenessNotes([archive]),

    el('h3', { text: 'What this measured' }),
    el('p', {
      text: `Derived from ${compact(sourceRows[NETWORK])} balance observations of ${network.chains.length} sovereign accounts, covering ${network.first} to ${network.last} — ${formatCount(network.days.length)} daily values per chain. Balances are read at ${network.decimals} decimals.`,
    }),
    wrapAnywhere(
      el(
        'ul',
        null,
        el('li', { text: caveats.coverage }),
        el('li', { text: caveats.filter }),
        el('li', {
          text: `Every address in the table above is a \`para\` account ON THE RELAY CHAIN, which in 2023 was where a parachain's DOT sat. The Asset Hub Migration (${MIGRATED_ON[NETWORK]}) moved those reserves to each chain's \`sibl\` account on Asset Hub, so these accounts are a historical record: re-running this measurement against the relay today returns a few hundred ${network.token} per parachain and looks entirely reasonable. What the same chains hold now is on /sovereign/, which reads both legs.`,
        }),
        el('li', {
          text:
            NETWORK === 'polkadot'
              ? `The ${MIGRATED_ON.polkadot} date was established in this repo by bisection — Acala's relay sovereign account falls from 3,137,094.16 DOT to 341.00 DOT across relay blocks #28,493,861→862 — and the migration was progressive rather than atomic, so different chains moved on different days.`
              : `The ${MIGRATED_ON.kusama} date for Kusama is transcribed from this repo's notes and was NOT re-derived the way the Polkadot one was. Nothing on this site reads Kusama today to check it.`,
        }),
        el('li', {
          text: retired.length
            ? `${retired.length} of the ${network.chains.length} chains charted here have since left the network: ${retired
                .map((row) => `${row.chain.name} on ${row.retired.on}`)
                .join(
                  ', ',
                )}. Their lines are historical and correct; the rows say so, because a 2023 series for a chain that no longer exists reads as a current holding otherwise. A chain being absent from that list is weaker than a claim that it is running — it came from one audit of the relays' registration storage on 2026-08-20 and nothing re-runs it.`
            : `This site's registry knows of no chain on this chart that has since left the network. That is weaker than a claim that all of them are running: the registry came from one audit of the relays' registration storage on 2026-08-20 and nothing re-runs it.`,
        }),
        // Only rendered when it is true, and it is not true today — all sixteen archived names
        // resolve. It exists because "not in the registry" and "still registered" are different
        // facts and the table above draws them differently; a note that appears the day a name
        // stops resolving beats one that has to be remembered.
        unknown.length
          ? el('li', {
              text: `${unknown.length} chain(s) on this chart are not in this site's registry at all — ${unknown.join(
                ', ',
              )}. The "Since" column says so rather than saying "still registered": we do not know either way, and printing the reassuring half of an unknown is the failure this page exists to avoid.`,
            })
          : null,
        el('li', {
          text: 'A parachain sovereign account holds the tokens backing what was minted on that parachain via reserve-backed transfer. It is not the whole picture: liquid-staking protocols on Acala, Parallel, Bifrost and Moonbeam may control more than their sovereign account shows.',
        }),
        el('li', {
          text: 'The original called these "netflows". Strictly they are balances over time — the term is kept because the study is published under it.',
        }),
        el('li', {
          text: `${network.token} only. A parachain's sovereign accounts also hold USDC, USDT and every bridged asset; that decomposition is on the /bridged/ page and the two must not be added together.`,
        }),
      ),
    ),

    el(
      'p',
      null,
      document.createTextNode('The same accounts, read live: '),
      el('a', { href: '/sovereign/', text: '/sovereign/' }),
      document.createTextNode('. Original study and source code: '),
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
    'When DOT moves to a parachain it is locked in that parachain’s sovereign account and minted on the other side. This is the only long look anyone took at those accounts: a 2023 Polkalytics study, redrawn here from its source CSVs as one line per chain on one shared scale. It is an archive — nothing on it has moved since 2023, and what the same accounts hold today is on /sovereign/.',
  controls: [
    choiceControl({
      label: 'Network',
      param: 'network',
      value: NETWORK,
      options: [
        { value: 'polkadot', label: 'Polkadot · DOT' },
        { value: 'kusama', label: 'Kusama · KSM' },
      ],
      hint: 'Two separate studies, not two halves of one: the KSM series starts seven months earlier, ends four weeks sooner, and tracks a different set of chains.',
    }),
  ],
  // The shape this page actually lands: the chart, the four tiles under it, then the ranking.
  // Naming the right shapes is what stops the page jumping at exactly the moment a reader is
  // looking at it.
  skeleton: ['chart', 'stats', 'rows'],
  loadingLabel: 'Reading the archived dataset',
  load,
  render,
})
