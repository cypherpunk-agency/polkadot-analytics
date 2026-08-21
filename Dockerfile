# syntax=docker/dockerfile:1

# polkadot-analytics — the static Vite build plus the dependency-free Node server, in one image.
#
# Two facts about this repo shape almost every line below, so they are worth stating once:
#
#   1. THERE ARE NO RUNTIME DEPENDENCIES. `vite` is the only entry in package.json and it is a
#      devDependency. So the runtime stage installs nothing — no npm step, no node_modules, no
#      registry access at deploy time, and nothing in the shipped image for a CVE feed to have
#      an opinion about except Node itself.
#   2. THERE ARE NO SECRETS, AND EXACTLY ONE WRITABLE PATH. Every upstream is anonymous public
#      HTTP, so there is still no credential of any kind in this image. What HAS changed is the
#      second half: decision 0006 added the persistent store, and mode A writes `store.sqlite`.
#      The rootfs stays `--read-only`; the store lives on a volume mounted at /data, and
#      ANALYTICS_DATA_DIR below points there. Nothing else in the container writes anything.
#
#      WITH NO VOLUME MOUNTED, /data IS PART OF THE READ-ONLY ROOTFS AND THE STORE CANNOT OPEN.
#      That is a supported state, not a crash: the server logs `[store] mode A is unavailable`,
#      keeps listening, answers every TTL-cached (mode B) operation normally and answers 503 on
#      the store-backed ones. Which is to say: an image that boots and serves is NOT evidence
#      that the volume is there. `/api/health` reports `store.available` — ask it.


# ──────────────────────────────────────────────────────────────────── stage 1: build ────
FROM node:22-alpine AS build
WORKDIR /app

# Manifest before source, so the dependency layer is cached independently of page edits:
# touching a chart must not re-run the install.
#
# `npm ci` rather than `npm install`, and the lockfile is copied explicitly rather than with a
# tolerant glob: `npm ci` installs exactly what the lockfile pins, so the build is reproducible
# or it fails loudly. A build that silently resolved a different vite is not the same build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# `src/data/` holds generated datasets. It can legitimately be absent in a fresh checkout (they
# are produced by `npm run data:*`), and a missing COPY source is a hard Docker error — so
# guarantee the directory exists here, where "empty" is a normal state, instead of leaving
# stage 2 to fail on a checkout that has not built a dataset yet.
RUN mkdir -p /app/src/data


# ────────────────────────────────────────────────────────────────── stage 2: runtime ────
FROM node:22-alpine AS runtime

# The deployed git sha, surfaced on /api/health so "is the new version actually live?" is
# answerable by asking the service rather than inferring it from a container start time.
# It is a build arg because it is not a secret — nothing here is.
ARG BUILD_STAMP="unknown"

# NODE_OPTIONS pins an explicit heap ceiling. Node derives its default old-space size from the
# memory it believes the machine has, and how faithfully that tracks a cgroup limit has varied
# between versions. On a shared 2 GB VM with a 256 MB container limit, guessing wrong means the
# kernel OOM-kills the process with no stack trace and no log line. Capped here, the same
# overrun surfaces as a readable JavaScript heap error instead. 192 MB leaves room for the
# 48 MB response cache plus a 24 MB in-flight upstream body.
#
# ANALYTICS_DATA_DIR is set HERE rather than left to the deployment, and that is the point: the
# store's default is `<repo>/server/data`, which inside this image is a path in the read-only
# rootfs. Left unset, every deployment would have to remember to supply it, and forgetting is
# invisible — the site comes up, mode B works, and only the store-backed pages 503. Naming the
# path in the image means the compose file has one job (mount something at /data) instead of two
# (mount something, and point an environment variable at it), and the two can no longer disagree.
ENV BUILD_STAMP=$BUILD_STAMP \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ANALYTICS_DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=192

# The mount point, created in the image and owned by uid 1000 — and creating it is not cosmetic.
# When Docker mounts a NAMED VOLUME over a path that exists in the image, it seeds the empty
# volume from that path, ownership included, so a fresh volume arrives owned by `node` and the
# process can write to it on the first boot with no runtime chown and no root. Mount an empty
# named volume over a path that does NOT exist in the image and it is created owned by root
# instead: the container starts, cannot write, and reports exactly the same "mode A is
# unavailable" as having no volume at all. One `mkdir` is the difference.
#
# (A BIND MOUNT does not inherit anything — the host directory's ownership wins — so a host path
# must be `chown 1000:1000`ed by the operator. Named volume for preference, precisely because it
# takes that step away from a human.)
#
# There is deliberately NO `VOLUME /data` instruction. `VOLUME` makes Docker create an ANONYMOUS
# volume whenever the run does not supply one, which would turn "somebody forgot to configure
# persistence" into a store that works perfectly and is silently discarded on every redeploy —
# fetching the whole backfill again from other people's RPC nodes, every deploy, with nothing
# anywhere reporting it. Failing to open the store is loud in the log and visible on
# /api/health; a volume that quietly resets is neither.
RUN mkdir -p /data && chown 1000:1000 /data

WORKDIR /app

# Exactly five paths, and deliberately no `npm ci --omit=dev`: there are no runtime deps to
# install, so an install step here would add an npm invocation, a network round trip and an
# empty node_modules for nothing.
#
#   dist/       the built site
#   server/     the whole service
#   src/core/   pure-JS codec/pricing/format modules the server imports directly — see the
#               `../../src/core/...` imports in server/sources/*.mjs. They are shared with the
#               browser bundle, which is exactly why they are pure and have no deps.
#   src/data/   generated datasets. Today the browser bundle imports them at build time, so
#               they are already inside dist/; they are carried here as well because the
#               server is specified to read them from disk, and that must not become an
#               image change on the day it does.
#   package.json  copied for ONE reason: `"type": "module"`. Nothing installs from it. The
#               `.js` files under src/core/ are ESM, and without the declaration Node falls
#               back to sniffing each file for module syntax — a heuristic that re-parses on
#               load and that can decide differently for a file readable either way. Verified:
#               the server does start without it on Node 22, which is exactly why it is worth
#               saying out loud that we are not relying on that.
COPY --from=build /app/dist         ./dist
COPY --from=build /app/server       ./server
COPY --from=build /app/src/core     ./src/core
COPY --from=build /app/src/data     ./src/data
COPY --from=build /app/package.json ./package.json

# Drop privileges. `node` (uid 1000) ships with the base image, so there is no useradd layer.
#
# Note what is NOT done here: the copied files stay owned by root. The service only ever reads
# them, so root-owned and world-readable means the process cannot rewrite its own code even
# before `--read-only` is applied at run time. Chowning them to `node` would quietly undo that.
# /data above is the single exception, and the exception is the whole design: exactly one path
# this uid can write, and it holds nothing but fetched public data.
USER node

EXPOSE 8080

# Liveness. `/healthz` is the right target for the container check specifically because it
# never touches an upstream: a third-party outage must not be able to restart this container.
# The deeper probe for external monitoring is `/api/health` — see docs/architecture/deployment.md.
#
# busybox `wget` from the base image rather than `node -e "fetch(...)"`: spawning a second Node
# process costs ~40 MB every 30 seconds, which on a 2 GB VM shared with other services is real
# money. `grep -qx ok` asserts the exact body, so a proxy returning a 200 error page fails too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/healthz" | grep -qx ok

# `node server/index.mjs`, not `npm start`. npm would fork a second process, add its own memory,
# and sit between Docker's SIGTERM and the server's shutdown handler — the handler that exists
# precisely so a redeploy finishes in-flight requests instead of cutting them. Exec form, so
# Node is PID 1 and receives signals directly.
CMD ["node", "server/index.mjs"]

LABEL org.opencontainers.image.title="polkadot-analytics" \
      org.opencontainers.image.licenses="Unlicense" \
      org.opencontainers.image.description="Public analytics dashboards for the Polkadot ecosystem" \
      org.opencontainers.image.url="https://analytics.cypherpunk.agency" \
      org.opencontainers.image.source="https://github.com/cypherpunk-agency/polkadot-analytics" \
      org.opencontainers.image.revision=$BUILD_STAMP
