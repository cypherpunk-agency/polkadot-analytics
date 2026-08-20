# Security and exposure

`analytics.cypherpunk.agency` answers the open internet with **no authentication gate**. That is
a deliberate decision, recorded in [decisions/0005-public-no-gate.md](../decisions/0005-public-no-gate.md),
and it is the fact every other decision here follows from.

## What is exposed

Everything this site renders is public on-chain or public-API data that anyone can pull from the
same endpoints anonymously. There is no user data, no account, no session, no cookie, no
analytics beacon and no logging of visitors beyond whatever the reverse proxy keeps.

The service accepts **no writes**. `GET` and `HEAD` only; every other method gets a flat 405
rather than a code path.

## What is not exposed, because it does not exist

**There are no secrets in this repository and there is no mechanism to hold one.**

- No API key, token, service-account file, mnemonic or password.
- No `.env`, and no `.env.example` either — there is nothing to configure.
- The container needs no secrets file mounted, no environment beyond `PORT`/`HOST`, and no
  persistent volume.
- Every upstream is anonymous public HTTP. Parity's Dotlake declares optional bearer auth in its
  OpenAPI document; we use the anonymous alternative, verified working.

This is enforced rather than promised. `npm run check` and CI fail on credential-shaped files,
and `.gitignore` carries `.env`, `*.pem`, `*-key.json` and friends as a tripwire — if one of
those ever matches something real, the answer is to delete the file and rethink, not to rely on
the ignore.

## The CSP

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'; object-src 'none'
```

No external origins at all. No CDN, no Google Fonts, no third-party scripts, no beacons.

`connect-src 'self'` is the load-bearing one and it is the reason the architecture looks the way
it does: **the browser may talk to this origin and nothing else**, so every chain, indexer and
API is read server-side. See [middleware.md](middleware.md).

Two things about this policy that have already caused a bug or would have:

- **It fails silently.** A blocked `fetch` or a blocked inline style does not error the page. It
  renders, returns 200 everywhere, and quietly does nothing. `style-src 'self'` blocking
  `setAttribute('style', …)` made every bar on the site render at zero width; the fix is in
  `src/design/dom.js` and the explanation is in [design-system.md](design-system.md).
- **The server sets it too, not just Caddy.** A security header that exists in only one
  deployment is a header you cannot reason about. `npm run preview` gets the same policy the
  production edge does, which is how the zero-width-bar bug was caught locally rather than after
  a deploy.

## Not an open proxy

The obvious risk of "a public service that fetches things" is that it becomes a free relay or an
SSRF pivot. It cannot:

- `/api/:source/:operation` resolves **both** segments against a static table in
  `server/sources/index.mjs`. There is no code path from a client-supplied string to a URL.
- Query text for GraphQL sources lives server-side. The client names an operation; it cannot
  send a query.
- JSON-RPC methods are whatever the source module calls, not whatever the client asks for.
- Every parameter is validated against a declared schema, with out-of-range values **rejected**
  rather than clamped.
- No request header, cookie or credential from the visitor is forwarded anywhere.

## Resource limits

The target VM is a 2 GB `e2-small` shared with several other services, so exhausting memory is a
denial of service against unrelated things.

- Upstream responses are read through a **size cap** and abandoned past it. An archive query with
  a mistaken filter returning tens of megabytes would otherwise be an OOM crash-loop, not an
  error message.
- The cache is bounded by both entry count and approximate bytes, and evicts coldest-first. An
  unbounded cache keyed on user-supplied parameters is a memory-exhaustion vector on a public URL.
- Single-flight means N concurrent cold requests produce one upstream call, not N.
- Every upstream call has a timeout.
- A rate limit on `/api/*` is requested at the edge — 30 req/min per IP, burst 60. With the cache
  in place a legitimate full page load is a handful of `/api` hits, so that is generous for a
  human and useless for a scraper.

## Being a good citizen upstream

This is not a security property but it belongs in the same conversation. The endpoints this site
reads are run by other people, some of them volunteers, and none of them agreed to serve us.

- Every operation is cached for at least two minutes; most for ten or fifteen.
- Paging is sequential, not parallel — one request at a time, once per TTL.
- The Bulletin index is ~40 RPC calls per ten minutes for all visitors combined. The full
  explorer's ~7,600-call signer resolution is deliberately **not** ported: it is a reasonable
  thing for one person to opt into in a local tool and an unreasonable thing to do on every load
  of a public page.
- The Hydration window is capped at seven days for the same reason, and the page says so rather
  than presenting it as a preference.

## Untrusted input

Everything read from an upstream is data, never markup and never an instruction. Token symbols,
account labels and chain names come from permissionless registries — anyone can register an asset
called `<script>`. They are rendered as text nodes, never concatenated into HTML. The one place
HTML strings were used (chart tooltips) was converted to DOM construction.

The Bulletin page classifies stored bytes but never renders them: the explorer this came from
deliberately shows SVG from a permissionless store as *text*, because an inline SVG is a
script-execution vector. That discipline carries over.
