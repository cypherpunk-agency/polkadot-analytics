import { defineConfig } from 'vite'
import { readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { knowledgePlugin } from './scripts/knowledge-plugin.mjs'
import { NAV } from './src/sources/pages.js'

const here = dirname(fileURLToPath(import.meta.url))

// Stamped into every bundle so "is the deploy actually live?" is answerable by looking at the
// page rather than by guessing from a container start time.
const buildStamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

/**
 * Every page is a directory at the repo root holding an `index.html`, which is also its URL:
 * `xcm/index.html` is served at `/xcm/`. Discovering them rather than listing them means
 * adding a page is one directory and no config edit — see docs/architecture/overview.md.
 */
function pageEntries() {
  // 404.html is not a directory page, so it is named explicitly; the server serves it for
  // anything that does not resolve.
  //
  // `knowledge` is the one entry that is NOT an HTML page: the knowledge base's pages are
  // emitted as static HTML by the plugin below, and this module exists only so those pages
  // have a real, hashed script URL to point at for the theme toggle. See knowledge.mjs for
  // why the rest of their chrome is static markup rather than JS.
  const entries = {
    home: resolve(here, 'index.html'),
    notfound: resolve(here, '404.html'),
    knowledge: resolve(here, 'src/pages/knowledge/main.js'),
  }
  for (const name of readdirSync(here)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue
    const html = resolve(here, name, 'index.html')
    try {
      if (statSync(html).isFile()) entries[name] = html
    } catch {
      /* not a page directory */
    }
  }
  return entries
}

export default defineConfig({
  // Absolute, not relative: pages live at nested paths (`/xcm/`) and share one `/assets`
  // bundle. A relative base would resolve those assets against the page directory and 404.
  base: '/',
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  // The knowledge base is rendered to static HTML at build time — no markdown parser reaches
  // the browser and no dependency is added. `navItems` is passed in rather than imported
  // inside the plugin so the emitted header is built from the same site map every other page
  // uses: `NAV` is already the finished bar, groups and all, and is plain data by design.
  // See docs/architecture/design-system.md.
  plugins: [
    knowledgePlugin({
      root: here,
      buildStamp,
      navItems: NAV,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: pageEntries() },
  },
  server: {
    port: 5180,
    // In dev the API runs as a separate process on 8080; in production the same Node server
    // serves both. Proxying here means the browser only ever talks to one origin in either
    // case, which is exactly what the production CSP requires. See docs/architecture/security.md.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
})
