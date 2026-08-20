# 0004 — Aggregate on the server, render in the browser

**Status:** accepted · 2026-08-19

## Context

The `yolodot` dashboards fetched raw records and aggregated them in the browser. For HyperFX that
is about 750 orders and entirely reasonable. For Hydration a three-day window is about 35,000
swap legs and roughly 25 MB on the wire; the Bulletin index is 4,800 records across 4,000 storage
keys.

## Decision

Sources return a finished aggregate. The browser renders it and does no arithmetic over raw
records.

## Why

- **Payload.** Hydration's aggregate is about 50 kB against about 25 MB of raw legs.
- **Cost to upstreams.** The fetch happens once per TTL rather than once per visitor. This is the
  same argument as [0001](0001-containerised-not-static.md) and it is the dominant one.
- **One implementation.** `src/core/swaps.js` is shared, so the server runs exactly the
  aggregation the browser would have. There is no second code path to disagree.
- **Trimming is explicit.** `trimForWire()` cuts the account and route lists to what a page
  actually draws — but the **totals are computed before the trim and are untouched by it**, so
  "top 4 share" stays a share of everything rather than a share of what survived. The payload
  carries `accountsTotal` so the page can say what it is not showing.

## Consequences

- A page cannot re-slice the data client-side. Filtering means a parameter and a round trip,
  which is why filter controls navigate rather than mutate in place — the choice ends up in the
  URL, where it can be linked, bookmarked and reported in a bug.
- Aggregation bugs are server-side, which is where tests can reach them.
- The browser bundle stays small: about 50 kB gzipped for the whole site.
