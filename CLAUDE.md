# polkadot-analytics

Public analytics dashboards over Polkadot ecosystem data, at
[analytics.cypherpunk.agency](https://analytics.cypherpunk.agency). Also a knowledge base: the
`docs/platform/` notes exist so questions about XCM, Asset Hub, contracts, the People Chain,
Hydration, Hyperbridge and Bulletin can be answered from this repo without going and reading a
chain first.

**This is not an app built on the Polkadot SDK.** It reads public chains, indexers and APIs and
draws the result. It may use the SDK if something genuinely needs it; nothing does yet.

## The three rules

**1. No secrets. Ever.** There is no API key, no token, no service-account file and no `.env`
anywhere in this repo, and there must not be. Every upstream is anonymous public HTTP. If you
find yourself wanting a credential, that is a design conversation, not a `.env` line — say so
before writing any code. `npm run check` fails the build on credential-shaped files.

**2. The browser talks only to this origin.** Every upstream call happens server-side. This is
enforced, not hoped for: `npm run check` fails if an absolute URL appears outside
`server/sources/`. Two reasons — the production CSP is `connect-src 'self'`, so a direct fetch
would fail *silently* (page renders, 200 everywhere, chart empty); and the pages are heavy
clients that would otherwise DoS a volunteer-run devnet node once per visitor.

**3. Say what is wrong with the number.** Every page carries a data-notes section generated from
the same payload the charts are drawn from. An unpriced asset, an interpolated timestamp, a
pallet account in a "top traders" list, a dollar figure that is really a floor — these get
stated on the page. A number without its caveat is worse than no number.

## Layout

```
server/                 the API. Node 22, zero runtime dependencies.
  index.mjs             static files + /api + /healthz
  lib/                  cache (TTL + single-flight), upstream calls, param validation
  sources/              ONE MODULE PER UPSTREAM — the security boundary, see below
src/
  core/                 shared by browser AND server: codec, pricing, swap model, API client
  design/               the design system. Every page is built from this and adds no CSS.
  sources/pages.js      the site map — nav and home index both read it
  pages/<name>/main.js  one entry per dashboard, mostly ~20 lines
  data/                 committed derived datasets (netflows)
docs/
  architecture/         how this repo works
  platform/             how POLKADOT works — the knowledge base
  decisions/            why we chose what we chose
<name>/index.html       one directory per page; the directory IS the URL
```

## Where to start for a given task

| Task | Start here |
|---|---|
| Add a data source | `server/sources/` — add a module, register it in `index.mjs`. Nothing else changes. |
| Add a dashboard | `src/sources/pages.js` + a `<name>/index.html` + `src/pages/<name>/main.js`. Vite discovers the directory. |
| Change how anything looks | `src/design/tokens.css`. Nothing else names a colour or a size. |
| Add a chart form | `src/design/charts.js`. Read `docs/architecture/design-system.md` first — the palette is validated, not chosen. |
| Understand a chain | `docs/platform/` |
| Deploy | `docs/architecture/deployment.md` |

## Working agreements

- **Storage keys are computed, never hardcoded.** A hardcoded prefix is right until a runtime
  upgrade moves it, and then reads as "this map is empty" rather than as an error. See
  `server/sources/hydration.mjs` and `bulletin-chain.js`.
- **Decoders self-check.** `decodeAssetDetails` throws if it does not consume its input exactly,
  and the registry is verified against three known assets before any price is computed. Wrong
  decimals are a silent factor of 10ⁿ on every total on the page — they must fail loudly.
- **Never set styles with `setAttribute('style', …)`.** Under `style-src 'self'` the browser
  silently drops it and every proportional bar renders at zero width. Use the `style` prop on
  `el()`/`svg()`, which routes through CSSOM. This has already bitten once.
- **No inline `<script>`, no CDN, no webfonts, no external anything.** The CSP forbids it and it
  fails silently, not loudly.
- **`null` is not `0`.** "We could not value this" and "this was worth nothing" are different
  facts and the arithmetic must keep them apart. Same for a chart series: a missing value breaks
  the line, it does not draw to zero.
- **Empty days are drawn, not dropped.** A gap in activity is information.
- **Bars are linear from zero.** A log scale on a ranking makes a long tail look like a
  distribution of equals.
- **One y-axis. Never two.**
- Prefer plain, boring frontend. There is no framework and there does not need to be.

## Running it

```bash
npm install
npm run dev       # Vite on :5180, API on :8080, /api proxied
npm run preview   # production build + the real server on :8080
npm run check     # syntax, secret scan, source-registry and no-external-URL checks
```

## Facts worth not re-deriving

- Hydration emits **one `Broadcast.Swapped3` per swap LEG**. Legs of one trade share the first
  element of `operationStack`. Not grouping them multiplies volume by the hop count.
- Hydration accounts beginning with hex `6d6f646c` are `modl` — pallet accounts, not people.
  On a normal day two thirds of the "trades" are the fee processor and DCA machinery.
- **Hydration's Omnipool hub asset (id 1) is `H2O`, not LRNA.** It was renamed; a lot of writing
  about Hydration, including its own older material, still says LRNA. The registry is the
  authority and it says H2O.
- `operationStack` variants **verified live in runtime 435** are `Omnipool`, `Router`, `DCA` and
  `Batch`. `Direct` is ours, for a leg with no stack. `ICE` appears in third-party writing about
  Hydration but has **no pallet, no storage and no metadata presence** — do not report it as a
  category. The code uses whatever the chain sends rather than mapping onto a fixed list.
- **Bulletin's `RETENTION_BLOCKS = 201_600` is inherited, not verified here.** On the sibling
  chain `paseo-bulletin-next`, `AuthorizationPeriod` is *also* 201,600 while `RetentionPeriod`
  differs — so a wrong transcription would be completely invisible. Settle it by reading the
  `TransactionStorage` constants out of `state_getMetadata`.
- The Bulletin devnet is a **single node and it does go down** (observed unreachable for several
  minutes on 2026-08-19). Unreachable is an ordinary state, not an error to retry through.
- HyperFX's own headline volume is cumulative protocol dust × 2,000, not a sum of its orders.
  This site sums the orders, and the two disagree.
- USDC and USDT are **18 decimals on BNB Chain and 6 everywhere else**. Keying decimals by
  symbol rather than by chain is a factor-of-a-trillion error that renders perfectly.
- Dotlake's `total_value_usd` is `0.0` for anything it cannot price, which is indistinguishable
  from a message that moved nothing. Treat it as a floor.
- The Bulletin devnet RPC is `bulletin-paseo.tservices.es:8443`. **Not**
  `paseo-bulletin-next-rpc.polkadot.io` — a different chain, which renders a plausible and
  entirely wrong view.
