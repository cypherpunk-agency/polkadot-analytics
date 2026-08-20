// The knowledge base: docs/**/*.md rendered to static HTML at build time.
//
// This module owns the MODEL (which files exist, what URL each one gets, how a relative link
// between two of them becomes a site URL) and the PAGE TEMPLATES. It is imported by two
// callers that must agree with each other:
//
//   scripts/knowledge-plugin.mjs   the Vite plugin that emits the pages into dist/
//   scripts/check.mjs              the check that refuses a document the renderer would mangle
//
// One module rather than two so "the check passed" means "the build will produce this", not
// "a second implementation of the same rules also thinks it is fine".
//
// ── why static HTML and not a runtime renderer ────────────────────────────────────────────
// The browser bundle ships no markdown parser and the runtime image installs no dependency.
// These pages are documents: they have no state, no data fetch and no interaction beyond the
// theme toggle, so anything the browser would do here is work done once per reader that could
// have been done once per deploy. They also get real URLs — /knowledge/platform/xcm/ — which a
// query-string router cannot give them.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

import { escapeHtml, htmlToText, renderMarkdown } from './markdown.mjs'

/** Where the documents live in the repo, and where they land on the site. */
export const DOCS_DIR = 'docs'
export const SITE_BASE = '/knowledge/'

/**
 * The "edit this page" target. It is the entire point of putting the knowledge base on the
 * site: a reader who spots something wrong is two clicks from the file that says it.
 *
 * `blob/main` rather than `edit/main`: the blob view has an edit button, works when the reader
 * is not signed in, and shows the git history of the claim next to the claim.
 */
export const GITHUB_BLOB = 'https://github.com/cypherpunk-agency/polkadot-analytics/blob/main/'

/**
 * Section order and the one-line purpose shown under each heading on the index.
 *
 * These three phrases mirror the headings in `docs/README.md`; where that file has its own
 * wording for a section, ITS wording wins (see `splitIndexDocument`) and these are the
 * fallback for a section that README has not been told about yet.
 */
export const SECTIONS = [
  { dir: 'architecture', label: 'Architecture', blurb: 'how this repo works' },
  { dir: 'platform', label: 'Platform', blurb: 'how Polkadot works' },
  { dir: 'decisions', label: 'Decisions', blurb: 'why we chose what we chose' },
]

/**
 * ⚠️ THE PUBLICATION BOUNDARY. Everything named here is rendered to a world-readable URL.
 *
 * `docs/` is not all one kind of thing. It holds documentation meant for the public, and it
 * also holds working notes — research sweeps of other repositories, notes on trading strategy,
 * half-formed plans — written by people and by agents, often into a directory that did not
 * exist an hour earlier. Publishing is the default that cannot be taken back: it is a public
 * origin with no gate (docs/decisions/0005-public-no-gate.md), and by the time anyone notices,
 * it has been fetched.
 *
 * THIS IS AN ALLOWLIST, DELIBERATELY, and not the denylist that would be less friction:
 *
 *   · The two failure modes are not symmetric. A denylist that misses a directory publishes
 *     private research to the internet, silently. An allowlist that misses a directory fails
 *     to publish a public document — visible, reversible, and shouted about below (the build
 *     warns, `npm run check` prints every withheld document, and README says what is withheld
 *     and why).
 *   · The thing being defended against is a directory APPEARING, not a directory changing. A
 *     denylist can only exclude what somebody thought of in advance; a new `docs/whatever/`
 *     written by a running workflow is published before anyone can add the entry. That is not
 *     hypothetical — it is how this constant came to exist.
 *   · It matches how this repo already draws its other boundary. `server/sources/index.mjs` is
 *     an allowlist of upstreams, for the same reason and in the same words: there must be no
 *     path from something outside the repo's control to something the world can reach.
 *
 * Adding a directory here is the deliberate act of publishing it. Read it first.
 *
 * Documents at the ROOT of `docs/` (today: `README.md`) are published — the index has to be.
 */
export const PUBLISHED_SECTIONS = new Set(['architecture', 'platform', 'decisions'])

/** True for a document this build may render to a public URL. */
export const isPublished = (doc) => doc.section === null || PUBLISHED_SECTIONS.has(doc.section)

/* ------------------------------------------------------------------------ the file set ---- */

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * `docs/platform/xcm.md` → `/knowledge/platform/xcm/`; `docs/README.md` → `/knowledge/`.
 *
 * A README is the index OF ITS DIRECTORY rather than a page called "readme", so the rule holds
 * one level down too: a future `docs/platform/README.md` would be `/knowledge/platform/`.
 */
function urlFor(docPath) {
  const parts = docPath.split('/')
  const file = parts.pop()
  const stem = file.replace(/\.md$/i, '')
  const segments = stem.toLowerCase() === 'readme' ? parts : [...parts, stem]
  return segments.length === 0 ? SITE_BASE : `${SITE_BASE}${segments.join('/')}/`
}

/**
 * Every document, in section order, each with its rendered body and the facts the templates
 * need. Rendering happens here because the link resolver needs the whole set to exist first —
 * a link is only resolvable once every target is known.
 *
 * @param {string} root  repo root
 */
export function collectDocuments(root) {
  const files = walk(join(root, DOCS_DIR))
    .map((abs) => relative(join(root, DOCS_DIR), abs).split(sep).join('/'))
    .sort()

  const byPath = new Map()
  const docs = files.map((path) => {
    const doc = {
      /** repo-relative, e.g. `docs/platform/xcm.md` — shown on the page and used for the edit link */
      file: `${DOCS_DIR}/${path}`,
      /** docs-relative, e.g. `platform/xcm.md` — the key links resolve against */
      path,
      abs: join(root, DOCS_DIR, path.split('/').join(sep)),
      section: path.includes('/') ? path.split('/')[0] : null,
      url: urlFor(path),
      isIndex: /(^|\/)readme\.md$/i.test(path),
    }
    // Every document is COLLECTED and rendered, including the ones that are not published:
    // `npm run check` still validates them, because a broken link in a working note is still a
    // broken link. `published` is what the three publishing consumers filter on.
    doc.published = isPublished(doc)
    byPath.set(path, doc)
    return doc
  })

  /** Broken links, collected rather than thrown: the caller decides whether that fails a build. */
  const brokenLinks = []
  /** Links that resolve to a file but name an anchor that file does not have. */
  const brokenAnchors = []
  /** Links FROM a published document INTO an unpublished one. Rendered as plain text. */
  const withheldLinks = []

  for (const doc of docs) {
    // Line endings normalised HERE, once, so every consumer sees the text the renderer sees.
    // The working tree is mixed — `.gitattributes` normalises on commit, but a file an agent
    // just wrote can still be CRLF on disk — and a `\r` is a non-newline character, which is
    // enough to make a blank line look like content to a line-pair regex. That is not
    // hypothetical: it made every `---` rule in a CRLF file read as a setext heading.
    const source = readFileSync(doc.abs, 'utf8').replace(/\r\n/g, '\n')
    doc.source = source
    doc.resolve = makeResolver(doc, byPath, brokenLinks, withheldLinks)
    const rendered = renderMarkdown(source, doc.resolve)
    doc.html = rendered.html
    doc.title = rendered.title || doc.path
    doc.headings = rendered.headings
    doc.anchors = new Set(rendered.headings.map((h) => h.id))
    doc.summary = firstParagraph(rendered.html)
  }

  // Anchors are checked in a second pass: a link may point at a heading in a document that had
  // not been rendered yet on the first.
  for (const doc of docs) {
    for (const { href, target, anchor } of doc.links ?? []) {
      if (!anchor) continue
      const to = byPath.get(target)
      if (to && !to.anchors.has(anchor)) brokenAnchors.push({ from: doc.file, href, target, anchor })
    }
  }

  return { docs, byPath, brokenLinks, brokenAnchors, withheldLinks }
}

/**
 * Turns a link as written in a document into a site URL, or `null` to render it as plain text.
 *
 * The cases that actually occur in `docs/`:
 *   `xcm.md`                          sibling document
 *   `../decisions/0003-no-secrets.md` document in another section
 *   `middleware.md#the-shape`         document plus a heading anchor
 *   `../platform/`                    a whole section — becomes the index's section heading
 *   `https://…`                       left alone
 *   `#a-heading`                      same page, left alone
 */
function makeResolver(doc, byPath, brokenLinks, withheldLinks) {
  doc.links = []
  const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : ''
  // De-duplicated at the point of recording: the index document is rendered twice (once to
  // collect its links, once to compose the landing page) and one bad link is one problem.
  const record = (entry) => {
    if (!brokenLinks.some((seen) => seen.from === entry.from && seen.href === entry.href)) brokenLinks.push(entry)
  }
  const withhold = (entry) => {
    // Only interesting FROM a published document: one working note linking to another is
    // fine, neither of them is going anywhere near the site.
    if (!doc.published) return
    if (!withheldLinks.some((seen) => seen.from === entry.from && seen.href === entry.href)) withheldLinks.push(entry)
  }

  return (href) => {
    if (!href) return null
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href // absolute or mailto:
    if (href.startsWith('#')) return href // same document

    const hash = href.indexOf('#')
    const anchor = hash === -1 ? '' : href.slice(hash + 1)
    const rawTarget = hash === -1 ? href : href.slice(0, hash)

    // posix.normalize because these are document paths, not filesystem paths — `..` must
    // collapse the same way on every platform.
    const target = posix.normalize(posix.join(dir, rawTarget))

    if (rawTarget.endsWith('/') || !rawTarget.includes('.')) {
      // A directory: `../platform/`. There is no page for a directory unless it holds a
      // README, so it resolves to the section on the index instead of dying.
      const section = target.replace(/\/$/, '')
      const exists = [...byPath.keys()].some((path) => path.startsWith(`${section}/`))
      if (exists && !PUBLISHED_SECTIONS.has(section.split('/')[0])) {
        // An unpublished directory has no public URL to point at, so the link renders as plain
        // text — the same treatment a missing file gets — and is reported.
        withhold({ from: doc.file, href, target: `${section}/` })
        return null
      }
      if (byPath.has(`${section}/README.md`)) return urlFor(`${section}/README.md`)
      if (SECTIONS.some((s) => s.dir === section)) return `${SITE_BASE}#${section}`
      record({ from: doc.file, href, target })
      return null
    }

    const to = byPath.get(target)
    if (!to) {
      record({ from: doc.file, href, target })
      return null
    }
    // THE BOUNDARY, enforced per link and not only per page. A published document linking into
    // an unpublished one would put the withheld URL on a public page — a 404 that names the
    // file, which is most of what withholding it was meant to avoid.
    if (!to.published) {
      withhold({ from: doc.file, href, target })
      return null
    }
    doc.links.push({ href, target, anchor })
    return anchor ? `${to.url}#${anchor}` : to.url
  }
}

/**
 * The description used on the index and in `<meta>`: the document's first real paragraph.
 *
 * "Real" excludes a short leading metadata line — every decision record opens with
 * `**Status:** accepted · date`, and a tile whose whole description is "Status: accepted" tells
 * a reader nothing about which decision it is.
 */
function firstParagraph(html) {
  for (const match of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = htmlToText(match[1])
    if (text.length < 120 && /^[A-Za-z][\w\s-]{0,24}:/.test(text)) continue
    return match[1]
  }
  return ''
}

/* --------------------------------------------------------------------------- last edited ---- */

/**
 * Last commit date per document, from ONE `git log` rather than one per file.
 *
 * Absent in the container build — `.git` is not in the Docker context — so every caller must
 * cope with `null`, and the templates fall back to the build stamp. A missing date is not
 * worth a build failure; a WRONG date would be worse than none.
 */
export function lastCommitDates(root) {
  const dates = new Map()
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '--no-renames', '--date=short', '--format=%x00%cd', '--name-only', '--', DOCS_DIR],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 },
    )
    let current = null
    for (const line of out.split('\n')) {
      if (line.startsWith('\0')) {
        current = line.slice(1).trim()
        continue
      }
      const name = line.trim()
      // First mention wins: `git log` is newest-first, so that is the latest commit to touch it.
      if (name && current && !dates.has(name)) dates.set(name, current)
    }
  } catch {
    /* no git, no history, or not a repo — the templates fall back to the build stamp */
  }
  return dates
}

/* ----------------------------------------------------------------------------- the chrome ---- */

/**
 * The header, nav and footer, as STATIC MARKUP rather than as something `shell.js` builds at
 * runtime.
 *
 * Why static: these are documents. Emitting the chrome means the page is complete when the HTML
 * arrives — no bundle to download before the nav exists, nothing to reflow, and the page still
 * reads correctly with JavaScript off, which for a page whose whole purpose is to be read is
 * the right trade.
 *
 * That leaves the two things the shell would otherwise have handled:
 *
 *   · THE ACTIVE NAV STATE is baked in. These pages know statically that they are the
 *     knowledge section, so `aria-current="page"` is written into the markup and cannot
 *     disagree with the URL.
 *   · THE THEME cannot be static — it lives in localStorage, and applying it needs JS. So the
 *     pages load ONE small module (`src/pages/knowledge/main.js`) whose only job is to apply
 *     the stored theme and wire the button that is already in the markup. Dropping the toggle
 *     instead would mean a reader who chose dark gets a light knowledge base, which is a worse
 *     inconsistency than a 1 kB module.
 *
 * The markup below must stay in step with `mountShell()` in `src/design/shell.js`; both are
 * styled by the same rules in `base.css`, so a divergence shows up as a visibly different
 * header rather than silently.
 */
function chrome(navItems, buildStamp) {
  const nav = navItems
    .map((item) => {
      const current = item.key === 'knowledge' ? ' aria-current="page"' : ''
      return `<a href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.nav)}</a>`
    })
    .join('')

  return {
    header:
      '<header class="site-head"><div class="page inner">' +
      '<a class="wordmark" href="/"><b>polkadot</b><span class="dim">analytics</span></a>' +
      `<nav class="site-nav" aria-label="Site sections">${nav}</nav>` +
      '<button class="theme-btn" type="button" aria-label="Change colour theme">[ AUTO ]</button>' +
      '</div></header>',
    footer:
      '<footer class="site-foot"><div class="page inner">' +
      '<span>Public data, read live from public endpoints. No accounts, no tracking, no cookies.</span>' +
      `<a href="${GITHUB_BLOB.replace(/\/blob\/main\/$/, '')}">source</a>` +
      '<a href="/api">API</a>' +
      `<span class="build">build ${escapeHtml(buildStamp)}</span>` +
      '</div></footer>',
  }
}

/**
 * @param {object} parts
 * @param {string} parts.title        document title, before the site suffix
 * @param {string} parts.description  plain text for `<meta name="description">`
 * @param {string} parts.body         everything inside `<main>`
 * @param {object} parts.assets       `{ css, script }` — real hashed filenames from the bundle
 */
function document_({ title, description, body, assets, navItems, buildStamp }) {
  const { header, footer } = chrome(navItems, buildStamp)
  // No inline <style>, no style="…" and no inline <script> anywhere in here: production serves
  // `style-src 'self'` and `script-src 'self'` with no `unsafe-inline`, and a violation does
  // not error — the page renders and the rule is simply dropped. See design-system.md.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)} — polkadot analytics</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="${escapeHtml(assets.css)}" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${header}
    <main class="page" id="main">
${body}
    </main>
    ${footer}
    <script type="module" src="${escapeHtml(assets.script)}"></script>
  </body>
</html>
`
}

/* --------------------------------------------------------------------------- doc template ---- */

const sectionOf = (dir) => SECTIONS.find((s) => s.dir === dir)

/** The "where this text lives and how to fix it" strip. Repeated at the top and the bottom. */
function editStrip(doc, updated) {
  return (
    '<p class="doc-actions">' +
    `<a class="doc-edit" href="${escapeHtml(GITHUB_BLOB + doc.file)}" rel="noopener noreferrer">Edit this page on GitHub</a>` +
    `<code class="doc-path">${escapeHtml(doc.file)}</code>` +
    `<span class="doc-updated">${escapeHtml(updated)}</span>` +
    '</p>'
  )
}

function tableOfContents(headings) {
  if (headings.length < 2) return ''
  const items = headings
    .filter((h) => h.level <= 3)
    .map((h) => `<li data-level="${h.level}"><a href="#${escapeHtml(h.id)}">${h.html}</a></li>`)
    .join('')
  if (!items) return ''
  return `<nav class="doc-toc" aria-label="On this page"><p class="doc-toc-title">On this page</p><ul>${items}</ul></nav>`
}

export function renderDocumentPage(doc, context) {
  const section = sectionOf(doc.section)
  const eyebrow = section ? `Knowledge base · ${section.label}` : 'Knowledge base'
  const updated = context.dates.get(doc.file)
    ? `Last updated ${context.dates.get(doc.file)}`
    : `Rendered ${context.buildStamp}`

  const body = [
    '      <div class="page-head">',
    `        <p class="eyebrow">${escapeHtml(eyebrow)}</p>`,
    `        <h1>${escapeHtml(doc.title)}</h1>`,
    `        ${editStrip(doc, updated)}`,
    '      </div>',
    '      <div class="doc-layout">',
    `        ${tableOfContents(doc.headings)}`,
    `        <article class="prose">${doc.html}</article>`,
    '      </div>',
    '      <section class="meta">',
    '        <h2>Correcting this page</h2>',
    '        <p>This page is rendered at build time from ' +
      `<code>${escapeHtml(doc.file)}</code> in the repository — there is no database and no CMS. ` +
      `Something wrong or missing is an edit to that file: <a href="${escapeHtml(GITHUB_BLOB + doc.file)}" rel="noopener noreferrer">open it on GitHub</a>.</p>`,
    `        <p><a href="${escapeHtml(SITE_BASE)}">← All documents</a></p>`,
    '      </section>',
  ].join('\n')

  return document_({
    title: doc.title,
    description: htmlToText(doc.summary).slice(0, 300),
    body,
    ...context,
  })
}

/* ------------------------------------------------------------------------- index template ---- */

/**
 * Drops every markdown table from a document, leaving its prose.
 *
 * Used for ONE document, `docs/README.md`, and for one reason: its tables are a hand-written
 * list of the same files this build walks. Rendering both would put the same twenty links on
 * the page twice, and the hand-written copy is the one that can go stale. So the prose of that
 * file is kept — it is the only place the split between the three sections is explained — and
 * the generated list stands in for the tables.
 *
 * `check.mjs` still validates every link inside those tables, so a stale entry there is a
 * build failure rather than something nobody notices because it is no longer rendered.
 */
function stripTables(markdown) {
  const lines = markdown.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    const isTableHead = lines[i].includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')
    if (!isTableHead) {
      kept.push(lines[i])
      continue
    }
    i += 1 // the separator
    while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) i += 1
  }
  return kept.join('\n')
}

/**
 * Splits `docs/README.md` into the intro, one block per section, and a closing note, so the
 * generated document list can be dropped INTO each section rather than beside all of them.
 *
 * A section block is matched to a directory by the `` `name/` `` in its heading, which is how
 * README already writes them.
 */
function splitIndexDocument(markdown) {
  const lines = markdown.split('\n')
  const intro = []
  const blocks = []
  let current = null

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      current = { heading: line, body: [] }
      blocks.push(current)
      continue
    }
    ;(current ? current.body : intro).push(line)
  }

  // Everything after a standalone rule in the LAST block is a closing note about the whole
  // document rather than about that section, and belongs at the foot of the page.
  let tail = []
  const last = blocks[blocks.length - 1]
  if (last) {
    const rule = last.body.findIndex((line) => /^\s*-{3,}\s*$/.test(line))
    if (rule !== -1) {
      tail = last.body.slice(rule + 1)
      last.body = last.body.slice(0, rule)
    }
  }

  for (const block of blocks) {
    const named = /`([a-z0-9-]+)\/`/i.exec(block.heading)
    block.dir = named ? named[1] : null
    // Force the heading id to the directory name, so `[…](../platform/)` in another document
    // can link to it. Only if the author has not chosen one explicitly.
    if (block.dir && !/\{#[\w-]+\}\s*$/.test(block.heading)) block.heading = `${block.heading.trimEnd()} {#${block.dir}}`
  }

  return { intro: intro.join('\n'), blocks, tail: tail.join('\n') }
}

function tile(doc, dates, buildStamp) {
  const updated = dates.get(doc.file) ? `updated ${dates.get(doc.file)}` : `rendered ${buildStamp}`
  return (
    `<a class="tile" href="${escapeHtml(doc.url)}">` +
    `<span class="k">${escapeHtml(doc.file)}</span>` +
    `<h3>${escapeHtml(doc.title)}</h3>` +
    // PLAIN TEXT, not the rendered fragment. The whole tile is one `<a>`, and a first paragraph
    // that contains a link — several do — would nest an anchor inside an anchor. The parser
    // "fixes" that by closing the outer one and cloning it, so the tile silently appears TWICE
    // on the index. It did, for `security.md` and `people-chain.md`, and the emitted HTML looked
    // perfectly fine; only the parsed DOM disagreed.
    `<p>${escapeHtml(htmlToText(doc.summary))}</p>` +
    `<span class="foot">${escapeHtml(updated)}</span>` +
    '</a>'
  )
}

export function renderIndexPage(index, docs, context) {
  const { dates, buildStamp } = context
  // The index document's own resolver, so a relative link written in its prose resolves the
  // same way it would anywhere else.
  const resolver = index.resolve
  const render = (markdown) => (markdown.trim() ? renderMarkdown(stripTables(markdown), resolver).html : '')

  const { intro, blocks, tail } = splitIndexDocument(index.source)
  const introHtml = render(intro)

  // NOTHING on this page comes from an unpublished directory. `docs` still holds those
  // documents — the check validates them — but from here down only published ones exist.
  const listable = docs.filter((doc) => doc.published && !doc.isIndex)

  const sections = []
  const placed = new Set()
  for (const block of blocks) {
    const dir = block.dir
    const heading = renderMarkdown(block.heading, resolver)
    const listed = listable.filter((doc) => doc.section === dir)
    if (dir) placed.add(dir)
    // Three cases, and only the first gets a list of documents:
    //   · a published directory   → its prose and its documents
    //   · an UNPUBLISHED directory → its prose only. This is how `docs/README.md` gets to say
    //     that `concept/` exists and is deliberately withheld, without the page linking to a
    //     single file inside it.
    //   · a heading that names no directory → prose only; it is an ordinary section.
    const body =
      dir && PUBLISHED_SECTIONS.has(dir)
        ? listed.length
          ? `<div class="deck">${listed.map((doc) => tile(doc, dates, buildStamp)).join('')}</div>`
          : `<p class="note">No documents in <code>${escapeHtml(`${DOCS_DIR}/${dir}`)}</code> yet.</p>`
        : ''
    sections.push(
      '      <section class="kb-section">' + heading.html + render(block.body.join('\n')) + body + '</section>',
    )
  }

  // A PUBLISHED directory that exists on disk but that README has never heard of still gets
  // listed — otherwise adding a document could leave it invisible on the page that exists to
  // show everything that is in the knowledge base. An unpublished one is not mentioned here at
  // all; if it should be acknowledged, that is a sentence in README, written on purpose.
  const orphanDirs = [...new Set(listable.map((doc) => doc.section).filter(Boolean))].filter((dir) => !placed.has(dir))
  for (const dir of orphanDirs) {
    const known = sectionOf(dir)
    const listed = listable.filter((doc) => doc.section === dir)
    sections.push(
      '      <section class="kb-section">' +
        `<h2 id="${escapeHtml(dir)}"><code>${escapeHtml(`${dir}/`)}</code>${known ? ` — ${escapeHtml(known.blurb)}` : ''}</h2>` +
        `<p class="note">Not described in <code>docs/README.md</code>.</p>` +
        `<div class="deck">${listed.map((doc) => tile(doc, dates, buildStamp)).join('')}</div>` +
        '</section>',
    )
  }

  const loose = listable.filter((doc) => !doc.section)
  if (loose.length) {
    sections.push(
      '      <section class="kb-section"><h2 id="other">Other documents</h2>' +
        `<div class="deck">${loose.map((doc) => tile(doc, dates, buildStamp)).join('')}</div></section>`,
    )
  }

  const updated = dates.get(index.file) ? `Last updated ${dates.get(index.file)}` : `Rendered ${buildStamp}`

  const body = [
    '      <div class="page-head">',
    '        <p class="eyebrow">Knowledge base</p>',
    `        <h1>${escapeHtml(index.title)}</h1>`,
    '        <p class="lede">Everything this project has written down — how the site is built, how the ' +
      'chains it reads actually work, and why each decision went the way it did. Rendered straight from the ' +
      'markdown in the repository, so what is on this page is exactly what is in the knowledge base.</p>',
    `        ${editStrip(index, updated)}`,
    '      </div>',
    introHtml ? `      <div class="prose kb-intro">${introHtml}</div>` : '',
    ...sections,
    // Labelled "why they are kept apart" rather than repeating README's own opening words —
    // that paragraph begins "A note on the split", and a heading saying the same thing reads
    // like a rendering mistake.
    tail.trim() ? `      <section class="meta"><h2>Why they are kept apart</h2>${render(tail)}</section>` : '',
    '      <section class="meta">',
    '        <h2>Correcting any of this</h2>',
    '        <p>Every page here is one markdown file in <code>docs/</code>, rendered at build time. The ' +
      'lists above are generated by walking that directory, so a document that exists is listed and a ' +
      'listing cannot point at a document that does not. Each page carries the path of its file and a ' +
      'link that opens it on GitHub.</p>',
    '      </section>',
  ]
    .filter(Boolean)
    .join('\n')

  // A tripwire for the bug above, because that one was invisible in the source: an `<a>` inside
  // the tile's `<a>` is valid-looking HTML that the parser rewrites into two tiles. Nothing
  // reading the emitted file would notice; only the DOM disagrees.
  if (/<a class="tile"[^>]*>(?:(?!<\/a>)[\s\S])*?<a[\s>]/.test(body)) {
    throw new Error(
      'knowledge: a tile contains a nested <a>. The parser will clone the tile and the index will ' +
        'list that document twice. Tile text must be plain — see `tile()`.',
    )
  }

  return document_({
    title: index.title,
    description:
      'The written knowledge base behind analytics.cypherpunk.agency: architecture, how Polkadot works, and the decisions behind both.',
    body,
    ...context,
  })
}

/* ------------------------------------------------------------------- what other code needs ---- */

/**
 * The shape the home page imports through the `virtual:knowledge` module. Plain values only —
 * it is serialised into the bundle.
 */
export function knowledgeIndexData(allDocs) {
  // The home page is a public page too, so it sees exactly what the site publishes.
  const docs = allDocs.filter((doc) => doc.published)

  // Directories in `SECTIONS` order first, then any others in the order they appear. Driven by
  // what is on disk rather than by the list above, so a new PUBLISHED directory shows up on the
  // home page instead of being quietly invisible until somebody edits a constant.
  const dirs = [...new Set(docs.map((doc) => doc.section).filter(Boolean))].sort((a, b) => {
    const rank = (dir) => {
      const at = SECTIONS.findIndex((section) => section.dir === dir)
      return at === -1 ? SECTIONS.length : at
    }
    return rank(a) - rank(b) || a.localeCompare(b)
  })

  return {
    base: SITE_BASE,
    sections: dirs
      .map((dir) => {
        const known = sectionOf(dir)
        return {
          dir,
          label: known?.label ?? `${dir[0].toUpperCase()}${dir.slice(1)}`,
          blurb: known?.blurb ?? '',
          documents: docs
            .filter((doc) => doc.section === dir && !doc.isIndex)
            .map((doc) => ({ title: doc.title, url: doc.url, file: doc.file, summary: htmlToText(doc.summary) })),
        }
      })
      .filter((section) => section.documents.length > 0),
  }
}
