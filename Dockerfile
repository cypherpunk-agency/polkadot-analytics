# syntax=docker/dockerfile:1

# polkadot-analytics — the static Vite build plus the dependency-free Node server, in one image.
#
# Two facts about this repo shape almost every line below, so they are worth stating once:
#
#   1. THERE ARE NO RUNTIME DEPENDENCIES. `vite` is the only entry in package.json and it is a
#      devDependency. So the runtime stage installs nothing — no npm step, no node_modules, no
#      registry access at deploy time, and nothing in the shipped image for a CVE feed to have
#      an opinion about except Node itself.
#   2. THERE ARE NO SECRETS AND NO WRITABLE STATE. The cache is in-process, the datasets are
#      baked in at build time, and every upstream is anonymous public HTTP. The container is
#      built to run with `--read-only` and no volume; if it ever needs to write something, that
#      is a design change to argue about, not a flag to add.


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
ENV BUILD_STAMP=$BUILD_STAMP \
    NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=192

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
