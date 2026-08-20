// The loading state, which on this site is a real state and not a gap between two others.
//
// The failure this replaces is already shipping: a 40-second Hydration fetch behind a bare
// spinner is INDISTINGUISHABLE FROM A HANG. The reader has no way to tell whether the request
// is progressing, whether the upstream is slow, or whether the page is broken — and the
// rational thing for them to do, reloading, makes it worse.
//
// So a slow load here says three things a spinner cannot:
//
//   1. HOW LONG IT HAS BEEN. An elapsed clock that ticks is the cheapest possible proof that
//      the page is alive, and it costs one interval.
//   2. WHAT IT IS DOING. A stage line the loader writes into: "asset registry", "day 12 of 30".
//      When a fetch reports counts the bar becomes determinate and stops guessing.
//   3. WHAT SHAPE THE ANSWER WILL BE. The skeleton is not decoration; it reserves the layout
//      so the page does not jump when the data lands, and it tells a reader that four tiles
//      and a chart are coming rather than leaving a blank card that might stay blank.
//
// Escalating copy at 8s / 25s / 60s exists for the same reason the error copy is split by
// kind: at forty seconds a reader deserves to be told this is normal for this upstream, not
// left to guess. Nothing here claims progress it does not have — an indeterminate bar is
// visibly indeterminate.
//
// Built from tokens.css only. No colour, size or duration is named anywhere but there, and
// every dimension is set through `el()`'s `style` prop, which routes through CSSOM — an
// inline `style=` attribute is silently dropped under `style-src 'self'` and every bar on the
// page would render at zero width.

import { append, clear, el } from './dom.js'

/** When the copy escalates, and to what. Ordered, and read from the end. */
const ESCALATION = [
  { afterMs: 60_000, text: 'Over a minute. This is a long read — a wide window against an archive node is minutes of work, not seconds. It is still going.' },
  { afterMs: 25_000, text: 'Slower than usual. The upstream has not answered yet; nothing has failed and nothing needs reloading.' },
  { afterMs: 8_000, text: 'Still waiting on the upstream.' },
]

/**
 * Skeleton shapes, by name. Each mirrors a real component so the reserved space matches what
 * eventually lands there. `aria-hidden` throughout: a screen reader is told the state once, by
 * the live region above, and reading out eleven empty boxes would be worse than a spinner.
 */
const SHAPES = {
  stats: () =>
    el(
      'div.stat-row.sk',
      { 'aria-hidden': 'true' },
      ...Array.from({ length: 4 }, () =>
        el('div.stat', null, el('div.sk-line', { style: 'width:45%' }), el('div.sk-line.sk-big', { style: 'width:70%' })),
      ),
    ),
  chart: () =>
    el(
      'div.card.sk',
      { 'aria-hidden': 'true' },
      el('div.sk-line', { style: 'width:30%' }),
      el('div.sk-plot'),
    ),
  rows: () =>
    el(
      'div.card.sk',
      { 'aria-hidden': 'true' },
      el('div.sk-line', { style: 'width:24%' }),
      el(
        'div.rows',
        null,
        // Descending widths: a ranking is what goes here, and a skeleton of equal bars would
        // promise a distribution of equals — the exact thing this site refuses to draw.
        ...[92, 74, 61, 48, 37, 25].map((width) =>
          el('div.row', null, el('div.sk-line'), el('div.track', null, el('div.sk-fill', { style: `width:${width}%` })), el('div.sk-line', { style: 'width:3rem' })),
        ),
      ),
    ),
  table: () =>
    el(
      'div.card.sk',
      { 'aria-hidden': 'true' },
      el('div.sk-line', { style: 'width:20%' }),
      ...Array.from({ length: 6 }, () => el('div.sk-line.sk-row')),
    ),
}

/**
 * Mount the loading panel into `host` and return the handle the loader writes progress into.
 *
 * @param {HTMLElement} host
 * @param {object} [spec]
 * @param {string} [spec.label]      what is being loaded, in the reader's terms
 * @param {string[]} [spec.skeleton] shape names, in the order they will appear
 * @param {number} [spec.now]        injectable clock, so this is testable without waiting
 * @returns {{progress: (u: {stage?: string, done?: number, total?: number, note?: string}) => void, stop: () => void, node: HTMLElement}}
 */
export function loadingPanel(host, { label = 'Loading', skeleton = ['stats', 'chart'], now = () => Date.now() } = {}) {
  const startedAt = now()

  const stage = el('span.load-stage', { text: `${label}…` })
  const elapsed = el('span.load-elapsed.mono', { text: '0s' })
  const detail = el('span.load-detail.mono')

  // `role="status"` and not `role="alert"`: this is an update, not an interruption. The
  // elapsed clock is excluded from the live region — announcing "1s… 2s… 3s…" would make the
  // page unusable with a screen reader on.
  const head = el(
    'div.load-head',
    { role: 'status', 'aria-live': 'polite' },
    el('span.spinner', { 'aria-hidden': 'true' }),
    stage,
    detail,
  )

  const bar = el('div.bar', { data: { mode: 'indeterminate' } })
  const track = el('div.progress', {
    role: 'progressbar',
    'aria-label': `${label} progress`,
    // No `aria-valuenow` while indeterminate. A progressbar that claims 0% for forty seconds
    // is a worse lie than one that admits it does not know.
  }, bar)

  const note = el('p.note.load-note')

  const panel = el(
    'div.loading',
    null,
    el('div.load-bar-row', null, head, elapsed),
    track,
    note,
    ...(skeleton ?? []).map((name) => SHAPES[name]?.()).filter(Boolean),
  )

  clear(host)
  append(host, panel)

  let lastEscalation = null
  const tick = () => {
    const ms = now() - startedAt
    elapsed.textContent = ms < 1000 ? '0s' : ms < 90_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
    const step = ESCALATION.find((rule) => ms >= rule.afterMs)
    if (step && step !== lastEscalation) {
      lastEscalation = step
      note.textContent = step.text
    }
  }
  const timer = setInterval(tick, 500)
  tick()

  return {
    node: panel,
    /**
     * Called by the loader. Every field is optional; passing `done`/`total` is what turns the
     * bar determinate, and once it is determinate it stays that way.
     */
    progress({ stage: stageText, done, total, note: noteText } = {}) {
      if (stageText) stage.textContent = stageText
      if (typeof noteText === 'string') note.textContent = noteText
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
        const fraction = Math.max(0, Math.min(1, done / total))
        bar.dataset.mode = 'determinate'
        // CSSOM, not setAttribute('style', …). See dom.js — under `style-src 'self'` the
        // attribute form is dropped and this bar would sit at zero width for ever.
        bar.style.setProperty('width', `${(fraction * 100).toFixed(1)}%`)
        track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
        track.setAttribute('aria-valuemin', '0')
        track.setAttribute('aria-valuemax', '100')
        detail.textContent = `${done} / ${total}`
      } else if (Number.isFinite(done)) {
        detail.textContent = String(done)
      }
    },
    /** Stops the clock. The harness calls this in a `finally`, so it runs on failure too. */
    stop() {
      clearInterval(timer)
    },
  }
}

/** The shape names `renderPage({ skeleton })` accepts, for anyone reaching for the list. */
export const SKELETON_SHAPES = Object.freeze(Object.keys(SHAPES))
