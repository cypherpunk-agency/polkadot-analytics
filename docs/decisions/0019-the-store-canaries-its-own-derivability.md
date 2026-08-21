# 0019 — The store canaries its own derivability

**Status:** accepted · 2026-08-21 · decided when infra accepted the no-backup terms

## Context

This service's answer to backups is that there are none, and that this is fine.
[Decision 0006](0006-demand-driven-store.md) makes the store a **cache of public upstreams**, so a
lost volume costs a refill and nothing else. Infra accepted the volume on exactly those terms.

That position is a claim about **upstreams**, not about us, and nothing checks it. It holds for as
long as every stored segment can still be fetched again — and one of them is already thin. orca
publishes a floor for its `routedTrades` index: the oldest block from which it has grouped swap legs
into routed trades, **para block 6,837,788 at 2025-01-25T05:58:36Z** when this was written. Below
that floor it simply has nothing.

If that floor ever moves forward, the days we already stored beneath it stop being re-derivable and
the volume quietly stops being a cache. Nothing in the code would notice: every request still
answers, every chart still draws, the coverage bar still reads complete, and a redeploy onto a fresh
volume refills the series **short at its oldest end** and says nothing about it. Infra's own words,
and they are right: *"re-check the orca floor periodically: it's the one thing that turns their pure
cache into state, and neither side would notice."*

## Decision

**A job handler may declare a `canary`, and `/api/health` publishes what they say.**

```
canary: async ({ store, sourceId, operationId }) => ({
  subject,   // what is being watched, in a human's words
  state,     // 'ok' | 'at-risk' | 'unknown'   — 'unknown' is NOT 'ok'
  message,   // ONE sentence naming the CONSEQUENCE, not the reading
  detail,    // optional, JSON-serialisable: the numbers the message was built from
})
```

Three commitments in the shape:

- **It reports; it never throws.** A canary does not fail a request, does not flip `/healthz`, does
  not stop a job, and does not move `/api/health`'s top-level `ok`. CLAUDE.md's rule about failing
  loudly is about decoders — a wrong number that would render perfectly must fail rather than
  render. This is the opposite shape: the numbers are *right*, and what changed is that they can no
  longer be reproduced. Taking the site down over that destroys the thing it is protecting.
- **The comparison is against the STORE, not against a date.** "The floor moved" is not by itself
  actionable, and a hardcoded floor date is the usual trap — right until a retention policy moves
  it, and then wrong in a way that reads as a fact. What matters is the intersection: the floor
  moved *past days we are holding*. `server/lib/canary.mjs` knows nothing about floors; a handler
  asks its own upstream and asks the store what sits below the answer.
- **`unknown` is a real answer and is never collapsed into `ok`.** A canary that says everything is
  fine when it could not check is worse than no canary. Same reason `liveness` keeps its own
  `unknown`.

`canaries.ok` on `/api/health` is `true` / `false` / **`null`**: false when anything is at risk *or*
could not be checked, null when nothing has been checked yet. `/api/health` never calls an upstream
itself — a background tick runs the canaries at boot and every 15 minutes, and the endpoint
publishes the last answer with the time it was taken.

## Rejected

- **Put it in the liveness machinery** (`src/core/liveness.js`). The two are easy to confuse and are
  not the same caveat. Liveness is a caveat on a **payload**: does the data in front of this reader
  reach the upstream's head. It is computed from the same payload the charts are drawn from,
  rendered on the page, per request, **for a reader**. A durability canary is a caveat on the
  **volume**: a visitor to `/hydration/` cannot act on it and would not know what to do with it,
  whereas infra — the people who accepted "no backup" and asked to be told — read `/api/health` with
  alerting. Two audiences, two mechanisms.
- **Move `/api/health`'s top-level `ok` to false when a canary fires.** That is what an orchestrator
  and a load balancer read. A store that has stopped being re-derivable is a reason to talk to a
  human, not to restart a container or drain a healthy site.
- **Throw, or refuse to serve the affected days.** The days are still correct. Refusing to publish
  correct data because a *backup policy* assumption lapsed punishes the reader for an operations
  problem.
- **Nest `canaries` inside `store`.** Infra's runbook greps the response for the literal
  `"store":{...}`, and a nested array would quietly change what that matches. `store` answers "is
  mode A wired", the question a 503 makes you ask; `canaries` answers "is the volume still just a
  cache". Two questions, two keys.
- **Compare naively: "are there stored days below the floor?"** This is a false alarm on day one and
  therefore no alarm at all. A healthy store deliberately holds 2025-01-01…24 as
  `coverage: 'before-source-floor'` — the days orca has never had — so the naive check fires on the
  first boot, gets explained away once, and is ignored for ever after. The discriminator is the
  stored payload's own `coverage`: only a day holding **indexed content** that now sits below the
  floor has actually been lost.

## Consequences

- `server/lib/canary.mjs` (new) and `server/test/canary.test.mjs` (new). The runner never throws:
  a handler that throws, returns nothing usable, or returns an unrecognised state still produces a
  report, marked `unknown` and naming what went wrong.
- `hydration/swaps-daily` is the first and currently only canary. `asset-hub/netflows-daily` has no
  published floor to read — see research queue **O76** for what a probe-shaped canary would have to
  look like there.
- The operator-facing half is in
  [deployment.md](../architecture/deployment.md#get-apihealth); the handler-contract line is in
  [jobs.md](../architecture/jobs.md#the-handler-contract).
- **If this ever goes `at-risk`, 0006's no-backup position has expired for that operation** and the
  volume is the only copy of the days the message names. That is the trigger to decide on a real
  backup, not a thing to acknowledge and move past.
