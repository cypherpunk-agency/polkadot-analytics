// Parachain sovereign holdings: what these accounts hold right now.
//
// One subject, named by the title: the DOT sitting in parachain sovereign accounts at this
// minute. It comes from `/api/asset-hub/sovereign-dot`, which derives both sovereign legs for
// every enumerated parachain and reads them in about five requests.
//
// ── what used to be here, and why it is gone ─────────────────────────────────────────────────
//
// This page carried a "then and now" card comparing today against the close of 2023-04-08, and
// above it a strip drawing the years since that date as time nobody measured. Both were built
// when the archived 2023 Polkalytics study was the only history of these accounts that existed.
// Three things retired the comparison, and the third would have been enough on its own:
//
//   1. THE DATE IS ARBITRARY. Nothing happened on 2023-04-08 except that a third-party study
//      stopped collecting data.
//   2. IT COVERED 8 CHAINS OF THE 52 THIS PAGE LISTS — the eight that study happened to track.
//   3. IT IS THAT ARCHIVE'S SINGLE WORST DAY. Its captures stop mid-day, so its final row is a
//      mid-day reading published as a close: on 2023-04-08 all eight chains disagree with a
//      fresh read of the chain by up to 23.6%, where on every other day the archive and the
//      chain agree to a median 4.0 × 10⁻⁹. The card set live data against the one day of the
//      archive that is known to be unreliable, and labelled it "then".
//
// The gap strip went for a different reason: the gap no longer exists. `/netflows/` now carries
// the same measurement for every UTC day from 2022-01-01 to yesterday, re-derived from the
// chains themselves (decision 0012). Drawing "N days with no observations" today would assert
// something false. So history is a link and not a rebuild — one notice beneath the holdings,
// pointing at the page that has all of it.
//
// ── the three things this page must be loud about, because all three fail silently ───────────
//
//  1. TWO ACCOUNTS, ON TWO CHAINS, AT TWO HEIGHTS. A chain's sovereign DOT is its `para` account
//     on the relay chain PLUS its `sibl` account on Asset Hub. The Asset Hub Migration moved
//     almost all of it to the second one, but the relay leg is not zero and dropping it is a
//     real undercount — and the two legs are read at different blocks on different chains, so a
//     transfer landing between the two reads appears in one and not the other. Every row carries
//     its own heights rather than one shared one, and the ranking draws the split rather than
//     stating it.
//
//  2. CHAINS LEAVE, AND THEIR DOT STAYS. Several chains in the ranking are deregistered —
//     Equilibrium 2025-07-08, Parallel 2025-12-20, Moonbeam 2026-08-10. Their sovereign accounts
//     still hold real DOT, drawn here at its real size, but it is stranded rather than held. The
//     rows say so; showing it as zero would say the money went back.
//
//  3. THE RELAY'S OWN ENUMERATION IS NOT COMPLETE. Chains hold sovereign DOT while appearing in
//     neither `Paras::ParaLifecycles` nor `Registrar::Paras`. The payload enumerates from four
//     independent sources for that reason, and the chains only the other three found get their
//     own card — a page built from one enumeration would have shown them as absent, which reads
//     as "holds nothing".
//
// Polkadot only, and there is no network toggle: `asset-hub.sovereign-dot` reads the Polkadot
// relay chain and Polkadot Asset Hub. Kusama's sovereign accounts sit on two chains this site
// does not read yet, so a Kusama toggle here would be a control that leads nowhere. The KSM
// archive still exists — it is on `/netflows/?network=kusama` — and the scope notice near the
// bottom of this page says exactly that rather than leaving the absence to be inferred.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { segmentedLegend, segmentedRows } from '../../design/charts.js'
import { livenessBanner, livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, formatUtc, percent, shortAddr } from '../../core/format.js'
import { RETIRED_CHAINS, resolveChain } from '../../core/topology.js'

/** The only network this page's upstream reads. See the header note. */
const NETWORK = 'polkadot'

/** How many chains the ranking DRAWS. Every one of them is in the table beneath it. */
const LIVE_ROWS = 12

/**
 * The Asset Hub Migration — why a chain's DOT is in a different account than it used to be.
 *
 * Not read from a chain, because no storage item says "this happened here" — it is a fact this
 * repo established by bisection and wrote down. Two independent bisections, both in
 * `docs/concept/research/`, put Polkadot's at this date: total issuance moves from the relay to
 * Asset Hub across relay #28,493,732→733, and Acala's own `para` sovereign account falls from
 * 3,137,094.16 DOT to 341.00 DOT across relay #28,493,861→862 at 12:38:00 UTC.
 *
 * The second bisection also found the thing that would make a single date misleading on a page
 * that drew the migration itself: it is progressive and per-account. At the block Acala moved,
 * Moonbeam's `para` account still held 1,465,523 DOT while Hydration, Bifrost, Astar and
 * Interlay were already down to 281–481 DOT. That detail belongs to the series on `/netflows/`,
 * which draws the handover day by day; here the date is only what dates the two-leg split.
 */
const MIGRATED_ON = '2025-11-04'

/**
 * The registry's `why` strings are written to be printed verbatim and not all of them end in a
 * full stop. They are concatenated with our own sentences here, so terminate them rather than
 * editing the registry — a caveat that runs into the next sentence stops being read as a caveat.
 */
const sentence = (text) => {
  const trimmed = String(text ?? '').trim()
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

/**
 * One read, and no rescue path — deliberately.
 *
 * While this page also drew a bundled 2023 archive, a failed live read was caught here so that
 * the other half still rendered: "half of this page is unavailable" rather than "this page is
 * broken". There is no other half now. A failure means there is nothing on this page at all, so
 * the error propagates to `renderPage`, which is the branch that says so, sets
 * `body[data-state="error"]`, and prints the upstream and the advice the `ApiError` carries.
 * Catching it here would produce a page that looks like it loaded and holds nothing.
 */
async function load({ progress }) {
  progress({
    stage: 'Reading sovereign DOT from Asset Hub and the relay chain',
    note: 'Both legs, at one pinned block each — a chain’s sovereign DOT is the sum of the two.',
    done: 0,
    total: 1,
  })
  const live = await read('asset-hub', 'sovereign-dot')
  progress({ done: 1, total: 1 })
  return live
}

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

function render(host, live) {
  clear(host)

  const { totals, missing, chains } = live
  const held = chains.filter((row) => row.total > 0)
  const topThree = held.slice(0, 3).reduce((sum, row) => sum + row.total, 0)

  append(
    host,
    // Nothing at all when the upstream is live — see the note in design/liveness.js.
    livenessBanner(live?.meta?.liveness),

    statRow([
      statTile('Sovereign DOT, now', `${compact(totals.total)} DOT`, `across ${held.length} chains that hold any`, { hero: true }),
      statTile('On Asset Hub (`sibl`)', `${compact(totals.assetHubTotal)} DOT`, `${percent((totals.assetHubTotal / totals.total) * 100, 1)} of it, since the ${MIGRATED_ON} migration`),
      statTile('On the relay (`para`)', `${compact(totals.relayTotal)} DOT`, `${percent((totals.relayTotal / totals.total) * 100, 1)} — the leg that held nearly all of it before then`),
      statTile('Concentration', percent((topThree / totals.total) * 100, 1), `held by the top three: ${held.slice(0, 3).map((row) => row.name ?? `para ${row.paraId}`).join(', ')}`),
    ]),

    liveRankCard(live, held),

    missing?.length ? missingCard(missing) : null,

    historyNotice(),

    kusamaNotice(),

    notes(live, held),
  )
}

/* ══════════════════════════════════════════════════════════════════════════════ holdings ═════ */

/**
 * Today's ranking, each bar split into the two legs it is the sum of.
 *
 * The split is the point rather than decoration: it is what makes "almost all of this moved to
 * Asset Hub in November 2025" a visible fact instead of a sentence — the `para` segment is a
 * hairline on almost every row.
 */
function liveRankCard(live, held) {
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
    // The lifecycle column needs this beside it or it misleads. `Paras::ParaLifecycles` on
    // Polkadot today returns `Parathread` for 86 of its 89 entries — Asset Hub, Hydration, Acala
    // and Bifrost among them — and `Parachain` for exactly three: Bridge Hub, People Chain and
    // Coretime (verified live 2026-08-20). Under Agile Coretime a chain that holds bulk coretime
    // is registered as a parathread and takes its core assignment from the broker, so the word
    // is not a statement about whether the chain produces blocks. Printing it unqualified would
    // label Hydration a parathread, which is true of the storage item and false of the chain.
    el('p.note', {
      text: '`Lifecycle` is `Paras::ParaLifecycles` verbatim. Read it as a registration state, not as a description of the chain: under Agile Coretime almost everything here is registered as a `Parathread` and takes its core from the broker — today only Bridge Hub, People Chain and Coretime read `Parachain`. A blank is a chain that is in no relay enumeration at all.',
    }),
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
    const retired = resolveChain(row.paraId, NETWORK)?.retired ?? null
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

/* ══════════════════════════════════════════════════════════════════════════════ elsewhere ═════ */

/**
 * Where the history is, in one sentence — and why it is not drawn here.
 *
 * This is the whole replacement for the "then and now" card, and the size is the decision. The
 * question "what did these accounts hold before today" now has a complete answer: every UTC day
 * from 2022-01-01, read from the chains themselves, on `/netflows/`. Redrawing any of it here
 * would be a second, smaller copy of a page that already exists — and it would push the thing
 * this page is named for down the screen, which is the failure decision 0011 was written about.
 *
 * Hand-built rather than `notice(…)` because that helper renders paragraphs from strings, and
 * this one is a sentence with a link in the middle of it. Same structure it emits.
 */
function historyNotice() {
  return el(
    'div.notice',
    { data: { tone: 'info' } },
    el('span.tag', { text: 'info' }),
    el(
      'div',
      null,
      el('strong', { text: 'This is a snapshot, not a series' }),
      el(
        'p',
        null,
        document.createTextNode(
          'Everything above was read at one block on each chain, moments ago. The same two accounts measured once per UTC day — at each day’s last block, from 2022-01-01 to yesterday, read from the chains themselves — are drawn on ',
        ),
        el('a', { href: '/netflows/', text: '/netflows/' }),
        document.createTextNode('. That is where the history of any figure on this page lives — how it got here, and whether it is usual for that chain.'),
      ),
    ),
  )
}

/**
 * Why this page is Polkadot only.
 *
 * "No data for Kusama" is the useless version of this. Naming the two chains a Kusama half would
 * need, and pointing at the KSM archive that does exist, turns an absence into something a
 * reader — or the next person to pick this up — can act on. Research queue O26.
 */
function kusamaNotice() {
  const retired = RETIRED_CHAINS.filter((entry) => entry.network === 'kusama')
  return notice(
    'info',
    'This page is Polkadot only',
    'The live read is `asset-hub.sovereign-dot`, and it reads the Polkadot relay chain and Polkadot Asset Hub. Kusama’s sovereign accounts sit on the Kusama relay and Kusama Asset Hub — two chains this site does not read yet — so there is no KSM half here to toggle to.',
    'The 2021–2023 KSM archive does exist and is drawn on /netflows/?network=kusama. Kusama’s own Asset Hub migration completed on 2025-10-07, a month before Polkadot’s, so the same account move applies there and the same caveat would too.',
    // Spread rather than passed as a possibly-null argument: `notice` renders every argument it
    // is given as a paragraph, so a `null` here is an empty `<p>` and a gap nobody can explain.
    ...(retired.length
      ? [
          `What this site’s registry knows about Kusama since: ${retired
            .map((entry) => `${entry.name} left on ${entry.retired.on}`)
            .join(', ')}. That comes from one audit of the relays’ registration storage on 2026-08-20 rather than from a read of the chain today.`,
        ]
      : []),
  )
}

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const wrapAnywhere = (node) => (node ? style(node, 'overflow-wrap:anywhere') : node)

function notes(live, held) {
  // Computed from the payload on screen rather than from a fixed list, so this counts the chains
  // actually drawn above and cannot drift away from them.
  const stranded = held
    .map((row) => ({ row, entry: resolveChain(row.paraId, NETWORK) }))
    .filter((pair) => pair.entry?.retired)
    .sort((a, b) => b.row.total - a.row.total)
  const strandedDot = stranded.reduce((sum, pair) => sum + pair.row.total, 0)

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    livenessNotes(live?.meta?.liveness),

    el('h3', { text: 'Today’s reading' }),
    wrapAnywhere(el('ul', null, ...(live.notes ?? []).map((note) => el('li', { text: note })))),
    el('p', {
      text: `Read at relay block ${formatCount(live.relay.block)} and Asset Hub block ${formatCount(live.assetHub.block)}, fetched ${formatUtc(Date.parse(live.fetchedAt))}. Those are two different chains at two different heights: a transfer landing between the two reads would appear in one leg and not the other, which is why each holding row in the payload carries its own block height rather than one shared one.`,
    }),

    el('h3', { text: 'Reading these numbers' }),
    wrapAnywhere(
      el(
        'ul',
        null,
        stranded.length
          ? el('li', {
              text:
                `${stranded.length} of the ${held.length} chains holding DOT here have LEFT the network: ${stranded
                  .map((pair) => `${pair.entry.name} on ${pair.entry.retired.on}`)
                  .join(', ')}. Their ${compact(strandedDot)} DOT is counted in every total above and shown at its real size, because it really is there — a deregistered chain’s DOT stays exactly where it was — but read it as stranded rather than held: the chain that would have had to instruct a transfer out of those accounts no longer runs. Showing it as zero would say the money went back.`,
            })
          : null,
        el('li', {
          text: 'A chain being absent from this site’s `retired` list is weaker than a claim that it is running. That list came from one audit of the relays’ registration storage on 2026-08-20 and nothing re-runs it, so it is a fact with a date on it rather than a live status.',
        }),
        el('li', {
          text: 'DOT only. A parachain’s sovereign accounts also hold USDC, USDT and every bridged asset; that decomposition is on the /bridged/ page and the two must not be added together.',
        }),
        // The payload's own last note says this site keeps no history of these balances. That
        // stopped being true when `netflows-daily` backfilled 2022-01 → yesterday, and it renders
        // three bullets above this one — so the correction goes here rather than being left as
        // two sentences that contradict each other with no way to tell which is current. Delete
        // this bullet when the note is fixed in `server/sources/asset-hub.mjs`.
        el('li', {
          text: 'One note in the reading above is out of date: it says this site keeps no history of these balances. /netflows/ now holds the same two accounts, read at each UTC day’s last block, from 2022-01-01 to yesterday.',
        }),
        el('li', {
          text: `Do not set these figures against the LAST ROW of the archived 2023 Polkalytics study, which is where a comparison with that file naturally reaches for. Its captures stop mid-day, so that row — 2023-04-08 — is a mid-day reading published as a day’s close: all eight chains in it disagree with a fresh read of the chain by up to 23.6%, where on every other day the file and the chain agree to a median 4.0 × 10⁻⁹. The archive is drawn against the re-derived daily series, with that deviation stated, on /netflows/.`,
        }),
      ),
    ),
  )
}

renderPage({
  page: pageByKey('sovereign'),
  intro:
    'When DOT moves to a parachain it is locked in that parachain’s sovereign account and minted on the other side. This page reads those accounts as they stand right now: both legs of every enumerated parachain — the `para` account on the relay chain and the `sibl` account on Asset Hub — summed, at one pinned block on each chain. It is a snapshot; the same accounts every UTC day since January 2022 are on /netflows/.',
  // The two blocks that are always here: today's tiles, then today's ranking. The card for the
  // chains the relay does not enumerate is not reserved for, because whether it exists depends
  // on the payload, and reserving space for a block that may not arrive is its own jump.
  skeleton: ['stats', 'rows'],
  loadingLabel: 'Reading sovereign balances from the relay chain and Asset Hub',
  load,
  render,
})
