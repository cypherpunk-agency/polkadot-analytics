// Element construction, small enough to read in one sitting.
//
// No framework, and the reason is not minimalism for its own sake: the production CSP is
// `script-src 'self'` with no `unsafe-eval`, the container has a 256 MB ceiling shared with
// several other services, and every page here is a document that renders once from one JSON
// payload. A runtime that re-renders on state change would be solving a problem this site
// does not have.

/**
 * `el('div.card', { text: 'hi' }, child, child)`.
 *
 * Children that are `null` are skipped. That matters more than it sounds: the native
 * `append` renders the literal string "null", so `node.append(cond ? x : null)` silently
 * puts the word "null" on the page.
 */
export function el(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.')
  const node = document.createElement(tag || 'div')
  if (classes.length) node.className = classes.join(' ')

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue
    if (key === 'text') node.textContent = value
    else if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ')
    else if (key === 'style') style(node, value)
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler)
    else if (key === 'data') for (const [name, item] of Object.entries(value)) node.dataset[name] = item
    else node.setAttribute(key, value === true ? '' : String(value))
  }

  append(node, ...children)
  return node
}

/**
 * ⚠️ THE REASON THIS FUNCTION EXISTS, and it is not style.
 *
 * The production CSP is `style-src 'self'` with no `'unsafe-inline'`. Under it, the browser
 * silently refuses `setAttribute('style', …)` — and "silently" is the whole problem. The page
 * still renders, every request still returns 200, and every proportional bar on the site draws
 * at **zero width**. It looks like a dataset with no values in it.
 *
 * Setting the same declarations through CSSOM (`node.style.setProperty`) is NOT governed by
 * `style-src`, so it works under the same policy. Every dynamic dimension and series colour on
 * this site goes through here.
 *
 * Split on the FIRST colon only: values legitimately contain them (`url(…)`, `var(--x, a:b)`).
 */
export function style(node, declarations) {
  if (!declarations) return node
  for (const rule of String(declarations).split(';')) {
    const at = rule.indexOf(':')
    if (at < 0) continue
    const name = rule.slice(0, at).trim()
    const value = rule.slice(at + 1).trim()
    if (name && value) node.style.setProperty(name, value)
  }
  return node
}

/** SVG needs its own namespace; `createElement('rect')` produces an HTML element that never draws. */
export function svg(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.')
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (classes.length) node.setAttribute('class', classes.join(' '))
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue
    if (key === 'text') node.textContent = value
    else if (key === 'style') style(node, value)
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler)
    // `fill`, `stroke` and friends are SVG PRESENTATION ATTRIBUTES, not CSS — they are not
    // touched by `style-src` and are set as ordinary attributes.
    else node.setAttribute(key, String(value))
  }
  append(node, ...children)
  return node
}

/** `append` that drops nullish children instead of stringifying them. */
export function append(node, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove()
  return node
}

export const $ = (id) => document.getElementById(id)

/** A labelled notice. The tag word is not decoration — it is what carries the meaning when
 *  the colour does not, which on the light surface is most of the time. */
export function notice(tone, title, ...paragraphs) {
  return el(
    'div.notice',
    { data: { tone } },
    el('span.tag', { text: tone }),
    el('div', null, el('strong', { text: title }), ...paragraphs.map((p) => el('p', { text: p }))),
  )
}

export function statTile(label, value, sub = null, { hero = false } = {}) {
  return el(
    'div.stat',
    null,
    el('div.k', { text: label }),
    el('div', { class: hero ? 'v hero' : 'v', text: value }),
    sub ? el('div.sub', { text: sub }) : null,
  )
}

export function statRow(tiles) {
  return el('div.stat-row', null, ...tiles)
}
