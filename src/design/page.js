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
  append(main, head, ...controls, body)

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

/**
 * A control row above the charts. Reloads by navigating rather than by refetching in place:
 * the choice then lives in the URL, which means it can be linked, bookmarked and reported in a
 * bug ("this page, with these settings") — none of which is true of in-memory state.
 */
export function choiceControl({ label, param, value, options, hint }) {
  // Rebuild the whole query string, not just this parameter. A page with two controls where
  // each link carries only its own parameter silently resets the other one, and the reader has
  // no way to tell that their window snapped back to the default when they switched network.
  const hrefFor = (next) => {
    const query = new URLSearchParams(location.search)
    query.set(param, String(next))
    return `?${query}`
  }

  const buttons = options.map((option) =>
    el('a.theme-btn', {
      href: hrefFor(option.value),
      text: String(option.label),
      'aria-current': String(option.value) === String(value) ? 'true' : null,
      style: String(option.value) === String(value) ? 'color:var(--ink);border-color:var(--rule-strong)' : null,
    }),
  )

  return el(
    'div',
    { style: 'display:flex;flex-wrap:wrap;gap:var(--s2);align-items:baseline;margin-bottom:var(--s5)' },
    el('span.eyebrow', { text: label, style: 'margin:0' }),
    ...buttons,
    hint ? el('span.note', { text: hint, style: 'margin:0' }) : null,
  )
}
