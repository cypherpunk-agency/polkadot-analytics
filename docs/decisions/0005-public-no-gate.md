# 0005 — Published publicly, with no authentication gate

**Status:** accepted · 2026-08-19 · decided by Tommi

## Context

House rule on this host is that nothing with data access is published without an auth gate:
oauth2-proxy in front, Google login, email allowlist. `analytics.cypherpunk.agency` is a
deliberate exception, decided explicitly.

## Decision

The site answers the open internet. No `google_auth`, no `basic_auth`, and the application has no
login of its own.

## Why it is safe here

Everything rendered is public on-chain or public-API data that anyone can pull from the same
endpoints anonymously. There is no user data, no account, no session and nothing about a visitor
stored anywhere. The service accepts no writes.

## What it obligates

Being ungated is what forces most of the engineering elsewhere in this repo:

- **No open proxy.** `/api/:source/:operation` resolves both segments against a static table.
  There is no path from a client-supplied string to a URL. See
  [security.md](../architecture/security.md).
- **Bounded everything.** Response size caps, cache bounds, timeouts, single-flight. On a shared
  2 GB VM, memory exhaustion here is a denial of service against unrelated services.
- **Upstream protection.** A cache is not an optimisation on an ungated URL; it is the thing
  standing between a volunteer-run devnet node and every visitor we get. This is why the Bulletin
  explorer's roughly 7,600-call signer resolution was deliberately not ported.
- **Edge rate limiting** on `/api/*`, requested at 30 requests per minute per IP.
- **Data selection.** Not everything that could be built here should be published here. A
  personal trading-history viewer and a live arbitrage research corpus were both excluded at
  scoping time for exactly this reason.

## Consequences

- No `X-Auth-Request-Email` header exists; nothing may be built against one.
- Anything added later that would not be fine on a billboard needs its own decision record, and
  probably its own gate.
