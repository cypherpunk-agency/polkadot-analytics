// A small Markdown renderer, used at BUILD TIME only.
//
// Why hand-rolled rather than `marked` or `markdown-it`: the runtime image installs nothing and
// the browser bundle ships no parser — the knowledge base is rendered to static HTML during the
// build, so a dependency here would buy convenience at the cost of the one property that makes
// this repo cheap to reason about. The subset below is exactly what `docs/` actually uses,
// checked against every file, and `npm run check` fails if a document uses something unsupported
// rather than letting it render as literal asterisks.
//
// ── the security posture ────────────────────────────────────────────────────────────────────
// Everything is escaped first and markup is re-introduced only by the rules below, so there is
// no path from document text to raw HTML. Raw HTML blocks in Markdown are NOT supported and are
// escaped like anything else. That is deliberate: these documents are edited by people and by
// agents, they render on a public origin under `script-src 'self'`, and a renderer that passes
// HTML through is one careless paste away from being the exception to that.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])

/** The same escape the renderer uses, for the page templates that wrap its output. */
export const escapeHtml = escape

/** The inverse, for turning a rendered fragment back into plain text (meta descriptions). */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Inline: code, links, bold, italic — applied to already-escaped text. */
function inline(text, linkResolver) {
  let out = escape(text)

  // Code spans first and held aside, so emphasis and link syntax inside them stays literal.
  // The placeholder is delimited by NUL, built with String.fromCharCode rather than pasted in
  // as a literal byte: a real control character in a source file makes it binary to git, grep
  // and every editor. NUL cannot collide with document text because the input is already
  // HTML-escaped.
  //
  // The DELIMITERS are load-bearing, not decoration. A restore pattern of /(\d+)/ matches
  // every bare number in ordinary prose — "20 renewals" becomes a lookup of spans[20], which
  // is `undefined`. That has happened; the placeholder is only ever matched MARK-delimited.
  const MARK = String.fromCharCode(0)
  const PLACEHOLDER = new RegExp(MARK + '(\\d+)' + MARK, 'g')
  const spans = []
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code)
    return MARK + (spans.length - 1) + MARK
  })

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const url = linkResolver(href)
    // A link that resolves to nothing renders as plain text rather than a dead anchor.
    if (!url) return label
    const external = /^https?:/i.test(url)
    const rel = external ? ' rel="noopener noreferrer"' : ''
    return `<a href="${escape(url)}"${rel}>${label}</a>`
  })

  // Bold BEFORE italic, and bold may CONTAIN italic — `**a *b* c**` and `**a *b***` both occur
  // in these documents. Two details make that work without a parser:
  //
  //   · the body is `[\s\S]+?`, not `[^*]+`, so a nested `*…*` does not end the match early;
  //   · the closing `**` must not be followed by a third `*`, so in `**a *b***` the closer is
  //     the LAST two asterisks and the inner pair survives for the italic pass. Without that
  //     lookahead the tags cross — `<strong>…</strong></em>` — which no browser un-does.
  out = out.replace(/\*\*([\s\S]+?)\*\*(?!\*)/g, '<strong>$1</strong>')
  // `>` and `<` join the boundary sets because by this point the only ones present are the
  // tags just inserted: the document's own angle brackets became entities in the first line of
  // this function. So `<strong>*b*</strong>` still finds its italic.
  out = out.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,;:!?<]|$)/g, '$1<em>$2</em>')

  // NOT re-escaped: `out` was escaped in full before the spans were lifted out of it, so the
  // held-aside text is already escaped. Escaping again turns `<name>` into a visible
  // `&lt;name&gt;` on the page, which is what the docs are full of.
  return out.replace(PLACEHOLDER, (_, i) => `<code>${spans[Number(i)] ?? ''}</code>`)
}

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

/**
 * @param {string} source     markdown
 * @param {(href: string) => string|null} linkResolver  maps a link target to a site URL, or null to drop it
 * @returns {{ html: string, title: string, headings: Array<{level:number,text:string,id:string}> }}
 */
export function renderMarkdown(source, linkResolver = (href) => href) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n')
  const out = []
  const headings = []
  let title = ''
  let i = 0

  const closeList = (() => {
    let open = null
    return {
      to(kind) {
        if (open === kind) return
        if (open) out.push(`</${open}>`)
        if (kind) out.push(`<${kind}>`)
        open = kind
      },
    }
  })()

  while (i < lines.length) {
    const line = lines[i]

    // ── fenced code ──────────────────────────────────────────────────────────────────────
    if (/^\s*```/.test(line)) {
      closeList.to(null)
      const body = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i += 1
      out.push(`<pre><code>${escape(body.join('\n'))}</code></pre>`)
      continue
    }

    // ── table ────────────────────────────────────────────────────────────────────────────
    // A header row followed by a |---|---| separator. Anything else with pipes is a paragraph.
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      closeList.to(null)
      const cells = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())

      const header = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))

      // Wrapped, because a wide table must scroll inside itself rather than making the page
      // scroll sideways.
      out.push('<div class="tablewrap"><table class="data prose-table">')
      // `| | |` is the two-column layout table these documents use for link lists. Emitting an
      // empty `<thead>` for it would announce two blank column headers to a screen reader.
      if (header.some((cell) => cell !== '')) {
        out.push('<thead><tr>')
        for (const cell of header) out.push(`<th>${inline(cell, linkResolver)}</th>`)
        out.push('</tr></thead>')
      }
      out.push('<tbody>')
      for (const row of rows) {
        out.push('<tr>')
        for (const cell of row) out.push(`<td>${inline(cell, linkResolver)}</td>`)
        out.push('</tr>')
      }
      out.push('</tbody></table></div>')
      continue
    }

    // ── heading ──────────────────────────────────────────────────────────────────────────
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList.to(null)
      const level = heading[1].length
      const text = heading[2].replace(/\s*\{#[\w-]+\}\s*$/, '').trim()
      const explicit = /\{#([\w-]+)\}\s*$/.exec(heading[2])
      const id = explicit ? explicit[1] : slug(text)
      if (level === 1 && !title) title = text
      // h1 becomes the page title and is rendered by the template, not inline.
      if (level > 1) {
        // `html` as well as `text`: a heading like "The `Broadcast.Swapped3` event" would put
        // literal backticks in a table of contents built from `text` alone.
        headings.push({ level, text, id, html: inline(text, linkResolver) })
        out.push(`<h${level} id="${escape(id)}">${inline(text, linkResolver)}</h${level}>`)
      }
      i += 1
      continue
    }

    // ── horizontal rule ──────────────────────────────────────────────────────────────────
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList.to(null)
      out.push('<hr />')
      i += 1
      continue
    }

    // ── blockquote ───────────────────────────────────────────────────────────────────────
    if (/^\s*>/.test(line)) {
      closeList.to(null)
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      // Blockquotes in these documents are always warnings, so they get the notice treatment
      // rather than the decorative left bar a blockquote usually gets.
      out.push(`<blockquote class="callout">${inline(body.join(' '), linkResolver)}</blockquote>`)
      continue
    }

    // ── lists ────────────────────────────────────────────────────────────────────────────
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      closeList.to(bullet ? 'ul' : 'ol')
      // Continuation lines are indented under the marker; fold them into the same item so a
      // wrapped sentence does not become a new bullet.
      let text = (bullet ?? ordered)[1]
      i += 1
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s/.test(lines[i])) {
        text += ` ${lines[i++].trim()}`
      }
      out.push(`<li>${inline(text, linkResolver)}</li>`)
      continue
    }

    // ── paragraph ────────────────────────────────────────────────────────────────────────
    if (!line.trim()) {
      closeList.to(null)
      i += 1
      continue
    }

    closeList.to(null)
    const body = []
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|[-*]\s|\d+[.)]\s|>|```)/.test(lines[i])) {
      body.push(lines[i++])
    }
    out.push(`<p>${inline(body.join(' '), linkResolver)}</p>`)
  }

  closeList.to(null)
  return { html: out.join('\n'), title, headings }
}

/** Everything the renderer does not understand, so `check.mjs` can refuse it rather than mangle it. */
export const UNSUPPORTED = [
  { name: 'raw HTML block', test: /^\s*<(?!!--)[a-zA-Z]/m },
  { name: 'reference-style link', test: /^\s*\[[^\]]+\]:\s+\S+/m },
  // The `(?=[^\n]*\S)` guard is load-bearing: without it a blank line followed by a `---`
  // horizontal rule — which these documents use constantly — reads as a setext heading, and
  // in a CRLF file "blank" is a line containing `\r`. Belt and braces with the normalisation
  // in collectDocuments.
  { name: 'setext heading', test: /^(?=[^\n]*\S)[^\n]+\n(=|-){3,}[ \t]*$/m },
]
