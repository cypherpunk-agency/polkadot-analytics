// The site shell: header, navigation, theme toggle, footer.
//
// Every page calls `mountShell()` and gets the same chrome. The navigation is defined once,
// here, from the same list the home page renders its index from — so a page that exists is
// always in the nav, and a nav entry that goes nowhere cannot happen.

import { el, append } from './dom.js'
import { PAGES } from '../sources/pages.js'

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
  for (const page of PAGES) {
    if (page.hidden) continue
    append(
      nav,
      el('a', {
        href: page.href,
        text: page.nav,
        // `aria-current` rather than a class: the styling hangs off the attribute, so the
        // accessible state and the visible state cannot disagree.
        'aria-current': page.key === active ? 'page' : null,
      }),
    )
  }

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
}
