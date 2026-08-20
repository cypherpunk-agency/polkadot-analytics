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
// a small lie. Read the nav from `NAV` and the deck from `DASHBOARDS`.
//
// `group` folds a page into a nav group. `nav` is then the label INSIDE that group, so it says
// what the page is rather than repeating which chain it is about — see `GROUPS`.

/**
 * The nav groups, in the order their first member appears.
 *
 * Half the dashboards on this site are Hydration. Flat, that meant "Money market", "Wrap map"
 * and "Pegs & OTC" sat on the bar next to "XCM" and "Bulletin" as if they were peers — three
 * labels that name a subject without naming the chain, so the bar read as eight unrelated
 * things. Grouping is not tidiness: it is the only place that says those four pages are one
 * subject, and it puts the top level back down to a length a reader can take in.
 *
 * A group is never hand-listed. It collects whichever pages name it in `group`, so a group
 * cannot list a page that was never built, and a page cannot quietly fall out of one.
 */
export const GROUPS = [
  {
    key: 'asset-hub',
    nav: 'Asset Hub',
    // Made the moment the second Asset Hub page landed, which is what the note on `bridged`
    // said to do. Two pages, one question asked twice: what does Asset Hub actually custody —
    // once for what came in from another consensus system, once for what the parachains left
    // behind. Flat, "Bridged" and "Sovereign DOT" read as two unrelated subjects.
    blurb: 'What Asset Hub holds: assets bridged in from elsewhere, and the parachains’ own reserves.',
  },
  {
    key: 'hydration',
    nav: 'Hydration',
    // Shown at the top of the open panel. Not decoration: it is the only chance to say what
    // the four pages have in common before the reader has to guess from four short labels.
    blurb: 'Swaps, the lending market, and the machinery that holds the pegs.',
  },
]

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
    // This was standalone until `sovereign` landed, with a note saying that a second Asset Hub
    // page was the moment to make the group. It landed, so the group exists — see GROUPS. The
    // nav label inside the panel drops "Asset Hub", which the panel has already said.
    key: 'bridged',
    kind: 'dashboard',
    group: 'asset-hub',
    href: '/bridged/',
    nav: 'Bridged in',
    title: 'Bridged onto Asset Hub',
    blurb:
      'Everything that entered Polkadot from another consensus system, keyed by the XCM location its storage key spells out: which parachain holds each asset now, and where the holder balances do not add back up to the supply the pallet claims.',
    source: 'Polkadot Asset Hub RPC',
    live: true,
  },
  {
    key: 'sovereign',
    kind: 'dashboard',
    group: 'asset-hub',
    href: '/sovereign/',
    nav: 'Sovereign DOT',
    title: 'Parachain sovereign holdings, then and now',
    blurb:
      'What every parachain holds in its sovereign accounts today, read live from both legs — the relay and Asset Hub — set beside the archived study that ends in April 2023. The three years between them are drawn as the silence they are, not joined by a line.',
    source: 'Polkadot relay + Asset Hub RPC, and an archived dataset',
    live: true,
  },
  {
    key: 'hydration',
    kind: 'dashboard',
    group: 'hydration',
    href: '/hydration/',
    // "DEX activity", not "Hydration": inside the Hydration group the chain name is already
    // said by the thing that opened, and a panel reading "Hydration › Hydration" tells the
    // reader nothing about which of the four pages this is.
    nav: 'DEX activity',
    title: 'Hydration DEX activity',
    blurb:
      'Swaps on the Omnipool: the per-leg chain events as the trades people actually made, valued in dollars, over a window the page states in days and in blocks.',
    source: 'Hydration liquidity-pools squid (orca) + chain registry',
    live: true,
  },
  {
    key: 'hydration-market',
    kind: 'dashboard',
    group: 'hydration',
    href: '/hydration-market/',
    nav: 'Money market',
    title: 'Hydration money market',
    blurb:
      'Hydration’s lending market is an Aave v3 fork in EVM contracts, not a pallet. Every reserve with its rates, utilisation and caps; HOLLAR’s real supply and who is allowed to mint it; and the Omnipool balance sheet read the way that does not silently drop half of it.',
    source: 'Hydration RPC (eth_* plane)',
    live: true,
  },
  {
    key: 'hydration-wraps',
    kind: 'dashboard',
    group: 'hydration',
    href: '/hydration-wraps/',
    nav: 'Wrap map',
    title: 'Hydration’s wrap map',
    blurb:
      'Every form each asset exists in on Hydration — the token, the aToken the money market mints against it, and the share token of the pool that joins them — with the configured limits on each.',
    source: 'Hydration RPC (Substrate + EVM)',
    live: true,
  },
  {
    key: 'hydration-peg',
    kind: 'dashboard',
    group: 'hydration',
    href: '/hydration-peg/',
    nav: 'Pegs & OTC',
    title: 'Hydration pegs, the HSM, and the OTC book',
    blurb:
      'What every peg-aware stableswap pool currently believes an asset is worth, how stale that belief is, how HOLLAR’s peg is configured to be defended, and what is resting on the OTC book.',
    source: 'Hydration RPC + Bifrost',
    live: true,
  },
  {
    // A drill-down rather than a dashboard: it answers about ONE account, and it is reached by
    // clicking a name on a ranked list rather than from the nav. `kind: 'tool'` keeps it out of
    // the nav bar and the home index, both of which list things you can arrive at cold — this
    // page with no `address` has nothing to show.
    key: 'account',
    kind: 'tool',
    // `hidden` keeps it out of the nav bar (buildNav skips it) and `kind: 'tool'` keeps it out
    // of the home index (DASHBOARDS filters on 'dashboard'). Both are wanted: the nav and the
    // index list pages you can arrive at cold, and this one with no `address` has nothing to
    // show. It is reached by clicking a name on a ranked list.
    hidden: true,
    href: '/account/',
    nav: 'Account',
    title: 'Follow an account',
    blurb:
      'One account on Hydration: what flowed in and out by asset, the trades behind it, and how much of that account’s history the window actually covers.',
    source: 'Hydration orca indexer',
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
      'DOT and KSM held in parachain sovereign accounts, day by day from the first parachain to April 2023 — the Polkalytics study redrawn from its source CSVs, one line per chain on one shared scale, with the three places its own report and its data disagree.',
    // `live: false`, and back to it. This carried `live: true` for a day while the page also
    // read `asset-hub/sovereign-dot`; that half now has its own page (`sovereign`, above) and
    // this one reads nothing at run time again. The dataset is compiled into the bundle and its
    // newest number is from 2023-04-08, so a tile promising live data would be a plain lie —
    // which is the entire reason this flag exists.
    source: 'Archived Polkalytics dataset',
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

/**
 * The header nav: the same pages, with the grouped ones folded into their group.
 *
 * Derived from `PAGES` in `PAGES` order — a group is emitted where its first member sits and
 * collects every member wherever it sits. So the bar is reordered by reordering this file, and
 * a page cannot drop out of the nav by being moved.
 *
 * Two shapes come out, and both are PLAIN DATA on purpose:
 *
 *   { kind: 'link',  key, href, nav }
 *   { kind: 'group', key, nav, blurb, items: [ { kind: 'link', … }, … ] }
 *
 * `vite.config.mjs` hands this straight to the knowledge-base plugin, which renders the same
 * bar as static HTML at build time. Putting page objects in here would mean the two headers
 * were built from different things, which is exactly the drift this list exists to prevent.
 */
export const NAV = buildNav()

function buildNav() {
  const link = ({ key, href, nav }) => ({ kind: 'link', key, href, nav })
  const items = []
  const started = new Map()

  for (const page of PAGES) {
    if (page.hidden) continue
    if (!page.group) {
      items.push(link(page))
      continue
    }

    let group = started.get(page.group)
    if (!group) {
      const spec = GROUPS.find((candidate) => candidate.key === page.group)
      // Thrown at import, which means the dev server and the build both refuse to start. A
      // page quietly vanishing from the nav is the failure worth preventing here; this module
      // is imported by every page and by vite.config.mjs, so there is nowhere for it to hide.
      if (!spec) {
        throw new Error(`pages.js: "${page.key}" is in group "${page.group}", which is not in GROUPS.`)
      }
      group = { kind: 'group', key: spec.key, nav: spec.nav, blurb: spec.blurb, items: [] }
      started.set(spec.key, group)
      items.push(group)
    }
    group.items.push(link(page))
  }

  return items
}

export const pageByKey = (key) => PAGES.find((page) => page.key === key)
