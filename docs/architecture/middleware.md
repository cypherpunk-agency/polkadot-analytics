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

`src/core/topology.js` is the other thing both sides need: para id to a name and a kind, and the
sovereign-account derivation that turns a para id into the exact account holding that chain's
money somewhere else. The derivation is verified — literal `para` / `sibl` bytes plus
trailing zeros, not a hash, checked against a live read in
[docs/platform/xcm.md](../platform/xcm.md). The name table is a *transcription*, says so, is
keyed by relay rather than by para id alone (para 1000 is Asset Hub on both networks and para
2000 is Acala on one and Karura on the other), and returns `null` rather than inventing a name
for an id it has never seen.

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
| `jobs` | optional. The store-backed half of that surface: `summary`, `schema`, `immutable(params)`, `nextBatch(ctx)` — see [jobs.md](jobs.md). It answers on the SAME URL shape and **wins over an `operations` entry of the same name**, so the two must never share one |

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

## Liveness: every source says how current it is

`transport` / `upstream` / `decode` catch an upstream that *fails*. They cannot catch the one
that succeeds and is wrong, and that failure is not hypothetical — one of our candidate sources
answers every query in 381 ms, with well-formed rows, and has not advanced a block since May.
Fast, complete, correctly shaped, and a picture of three months ago. Nothing in the error model
sees it, because nothing failed.

So a source asserts a second thing next to its data: **when this upstream last had something
new, and whether the payload just built reaches that far.** The contract is
`src/core/liveness.js`, imported by both runtimes for the same reason everything else in
`src/core/` is.

A source builds one with `liveness({ … })` and puts it on the payload as `meta.liveness` — a
single report, or an array when a page reads two upstreams:

| field | what it is |
|---|---|
| `source`, `label` | the source id, and the upstream's human name as `/api` shows it |
| `state` | `live`, `stale`, `frozen`, `unreachable` or `unknown` |
| `observedAt` | ms epoch — when we asked. Always present. |
| `headAt`, `head` | the newest datum the upstream admits to, as a timestamp and in its own words (`block 12,344,549`, `2026-08-18`) |
| `lagMs` | `observedAt - headAt`, or `null` when the upstream does not say |
| `staleAfterMs`, `frozenAfterMs` | this upstream's own thresholds — six-second blocks and a daily aggregate are not stale at the same age |
| `covers` | `{from, to}`: the window the payload actually covers, which is a different fact from the head |
| `note` | one sentence, when something needs saying |

Five states, and the last two are the ones that matter:

- **`frozen` is separate from `stale`** because they need different sentences. Stale means the
  indexer is behind and will catch up. Frozen means stop building on this.
- **`unreachable` is not automatically an error.** The Bulletin devnet is a single node and
  being down for a few minutes is one of its ordinary states.
- **`unknown` is a real third state and is never collapsed into `live`.** An upstream that
  exposes no head is not confirmed current; rendering it as a green tick is the original bug
  wearing a badge.

`liveness()` throws on a malformed assertion rather than returning a plausible object — same
discipline as `decodeAssetDetails`. A broken assertion renders as a confident pill, which is
worse than no pill.

The page side is `src/design/liveness.js`: `livenessNotes()` for the data-notes list,
`livenessPill()` for a heading, and `livenessBanner()` above the charts. The banner renders
**nothing at all** when every upstream is live — a green "all normal" box on every page is a box
readers learn to skip within a week, and then they skip the red one too.

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
