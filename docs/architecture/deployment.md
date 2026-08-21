# Deployment

How this service becomes a container, what that container needs from the world, and what is still
missing before it can actually ship.

**Status as of 2026-08-21: the deploy runs, and the store has nowhere to live on the VM.**
`.github/workflows/deploy.yml` carries real infra values and `PINNED_COMMAND_SUPPLIED=true`, and
production is demonstrably serving this repository's code — so the "gated off as of 2026-08-19" this
line used to say is out of date. What cannot be read from this repository is the value of the
`DEPLOY_ENABLED` repository variable itself (research queue O59). What is missing is a volume: see
[the volume, and the change an operator has to make](#the-volume-and-the-change-an-operator-has-to-make),
and [What is still owed](#what-is-still-owed) for the rest of the list.

---

## What is being deployed

One image, one process. Inside it:

- **the static site** — a Vite multi-page build. Every page directory at the repo root that holds an
  `index.html` becomes a page; `xcm/index.html` is served at `/xcm/`.
- **the server** — `server/index.mjs`, ~640 lines of `node:http`. It serves `dist/` and answers a
  read-only, cached API at `/api/*` that proxies public upstreams.
- **a job worker**, in a `worker_threads` thread of the same process, draining a queue that lives in
  the same SQLite file as the store. It is idle unless something enqueued work
  ([jobs.md](jobs.md)).

There is no second container, no database server, no cache server and no sidecar. The response cache
is a `Map` in the process; a restart empties it and the next request refills it. The job queue is
**not** in that `Map` — it is rows in `store.sqlite` on the volume, and surviving a restart is the
whole point of it.

## Building the image

```
docker build --build-arg BUILD_STAMP="$(git rev-parse HEAD)" -t polkadot-analytics .
```

Two stages, and the split does real work.

**Stage 1** runs `npm ci` and `npm run build` on `node:22-alpine`. `npm ci` (rather than
`npm install`) installs exactly what `package-lock.json` pins — the build is reproducible or it
fails, which is the whole point of having a lockfile.

**Stage 2** starts from a clean `node:22-alpine` and copies five paths out of stage 1:

| Path | Why it is in the runtime image |
|---|---|
| `dist/` | the built site |
| `server/` | the service |
| `src/core/` | pure-JS codec, pricing and formatting modules the server imports directly — the same modules the browser bundle uses, which is exactly why they have no dependencies |
| `src/data/` | generated datasets |
| `package.json` | for `"type": "module"` and nothing else |

**Stage 2 runs no `npm` command at all** — not even `npm ci --omit=dev`. `vite` is this repo's only
dependency and it is a `devDependency`, so there is nothing to install. The runtime image contains
no `node_modules` directory. This was verified by assembling exactly those five paths in an empty
directory with no `node_modules` and starting the server: `/healthz`, `/api`, `/api/health`, a page
and a 404 all answered correctly.

The image runs as the base image's `node` user (uid 1000). The copied files stay owned by `root`,
deliberately: the service only ever reads them, so the process cannot rewrite its own code.

## What the container needs

One volume, and nothing else.

That is worth stating plainly, because the list is so short and because it used to be shorter:

- **No secrets.** Every upstream is anonymous public HTTP. No API key, no token, no `Authorization`
  header, no `.env`, no secret store, no mounted credential file. `server/lib/upstream.mjs` is the
  single place any outbound request is made, and it attaches no credentials to anything — see
  `docs/decisions/0003-no-secrets.md`.
- **One volume, 1 GB, at `/data`.** This is the whole of the change from "nothing at all", and it
  arrived with [decision 0006](../decisions/0006-demand-driven-store.md): mode A writes
  `store.sqlite`. The rootfs stays `--read-only` and `/data` is the only writable path in the
  container. See the box below for what happens without it, and
  [decision 0014](../decisions/0014-the-store-gets-a-volume-and-fills-itself.md) for why it is a
  named volume rather than a `VOLUME` instruction.
- **No datastore.** Still true, and worth keeping separate from the volume: no Postgres, no Redis,
  no object storage, no second container. The one persistence this repo has is a single SQLite file
  it opens itself; there is no server to run.
- **No configuration** beyond five variables, none of which is sensitive:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `BUILD_STAMP` | `unknown` | the deployed git sha, reported by `/api/health` |
| `ANALYTICS_DATA_DIR` | `/data` **in the image** (`<repo>/server/data` outside it) | where `store.sqlite` lives. Set in the Dockerfile so a deployment has one job — mount something at `/data` — rather than two that can disagree |
| `NODE_OPTIONS` | `--max-old-space-size=192` | heap ceiling; see the memory envelope below |

> ### Without the volume the site works and two pages do not
>
> "Nothing is written to disk at runtime" was true of the whole service when it was written. Since
> [decision 0006](../decisions/0006-demand-driven-store.md) it is true only of **mode B**.
>
> With no volume mounted, `/data` is part of the read-only rootfs, `openStore()` throws, and the
> service **carries on**: it logs `[store] mode A is unavailable`, keeps listening, answers every
> TTL-cached (mode B) operation normally, and answers `503` on the store-backed ones. A site that
> refuses to start because a volume is missing is a worse outage than a site with two of
> thirty-seven endpoints down.
>
> The consequence, stated plainly, because it happened: **the `/netflows/` page and the
> `/api/hydration/swaps-daily` endpoint return 503 for every visitor** in that state. Note the two
> shapes — one is a page, the other is an API path. An earlier draft of this line listed them as
> `/netflows/` and `hydration/swaps-daily` side by side, which reads as two pages, and someone
> duly tried `/hydration/swaps-daily` and got a 404. There is no such page; `swaps-daily` is a job
> operation and lives under `/api/`. It shipped that way on 2026-08-20 and nothing went
> red, which is the real lesson here — **an image that boots and serves is not evidence that the
> volume is there.** `/api/health` reports `store.available`; CI now asserts it in both directions.
>
> The size is settled on a measured fill rate rather than a guess: **1 GB**, which holds roughly
> 160,000 source-days at the 14–17 kB/day this repo actually costs. A full 19-month Hydration
> backfill is 9 MB; the 2022 → 2026 Polkadot netflows series is 2.33 MB and Kusama's 2021 → 2026 one
> is 2.73 MB. The measurement, and what would reverse it, is in
> [jobs.md](jobs.md#what-the-store-actually-costs) and `docs/concept/plan.md` §12.

`BUILD_STAMP` is what makes "is the new version actually live?" answerable by asking the service
instead of inferring it from a container start time.

A minimal run looks like this, and it is the full set of flags:

```
docker volume create polkadot-analytics-data

docker run -d --name polkadot-analytics \
  --read-only \
  --memory 256m \
  --volume polkadot-analytics-data:/data \
  --publish 127.0.0.1:8080:8080 \
  ghcr.io/cypherpunk-agency/polkadot-analytics:<sha>
```

A **named** volume, deliberately. `/data` exists in the image owned by uid 1000, and Docker seeds a
fresh named volume from the image's directory — ownership included — so the `node` user can write to
it on the first boot with no runtime `chown` and no root. A **bind** mount inherits nothing (the host
directory's ownership wins), so a host path must be `chown 1000:1000`ed by hand first; forget it and
the container reports exactly the same "mode A is unavailable" as having no volume at all.

## Memory envelope

The target VM is a 2 GB `e2-small` shared with several other services, so this one does not get to
be careless. **We asked for a 256 MB container limit and expect 70–90 MB RSS in steady state.**

Where that number comes from:

- a bare Node 22 process is roughly 40–50 MB before it does anything;
- the response cache is bounded at **48 MB** and 400 entries (`server/index.mjs`), and it is swept
  every 60 seconds;
- a single in-flight upstream response is capped at **24 MB** (`server/lib/upstream.mjs`). That cap
  is not paranoia: an archive query with a mistaken filter can return tens of megabytes, and on a
  256 MB container that is a crash-loop instead of an error message.

Worst case is therefore around 120 MB, which leaves the limit with real headroom rather than
theoretical headroom. A local run of the assembled runtime tree measured **55 MB RSS** immediately
after serving a page and both health endpoints, with a cold cache.

The image also pins `NODE_OPTIONS=--max-old-space-size=192`. Node derives its default heap from the
memory it believes the machine has, and how faithfully that tracks a cgroup limit has moved between
versions. Without an explicit ceiling, a leak on a 2 GB host would be OOM-killed by the kernel with
no stack trace and no log line. With one, the same overrun surfaces as a readable JavaScript heap
error.

## Health endpoints

There are two, and they answer different questions. Both are cheap and **neither touches an
upstream**.

### `GET /healthz`

Returns `200` with the body exactly `ok`. This is **liveness**: is a process listening.

It is what the container `HEALTHCHECK` calls, every 30 seconds, using busybox `wget` from the base
image rather than spawning a second Node process — a ~40 MB process twice a minute is real money on
a shared 2 GB VM.

### `GET /api/health`

Returns `200` and JSON:

```json
{
  "ok": true,
  "service": "polkadot-analytics",
  "build": "<the deployed git sha>",
  "uptimeSeconds": 41,
  "cache": { "entries": 12, "approxBytes": 918273, "hits": 88, "misses": 12, "…": 0 },
  "store": { "available": true },
  "canaries": { "ok": true, "checkedAt": 1755772800000, "reports": [ … ] }
}
```

**This is the one external monitoring should watch.** `/healthz` only proves that something accepted
a TCP connection and wrote four bytes. `/api/health` proves the app layer is actually wired: the
source registry imported, the codec modules under `src/core/` resolved, the cache constructed, and
the JSON layer works. A deploy that shipped a broken import would still pass `/healthz` right up
until the first real request.

It also reports `build`, so an alert can distinguish "the service is down" from "the service is up
and serving last week's code" — which is the failure a plain 200 check will never catch.

`store.available` is the other field worth alerting on, and it is the one this deployment learned
the hard way. `false` means the container came up without a writable `/data`: everything TTL-cached
answers normally and every store-backed operation answers 503, so the site looks entirely healthy
from the outside while `/netflows/` is broken for every visitor. Nothing else distinguishes the two
states.

**`canaries.ok` is the durability alarm, and it is deliberately not `ok`.**

```
curl -s https://analytics.cypherpunk.agency/api/health | jq '.canaries'
# want: .canaries.ok == true
```

The top-level `ok` stays `true` when a canary fires. A store that has stopped being re-derivable is
something to tell a human about, not a reason to restart a container or pull a healthy site out of a
load balancer. `canaries.ok` is `true` / `false` / **`null`** — null means nothing has been checked
yet (a container with no volume, or the first seconds after boot) and **must not be read as
`true`**. Each report carries a sentence naming the *consequence*, not a reading; a reading in an
alert is a thing people learn to scroll past.

Today there is exactly one, `hydration/swaps-daily` watching orca's routed-trade floor. If it goes
`at-risk`, the store has stopped being a pure cache for that operation and this volume is the only
copy of the days the message names — **that is the point at which a backup stops being
unnecessary.** It re-checks at boot and every 15 minutes; `/api/health` publishes the last answer
and the time it was taken. See
[decision 0019](../decisions/0019-the-store-canaries-its-own-derivability.md).

`canaries` is a sibling of `store` rather than a field inside it, so the `"store":{...}` grep in the
runbook below still matches byte for byte.

### What neither of them does

Neither endpoint calls an upstream, and that is a deliberate design decision rather than an
oversight. A health check that goes red when a public devnet node reboots is a health check
everybody learns to ignore, and an upstream outage that restarts our container makes a bad situation
worse. Upstream failures surface where they belong: as `502` on the specific `/api/<source>/<op>`
call, with `transport` versus `upstream` preserved so the reader can tell "we could not reach them"
from "they answered with an error".

### What the server does at boot, and in what order

The order is load-bearing, so it is written down rather than left to be read out of the file:

1. **`server.listen`.** Before anything touches the filesystem. Whatever a mounted volume costs —
   and a volume can be slow, or wedged, in ways a local disk is not — it must not be able to cost
   the listener. A process that is alive and not listening is the worst of the three states, because
   every health check and every human reads it as "still starting" for as long as it lasts.
2. **`openStore()`.** Failing here is a supported state, not a crash. Until it returns, mode A
   answers 503 and mode B answers normally.
3. **Warm and resume,** in the background, never awaited. Any job left runnable by a previous
   instance is picked up, and any handler that declares `warm()` gets its identities enqueued — so a
   backfill interrupted by a redeploy continues without waiting for a visitor. Thereafter a
   one-minute tick keeps looking, because "runnable" is a function of the clock: a job SIGKILLed
   mid-batch holds its lease for up to a minute after its owner died, and a failed job backs off for
   up to an hour. See
   [decision 0014](../decisions/0014-the-store-gets-a-volume-and-fills-itself.md).

> **Both handlers declare `warm()` as of 2026-08-21**, so a fresh volume fills itself: every settled
> month of `asset-hub/netflows-daily` on both networks, and every settled month of
> `hydration/swaps-daily` from orca's own floor block up to orca's own head. Neither list is a
> constant — each is derived from the same predicate `immutable` uses, so the current month falls
> out on its own and the warm list cannot drift from the list a reader asks for. A warm identity
> that differs from a requested one by so much as a key is a **second** identity: the backfill would
> run twice, both copies would be correct, and the page would still start empty.
>
> **Warming half a page is worse than warming nothing**, which is why `netflows-daily` warms both
> networks. `MAX_LIVE_JOBS_PER_OPERATION` (8) is counted per `(source, operation)` **across all
> params**, so warming Polkadot alone would put 55 live jobs on that operation and a Kusama reader
> arriving during the drain would be refused with "the queue is busy" for the whole of it.
>
> **A reader is not starved by that warm-up.** The 135 identities a cold volume enqueues are all at
> `warm` priority; the first request for any of them raises the one it joins to `reader`, and the
> drain hands over at the next batch boundary. So a visitor arriving mid-refill waits one batch
> (≤ ~14 s), not the two hours the backlog takes. Before that existed it really was the two hours,
> measured in production: job 74 of 135, answering 200 with a correct coverage envelope the whole
> time. See [jobs.md](jobs.md#priority-a-reader-is-claimed-before-a-warm-enqueued-job).

## Push-to-deploy

`.github/workflows/deploy.yml`, on every push to `main`, plus `workflow_dispatch`.

**Job 1 — `image`.** Builds the image and pushes `ghcr.io/cypherpunk-agency/polkadot-analytics` at
both `:<sha>` and `:latest`, authenticating with the job's `GITHUB_TOKEN` scoped by
`packages: write`. No PAT, no stored registry credential. It outputs the **digest**, because that is
what the deploy pins to: a tag is a moving pointer, a digest cannot mean two things.

**Job 2 — `deploy`.** Gated:

```yaml
if: ${{ vars.DEPLOY_ENABLED == 'true' }}
```

While that repository variable is anything other than `'true'`, the job is **skipped, not failed**.
That distinction is the entire design. A red `main` that everybody knows to ignore is worse than no
check at all, so an unconfigured deploy must be quiet rather than noisy.

Authentication is **keyless**: `google-github-actions/auth` exchanges the workflow's OIDC token
(`id-token: write`) for short-lived GCP credentials via Workload Identity Federation. There is
deliberately **no `GCP_SA_KEY` secret**, and the preflight step fails the run if one ever appears. A
downloaded service-account key is a long-lived root-ish credential sitting in a settings page, and
not having one is the point of the whole arrangement.

Every action in both workflows is pinned to a **commit SHA**, not a tag. A tag is a mutable pointer,
and whatever it points at runs with the workflow's token.

### The `--ssh-key-file` rule

> **Every `gcloud compute ssh` and `gcloud compute scp` invocation must pass `--ssh-key-file`.**

Without it, `gcloud` looks for `~/.ssh/google_compute_engine`, does not find one on a fresh
ephemeral runner, **generates a new keypair, and pushes the public half into project-wide
metadata**. Keys in project metadata grant root-equivalent access to every instance in the project,
they never expire, and nothing prunes them. One per deploy. **Twenty-five had accumulated before
they were pruned** — twenty-five standing root keys whose private halves were destroyed along with
the runners that made them, which means nobody could even determine which were still live.

The workflow generates a run-scoped ed25519 key and passes `--ssh-key-file` explicitly. The durable
fix is OS Login, which is on the infra list below: with `enable-oslogin=TRUE`, keys land in the
service account's login profile with a TTL and access is governed by IAM, so this failure mode stops
being possible rather than being remembered.

### Verification

The deploy is not finished when the remote command returns; it is finished when the service answers.
The last step polls `https://analytics.cypherpunk.agency/api/health` and requires `build` to equal
the deployed sha. A restart that silently kept the old container would pass a plain 200 check and
fail this one.

## What is still owed

Items 1–4 of the original list were supplied by infra over the agent bridge on 2026-08-19 and are
reviewed literals in `.github/workflows/deploy.yml` now: the Workload Identity provider and service
account, the instance and zone (`web-server` / `europe-west1-b`), and the pinned privileged command
(`sudo /usr/local/bin/deploy-service`). The one Actions secret the deploy reads is
`GCP_DEPLOY_SSH_KEY`; there is deliberately no `GCP_SA_KEY` and the preflight fails the run if one
appears.

What is still owed:

1. **OS Login enabled** (`enable-oslogin=TRUE`) on the project or the instance, plus IAP so
   `--tunnel-through-iap` can be added and public SSH closed on the VM. This is also the durable fix
   for the `--ssh-key-file` box above.
2. **Caddy** terminating TLS for `analytics.cypherpunk.agency` and proxying to the container. The
   server sets its own security headers including `connect-src 'self'`, so the edge and the origin
   agree even if one of them is ever bypassed. One behaviour of that proxy is asserted but
   unverified from here: `/api/stream/*` is Server-Sent Events
   ([decision 0020](../decisions/0020-the-series-is-read-in-one-request.md)) and must reach the
   browser unbuffered. Caddy 2 streams `text/event-stream` by default and the response also sends
   `x-accel-buffering: no` for anything nginx-shaped in the path — and the client falls back to
   polling if the pipe is dead, so a buffering edge degrades the page rather than breaking it.
   **Probed 2026-08-21, minutes after the deploy that shipped it:** `curl -N` against
   `/api/stream/asset-hub/netflows-daily?network=polkadot&months=2022-01` answered
   `text/event-stream` with first bytes at 136 ms of a 176 ms total — the `retry:` hint and the
   month's full envelope arrived immediately, not at connection close. The edge passes SSE
   through. (The long-lived heartbeat path is unobservable while the store is full — every
   watchable month completes instantly — so that half of the question waits for the first cold
   month; the client's polling fallback covers it meanwhile.) The same probe showed the edge
   gzips the aggregate: ~2.75 MB of JSON travels compressed.
3. **A 1 GB persistent volume mounted at `/data`**, in the compose file on the VM — the one thing
   this repository cannot do for itself. The exact change is in
   [the section below](#the-volume-and-the-change-an-operator-has-to-make). Until it exists,
   `/netflows/` returns 503 for every visitor and `/api/health` reports
   `"store":{"available":false}`. Eviction is still deliberately unbuilt
   ([decision 0006](../decisions/0006-demand-driven-store.md)) and should become a stated decision
   at the same time, not later.

## The volume, and the change an operator has to make

**This repository cannot make this change, but the file is not a mystery.** The deploy workflow's
last step is `sudo /usr/local/bin/deploy-service polkadot-analytics <digest>`, which recreates a
service defined in a compose file on the VM at `/mnt/pd/stack/docker-compose.yml`. That file is
**tracked**, in the `cypherpunk-agency/server-setup` repository as `stack/docker-compose.yml`;
find our block under the `polkadot-analytics` service key. It is a single file covering every
service on the host, each with its own hardening posture, which is why one session editing it is
an infra decision rather than ours — two writers is the split-brain the snapshot discipline exists
to prevent. Infra-shape changes (volumes, resources, Caddy) go to them and turn around in minutes.

Everything on our side is done: the image sets `ANALYTICS_DATA_DIR=/data`, creates `/data` owned by
uid 1000, and CI proves the store opens when something is mounted there and degrades cleanly when
nothing is.

What has to happen on `web-server` (`europe-west1-b`), once:

1. Add a named volume to the `polkadot-analytics` service in the VM's compose file:

   ```yaml
   services:
     polkadot-analytics:
       # … unchanged: image, read_only: true, networks, deploy.resources.limits …
       volumes:
         - polkadot-analytics-data:/data

   volumes:
     polkadot-analytics-data:
   ```

   Nothing is published: Caddy reverse-proxies over the shared `web` network, so this service has
   no `ports`. Resource limits live under `deploy.resources.limits`, not `mem_limit`.

   A **named** volume, not a bind mount: Docker seeds a fresh named volume from the image's `/data`,
   ownership included, so the container's uid 1000 can write to it with no `chown` and no root. A
   host bind mount would have to be `chown 1000:1000`ed by hand, and forgetting that fails in exactly
   the same way as having no volume.

2. Keep `read_only: true`. The volume is the only writable path and that is the design.

3. **Nothing enforces 1 GB — not the app, and not the volume.** A Docker named volume here is a
   directory on the host's data disk with no per-volume quota, and this service never deletes a
   stored fact (decision 0006 defers eviction until storage pressure is real, and it has not been
   implemented). So 1 GB is a sizing estimate, not a limit, and the honest control is a disk alert
   on the host rather than a number in this document. The measured fill rate (14–17 kB per source-day)
   means 1 GB is roughly
   160,000 source-days — but a runaway job is a runaway job.

4. Redeploy, then confirm from off the box:

   ```
   curl -s https://analytics.cypherpunk.agency/api/health | grep -o '"store":{[^}]*}'
   # want: "store":{"available":true}

   curl -s https://analytics.cypherpunk.agency/api/health | jq '.canaries.ok'
   # want: true. null means nothing has been checked yet — wait for the first tick.
   ```

   Then watch it fill. `/api/asset-hub/netflows-daily?month=2026-07&network=polkadot` answers 200
   with a `coverage` block from the first request; `coverage.complete` turns true when that month's
   job finishes. The whole 2022 → 2026 Polkadot series is roughly 50 minutes of polite serial
   fetching, once, and Kusama's 2021 → 2026 one measured 33 minutes.

**Nothing here is a credential and nothing here belongs in this repository's settings.** The volume
is a line in a compose file on a VM.

### If the backfill should not run against the public RPCs from the VM

It does not have to. The store is a single SQLite file and the CLI drains the same queue with the
same engine, so it can be filled anywhere and copied in:

```
ANALYTICS_DATA_DIR=./data node scripts/job.mjs enqueue asset-hub netflows-daily month=2026-07 network=polkadot
ANALYTICS_DATA_DIR=./data node scripts/job.mjs run
# then copy data/store.sqlite into the volume with the container stopped
```

Stop the container first — copying a SQLite file with a live writer attached copies a torn WAL. This
is the escape hatch, not the plan: the boot warm-up is the plan, and it is one-time because the
volume persists.

## Running it locally

You need Node 22 and nothing else. No Docker, no credentials, no `.env` — there is nothing to
configure.

```
npm install
npm run dev
```

`npm run dev` runs the Vite dev server and the API process side by side. Vite owns the documents
with hot reload on port 5180 and proxies `/api` and `/healthz` to the API on 8080, so the browser
only ever talks to one origin — which is exactly what the production CSP requires, and means a
CSP-related mistake shows up in development rather than in production.

```
npm run preview
```

`npm run preview` builds and then serves the real thing: the production Node server, serving
`dist/`, with the same headers and the same caching it will use in production. Use it when you are
about to change anything about routing, caching, headers or the container — the dev server is not
the thing that gets deployed, and `preview` is.

### Behind an HTTP proxy — including any sandboxed agent session

Node 22's `fetch` **ignores `HTTPS_PROXY`**. It has no proxy support switched on by default and
`undici` only reads the environment when `NODE_USE_ENV_PROXY=1` is set. So in an environment where
all outbound traffic must go through a local proxy — the usual shape of a sandboxed agent session
— every `server/sources/` module fails while `curl` to the same host succeeds, and the failure is
not a timeout: the interception layer answers, so it arrives as a plausible **HTTP 403 from the
upstream**. `/api/asset-hub/sovereign-dot` returns
`{"error":{"kind":"upstream","source":"polkadot-rpc","message":"polkadot-rpc returned HTTP 403."}}`
and every page renders its "this upstream is having a bad day" branch, correctly and for entirely
the wrong reason. Observed 2026-08-20.

```
NODE_USE_ENV_PROXY=1 node server/index.mjs
```

is the whole fix, and it belongs in the shell rather than in the repository: nothing about the
deployed container needs it, and hard-coding a dispatcher would be a proxy the production image
does not want. The trap worth knowing is the diagnosis, not the flag — a page's error branch
rendering perfectly is *not* evidence that an upstream is down.

```
npm run check
```

Runs the same verification CI runs: syntax across `server/`, `src/` and `scripts/`; the secret
tripwire; the source-registry contract (every source has `id`, `label`, `operations`; every
operation has `summary`, `ttlMs`, `run`); and the "no third-party origin outside
`server/sources/`" invariant. Green locally means the same thing as green in CI, on purpose.

## Related

- `docs/architecture/security.md` — the CSP, why upstream calls happen server-side
- `docs/decisions/0003-no-secrets.md` — why there are no credentials anywhere
- `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/check.mjs`
