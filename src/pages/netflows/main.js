// Parachain netflows: a 2021–2023 archive, and the same accounts read today.
//
// The dataset is a 2023 Polkalytics study by Tommi Enenkel of the DOT and KSM held in parachain
// sovereign accounts. The original produced 25 MB of plotly HTML; the charts here are redrawn
// from the source CSVs into an 83 KB committed dataset, which is both far lighter and the only
// version that renders at all under this site's CSP (the plotly output relies on inline script).
//
// ── what changed, and why it is a second series rather than a replacement ────────────────────
// This used to be the one page here that read no live endpoint at all. It now reads
// `/api/asset-hub/sovereign-dot`, which derives both sovereign legs for every enumerated
// parachain and reads them in about five requests. The archive is not replaced by that — it is
// the only thing on this site with any history behind it, and history is the whole reason it
// exists. What the live read does is turn the archive from "the story" into "the first half of a
// comparison", which is a different and more useful page.
//
// ── the three things this page must be loud about, because all three fail silently ───────────
//
//  1. THE HOLE. The archive ends 2023-04-08. The live read is today. Between them are more than
//     three years in which nothing was observed. There is no line across that gap, no
//     interpolation, and the two halves never share an axis — they are drawn as two blocks with
//     the gap itself rendered between them, to scale, and with what happened inside it named. A
//     single continuous series here would invent three and a half years of data.
//
//  2. THEY ARE NOT THE SAME MEASUREMENT. The archive measured `System::Account` for the `para`
//     account ON THE RELAY CHAIN — which in 2023 was where a parachain's DOT actually sat. The
//     Asset Hub Migration (2025-11-04) moved that money to the `sibl` account on Asset Hub, and
//     today's figure is the SUM of both legs. Re-running the 2023 code today would draw a chart
//     of a few hundred DOT per parachain and be completely, plausibly wrong. So the comparison
//     is "the same question, asked of accounts that moved", and the page says so beside every
//     number rather than in a footnote.
//
//  3. CHAINS LEAVE. Three of the eight chains the Polkadot archive tracks have been deregistered
//     since it ended — Equilibrium 2025-07-08, Parallel 2025-12-20, Moonbeam 2026-08-10 — and so
//     has Moonriver on the Kusama side. Their sovereign accounts still hold a few hundred DOT,
//     so "today's balance" is a real number for them and a meaningless one to compare: it is
//     stranded, not held. Those rows get NO bar. Drawing one would put a dead chain on the same
//     axis as a live one, and drawing zero would say they gave the money back.
//
// Re-deriving the dataset from the raw CSVs also turned up three places where the written
// report and the data disagree. Those are rendered rather than quietly reconciled: the numbers
// in `reportDiscrepancies` come out of the same file the charts are drawn from.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { multiLine, segmentedLegend, segmentedRows, seriesColor } from '../../design/charts.js'
import { liveness } from '../../core/liveness.js'
import { livenessBanner, livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, formatUtc, percent, shortAddr } from '../../core/format.js'
import { RETIRED_CHAINS, resolveChain } from '../../core/topology.js'
import dataset from '../../data/netflows.json'

const NETWORK = new URLSearchParams(location.search).get('network') === 'kusama' ? 'kusama' : 'polkadot'

/** A chain whose daily line understates its true peak by more than this gets marked on the row. */
const CLIP_THRESHOLD = 0.03

/**
 * The only network `asset-hub.sovereign-dot` covers. It reads the Polkadot relay chain and
 * Polkadot Asset Hub; Kusama's sovereign accounts live on two different chains that this site
 * does not read yet, and inventing a Kusama half from the Polkadot one is not available. The
 * Kusama toggle therefore keeps the archive and says plainly that it has no live counterpart.
 */
const LIVE_NETWORK = 'polkadot'

/** How many chains the live ranking DRAWS. Every one of them is in the table beneath it. */
const LIVE_ROWS = 12

/**
 * The Asset Hub Migration, per network — the single most important thing inside the gap.
 *
 * Not read from a chain, because no storage item says "this happened here" — it is a fact this
 * repo established by bisection and wrote down. Two independent bisections, both in
 * `docs/concept/research/`, put Polkadot's at 2025-11-04: total issuance moves from the relay to
 * Asset Hub across relay #28,493,732→733, and Acala's own `para` sovereign account falls from
 * 3,137,094.16 DOT to 341.00 DOT across relay #28,493,861→862 at 12:38:00 UTC.
 *
 * The second bisection also found the thing that makes a single date slightly misleading, and
 * the page says it: the migration is progressive and per-account. At the block Acala moved,
 * Moonbeam's `para` account still held 1,465,523 DOT while Hydration, Bifrost, Astar and
 * Interlay were already down to 281–481 DOT, having moved their reserves to Asset Hub earlier
 * and independently.
 */
const MIGRATION = {
  polkadot: {
    on: '2025-11-04',
    label: 'The Asset Hub Migration',
    why:
      'Balances, staking and governance moved from the relay chain to Asset Hub. A parachain’s DOT reserve moved with them — from its `para` account on the relay to its `sibl` account on Asset Hub. Verified here by bisection: Acala’s relay sovereign account fell from 3,137,094.16 DOT to 341.00 DOT across relay blocks #28,493,861→862 at 12:38:00 UTC. It was not atomic across chains: at that same block Moonbeam still held 1,465,523 DOT on the relay, while Hydration, Bifrost, Astar and Interlay had already moved theirs and were down to 281–481 DOT.',
  },
  // Kusama's is recorded rather than re-derived, and the difference is stated on the page: the
  // Polkadot date above was bisected in this repo, this one was read out of a note. Marking both
  // and saying which is which beats marking only the one we happened to prove.
  kusama: {
    on: '2025-10-07',
    label: 'Kusama’s Asset Hub Migration',
    why:
      'The same account move, a month before Polkadot’s: a parachain’s KSM reserve left its `para` account on the Kusama relay for its `sibl` account on Kusama Asset Hub. This date is transcribed from docs/platform/asset-hub.md and was NOT re-derived here the way the Polkadot one was, and nothing on this page reads Kusama today to check it.',
  },
}

const DAY_MS = 86_400_000
const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`)
const amountOf = (token) => (value) => `${compact(value)} ${token}`
const mono = 'font-family:var(--font-mono);font-variant-numeric:tabular-nums'

/**
 * The registry's `why` strings are written to be printed verbatim and not all of them end in a
 * full stop. They are concatenated with our own sentences here, so terminate them rather than
 * editing the registry — a caveat that runs into the next sentence stops being read as a caveat.
 */
const sentence = (text) => {
  const trimmed = String(text ?? '').trim()
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * The liveness assertion for an archive.
 *
 * Every other page on this site asserts liveness about an upstream it just read. This half of
 * this one has no upstream — the dataset is compiled into the bundle — and the assertion is
 * *more* useful here, not less, because this is the page where a reader is most likely to
 * mistake old numbers for current ones. Stating the age in the same vocabulary the live pages
 * use ("frozen", a lag in days, the window covered) is what makes the two comparable at a
 * glance, and on this page the live report now sits in the same list, three lines below it.
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

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

/**
 * Two halves, and only one of them can fail.
 *
 * The archive is bundled, so it is either there or the build is broken. The live read is
 * somebody else's public RPC and can be down at any moment. Letting a failed live read take the
 * archive down with it would turn a partial page into a blank one, so the error is caught,
 * carried into `render`, and shown as a notice where the live block would have been. That is
 * the difference between "half of this page is unavailable right now" and "this page is broken".
 */
async function load({ progress }) {
  const network = dataset.networks[NETWORK]
  if (!network) throw Object.assign(new Error(`The archived dataset has no \`${NETWORK}\` network.`), { kind: 'decode' })

  const total = NETWORK === LIVE_NETWORK ? 2 : 1
  progress({ stage: `Reading the archived ${network.token} dataset`, done: 1, total })
  const archive = archiveLiveness(network)

  if (NETWORK !== LIVE_NETWORK) return { network, archive, live: null, liveError: null }

  progress({
    stage: 'Reading sovereign DOT from Asset Hub and the relay chain',
    note: 'Both legs, at one pinned block each — a chain’s sovereign DOT is the sum of the two.',
    done: 1,
    total,
  })
  try {
    const live = await read('asset-hub', 'sovereign-dot')
    progress({ done: 2, total })
    return { network, archive, live, liveError: null }
  } catch (error) {
    console.error(error)
    return { network, archive, live: null, liveError: error }
  }
}

/* ═══════════════════════════════════════════════════════════════════════ the then/now join ═════ */

/**
 * Join each archived chain to its row in today's payload — and then check the join.
 *
 * The join key is the para id, resolved through `topology.js` so that the archive's `HydraDX`
 * and today's `Hydration` are recognised as one chain rather than two. But a registry is a
 * transcription and could be wrong, and a wrong para id derives a valid-looking sovereign
 * address that holds nothing — which would render as "this chain gave all its DOT back".
 *
 * So the address is the evidence: the 2023 dataset carries the exact relay account it observed,
 * and the live payload carries the relay account derived from the registry's para id today. If
 * those two strings are equal, the two series are about the same account and the comparison is
 * real. `addressAgrees` records the answer per row and the data notes report it, rather than the
 * check being made once by somebody and then trusted forever.
 */
function joinThenNow(network, live) {
  const byParaId = new Map((live?.chains ?? []).map((row) => [row.paraId, row]))

  return network.chains
    .map((chain) => {
      const entry = resolveChain(chain.name, NETWORK)
      const now = entry?.paraId == null ? null : byParaId.get(entry.paraId) ?? null
      return {
        archiveName: chain.name,
        name: entry?.name ?? chain.name,
        paraId: entry?.paraId ?? null,
        address: chain.address,
        then: chain.last,
        thenPeak: chain.peak,
        retired: entry?.retired ?? null,
        now,
        // `null` — not `false` — when there is no live row to check against. "We did not check"
        // and "we checked and it disagreed" are different admissions.
        addressAgrees: now ? now.relayAddress === chain.address : null,
      }
    })
    .sort((a, b) => b.then - a.then)
}

/** `×41.8` for growth, `−98.6%` for shrinkage. Each direction in the form that reads. */
function changeLabel(then, now) {
  if (!(then > 0) || now === null || now === undefined) return null
  const ratio = now / then
  // A multiple past half again as much, a percentage below it. "+100%" for a doubling is
  // technically right and reads as smaller than "×2.0", which is the wrong impression to leave.
  if (ratio >= 1.5) return `×${ratio.toFixed(1)}`
  if (ratio > 1) return `+${percent((ratio - 1) * 100, 0)}`
  return `−${percent((1 - ratio) * 100, 1)}`
}

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

function render(host, { network, archive, live, liveError }) {
  clear(host)
  const { token } = network
  const amount = amountOf(token)

  const totalPeak = network.chains.reduce((sum, chain) => sum + chain.peak, 0)
  const totalLast = network.chains.reduce((sum, chain) => sum + chain.last, 0)
  const clipped = network.chains.filter((chain) => chain.clipped > CLIP_THRESHOLD)
  const rows = joinThenNow(network, live)
  const retired = rows.filter((row) => row.retired)

  append(
    host,
    // Nothing at all when both upstreams are live — see the note in design/liveness.js. The
    // archive's own report is deliberately NOT passed here: it is permanently `frozen` by
    // design, and a red box on every single visit is how a reader learns to skip red boxes.
    livenessBanner(live?.meta?.liveness),

    notice(
      'warning',
      'Two measurements, three years apart, and they are not the same measurement',
      `The lower half of this page is an archive that stopped on ${network.last}.` +
        (live
          ? ' The upper half was read from the chains a moment ago. Nothing was observed in between, so nothing is drawn in between.'
          : ' It has no live counterpart here.'),
      'The archive measured a parachain’s `para` account on the relay chain, which in 2023 was where its DOT sat. The Asset Hub Migration moved that money to the `sibl` account on Asset Hub, and today’s figure is both legs added together. Same question, different accounts — a reader comparing 2023 to today straight across is comparing two different things.',
    ),

    ...(NETWORK === LIVE_NETWORK ? liveBlock({ live, liveError }) : [kusamaBlock(retired)]),

    gapCard(network, live),

    live ? thenNowCard(rows, network, live) : null,

    el('h2', {
      text: `The archive: ${token} in parachain sovereign accounts, ${network.first} to ${network.last}`,
      style: 'margin-top:var(--s7);padding-top:var(--s5);border-top:var(--border)',
    }),
    el('p.note', {
      text: `Everything below this line stopped moving on ${network.last}. It is a re-rendering of a study published in 2023, kept because the shape of the era is still worth looking at — not because these are anyone’s current holdings.`,
    }),

    statRow([
      statTile('Chains tracked', String(network.chains.length), `sovereign accounts above the study's floor`, { hero: true }),
      statTile('Largest holding', amount(network.chains[0].peak), `${network.chains[0].name}, at its peak`),
      statTile('Sum of peaks', amount(totalPeak), 'not simultaneous — each chain at its own high'),
      statTile('Held at the end', amount(totalLast), `across all ${network.chains.length}, on ${network.last}`),
    ]),

    chartCard(network, token),
    rankCard(network, amount, clipped, rows),
    clipped.length ? clipNotice(clipped, token) : null,
    discrepanciesCard(),
    notes({ network, archive, live, liveError, rows }),
  )
}

/* ══════════════════════════════════════════════════════════════════════════════════ now ═════ */

/**
 * The live half: what these accounts hold at this minute.
 *
 * Returned as an array so the caller can splice it in or swap it for the Kusama explanation
 * without either branch having to know what the other renders.
 */
function liveBlock({ live, liveError }) {
  if (!live) {
    return [
      notice(
        liveError?.kind === 'transport' ? 'warning' : 'critical',
        'Today’s figure could not be read',
        liveError?.message ?? 'The live read failed.',
        liveError?.advice ?? 'Something failed on the way to Asset Hub and the relay chain.',
        'The archive below is bundled into this page and is unaffected by that — it is simply the only half of the comparison available right now. Nothing above has been filled in with a guess, and the “then and now” panel is absent rather than half-drawn.',
      ),
    ]
  }

  const { totals, issuance, missing, chains } = live
  const held = chains.filter((row) => row.total > 0)
  const topThree = held.slice(0, 3).reduce((sum, row) => sum + row.total, 0)

  return [
    el('h2', { text: 'Today' }),
    statRow([
      statTile('Sovereign DOT, now', `${compact(totals.total)} DOT`, `across ${held.length} chains that hold any`, { hero: true }),
      statTile('On Asset Hub (`sibl`)', `${compact(totals.assetHubTotal)} DOT`, `${percent((totals.assetHubTotal / totals.total) * 100, 1)} of it, since the ${MIGRATION[LIVE_NETWORK].on} migration`),
      statTile('On the relay (`para`)', `${compact(totals.relayTotal)} DOT`, `${percent((totals.relayTotal / totals.total) * 100, 1)} — the leg the archive measured`),
      statTile('Concentration', percent((topThree / totals.total) * 100, 1), `held by the top three: ${held.slice(0, 3).map((row) => row.name ?? `para ${row.paraId}`).join(', ')}`),
    ]),
    liveRankCard(live),
    missing?.length ? missingCard(missing) : null,
  ]
}

/**
 * Today's ranking, each bar split into the two legs it is the sum of.
 *
 * The split is the point rather than decoration: it is what makes "the archive measured only the
 * relay leg" a visible fact instead of a sentence — the `para` segment is a hairline on almost
 * every row, and that hairline is the entire 2023 chart.
 */
function liveRankCard(live) {
  const held = live.chains.filter((row) => row.total > 0)
  const drawn = held.slice(0, LIVE_ROWS)
  const series = [{ label: 'on Asset Hub · `sibl`' }, { label: 'on the relay · `para`' }]
  const segmentsOf = (row) => [row.assetHubFree + row.assetHubReserved, row.relayFree + row.relayReserved]

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `Sovereign DOT today, by chain` }),
      el('p.note', {
        text: `One shared linear scale across all ${LIVE_ROWS} drawn rows, so the bars are comparable — which is also why most of them are nearly invisible: three chains hold the overwhelming majority. Every one of the ${held.length} chains holding anything is in the table below, and ${live.chains.length - held.length} more were enumerated and hold nothing at all.`,
      }),
    ),
    segmentedLegend(series, [live.totals.assetHubTotal, live.totals.relayTotal], (v) => `${compact(v)} DOT`),
  )

  const plot = el('div')
  append(card, plot)
  const tally = segmentedRows(plot, {
    rows: drawn.map((row) => ({
      label: row.name ?? `para ${row.paraId}`,
      // A chain this site cannot name renders as its own para id and says so, rather than as
      // "unknown" — `para 3344` is a fact a reader can act on and "unknown" is not.
      sublabel: row.name ? `para ${row.paraId}` : 'unnamed here',
      total: row.total,
      segments: segmentsOf(row),
      note: `relay ${row.relayAddress}\nAsset Hub ${row.assetHubAddress}`,
    })),
    series,
    format: (v) => `${compact(v)} DOT`,
    residualLabel: 'not attributed to either leg',
  })

  append(
    card,
    tally.faint
      ? el('p.note', {
          text: `${tally.faint} of the ${drawn.length} drawn rows are under 2% of the largest and are shown at the minimum width that stays visible. Read the figure at the end of the row, not the length of the bar — the bar is there to show you the concentration, and the concentration is the finding.`,
        })
      : null,
    liveTable(held),
  )
  return card
}

function liveTable(held) {
  const body = el('tbody')
  for (const row of held) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: row.name ?? `para ${row.paraId}` }),
        el('td.num', { text: String(row.paraId) }),
        el('td.num', { text: compact(row.total) }),
        el('td.num', { text: compact(row.assetHubFree + row.assetHubReserved) }),
        el('td.num', { text: compact(row.relayFree + row.relayReserved) }),
        el('td', { text: row.lifecycle ?? '—' }),
        el('td.mono', { text: shortAddr(row.assetHubAddress, 8, 6) }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `All ${held.length} chains holding sovereign DOT today` }),
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
            el('th.num', { text: 'Para' }),
            el('th.num', { text: 'Total DOT' }),
            el('th.num', { text: 'On Asset Hub' }),
            el('th.num', { text: 'On the relay' }),
            el('th', { text: 'Lifecycle' }),
            el('th', { text: 'Asset Hub account' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/**
 * The chains the relay's own enumeration does not name.
 *
 * The payload hands these over with a per-row `why`, and rendering them is the whole of rule 3
 * in one card: every one of them holds real DOT, and a page built from `Paras::ParaLifecycles`
 * alone would have shown them as absent — which a reader would read as "holds nothing".
 */
function missingCard(missing) {
  const list = el('div.rows')
  for (const row of missing) {
    // The payload knows a chain is absent from the relay's enumeration; this site's registry
    // knows the DATE it left. Neither one alone is the whole sentence, so the row carries both.
    const retired = resolveChain(row.paraId, LIVE_NETWORK)?.retired ?? null
    append(
      list,
      el(
        'div.row',
        {
          title: `${sentence(row.why)}${retired ? `\n\n${sentence(retired.why)}` : ''}`,
          // Two columns rather than `.row`'s three. The middle column would be a track here and
          // there is nothing to draw in it — and at 390px the enumeration text is a long
          // unbreakable word that overran the amount and printed on top of it.
          style: 'grid-template-columns:minmax(0,1fr) auto',
        },
        el(
          'div',
          { style: 'display:grid;gap:var(--s1);min-width:0' },
          // `.name` clips its overflow and never wraps, which is right for one long chain name
          // and wrong for a name plus a pill: at 390px the pill would simply vanish, and
          // vanishing is the one thing a "this chain has left" marker must never do.
          el(
            'div.name',
            { style: 'overflow:visible;white-space:normal;display:flex;flex-wrap:wrap;gap:var(--s2);align-items:baseline' },
            el('span', { text: row.name ?? `para ${row.paraId}` }),
            retired ? el('span.pill', { data: { tone: 'warning' }, text: `left ${retired.on}` }) : null,
          ),
          el('div', {
            text: `found via ${row.enumeratedBy.join(' + ')}`,
            style: 'color:var(--ink-muted);font-size:var(--step--1);overflow-wrap:anywhere',
          }),
        ),
        el('div.amt', { text: `${compact(row.total)} DOT` }),
      ),
    )
  }
  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${missing.length} chains hold DOT that the relay chain no longer lists` }),
      el('p.note', { text: `Every one of them is ${sentence(missing[0]?.why ?? 'absent from the relay’s own enumeration')}` }),
    ),
    list,
    el('p.note', {
      text: 'These are found because the payload enumerates parachains from four independent sources rather than one — the two relay storage items, the para ids named by Asset Hub’s own `ForeignAssets` keys, and this site’s registry. Absent from an enumeration and holding nothing are different facts.',
    }),
  )
}

/** Kusama has no live half here, and saying which chains it would need is more use than "no data". */
function kusamaBlock(retired) {
  return notice(
    'info',
    'There is no live half for Kusama on this page',
    'The live read is `asset-hub.sovereign-dot`, and it reads the Polkadot relay chain and Polkadot Asset Hub. Kusama’s sovereign accounts sit on the Kusama relay and Kusama Asset Hub — two chains this site does not read yet — so the KSM view below is the archive alone.',
    retired.length
      ? `What is known about the years since: ${retired
          .map((row) => `${row.name} left Kusama on ${row.retired.on}`)
          .join(', ')}. That comes from this site’s own registry rather than from a read of the chain today, and it is marked on the ranking below.`
      : 'Kusama’s own Asset Hub migration completed on 2025-10-07, a month before Polkadot’s, so the same account move applies there and the same caveat would too.',
  )
}

/* ══════════════════════════════════════════════════════════════════════════════ the gap ═════ */

/**
 * The three and a half years nobody measured, drawn to scale.
 *
 * The temptation on a page like this is a single chart with a dotted line across the middle, and
 * it is exactly wrong: a dotted line is still a line, and a reader takes it as "roughly this".
 * What is actually known is a shape — a short observed window, then a long silence, then one
 * instant — and drawing that shape honestly means drawing the silence at its true width. It is
 * three quarters of the elapsed time, and it dwarfs the archive it follows.
 *
 * The markers inside it are the events this repo can date. They are ticks rather than labels,
 * because four labels inside one strip collide at 390px; the numbered list beneath carries the
 * sentence.
 */
function gapCard(network, live) {
  const from = dayOf(network.first)
  const to = dayOf(network.last)
  const now = live?.fetchedAt ? Date.parse(live.fetchedAt) : Date.now()
  const span = Math.max(now - from, 1)
  const gap = Math.max(now - to, 1)
  const archivePct = ((to - from) / span) * 100

  /** What "we did not measure this" looks like here — an absence, deliberately not a hue. */
  const hatch =
    'repeating-linear-gradient(45deg,var(--surface-sunken),var(--surface-sunken) 3px,var(--rule-strong) 3px,var(--rule-strong) 5px)'

  const events = [
    ...(MIGRATION[NETWORK] ? [MIGRATION[NETWORK]] : []),
    // Every departure this registry knows about on this network, not only the ones the archive
    // happened to track. The gap card answers "what happened in these years", and a chain that
    // left without ever appearing in the 2023 study still happened.
    ...RETIRED_CHAINS.filter((entry) => entry.network === NETWORK).map((entry) => ({
      on: entry.retired.on,
      label: `${entry.name} left ${NETWORK === 'kusama' ? 'Kusama' : 'Polkadot'}`,
      why: entry.retired.why,
    })),
  ]
    .filter((event) => dayOf(event.on) > to && dayOf(event.on) <= now)
    .sort((a, b) => a.on.localeCompare(b.on))

  const ticks = events.map((event, i) =>
    el(
      'div',
      {
        title: `${event.on} · ${event.label}`,
        style: `position:absolute;top:0;bottom:0;left:${((dayOf(event.on) - to) / gap) * 100}%;width:2px;background:var(--ink-muted)`,
      },
      el('span', {
        text: String(i + 1),
        style: `position:absolute;top:-1.15rem;left:-0.3rem;${mono};font-size:var(--step--1);color:var(--ink-muted)`,
      }),
    ),
  )

  // No `overflow:hidden` on this strip, deliberately: the tick numerals sit above it and were
  // being clipped away by it, which left four unexplained hairlines and a numbered list that
  // referred to nothing.
  const strip = el(
    'div',
    { style: 'display:flex;align-items:stretch;height:1.5rem;margin:1.4rem 0 var(--s2)' },
    el('div', {
      title: `${network.first} → ${network.last}: ${formatCount(network.days.length)} daily observations`,
      style: `width:${archivePct}%;background:${seriesColor(0)}`,
    }),
    el(
      'div',
      {
        title: `${network.last} → today: ${formatCount(Math.round(gap / DAY_MS))} days, nothing observed`,
        style: `flex:1;position:relative;background:${hatch}`,
      },
      ...ticks,
    ),
  )

  // A legend rather than an axis. An axis whose labels are pinned to the block boundaries reads
  // beautifully at 1,100px and collapses at 390, where the archive block is 90px wide and two
  // ten-character dates ran into each other and read as one string. The strip already carries
  // the proportion; the legend carries the dates, and it wraps.
  const scale = el(
    'ul.legend',
    null,
    el(
      'li',
      // Wrapping inside the item, not just between items: `nowrap` on the range keeps a date
      // from breaking in the middle — which stops it reading as a date — but without this the
      // day count then ran off the right edge at 360px instead of dropping to a second line.
      { style: 'flex-wrap:wrap' },
      el('span.swatch', { style: `background:${seriesColor(0)}` }),
      el('span', { text: `observed · ${network.first} → ${network.last}`, style: 'white-space:nowrap' }),
      el('span.amt', { text: `${formatCount(network.days.length)} days` }),
    ),
    el(
      'li',
      { style: 'flex-wrap:wrap' },
      el('span.swatch', { style: `background:${hatch}` }),
      el('span', { text: `not observed · ${network.last} → today`, style: 'white-space:nowrap' }),
      el('span.amt', { text: `${formatCount(Math.round(gap / DAY_MS))} days` }),
    ),
  )

  const list = el('ol', { style: 'margin:var(--s4) 0 0;padding-inline-start:var(--s5)' })
  for (const event of events) {
    append(
      list,
      el(
        'li',
        { style: 'margin-bottom:var(--s2)' },
        el('strong', { text: `${event.on} — ${event.label}. ` }),
        document.createTextNode(sentence(event.why)),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${formatCount(Math.round(gap / DAY_MS))} days with no observations` }),
      el('p.note', {
        text: `Drawn to scale: the solid block is the ${formatCount(network.days.length)} days the archive covers, the hatched block is everything since. There is no line across it and no interpolation, because nothing was measured — this site keeps no balance history of its own yet, and the numbers that would fill this gap are not stored anywhere it can read.`,
      }),
    ),
    strip,
    scale,
    events.length ? el('p.note', { text: 'What this repo can date inside the gap, marked on the strip above:' }) : null,
    events.length ? list : null,
  )
}

/* ═════════════════════════════════════════════════════════════════════════ then and now ═════ */

/**
 * The comparison, one chain at a time, two bars each on a shared linear scale.
 *
 * Two bars and not a line: a line between two points three years apart asserts the path between
 * them, and there is no path — there are two readings. Stacking them per chain also keeps the
 * pair adjacent, which is the comparison a reader actually wants, while the shared scale keeps
 * the cross-chain comparison available.
 *
 * A retired chain gets NO second bar. Its account still holds a few hundred DOT and that number
 * is real, but it is stranded rather than held, and putting it on the same axis as a live chain
 * would invite exactly the reading the row exists to prevent.
 */
function thenNowCard(rows, network, live) {
  const max = Math.max(...rows.map((row) => Math.max(row.then, row.retired ? 0 : row.now?.total ?? 0)), 1)
  // The same floor the ranking below uses. A bar that rounds to zero width reads as "no data",
  // and 9,307 DOT is not no data — it is a 98.6% fall, which is the most interesting row here.
  const width = (value) => `${Math.max(0.4, (value / max) * 100)}%`

  const bar = (label, value, color, title) =>
    el(
      'div',
      { title, style: 'display:grid;grid-template-columns:2.6rem minmax(0,1fr) auto;gap:var(--s2);align-items:center;font-size:var(--step--1)' },
      el('span', { text: label, style: 'color:var(--ink-muted)' }),
      el('div.track', null, el('div.fill', { style: `width:${width(value)};background:${color}` })),
      el('span', { text: `${compact(value)} DOT`, style: mono }),
    )

  const list = el('div', { style: 'display:grid;gap:var(--s4)' })
  for (const row of rows) {
    const now = row.now
    const change = row.retired || !now ? null : changeLabel(row.then, now.total)

    append(
      list,
      el(
        'div',
        { style: 'display:grid;gap:var(--s1);padding-top:var(--s3);border-top:var(--border)' },
        el(
          'div',
          { style: 'display:flex;gap:var(--s2);align-items:baseline;flex-wrap:wrap' },
          el('span', { text: row.name, style: mono }),
          el('span', {
            text: row.archiveName === row.name ? `para ${row.paraId}` : `para ${row.paraId} · “${row.archiveName}” in 2023`,
            style: 'color:var(--ink-muted);font-size:var(--step--1)',
          }),
          el('span', { style: 'flex:1' }),
          row.retired ? el('span.pill', { data: { tone: 'warning' }, text: 'LEFT' }) : null,
          change ? el('span', { text: change, style: `${mono};color:var(--ink)` }) : null,
        ),
        bar('then', row.then, seriesColor(0), `${row.name} held ${compact(row.then)} DOT in its \`para\` account on the relay chain at the close of ${network.last}.`),
        row.retired
          ? el(
              'div',
              {
                style:
                  'border-inline-start:2px solid var(--warning);padding-inline-start:var(--s3);font-size:var(--step--1);color:var(--ink-secondary)',
              },
              el('strong', { text: `No bar: ${row.name} left the network on ${row.retired.on}. ` }),
              document.createTextNode(
                now
                  ? `${sentence(row.retired.why)} Its sovereign accounts still hold ${compact(now.total)} DOT — ${compact(now.assetHubFree + now.assetHubReserved)} on Asset Hub and ${compact(now.relayFree + now.relayReserved)} on the relay — but that is stranded, not held, and it is not comparable with a chain that is still running.`
                  : sentence(row.retired.why),
              ),
            )
          : now
            ? bar(
                'now',
                now.total,
                seriesColor(1),
                `${row.name} holds ${compact(now.total)} DOT today: ${compact(now.assetHubFree + now.assetHubReserved)} in its \`sibl\` account on Asset Hub and ${compact(now.relayFree + now.relayReserved)} in its \`para\` account on the relay.`,
              )
            : el('p.note', {
                text: `No row for this chain in today’s payload, which enumerates from four independent sources. That is a gap in the join, not a balance of zero, and it is counted in the data notes.`,
              }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Then and now, for the eight chains the archive tracked' }),
      el('p.note', {
        text: `“Then” is the balance at the close of ${network.last}, in the \`para\` account on the relay chain — the only leg that existed to measure. “Now” is that chain’s two legs added together, read at relay #${formatCount(live.relay.block)} and Asset Hub #${formatCount(live.assetHub.block)}. One shared linear scale across both, so the bars are comparable to each other; the three-year gap between the two readings is drawn above, and nothing is drawn across it.`,
      }),
    ),
    el(
      'ul.legend',
      null,
      el('li', null, el('span.swatch', { style: `background:${seriesColor(0)}` }), document.createTextNode(`at the close of ${network.last}`)),
      el('li', null, el('span.swatch', { style: `background:${seriesColor(1)}` }), document.createTextNode('today, both legs summed')),
    ),
    list,
    thenNowTable(rows, network),
  )
}

function thenNowTable(rows, network) {
  const body = el('tbody')
  for (const row of rows) {
    const now = row.now
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: row.name }),
        el('td.num', { text: row.paraId == null ? '—' : String(row.paraId) }),
        el('td.num', { text: compact(row.then) }),
        el('td.num', { text: now ? compact(now.assetHubFree + now.assetHubReserved) : '—' }),
        el('td.num', { text: now ? compact(now.relayFree + now.relayReserved) : '—' }),
        el('td.num', { text: now ? compact(now.total) : '—' }),
        el('td', { text: row.retired ? `left ${row.retired.on}` : changeLabel(row.then, now?.total) ?? '—' }),
        el('td', { text: row.addressAgrees === null ? 'not checked' : row.addressAgrees ? 'same account' : '⚠ DIFFERENT ACCOUNT' }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: 'Both readings, side by side, and the account-identity check' }),
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
            el('th.num', { text: 'Para' }),
            el('th.num', { text: `Then (${network.last})` }),
            el('th.num', { text: 'Now · Asset Hub' }),
            el('th.num', { text: 'Now · relay' }),
            el('th.num', { text: 'Now · total' }),
            el('th', { text: 'Change' }),
            el('th', { text: '2023 address vs derived today' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ══════════════════════════════════════════════════════════════════════════ the archive ═════ */

function chartCard(network, token) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held in parachain sovereign accounts, 2021–2023` }),
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

function rankCard(network, amount, clipped, rows) {
  const max = network.chains[0].peak
  // Keyed by the archive's own spelling, because that is what the rows below carry.
  const retiredByName = new Map(rows.filter((row) => row.retired).map((row) => [row.archiveName, row.retired]))
  const list = el('div.rows')

  network.chains.forEach((chain, i) => {
    const isClipped = chain.clipped > CLIP_THRESHOLD
    const retired = retiredByName.get(chain.name) ?? null
    append(
      list,
      el(
        'div.row.rank-row',
        { title: retired ? `${chain.address}\n\n${retired.why}` : chain.address },
        el('div.rank', { text: String(i + 1) }),
        el(
          'div.name',
          // Wrapping rather than clipping, so the marker survives a narrow viewport — see the
          // same note on the `missing` rows above.
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
      el('h2', { text: 'Ranked by peak holding, in the archive' }),
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

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const wrapAnywhere = (node) => (node ? style(node, 'overflow-wrap:anywhere') : node)

function notes({ network, archive, live, liveError, rows }) {
  const { caveats, rows: sourceRows } = dataset.source
  const joined = rows.filter((row) => row.now)
  const checked = joined.filter((row) => row.addressAgrees === true)
  const disagreed = joined.filter((row) => row.addressAgrees === false)
  const unjoined = rows.filter((row) => !row.now)

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    // Both halves in one list, worst first. The archive is permanently `frozen` and the live
    // read is normally `live`; putting them in the same list in the same vocabulary is what
    // lets a reader see at a glance which half of this page is which.
    livenessNotes([archive, ...(live?.meta?.liveness ?? [])]),

    el('h3', { text: 'Comparing the two halves' }),
    wrapAnywhere(
      el(
        'ul',
        null,
        el('li', {
          text: `The archive measured \`System::Account\` for each chain's \`para\` account ON THE RELAY CHAIN. Today's figure is that account PLUS the chain's \`sibl\` account on Asset Hub, because the ${MIGRATION[LIVE_NETWORK].on} migration moved the money to the second one. Re-running the 2023 method against the relay today would return a few hundred DOT per parachain and look entirely reasonable.`,
        }),
        el('li', {
          text: `Nothing was observed between ${network.last} and today. The two readings are drawn as two blocks with the elapsed time between them shown to scale; no series crosses the gap, no value is interpolated into it, and a missing value here breaks the comparison rather than drawing to zero.`,
        }),
        live
          ? el('li', {
              text:
                `The join between the two halves is by para id, resolved through this site's registry — which is how the archive's “HydraDX” and today's “Hydration” are recognised as one chain. The check on that join is the address: ` +
                `for ${checked.length} of the ${rows.length} archived chains the sovereign account recorded in the 2023 CSVs is byte-for-byte the account derived from the registry's para id today` +
                `${disagreed.length ? `, and for ${disagreed.length} it is NOT — those rows are marked in the table and must not be read as a comparison` : ', so every comparison above is about the same account'}` +
                `${unjoined.length ? `. ${unjoined.length} archived chain(s) have no row in today's payload at all, which is a gap in the join rather than a balance of zero` : ''}.`,
            })
          : null,
        el('li', {
          text: `${rows.filter((row) => row.retired).length} of the ${rows.length} archived chains have since left the network: ${
            rows
              .filter((row) => row.retired)
              .map((row) => `${row.name} on ${row.retired.on}`)
              .join(', ') || 'none'
          }. They are drawn with no “now” bar. Their sovereign accounts are not empty — a deregistered chain's DOT stays where it was — but a balance nobody can move is not comparable with one that is still in use, and drawing it as either a bar or a zero would say something untrue.`,
        }),
        el('li', {
          text: 'A chain being absent from this site’s `retired` list is weaker than a claim that it is running. That list came from one audit of the relays’ registration storage on 2026-08-20 and nothing re-runs it, so it is a fact with a date on it rather than a live status.',
        }),
      ),
    ),

    live
      ? el(
          'div',
          null,
          el('h3', { text: 'Today’s reading' }),
          wrapAnywhere(el('ul', null, ...(live.notes ?? []).map((note) => el('li', { text: note })))),
          el('p', {
            text: `Read at relay block ${formatCount(live.relay.block)} and Asset Hub block ${formatCount(live.assetHub.block)}, fetched ${formatUtc(Date.parse(live.fetchedAt))}. Those are two different chains at two different heights: a transfer landing between the two reads would appear in one leg and not the other, which is why each holding row in the payload carries its own block height rather than one shared one.`,
          }),
        )
      : liveError
        ? el('p', { text: `Today’s reading is missing: ${liveError.message} ${liveError.advice ?? ''}` })
        : null,

    el('h3', { text: 'The archive' }),
    el('p', {
      text: `Derived from ${compact(sourceRows[NETWORK])} balance observations of ${network.chains.length} sovereign accounts, covering ${network.first} to ${network.last}. Balances are read at ${network.decimals} decimals.`,
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
        text: 'The original called these "netflows". Strictly they are balances over time — the term is kept because the study is published under it. The live half above is a single point, not a flow at all: this site keeps no balance history of its own yet, so there is nothing to draw between today and yesterday either.',
      }),
      el('li', {
        text: 'DOT only, on both halves. A parachain’s sovereign accounts also hold USDC, USDT and every bridged asset; that decomposition is on the /bridged/ page and the two must not be added together.',
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
    'When DOT moves to a parachain it does not leave Polkadot — it is locked in that parachain’s sovereign account and minted on the other side. Watching those accounts is the closest thing to watching capital move across the network. This page holds two readings of them: an archived study running from the first parachain to April 2023, and the same accounts read live a moment ago. Between the two is a three-year hole and one migration that moved the money to a different chain, so they are shown as a comparison with its caveats attached, never as one continuous line.',
  controls: [
    choiceControl({
      label: 'Network',
      param: 'network',
      value: NETWORK,
      options: [
        { value: 'polkadot', label: 'Polkadot · DOT' },
        { value: 'kusama', label: 'Kusama · KSM' },
      ],
      hint: 'The live half is Polkadot only — Kusama’s sovereign accounts are on chains this site does not read yet.',
    }),
  ],
  // The skeleton is the layout this page actually lands: the live tiles and ranking, the gap,
  // the comparison, then the archive. Naming the right shapes is what stops the page jumping at
  // exactly the moment a reader is looking at it.
  skeleton: ['stats', 'rows', 'chart', 'stats', 'chart', 'rows'],
  loadingLabel: 'Reading the archived dataset, then today’s sovereign balances',
  load,
  render,
})
