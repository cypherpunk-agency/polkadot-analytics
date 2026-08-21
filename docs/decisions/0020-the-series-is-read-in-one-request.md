# 0020 — The series is read in one request, and the rest arrives over a stream

**Status:** accepted · 2026-08-21 · decided after production 429'd its own page

## Context

Decision [0012](0012-netflows-is-a-store-plus-a-live-tail.md) chose a calendar month as the store
identity for the daily netflows series and stated its cost plainly: up to sixty-two requests per
page load, "fine now and will not be in 2029", filed as research queue O41 to revisit "before it
is urgent".

It became urgent on 2026-08-21, and not in 2029's way. The edge rate-limits `/api/*` at 30
requests per minute per IP ([security.md](../architecture/security.md)) — a policy written when
"a legitimate full page load is a handful of `/api` hits" was true. `/netflows/` had grown into
~56 hits per load, so the limiter cut the page off mid-fan-out: months 2022-01 → 2024-06
answered 200, everything after answered a bodyless 429 from the edge, and the page rendered its
own error state. The page was DoSing itself, politely, through its own front door. The client's
`MONTH_CONCURRENCY = 6` bounded simultaneity, not count, which is no defence against a per-minute
quota — and the structural flaw is that the request count grew by one every month, forever, so
*any* fixed quota would eventually be crossed.

## What was decided

**The storage identity does not change. The read layer composes.** Three pieces:

1. **`asset-hub/netflows-series`** — a *store-read operation* (a new third dispatch shape in
   `server/index.mjs`, `store: true`): every settled month of one network in one response. Each
   month is served through the same `serveFromStore` the per-month endpoint uses — a function
   call instead of an HTTP request, and deliberately the SAME function, so find-or-create, the
   reader-priority raise, the `gave-up` refusal and the live-jobs cap apply to one aggregate GET
   exactly as they applied to fifty-six. One page load can still mint at most
   `MAX_LIVE_JOBS_PER_OPERATION` jobs. Completeness is the cache policy: complete → `max-age=300`,
   incomplete → `no-store`. A TTL'd (mode B) aggregate was structurally wrong here twice over —
   `run(params)` cannot reach the store, and its `ttlMs` becomes a browser `max-age` that would
   hand a polling reader their own cache.

2. **`/api/stream/<source>/<operation>`** — an *identity watch* over Server-Sent Events, declared
   per job handler as `watch` (event name, params schema, params→identities). A reader answered a
   partial series subscribes with the months it lacks and is handed each month's complete
   envelope — the same envelope the HTTP endpoint answers, so stream and fetch are one decoding
   path — as it lands. The watch is **read-only by contract**: it calls `storedAnswer` (the
   read-only sibling of `serveFromStore`) and never enqueues, raises, or spawns. Reading is what
   creates demand; holding a connection open must not hold a job open. It polls local SQLite on a
   slow tick (there is no job-completion event in this service, deliberately — the worker writes
   and exits), heartbeats for proxies, caps concurrent watches and its own lifetime, reports a
   `gave-up` identity as `stalled` rather than watching it forever, and is ended cleanly on
   shutdown so a redeploy does not ride the force-exit timer.

3. **`followStore` (`src/core/follow.js`)** — the client choreography, shared so the next page
   does not reinvent it: subscribe; fall back to slow-polling the aggregate when the stream
   cannot be established or errors repeatedly with zero frames delivered (the buffering-proxy
   signature); apply re-deliveries idempotently; stop on done/complete/lifetime. A proxy that
   buffers SSE downgrades the page to polling — it cannot break it.

`/netflows/` now makes **two** requests in steady state (aggregate + live tail) and three on a
cold store (+ the stream). The page draws immediately with gaps, states "N fetches are in
flight" from the same payload the chart uses, and fills itself as months land — no reload.
Verified end-to-end on 2026-08-21 against a seeded store with three months held back and landed
late: exactly 3 requests, both late months arrived over the stream, zero polls, and the live
tail was read from the real public RPCs during the same page load.

## What was rejected

- **A coarser identity for closed years** — O41's own sketch. It means two identities over the
  same days, which is the duplicated-segments mistake [jobs.md](../architecture/jobs.md) names
  as the expensive one, and it re-fetches history that is already stored. The read-layer
  composition gets the same wire result without touching a single stored fact.
- **Raising the edge limit** (burst ~120). One line of Caddy config, but it erodes the limit's
  purpose, and the next long-history page crosses it again. The limit's premise — a page load is
  a handful of hits — is worth restoring, not abandoning.
- **Client-side pacing under the quota.** Turns page load into a two-minute crawl to preserve a
  request pattern that was never a goal in itself.
- **WebSockets** for the fill-in. The need is strictly server→client; a zero-dependency server
  would have to hand-roll the upgrade handshake and frame protocol (hundreds of subtle lines of
  attack surface on a public anonymous endpoint); a WS upgrade sits outside the edge rate
  limiter's model; and `connect-src 'self'` covers `EventSource` unambiguously while WS depends
  on CSP3 scheme-matching — exactly the silently-failing edge this project keeps getting bitten
  by. SSE is a plain HTTP response: ~1 request against the quota, streams through Caddy and the
  Vite dev proxy as-is, and `EventSource` reconnects itself.
- **A pub/sub layer so the stream needn't poll.** The drain worker opens its own SQLite
  connection and exits when idle; wiring an event channel across that boundary buys freshness in
  milliseconds for a chart that fills over minutes, at the cost of the first piece of standing
  infrastructure in an otherwise request-shaped service. The slow tick against a local indexed
  aggregate is microseconds per connection.

## Refined by adversarial review, same day

A 31-agent review of the change confirmed six defects, all fixed before landing; the two worth
remembering shaped the protocol itself:

- **`done` carries a machine-readable `reason`** (`complete` | `lifetime` | `failure`), and the
  client stops following only on `complete` — anything else downgrades to polling. The first
  version distinguished "finished" from "the watch ended with months pending" only in prose,
  which the client cannot read, so every lifetime cap orphaned a mid-fill page.
- **Shutdown severs the stream with no `done` frame at all.** A severed stream is what
  EventSource reconnection exists for: the browser waits out the `retry:` hint and re-subscribes
  to the new instance. The original farewell frame read as completion and turned every redeploy
  into a page-wide unsubscribe.

The rest: the aggregate gained single-flight (concurrent identical requests share one ~megabyte
composition) and a per-month event-loop yield (sub-512-row reads never trip the store's own);
the watch's `identities` filters out months the settle predicate refuses, so an unlandable month
cannot pin a watch slot for its lifetime; a connection that stops reading is dropped at a 4 MB
write-buffer high-water mark; stalled (gave-up) months are counted and *named* on the page
instead of reading as "in flight"; the aggregate names the one-hour-per-month `pending` window
in which the newest whole month is too old for the tail and too young for the store; and the
client's follow polls at 60 s under a 30-minute cap, surfacing every non-complete ending in the
page's own copy.

## Consequences

- `server/index.mjs` gains the third dispatch shape (`serveStoreRead`) and the reserved `stream`
  segment; `scripts/check.mjs` enforces both registry contracts (`store: true` excludes `ttlMs`;
  a `watch` must carry `event`, `schema`, `identities`).
- `demand.mjs` exports `storedAnswer` — the read-only completeness probe the stream is built on.
- The per-month endpoint `/api/asset-hub/netflows-daily` is unchanged and remains the demand and
  warm path; `netflowsSettledMonths` is the single derivation of "which months exist", shared by
  `warm()`, the aggregate, and the page (which no longer derives the list from the reader's
  clock at all).
- `/hydration/` has the same fan-out disease (per-month `swaps-daily` reads) and is the intended
  second adopter of all three pieces — filed as research queue O83.
- The edge rate limit's premise is true again, and [security.md](../architecture/security.md)
  says so with this decision as the reason.
- Whether production's Caddy passes `text/event-stream` unbuffered is **unverified from this
  repo** (the Caddyfile lives in infra's repo). It streams by default in Caddy 2, the response
  sets `x-accel-buffering: no` for nginx-family middleboxes, and the polling fallback makes the
  answer non-fatal either way — but it is worth one probe after the next deploy; see
  [deployment.md](../architecture/deployment.md).
