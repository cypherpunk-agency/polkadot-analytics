// The Vite plugin that turns `docs/**/*.md` into `dist/knowledge/**/index.html`.
//
// Three jobs, and they are separate on purpose:
//
//   1. `generateBundle` — emit one static HTML page per document plus the index. It runs there
//      rather than in `writeBundle` because that is where the BUNDLE is available, and the
//      pages must reference the real hashed asset filenames. Guessing `/assets/shell.css`
//      would 404 in a way that leaves the page rendering, unstyled, with a 200 for the
//      document — the same class of silent failure the CSP rules exist to prevent.
//
//   2. `resolveId`/`load` — a `virtual:knowledge` module, so the home page can list the
//      knowledge base from the same walk of `docs/` that produced the pages. A committed
//      generated file would be a second copy that can disagree; a virtual one cannot.
//
//   3. `configureServer` — serve the same pages in `npm run dev`. Without it `/knowledge/`
//      is a 404 until you run a production build, which is exactly how a docs page rots.
//
// The renderer, the URL rules and the templates all live in `knowledge.mjs`, which
// `scripts/check.mjs` imports too — so what the check validates is what the build emits.

import {
  SITE_BASE,
  collectDocuments,
  knowledgeIndexData,
  lastCommitDates,
  renderDocumentPage,
  renderIndexPage,
} from './knowledge.mjs'

const VIRTUAL_ID = 'virtual:knowledge'
const RESOLVED_ID = '\0virtual:knowledge'

/**
 * The stylesheet, found rather than assumed.
 *
 * Vite attaches the CSS a chunk pulled in to that chunk's `viteMetadata.importedCss`. The
 * knowledge entry imports `app.css`, so that set is the authoritative answer. The fallback
 * exists for the case where Vite's CSS attribution moves; it refuses to guess between two
 * candidates rather than picking one and shipping a page styled by half the design system.
 */
function findAssets(bundle) {
  const entry = Object.values(bundle).find(
    (item) => item.type === 'chunk' && item.isEntry && item.name === 'knowledge',
  )
  if (!entry) {
    throw new Error(
      'knowledge: no `knowledge` entry chunk in the bundle. vite.config.mjs must list ' +
        'src/pages/knowledge/main.js as a build input — the emitted pages need a real script URL.',
    )
  }

  const css = [...(entry.viteMetadata?.importedCss ?? [])]
  if (css.length === 0) {
    const assets = Object.values(bundle).filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    if (assets.length !== 1) {
      throw new Error(
        `knowledge: could not identify the stylesheet (${assets.length} .css assets, none attributed to the ` +
          'knowledge entry). The emitted pages must reference the real hashed filename.',
      )
    }
    css.push(assets[0].fileName)
  }
  if (css.length > 1) {
    throw new Error(
      `knowledge: the knowledge entry pulled in ${css.length} stylesheets (${css.join(', ')}). ` +
        'This site has exactly one; something has split app.css.',
    )
  }

  return { css: `/${css[0]}`, script: `/${entry.fileName}` }
}

/**
 * @param {object} options
 * @param {string} options.root        repo root
 * @param {string} options.buildStamp  the same stamp the bundle is built with
 * @param {Array<object>} options.navItems  the finished header bar — `NAV` from src/sources/pages.js
 */
export function knowledgePlugin({ root, buildStamp, navItems }) {
  return {
    name: 'polkadot-analytics:knowledge',

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      return null
    },

    load(id) {
      if (id !== RESOLVED_ID) return null
      const { docs } = collectDocuments(root)
      // Plain data, serialised into the bundle. The home page renders it as text nodes.
      return `export const KNOWLEDGE = ${JSON.stringify(knowledgeIndexData(docs))}\n`
    },

    generateBundle(_options, bundle) {
      const { docs, brokenLinks, withheldLinks } = collectDocuments(root)
      if (docs.length === 0) {
        this.warn('knowledge: docs/ holds no markdown, so no knowledge pages were emitted.')
        return
      }

      // The publication boundary, applied once and then not thought about again: nothing below
      // this line sees an unpublished document. See PUBLISHED_SECTIONS in knowledge.mjs.
      const withheld = docs.filter((doc) => !doc.published)
      const published = docs.filter((doc) => doc.published)

      // Said out loud on every build. An allowlist's failure mode is a document that does not
      // appear, and the fix for that is to make not-appearing impossible to miss.
      for (const dir of new Set(withheld.map((doc) => doc.section))) {
        const count = withheld.filter((doc) => doc.section === dir).length
        this.warn(
          `knowledge: docs/${dir}/ is NOT published (${count} document${count === 1 ? '' : 's'} withheld). ` +
            'Add it to PUBLISHED_SECTIONS in scripts/knowledge.mjs if it should be on the public site.',
        )
      }

      for (const { from, href } of withheldLinks) {
        this.warn(`knowledge: ${from} links to \`${href}\`, which is not published — rendered as plain text.`)
      }

      // Reported, never silently dropped: the renderer turns an unresolvable link into plain
      // text, which reads like prose rather than like a mistake. `npm run check` fails on
      // these; the build only says so, because a build that refuses to produce a site over a
      // dead link in a footnote is a build people learn to bypass.
      for (const { from, href } of brokenLinks) {
        this.warn(`knowledge: ${from} links to \`${href}\`, which does not exist — rendered as plain text.`)
      }

      const context = { assets: findAssets(bundle), buildStamp, navItems, dates: lastCommitDates(root) }
      const index = published.find((doc) => doc.url === SITE_BASE)

      for (const doc of published) {
        const html = doc === index ? renderIndexPage(doc, docs, context) : renderDocumentPage(doc, context)
        // `<url>index.html`: the URL is the directory, so the server's existing directory
        // handling serves it with no server change and both /x/ and /x resolve.
        this.emitFile({ type: 'asset', fileName: `${doc.url.replace(/^\//, '')}index.html`, source: html })
      }

      if (!index) {
        this.warn('knowledge: docs/README.md is missing, so /knowledge/ has no index page.')
      }
    },

    configureServer(server) {
      // Dev only. The assets are the unbuilt sources; Vite serves both.
      const devAssets = { css: '/src/design/app.css', script: '/src/pages/knowledge/main.js' }

      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        if (!pathname.startsWith(SITE_BASE.slice(0, -1))) return next()

        const wanted = pathname.endsWith('/') ? pathname : `${pathname}/`
        const { docs } = collectDocuments(root)
        // Same boundary in dev as in the build. A page that only exists on a laptop is still a
        // page somebody will link to from a screenshot.
        const doc = docs.find((item) => item.url === wanted && item.published)
        if (!doc) return next()

        const context = { assets: devAssets, buildStamp: 'dev', navItems, dates: lastCommitDates(root) }
        const index = docs.find((item) => item.url === SITE_BASE)
        const html = doc === index ? renderIndexPage(doc, docs, context) : renderDocumentPage(doc, context)

        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        // `transformIndexHtml` so the dev client is injected and HMR still works on the page.
        server.transformIndexHtml(pathname, html, req.originalUrl).then(
          (transformed) => res.end(transformed),
          () => res.end(html),
        )
      })
    },
  }
}
