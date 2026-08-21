// Parachain netflows: the relay token held in parachain sovereign accounts, every day, from the
// first month each network can answer for to yesterday. Polkadot and Kusama, the same series.
//
// ── what changed, and why it is the whole point of this page ─────────────────────────────────
// For three years this page drew a 2023 Polkalytics archive — 2022-02-02 to 2023-04-08 for
// Polkadot, 2021-07-01 to 2023-03-12 for Kusama — and stopped there, while `/sovereign/` drew
// today. Between them was a three-and-a-half-year hole, and no amount of caveat text makes a
// hole into a series. It is now filled on BOTH networks: the same measurement the 2023 study
// made is taken again, from the chains themselves, once per UTC day. The archive is still here —
// as a CROSS-CHECK, drawn against the re-derived series where the two overlap, with the
// deviation stated rather than assumed.
//
// The backfill lives in `server/sources/asset-hub.mjs` as the store-backed job
// `netflows-daily` (one calendar month per job per NETWORK, one UTC day per stored fact) plus
// the live operation `sovereign-dot-recent` for the tail a month-bucketed store cannot serve.
// This file reads both and draws the join.
//
// ── the three things this page must be loud about ────────────────────────────────────────────
//
//  1. A DAY IS ITS CLOSE. Each value is the state at that UTC day's LAST BLOCK on each chain.
//     That is the archive's own definition and reproducing it is what makes the cross-check
//     meaningful: reading at 00:00 instead would shift the whole series one day early and read
//     as a genuine lead rather than as an off-by-one.
//
//  2. THE SERIES CROSSES TWO CHAINS. Before the Asset Hub Migration — Polkadot 2025-11-04,
//     Kusama 2025-10-07, both bisected out of their own relay chain rather than transcribed — a
//     parachain's reserve sat in its `para` account ON ITS RELAY CHAIN; after it, in its `sibl`
//     account on ITS ASSET HUB. Every day here reads BOTH, and the second chart draws the
//     handover explicitly. The per-chain lines are continuous because the money moved rather
//     than doubled — but a series that only showed the sum would hide the largest structural
//     break in it.
//
//  3. WHAT IS MISSING IS DRAWN. A day the store does not hold yet is a gap in the line, never a
//     zero, and the data notes count them. The store fills on demand: the first reader of a
//     month is what starts its fetch, so a fresh deployment draws a sparse chart that fills in
//     over the following minutes rather than an empty one that looks broken.
//
// ── the two networks are one page, and the differences are the dangerous part ────────────────
// Nothing here is Polkadot-shaped any more. Every token amount, every chain name, every
// sovereign address and both structural dates come from `NETWORKS` below and never from a
// module constant. The reason is that KSM is 12 decimals and DOT is 10: a Kusama series drawn
// with the DOT divisor is exactly 100× too large, with a correctly shaped line and a correctly
// shaped axis. Kusama's SS58 prefix is 2, so an address rendered at prefix 0 is a valid-looking
// Polkadot address for a Kusama account. And the two Asset Hub Migrations are four weeks apart.

import '../../design/app.css'
import { choiceControl, renderPage } from '../../design/page.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { read } from '../../core/client.js'
import { followStore } from '../../core/follow.js'
import { liveness } from '../../core/liveness.js'
import { livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, percent } from '../../core/format.js'
import { chainOf, resolveChain, sovereignAddress } from '../../core/topology.js'
import { ARCHIVE_QUANTUM, buildSeries, crossCheck, units } from './series.js'
import dataset from '../../data/netflows.json'

/**
 * Everything that differs between the two networks, in one table, mirroring the server's.
 *
 * `firstMonth` is the earliest WHOLE month both of that network's chains can answer for, and on
 * both networks the binding constraint is the same: an Asset Hub with state but no
 * `Timestamp::Now`, which is indistinguishable from a pruned archive and whose balance reads come
 * back `null`, which is indistinguishable from an empty account.
 *
 *   polkadot  Asset Hub's clock starts at #305,204 = 2021-12-18T18:52:54Z. Polkadot's first
 *             parachains onboarded 2021-12-17 and no sovereign account held DOT until
 *             2022-02-02, so 2022-01 is a month of verified-EMPTY days, not missing ones.
 *   kusama    Kusama Asset Hub's clock starts at #66,687 = 2021-06-03T15:36:00.509Z (bisected
 *             live 2026-08-21). June 2021 cannot be a whole month, so the series opens at
 *             2021-07 — which is also the archived dataset's own first day.
 *
 * `migratedOn` is the Asset Hub Migration. No storage item says it; both dates were established
 * in this repo by bisecting a large sovereign account out of the relay chain itself, and both
 * were PROGRESSIVE rather than atomic — `migrationEvidence` carries each one's, verbatim.
 *
 * `decimals` is the one that fails silently. DOT is 10 and KSM is 12; the wrong divisor is a
 * factor of 100 that draws a correctly shaped line on a correctly shaped axis.
 */
const NETWORKS = {
  polkadot: {
    id: 'polkadot',
    label: 'Polkadot',
    token: 'DOT',
    decimals: 10,
    ss58: 0,
    relayName: 'the relay chain',
    assetHubName: 'Asset Hub',
    firstMonth: '2022-01',
    migratedOn: '2025-11-04',
    migrationEvidence:
      `Acala's \`para\` account on the Polkadot relay falls from 3,137,094.16 DOT to 341.00 DOT across ` +
      `#28,493,861→862 — while at that same block Moonbeam still held 1,465,523 DOT there and Hydration, ` +
      `Bifrost, Astar and Interlay were already down to 281–481 DOT.`,
  },
  kusama: {
    id: 'kusama',
    label: 'Kusama',
    token: 'KSM',
    decimals: 12,
    ss58: 2,
    relayName: 'the Kusama relay chain',
    assetHubName: 'Kusama Asset Hub',
    firstMonth: '2021-07',
    migratedOn: '2025-10-07',
    migrationEvidence:
      `Karura's \`para\` account on the Kusama relay falls from 40,394.8 KSM to 160.0 KSM across ` +
      `#30,424,405→#30,424,406, dated 2025-10-07T14:47:54Z — while at that same block Bifrost still held ` +
      `19,525.2 KSM there, Kintsugi 6,481.3, Basilisk 2,528.5 and Picasso 2,470.8, and Moonriver, Heiko ` +
      `and Mangata were already down to 40–90 KSM. The handover completes inside that UTC day.`,
  },
}

const NET = NETWORKS[new URLSearchParams(location.search).get('network')] ?? NETWORKS.polkadot
const NETWORK = NET.id

/** Planck to whole tokens, at THIS network's decimals. Never a module constant — see series.js. */
const amount = (raw) => units(raw, NET.decimals)

/** A chain whose ARCHIVE daily line understates its true peak by more than this gets marked. */
const CLIP_THRESHOLD = 0.03

/** How many chains get a line. Everything else is in the ranking and the table beneath it. */
const CHART_LINES = 10

const amountOf = (token) => (value) => `${compact(value)} ${token}`

/** This network's chain registry entry for a para id, or null. Keyed by RELAY, never globally:
 *  para 2000 is Acala on Polkadot and Karura on Kusama. */
const nameOf = (paraId) => chainOf(paraId, NETWORK)?.name ?? `para ${paraId}`

/** A sovereign address at THIS network's SS58 prefix. Prefix 0 on a Kusama account is a
 *  valid-looking Polkadot address for an account that does not exist there. */
const addressOf = (paraId, on) => sovereignAddress(paraId, { on, ss58Prefix: NET.ss58 })

/* ═════════════════════════════════════════════════════════════════════════════ liveness ═════ */

/**
 * The archive's liveness assertion — `frozen`, permanently and by design.
 *
 * It is still here, and it still matters, but it now describes a CROSS-CHECK rather than the
 * page's subject: the reason to say "this file stopped on 2023-04-08" is so that a deviation
 * between it and the live series is read as two measurements of the same past, not as one of
 * them being out of date.
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
      'Nothing was read at load time: this dataset ships inside the page. “Frozen” here is the ' +
      'permanent, intended state of an archive rather than a stalled indexer. On this page it is ' +
      'no longer the source of the chart — it is the independent second reading the chart is ' +
      `checked against, over ${network.first} to ${network.last}.`,
  })
}

/**
 * What this site's registry has to say about a chain — three answers, not two. A chain the
 * registry has never heard of is NOT a chain that is still running, and collapsing those would
 * print a claim nobody made.
 */
const retiredOf = (paraId) => chainOf(paraId, NETWORK)?.retired ?? null

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

async function load({ progress }) {
  const network = dataset.networks[NETWORK]
  if (!network) throw Object.assign(new Error(`The archived dataset has no \`${NETWORK}\` network.`), { kind: 'decode' })
  if (network.token !== NET.token || network.decimals !== NET.decimals) {
    // The archive is compiled into this bundle and the series is read from a chain. If the two
    // disagree about the token or its decimals, every comparison below is nonsense — and that
    // mismatch is exactly the shape a copy-paste between the two networks would take. The
    // archive is a THIRD independent statement of the divisor, after the network table here and
    // `system_properties` on the chains themselves, and it costs one comparison to use it.
    throw Object.assign(
      new Error(
        `The archived dataset calls ${NETWORK} \`${network.token}\`/${network.decimals} and this page calls it ` +
          `\`${NET.token}\`/${NET.decimals}. Every figure below would be scaled by the wrong divisor.`,
      ),
      { kind: 'decode' },
    )
  }

  const archive = archiveLiveness(network)

  // ONE request for every stored month — decision 0020. This page used to make one request per
  // month, and fifty-six at once through the edge's 30-per-minute rate limit was the page
  // answering its own tail with 429s. Which months exist is now the SERVER's clock's decision;
  // the reader's clock decides only how many tail days to ask for, and the server refuses any
  // day it cannot verify, so a wrong clock costs a shorter tail rather than a wrong number.
  const tailDays = Math.max(0, new Date().getUTCDate() - 1)
  const total = 1 + (tailDays > 0 ? 1 : 0)
  progress({ stage: 'Reading the stored series', done: 0, total })
  const series = await read('asset-hub', 'netflows-series', { network: NETWORK })

  if (series?.token !== NET.token || series?.decimals !== NET.decimals) {
    // The same tripwire as the archive gate above, pointed at the server: every figure the
    // aggregate carries was scaled by ITS divisor, and drawing it under this page's would be
    // the factor-of-100 that renders perfectly.
    throw Object.assign(
      new Error(
        `The server calls ${NETWORK} \`${series?.token}\`/${series?.decimals} and this page calls it ` +
          `\`${NET.token}\`/${NET.decimals}. Every figure below would be scaled by the wrong divisor.`,
      ),
      { kind: 'decode' },
    )
  }

  // The per-month `{data, coverage, job}` entries are byte-compatible with the single-month
  // envelope, so the series shaper reads them unchanged — and a month arriving later over the
  // stream (the same envelope again) replaces its entry without translation.
  const months = (series.months ?? []).map((entry) => ({ month: entry.month, body: entry }))
  const lastWholeMonth = months.length ? months[months.length - 1].month : null

  // The tail: the days of the current month that have already closed. On the 1st there are
  // none, and the stored months already reach yesterday.
  let tail = null
  if (tailDays > 0) {
    progress({ stage: 'Reading the current month from the chains', done: 1, total })
    tail = await read('asset-hub', 'sovereign-dot-recent', { days: Math.min(tailDays, 40), network: NETWORK })
  }
  progress({ stage: 'Drawing', done: total, total })

  return {
    network,
    archive,
    months,
    tail,
    lastWholeMonth,
    live: !series.coverage?.complete,
    // The month that ended but has not settled yet — the server names it so this page can say
    // why, for one hour a month, the series is a month shorter than a reader expects.
    pending: series.coverage?.pending ?? null,
    // Set by followMissing's onSettled when the live subscription ends for any reason other
    // than completion; flips the gap notice from a promise to a truthful past tense.
    followEnded: null,
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

/**
 * The one follow this page load ever starts, or null. Module-level because `render` runs once
 * per UPDATE, not once per page: the harness renders once by design (src/design/dom.js), and
 * this page re-invokes its own `render` into the same host as months land — so the guard that
 * stops every re-render from opening another EventSource has to outlive the render call.
 */
let following = null

function render(host, data) {
  clear(host)
  renderSeries(host, data)
  followMissing(host, data)
}

/**
 * Subscribe for the months the aggregate could not answer, and re-render as each lands.
 *
 * The stream hands over the same envelope the HTTP endpoint answers, so applying one is a keyed
 * replacement into `data.months` — idempotent, because a reconnecting stream re-delivers and a
 * fallback poll overlaps with it. The fallback (a slow re-read of the aggregate) replaces the
 * whole list the same way. Either way the page redraws from `data`, which keeps every chart,
 * notice and data note derived from one payload — rule 3 survives the page becoming live.
 */
function followMissing(host, data) {
  if (following !== null) return
  const missing = data.months.filter((m) => !m.body?.coverage?.complete).map((m) => m.month)
  if (!missing.length) return
  following = followStore({
    source: 'asset-hub',
    operation: 'netflows-daily',
    query: { network: NETWORK, months: missing.join(',') },
    event: 'month',
    poll: async () => {
      const series = await read('asset-hub', 'netflows-series', { network: NETWORK })
      if (series?.token !== NET.token || series?.decimals !== NET.decimals) return { complete: false }
      data.months = (series.months ?? []).map((entry) => ({ month: entry.month, body: entry }))
      data.live = !series.coverage?.complete
      render(host, data)
      return { complete: Boolean(series.coverage?.complete) }
    },
    onUpdate: (update) => {
      if (update.kind === 'stalled') {
        // The fetch for this month surrendered; it will not land without a maintainer. Record
        // the gave-up job on the entry so the notice can COUNT it — a stalled month silently
        // left "in flight" is a promise the page cannot keep.
        const entry = data.months.find((m) => m.month === update.data?.params?.month)
        if (!entry || !update.data?.job) return
        entry.body = { ...(entry.body ?? {}), job: update.data.job }
        render(host, data)
        return
      }
      if (update.kind !== 'event') return
      const envelope = update.data
      const entry = data.months.find((m) => m.month === envelope?.params?.month)
      if (!entry) return
      entry.body = envelope
      data.live = data.months.some((m) => !m.body?.coverage?.complete)
      render(host, data)
    },
    onSettled: (why) => {
      // 'done' and 'complete' need nothing: the last event or poll already re-rendered a full
      // series. Any other reason means the follow gave up with months still missing, and the
      // page must stop claiming it is subscribed — the copy flips to a truthful past tense.
      if (why === 'done' || why === 'complete') return
      data.followEnded = why
      render(host, data)
    },
  })
}

function renderSeries(host, { network, archive, tail, months, lastWholeMonth, live, pending, followEnded }) {
  const series = buildSeries({ months, tail, firstDay: `${NET.firstMonth}-01`, decimals: NET.decimals })
  const check = crossCheck(series, network, (name) => resolveChain(name, NETWORK)?.paraId ?? null)
  const token = NET.token
  const format = amountOf(token)

  if (!series.days.length) {
    return append(
      host,
      notice(
        'warning',
        `Nothing is stored yet for ${NET.label}, and the fetch has just been started`,
        'This page is drawn from a store that fills on demand: this request is what started the fetch. The page stays subscribed and draws each month the moment it lands — no reload needed.',
        coverageSentence(series.coverage),
      ),
      notes({ series, check, archive, network, lastWholeMonth, tail, pending }),
    )
  }

  const totalNow = series.latest ? amount(series.latest.totals.total) : null

  append(
    host,
    // The chart first, and deliberately first: decision 0011 — a page has one subject, and on
    // this page the subject is the series. Every block that has ever been put above it has
    // pushed it below the fold.
    chartCard(series, token),

    // Slim, and underneath. Context for the chart, not a headline of its own.
    statRow([
      statTile('Days drawn', formatCount(series.coverage.present), coveredRange(series)),
      statTile('Chains seen', String(series.chains.length), `held at least ${series.coverage.dustFloor ?? '—'} ${token} on at least one day`),
      statTile('Largest holding', format(series.chains[0]?.peak ?? 0), `${nameOf(series.chains[0]?.paraId)}, on ${series.chains[0]?.peakOn}`),
      statTile('Held on the last day', totalNow === null ? '—' : format(totalNow), series.last ? `across every chain, at the close of ${series.last}` : 'nothing stored'),
    ]),

    series.coverage.missing > 0 ? gapNotice(series, { live, followEnded }) : null,
    legsCard(series, token),
    check ? crossCheckCard(check, token) : null,
    archiveClipNotice(network),
    rankCard(series, format),
    discrepanciesCard(),
    notes({ series, check, archive, network, lastWholeMonth, tail, pending }),
  )
}

const coveredRange = (series) => (series.firstPresent && series.last ? `${series.firstPresent} → ${series.last}` : 'nothing yet')

/* ══════════════════════════════════════════════════════════════════════════ the charts ═════ */

function chartCard(series, token) {
  const drawn = series.chains.slice(0, CHART_LINES)
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held in parachain sovereign accounts, ${series.first} → ${series.last}` }),
      el('p.note', {
        text:
          `One line per chain on one shared scale — the ${CHART_LINES} largest by peak, of ${series.chains.length} seen. ` +
          `Each point is that chain's balance at the UTC day's LAST BLOCK, summed across its \`para\` account on ` +
          `${NET.relayName} and its \`sibl\` account on ${NET.assetHubName}. A line begins where that chain first holds ` +
          `${token}; before that it is absent, not zero.` +
          (series.coverage.missing ? ' A break in a line is one of the days this site has not fetched yet.' : ''),
      }),
    ),
  )

  const legend = el('ul.legend')
  drawn.forEach((chain, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${nameOf(chain.paraId)} `),
        el('span.amt', { text: compact(chain.peak) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: drawn.map((chain) => ({ label: nameOf(chain.paraId), values: chain.values })),
      format: compact,
      height: 380,
    }),
  )
  return card
}

/**
 * The migration, drawn rather than described.
 *
 * Two series on ONE axis, which is the only honest way to show it: the same DOT, counted in two
 * different places, handing over on 2025-11-04. The per-chain lines above are continuous across
 * that date because the money moved rather than doubled — this is the chart that says the
 * accounts underneath them changed chain.
 */
function legsCard(series, token) {
  const migrationIndex = series.days.indexOf(NET.migratedOn)
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `Which chain the ${token} is actually on` }),
      el('p.note', {
        text:
          `The same total, split by where it sits. Until the Asset Hub Migration a parachain's reserve was in its \`para\` ` +
          `account on ${NET.relayName}; from ${NET.migratedOn} it is in its \`sibl\` account on ${NET.assetHubName}. The ` +
          `lines above are continuous across that date because the ${token} moved rather than doubled — this is the handover ` +
          `itself. It was progressive, not atomic: different chains moved on different days, which is why the crossing takes ` +
          `more than one day.`,
      }),
    ),
  )
  const legend = el(
    'ul.legend',
    null,
    el('li', null, el('span.swatch', { style: `background:${seriesColor(0)}` }), document.createTextNode(`On ${NET.relayName} (\`para\`)`)),
    el('li', null, el('span.swatch', { style: `background:${seriesColor(1)}` }), document.createTextNode(`On ${NET.assetHubName} (\`sibl\`)`)),
  )
  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: [
        { label: `On ${NET.relayName}`, values: series.legs.relay },
        { label: `On ${NET.assetHubName}`, values: series.legs.assetHub },
      ],
      format: compact,
      height: 280,
    }),
  )
  if (migrationIndex >= 0) {
    append(
      card,
      el('p.note', {
        text: `${NET.migratedOn} is day ${formatCount(migrationIndex + 1)} of ${formatCount(series.days.length)} on this axis. ${NET.migrationEvidence}`,
      }),
    )
  }
  return card
}

/* ------------------------------------------------------------------------ cross-check ---- */

/**
 * The verdict is taken on the ABSOLUTE gap, not on the relative deviation, and that is the one
 * decision in this card worth explaining.
 *
 * The archive stores two decimal places. On Polkadot its smallest overlapping balance is 1.23
 * DOT, where half a hundredth is 0.25%; on Kusama it is 0.03 KSM, where the identical half a
 * hundredth is 7.3%. A relative threshold therefore reports two readings that agree to the
 * planck as a third of the Kusama chain-days disagreeing — a warning banner on a page whose
 * numbers are right. `beyondQuantum` counts the chain-days whose difference the file's own
 * precision CANNOT explain, which is the same question on both networks.
 */
function crossCheckCard(check, token) {
  const { body, tail, assetHub } = check
  const agrees = body && body.beyondQuantum === 0

  // A `p.note` above the table rather than a `<caption>` inside it: this page adds no CSS, and
  // the design system has no caption rule, so a bare one would render in the UA's centred style.
  const worstTable = (rows, caption) =>
    el(
      'div',
      null,
      el('p.note', { text: caption }),
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
            el('th', { text: 'Day' }),
            el('th', { text: 'Chain' }),
            el('th.num', { text: `2023 archive (${token})` }),
            el('th.num', { text: '`para` leg, read now' }),
            el('th.num', { text: 'Deviation' }),
            el('th.num', { text: `Gap (${token})` }),
          ),
        ),
        el(
          'tbody',
          null,
          ...rows.map((row) =>
            el(
              'tr',
              null,
              el('td.mono', { text: row.date }),
              el('td', { text: row.name }),
              el('td.num', { text: compact(row.archived) }),
              el('td.num', { text: compact(row.value) }),
              el('td.num', { text: percent(row.deviation * 100, 4) }),
              el('td.num', { text: row.gap.toFixed(6) }),
            ),
          ),
        ),
      ),
      ),
    )

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Checked against the 2023 archive' }),
      el('p.note', {
        text:
          `The 2021–2023 Polkalytics study measured the same accounts with different code, and its dataset is still ` +
          `compiled into this page. Where it overlaps the series above — ${check.from} to ${check.to}, ` +
          `${formatCount(check.pairs)} chain-days across ${check.chains} chains — the two are compared here rather than ` +
          `assumed to agree. The comparison is against the \`para\` LEG ALONE, because that is what the 2023 study read: ` +
          `scoring it against the sum would count the ${NET.assetHubName} leg as a disagreement when it is simply something ` +
          `the original never had.`,
      }),
    ),
    body
      ? notice(
          agrees ? 'good' : 'warning',
          agrees
            ? `They agree: median deviation ${percent(body.median * 100, 7)} over ${formatCount(body.pairs)} chain-days`
            : `They disagree on ${formatCount(body.beyondQuantum)} of ${formatCount(body.pairs)} chain-days`,
          agrees
            ? `Outside that final day, not one of the ${formatCount(body.pairs)} chain-days differs by more than ` +
              `${ARCHIVE_QUANTUM} ${token} in absolute terms — the largest gap anywhere is ${body.maxGap.toFixed(6)} ${token} — ` +
              `which is exactly what the archive's own two-decimal storage can produce and nothing more. The worst RELATIVE ` +
              `deviation is ${percent(body.max * 100, 3)}, on ${body.worst[0].name} holding ${compact(body.worst[0].archived)} ` +
              `${token}, and it is the same rounding seen through a small denominator: ${formatCount(body.over)} chain-days ` +
              `exceed 0.01% and every one of them is a small balance. The account derivation, the day boundary, the decimals ` +
              `and the \`free + reserved\` convention all reproduce independently, three years apart, from two different ` +
              `codebases.`
            : `${formatCount(body.beyondQuantum)} of ${formatCount(body.pairs)} chain-days differ by more than the ` +
              `${ARCHIVE_QUANTUM} ${token} the file's two decimal places can produce. The largest is ` +
              `${body.worstGap[0].name} on ${body.worstGap[0].date}: ${body.worstGap[0].archived.toFixed(2)} ${token} in ` +
              `the file against ${body.worstGap[0].value.toFixed(6)} read from the chain, a gap of ` +
              `${body.maxGap.toFixed(6)} ${token} — ${percent(body.worstGap[0].deviation * 100, 4)} of that balance. Those ` +
              `are real differences between two readings of the same past, not rounding. Everything else agrees: the ` +
              `median deviation over all ${formatCount(body.pairs)} is ${percent(body.median * 100, 7)}. (The worst ` +
              `RELATIVE figure on this page, ${percent(body.max * 100, 3)}, is a different row — a chain holding ` +
              `${compact(body.worst[0].archived)} ${token}, where the same rounding is a large fraction of a small ` +
              `number — and the two must not be quoted together.)`,
        )
      : null,
    // The archive's last day is not a whole day, and this is where that stops being a footnote
    // in a caveat string and becomes a number on the page.
    tail
      ? notice(
          'warning',
          `Except on ${check.finalDay}, the archive's last day, where all ${formatCount(tail.pairs)} chains disagree`,
          `Up to ${percent(tail.max * 100, 1)} on ${tail.worst[0].name}: ${compact(tail.worst[0].archived)} ${token} in the ` +
            `file against ${compact(tail.worst[0].value)} ${token} read from the chain at that day's last block. This is the file's ` +
            `own coverage caveat becoming visible — its captures run eight days past the report's window and simply stop, ` +
            `so its final row is the last observation it happened to take rather than that UTC day's close. Every other ` +
            `day in the overlap is a close and matches. The archive's published "at the end" figures are therefore ` +
            `mid-day readings, not day-end ones.`,
        )
      : null,
    assetHub.pairs
      ? notice(
          'info',
          `And the ${NET.assetHubName} leg, which the 2023 study could not have read`,
          `On ${formatCount(assetHub.pairs)} of the ${formatCount(check.pairs)} chain-days in this overlap a parachain ` +
            `ALSO held ${token} in its \`sibl\` account on ${NET.assetHubName} — at most ${percent(assetHub.maxShare * 100, 2)} of that ` +
            `chain's total at the time. Small then, and the whole thing now: after the Asset Hub Migration on ${NET.migratedOn} it is where ` +
            `essentially all of it sits. The series above sums both legs; the comparison above uses only the relay leg, ` +
            `so this is stated rather than hidden inside a residual.`,
        )
      : null,
    body
      ? worstTable(
          body.worstGap,
          `The five largest ABSOLUTE gaps outside ${check.finalDay}. Absolute, because the archive's two-decimal storage ` +
            `bounds the gap and not the percentage: the same half-hundredth is 0.25% of 1.23 ${token} and 7.3% of 0.03 ${token}.`,
        )
      : null,
    tail ? worstTable(tail.worstGap, `${check.finalDay}, the archive's partial final day`) : null,
  )
}

/* ------------------------------------------------------------------------------- rank ---- */

function rankCard(series, format) {
  const max = series.chains[0]?.peak ?? 1
  const list = el('div.rows')

  series.chains.slice(0, 24).forEach((chain, i) => {
    const retired = retiredOf(chain.paraId)
    const label = nameOf(chain.paraId)
    append(
      list,
      el(
        'div.row.rank-row',
        { title: retired ? `${addressOf(chain.paraId, 'relay')}\n\n${retired.why}` : addressOf(chain.paraId, 'relay') },
        el('div.rank', { text: String(i + 1) }),
        el(
          'div.name',
          // Wrapping rather than clipping, so the marker survives a narrow viewport: `.name`
          // never wraps by default, and at 390px the pill would simply vanish — which is the
          // one thing a "this chain has left" marker must never do.
          { style: 'overflow:visible;white-space:normal;display:flex;flex-wrap:wrap;gap:var(--s2);align-items:baseline' },
          el('span', { text: label }),
          retired ? el('span.pill', { data: { tone: 'warning' }, text: `left ${retired.on}` }) : null,
        ),
        el(
          'div.track',
          null,
          el('div.fill', { style: `width:${Math.max(0.5, (chain.peak / max) * 100)}%;background:${seriesColor(i)}` }),
        ),
        el('div.amt', { text: format(chain.peak) }),
        el('div.amt', null, el('span.cnt', { text: `ended ${compact(chain.last ?? 0)}` })),
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
        text: `Peak is the highest daily close observed anywhere in ${series.first} → ${series.last}. It is not a simultaneous total: each chain is at its own high on its own day. A balance that rose and fell back inside one UTC day leaves no trace here, because a day is one reading.`,
      }),
    ),
    list,
    table(series),
  )
}

/**
 * The table is not an appendix. It is the accessibility fallback for the charts above — every
 * chart on this site has one — and it is the only place both sovereign addresses appear in full.
 */
function table(series) {
  const body = el('tbody')
  for (const chain of series.chains) {
    const entry = chainOf(chain.paraId, NETWORK)
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: entry?.name ?? `para ${chain.paraId}` }),
        el('td.num', { text: String(chain.paraId) }),
        el('td.num', { text: compact(chain.peak) }),
        el('td.mono', { text: chain.peakOn ?? '—' }),
        el('td.num', { text: compact(chain.last ?? 0) }),
        el('td', { text: !entry ? 'not in this site’s registry' : entry.retired ? `left ${entry.retired.on}` : 'still registered' }),
        el('td.mono', { text: addressOf(chain.paraId, 'relay') }),
        el('td.mono', { text: addressOf(chain.paraId, 'sibling') }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: 'Every chain, its peak, and both sovereign account addresses' }),
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
            el('th.num', { text: 'Peak' }),
            el('th', { text: 'On' }),
            el('th.num', { text: 'Last day' }),
            el('th', { text: 'Since' }),
            el('th', { text: `\`para\` on ${NET.relayName}` }),
            el('th', { text: `\`sibl\` on ${NET.assetHubName}` }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ------------------------------------------------------------------------- the caveats ---- */

const coverageSentence = (coverage) =>
  `${formatCount(coverage.complete)} of ${formatCount(coverage.months)} months are fully stored` +
  (coverage.jobs.length ? `, and ${formatCount(coverage.jobs.length)} fetch${coverage.jobs.length === 1 ? ' is' : 'es are'} in flight` : '') +
  '.'

function gapNotice(series, { live, followEnded } = {}) {
  const { coverage } = series
  const stalled = coverage.jobs.filter((job) => job?.state === 'gave-up').length
  return notice(
    'warning',
    `${formatCount(coverage.missing)} of the ${formatCount(coverage.days)} days in this span are not drawn`,
    'This series is served from a store that fills on demand, one calendar month per fetch — reading this page is what starts the missing ones. A day that has not been fetched is a break in the line, never a zero: the chart says nothing at all about it rather than saying it was empty.',
    `${coverageSentence(coverage)}${
      stalled
        ? ` ${formatCount(stalled)} month${stalled === 1 ? "'s fetch has" : "s' fetches have"} surrendered after repeated failures and will NOT land without a maintainer — ${stalled === 1 ? 'that gap' : 'those gaps'} will outlive this visit.`
        : ''
    } ${
      followEnded
        ? 'The live subscription this page opened has ended with months still missing — reload to continue the fill.'
        : live
          ? 'This page stays subscribed and draws each month the moment it lands — no reload needed.'
          : 'Reloading this page continues the fill.'
    }`,
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
      el('h2', { text: 'Where the 2023 report and its own data disagree' }),
      el('p.note', {
        text: 'Re-deriving the archived dataset from the raw CSVs in 2026 turned up three places where the published 2023 report says something its own underlying data does not support. They are listed rather than reconciled — the report is still online and saying otherwise.',
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

function notes({ series, check, archive, network, lastWholeMonth, tail, pending }) {
  const latest = series.latest
  const token = NET.token
  const retired = series.chains.map((c) => ({ chain: c, entry: chainOf(c.paraId, NETWORK) })).filter((row) => row.entry?.retired)
  const unnamed = series.chains.filter((c) => !chainOf(c.paraId, NETWORK))

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    // Two reports side by side, in the same vocabulary: the chains this series was read from,
    // and the archive it is checked against. That the second says `frozen` is the point — it is
    // what makes a deviation between them read as two measurements of one past rather than as
    // one of them being out of date.
    livenessNotes([...(tail?.meta?.liveness ?? []), ...(archive ? [archive] : [])]),

    el('h3', { text: 'What this measures' }),
    el('p', {
      text:
        `A ${NET.label} parachain's ${token} is the SUM of two accounts on two chains: \`para\` on ${NET.relayName} and ` +
        `\`sibl\` on ${NET.assetHubName}. Both are read on every day of this series, at that day's LAST BLOCK on each ` +
        `chain — two different blocks, because they are two different chains. ` +
        `${latest ? `The most recent day, ${latest.date}, was read at relay #${formatCount(latest.relay.block)} and ${NET.assetHubName} #${formatCount(latest.assetHub.block)}.` : ''}`,
    }),
    wrapAnywhere(
      el(
        'ul',
        null,
        el('li', {
          text:
            `A DAY IS ITS CLOSE, not its open. Reading the state at 00:00 instead would put every value one day early ` +
            `against the archived dataset and read as a genuine one-day lead rather than as an off-by-one. It also means a ` +
            `balance that rose and fell back inside a single UTC day leaves no trace at all — the same limitation the 2023 ` +
            `study had, and the reason its own Bifrost line understates that chain's true peak by 55%.`,
        }),
        el('li', {
          text:
            `THE SERIES CROSSES TWO CHAINS. The Asset Hub Migration on ${NET.migratedOn} moved every parachain's ${token} ` +
            `reserve from ${NET.relayName} to ${NET.assetHubName}. Both legs are read on every day here and the second chart ` +
            `draws the handover, so the per-chain lines are continuous without hiding that the accounts underneath them ` +
            `changed chain. No storage item records that date; it was established here by bisecting the relay chain itself, ` +
            `and it was progressive rather than atomic. ${NET.migrationEvidence}`,
        }),
        el('li', {
          text:
            `${token} IS ${NET.decimals} DECIMALS, and that is the divisor every figure on this page is scaled by. Both of ` +
            `${NET.label}'s chains say so in \`system_properties\` and the server refuses to read a day from a chain that ` +
            `disagrees — because DOT is 10 and KSM is 12, and the other network's divisor is a factor of 100 that draws a ` +
            `correctly shaped line on a correctly shaped axis. Addresses here are SS58 prefix ${NET.ss58}.`,
        }),
        el('li', {
          text:
            `WHICH CHAINS ARE READ is the union of four enumerations, taken at each day's own block: ${NET.relayName}'s ` +
            `\`Paras::ParaLifecycles\`, its \`Registrar::Paras\`, this site's own topology registry for ${NET.label}, and ` +
            `every chain already seen holding an account earlier in the same fetch. No single one of them is complete — on ` +
            `Polkadot, para 2004 is in neither relay item today and still holds DOT. A chain that both left the registry and ` +
            `is absent from this site's registry would still be missed; nothing here can rule that out.`,
        }),
        el('li', {
          text:
            `SMALL HOLDINGS ARE SUMMED, NOT NAMED. A chain is listed individually on a day only if it held at least ` +
            `${series.coverage.dustFloor} ${token} — the floor the server actually applied, read back out of the stored day rather ` +
            `than restated here, because it is a fixed planck amount and so a different figure on each network — and is among ` +
            `that day's ${formatCount(series.coverage.listedMax)} largest; everything else goes ` +
            `into that day's single \`dust\` aggregate` +
            `${series.coverage.dustDaysMax ? ` — up to ${formatCount(series.coverage.dustDaysMax)} chains on one day` : ''}. ` +
            `The day's totals still include them EXACTLY, so no sum on this page is affected: the most that aggregate ever ` +
            `reached on any single day here is ${compact(series.coverage.dustMax)} ${token}. What is lost is only the ability ` +
            `to name those chains. A chain that has appeared and then drops into the aggregate is drawn at zero rather than ` +
            `as a gap, because that is what it is at this scale — it is not a missing reading.`,
        }),
        el('li', {
          text:
            `WHAT IS MISSING IS A GAP, NOT A ZERO. ${series.coverage.missing === 0 ? 'Every day in this span is present.' : `${formatCount(series.coverage.missing)} of ${formatCount(series.coverage.days)} days are not fetched yet and break the line rather than dropping it to zero.`} ` +
            `Whole past months come from a store that keeps them forever once fetched; ${lastWholeMonth ? `everything after ${lastWholeMonth} ` : 'the current month '}` +
            `is read live on request and cached for thirty minutes, because a store bucketed by calendar month cannot serve a ` +
            `month that has not ended. ` +
            `${pending ? `${pending} is currently in NEITHER: it ended less than an hour ago, which is too recent for the store's settle delay and already outside the live tail — for that one hour the series is a month shorter than it will be, and this sentence is the only trace of it. ` : ''}` +
            `Today itself is never here: a day's value is its close, and today has not closed. ` +
            `What these accounts hold at this minute is on /sovereign/.`,
        }),
        check
          ? el('li', {
              text:
                `THE ARCHIVE AGREES, AND WHERE IT DOES NOT IS ITSELF A FINDING. Over ${check.from} to ${check.to} the 2023 ` +
                `Polkalytics dataset and the \`para\` leg of this series were compared on ${formatCount(check.pairs)} ` +
                `chain-days. Outside the archive's final day: median deviation ${percent(check.body.median * 100, 7)}, ` +
                `largest ABSOLUTE gap ${check.body.maxGap.toFixed(6)} ${token}, and ` +
                `${check.body.beyondQuantum === 0 ? `NOT ONE chain-day` : `${formatCount(check.body.beyondQuantum)} chain-days`} ` +
                `differ${check.body.beyondQuantum === 1 ? 's' : ''} by more than the ${ARCHIVE_QUANTUM} ${token} the file's ` +
                `two decimal places can produce. The verdict is taken on that absolute gap rather than on the percentage, ` +
                `because the percentage is dominated by the smallest balance in the overlap and the two networks' smallest ` +
                `balances are three orders of magnitude apart — the worst relative deviation here is ` +
                `${percent(check.body.max * 100, 3)}, on a chain holding ${compact(check.body.worst[0].archived)} ${token}.` +
                `${check.tail ? ` ON ${check.finalDay} all ${formatCount(check.tail.pairs)} chains disagree, by up to ${percent(check.tail.max * 100, 1)}: that file's captures stop mid-day, so its last row is not a day's close and its published closing figures are mid-day readings.` : ''}`,
            })
          : null,
        check?.assetHub?.pairs
          ? el('li', {
              text:
                `THE 2023 STUDY MEASURED ONE OF THE TWO ACCOUNTS. It read \`para\` on ${NET.relayName} only. On ` +
                `${formatCount(check.assetHub.pairs)} of the ${formatCount(check.pairs)} chain-days in the overlap the ` +
                `same chain also held ${token} in its \`sibl\` account on ${NET.assetHubName} — up to ` +
                `${percent(check.assetHub.maxShare * 100, 2)} of its total at the time. That is why the comparison above ` +
                `is against the relay leg alone, and why the lines are drawn from the sum.`,
            })
          : null,
        retired.length
          ? el('li', {
              text:
                `${retired.length} of the ${series.chains.length} chains here have since LEFT the network: ` +
                `${retired.map((row) => `${row.entry.name} on ${row.entry.retired.on}`).join(', ')}. Their lines are ` +
                `historical and correct, and their sovereign accounts still hold what they hold — but that balance is ` +
                `stranded rather than held, and it will not move again. A chain being absent from this list is weaker than a ` +
                `claim that it is running: the registry came from one audit of the relays' registration storage on ` +
                `2026-08-20 and nothing re-runs it.`,
            })
          : null,
        unnamed.length
          ? el('li', {
              text:
                `${unnamed.length} para id(s) here — ${unnamed.map((c) => c.paraId).sort((a, b) => a - b).join(', ')} — are not in this site's ` +
                `registry at all, so they are drawn as their own identifier rather than as a name. That is the truth about ` +
                `what is known, and printing the reassuring half of an unknown is the failure this page exists to avoid.`,
            })
          : null,
        el('li', {
          text: 'A parachain sovereign account holds the tokens backing what was minted on that parachain via reserve-backed transfer. It is not the whole picture: liquid-staking protocols on Acala, Bifrost and Moonbeam may control more than their sovereign account shows.',
        }),
        el('li', {
          text: 'The original study called these "netflows". Strictly they are balances over time — the term is kept because the study is published under it.',
        }),
        el('li', {
          text: `${token} only. A parachain's sovereign accounts also hold USDC, USDT and every bridged asset; that decomposition is on the /bridged/ page and the two must not be added together.`,
        }),
      ),
    ),

    el(
      'p',
      null,
      document.createTextNode('The same accounts at this minute, with today’s figures: '),
      el('a', { href: '/sovereign/', text: '/sovereign/' }),
      document.createTextNode('. The archived 2023 study and its source code: '),
      el('a', { href: dataset.source.repo, text: dataset.source.repo }),
      document.createTextNode(`. Archive dataset regenerated ${String(dataset.generated).slice(0, 10)} by `),
      el('code', { text: 'npm run data:netflows' }),
      document.createTextNode('.'),
    ),
    el('p', { text: 'Full disclosure carried over from the original report: at the time of writing the author had a contractual relationship with Mangata Finance.' }),
  )
}

/* ══════════════════════════════════════════════════════ the archive's own clipping caveat ═════ */

/**
 * The 2023 dataset resamples, and some of its lines understate their own peak.
 *
 * This used to live only on the Kusama toggle, because Kusama was the archive and nothing else.
 * Now that both networks draw a re-derived series it belongs beside the cross-check on both: a
 * chain whose ARCHIVED line is clipped will disagree with the series above for a reason that is
 * the archive's, not this site's, and saying which is which is the whole point of drawing them
 * together.
 */
function archiveClipNotice(network) {
  const clipped = (network.chains ?? []).filter((chain) => chain.clipped > CLIP_THRESHOLD)
  if (!clipped.length) return null
  return notice(
    'warning',
    `${clipped.length} of the archive's own lines understate their peak`,
    dataset.source.caveats.resampling,
    `Affected in the ${NET.label} archive: ${clipped.map((chain) => `${chain.name} (−${percent(chain.clipped * 100, 1)})`).join(', ')}. ` +
      `That is a limit of the 2023 capture, not of the series above, which reads every UTC day's close.`,
  )
}

renderPage({
  page: pageByKey('netflows'),
  intro:
    `When ${NET.token} moves to a ${NET.label} parachain it is locked in that parachain’s sovereign account and minted on ` +
    `the other side. This is that lock, drawn day by day from ${NET.firstMonth} to yesterday: one line per chain, read from ` +
    `the chains themselves at the close of every UTC day, across both accounts a parachain owns — \`para\` on ` +
    `${NET.relayName} and \`sibl\` on ${NET.assetHubName}. The 2023 Polkalytics study that first measured these accounts is ` +
    `still here, as the independent second reading this series is checked against.`,
  controls: [
    choiceControl({
      label: 'Network',
      param: 'network',
      value: NETWORK,
      options: [
        { value: 'polkadot', label: 'Polkadot · DOT' },
        { value: 'kusama', label: 'Kusama · KSM' },
      ],
      hint: 'Both are read from their own chains, day by day, to yesterday — Polkadot from 2022-01, Kusama from 2021-07, each starting at the first month its Asset Hub has a clock.',
    }),
  ],
  // The shape this page actually lands: the chart, the four tiles under it, then the second
  // chart and the ranking. Naming the right shapes is what stops the page jumping at exactly
  // the moment a reader is looking at it.
  skeleton: ['chart', 'stats', 'chart', 'rows'],
  loadingLabel: 'Reading the daily series',
  load,
  render,
})
