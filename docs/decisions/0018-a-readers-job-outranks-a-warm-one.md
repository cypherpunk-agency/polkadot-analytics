# 0018 — A reader's job outranks a warm one

**Status:** accepted · 2026-08-21 · decided after boot warming went live in production

## Context

[Decision 0014](0014-the-store-gets-a-volume-and-fills-itself.md) gave the store a volume and made
it fill itself: any handler that declares `warm()` gets its identities enqueued at boot. That
shipped inert and became live on 2026-08-21, at which point a cold volume enqueues **135
identities before anybody visits** — 116 `asset-hub/netflows-daily` and 19 `hydration/swaps-daily`.

`claim()` was `ORDER BY id LIMIT 1`. That was correct for as long as a reader's own request was the
only thing in the queue, which it had been for the whole life of the queue up to that morning.

The result, measured in production the same day: a reader asking for
`netflows-daily?month=2026-07&network=polkadot` got **job 74 of 135, `queued`**, behind roughly two
hours of work nobody had asked for, for a month that takes about 45 seconds on its own.

Nothing looked broken while it happened. Jobs 1 and 2 were `done`, every request answered `200`
carrying a correct coverage envelope, the queue was draining exactly as designed, and the page
simply never filled. `MAX_LIVE_JOBS_PER_OPERATION` exists to protect readers and warming is
deliberately exempt from it — which in this failure makes things *worse* rather than better, because
the exemption is what lets 135 jobs get in front of somebody.

## Decision

**Jobs carry a priority, and the fix is at the point of claiming rather than at the point of
enqueueing.** Warming should still fill the store; it should just never be in front of a person.

`JOB_PRIORITY` in `server/lib/jobs.mjs`: `warm: 0` for anything speculative and the column default,
`reader: 10` for an HTTP request, a CLI `enqueue`, or anything else a human is waiting on. They are
numbers rather than an enum so a third asker can sit between them without a migration.

`claim()` becomes `ORDER BY priority DESC, id`. **Ordering, never filtering** — a warm job is
claimed the instant no reader is waiting, so no backfill is slowed down and the total work is
unchanged. Within one priority the order is still insertion order, which is what it was before.

Three properties come with it, each of which is a way this would otherwise go wrong quietly:

- **Raise-only.** Find-or-create means a reader asking for an already-warmed month **joins** that
  job rather than minting a second one. So the only lever a reader has is the position of the row
  they joined, and `enqueue` / `raisePriority` therefore raise but never lower. Without that, the
  once-a-minute re-warm would put every lifted job back down sixty seconds later — correct answers,
  a full coverage bar, and a reader starved again for reasons invisible from anywhere.
- **A running job steps aside between batches, never inside one,** and goes back to **`queued`**
  with its cursor intact. It is re-claimed in the same drain the moment the reader is served, and
  nothing is refetched.
- **Strictly greater.** `hasRunnableAbove` uses `priority > ?`. Equal priorities must never yield to
  each other or two warm jobs hand the drain back and forth one batch each, for ever, with every
  batch correct and the queue never emptying.

## Rejected

- **Do not warm at all.** This hands back the cold-start problem 0014 exists to solve: a fresh
  volume that only fills on demand means the first visitor to every page pays for the whole
  backfill, which is the pre-0014 behaviour and is worse for readers in aggregate, not better.
- **Cap the warm list — warm only the most recent N months.** This makes the un-warmed half
  *strictly harder* to fetch than before warming existed. `MAX_LIVE_JOBS_PER_OPERATION` is counted
  per `(source, operation)` across all params, so N live warm jobs refuse every reader of that
  operation with "the queue is busy" — including readers of the months the cap chose not to warm.
  Already recorded in CLAUDE.md as its own trap; capping is that trap on purpose.
- **A second queue, or a second worker, for warm work.** This breaks the one-drainer /
  one-request-per-host politeness guarantee the whole engine rests on. Two drainers are two
  independent in-process gates pointed at the same volunteer-run node, and the gate is the reason
  this project is welcome on those endpoints at all.
- **Pre-empt mid-batch.** Rejected because the rows-and-cursor invariant is the reason this system
  is trustworthy: a batch of fetched rows and the cursor that covers them commit in one transaction,
  and there is no reachable state where one exists without the other. Interrupting a batch to serve
  a reader trades that away for at most one batch of latency.
- **Yield to `partial` rather than to `queued`.** `partial` is not in `RUNNABLE_WHERE`, so a job
  parked there would sit until something enqueued it again — and something would: the re-warm, a
  minute later, for a reason nobody could see from the outside. A state that only recovers by
  accident is not a state.

## Consequences

- `claim()` orders by priority; `enqueue` takes `{ priority }`; `raisePriority` and `yieldJob` are
  new; `hasRunnableAbove(priority)` is what the engine asks between batches.
  `server/lib/demand.mjs` raises on the request path, so a reader **joining** a warm job lifts it.
- **`scripts/job.mjs` enqueues at `reader` priority,** and its `list` gained a priority column. A
  maintainer typing `job enqueue` mid-backfill is as much a human waiting as a page is, and the
  deployment document's fill-it-elsewhere escape hatch runs through that command. Without the
  column, a starved reader is invisible at the CLI, which is how this took two hours to see.
- **Batch size is now a latency decision as well as a throughput one.** One batch is the longest a
  reader can be made to wait behind work nobody asked for: `swaps-daily` commits one day (~9 s),
  `netflows-daily` ten (~14 s), against whole months of 4.5 min and 45 s. That reasoning now lives
  at the top of `server/lib/job-worker.mjs` beside the batch loop.
- Measured on a 135-identity cold store with a reader arriving after three jobs had been claimed:
  the reader's job was claimed **4th instead of 55th**, with **1 job run between the GET and the
  answer instead of 52**. The full traces and the real-registry run are in
  [jobs.md](../architecture/jobs.md#priority-a-reader-is-claimed-before-a-warm-enqueued-job).
- Tests: the five priority cases in `server/test/jobs.test.mjs`, including the two that pin the
  properties above — that warming cannot lower a lifted job, and that equal priorities never yield
  to each other.
- **What this does not fix** is the cap itself. A reader asking for an identity nobody warmed still
  meets `MAX_LIVE_JOBS_PER_OPERATION` while 135 warm jobs are live. Priority fixes the ordering, not
  the admission; see research queue **O79**.
