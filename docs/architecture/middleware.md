# The shared layer

There are no independent apps in this repo. There is one data layer, one design system, and
pages thin enough that adding one is not a project. This document is what that means concretely
and why each piece is where it is.

## The shape

```
browser                                    server                          the world
─────────────────────────────────────────────────────────────────────────────────────────
src/pages/<name>/main.js                   server/index.mjs
  └─ src/core/client.js  ──── /api/… ───→    └─ server/sources/index.mjs
        (the ONLY fetch)                          └─ <source>.mjs  ──→  chain / indexer / API
  └─ src/design/*                                     └─ lib/cache.mjs
        (the ONLY styling)                            └─ lib/upstream.mjs
                                                      └─ lib/params.mjs
                    ╲                          ╱
                     ╲── src/core/ ───────────╱
                         shared by both: codec, pricing, the swap model
```

`src/core/` is imported by the browser bundle *and* by the Node server. That is not a
convenience — it is what makes "one shared library" true rather than aspirational. The files
there are pure functions over plain values with no DOM and no Node built-ins, so both runtimes
can use them unchanged. When the server aggregates Hydration swaps it calls the same
`aggregate()` the browser would have called.

## The source registry is the security boundary

`server/sources/index.mjs` is the only place an upstream hostname exists. `/api/:source/:op`
resolves both path segments against that table before anything leaves the machine.

This matters because the site is **public and ungated**. A service that forwarded a
client-supplied URL would be an open proxy and an SSRF hole. Here there is no code path from a
client string to a URL: the client names an *operation*, the server owns the query.

Each source module declares:

| field | what it is |
|---|---|
| `id`, `label`, `homepage` | identity, shown on the front page and at `/api` |
| `transport` | `graphql`, `jsonrpc`, `rest`, or a combination |
| `covers` | which chains or networks it can speak for |
| `operations` | the callable surface: `summary`, `ttlMs`, `schema`, `run(params)` |

`schema` is validated by `lib/params.mjs`, which **rejects** out-of-range values rather than
clamping them — a page that asks for 5,000 days and silently gets 90 draws a confident, wrong
chart. The normalised parameters are also the cache key, so `days=7` and `days=07` cannot
become two entries that each halve the hit rate.

`/api` serves a description generated from this same table, so the documentation of the API
cannot drift from what the API will answer.

## Why anything is server-side at all

Two independent reasons, either of which would be sufficient.

**The CSP.** Production serves `default-src 'self'` with no exceptions, including
`connect-src 'self'`. A page fetching an indexer directly does not error — the document renders,
every request returns 200, and the chart is empty. That is the worst failure mode available, and
the fix is architectural rather than vigilance.

**The load.** These dashboards are heavy clients by design. The Bulletin index is ~40 RPC calls;
its full explorer would be ~7,600. Hydration is ~80 archive pages for a three-day window. Served
straight to the browser at a public URL, every visitor repeats that against a volunteer-run node.
Cached server-side, every visitor shares one snapshot.

The cache is TTL plus **single-flight**: ten simultaneous cold requests for the same key produce
one upstream call. Without that, the cache makes a thundering herd worse, because a cold cache is
exactly when traffic spikes. It is also bounded — the container has a 256 MB ceiling, and an
unbounded cache keyed on user-supplied parameters is a memory-exhaustion vector that fails as an
OOM crash-loop rather than an error.

## Transports, and the seam for more

Three exist today, all in `lib/upstream.mjs`:

- **`graphql`** — POST, with the `errors` array treated as a real failure rather than a warning.
- **`jsonRpc`** — anonymous Substrate JSON-RPC over HTTPS POST.
- **`rest`** — GET with a server-built query string.

Adding a fourth is a function in that file plus a `transport` value. Two are worth naming:

**A light client (smoldot) would have to run server-side.** In the browser it needs WebSocket
connections to bootnodes, which `connect-src 'self'` forbids — the same policy that forces
everything else through the proxy. Running it in the container is possible but expensive on a
2 GB VM shared with several services; it would need a memory conversation before a code one.

**Web sources** — scraped pages, RSS, third-party JSON — fit the `rest` transport as-is. The
constraint that matters is not technical: anything read from the open web is untrusted input,
and it must not be rendered as HTML or trusted as an instruction. Build it as DOM with text
nodes, the way the chart tooltips do.

## Failures keep their shape

`transport` (we could not reach them), `upstream` (they answered, with an error) and `decode`
(they answered with something we cannot read) never collapse into one "error". They mean
different things to a reader and imply different actions:

- transport → their outage, wait
- upstream → their error, possibly our request
- decode → a format changed, our bug

The server maps them to 502 (not 500 — this service is fine), and `ApiError.advice` in
`src/core/client.js` turns each into a sentence a non-engineer can act on. `renderPage()` puts
that on screen instead of "failed to load".

## The canonical swap model

`src/core/swaps.js` defines one `Trade` shape and one `aggregate()` over it. HyperFX (intent
orders bridged across five EVM chains) and Hydration (an Omnipool on a parachain) share nothing
at the protocol level and everything at the reporting level: somebody sent one asset and received
another, at a time, on a venue.

So both sources normalise into `Trade[]`, both call the same `aggregate()`, and both pages call
the same `renderSwapDashboard()`. `src/pages/hyperfx/main.js` is fifteen lines. Adding a third
DEX means writing a normaliser; it does not mean writing another dashboard.

The labels that genuinely differ travel in `meta` as data, not as branches — HyperFX counts
"orders" stacked by "chain the order was placed on"; Hydration counts "trades" stacked by "how
the trade was initiated".

## Adding things

**A data source.** One module in `server/sources/`, one line in `index.mjs`. It appears at `/api`
and on the front page automatically.

**A dashboard.** An entry in `src/sources/pages.js`, a `<name>/index.html`, and a
`src/pages/<name>/main.js` that calls `renderPage()`. Vite discovers the directory; the nav and
the home index read the same list, so a page cannot exist without being listed and a nav entry
cannot point at nothing.

**A chart form.** `src/design/charts.js`. Read
[design-system.md](design-system.md) first — the palette is validated, not chosen.
