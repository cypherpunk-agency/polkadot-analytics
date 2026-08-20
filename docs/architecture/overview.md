# How this repo is put together

One site, five dashboards, one data layer, one design system. This is the map; the pieces have
their own documents.

## Request path

```
visitor → Caddy (TLS, CSP, rate limit)
        → container: server/index.mjs
             ├─ GET /                static: dist/index.html
             ├─ GET /xcm/            static: dist/xcm/index.html
             ├─ GET /healthz         "ok" — never touches an upstream
             ├─ GET /api             the source registry, self-described
             ├─ GET /api/health      app layer wired + cache statistics
             └─ GET /api/:src/:op    validate → cache → source module → upstream
```

The browser loads a document and one JavaScript bundle, then makes one or more `/api` calls.
It never calls anything else — see [security.md](security.md).

## Directories

| path | what it is |
|---|---|
| `<name>/index.html` | one directory per page; the directory **is** the URL. Vite discovers them. |
| `src/pages/<name>/main.js` | the page. Usually about twenty lines: fetch, hand the payload to a renderer. |
| `src/sources/pages.js` | the site map. Header nav and home index both read it. |
| `src/design/` | tokens, components, DOM helpers, the page harness, the chart kit. |
| `src/core/` | pure modules shared by browser and server: codecs, pricing, the swap model, the API client. |
| `src/data/` | committed derived datasets. |
| `server/` | the API. Node 22, no runtime dependencies. |
| `server/sources/` | one module per upstream — the allowlist and the security boundary. |
| `scripts/` | dataset builders and `check.mjs`. |
| `docs/platform/` | how Polkadot works. The knowledge base. |
| `docs/decisions/` | why we chose what we chose. |

## The five things worth knowing

**1. Everything upstream happens server-side.** Two independent reasons: the production CSP is
`connect-src 'self'`, so a direct browser fetch fails *silently*; and these pages are heavy
clients that would otherwise hammer volunteer-run infrastructure once per visitor. See
[middleware.md](middleware.md) and [decision 0001](../decisions/0001-containerised-not-static.md).

**2. Sources return finished aggregates.** `src/core/swaps.js` is imported by both runtimes, so
the server runs exactly the aggregation the browser would have. See
[decision 0004](../decisions/0004-server-side-aggregation.md).

**3. Two very different venues share one dashboard.** HyperFX and Hydration normalise into the
same `Trade` shape, so `renderSwapDashboard()` draws both. Adding a DEX is a normaliser, not a
dashboard. See [decision 0002](../decisions/0002-one-shared-library.md).

**4. The palette is validated, not chosen.** Eight categorical hues that pass colour-vision
separation and contrast checks in both light and dark, assigned in fixed order and never cycled.
See [design-system.md](design-system.md).

**5. Caveats are generated, not written.** Every page's data-notes section is built from the same
payload the charts are drawn from, so it cannot describe a different dataset than the one on
screen. An unpriced asset, an interpolated timestamp, a pallet account in a "top traders" list —
these are on the page, not in a footnote nobody reads.

**How current** is one of those caveats, and it travels the same way: a source puts a
`meta.liveness` assertion next to its data and the page renders it, so "this upstream last had
something new N hours ago" is on the page rather than assumed. It is the one failure the error
taxonomy cannot see — an upstream that answers fast, completely and correctly with rows from
three months ago — and it needs saying even when the answer is "this is an archive and it stopped
in 2023". See [middleware.md](middleware.md#liveness-every-source-says-how-current-it-is).

## Adding things

| I want to… | Do this |
|---|---|
| add a data source | one module in `server/sources/`, one line in its `index.mjs` |
| add a dashboard | an entry in `src/sources/pages.js`, a `<name>/index.html`, a `src/pages/<name>/main.js` |
| add a DEX to the swap dashboard | a normaliser that emits `Trade[]`; no page code |
| change the look | `src/design/tokens.css` |
| add a chart form | `src/design/charts.js`, after reading [design-system.md](design-system.md) |

`npm run check` enforces the invariants: no credential-shaped files, every source module
conforming to the registry contract, and no third-party URL anywhere the browser could reach one.

## Related documents

- [middleware.md](middleware.md) — the shared data layer, transports, failure taxonomy
- [design-system.md](design-system.md) — tokens, palette validation, chart rules, the CSP trap
- [security.md](security.md) — public exposure, CSP, not-an-open-proxy, resource limits
- [deployment.md](deployment.md) — image, health checks, push-to-deploy
- [../platform/](../platform/) — how the chains themselves work
