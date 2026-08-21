# The store and the job system

Some of what this site draws takes half an hour to fetch and then never changes again. That
combination is what the store is for, and the job system is what makes a half-hour fetch
survivable. Why it is shaped this way — demand-driven, no scheduler — is
[decision 0006](../decisions/0006-demand-driven-store.md). This document is how it works, for
somebody about to write a handler.

**Two handlers exist**, and between them they are the whole worked example:

| Handler | Identity | Segment | What it stores | Read it with |
|---|---|---|---|---|
| `hydration/swaps-daily` | `{ month }` | one ISO day | a day of routed trades, summarised: volumes, routes, accounts, derived rates, quality counters | [hydration.md](../platform/hydration.md#backfilling-the-whole-history-what-orca-actually-holds-and-what-it-costs) |
| `asset-hub/netflows-daily` | `{ month, network }` | one ISO day | the relay token in every parachain sovereign account at that UTC day's close, both legs, on two chains of one network | [asset-hub.md](../platform/asset-hub.md#reading-sovereign-balances-day-by-day-back-to-2022), [kusama.md](../platform/kusama.md) |

They landed a few hours apart on 2026-08-20 and chose the same identity independently, which is
the argument for the month bucket being right rather than merely first. Neither can serve the
**current** month, so each has a TTL-cached partner for the tail — `hydration/swaps` and
`asset-hub/sovereign-dot-recent` — and the page joins them and says which side of the seam a day
came from. That pattern is [decision 0012](../decisions/0012-netflows-is-a-store-plus-a-live-tail.md).

⚠️ **Neither of them works in production yet.** The compose file on the VM mounts no volume, so
`/data` is part of the read-only rootfs, `openStore()` fails, and mode A degrades to 503 while mode B
answers normally — deliberately. The image side is done and CI asserts both directions; what remains
is one line in a file this repository cannot reach, written out in
[deployment.md](deployment.md#the-volume-and-the-change-an-operator-has-to-make).

Four files, and they do not overlap:

| file | what it owns |
|---|---|
| `server/lib/store.mjs` | the SQLite file: facts, canonical keys, migrations, non-blocking reads |
| `server/lib/jobs.mjs` | the queue: job identity, states, leases, backoff, cancellation |
| `server/lib/job-worker.mjs` | the engine: claim, run, commit, and the worker thread |
| `scripts/job.mjs` | the CLI — the same store, queue and engine, in the foreground |

There is no URL and no `fetch` in any of them. Handlers are resolved through the source registry
exactly as HTTP operations are, so `server/sources/` remains the one directory where the outside
world exists, and `npm run check` still enforces it.

## The store

A fact is a payload keyed by four things:

```
(source, operation, canonical params, segment) → payload, head, code_version, stored_at
```

**Canonical params.** `{a: 1, b: 2}` and `{b: 2, a: 1}` are the same request, so they must be the
same row. `canonicalParams()` sorts keys at every depth and drops `undefined`; the resulting
string *is* the identity, and nothing ever compares params as objects. This is the rule
`params.mjs` already applies to the TTL cache key, made durable.

**Segments are the unit of work.** A year of history is not one row, it is one row per day — or
per page, or per block window; the operation chooses. Segmenting is what makes a long fetch
resumable, a coverage bar drawable, and a partial answer servable. It is also why a crashed job
costs one segment rather than everything.

**Segments sort as strings.** `readFacts` and `listSegments` order lexicographically, and
`coverage`'s earliest and latest are a string MIN and MAX. Pick ids whose text order is their real
order: ISO dates (`2026-08-19`), or zero-padded counters (`p00009`, never `p9`). An unpadded page
number draws a chart out of sequence, with no error anywhere.

**Coverage is derived, not bookkept.** `store.coverage(source, operation, params)` returns
`{ segments, earliest, latest }` computed from the facts table itself. There is no second table
recording what was filled, because bookkeeping that is computed cannot drift from the rows it
describes.

**Every row records what produced it.** `head` is the upstream head the fact was computed
against; `code_version` is the code that computed it. Both default to `null` — "not recorded" —
never to an invented value. A store you cannot audit is a store you cannot re-derive, and
re-derivation is the mitigation for the one failure mode 0006 names as fatal.

**Big reads do not stall the event loop.** `node:sqlite` is synchronous, and a synchronous
`.all()` over a year of days stalled the HTTP thread for 1.6 s in probing. `readFacts` and
`listSegments` iterate and yield to the event loop periodically, which brought the same read to
about 43 ms of stall. They are `async` for that reason. `getFact` and `putFact` touch one row and
stay synchronous.

Writes are `INSERT OR REPLACE`, deliberately: a resumed job may refetch the page a crash
interrupted, and an explicit re-derive overwrites on purpose. Idempotent writes make both free.

## A job

A job is an intention: "fetch `(source, operation, params)` into the store". Its identity is
those three things, with params canonicalised the same way facts are.

**Find-or-create is the only way one comes into existence.** `queue.enqueue()` returns the
existing live job for an identity rather than making a second one — ten readers asking for the
same year produce one job. A `partial` job is additionally re-queued, because a new request *is*
the demand that resuming was waiting for. Only a `done` or `gave-up` history permits a genuinely
new row, which makes a re-derive a deliberate act. This is enforced twice: in a transaction here,
and by a partial unique index in the schema for whatever this code gets wrong.

### States

```
queued  ──claim──▶ running ──complete──▶ done
  ▲                  │ │
  │       fail (budget left)  ──▶ failed ──(backoff elapsed)──▶ claimed again
  │                  │ │
  │       fail (budget spent) ──▶ gave-up  ──retry──▶ queued
  │                  │
  │       cancel observed / owner died ──▶ partial (cursor intact)
  └─────── enqueue of the same identity resumes a partial ◀──┘
```

**`gave-up` is a persisted surrender, and it is the state most worth understanding.** A timeout
from an upstream is indistinguishable from "there are no rows in this range". A queue that
retried on error forever would grind against an empty window at twelve seconds an attempt for the
rest of its life, politely, invisibly, and at somebody else's expense. Three failed attempts get
written down as a fact about the job — visible in `job list`, carrying the last error — and only
an explicit `job retry` reverses it.

**Progress is `done_units / total_units`, and either may be `null`.** Not knowable is a different
fact from zero and is never collapsed into it. A handler that cannot count its total pages reports
`null`, and the coverage UI says "in progress", not "0%".

### The one invariant

A batch of fetched rows and the cursor that covers them **commit in one transaction**. The
handler never touches the database; it returns `{ rows, cursor }` and the engine commits both or
neither. On the final batch the `done` transition joins the same transaction, so "the work exists"
and "the job says so" are one atomic fact.

This is a property of the API shape, not of handler discipline. There is no reachable state where
rows exist without the cursor that covers them, and no way for a handler to create one.

### Lease fencing

A claimed job carries a lease and a `lease_owner`. The engine heartbeats it while batches are in
flight — without that, one slow `nextBatch` (a single-node devnet taking its time, or the
politeness gate queueing this batch behind another job's request) would outlive the lease and hand
the job to a second engine while the first is still fetching. With the heartbeat, a lapsed lease
genuinely means a dead owner, and any later claimer adopts the row directly.

Every write a running engine makes is guarded by `state = 'running' AND lease_owner = me`. A
deposed owner cannot regress the cursor, cannot flip a finished job to failed, and cannot collide
with its own replacement. `advance` and `complete` throw `LeaseLostError` on refusal, which aborts
the surrounding transaction: **a deposed engine commits nothing.**

### The politeness gate

`gate(host, fn)` allows one in-flight request per host, across every job the engine runs. It works
by chaining — each host maps to the promise of the last call routed through it, and the next call
starts when that one settles, pass or fail.

Handlers wrap every upstream call in it and name the host themselves, because the hostname string
belongs in the source module, not in the engine.

One drainer runs at a time across the machine, enforced by a lease in the store. The gate is an
in-process structure, so a server worker and a shell `job run` draining at once would be two
independent gates pointed at the same volunteer-run node. `drainQueue` returns `null` — not an
empty array — when another live drainer holds the lock: "someone else is on it" is a different
answer from "nothing to do".

### Priority: a reader is claimed before a warm-enqueued job

Jobs carry a `priority` (`JOB_PRIORITY`, `server/lib/jobs.mjs`): **`warm` (0)** for anything
speculative, **`reader` (10)** for a request, a CLI `enqueue`, or anything else a human is waiting
on. `claim()` takes `ORDER BY priority DESC, id` — **ordering, never filtering**, so a warm job is
claimed the instant no reader is waiting and no backfill is slowed down.

This was not a problem while a reader's own request was the only job in the queue. Decision 0014
changed that: a cold volume enqueues **135 identities before anybody visits**. Measured in
production 2026-08-21, under the old `ORDER BY id LIMIT 1`, a reader asking for
`netflows-daily?month=2026-07&network=polkadot` got **job 74 of 135, `queued`**, behind about two
hours of warm work, for a month that takes ~45 s on its own. Every request answered 200 with a
correct coverage envelope; the page simply never filled. `MAX_LIVE_JOBS_PER_OPERATION` was meant to
protect readers and warming is deliberately exempt from it, which made this *worse* rather than
better.

Three properties, each of which is a way this goes wrong quietly:

- **Raise-only.** Find-or-create means a reader asking for a warmed month **joins** its job; a
  second row is impossible (the partial unique index) and would refetch what is already in flight.
  So the only lever a reader has is the position of the row they joined, and `enqueue` /
  `raisePriority` raise but never lower — otherwise the once-a-minute re-warm would put every lifted
  job back down sixty seconds later.
- **No mid-batch pre-emption.** The rows-and-cursor invariant comes first. The engine checks between
  batches only, and steps aside back to **`queued`** with the cursor intact, so it is re-claimed in
  the same drain the moment the reader is served and nothing is refetched. Not `partial`: `partial`
  is not in `RUNNABLE_WHERE`, so a job parked there would sit until something enqueued it again —
  recovering a minute later, via the re-warm, for a reason nobody could see.
- **Strictly greater.** `hasRunnableAbove` uses `priority > ?`. Two jobs at one priority must never
  yield to each other, or they hand the drain back and forth one batch each, for ever, with every
  batch correct and the queue never emptying.

Measured two ways on 2026-08-21. A 135-identity cold store, real boot, synthetic upstream at the
real batch granularity, reader arriving after three jobs had been claimed:

| | FIFO (before) | priority (after) |
|---|---|---|
| reader's job claimed | **55th** | **4th** — the very next one |
| jobs run between the GET and the answer | **52** | **1** (the batch already in flight) |

The batch trace shows the hand-over exactly: `2022-03 days 1-10` (the in-flight batch, not
pre-empted) → `2026-07 days 1-10, 11-20, 21-30, 31-31` (the reader's whole month) → `2022-03 days
11-20` (resumed, nothing refetched).

Then against the real registry and real upstreams on a cold volume: the reader's month was **job 74
of 135** — the production number — `queued` at priority 0; the GET raised it to 10 without minting a
second row; job 1 (`swaps-daily 2025-01`, running at 29/31) committed its in-flight day, stepped
aside to `queued` with its cursor at `2025-01-31` and 30 stored segments; job 74 was claimed next
and reached `done` at 31/31.

Tests: the five priority cases in `server/test/jobs.test.mjs`. The reasoning, and the four rejected
alternatives, are in
[decision 0018](../decisions/0018-a-readers-job-outranks-a-warm-one.md).

**A batch is therefore the unit of fairness as well as the unit of commit,** which makes batch size
a **latency** decision and not only a throughput one: one batch is the longest a reader can be made
to wait behind work nobody asked for. `swaps-daily` commits one day (~9 s), `netflows-daily` ten
(~14 s), against whole months of 4.5 min and 45 s respectively.

### Where it runs

A `worker_threads` worker in the same process: +17 MB measured, against about 47 MB for a second
process. The HTTP thread keeps its own read view of the same WAL file while the worker writes. The
worker drains and then **exits** — an idle worker holding 17 MB is 17 MB spent on nothing — and
`ensureWorker()` spawns one only when `queue.hasRunnable()` says there is something to do. It is
`unref`'d, so it can never be the thing keeping the server alive.

A separate container remains available if we ever want ingest to fail independently of serving.
Nothing in the design assumes the thread.

## The handler contract

A source module may export a `jobs` object next to `operations`. This is the contract the engine
enforces; it is also documented at the top of `server/lib/job-worker.mjs`, which is the copy that
gets updated when it changes.

```
jobs: {
  'trades-window': {
    summary: 'Backfill routed trades for a block window, one day per segment.',

    immutable: (params) => boolean,
      // May the answer still change? Consulted before the first batch. A handler that
      // answers false is REFUSED — mutable data belongs on the TTL cache, and a predicate
      // wrong in the permissive direction freezes a partial answer forever. Be conservative.

    warm: () => [params, …],
      // OPTIONAL, and a deployment concern rather than a fetching one: the identities worth
      // filling BEFORE a reader asks. Called at boot and on the minute tick by
      // server/lib/warm.mjs, never on a request path. Everything it returns goes through this
      // handler's own `schema` and `immutable`, and an identity that is already complete is
      // skipped, so a warm list may safely be "every month of the series" for ever. May be
      // async. See deployment.md, boot step 3, for the three rules a warm list has to obey.

    canary: async ({ store, sourceId, operationId }) => report | null,
      // OPTIONAL. Does this handler's upstream still hold everything the store holds? A
      // REPORTING condition, never an error: it does not throw, fail a request or stop a job.
      // See server/lib/canary.mjs and decision 0019.

    plan: async ({ params, gate }) => ({ totalUnits }),
      // Optional. Runs once, before the first batch, to size the work.
      // `totalUnits: null` means "not knowable" — null, never 0.

    nextBatch: async ({ params, cursor, gate }) => ({
      rows,        // [{ segment, payload, head?, codeVersion? }] — may be empty
      cursor,      // resume point AFTER these rows; JSON-serialisable; committed with them.
                   //   Required unless `done`. Omitted on a done batch, the last committed
                   //   cursor is KEPT, so a finished job's resume point still covers its work.
      done,        // true when this was the final batch
      doneUnits,   // optional absolute progress; null = not knowable; omit = unchanged
      totalUnits,  // optional; same rules
    }),
  },
}
```

`cursor` on entry is `null` at the start, and thereafter exactly what the last committed batch
returned. A crash between batches replays at most one page, and because facts insert idempotently
on their segment key, the replay is free.

### Choosing the identity, before choosing anything else

This is the decision the contract does not make for you, and getting it wrong is expensive rather
than wrong-looking. **The params are part of the fact key** — `(source, operation, canonical
params, segment)` — so two identities never share a segment, even when they name the same day.

An operation parameterised by a free `{from, to}` range therefore re-fetches and re-stores every
day of every window a reader asks for. Ten readers with ten slightly different ranges over the same
year are ten full backfills against an upstream we do not own, and nothing anywhere reports it: the
coverage bar fills, the answers are right, the store is ten times the size it should be and the
upstream saw ten times the traffic. So the identity has to be a **fixed bucket that many readers
land on**.

The other constraint pulls against making that bucket "everything":

> **A job that reaches `done` frees nothing.** `serveFromStore` answers *complete* for an identity
> whose job finished, and never enqueues another one. An identity of "all days up to now" is
> therefore permanently frozen at whatever "now" meant when it finished — and `immutable()` would
> have had to lie to let it start at all.

Which leaves a bucket that is (a) coarse enough to be shared, (b) fine enough that new data is not
held hostage to it, and (c) genuinely finished at a knowable moment. For a daily series a **calendar
month** is the smallest thing that is all three, and that is what `hydration/swaps-daily` uses: the
identity is `{ month }`, the segments are its ISO days.

State the cost of the bucket on the page rather than discovering it later. A month-bucketed store
cannot serve the current month at all, so a page that wants both history and this week reads the
store for whole past months and a TTL-cached operation for the tail.

> **Adding a param to a filled job orphans everything already in it.** `{"month":"2026-01"}` and
> `{"month":"2026-01","network":"polkadot"}` are different canonical params, so they are different
> identities and share no segment. Making `network` required on `asset-hub/netflows-daily` on
> 2026-08-21 therefore orphaned all **1,673** stored Polkadot days at a stroke: they are re-derived
> once, on demand, and the old rows sit in the SQLite file as dead weight until somebody deletes
> them. That is the honest price of a self-describing identity and it is worth paying — but pay it
> knowingly, and consider the forward-only `UPDATE` in
> [decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md), which was verified
> against a copy of the store rather than assumed.

**And enqueuing is not idempotent across `done`.** `queue.enqueue` is find-or-create over *live*
states only, and `done` is not one of them — so enqueuing an identity that already finished mints a
**new** job and refetches every segment already stored. Anything that enqueues without asking
`describeIdentity` first (a boot warm-up, a cron, a retry loop) turns "immutable data is fetched once
and never again" into "refetched every time", with correct answers, a full coverage bar and nothing
anywhere reporting it. `server/lib/warm.mjs` checks, and `server/test/warm.test.mjs` asserts that it
does.

### Do not name a job after an operation

A `jobs` entry and an `operations` entry share the URL shape `/api/<source>/<name>`, and **the job
wins** (`server/index.mjs`). Naming a job after an existing operation does not put a second mode
beside the first — it takes the URL away from it. The page reading that URL keeps getting `200`s,
now carrying a store envelope it has no idea how to draw, and nothing throws, logs or fails. This
is why `hydration.mjs` calls its handler `swaps-daily` and not `swaps`, and why `npm run check`
fails the registry group on a collision.

**Writing one, in order.**

1. Decide the segment. It should be the smallest chunk that is independently meaningful — a day,
   usually. Check its ids sort as strings.
2. Write `immutable`. It is the most dangerous line in the file. `b <= finalizedHead - k` for a
   block range; "the UTC day has ended *and* the source has settled" for a calendar day. If you
   are unsure, answer false: a job that refuses to run is a bug you find in a minute, and a
   window frozen too early is a wrong number nobody ever notices.
3. Write `nextBatch` as a pure function of `(params, cursor)`. Wrap each upstream call in
   `gate(host, fn)`. Return rows and the cursor that covers them. Do not write to the store, do
   not catch errors you cannot act on — a thrown error is a failed attempt, which is a state the
   queue already knows how to handle.
4. Stamp `head` on every row, and `codeVersion` when the payload is derived rather than raw.
5. Run it from the CLI against a local store before it goes anywhere near the server.

The engine refuses, permanently and without burning the attempt budget, a handler that cannot be
resolved, does not implement `immutable` and `nextBatch`, declares its params mutable, returns a
batch without a `rows` array, or returns an unfinished batch with no cursor. All of those are
design errors, and retrying a design error is only a slower error.

## The CLI

`scripts/job.mjs` is not a second implementation. It opens the same store, the same queue and the
same engine against a local SQLite file, with no server running:

```bash
node scripts/job.mjs enqueue <source> <operation> [key=value ...]
node scripts/job.mjs run [id]      # run one job, or drain; progress to stderr
node scripts/job.mjs status <id>
node scripts/job.mjs list [state]  # queued|running|partial|done|failed|gave-up
node scripts/job.mjs cancel <id>
node scripts/job.mjs retry <id>    # reverse a gave-up
```

The store lives at `ANALYTICS_DATA_DIR`, defaulting to `server/data/`.

This is the tier-3 bridge: a year-long backfill on a laptop and the same backfill on the VM are
the same code with a different data directory. The heavy work does not have to run on the small
VM, which is what stops the VM from being the constraint that shapes every other decision.

Two things to know. Cancellation is cooperative and checked against committed state between
batches, so a `cancel` issued from a shell is seen by the server's worker. And `key=value` parses
as JSON where it can (`days=30` is the number 30), which diverges from the HTTP layer for params a
source declares as a list: `assets=DOT,USDC` is comma-split by `readParams` but stays one string
here, minting a second identity. Until `enqueue` consults the param schema, pass those as JSON:
`assets=["DOT","USDC"]`.

## What the store actually costs

Measured, not estimated — `hydration/swaps-daily` filling four whole calendar months into
`server/data/store.sqlite` on 2026-08-20. **121 days, 1,112,356 routed trades, and the file
finished at 1,499,136 bytes.**

| | |
|---|---|
| one indexed day, JSON payload | **13.2 – 15.5 kB** (12,104 B smallest, 17,201 B largest) |
| one day with nothing to index | 544 B — a block window and an explicit `coverage` |
| on disk, per indexed day | **≈ 14.3 – 16.7 kB** |
| SQLite overhead over the logical rows | **1.079×** (pages, and the four-column primary key) |
| per routed trade summarised | **1.35 B on disk** (1,499,136 B / 1,112,356 trades) |
| time per day | mean **9.0 s**, median 7.8 s, p90 15.3 s, worst 31.5 s |
| time, as a model | **2.27 s per day + 0.563 ms per trade** (fits all four months to ±1 %) |

**The payload is nearly flat in the trade count**, which is the number that makes the disk
conversation easy: a day is a summary with bounded lists (fifty accounts, forty routes, every
asset and every derived rate), so a day with 19,046 trades costs 15.5 kB and a day with 7,315
costs 13.6 kB. Cost scales with **days**, not with volume.

Extrapolating to everything orca holds — 2025-01-01 to 2026-08-19, 596 days, 6,585,435 routed
trades:

- **≈ 9 MB on disk**, and about **84 minutes** of wall time to fill, one request in flight.
- **≈ 2.9 GB pulled from orca** to produce it. The store is 0.3 % of what it reads; the fetch is
  the expensive half, and the whole point of mode A is doing it once.

For scale in the other direction: storing the **trades themselves** rather than a daily summary is
268 B per trade in the canonical `Trade` shape — 2.8 MiB a day and **1.64 GiB** for the same
history, a factor of ~190. It would also be unservable: `serveFromStore` returns every segment of
an identity in one response with no paging, and a month of raw trades is ~150 MB in a single
answer. The summary month is 428 kB over the wire, measured.

**A backfill needs headroom beyond the data.** During the fill the WAL reached ~2.9 MB against
~1 MB of committed rows and settled back to zero when the last connection closed. Provision for
the file plus a few MB, not for the file exactly.

**The second handler is two orders of magnitude cheaper per day, and that is the useful comparison.**
`asset-hub/netflows-daily` stores **1,392 B mean** per Polkadot day and **1,542 B** per Kusama day,
against Hydration's 14–17 kB, because a day of sovereign balances is ~50 numbers while a day of
trades is a summary with bounded lists. Polkadot's 2022-01 → 2026-07 series is **1,673 days and
2.33 MB**, filled in about 50 minutes; Kusama's 2021-07 → 2026-07 series is **1,857 days and
2.73 MB**, filled in 33.1 minutes at 1.07 s a day (measured 2026-08-21). Full figures, and the five
months that failed once mid-run and succeeded on retry, are in
[asset-hub.md](../platform/asset-hub.md#the-cost-measured) and
[kusama.md](../platform/kusama.md#what-it-costs-to-read).

⚠️ **A per-day request count is easy to under-measure by forgetting what runs per BATCH.**
`netflows-daily` was recorded at "~2.2 requests per day" on 2026-08-20; counting real `fetch` calls
through the handler the next day gives **5.4–5.7 on both networks**. The missing ~3 are
`netflowsHeads`, which re-pins both chains on every batch — five un-batched calls per host, ten per
ten-day batch, a full request per stored day. Count the calls; do not add up the ones you meant to
make.

So the range a `jobs` handler costs is **0.5 kB to 17 kB per day** on this evidence, and the thing
that moves it is how much summarising the payload does — not how busy the chain was. Both handlers
are nearly flat in the underlying volume.

**The two handlers measured above are pinned as a tripwire.** They are listed in
`MEASURED_JOB_HANDLERS` in `scripts/check.mjs`, and `npm run check` fails the registry group if a
third is added or one is removed. Infra sized the volume on these figures and asked to be told when
they move; a promise to remember is worth nothing at the moment it matters, which is a year from now
in somebody else's pull request. The failure message carries the four steps that discharge it, in
order — measure, update the figures in this document and in
[deployment.md](deployment.md), tell infra, and **then** add the handler to the list, in the same
commit as the measurement.

## What does not belong here

Anything that can still change. TVL now, reserve APYs, health factors, the head block, peg
deviation — these are never immutable, they keep the `TtlCache`, and the engine will refuse them
if you try. See [middleware.md](middleware.md).

Anything Bulletin. That data is deliberately never stored; see
[decision 0007](../decisions/0007-bulletin-client-direct.md).

And anything on a clock beyond the short warm-keeping allowlist 0006 permits. If that list is
growing, read the tripwire section of 0006 before adding to it.
