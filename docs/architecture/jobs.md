# The store and the job system

Some of what this site draws takes half an hour to fetch and then never changes again. That
combination is what the store is for, and the job system is what makes a half-hour fetch
survivable. Why it is shaped this way — demand-driven, no scheduler — is
[decision 0006](../decisions/0006-demand-driven-store.md). This document is how it works, for
somebody about to write the first real handler.

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

## What does not belong here

Anything that can still change. TVL now, reserve APYs, health factors, the head block, peg
deviation — these are never immutable, they keep the `TtlCache`, and the engine will refuse them
if you try. See [middleware.md](middleware.md).

Anything Bulletin. That data is deliberately never stored; see
[decision 0007](../decisions/0007-bulletin-client-direct.md).

And anything on a clock beyond the short warm-keeping allowlist 0006 permits. If that list is
growing, read the tripwire section of 0006 before adding to it.
