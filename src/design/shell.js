// The site shell: header, navigation, theme toggle, footer.
//
// Every page calls `mountShell()` and gets the same chrome. The navigation is defined once,
// here, from the same list the home page renders its index from — so a page that exists is
// always in the nav, and a nav entry that goes nowhere cannot happen.
//
// It reads `NAV`, not `PAGES`: pages that share a subject are folded into a group there, and
// the bar renders whatever shape it is handed. The same `NAV` is rendered as static HTML by
// `chrome()` in scripts/knowledge.mjs — the two must stay in step, and a divergence shows up
// as a visibly different header rather than silently.

import { el, append } from './dom.js'
import { NAV } from '../sources/pages.js'

const STORAGE_KEY = 'pa-theme'

/**
 * Three theme states, not two: light, dark, and "whatever the OS says". The third is the
 * default and is the one most people actually want; a toggle that only flips between two
 * fixed themes takes that away from them silently.
 */
function readTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // Private-browsing modes throw on localStorage. Falling back to the OS setting is the
    // right failure: the page still themes correctly, it just does not remember a choice.
    return 'system'
  }
}

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* nothing to remember it with; the page is still themed */
  }
}

const LABEL = { system: 'AUTO', light: 'LIGHT', dark: 'DARK' }
const NEXT = { system: 'light', light: 'dark', dark: 'system' }

/** Wires an existing button, so the same behaviour serves a built one and a static one. */
function wireTheme(button) {
  let theme = readTheme()
  button.textContent = `[ ${LABEL[theme]} ]`
  button.addEventListener('click', () => {
    theme = NEXT[theme]
    applyTheme(theme)
    button.textContent = `[ ${LABEL[theme]} ]`
  })
  return button
}

function themeButton() {
  return wireTheme(el('button.theme-btn', { type: 'button', 'aria-label': 'Change colour theme' }))
}

/* ------------------------------------------------------------------------------- the nav ---- */

/**
 * One entry on the bar: either a page, or a group of pages that share a subject.
 *
 * A GROUP IS A `<details>`, and that is the whole design decision. It opens, it closes, it
 * answers the keyboard and it announces its own expanded state with no script at all — which
 * this site actually needs, because the knowledge base ships its chrome as static HTML and is
 * meant to read correctly with scripting off. A scripted menu would have to be reimplemented
 * there, in a second language, and the two would drift. `wireNavGroups()` below adds the menu
 * manners on top; none of them are load-bearing.
 *
 * The group's own label is NOT a link. `/hydration/` is a real page, so making the summary
 * point at it would be tempting and wrong: on a touch device the tap that should open the
 * panel would navigate instead, and the other three pages would be unreachable from the bar.
 * The DEX page is the first entry inside the panel instead, where it can be reached.
 */
function navItem(item, active) {
  // `aria-current` rather than a class: the styling hangs off the attribute, so the accessible
  // state and the visible state cannot disagree.
  const link = (entry) =>
    el('a', { href: entry.href, text: entry.nav, 'aria-current': entry.key === active ? 'page' : null })

  if (item.kind !== 'group') return link(item)

  return el(
    'details.nav-group',
    { data: { group: item.key } },
    // `aria-current="true"`, not `"page"`: the reader is on a page IN this group, not on the
    // group. Two different facts, and the stylesheet marks them differently too.
    el('summary', {
      text: item.nav,
      'aria-current': item.items.some((entry) => entry.key === active) ? 'true' : null,
    }),
    el(
      'div.nav-panel',
      null,
      item.blurb ? el('p.nav-panel-note', { text: item.blurb }) : null,
      ...item.items.map(link),
    ),
  )
}

/**
 * The three manners a bare `<details>` does not have, and nothing beyond them.
 *
 * Opening one group closes the others; Escape closes the open one and puts focus back on its
 * summary; a press outside, or the focus leaving by tab, closes it. Each is an enhancement: with
 * this function never called the nav still works, it just leaves panels open behind you.
 *
 * Called by both `mountShell()` and `mountShellBehaviour()`, so the built chrome and the static
 * knowledge-base chrome behave identically.
 */
export function wireNavGroups(root = document) {
  const groups = [...root.querySelectorAll('.nav-group')]
  if (groups.length === 0) return

  for (const group of groups) {
    group.addEventListener('toggle', () => {
      if (!group.open) return
      for (const other of groups) if (other !== group) other.open = false
    })

    // Tabbing past the last entry is a dismissal. A `relatedTarget` of null is not: that is a
    // press on something unfocusable, which the outside-press handler below already owns —
    // closing here too would shut the panel while the reader is still pointing at it.
    group.addEventListener('focusout', (event) => {
      if (event.relatedTarget && !group.contains(event.relatedTarget)) group.open = false
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const open = groups.find((group) => group.open)
    if (!open) return
    open.open = false
    // Focus goes back where it came from. Leaving it on a panel that no longer exists drops a
    // keyboard reader at the top of the document.
    open.querySelector('summary')?.focus()
  })

  // `pointerdown`, not `click`: one listener covers mouse, touch and pen, and the panel shuts
  // on the press rather than a frame later on release. A press inside the group is left alone
  // — including on a link, whose navigation is not this function's business.
  document.addEventListener('pointerdown', (event) => {
    if (groups.some((group) => group.contains(event.target))) return
    for (const group of groups) group.open = false
  })
}

/**
 * For pages whose chrome is STATIC MARKUP rather than built here: the knowledge base, which is
 * rendered to HTML at build time and ships no page module beyond this one call.
 *
 * The header, nav and footer are already in the document and the active nav item is already
 * marked, so there is nothing to construct. What cannot be static is the theme: it lives in
 * localStorage, so applying it and wiring the toggle needs script. This is that, and nothing
 * else. See `chrome()` in scripts/knowledge.mjs for the other half.
 */
export function mountShellBehaviour(root = document) {
  applyTheme(readTheme())
  const button = root.querySelector('.theme-btn')
  if (button) wireTheme(button)
  wireNavGroups(root)
}

/**
 * @param {object} options
 * @param {string} options.active   the page key, matching an entry in PAGES
 */
export function mountShell({ active } = {}) {
  applyTheme(readTheme())

  // "Site sections", not "Dashboards": the nav carries the knowledge base too, and a label
  // that only a screen reader hears is exactly the one that goes stale unnoticed.
  const nav = el('nav.site-nav', { 'aria-label': 'Site sections' })
  for (const item of NAV) append(nav, navItem(item, active))

  const header = el(
    'header.site-head',
    null,
    el(
      'div.page.inner',
      null,
      el('a.wordmark', { href: '/' }, el('b', { text: 'polkadot' }), el('span.dim', { text: 'analytics' })),
      nav,
      themeButton(),
    ),
  )

  const footer = el(
    'footer.site-foot',
    null,
    el(
      'div.page.inner',
      null,
      el('span', { text: 'Public data, read live from public endpoints. No accounts, no tracking, no cookies.' }),
      el('a', { href: 'https://github.com/cypherpunk-agency/polkadot-analytics', text: 'source' }),
      el('a', { href: '/api', text: 'API' }),
      el('span.build', { text: `build ${__BUILD_STAMP__}` }),
    ),
  )

  document.body.prepend(header)
  document.body.append(footer)

  wireNavGroups(header)
}
