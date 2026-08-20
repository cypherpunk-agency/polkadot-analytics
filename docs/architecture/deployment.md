# Deployment

How this service becomes a container, what that container needs from the world, and what is still
missing before it can actually ship.

**Status as of 2026-08-19: the deploy job is gated off.** Pushes to `main` build and publish an
image. Nothing pulls it. See [What is still owed](#what-is-still-owed) for the exact list.

---

## What is being deployed

One image, one process. Inside it:

- **the static site** — a Vite multi-page build. Every page directory at the repo root that holds an
  `index.html` becomes a page; `xcm/index.html` is served at `/xcm/`.
- **the server** — `server/index.mjs`, about 250 lines of `node:http`. It serves `dist/` and answers
  a read-only, cached API at `/api/*` that proxies public upstreams.

There is no second container, no database, no cache server, no queue and no sidecar. The response
cache is a `Map` in the process; a restart empties it and the next request refills it.

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

Nothing.

That is worth stating plainly, because it is unusual and it is the property that makes everything
else about this deployment boring:

- **No secrets.** Every upstream is anonymous public HTTP. No API key, no token, no `Authorization`
  header, no `.env`, no secret store, no mounted credential file. `server/lib/upstream.mjs` is the
  single place any outbound request is made, and it attaches no credentials to anything — see
  `docs/decisions/0003-no-secrets.md`.
- **No volumes.** Nothing is written to disk at runtime. The image is designed to run with
  `--read-only`, and CI asserts that it does.
- **No datastore.** No Postgres, no Redis, no object storage.
- **No configuration** beyond three variables, none of which is sensitive:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `BUILD_STAMP` | `unknown` | the deployed git sha, reported by `/api/health` |

`BUILD_STAMP` is what makes "is the new version actually live?" answerable by asking the service
instead of inferring it from a container start time.

A minimal run looks like this, and it is the full set of flags:

```
docker run -d --name polkadot-analytics \
  --read-only \
  --memory 256m \
  --publish 127.0.0.1:8080:8080 \
  ghcr.io/cypherpunk-agency/polkadot-analytics:<sha>
```

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
  "cache": { "entries": 12, "approxBytes": 918273, "hits": 88, "misses": 12, "…": 0 }
}
```

**This is the one external monitoring should watch.** `/healthz` only proves that something accepted
a TCP connection and wrote four bytes. `/api/health` proves the app layer is actually wired: the
source registry imported, the codec modules under `src/core/` resolved, the cache constructed, and
the JSON layer works. A deploy that shipped a broken import would still pass `/healthz` right up
until the first real request.

It also reports `build`, so an alert can distinguish "the service is down" from "the service is up
and serving last week's code" — which is the failure a plain 200 check will never catch.

### What neither of them does

Neither endpoint calls an upstream, and that is a deliberate design decision rather than an
oversight. A health check that goes red when a public devnet node reboots is a health check
everybody learns to ignore, and an upstream outage that restarts our container makes a bad situation
worse. Upstream failures surface where they belong: as `502` on the specific `/api/<source>/<op>`
call, with `transport` versus `upstream` preserved so the reader can tell "we could not reach them"
from "they answered with an error".

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

Nothing below exists yet. Until it does, `DEPLOY_ENABLED` stays unset and the deploy job stays
skipped.

**From the infra session**, as repository *variables* — none of these is confidential, and keeping
them as variables rather than secrets keeps "this repo has no secrets" literally true:

1. **`GCP_WORKLOAD_IDENTITY_PROVIDER`** —
   `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`.
   The pool's attribute condition **must** restrict the principal to this repository (e.g.
   `assertion.repository == 'cypherpunk-agency/polkadot-analytics'`). Without that condition, any
   GitHub repository in the world can assume the identity.
2. **`GCP_SERVICE_ACCOUNT`** — the deploy service account's email. It needs exactly two things: pull
   the image, and run the pinned command on one instance. Not project editor, not compute admin.
3. **`GCP_INSTANCE`** and **`GCP_ZONE`** — the shared `e2-small` and its zone.
4. **The pinned privileged command** — the exact remote command that swaps the running container.
   It lives inline in `deploy.yml`, not in a repository variable, because a command injected from a
   variable is arbitrary remote code execution for anyone who can edit repository settings. Infra
   supplies the text; it lands in the file through code review like everything else.

Also owed, and the reason the `--ssh-key-file` box exists:

5. **OS Login enabled** (`enable-oslogin=TRUE`) on the project or the instance, plus IAP so
   `--tunnel-through-iap` can be added and public SSH closed on the VM.

And from whoever owns the edge:

6. **Caddy** terminating TLS for `analytics.cypherpunk.agency` and proxying to the container. The
   server sets its own security headers including `connect-src 'self'`, so the edge and the origin
   agree even if one of them is ever bypassed.

When all six exist, the enabling change is: set `DEPLOY_ENABLED=true`, replace the `TODO(infra)`
remote command, and flip `PINNED_COMMAND_SUPPLIED` in the preflight step — the last two in the same
reviewed pull request. The preflight step refuses to run if the flag is flipped before the values
are real, because a half-configured deploy that runs is worse than one that does not.

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
