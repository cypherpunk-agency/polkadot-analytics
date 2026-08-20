// The site map, in one place.
//
// The header nav and the home-page index both read this list, so a page cannot exist without
// appearing in the nav, and a nav entry cannot point at a page that was never built. Adding a
// dashboard is: a directory with an `index.html`, plus an entry here.
//
// `live: false` marks a page whose data is a fixed historical dataset rather than a live read.
// That distinction belongs on the tile, not in a footnote — a reader who cannot tell a live
// dashboard from a 2023 archive will read the archive as today's numbers.
//
// `kind` separates the two things this list now holds. Everything here belongs in the header
// nav, but only a `dashboard` belongs in the home page's deck of dashboards — the knowledge
// base is a section of the site, not a chart, and a tile promising "live data" for it would be
// a small lie. Read the nav from `PAGES` and the deck from `DASHBOARDS`.

export const PAGES = [
  {
    key: 'xcm',
    kind: 'dashboard',
    href: '/xcm/',
    nav: 'XCM',
    title: 'XCM message flow',
    blurb:
      'Every cross-consensus message on Polkadot: which chains talk to each other, how much of it lands, and how long it takes.',
    source: 'Dotlake (Parity)',
    live: true,
  },
  {
    key: 'hydration',
    kind: 'dashboard',
    href: '/hydration/',
    nav: 'Hydration',
    title: 'Hydration DEX activity',
    blurb:
      'Swaps on the Omnipool, reconstructed from per-leg chain events into the trades people actually made, and valued in dollars.',
    source: 'Hydration archive + RPC',
    live: true,
  },
  {
    key: 'hyperfx',
    kind: 'dashboard',
    href: '/hyperfx/',
    nav: 'HyperFX',
    title: 'HyperFX swap volume',
    blurb:
      'Every intent order bridged through Hyperbridge, valued on the input leg, broken down by day, route and account.',
    source: 'Hyperbridge nexus indexer',
    live: true,
  },
  {
    key: 'bulletin',
    kind: 'dashboard',
    href: '/bulletin/',
    nav: 'Bulletin',
    title: 'Bulletin chain storage',
    blurb:
      'What is actually stored on the Polkadot Bulletin chain, what shape it is, and how long it has left before its lease runs out.',
    source: 'Bulletin devnet RPC',
    live: true,
  },
  {
    key: 'netflows',
    kind: 'dashboard',
    href: '/netflows/',
    nav: 'Netflows',
    title: 'Parachain netflows, 2021–2023',
    blurb:
      'The archived Polkalytics study of DOT and KSM held in parachain sovereign accounts, from the first parachain to April 2023.',
    source: 'Archived dataset',
    live: false,
  },
  {
    key: 'knowledge',
    kind: 'section',
    href: '/knowledge/',
    nav: 'Knowledge',
    title: 'The knowledge base',
    blurb:
      'Everything this project has written down: how the site is built, how the chains it reads actually work, and why each decision went the way it did. Rendered from the markdown in the repository, one page per file, each with a link to edit it.',
    // No `source` and no `live`: it reads nothing at run time. Its pages are rendered from
    // docs/ at build time by scripts/knowledge-plugin.mjs.
  },
]

/** The dashboards, in order. The home page's deck is this, not `PAGES`. */
export const DASHBOARDS = PAGES.filter((page) => page.kind === 'dashboard')

export const pageByKey = (key) => PAGES.find((page) => page.key === key)
