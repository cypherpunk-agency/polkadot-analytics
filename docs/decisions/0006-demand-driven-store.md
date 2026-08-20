# 0006 — A persistent store filled by demand, not by a schedule

**Status:** accepted · 2026-08-20 · decided by Tommi

## Context

Everything this site has shipped so far is a pure function of an upstream, cached for two to
fifteen minutes. Fix a decoder and every number on the site is right within one TTL. That
property is worth a great deal, and it is the reason no store existed until now.

It stopped being enough for one reason: a lot of what we want to draw is **immutable and
expensive**. Hydration trades in a finalised block window will never change. XCM messages on a
closed calendar day will never change. A balance at block N on an archive node will never change.
Under a TTL cache those are refetched forever — a year of Hydration is roughly thirty-three
minutes of upstream work, and a TTL cache either does it again every fifteen minutes or caps the
window at seven days, which is what the site does today.

Two designs were on the table. Both had been sketched by earlier research sweeps, and both were
called "the store", which hid the actual disagreement — which was never whether there is
machinery, but **what decides to run it**.

## Decision

A persistent store, keyed by `(source, operation, canonical params, segment)`. Anything immutable
that has been fetched once is **never fetched again**. Everything is persisted; eviction is
deferred until storage pressure is real, and is then oldest-first.

There **is** a worker and a persisted job queue. There is **no schedule that fetches ahead of
demand** — jobs are created by demand, not by a clock.

A deliberately thin cron is permitted for a named handful of streams, and stays thin.

## Why the machinery, when the trigger is demand

Demand-driven does not mean synchronous. A reader asking for a year of Hydration is asking for
half an hour of fetching. That cannot live inside an HTTP request, and it must survive a
redeploy, a SIGTERM, and the reader closing the tab thirty seconds in. So:

- **A persisted queue**, because an intention that dies with a process is not an intention.
- **A worker**, because the HTTP thread has other readers.
- **Resumable cursors and idempotent segment keys**, because a restart mid-fetch must cost one
  page, not thirty-three minutes.
- **Find-or-create**, because ten readers asking for the same window are one job. This is the
  single-flight property the `TtlCache` already has, made durable.
- **An attempt budget with a persisted surrender**, because a timeout is indistinguishable from
  "no rows in this range", and a walker that retries on error grinds against an empty window at
  twelve seconds an attempt for the rest of its life.
- **One in-flight request per upstream host**, globally, because the upstreams are volunteer-run
  and politeness cannot be left to whichever handler was written last.

None of that is a scheduler. Every item exists to make *one demand-driven fetch* survivable. How
it is built is [jobs.md](../architecture/jobs.md).

## Why not the scheduled pipeline

The rejected design is the ordinary one: decide up front which streams matter, fetch them on a
timer into a warehouse, serve from the warehouse. It was rejected for four reasons, in order of
weight.

**It fails silently in exactly the way this site cannot afford.** A scheduled stream that stops
fetching — an upstream that moved, a schema that changed, a node that went away — leaves the
charts rendering. They render the last day that landed, in a shape that looks like a quiet
period. Nobody watches the ingest log of a dashboard site; the first honest signal is somebody
noticing the numbers feel old, days later. Demand-driven has no such state: nothing was fetched
because nobody asked, and the moment somebody asks, a failure is a failure they see, on the page,
attached to the request that caused it.

**It requires guessing.** A schedule is a bet about what will be looked at, placed before anyone
looks. Wrong in one direction and we hammer a volunteer's archive node nightly for a page nobody
opens; wrong in the other and the one page somebody wants is the one that was not backfilled.
Demand-driven declines the bet: what was asked for is what is fetched, and it is kept.

**It makes the storage question unanswerable in advance.** "How much disk do we need" has no
honest answer for a pipeline until the pipeline is running. A demand-driven store fills at the
rate the site is actually used, which is a number we can measure before asking infra for
anything.

**It costs continuously, for data nobody read.** Every scheduled fetch is upstream load we chose
to create. Against infrastructure run by volunteers, load we cannot point at a reader is load we
should not generate — the same argument as [0001](0001-containerised-not-static.md) and
[0005](0005-public-no-gate.md), pointed at ingest instead of at serving.

Two smaller alternatives were also rejected. **Keeping the TTL cache and simply raising the TTL**
does not help: it does not make a thirty-three-minute fetch survivable, and a longer TTL on
mutable data is only staler data. **Storing raw records rather than finished aggregates** was
rejected because the aggregate is what is asked for, the raw legs are about 25 MB against 50 kB,
and anything raw can be refetched from an upstream that still has it — which is
[0004](0004-server-side-aggregation.md) carried into storage.

## What we pay for it

**Cold start is user-facing, and it is the same defect as today's seven-day hang.** The first
visitor to ask for a year pays the fetch. This is not waved away: each *day* is its own segment,
so the work is chunkable; a request answers immediately with whatever coverage exists plus a job
id; the page draws a coverage bar rather than a bare spinner; and the job keeps filling after the
reader leaves. A partial answer that says what it is missing is the shape rule 3 already demands.

**The immutability predicate becomes the one way this design produces silently wrong data
forever.** A window marked immutable too early freezes a partial answer permanently — and freezes
it unevenly, only for whatever somebody happened to look at. Mitigations, all of them built into
the engine rather than left to discipline: the predicate is conservative by default and lives
with the source that owns the question; the engine refuses outright a handler that declares its
data mutable; every stored row records the upstream head and the code version that produced it;
and nothing is stored that cannot be refetched, so a re-derive is always available.

**We lose "fix the decoder and the site is right within fifteen minutes."** That is the real
price of this record, and it is why the head- and version-stamping above is not optional.

## The thin cron, and its tripwire

A handful of streams are worth keeping warm without anyone asking — head-following for pages we
know get looked at, so the common case is not a cold start. That is permitted, and it uses the
same queue, the same worker, the same idempotency and the same handlers as a demand-driven job.
It is a short allowlist of recurring enqueues on a timer, not a second ingest path.

**The tripwire is the length of that list.** If it grows past a few named entries, we have
rebuilt the scheduled pipeline this record rejects — and we will have inherited its worst
property without ever deciding to: a stream that stops fetching loses days silently while the
charts keep rendering. Growth of that list is the signal to stop and re-decide, not to add one
more line.

## Consequences

- The container is no longer stateless. It needs a disk, and that is an infra conversation that
  did not exist before. Size it after the store has run long enough to show a real fill rate.
- Every operation that wants the store must declare an immutability predicate. Mutable data —
  TVL now, reserve APYs, head block, peg deviation — stays on the TTL cache. That mode does not
  change and is not deprecated by this record.
- A long research job (backfill a year, sweep every holder, walk an account graph) is the same
  job row, the same handler and the same worker locally as in production; locally it runs against
  a local store file through `scripts/job.mjs`. The heavy work does not have to run on the small
  VM, which is what stops the VM being the constraint that shapes every other decision.
- **Client-triggered ingest stays bounded.** An "expand this account" click maps to a declared
  operation with validated params, never to "go and index whatever this string is". On an ungated
  site, a click that can enqueue unbounded upstream work is a denial-of-service amplifier pointed
  at somebody else.
- Bulletin is deliberately outside all of this. See [0007](0007-bulletin-client-direct.md).
