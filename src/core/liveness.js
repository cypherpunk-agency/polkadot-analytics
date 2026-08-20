// The liveness assertion. One shape, asserted by every source module, rendered on every page.
//
// ── why this file exists ─────────────────────────────────────────────────────────────────
// In one day of research three of our upstreams misbehaved in three different ways, and only
// one of them looked like an error:
//
//   · Subscan started returning 403. Loud. We noticed within a minute.
//   · The Bulletin devnet went unreachable for several minutes. Loud, and ordinary.
//   · The SQD `hydradx` squid answered every query, in 381 ms, with 1.57 MB of perfectly
//     well-formed rows — and had not advanced a block in 103 days.
//
// The third is the one this contract is for. A frozen index is indistinguishable from a live
// one at the transport layer: it is fast, it is complete, it is correctly shaped, and every
// chart drawn from it renders beautifully and is a picture of May. Nothing in `ApiError` can
// catch it, because nothing failed.
//
// So each source answers a second question next to its data — "when did this upstream last
// have something new, and does the payload I just built reach that far" — and the page says
// the answer out loud. That is rule 3 of this repo applied to time rather than to value.
//
// ── what a source asserts ────────────────────────────────────────────────────────────────
// A source module builds one of these per payload with `liveness(...)` and puts it on the
// payload as `meta.liveness` (one upstream) or `meta.liveness = [...]` (several). The page
// hands it to `livenessNotes()` from src/design/liveness.js and it lands in data-notes.
//
// This module is imported by BOTH runtimes: pure functions over plain values, no DOM, no Node
// built-ins. Same reason everything else in src/core/ is.

/**
 * @typedef {'live'|'stale'|'frozen'|'unreachable'|'unknown'} LivenessState
 *
 * live         the upstream answered and its head is inside `staleAfterMs`
 * stale        the upstream answered, but its head is older than `staleAfterMs`
 * frozen       the upstream answered, and its head is older than `frozenAfterMs` — the SQD
 *              case. Separated from `stale` because they need different sentences: stale is
 *              "the indexer is behind", frozen is "stop building on this".
 * unreachable  the upstream did not answer. Not automatically an error — the Bulletin devnet
 *              is a single node and being down is one of its ordinary states.
 * unknown      the upstream answered but exposes nothing we can read a head from. Honest
 *              third state; NOT collapsed into `live`, which would be the whole bug again.
 */

/**
 * @typedef {object} LivenessReport
 * @property {string} source          source id, matching the key in server/sources/index.mjs
 * @property {string} label           the upstream's human name, as it appears at /api
 * @property {LivenessState} state
 * @property {number} observedAt      ms epoch — when WE asked. Always present.
 * @property {number|null} headAt     ms epoch of the newest datum the upstream admits to, or
 *                                    null when it does not say.
 * @property {string|null} head       what "head" IS in the upstream's own terms: `block
 *                                    12,344,549`, `2026-08-18`, `finalized #28,493,862`.
 *                                    Prose for a reader, never parsed.
 * @property {number|null} lagMs      observedAt - headAt, or null when headAt is null.
 * @property {number} staleAfterMs    lag past which this upstream is called stale
 * @property {number} frozenAfterMs   lag past which this upstream is called frozen
 * @property {{from: string|null, to: string|null}|null} covers
 *                                    the window the payload actually covers, in the units the
 *                                    page shows. Separate from the head: an upstream can be
 *                                    live while the payload in front of you stops three days
 *                                    short, and a reader needs both facts.
 * @property {string|null} note       one sentence naming what is wrong, when something is.
 */

export const LIVENESS_STATES = /** @type {const} */ (['live', 'stale', 'frozen', 'unreachable', 'unknown'])

/**
 * Defaults chosen to be WRONG IN THE SAFE DIRECTION for a general upstream: a chain producing
 * blocks every six seconds is stale long before fifteen minutes, and a source that knows that
 * passes its own thresholds. What these defaults must never do is call a dead thing live.
 */
export const DEFAULT_STALE_AFTER_MS = 15 * 60_000
export const DEFAULT_FROZEN_AFTER_MS = 24 * 60 * 60_000

/** Clock skew we will tolerate before saying so. Indexers do stamp rows in the future. */
const SKEW_TOLERANCE_MS = 5 * 60_000

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * Build a liveness assertion. Throws rather than returning a plausible-looking object, for the
 * same reason `decodeAssetDetails` throws: a malformed assertion renders as a confident green
 * pill, which is worse than no pill at all.
 *
 * @param {object} spec
 * @param {string} spec.source
 * @param {string} spec.label
 * @param {number} [spec.observedAt]      ms epoch; defaults to now
 * @param {number|null} [spec.headAt]     ms epoch of the upstream's newest datum
 * @param {string|null} [spec.head]       the same head in the upstream's own words
 * @param {boolean} [spec.reachable]      false when the upstream did not answer at all
 * @param {{from?: string|null, to?: string|null}|null} [spec.covers]
 * @param {number} [spec.staleAfterMs]
 * @param {number} [spec.frozenAfterMs]
 * @param {string|null} [spec.note]       overrides the generated sentence
 * @returns {LivenessReport}
 */
export function liveness({
  source,
  label,
  observedAt = Date.now(),
  headAt = null,
  head = null,
  reachable = true,
  covers = null,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  frozenAfterMs = DEFAULT_FROZEN_AFTER_MS,
  note = null,
} = {}) {
  if (typeof source !== 'string' || !source) throw new Error('liveness: `source` must be the source id')
  if (typeof label !== 'string' || !label) throw new Error('liveness: `label` must be the upstream name')
  if (!isFiniteNumber(observedAt)) throw new Error('liveness: `observedAt` must be a millisecond timestamp')
  if (headAt !== null && !isFiniteNumber(headAt)) throw new Error('liveness: `headAt` must be a millisecond timestamp or null')
  if (!isFiniteNumber(staleAfterMs) || staleAfterMs <= 0) throw new Error('liveness: `staleAfterMs` must be positive')
  if (!isFiniteNumber(frozenAfterMs) || frozenAfterMs <= 0) throw new Error('liveness: `frozenAfterMs` must be positive')
  if (frozenAfterMs < staleAfterMs) throw new Error('liveness: `frozenAfterMs` must not be smaller than `staleAfterMs`')

  const lagMs = headAt === null ? null : observedAt - headAt
  let skew = null
  if (lagMs !== null && lagMs < -SKEW_TOLERANCE_MS) {
    // The upstream's head is in OUR future by more than clock skew explains. Reported, not
    // hidden: it means the upstream stamps rows from a clock we do not share, and every
    // latency figure computed against it is off by that much.
    skew = `Its head is stamped ${humanDuration(-lagMs)} in the future, so its clock and ours disagree.`
  }

  const state = !reachable
    ? 'unreachable'
    : lagMs === null
      ? 'unknown'
      : lagMs >= frozenAfterMs
        ? 'frozen'
        : lagMs >= staleAfterMs
          ? 'stale'
          : 'live'

  return {
    source,
    label,
    state,
    observedAt,
    headAt,
    head: head ?? null,
    lagMs,
    staleAfterMs,
    frozenAfterMs,
    covers: covers ? { from: covers.from ?? null, to: covers.to ?? null } : null,
    note: note ?? skew ?? null,
  }
}

/**
 * The upstream did not answer. A distinct constructor rather than a flag, because the caller
 * is in a catch block and has no head to report — and passing `headAt: null` to `liveness()`
 * would otherwise land it in `unknown`, which means something else entirely.
 *
 * @param {{source: string, label: string, reason?: string|null, observedAt?: number}} spec
 * @returns {LivenessReport}
 */
export function unreachable({ source, label, reason = null, observedAt = Date.now() } = {}) {
  return liveness({ source, label, observedAt, reachable: false, note: reason })
}

/** Anything that is not `live`. The one predicate a page needs to decide whether to warn. */
export const isStale = (report) => Boolean(report) && report.state !== 'live'

/** Severity order, worst last. Used to pick the report a banner should lead with. */
const SEVERITY = { live: 0, unknown: 1, stale: 2, unreachable: 3, frozen: 4 }

/**
 * The worst report in a list. `frozen` outranks `unreachable` deliberately: an upstream that
 * is down is visibly down and will come back; an upstream that answers instantly with
 * four-month-old rows is the failure nobody notices.
 *
 * @param {LivenessReport[]} reports
 * @returns {LivenessReport|null}
 */
export function worstLiveness(reports) {
  const list = (reports ?? []).filter(Boolean)
  if (!list.length) return null
  return list.reduce((worst, report) => (SEVERITY[report.state] > SEVERITY[worst.state] ? report : worst))
}

/** Normalises the two shapes a payload may carry — one report or several — into an array. */
export const livenessList = (value) => (Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [])

/**
 * Coarsening as it grows, same rule as `formatDuration` in format.js: nobody needs seconds on
 * a 103-day lag, and printing them implies a precision the head timestamp does not have.
 * Duplicated here rather than imported so this module stays free of presentation concerns for
 * everything except the one sentence it writes.
 */
function humanDuration(ms) {
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * One sentence, for the data-notes list. It names the upstream, says when it last had
 * something new, and — this is the part that earns the contract — says what that means for
 * the numbers on the page rather than only reporting a timestamp.
 *
 * @param {LivenessReport} report
 * @returns {string}
 */
export function describeLiveness(report) {
  if (!report) return ''
  const where = report.head ? ` (${report.head})` : ''
  const covers = report.covers?.from || report.covers?.to
    ? ` The payload here covers ${report.covers.from ?? '?'} to ${report.covers.to ?? '?'}.`
    : ''
  const extra = report.note ? ` ${report.note}` : ''

  switch (report.state) {
    case 'live':
      return `${report.label} answered, and its newest data is ${humanDuration(report.lagMs)} old${where}.${covers}${extra}`
    case 'stale':
      return `${report.label} answered, but its newest data is ${humanDuration(report.lagMs)} old${where} — further behind than the ${humanDuration(report.staleAfterMs)} this source expects. Anything after that point is missing from this page, not absent from the chain.${covers}${extra}`
    case 'frozen':
      return `${report.label} answered normally and its newest data is ${humanDuration(report.lagMs)} old${where}. That is not lag, it is a stopped index: the numbers here are a picture of that date, drawn today.${covers}${extra}`
    case 'unreachable':
      return `${report.label} did not answer at all. Nothing on this page was read from it${covers ? ';' : '.'}${covers}${extra}`
    default:
      return `${report.label} answered, but exposes nothing this site can read a head from, so how current these numbers are is unknown — not confirmed current.${covers}${extra}`
  }
}

/**
 * The tone a `.notice` or `.pill` should carry. `unknown` is deliberately not `good`: the
 * whole point of the third state is that it must not render as a green tick.
 *
 * @param {LivenessReport} report
 * @returns {'good'|'warning'|'critical'|'muted'}
 */
export function livenessTone(report) {
  switch (report?.state) {
    case 'live':
      return 'good'
    case 'stale':
      return 'warning'
    case 'frozen':
    case 'unreachable':
      return 'critical'
    default:
      return 'muted'
  }
}

/** The word that goes in a pill. Short, and it is the state, not a paraphrase of it. */
export const livenessWord = (report) => (report?.state ?? 'unknown').toUpperCase()
