// The DOT whale cohort's daily balance series: what the 1,000 largest DOT accounts held at the
// close of every UTC day since January 2022, on the relay chain and on Asset Hub.
//
// ── what this page is, and the caveat that defines it ────────────────────────────────────────
// The cohort is SEEDED, not enumerated (decision 0021): the accounts were discovered once, from
// Subscan's public holder list, on 2026-08-21, and committed to `src/data/dot-whales.json`. Every
// number drawn here is read from the chains — Subscan's balances were a cross-check and are not
// published. The consequence is survivorship and it is not a detail: this series answers "what
// did TODAY'S whales hold on each past day", so an account that was large in 2023 and exited
// before the seed date is invisible here by construction. The second chart is that caveat made
// visible — in 2022-01 only ~270 of the 1,000 existed anywhere at all.
//
// ── one request, and the rest arrives over a stream ──────────────────────────────────────────
// `asset-hub/whales-series` answers every settled month in ONE response (decision 0020), as
// per-day AGGREGATES — the day's sum, its two legs, how many of the cohort held anything. The
// per-account detail (1,000 rows × ~1,700 days) stays in the store. A page whose request count
// grows with its history is a page that eventually 429s itself against the edge's rate limit, so
// this file makes exactly one `/api` call in steady state and subscribes for what is missing.
//
// ── the three things this page must be loud about ────────────────────────────────────────────
//
//  1. A DAY IS ITS CLOSE. Each value is the state at that UTC day's LAST BLOCK on each chain —
//     two different blocks, because they are two different chains. Reading at 00:00 instead
//     would shift the whole series one day early and read as a genuine lead.
//
//  2. THE SERIES CROSSES TWO CHAINS. Before the Asset Hub Migration (2025-11-04) the relay leg
//     carries essentially the whole cohort; afterwards the Asset Hub leg does. The lead chart
//     draws that handover rather than asserting through it, because a single summed line would
//     hide the largest structural break in the data.
//
//  3. WHAT IS MISSING IS A GAP, NOT A ZERO. A month the store does not hold yet breaks the line;
//     it never draws to zero. "We have not fetched this" and "the whales held nothing" are
//     different claims about the chain and the arithmetic keeps them apart.
//
// ── what is deliberately NOT drawn ───────────────────────────────────────────────────────────
// `top10Planck` is in the payload and there is no concentration line on this page. The reading it
// would produce — 23.5 % of the cohort in the top ten in 2024-06 against 9.4 % in 2026-07 — is
// survivorship-contaminated: measuring 2026's top ten in 2024 is not the same measurement as
// measuring 2024's, and the difference between "real deconcentration" and "an artefact of the
// cohort" has to be settled before either number goes on a page. Research queue O87.
//
// ── the roster, and the hole that USED to be at the top of it ────────────────────────────────
// The cohort's accounts are listed at the foot of the page, each linking through to
// `/account/`. Two things about that list are not guessable from it and are stated on it:
//
//   • THE FIRST COHORT WAS NOT THE LARGEST ACCOUNTS, AND THE MECHANISM THAT CAUGHT IT STAYS.
//     Cohort `2026-08-21` silently lost seed ranks 1–10 — Subscan renders the top ten with medal
//     markup that lacks the rank badge the capture parser keyed on — and was superseded the same
//     day by `2026-08-21-full` (rank derived from row position, cross-checked against the badge).
//     The miss was caught here, by comparing `seedRank` against `rank` and then verifying against
//     the chain: at the old seed's block the Treasury held 24,310,104 DOT, 2.05× that cohort's
//     rank 1, and was absent. The notice below the roster header derives "how many top seed ranks
//     are missing" from the FILE (lowest `seedRank` minus one), so it said "10" then, says
//     nothing now, and will say the right thing about any future re-seed without being edited.
//
//   • A LABEL AND A SYSTEM FLAG ARE DIFFERENT KINDS OF CLAIM. `system` is decoded from the
//     account id's own bytes — `modl`, `sibl`, a global-consensus sovereign — and cannot be wrong
//     about what KIND of account it is. `label` is Subscan's, about WHO operates an address, and
//     this site cannot check it. They are rendered as different things for that reason, and the
//     eight system accounts are marked on every row so that a pallet or a sovereign can never be
//     read off this page as a large individual holder (CLAUDE.md's `modl` rule).

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile, style } from '../../design/dom.js'
import { multiLine, seriesColor } from '../../design/charts.js'
import { read } from '../../core/client.js'
import { followStore } from '../../core/follow.js'
import { shortAddress } from '../../core/codec/ss58.js'
import { compact, formatCount, percent, tokenAmount } from '../../core/format.js'
// The cohort itself — the same file the server reads, bundled rather than fetched. It is an
// INPUT committed to git, not an upstream (decision 0021), so it belongs in the build the way
// `src/data/netflows.json` does on /netflows/. Rule 2 is satisfied without a request being made.
import whales from '../../data/dot-whales.json'

/**
 * The cohort id, which is also its seed date and half of the store identity.
 *
 * This was a bare constant, and its comment argued for staying one: the cohort file is 290 kB of
 * account rows "this page never draws". It draws them now — the roster at the foot of the page is
 * that file — so the argument is gone and the file is imported. What survives is the reason the id
 * is still WRITTEN HERE rather than read out of `whales.cohort`: this constant is the page's own
 * declaration of which set of accounts it is about, and a re-seed is a NEW id beside this one,
 * never an edit to what this one means. Taking the id from the file would make a re-seed silently
 * repoint every sentence on this page at a different set of accounts.
 *
 * Both directions of drift now fail LOUDLY instead. Against the SERVER: the operation's schema
 * declares `oneOf` from the file, so an unknown cohort is a 400 listing the valid ids. Against the
 * BUNDLED FILE: `assertCohortMatches` below compares this id, the seed block, the account count
 * and the seed total against what the server answered, so a deployed server holding a different
 * copy of the file than this bundle cannot quietly draw one cohort's chart above another's roster.
 */
const COHORT = '2026-08-21-full'

const DAY_MS = 86_400_000
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`)
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * Planck (an exact decimal string) to whole tokens, at the DECIMALS THE PAYLOAD CARRIES.
 *
 * Never a module constant. DOT is 10 and KSM is 12, and a series drawn with the other network's
 * divisor is a factor of 100 with a correctly shaped line on a correctly shaped axis — the exact
 * failure `/netflows/` shipped once. `null` stays `null`, because a day we could not summarise and
 * a day the cohort held nothing are different facts.
 */
const units = (raw, decimals) => {
  if (raw === null || raw === undefined) return null
  if (!Number.isInteger(decimals)) throw new Error(`units: decimals must be an integer, got ${decimals}`)
  return Number(BigInt(raw)) / 10 ** decimals
}

/** Every ISO day of a `YYYY-MM`, in order. */
function daysOfMonth(month) {
  const [year, index] = month.split('-').map(Number)
  const days = []
  const end = index === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, index, 1)
  for (let at = Date.UTC(year, index - 1, 1); at < end; at += DAY_MS) days.push(isoDay(at))
  return days
}

const amountOf = (token) => (value) => (value === null ? '—' : `${compact(value)} ${token}`)

/* ═════════════════════════════════════════════════════════════════════════════════ load ═════ */

/**
 * The bundled cohort file and the server's copy of it must be the SAME reading.
 *
 * Both halves of this page now come from `src/data/dot-whales.json` — the charts by way of the
 * server, which reads it to know whose balances to fetch, and the roster straight out of the
 * bundle. Nothing else makes them agree. A deploy that ships a browser bundle built from one
 * commit against a server running another is an ordinary thing to do by accident, and the result
 * would be one cohort's four-year series sitting directly above a different cohort's account list,
 * under one heading, with every figure internally consistent and no request failing. Four fields
 * are compared because any one of them moving means the file moved.
 */
function assertCohortMatches(series) {
  const seedTotal = whales.accounts.reduce((sum, account) => sum + BigInt(account.free) + BigInt(account.reserved), 0n)
  const mismatch = [
    ['cohort id', String(whales.cohort), String(COHORT)],
    ['seed block', String(whales.blockNumber), String(series.seed?.block ?? '')],
    ['account count', String(whales.accounts.length), String(series.accounts ?? '')],
    ['seed total (planck)', seedTotal.toString(), String(series.seed?.cohortPlanck ?? '')],
  ].find(([, mine, theirs]) => mine !== theirs)
  if (!mismatch) return
  const [field, mine, theirs] = mismatch
  throw Object.assign(
    new Error(
      `The account list in this page's bundle and the one the server measured are not the same reading — their ${field} is \`${theirs}\` and this bundle's is \`${mine}\`. The charts and the roster below them would be about different sets of accounts.`,
    ),
    { kind: 'decode' },
  )
}

async function load({ progress }) {
  progress({ stage: 'Reading the stored series', done: 0, total: 1 })

  // ONE request, and it does not grow with history: every settled month arrives in this response,
  // and the months that are not stored yet arrive over the stream below rather than as more GETs.
  const series = await read('asset-hub', 'whales-series', { cohort: COHORT })

  // Three tripwires, all of the same kind: a payload that is not about what this page says it is
  // about must fail loudly rather than be drawn under the wrong label.
  if (series?.cohort !== COHORT) {
    throw Object.assign(
      new Error(`This page asks for whale cohort \`${COHORT}\` and the server answered for \`${series?.cohort}\`. Those are different sets of accounts.`),
      { kind: 'decode' },
    )
  }
  if (!Number.isInteger(series?.decimals) || typeof series?.token !== 'string' || !series.token) {
    throw Object.assign(
      new Error(`The server did not say what token or how many decimals this series is in (got \`${series?.token}\`/${series?.decimals}). Every figure below would be scaled by a guess.`),
      { kind: 'decode' },
    )
  }
  if (series.token !== 'DOT') {
    // The cohort file IS a Polkadot Asset Hub reading — there is no `network` parameter here
    // because the question has one answer. A payload calling it anything else means the identity
    // moved underneath this page, and the survivorship copy, the Migration date and the seed
    // benchmark would all be about a different chain.
    throw Object.assign(
      new Error(`This is a DOT cohort and the server called the token \`${series.token}\`. Nothing below would be about the chain this page names.`),
      { kind: 'decode' },
    )
  }
  assertCohortMatches(series)

  progress({ stage: 'Drawing', done: 1, total: 1 })
  return {
    payload: series,
    // Set by followMissing's onSettled when the subscription ends for any reason other than
    // completion. It flips the gap notice from a promise into a truthful past tense.
    followEnded: null,
  }
}

/* ══════════════════════════════════════════════════════════════════════════════ the shape ═════ */

/**
 * One continuous daily axis out of the months the server answered with.
 *
 * The axis spans the WHOLE settled range — the first month the chains can answer for to the last
 * day of the last settled month — and not merely the part that happens to be stored. A store that
 * holds six months of fifty-five must draw as six months inside a four-year span, because a month
 * nobody has fetched is a hole in a known series rather than the series being short. That is also
 * what makes a gap at the NEWEST end visible, which is the end a reader is most likely looking at.
 */
function buildSeries(payload) {
  const decimals = payload.decimals
  const amount = (raw) => units(raw, decimals)
  const months = payload.months ?? []

  const byDay = new Map()
  const stalled = []
  const inFlight = []
  let completeMonths = 0
  for (const entry of months) {
    if (entry?.coverage?.complete) completeMonths += 1
    if (entry?.job?.state === 'gave-up') stalled.push(entry.month)
    else if (entry?.job) inFlight.push(entry.month)
    for (const day of entry?.days ?? []) if (day?.day) byDay.set(day.day, day)
  }

  const firstMonth = MONTH_RE.test(payload.firstMonth ?? '') ? payload.firstMonth : months[0]?.month ?? null
  const lastMonth = months.length ? months[months.length - 1].month : null
  const days = []
  if (firstMonth && lastMonth) {
    const inLastMonth = daysOfMonth(lastMonth)
    const lastDay = inLastMonth[inLastMonth.length - 1]
    for (let at = dayMs(`${firstMonth}-01`); at <= dayMs(lastDay); at += DAY_MS) days.push(isoDay(at))
  }

  const total = []
  const relay = []
  const assetHub = []
  const nonzero = []
  let latest = null
  let present = 0
  let peak = null
  let peakOn = null
  // The pre-Migration Asset Hub leg, measured rather than described — see the note it feeds.
  let preAhMax = 0
  let preAhShare = 0
  let preAhOn = null

  for (const date of days) {
    const day = byDay.get(date)
    const sum = amount(day?.sumPlanck)
    const relayValue = amount(day?.relayPlanck)
    const ahValue = amount(day?.ahPlanck)
    total.push(sum)
    relay.push(relayValue)
    assetHub.push(ahValue)
    // A count is `null` when the day is not stored and a real 0 when it is: on the first days of
    // this series NONE of the cohort existed anywhere, which is a fact rather than a gap.
    nonzero.push(day?.nonzero === undefined || day?.nonzero === null ? null : Number(day.nonzero))
    if (sum === null) continue
    present += 1
    latest = { date, total: sum, relay: relayValue, assetHub: ahValue, nonzero: day?.nonzero ?? null, header: day }
    if (peak === null || sum > peak) {
      peak = sum
      peakOn = date
    }
    if (payload.migratedOn && date < payload.migratedOn && ahValue !== null && ahValue > preAhMax) {
      preAhMax = ahValue
      preAhShare = sum > 0 ? ahValue / sum : 0
      preAhOn = date
    }
  }

  const firstPresent = days.find((date) => byDay.get(date)?.sumPlanck !== undefined && byDay.get(date)?.sumPlanck !== null) ?? null
  const seen = nonzero.filter((value) => value !== null)

  return {
    days,
    byDay,
    lines: { total, relay, assetHub, nonzero },
    latest,
    peak,
    peakOn,
    firstPresent,
    first: days[0] ?? null,
    last: days.length ? days[days.length - 1] : null,
    nonzeroMax: seen.length ? Math.max(...seen) : null,
    nonzeroFirst: seen.length ? seen[0] : null,
    preMigration: { ah: preAhMax, share: preAhShare, on: preAhOn },
    months,
    coverage: {
      months: months.length,
      complete: completeMonths,
      incomplete: months.length - completeMonths,
      stalled,
      inFlight,
      days: days.length,
      present,
      missing: days.length - present,
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════ render ═════ */

/**
 * The one subscription this page load ever starts, or null. Module-level because `render` runs
 * once per UPDATE rather than once per page: months landing over the stream re-invoke it into the
 * same host, so the guard that stops each re-render opening another `EventSource` has to outlive
 * the render call.
 */
let following = null

function render(host, data) {
  clear(host)
  draw(host, data)
  followMissing(host, data)
}

/**
 * Subscribe for the months the aggregate could not answer, and redraw as each lands.
 *
 * The stream hands over the same envelope the HTTP endpoint answers, so applying one is a keyed
 * replacement into `payload.months` — idempotent, because a reconnecting stream re-delivers and a
 * fallback poll overlaps with it. Either path redraws from `data.payload`, which is what keeps
 * every chart, tile and data note on this page derived from ONE payload.
 */
function followMissing(host, data) {
  if (following !== null) return
  const missing = (data.payload.months ?? []).filter((entry) => !entry?.coverage?.complete).map((entry) => entry.month)
  if (!missing.length) return
  following = followStore({
    source: 'asset-hub',
    operation: 'whales-daily',
    query: { cohort: COHORT, months: missing.join(',') },
    event: 'month',
    poll: async () => {
      const series = await read('asset-hub', 'whales-series', { cohort: COHORT })
      // The same identity gate as `load`. A poll that silently accepted another cohort's answer
      // would redraw this page with somebody else's accounts and nothing would look wrong.
      if (
        series?.cohort !== COHORT ||
        series?.token !== data.payload.token ||
        series?.decimals !== data.payload.decimals ||
        series?.seed?.block !== data.payload.seed?.block
      ) {
        return { complete: false }
      }
      data.payload = series
      render(host, data)
      return { complete: Boolean(series.coverage?.complete) }
    },
    onUpdate: (update) => {
      if (update.kind === 'stalled') {
        // This month's fetch has surrendered; it will not land without a maintainer. Recording
        // the gave-up job on the entry is what lets the notice NAME it — a stalled month left
        // sitting in "in flight" is a promise the page cannot keep.
        const entry = (data.payload.months ?? []).find((month) => month.month === update.data?.params?.month)
        if (!entry || !update.data?.job) return
        entry.job = update.data.job
        render(host, data)
        return
      }
      if (update.kind !== 'event') return
      const envelope = update.data
      const entry = (data.payload.months ?? []).find((month) => month.month === envelope?.params?.month)
      if (!entry || !envelope?.coverage) return
      // The stream carries the month's stored FACTS; this page draws day headers. Reduce it here,
      // exactly as the aggregate endpoint does, so the two paths produce the same rows.
      entry.days = (envelope.data ?? []).map(headerOf)
      entry.coverage = envelope.coverage
      entry.job = envelope.job ?? null
      render(host, data)
    },
    onSettled: (why) => {
      // 'done' and 'complete' need nothing: the last event or poll already redrew a full series.
      // Anything else means the follow gave up with months still missing, and the page must stop
      // claiming it is subscribed.
      if (why === 'done' || why === 'complete') return
      data.followEnded = why
      render(host, data)
    },
  })
}

/**
 * A stored fact reduced to the day header this page draws — the same reduction the aggregate
 * endpoint performs server-side, applied to the envelopes that arrive over the stream.
 *
 * `null`, never `0`, for anything the fact does not carry: a day written by an older code version
 * has no aggregate at all, and drawing it as zero would say the whales held nothing.
 */
function headerOf(fact) {
  const payload = fact?.payload ?? {}
  const aggregate = payload.aggregate ?? {}
  const value = (name) => (aggregate[name] === undefined ? null : aggregate[name])
  return {
    day: payload.date ?? fact?.segment ?? null,
    relayBlock: payload.relay?.block ?? null,
    assetHubBlock: payload.assetHub?.block ?? null,
    sumPlanck: value('sumPlanck'),
    relayPlanck: value('relayPlanck'),
    ahPlanck: value('ahPlanck'),
    nonzero: value('nonzero'),
    top10Planck: value('top10Planck'),
  }
}

function draw(host, data) {
  const { payload, followEnded } = data
  const series = buildSeries(payload)
  const token = payload.token
  const format = amountOf(token)

  if (!series.days.length || series.coverage.present === 0) {
    return append(
      host,
      notice(
        'warning',
        'Nothing is stored yet for this cohort, and the fetch has just been started',
        'This page is drawn from a store that fills on demand: this request is what started the fetch. Each month is read one UTC day at a time from two public RPCs, so a cold store fills over minutes rather than seconds. The page stays subscribed and draws each month the moment it lands — no reload needed.',
        payload.coverage?.note ?? '',
      ),
      // The roster does not depend on the store at all — it is the seed reading, in the bundle —
      // so a cold store still has something true to show while it fills.
      cohortCard(payload),
      notes(series, payload),
    )
  }

  append(
    host,
    // The chart first, and deliberately first: a page has one subject (decision 0011) and on this
    // page the subject is the series and the handover inside it.
    legsCard(series, payload),
    statRow([
      statTile('The cohort', formatCount(payload.accounts ?? 0), `accounts, fixed on ${payload.cohort}`),
      statTile('Held on the last day drawn', format(series.latest?.total ?? null), series.latest ? `at the close of ${series.latest.date}` : 'nothing stored yet'),
      seedTile(series, payload, format),
      statTile(
        'Months stored',
        `${formatCount(series.coverage.complete)} of ${formatCount(series.coverage.months)}`,
        `${formatCount(series.coverage.present)} of ${formatCount(series.coverage.days)} days drawn`,
      ),
    ]),
    series.coverage.missing > 0 ? gapNotice(series, payload, followEnded) : null,
    survivorshipCard(series, payload),
    monthTable(series, payload),
    // Last of the content sections, and directly above the data notes on purpose: the notes open
    // with where the account list came from and who is attributed for it, so the roster's
    // provenance is the next thing a reader meets after the roster.
    cohortCard(payload),
    notes(series, payload),
  )
}

/**
 * Latest against the seed's own reading — the one number on this page that is a comparison rather
 * than a measurement, and it is not quite like-for-like, which the sub-line says.
 */
function seedTile(series, payload, format) {
  const benchmark = units(payload.seed?.cohortPlanck, payload.decimals)
  if (benchmark === null || !series.latest) {
    return statTile('Against the seed reading', '—', 'the seed benchmark or the latest day is missing')
  }
  const ratio = benchmark > 0 ? series.latest.total / benchmark : null
  return statTile(
    'Against the seed reading',
    ratio === null ? '—' : percent(ratio * 100, 1),
    `of the ${compact(benchmark)} ${payload.token} the same accounts held at Asset Hub #${formatCount(payload.seed?.block ?? 0)}`,
  )
}

/* ══════════════════════════════════════════════════════════════════════════ the charts ═════ */

/**
 * The lead chart: the cohort's daily holding, split by which chain it is on.
 *
 * Three lines on ONE axis, which is the only honest way to draw this. The two legs are the same
 * DOT counted in two different places and they sum to the total, so the handover on 2025-11-04 is
 * visible as one line falling to the floor while the other rises to meet the total — the money
 * moved rather than doubled. A single summed line would be smooth across the largest structural
 * break in the data, and a second y-axis for the small leg would invent a comparison that is not
 * in the numbers.
 */
function legsCard(series, payload) {
  const token = payload.token
  const drawn = [
    { label: 'Total held', values: series.lines.total, last: series.latest?.total ?? null },
    { label: 'On the relay chain', values: series.lines.relay, last: series.latest?.relay ?? null },
    { label: 'On Asset Hub', values: series.lines.assetHub, last: series.latest?.assetHub ?? null },
  ]

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: `${token} held by the cohort, ${series.first} → ${series.last}` }),
      el('p.note', {
        text:
          `Every account in the cohort, summed, at the close of each UTC day — and the same total split by which chain it is ` +
          `actually on. Until the Asset Hub Migration on ${payload.migratedOn} a holder's ${token} was on the relay chain; ` +
          `afterwards it is on Asset Hub. The two legs sum to the total on every day, so the crossing is the handover itself ` +
          `rather than a change in what anyone holds — and the total line runs exactly underneath whichever leg is carrying the ` +
          `money, which is what "they sum" looks like when it is drawn. Anywhere it separates from both, something is ` +
          `unaccounted for.` +
          (series.coverage.missing ? ' A break in a line is one of the days this site has not fetched yet, never a zero.' : ''),
      }),
    ),
  )

  const legend = el('ul.legend')
  drawn.forEach((line, i) => {
    append(
      legend,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(i)}` }),
        document.createTextNode(`${line.label} `),
        // The value, not just the name: three of the eight light-mode hues sit under 3:1 contrast,
        // so colour never carries meaning alone on this site.
        el('span.amt', { text: line.last === null ? '—' : compact(line.last) }),
      ),
    )
  })

  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: drawn.map((line) => ({ label: line.label, values: line.values })),
      format: compact,
      height: 380,
    }),
  )

  if (series.latest) {
    append(
      card,
      el('p.note', {
        text:
          `The last day drawn, ${series.latest.date}, was read at relay #${formatCount(series.latest.header?.relayBlock ?? 0)} and ` +
          `Asset Hub #${formatCount(series.latest.header?.assetHubBlock ?? 0)} — two blocks, because they are two chains. The peak ` +
          `anywhere in this span is ${compact(series.peak)} ${token}, on ${series.peakOn}.`,
      }),
    )
  }
  return card
}

/**
 * The survivorship caveat, drawn.
 *
 * This chart exists because the sentence "the cohort is 2026's whales" is easy to read past and
 * impossible to un-see once it is a line: the count of accounts holding anything at all climbs
 * from a couple of hundred to the full cohort over four years. Every early number on the chart
 * above is a number about however many of them existed at the time, and this says how many.
 */
function survivorshipCard(series, payload) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'How many of the cohort existed at all' }),
      el('p.note', {
        text:
          `Of the ${formatCount(payload.accounts ?? 0)} accounts in the cohort, how many held anything on either chain at that ` +
          `day's close. The cohort was fixed on ${payload.cohort}, so this line is the survivorship caveat rather than a ` +
          `measurement of the past: an account that had not been created yet is counted here as absent, and an account that was ` +
          `large in 2023 and closed before ${payload.cohort} is not in this chart at all. A zero on the left is real — none of ` +
          `today's whales existed then — and it is not the same as a gap.`,
      }),
    ),
  )

  const legend = el(
    'ul.legend',
    null,
    el(
      'li',
      null,
      el('span.swatch', { style: `background:${seriesColor(0)}` }),
      document.createTextNode('Accounts holding anything '),
      el('span.amt', { text: series.latest?.nonzero === null || series.latest?.nonzero === undefined ? '—' : formatCount(series.latest.nonzero) }),
    ),
  )

  const plot = el('div.plot')
  append(card, legend, plot)
  queueMicrotask(() =>
    multiLine(plot, {
      days: series.days,
      series: [{ label: 'Accounts holding anything', values: series.lines.nonzero }],
      format: (value) => formatCount(Math.round(value)),
      height: 260,
    }),
  )

  if (series.nonzeroFirst !== null) {
    append(
      card,
      el('p.note', {
        text:
          `On the first day this series can answer for, ${series.firstPresent}, ${formatCount(series.nonzeroFirst)} of the ` +
          `${formatCount(payload.accounts ?? 0)} held anything anywhere. The most on any day drawn is ` +
          `${formatCount(series.nonzeroMax ?? 0)}.`,
      }),
    )
  }
  return card
}

/**
 * The table view for both charts above, one row per month.
 *
 * Every chart on this site has a table, and this is theirs — per MONTH rather than per day
 * because seventeen hundred rows is a download rather than a fallback. Each row is that month's
 * last drawn day, so a partly-fetched month reports the day it actually reaches.
 */
function monthTable(series, payload) {
  const token = payload.token
  const body = el('tbody')

  for (const entry of series.months) {
    const days = daysOfMonth(entry.month)
    const drawn = days.filter((date) => series.byDay.get(date)?.sumPlanck !== undefined && series.byDay.get(date)?.sumPlanck !== null)
    const lastDrawn = drawn.length ? series.byDay.get(drawn[drawn.length - 1]) : null
    const state = entry.job?.state === 'gave-up' ? 'gave up' : entry.coverage?.complete ? 'stored' : entry.job ? `fetching (${entry.job.state})` : 'not stored'
    append(
      body,
      el(
        'tr',
        null,
        el('td.mono', { text: entry.month }),
        el('td', { text: state }),
        el('td.num', { text: `${formatCount(drawn.length)} / ${formatCount(days.length)}` }),
        el('td.mono', { text: lastDrawn?.day ?? '—' }),
        el('td.num', { text: lastDrawn ? compact(units(lastDrawn.sumPlanck, payload.decimals)) : '—' }),
        el('td.num', { text: lastDrawn ? compact(units(lastDrawn.relayPlanck, payload.decimals)) : '—' }),
        el('td.num', { text: lastDrawn ? compact(units(lastDrawn.ahPlanck, payload.decimals)) : '—' }),
        el('td.num', { text: lastDrawn?.nonzero === null || lastDrawn?.nonzero === undefined ? '—' : formatCount(lastDrawn.nonzero) }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Every month, as numbers' }),
      el('p.note', {
        text:
          `The table view of both charts, and the coverage report for the store behind them. Each row reports that month's LAST ` +
          `drawn day, so a month still being fetched shows how far it has got rather than a figure for a day nobody has read.`,
      }),
    ),
    el(
      'details.data-table',
      null,
      el('summary', { text: `All ${formatCount(series.months.length)} settled months, with what is stored for each` }),
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
              el('th', { text: 'Month' }),
              el('th', { text: 'Store' }),
              el('th.num', { text: 'Days drawn' }),
              el('th', { text: 'Last drawn' }),
              el('th.num', { text: `Total (${token})` }),
              el('th.num', { text: 'Relay leg' }),
              el('th.num', { text: 'Asset Hub leg' }),
              el('th.num', { text: 'Accounts' }),
            ),
          ),
          body,
        ),
      ),
    ),
  )
}

/* ═════════════════════════════════════════════════════════════════════════════ the roster ═════ */

/**
 * What KIND of account a row is — and, just as important, on whose authority.
 *
 * Two different claims live in the cohort file and they must not render as one badge:
 *
 *   STRUCTURAL (`system`) is decoded from the account id's own bytes. `modl` is a pallet's own
 *   account — a treasury, a bounty, a nomination pool, an XCM channel — and `sibl`/`para` and the
 *   global-consensus form are sovereign accounts of other chains. This cannot be wrong about what
 *   kind of account it is, and it is the reason the tone is `warning` rather than `muted`: the
 *   pill is not hedging, it is saying "whatever else you conclude, THIS IS NOT A PERSON".
 *
 *   THIRD-PARTY (`label`) is Subscan's claim about who operates an address, and this site has no
 *   way to check it. Custodial roles are picked out by Subscan's own `(hot_wallet)`/`(user_wallet)`
 *   convention rather than by a hand-kept list of exchange names, so the marker fails by going
 *   quiet on an unfamiliar venue rather than by guessing. Tone `muted`, which on this site means
 *   exactly "we cannot tell", and the question mark is in the word.
 *
 * The pill's TEXT always carries the meaning. Three of the light-mode hues sit under 3:1 contrast,
 * so nothing on this site is allowed to mean something by its colour alone.
 */
const CUSTODIAL_RE = /\((?:hot|cold|warm|user|deposit|withdraw)[\s_-]?wallet\)/i
const PROXY_RE = /\b(?:proxy|staker)\b/i

function kindOf(account) {
  const label = account.label ?? ''
  if (account.system === 'modl') {
    return { text: 'pallet', tone: 'warning', title: 'A pallet’s own account, decoded from the account id (modl…). Nobody holds the key; the runtime does.' }
  }
  if (account.system === 'sibl' || account.system === 'para' || account.system === 'sovereign') {
    return { text: 'sovereign', tone: 'warning', title: 'Another chain’s sovereign account here, decoded from the account id. It holds that chain’s users’ DOT, not one holder’s.' }
  }
  if (CUSTODIAL_RE.test(label)) {
    return { text: 'custodial?', tone: 'muted', title: 'Subscan labels this a custody wallet, so the balance is many people’s. This site cannot verify the label.' }
  }
  if (PROXY_RE.test(label)) {
    return { text: 'protocol?', tone: 'muted', title: 'Subscan labels this a protocol proxy, so the balance is many people’s. This site cannot verify the label.' }
  }
  return null
}

/** `/account/?address=…`, built the way `/account/`'s own hop links are, so the escaping matches. */
function accountHref(address) {
  const query = new URLSearchParams()
  query.set('address', address)
  return `/account/?${query}`
}

/**
 * The roster is built ONCE per page load and re-attached on every redraw.
 *
 * `render` runs once per UPDATE, not once per page: this page stays subscribed and redraws as each
 * missing month lands, which on a cold store is fifty-five times. The charts and the month table
 * genuinely change on each of those; a thousand rows of a file that is pinned to a block do not. Building
 * ~9,000 nodes per landing month would be the page's dominant cost for the entire fill, spent
 * producing the identical DOM. `clear(host)` only detaches the node — appending it again moves it
 * back — so the cache is a plain reference, keyed by the divisor in case it ever moved.
 */
let roster = null

function cohortCard(payload) {
  // ⚠️ THE DIVISOR, and where it comes from. Not a constant in this file and not a field of the
  // cohort file: it is the `decimals` the SERVER declared for this series, which `load` has
  // already tripwired to be an integer and to belong to a payload calling its token DOT. The
  // roster's planck strings and the charts' planck strings are then divided by the same thing —
  // which is what makes the roster's total and the seed tile above it comparable at all. KSM is 12
  // and DOT is 10, and the wrong one is a factor of 100 that renders perfectly on a plausible
  // axis; `/netflows/` shipped exactly that once.
  const decimals = payload.decimals
  if (roster?.decimals === decimals) return roster.node

  const amount = (planck) => units(planck, decimals)
  const cohortTotal = whales.accounts.reduce((sum, account) => sum + BigInt(account.free) + BigInt(account.reserved), 0n)
  const cohortDot = amount(cohortTotal.toString())

  const body = el('tbody')
  for (const account of whales.accounts) {
    const held = amount((BigInt(account.free) + BigInt(account.reserved)).toString())
    const kind = kindOf(account)
    append(
      body,
      el(
        'tr',
        null,
        el('td.num', { text: formatCount(account.rank) }),
        el(
          'td.mono',
          null,
          // The full address is in the href — copyable as a link, and what `/account/` receives —
          // while the cell shows the middle-truncated form. The tail is kept because it is what
          // disambiguates two addresses that share a prefix, which on one network most do.
          el('a', { href: accountHref(account.address), text: shortAddress(account.address, 8), title: account.address }),
        ),
        el('td', null, kind ? el('span.pill', { text: kind.text, data: { tone: kind.tone }, title: kind.title }) : null),
        el('td', { text: account.label ?? '—', title: account.label ? 'Subscan’s label for this address. Not verified here.' : 'No label on the seed list' }),
        el('td.num', { text: tokenAmount(amount(account.free)) }),
        el('td.num', { text: tokenAmount(amount(account.reserved)) }),
        el('td.num', { text: tokenAmount(held) }),
        el('td.num', { text: percent(cohortDot > 0 ? (held / cohortDot) * 100 : 0, 3) }),
      ),
    )
  }

  const node = el(
    // An id, so the roster can be linked to directly: /whales/#cohort.
    'section.card',
    { id: 'cohort' },
    el(
      'header',
      null,
      el('h2', { text: 'Every account in the cohort' }),
      el('p.note', {
        text:
          `All ${formatCount(whales.accounts.length)} accounts, ranked by what the chain said they held when the cohort was fixed: ` +
          `Asset Hub #${formatCount(whales.blockNumber)}, ${whales.readAt.slice(0, 10)}. Every row links through to that account's own ` +
          `page. These are the balances the ranking was MADE from and they are a dated snapshot — nothing in this table has been ` +
          `re-read since, and it is the charts above, not this list, that move.`,
      }),
    ),
    seedShortfallNote(),
    el('p.note', {
      text:
        `Eight of these accounts are not holders at all and are marked on their row: a "pallet" is the runtime's own account — a ` +
        `treasury, a bounty, a nomination pool — and a "sovereign" is another chain holding its users' ${payload.token} here. Those two ` +
        `are decoded from the account id itself and cannot be wrong. "custodial?" and "protocol?" are a different kind of claim ` +
        `entirely: they come from the seed list's label, they mean the balance is many people's rather than one, and this site has no ` +
        `way to check them. Where the list and its labels came from, and who is attributed for them, is in the data notes directly below.`,
    }),
    el('p.note', {
      text:
        `Following the money from here is a RECENT-WINDOW view, not this page's four years. The account screen answers from a window ` +
        `of the last few days on each upstream it reads, so it will show what an address has been doing lately rather than the history ` +
        `drawn above. Widening it is an open question in this project's research queue.`,
    }),
    el(
      // Open by default. The rows are built either way — a closed `details` hides its content, it
      // does not skip building it — so collapsing would cost the same and hide the thing that was
      // asked for. What the disclosure buys is the ability to fold a thousand rows away again, and the
      // 28rem scroller under it means the roster costs about a screen until someone wants more.
      'details.data-table',
      { open: true },
      el('summary', { text: `All ${formatCount(whales.accounts.length)} accounts, largest first` }),
      el(
        // `.tablewrap` is the design system's own horizontal scroller and `.scroll-y` caps the
        // height; `table.data th` is sticky, so the header stays put inside it. Note that
        // `.scroll-y` turns on horizontal clipping too — that is fine HERE, because this element
        // is deliberately a scroller in both axes, and it is why the overflow check for this
        // section has to measure a ROW rather than the document.
        'div.tablewrap.scroll-y',
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
              el('th.num', { text: 'Rank' }),
              el('th', { text: 'Account' }),
              el('th', { text: 'Kind' }),
              el('th', { text: 'Label' }),
              el('th.num', { text: `Free (${payload.token})` }),
              el('th.num', { text: 'Reserved' }),
              el('th.num', { text: 'Held' }),
              el('th.num', { text: 'Of cohort' }),
            ),
          ),
          body,
        ),
      ),
    ),
    el('p.note', {
      text:
        `${compact(cohortDot)} ${payload.token} across the ${formatCount(whales.accounts.length)} rows, which is ` +
        `${percent((cohortDot / units(whales.totalIssuancePlanck, decimals)) * 100, 2)} of ${payload.token}'s total issuance at that ` +
        `block. Held is free plus reserved; reserved is DOT the account cannot move — staked, bonded to a deposit, or locked by ` +
        `governance — and on several of the largest rows it is nearly the whole balance.`,
    }),
  )

  roster = { decimals, node }
  return node
}

/**
 * The hole at the top of the list, stated on the page rather than in a commit message.
 *
 * The count is DERIVED from the file — the lowest seed rank present, minus one — so it cannot go
 * stale against a re-seed that loses a different number of rows, and it disappears by itself if a
 * re-seed loses none. The Treasury figure beside it is the part that made this a fact rather than
 * an inference about a field nothing documents: it is a live read, at the block the file pins, of
 * an account that outranks the entire cohort and is absent from it.
 */
function seedShortfallNote() {
  const lowestSeedRank = whales.accounts.reduce((low, account) => Math.min(low, account.seedRank ?? Infinity), Infinity)
  if (!Number.isFinite(lowestSeedRank) || lowestSeedRank <= 1) return null
  const lost = lowestSeedRank - 1
  return notice(
    'warning',
    `This is not the ${formatCount(whales.accounts.length)} largest accounts on the chain — the top ${formatCount(lost)} are missing`,
    `The cohort was seeded from a public holder list and ${formatCount(lost)} rows were lost while it was being read. They came off the ` +
      `TOP: the seed ranks that survived run ${formatCount(lowestSeedRank)} to ${formatCount(lowestSeedRank + whales.accounts.length - 1)} ` +
      `with no gaps in between, so every account the list ranked above rank ${formatCount(lowestSeedRank)} is absent. The cohort was ` +
      `deliberately left as it is rather than topped up from a second block height, because mixing two readings would be a worse fault ` +
      `than a stated one.`,
    `Everything on this page is therefore an honest answer to "what did THESE ${formatCount(whales.accounts.length)} accounts do" ` +
      `and is not an answer to "what did the biggest holders do".`,
  )
}

/* ------------------------------------------------------------------------- the caveats ---- */

function gapNotice(series, payload, followEnded) {
  const { coverage } = series
  const stalled = coverage.stalled
  return notice(
    'warning',
    `${formatCount(coverage.missing)} of the ${formatCount(coverage.days)} days in this span are not drawn`,
    'This series is served from a store that fills on demand, one calendar month per fetch — reading this page is what starts the missing ones. A day that has not been fetched is a break in the line, never a zero: the chart says nothing at all about it rather than saying the cohort held nothing.',
    `${formatCount(coverage.complete)} of ${formatCount(coverage.months)} months are fully stored` +
      (coverage.inFlight.length ? `, and ${formatCount(coverage.inFlight.length)} fetch${coverage.inFlight.length === 1 ? ' is' : 'es are'} in flight` : '') +
      '. ' +
      (stalled.length
        ? `${formatCount(stalled.length)} month${stalled.length === 1 ? "'s fetch has" : "s' fetches have"} surrendered after repeated failures and will NOT land without a maintainer — ${stalled.join(', ')}. ${stalled.length === 1 ? 'That gap' : 'Those gaps'} will outlive this visit. `
        : '') +
      (followEnded
        ? 'The live subscription this page opened has ended with months still missing — reload to continue the fill.'
        : coverage.incomplete
          ? 'This page stays subscribed and draws each month the moment it lands — no reload needed.'
          : 'Reloading this page continues the fill.'),
  )
}

/* ═══════════════════════════════════════════════════════════════════════════════ notes ═════ */

const wrapAnywhere = (node) => (node ? style(node, 'overflow-wrap:anywhere') : node)

/**
 * The data notes, generated from the same payload the charts are drawn from — rule 3.
 *
 * Three sources feed it and they are kept apart on purpose: the server's own `notes[]` and
 * `coverage.note`, which describe the reading; the seed block, which describes where the account
 * list came from and carries the attribution decision 0021 requires; and the page-level caveats
 * below, which are things the payload's numbers IMPLY but cannot say about themselves.
 */
function notes(series, payload) {
  const token = payload.token
  const seed = payload.seed ?? {}
  const benchmark = units(seed.cohortPlanck, payload.decimals)

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),

    el('h3', { text: 'Where the account list came from' }),
    wrapAnywhere(
      el('p', {
        text:
          `The ${formatCount(payload.accounts ?? 0)} accounts were DISCOVERED once, by a human, on ${seed.readAt ? seed.readAt.slice(0, 10) : payload.cohort}, and committed to this ` +
          `repository with their provenance on them. ${seed.source ?? ''} They are not re-read: the seed could vanish tomorrow and ` +
          `nothing here would break or notice. What those accounts HOLD is read from the chains, and it is the only thing this ` +
          `page publishes.`,
      }),
    ),
    benchmark === null
      ? null
      : el('p', {
          text:
            `The benchmark in the tiles above is the seed's own reading: ${compact(benchmark)} ${token} across the same accounts at ` +
            `Asset Hub #${formatCount(seed.block ?? 0)}. It is not quite like-for-like with a day on the chart — it is one pinned ` +
            `mid-day block on ONE chain, where a day here is both chains at their own close — so a small difference on the seed date ` +
            `itself is the two readings' definitions, not a movement.`,
        }),

    el('h3', { text: 'What this measures' }),
    wrapAnywhere(el('ul', null, ...(payload.notes ?? []).map((text) => el('li', { text })))),

    el('h3', { text: 'What the numbers do not say about themselves' }),
    wrapAnywhere(
      el(
        'ul',
        null,
        el('li', {
          text:
            `THE ASSET HUB LEG BEFORE ${payload.migratedOn} IS ACCOUNT EXISTENCE, NOT ACTIVITY. An account on Asset Hub existed ` +
            `then mostly because something had put at least one existential deposit there — at the close of 2024-06-30, 550 of the ` +
            `${formatCount(payload.accounts ?? 0)} held exactly 0.01 ${token} (one existential deposit) on Asset Hub and nothing ` +
            `more, so that day's whole Asset Hub leg of 2,152.67 ${token} is essentially 550 × ED against 588,222,171 ${token} on ` +
            `the relay (verified 2026-08-21 from the per-account detail, which this endpoint deliberately does not ship). ` +
            (series.preMigration.on
              ? `On the days drawn here the Asset Hub leg never exceeds ${compact(series.preMigration.ah)} ${token} before that date — ` +
                `${percent(series.preMigration.share * 100, 4)} of the cohort's holding, on ${series.preMigration.on}. `
              : '') +
            `Reading that line as "the whales were already on Asset Hub" is the mistake it is drawn to prevent.`,
        }),
        el('li', {
          text:
            `THE COHORT IS TODAY'S, SO THE PAST IS SURVIVORSHIP. Every figure before ${payload.cohort} is about however many of ` +
            `these accounts existed at the time` +
            (series.nonzeroFirst === null
              ? ''
              : ` — ${formatCount(series.nonzeroFirst)} of ${formatCount(payload.accounts ?? 0)} on ${series.firstPresent}`) +
            `, and says nothing about holders who were large then and gone before the seed. ` +
            (series.coverage.present ? 'The second chart draws that count for exactly this reason. ' : '') +
            `A future re-seed is a NEW cohort beside this one, never an edit to this one.`,
        }),
        el('li', {
          text:
            `THERE IS NO CONCENTRATION LINE, AND THAT IS DELIBERATE. The payload carries each day's top-ten sum and this page does ` +
            `not draw it: the top ten OF THIS COHORT in 2024 is not the top ten that existed in 2024, so a falling concentration ` +
            `curve cannot be told apart from the cohort's own composition drifting backwards through time. It is an open question ` +
            `in this project's research queue, and an unsettled measurement is worse on a page than a missing one.`,
        }),
        el('li', {
          text:
            `A DAY IS ITS CLOSE, AND TODAY IS NEVER HERE. Each value is that UTC day's last block on each chain, so a balance that ` +
            `rose and fell back inside one day leaves no trace, and the newest day this page can draw is the last day of the last ` +
            `SETTLED month. ` +
            (payload.coverage?.pending
              ? `${payload.coverage.pending} is currently in neither the store nor this chart: it ended less than an hour ago, which is too recent for the store's settle delay. For that one hour the series is a month shorter than it will be, and this sentence is the only trace of it. `
              : '') +
            `Whole past months come from a store that keeps them forever once fetched — immutable data is fetched once and never ` +
            `again.`,
        }),
      ),
    ),

    el('h3', { text: 'What is stored right now' }),
    el('p', { text: payload.coverage?.note ?? '' }),
    el('p', {
      text:
        `${formatCount(series.coverage.present)} of ${formatCount(series.coverage.days)} days are drawn, across ` +
        `${formatCount(series.coverage.months)} settled months from ${payload.firstMonth}. ` +
        (payload.stream
          ? `The months that are not stored are being fetched, and this page is subscribed to ${payload.stream} for them.`
          : 'Every settled month is stored, so this page made exactly one request and will make no more.'),
    }),

    el(
      'p',
      null,
      document.createTextNode('The same two chains, measured for parachain sovereign accounts instead of holders: '),
      el('a', { href: '/netflows/', text: '/netflows/' }),
      document.createTextNode('. What those accounts hold at this minute: '),
      el('a', { href: '/sovereign/', text: '/sovereign/' }),
      document.createTextNode('.'),
    ),
  )
}

renderPage({
  page: pageByKey('whales'),
  intro:
    `The ${formatCount(whales.accounts.length)} largest DOT accounts on Polkadot Asset Hub as they stood on ` +
    `${(whales.readAt ?? '').slice(0, 10)}, read backwards through every UTC day since January 2022, on both chains they can ` +
    `hold DOT on. The list is fixed and dated: this is what TODAY’s whales held in the past, not who was large at the time. ` +
    `Every account is listed at the foot of the page, each linking through to its own activity.`,
  // The shape the page actually lands, so the layout is reserved and nothing jumps when the data
  // arrives: the lead chart, the tiles under it, the survivorship chart, then the two tables.
  skeleton: ['chart', 'stats', 'chart', 'table', 'table'],
  loadingLabel: 'Reading the stored series',
  load,
  render,
})
