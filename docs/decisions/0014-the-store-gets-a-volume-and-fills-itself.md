# 0014 — The store gets a volume, and it fills itself at boot

**Status:** accepted · 2026-08-21 · decided by Claude, from a production outage Tommi diagnosed

## Context

`/netflows/` shipped on 2026-08-20 against the persistent store ([0006](0006-demand-driven-store.md),
[0012](0012-netflows-is-a-store-plus-a-live-tail.md)). It did not work for anybody:

```
$ curl "https://analytics.cypherpunk.agency/api/asset-hub/netflows-daily?month=2026-07"
HTTP 503
{"error":{"kind":"server","source":"asset-hub","message":"This operation is served from the
persistent store, which this instance could not open. …"}}
```

The store had nowhere to live. The size question had been settled the day before — 1 GB, on a
measured fill rate — and written into `docs/concept/plan.md` §12.2, and **that is where it
stopped.** Nothing in the deployment ever mounted anything. `deployment.md` still asserted "No
volumes. Nothing is written to disk at runtime" and "No datastore", both of which had been true
of the whole service and were by then true only of mode B.

Three separate things had to be decided, and they are decided together here because each one on
its own leaves the page broken.

## Decision 1 — the store lives at `/data`, named in the image

`ANALYTICS_DATA_DIR=/data` is set in the `Dockerfile`, and `/data` is created there owned by uid
1000. The rootfs stays `--read-only`. The deployment mounts a **1 GB named volume** at `/data`.

The alternative was to leave the variable to the deployment and keep the image ignorant of it.
Rejected because forgetting is invisible: the site comes up, mode B works, and only the
store-backed pages 503 — which is precisely the outage above. Naming the path in the image leaves
the compose file one job (mount something at `/data`) rather than two that can disagree.

Three refusals inside that, each because the failure is quiet:

- **No `VOLUME /data` instruction.** `VOLUME` makes Docker create an anonymous volume when the
  run does not supply one. That converts "nobody configured persistence" into a store that works
  perfectly and is discarded on every redeploy — refetching the whole backfill from other
  people's RPC nodes, every deploy, with nothing anywhere reporting it. A store that fails to
  open is loud in the log and visible on `/api/health`; a volume that silently resets is neither.
- **`/data` is created in the image, not at runtime.** Docker seeds a fresh *named* volume from
  the image's directory, ownership included, so the volume arrives owned by `node` and needs no
  runtime `chown` and no root. Mounted over a path that does not exist, it is created owned by
  root and the container reports exactly the same "mode A is unavailable" as having no volume at
  all. One `mkdir` is the whole difference. (A *bind* mount inherits nothing — the host
  directory's ownership wins — which is why a named volume is preferred: it takes the step away
  from a human.)
- **CI now runs the image both ways.** Without a volume it must come up and report
  `store.available:false`; with one it must report `true` and `/data/store.sqlite` must exist.
  Only the first half existed before, so "the intended state is reachable" was never checked —
  which is how a store shipped with nowhere to live.

## Decision 2 — failing to open the store may never stop the server listening

`createApp` already caught `openStore()` so that a missing volume cost mode A and nothing else.
It did not work, and the reason is worth keeping: **a `catch` only helps if the call returns.**

`openStore` called `fs.mkdirSync(dir, {recursive: true})`, which is not bounded. It reads `ENOENT`
from a `mkdir` as "the parent does not exist yet", creates the parent, and retries the child — so
on a filesystem that answers `ENOENT` to *creating* a child whose parent already exists, the two
steps alternate forever. procfs does exactly that. Verified on Linux 6.18, 2026-08-21:

```
mkdir('/proc/nonexistent')  -> ENOENT      (from Node and from /bin/mkdir alike)
stat('/proc')               -> a directory
```

`ANALYTICS_DATA_DIR=/proc/nonexistent/nope node server/index.mjs` therefore span in C++ at 100%
CPU, thread state `R`, never threw, never printed a line, and never reached `server.listen`. A
process that is alive and not listening is the worst of the three states: every health check,
load balancer and human reads it as "still starting" for as long as it lasts.

So, two changes:

- `server/lib/store.mjs` creates directories with a **bounded** walk — each ancestor visited
  once, shallowest first, never retried — so the worst case is an error naming the path. It also
  asks `access(2)` before SQLite does, because `EACCES` (a bind mount this uid does not own) and
  `EROFS` (no volume at all) have different remedies and `new DatabaseSync` says only "unable to
  open database file".
- `server/index.mjs` binds the port **before** it touches the filesystem (`deferStore`, then
  `app.openStore()` inside the `listen` callback). Whatever a mounted volume costs — and a volume
  can be slow in ways a local disk is not — it must not be able to cost the listener.

## Decision 3 — the store fills itself at boot, not on somebody's pageview

A fresh volume holds an empty store, and the first mode-A reader is what creates the fetch. For
`/netflows/` that is 55 months, ~50 minutes and ~2.9 GB pulled from public RPC nodes. Making a
visitor be the trigger for that is wrong twice: they see a nearly empty chart, and the fetch only
progresses while a worker happens to be alive.

**Rejected: shipping a seed dataset.** The stored series is only 2.33 MB, so it would fit; the
objection is not size. It is that a committed snapshot of fetched data is a second copy of the
store with no coverage bookkeeping, no `head`, and no way to tell whether it is current — and the
first thing anyone would ask of it is "re-derive it", which is the backfill again. It also has to
be imported into a writable store on boot, so it needs the volume anyway.

**Rejected: a cron.** 0006 already decided against a schedule that fetches ahead of demand, and
nothing here disturbs that argument. Boot is not a clock.

**Chosen: warm at boot, and keep looking.** `server/lib/warm.mjs`, called once the server is
listening. Three separate things, each of which previously needed somebody to load a page first:

1. **Warm.** A job handler may declare `warm()`, returning the identities worth having before
   anybody asks. Everything it returns goes through that handler's own `schema` (with the same
   `readParams` the HTTP layer uses) and its own `immutable` predicate.
2. **Resume.** A redeploy mid-backfill left runnable jobs and no worker: `startWorker` was
   reachable only from the request path. On a quiet site a half-filled series stayed half-filled
   for hours.
3. **Keep looking.** A one-shot check at boot is not enough, and this was found by testing rather
   than by reasoning: a job SIGKILLed mid-batch keeps its lease for up to `leaseMs` *after* its
   owner died, so at the instant a redeploy comes back up it is `running`, not runnable — the
   boot check finds nothing and never looks again. A backfill sat at 30/31 across a restart until
   a one-minute tick was added. A `failed` job backing off for up to an hour had the same
   problem. The tick costs one indexed `SELECT` against a local SQLite file per minute and spawns
   nothing while there is nothing to run.

The whole thing enqueues into the same queue, through the same find-or-create, drained by the
same single worker at the same one-request-per-host politeness. A warmed backfill and a
reader-triggered one are the same fetch with a different trigger; there is deliberately no second
path that could fetch differently.

### The refusal that matters

`enqueue` is find-or-create over *live* states only, and `done` is not one of them. So enqueuing
a finished identity does not join it — it mints a **new job and refetches every segment it
already holds**. A boot hook without that check would have turned "immutable data is fetched once
and never again" into "refetched on every redeploy", with correct answers, a full coverage bar
and nothing anywhere reporting it: the entire point of 0006, undone by the thing meant to help
it. `warmStore` skips a complete identity, skips a `gave-up` one (a restart is not new evidence,
and a surrender a reboot could undo is not a surrender), and is tested for both.

## Consequences

- The deployment gains its first volume. "No volumes / no datastore" is no longer true of this
  service and `deployment.md` says so.
- `/api/health` reports `store.available`, and CI asserts it in both directions. **An image that
  boots and serves is not evidence that the volume is there** — ask the health endpoint.
- A source that wants warming adds a `warm()` to its job handler and nothing else. A source that
  does not declare one is not warmed, which is the right answer for an operation whose useful
  params are not knowable in advance.
- The backfill is now a one-time cost against the public RPCs, not a per-deploy one — provided
  the volume genuinely persists. That is the property the anonymous-volume refusal protects.

## Related

- [0006 — A persistent store filled by demand, not by a schedule](0006-demand-driven-store.md)
- [0012 — Netflows is a store plus a live tail](0012-netflows-is-a-store-plus-a-live-tail.md)
- `docs/architecture/deployment.md`, `docs/architecture/jobs.md`
- `server/lib/store.mjs`, `server/lib/warm.mjs`, `server/index.mjs`, `Dockerfile`
