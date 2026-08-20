// The front page: what is here, and what it is made of.
//
// The dashboard index comes from `src/sources/pages.js`, the data-source list comes from the
// API's own self-description at `/api` (generated from the server's source registry), and the
// knowledge-base index comes from `virtual:knowledge`, which is the same walk of `docs/` that
// emitted the pages at /knowledge/. None of the three is a hand-written list, so none can
// drift: a dashboard that exists is listed, a source this site can read is described, and a
// document that exists is linked.

import '../../design/app.css'
import { mountShell } from '../../design/shell.js'
import { append, clear, el, notice } from '../../design/dom.js'
import { loadingPanel } from '../../design/loading.js'
import { catalogue } from '../../core/client.js'
import { DASHBOARDS, pageByKey } from '../../sources/pages.js'
// Provided by scripts/knowledge-plugin.mjs at build time — plain data, no markdown parser and
// no fetch. See scripts/knowledge.mjs.
import { KNOWLEDGE } from 'virtual:knowledge'

mountShell({ active: 'home' })

const main = document.getElementById('main')

append(
  main,
  el(
    'div.page-head',
    null,
    el('p.eyebrow', { text: 'analytics.cypherpunk.agency' }),
    el('h1', { text: 'Polkadot analytics' }),
    el('p.lede', {
      text:
        'Dashboards over public Polkadot ecosystem data, read live from public endpoints. No accounts, no API keys, no tracking, nothing stored about you. Every number on this site says where it came from and what is wrong with it.',
    }),
  ),
)

/* ------------------------------------------------------------------------- dashboards ---- */

const deck = el('div.deck')
for (const page of DASHBOARDS) {
  append(
    deck,
    el(
      'a.tile',
      { href: page.href, data: { live: page.live ? '1' : '0' } },
      el('span.k', { text: page.source }),
      el('h3', { text: page.title }),
      el('p', { text: page.blurb }),
      el('span.foot', { text: page.live ? 'live' : 'archive — fixed dataset' }),
    ),
  )
}

append(main, el('section', null, deck))

/* ---------------------------------------------------------------------- the knowledge base ---- */

// Not a tile in the deck above: those are dashboards, and a tile for the knowledge base would
// promise live numbers it does not have. It is a section of the site, so it gets a section.
{
  const knowledge = pageByKey('knowledge')
  const card = el(
    'section.card',
    null,
    el('header', null, el('h2', { text: knowledge.title })),
    el('p.note', {
      text:
        'Written documentation of the platforms this site reads and of the site itself, kept in the repository next to the code that queries them, and published here so it can be read and corrected rather than taken on trust. Every page names the file it came from and links straight to it.',
    }),
  )

  for (const section of KNOWLEDGE.sections) {
    const list = el('ul')
    for (const doc of section.documents) {
      append(list, el('li', null, el('a', { href: doc.url, text: doc.title })))
    }
    append(
      card,
      el(
        'div.kb-group',
        null,
        el('span.k', { text: section.blurb ? `${section.label} — ${section.blurb}` : section.label }),
        list,
      ),
    )
  }

  append(
    card,
    el(
      'p.note',
      null,
      document.createTextNode('All of it, with the section notes and the decision records: '),
      el('a', { href: knowledge.href, text: 'the knowledge base' }),
      document.createTextNode('.'),
    ),
  )
  append(main, card)
}

/* --------------------------------------------------------------------------- how & why ---- */

append(
  main,
  el(
    'section.card',
    { style: 'margin-top:var(--s6)' },
    el('header', null, el('h2', { text: 'How this works' })),
    el('p.note', {
      text:
        'Your browser only ever talks to this site. Every chain, indexer and API this site reads is called server-side, once per cache window, and every visitor is served the same snapshot. That is not an implementation detail — these dashboards are heavy clients by design, and one that fanned out to a volunteer-run node once per pageview would be a denial-of-service with our name on it.',
    }),
    el('p.note', {
      text:
        'It also means there is nothing to configure and nothing to leak: no API keys exist anywhere in this repository, because every upstream is anonymous public HTTP. The content security policy is default-src self with no exceptions, which the same design makes possible rather than painful.',
    }),
  ),
)

/* ------------------------------------------------------------------------ what we read ---- */

const sourcesHost = el('section.card', null, el('header', null, el('h2', { text: 'What this site reads' })))
// The card's body is its own node so the loading panel can own it without taking the heading
// with it — `loadingPanel` clears whatever host it is given.
const sourcesBody = el('div')
append(sourcesHost, sourcesBody)
append(main, sourcesHost)

// Not top-level await: the build targets browsers that predate it, and a module that fails to
// parse takes the whole page with it rather than just this card.
async function listSources() {
  // The same loading state every dashboard gets, for the same reason: on a cold container this
  // card sat as a bare heading with nothing under it, which is indistinguishable from a card
  // that is going to stay empty. `rows` is the shape that lands here, so the layout is reserved.
  const loading = loadingPanel(sourcesBody, { label: 'Reading the source catalogue', skeleton: ['rows'] })
  try {
    const { sources } = await catalogue()
    loading.progress({ stage: 'Reading the source catalogue', done: sources.length, total: sources.length })
    clear(sourcesBody)
    const list = el('div.rows')
    for (const source of sources) {
      const operations = source.operations.length
      const ttl = Math.min(...source.operations.map((op) => op.cacheSeconds))
      append(
        list,
        el(
          'div.row',
          { style: 'grid-template-columns:minmax(10rem,16rem) 1fr auto' },
          el('div.name', null, el('a', { href: source.homepage, text: source.label })),
          el('div', { class: 'note', style: 'margin:0', text: (source.covers ?? []).join(', ') }),
          el('div.amt', null, el('span.cnt', { text: `${operations} ${operations === 1 ? 'query' : 'queries'} · cached ≥ ${Math.round(ttl / 60)}m` })),
        ),
      )
    }
    append(
      sourcesBody,
      list,
      el(
        'p.note',
        null,
        document.createTextNode('The full machine-readable description, including every parameter, is at '),
        el('a', { href: '/api', text: '/api' }),
        document.createTextNode(' — generated from the same registry the server resolves against, so it cannot describe something the service will not answer.'),
      ),
    )
  } catch (error) {
    // The catalogue failing is not fatal to this page: the dashboard index above is built into
    // the bundle. Say what is missing rather than showing an empty card. Only the body is
    // replaced now, so the heading no longer has to be rebuilt to survive the failure.
    clear(sourcesBody)
    append(
      sourcesBody,
      notice('warning', 'The source catalogue is unavailable', error.message ?? 'The API did not answer. The dashboards above may still work.'),
    )
  } finally {
    // In a `finally` for the reason renderPage() does it: otherwise the elapsed clock ticks on
    // behind the failure notice for as long as the tab is open.
    loading.stop()
  }
}

listSources()

/* ----------------------------------------------------------------------------- the repo ---- */

append(
  main,
  el(
    'section.meta',
    null,
    el('h2', { text: 'About' }),
    el('p', {
      text:
        'No framework, no tracking, no accounts, and no secrets: every upstream is anonymous public HTTP, which is a design constraint rather than a boast — it is what makes the whole thing readable and re-runnable by anyone.',
    }),
    el(
      'p',
      null,
      el('a', { href: 'https://github.com/cypherpunk-agency/polkadot-analytics', text: 'cypherpunk-agency/polkadot-analytics' }),
      document.createTextNode(' · built by '),
      el('a', { href: 'https://cypherpunk.agency', text: 'Cypherpunk Agency' }),
    ),
  ),
)
