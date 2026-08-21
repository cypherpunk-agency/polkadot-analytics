// The page harness. Every dashboard is `renderPage({ page, intro, load, render })`.
//
// It owns the four states a data page actually has, which is the thing pages get wrong when
// each one hand-rolls it: **loading**, **ready**, **failed**, and — the one usually missing —
// **succeeded but empty**. A page that only draws the first two shows a permanently empty
// chart when an upstream is down, and reads as "there was no activity".
//
// It also owns the failure copy. `ApiError` already distinguishes "we could not reach them"
// from "they answered with an error" from "they answered with something we cannot read", and
// those imply completely different actions for a reader. Collapsing them into "failed to load"
// throws that away.
//
// And it owns the control row, which on these pages is not decoration: a dashboard here is
// several screens long, so the row is sticky under the site header and the settings stay
// reachable from the bottom of the page. See `controlBar()`.

import { append, clear, el } from './dom.js'
import { mountShell } from './shell.js'
import { loadingPanel } from './loading.js'

/**
 * @param {object} spec
 * @param {{key:string,title:string,source:string}} spec.page   entry from src/sources/pages.js
 * @param {string} spec.intro                                    the lede, in prose
 * @param {(ctx: {progress: (u: {stage?:string,done?:number,total?:number,note?:string}) => void}) => Promise<any>} spec.load
 *        `load` is handed a reporter. Using it is optional — every existing page ignores the
 *        argument and still gets the clock, the skeleton and the escalating copy. A load that
 *        knows its own shape ("day 12 of 30", "asset registry") should say so, because a
 *        determinate bar is the difference between "this is working" and "this might be stuck".
 * @param {(host: HTMLElement, data: any) => void} spec.render
 * @param {Array<HTMLElement>} [spec.controls]                   optional filter row above the charts
 * @param {string[]} [spec.skeleton]  shape names from loading.js, in the order they will appear
 * @param {string} [spec.loadingLabel]
 */
export async function renderPage({ page, intro, load, render, controls = [], skeleton = ['stats', 'chart'], loadingLabel }) {
  mountShell({ active: page.key })

  const main = document.getElementById('main')
  const head = el(
    'div.page-head',
    null,
    el('p.eyebrow', { text: page.source }),
    el('h1', { text: page.title }),
    el('p.lede', { text: intro }),
  )

  const body = el('div')
  append(main, head, ...controlBar(controls), body)
  measureStickyChrome()

  document.body.dataset.state = 'loading'
  const loading = loadingPanel(body, {
    label: loadingLabel ?? `Reading ${page.source ?? 'the upstream'}`,
    skeleton,
  })

  try {
    const data = await load({ progress: loading.progress })
    document.body.dataset.state = 'ready'
    clear(body)
    render(body, data)
  } catch (error) {
    document.body.dataset.state = 'error'
    console.error(error)
    clear(body)
    append(
      body,
      el(
        'div.notice',
        { data: { tone: error.kind === 'transport' ? 'warning' : 'critical' } },
        el('span.tag', { text: error.kind ?? 'error' }),
        el(
          'div',
          null,
          el('strong', { text: error.message ?? 'This page could not load its data.' }),
          el('p', { text: error.advice ?? 'Something failed on the way to the data.' }),
          error.source ? el('p', { text: `Upstream: ${error.source}` }) : null,
        ),
      ),
    )
  } finally {
    // In a `finally`, not after the happy path: a page that fails leaves the elapsed clock
    // ticking behind the error notice for as long as the tab is open otherwise.
    loading.stop()
  }
}

/* ------------------------------------------------------------------- the URL as state ---- */

/**
 * Every control's links, rebuilt from the CURRENT query string whenever any control moves it.
 *
 * `choiceControl` already rebuilds the whole query string rather than only its own parameter,
 * so two controls cannot silently reset each other. That was computed once, at build time,
 * which was enough while every control navigated away. A control that rewrites the URL IN
 * PLACE (`localChoiceControl`) breaks it: the "Network" link still carries the edge weighting
 * the page happened to load with, so switching network quietly reverts a choice the reader
 * made two clicks ago. Every control registers here and relinks when the query string moves
 * under it.
 */
const relinkers = new Set()

/** The current query string with one parameter replaced. */
const queryWith = (param, next) => {
  const query = new URLSearchParams(location.search)
  query.set(param, String(next))
  return `?${query}`
}

/**
 * `replaceState`, not `pushState`: a local choice is a different VIEW of the page the reader
 * is already on, not a different place. Back should leave the page rather than walk them
 * backwards through every time they flipped a chart's weighting.
 */
function writeParam(param, next) {
  history.replaceState(history.state, '', queryWith(param, next) + location.hash)
  for (const relink of relinkers) relink()
}

/** Unique per page load; only needs to be unique within one document. */
let controlSeq = 0

/**
 * The shared body of both controls: a labelled row of links, one per option, the current one
 * marked with `aria-current`. `onPick` is the whole difference between them — without it a
 * click is an ordinary navigation, with it the click is handled in place.
 */
function optionRow({ label, param, value, options, hint, onPick }) {
  let current = String(value)
  const id = `ctl-${++controlSeq}`

  const mark = () => {
    buttons.forEach((button, i) => {
      if (String(options[i].value) === current) button.setAttribute('aria-current', 'true')
      else button.removeAttribute('aria-current')
    })
  }

  const pick = (next, event) => {
    // A modified click is the reader asking for a new tab or window, and the href is the
    // honest answer to that. Only a plain primary click is handled in place.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (String(next) === current) return
    current = String(next)
    mark()
    writeParam(param, current)
    onPick(current)
  }

  const buttons = options.map((option) =>
    el('a.theme-btn', {
      // A real link even when the click is intercepted: it can be copied, opened in a new tab,
      // and read by anything that reads links. The interception is the enhancement, not the
      // mechanism.
      href: queryWith(param, option.value),
      text: String(option.label),
      'aria-current': String(option.value) === current ? 'true' : null,
      on: onPick ? { click: (event) => pick(option.value, event) } : null,
    }),
  )

  relinkers.add(() => buttons.forEach((button, i) => button.setAttribute('href', queryWith(param, options[i].value))))

  return el(
    // `role="group"` with the visible label as its name: the row reads as one named choice
    // rather than as a loose run of links whose heading a screen reader passed a moment ago.
    'div.controls',
    { role: 'group', 'aria-labelledby': id },
    el('span.eyebrow', { id, text: label }),
    ...buttons,
    // `.control-hint` is what lets `controlBar()` lift the sentence out of the sticky row; see
    // the note there for why it may not travel with the buttons.
    hint ? el('span.note.control-hint', { text: hint }) : null,
  )
}

/**
 * A control row above the charts. Reloads by navigating rather than by refetching in place:
 * the choice then lives in the URL, which means it can be linked, bookmarked and reported in a
 * bug ("this page, with these settings") — none of which is true of in-memory state.
 *
 * This is the right control for a LOAD PARAMETER — something `load()` actually reads. For a
 * choice that only changes how already-loaded data is drawn, `localChoiceControl` keeps both
 * properties without the refetch.
 */
export function choiceControl(spec) {
  return optionRow(spec)
}

/**
 * The same control for a choice that does NOT change what was fetched — which view of the data
 * already in memory to draw.
 *
 * Navigating for one of those is not a small waste. `/xcm/`'s edge weighting was a
 * `choiceControl` until 2026-08-21, and flipping "by value / by messages" re-ran the whole
 * load, including the row-level read that pages Dotlake up to twenty times and is explicitly
 * the slow half — about forty seconds to change how one graph was drawn from data the browser
 * already had.
 *
 * The fix keeps BOTH properties rather than trading one for the other. `onChange` redraws in
 * place, and the choice is still written to the query string with `replaceState`, so the view
 * stays linkable, bookmarkable and reportable. A control that only redraws would have thrown
 * away the reason `choiceControl` navigates in the first place.
 *
 * @param {(value: string) => void} spec.onChange  called with the new value, after the URL is updated
 */
export function localChoiceControl({ onChange, ...spec }) {
  return optionRow({ ...spec, onPick: onChange })
}

/* --------------------------------------------------------------- the sticky control row ---- */

/**
 * The controls, wrapped in one sticky bar — plus their hints, which are NOT in it.
 *
 * Why the hints come out: a sticky element's flow box IS its painted box, so anything that
 * changes its height while it is stuck shifts every pixel below it. A bar that compacts on
 * stick therefore jumps the page under the reader at the exact moment they scroll past it.
 * The alternative is a bar that is born compact, and the hint — a sentence, five lines of it
 * at 390px — is the only part that is not. So it renders directly under the bar, in normal
 * flow, where it is still next to its control and costs the sticky row nothing.
 *
 * A page that puts a `choiceControl` in its own body rather than here keeps its hint inline;
 * nothing lifts it.
 */
function controlBar(controls) {
  if (!controls.length) return []
  const bar = el('div.controls-bar', null, ...controls)
  // `append` MOVES a node that is already in the tree, so this takes the hints out of the bar.
  const hints = el('div.control-hints', null, ...bar.querySelectorAll('.control-hint'))
  return [bar, hints]
}

/**
 * Publishes the height of the sticky chrome as custom properties, so the stylesheet can offset
 * the control row below the header and scroll focused things clear of both.
 *
 * These are MEASURED, and that is the point. The header wraps on a narrow screen — 53px at
 * 1280 and 143px at 390 when this was written — so a transcribed offset is right at exactly
 * one width and leaves the bar overlapping or floating at every other. It is the one size on
 * the site that `tokens.css` cannot hold, because it is a fact about the rendered page rather
 * than a design decision.
 */
function measureStickyChrome() {
  const root = document.documentElement
  const boxes = [
    ['--head-h', document.querySelector('.site-head')],
    ['--controls-h', document.querySelector('.controls-bar')],
  ].filter(([, node]) => node)
  if (!boxes.length || typeof ResizeObserver !== 'function') return

  const publish = () => {
    for (const [name, node] of boxes) {
      const next = `${Math.round(node.getBoundingClientRect().height)}px`
      // Only on change: neither property feeds back into the height of anything observed here,
      // but a write per frame during a resize drag is still a write per frame.
      if (root.style.getPropertyValue(name) !== next) root.style.setProperty(name, next)
    }
  }

  const observer = new ResizeObserver(publish)
  for (const [, node] of boxes) observer.observe(node)
  publish()
}
