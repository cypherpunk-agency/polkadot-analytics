# 0001 — A container with a caching proxy, not a static bundle

**Status:** accepted · 2026-08-19

## Context

The site is a set of read-only dashboards over third-party public APIs. No ingest, no events, no
database, no writes. On the face of it that is a `dist/` on a file server.

## Decision

Ship a container: the static build plus a small Node server that also serves a cached, read-only
API over an allowlisted set of upstreams.

## Why

**The CSP would have broken it silently.** The house policy on this host is `default-src 'self'`
with no external origins. The dashboards read four third-party endpoints from the browser. Under
that policy every one of those fetches is blocked — and blocked the silent way: page renders,
200 everywhere, every chart empty.

The alternative was a `connect-src` exception on the site's Caddy block listing those origins.
Rejected because it punches a hole in the house CSP, makes every new data source a pull request
against the infrastructure repo, and — the deciding reason — leaves no server-side cache.

**The cache is the real argument.** These pages are heavy clients by design. The Bulletin index
is about 40 RPC calls; its full explorer would be about 7,600 against a single shared devnet
node, and the explorer's own source says a client doing that would be the heaviest client on the
chain. Hydration is about 80 archive pages for a three-day window. One person opening a local
tool is fine. A public URL with no gate repeating that per visitor is a denial-of-service with
our name on it, aimed at infrastructure run by volunteers.

A 2–15 minute TTL turns N visitors into one upstream fetch.

## Consequences

- Roughly 70–90 MB RSS on a VM with a 256 MB budget for this service. Measured at 55 MB idle.
- The upstream allowlist lives in this repo, so adding a data source touches nothing else.
- The CSP stays a pure `default-src 'self'` with no exceptions.
- Upstream CORS stops mattering entirely — the browser never talks to them.
- One more moving part to deploy and monitor than a static bundle.
