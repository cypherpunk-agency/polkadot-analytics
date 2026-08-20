// Rendering for the liveness assertion. The contract itself is in src/core/liveness.js.
//
// Split in two because the assertion is built SERVER-SIDE, inside a source module, and the
// server has no DOM. `src/core/liveness.js` is a shape and some predicates; this is the four
// ways that shape appears on a page:
//
//   livenessPill      a word next to a heading — the state, never a paraphrase of it
//   livenessNote      one `<li>` for the data-notes list
//   livenessNotes     the whole `<ul>`, one line per upstream
//   livenessBanner    a `.notice` above the charts, and ONLY when something is wrong
//
// The banner is the load-bearing one and its rule is deliberate: it renders nothing at all
// when everything is live. A green "all systems normal" box on every page is a box readers
// learn to skip in a week, and then the one time it turns red they skip that too.

import { el, notice } from './dom.js'
import { describeLiveness, livenessList, livenessTone, livenessWord, worstLiveness } from '../core/liveness.js'
import { formatUtc } from '../core/format.js'

/**
 * @param {import('../core/liveness.js').LivenessReport} report
 * @returns {HTMLElement|null}
 */
export function livenessPill(report) {
  if (!report) return null
  return el('span.pill', {
    data: { tone: livenessTone(report) },
    text: livenessWord(report),
    // The pill is a glance; the sentence is the fact. `title` carries it for a mouse, and the
    // same sentence is in the data-notes list for everyone else — colour and a five-letter
    // word never carry this alone.
    title: describeLiveness(report),
  })
}

/**
 * One line for the data-notes list: the state, the upstream, the sentence, and the instant we
 * asked. The timestamp is UTC and absolute rather than "3 minutes ago" — this is the caveat a
 * reader may screenshot into a bug report, and a relative time in a screenshot is worthless.
 *
 * @param {import('../core/liveness.js').LivenessReport} report
 * @returns {HTMLElement|null}
 */
export function livenessNote(report) {
  if (!report) return null
  return el(
    'li',
    null,
    livenessPill(report),
    document.createTextNode(` ${describeLiveness(report)} Asked at ${formatUtc(report.observedAt)}.`),
  )
}

/**
 * The list, worst first, so the thing that undermines the page is not the fourth bullet.
 *
 * @param {import('../core/liveness.js').LivenessReport|import('../core/liveness.js').LivenessReport[]} value
 * @returns {HTMLElement|null}
 */
export function livenessNotes(value) {
  const reports = livenessList(value)
  if (!reports.length) return null
  const order = { frozen: 0, unreachable: 1, stale: 2, unknown: 3, live: 4 }
  const sorted = [...reports].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9))
  return el('ul.liveness', null, ...sorted.map(livenessNote))
}

/**
 * The banner, or nothing.
 *
 * @param {import('../core/liveness.js').LivenessReport|import('../core/liveness.js').LivenessReport[]} value
 * @returns {HTMLElement|null} null when every upstream is live
 */
export function livenessBanner(value) {
  const reports = livenessList(value)
  const worst = worstLiveness(reports)
  if (!worst || worst.state === 'live') return null

  const tone = livenessTone(worst)
  const heading = {
    frozen: `${worst.label} has stopped advancing`,
    unreachable: `${worst.label} did not answer`,
    stale: `${worst.label} is behind`,
    unknown: `${worst.label} does not say how current it is`,
  }[worst.state]

  const others = reports.filter((report) => report !== worst && report.state !== 'live')
  return notice(
    tone === 'muted' ? 'info' : tone,
    heading,
    describeLiveness(worst),
    ...others.map(describeLiveness),
  )
}
