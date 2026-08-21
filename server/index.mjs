// The whole server: static files, one API surface, one health check.
//
// No framework. Not for sport — the dependency surface of this container is the attack surface
// of a public, ungated service, and `node:http` plus the registry in `sources/` is genuinely
// all this needs. `npm ci` installs nothing at runtime; see the Dockerfile.
//
// Routes:
//   GET /healthz              liveness. Never touches an upstream — see below.
//   GET /api                  what this service can answer, generated from the registry
//   GET /api/health           the app layer is wired, plus cache statistics
//   GET /api/jobs/:id         one job's state, for polling a partial answer to completion
//   GET /api/:source/:op      one validated, read-only operation — cached (mode B) or
//                             store-backed (mode A), decided by the registry, see below
//   GET /*                    the static build
//
// ── two answer modes, one URL shape ──────────────────────────────────────────────────────────
// A reader asks for `/api/hydration/trades?days=365` the same way whichever mode answers it.
// What differs is where the answer comes from (docs/concept/plan.md §2):
//
//   B. TTL CACHE (mutable data — TVL now, a head block). `operations` entry, `op.run(params)`,
//      one cached upstream call. Unchanged since v1, and the code path below is untouched.
//   A. THE STORE (immutable data — a closed day, a finalised block window). `jobs` entry, no
//      upstream call on the request path at all: the store is read, and if it does not yet
//      hold everything, a job is found-or-created to fill it and the reader is told so in the
//      same 200. See server/lib/demand.mjs, which owns that decision and its abuse posture.
//
// A `jobs` entry WINS over an `operations` entry of the same name. Declaring both is a
// registry mistake rather than a feature — one operation, one mode — and this resolution order
// makes the mistake visible (the `run` never fires) instead of racy.
//
// ── testability ──────────────────────────────────────────────────────────────────────────────
// `createApp()` builds the request handler and binds no port; the listener at the bottom runs
// only when this file is the entry point. Its `registry` option is the same injection seam as
// `runJob`'s `resolveHandler` in job-worker.mjs: a parameter of a factory function, used by
// tests to pass a synthetic source. It is not runtime registration — nothing mutates SOURCES,
// there is no `register()`, no env var, and no request can reach it. The default is always the
// registry, and the registry stays the security boundary.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TtlCache } from './lib/cache.mjs'
import { UpstreamError } from './lib/upstream.mjs'
import { ParamError, cacheKey, readParams } from './lib/params.mjs'
import { openStore, defaultDataDir } from './lib/store.mjs'
import { JobQueue } from './lib/jobs.mjs'
import { ensureWorker as spawnWorker } from './lib/job-worker.mjs'
import { describeJob, serveFromStore, storedAnswer } from './lib/demand.mjs'
import { warmStore } from './lib/warm.mjs'
import { runCanaries } from './lib/canary.mjs'
import { describe, resolve as resolveOperation, resolveJob } from './sources/index.mjs'

const ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Emitted only OUTSIDE production. In production Caddy is the single owner of security
 * headers — it serves this exact policy (it adopted our stricter directives verbatim,
 * agent bridge 2026-08-20), and two CSP headers on one response are a trap: browsers
 * enforce the intersection, so whoever later edits one header gets a policy that silently
 * under-delivers because the other still constrains. But the header cannot simply go away:
 * `npm run preview` has no Caddy in front, and this header is the local tripwire for the
 * silent-CSP-breakage class that already bit us once (see design-system.md). So: one
 * header, one owner per environment.
 *
 * `connect-src 'self'` is the load-bearing directive: the browser may talk to this origin
 * and nothing else, which is the whole reason the upstream calls happen server-side. See
 * docs/architecture/security.md.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

const EMIT_CSP = process.env.NODE_ENV !== 'production'

/**
 * How often the durability canaries re-ask their upstreams (server/lib/canary.mjs).
 *
 * Fifteen minutes, on the same one-minute tick as the re-warm but its own clock. The thing being
 * watched is a RETENTION POLICY — orca's routed-trade floor — and a retention policy moves at
 * most a handful of times in the life of an indexer, so a minute-by-minute check would be one
 * extra GraphQL request a minute, forever, to learn something that changes once. Fifteen minutes
 * is still four orders of magnitude finer than the event, and it means the answer `/api/health`
 * publishes is never more than a quarter of an hour old.
 *
 * It also runs once at boot, unconditionally, which is the reading a human sees in the deploy log.
 */
const CANARY_INTERVAL_MS = 15 * 60_000

/** The headers every response carries, streaming or not. One derivation, because a streaming
 *  path that rebuilt them by hand would drift from `send()` the first time either changed. */
function baseHeaders(headers = {}) {
  return {
    ...(EMIT_CSP ? { 'content-security-policy': CSP } : {}),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...headers,
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders(headers))
  res.end(body)
}

const sendJson = (res, status, value, headers = {}) =>
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers })

/* --------------------------------------------------------------------------- static ---- */

async function serveStatic(res, pathname) {
  // Directory URLs map to their index.html: `/xcm/` -> `dist/xcm/index.html`.
  const wanted = pathname.endsWith('/') ? `${pathname}index.html` : pathname

  // `normalize` collapses `..` before the prefix check, so a path that tries to climb out of
  // dist fails the check rather than resolving somewhere interesting.
  const target = join(DIST, normalize(wanted))
  if (!target.startsWith(DIST + sep) && target !== DIST) return send(res, 403, 'Forbidden')

  let info
  try {
    info = await stat(target)
  } catch {
    // Not a file. Try the directory form once — `/xcm` should reach the same page as `/xcm/` —
    // and otherwise this is a genuine 404. There is deliberately no SPA catch-all: these are
    // separate documents, and a catch-all would answer 200 for every typo.
    if (!pathname.endsWith('/') && !extname(pathname)) {
      return serveStatic(res, `${pathname}/`)
    }
    return notFound(res)
  }
  if (info.isDirectory()) return serveStatic(res, `${pathname}/`)

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  // Vite fingerprints everything under /assets, so those are immutable. Documents are not.
  const cacheControl = target.includes(`${sep}assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=60'

  send(res, 200, await readFile(target), { 'content-type': type, 'cache-control': cacheControl })
}

async function notFound(res) {
  try {
    return send(res, 404, await readFile(join(DIST, '404.html')), { 'content-type': MIME['.html'] })
  } catch {
    return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
  }
}

/* ------------------------------------------------------------------------------ api ---- */

async function serveApi(ctx, req, res, segments, query) {
  if (segments.length === 0) return sendJson(res, 200, describe())

  if (segments.length === 1 && segments[0] === 'health') {
    // Deliberately does NOT call an upstream. This endpoint answers "is the app wired", and an
    // upstream outage is their problem, not our liveness. A health check that goes red when a
    // devnet node reboots trains everyone to ignore it.
    return sendJson(
      res,
      200,
      {
        ok: true,
        service: 'polkadot-analytics',
        build: process.env.BUILD_STAMP ?? null,
        uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
        cache: ctx.cache.report(),
        // Whether mode A is available at all. A container started without a writable data
        // directory serves mode B perfectly and mode A not at all, and that is a difference
        // worth being able to ask about rather than infer from a 503.
        store: { available: ctx.store !== null },
        // THE DURABILITY CANARIES — server/lib/canary.mjs. Reported here rather than computed
        // here: the checks talk to upstreams and this endpoint must not, so a background tick
        // runs them and this publishes the last answer with the time it was taken.
        //
        // A sibling of `store` rather than a field inside it, deliberately. `store` answers "is
        // mode A wired", the question a 503 makes you ask, and infra's own runbook greps this
        // response for the literal `"store":{...}` — a nested array would quietly change what
        // that matches. Two questions, two keys.
        //
        // `canaries.ok` is the one field an alert needs: false when anything is at risk OR could
        // not be checked, null when nothing has been checked yet — which is NOT the same as true
        // and must not be read as it. It deliberately does NOT move the `ok` above: a store that
        // has stopped being re-derivable is a thing to tell somebody about, not a reason to
        // restart a container or take a healthy site out of a load balancer.
        canaries: ctx.canaries,
      },
      { 'cache-control': 'no-store' },
    )
  }

  // `jobs` is a RESERVED first segment under /api, not a source. Claimed before the registry
  // is consulted so the meaning of this URL cannot change on the day someone adds a source
  // called "jobs".
  if (segments[0] === 'jobs') return serveJobStatus(ctx, res, segments)

  // `stream` is the second RESERVED first segment, claimed for the same reason `jobs` is:
  // /api/stream/<source>/<operation> holds an identity-watch open over Server-Sent Events, and
  // that meaning must not change on the day someone adds a source called "stream".
  if (segments[0] === 'stream') return serveStream(ctx, req, res, segments.slice(1), query)

  if (segments.length !== 2) {
    return sendJson(res, 404, { error: { kind: 'request', message: 'Expected /api/<source>/<operation>.' } })
  }

  const [sourceId, operationId] = segments

  // Mode A first — see the header. A source with no `jobs` entry falls straight through to the
  // unchanged mode-B path below.
  const job = ctx.registry.resolveJob(sourceId, operationId)
  if (job.handler) return serveStoreBacked(ctx, res, sourceId, operationId, job, query)

  const { source, operation, error } = ctx.registry.resolve(sourceId, operationId)
  if (error) return sendJson(res, 404, { error: { kind: 'request', message: error } })

  // Store-read operations — the third shape, between the two modes. Like mode A it answers from
  // the persistent store and is cached by completeness; like mode B it is an `operations` entry
  // with a `run`. The difference from mode B is the contract: `run(params, ctx)` receives the
  // store context, returns `{ complete, body }`, and is NEVER put behind the TTL cache — a
  // cached "3 months missing" would outlive the months landing, and the browser would be handed
  // a max-age that turns its own polling into a mirror.
  if (operation.store === true) return serveStoreRead(ctx, res, sourceId, operationId, { source, operation }, query)

  let params
  try {
    params = readParams(Object.fromEntries(query), operation.schema ?? {})
  } catch (problem) {
    if (problem instanceof ParamError) {
      return sendJson(res, 400, { error: { kind: 'request', message: problem.message } })
    }
    throw problem
  }

  const key = cacheKey(sourceId, operationId, params)
  const fresh = ctx.cache.peek(key) === undefined

  try {
    const value = await ctx.cache.resolve(key, operation.ttlMs, () => operation.run(params))
    return sendJson(
      res,
      200,
      { source: source.id, operation: operationId, params, data: value },
      {
        // Let Caddy and the browser hold it for the same window the server does; a client that
        // re-asks inside the TTL gets the same bytes either way.
        'cache-control': `public, max-age=${Math.round(operation.ttlMs / 1000)}`,
        'x-cache': fresh ? 'miss' : 'hit',
      },
    )
  } catch (problem) {
    if (problem instanceof UpstreamError) {
      // 502, not 500: this service is fine, the thing it reads is not, and the distinction is
      // what stops an upstream outage from reading as our bug.
      return sendJson(res, 502, problem.toPayload(), { 'cache-control': 'no-store' })
    }
    console.error(`[api] ${sourceId}/${operationId} failed:`, problem)
    return sendJson(
      res,
      500,
      { error: { kind: 'server', source: sourceId, message: 'The request failed inside this service.' } },
      { 'cache-control': 'no-store' },
    )
  }
}

/** Mode A: read the store, and enqueue only if it does not already hold the answer. */
async function serveStoreBacked(ctx, res, sourceId, operationId, { handler }, query) {
  if (!ctx.store) {
    // Mode B is unaffected by this and keeps serving; saying which half is down beats a blanket
    // 500 that makes the whole service look broken.
    return sendJson(
      res,
      503,
      {
        error: {
          kind: 'server',
          source: sourceId,
          message:
            'This operation is served from the persistent store, which this instance could not ' +
            'open. Cached (mode B) operations are unaffected.',
        },
      },
      { 'cache-control': 'no-store' },
    )
  }

  let params
  try {
    // A job handler declares its own schema, same shape as an operation's. No schema means NO
    // parameters — readParams rejects unknown names, so the permissive reading is impossible.
    params = readParams(Object.fromEntries(query), handler.schema ?? {})
  } catch (problem) {
    if (problem instanceof ParamError) {
      return sendJson(res, 400, { error: { kind: 'request', message: problem.message } })
    }
    throw problem
  }

  try {
    const answer = await serveFromStore({
      store: ctx.store,
      queue: ctx.queue,
      sourceId,
      operationId,
      params,
      handler,
      startWorker: ctx.startWorker,
    })
    return sendJson(res, answer.status, answer.body, {
      // A complete answer is immutable data and may be held; a partial one changes as the job
      // advances, and a cached partial would strand a reader on a coverage bar that never
      // moves. `no-store` on anything with a live job, deliberately.
      'cache-control': answer.complete ? 'public, max-age=300' : 'no-store',
      'x-store': answer.complete ? 'complete' : 'partial',
    })
  } catch (problem) {
    console.error(`[api] ${sourceId}/${operationId} (store) failed:`, problem)
    return sendJson(
      res,
      500,
      { error: { kind: 'server', source: sourceId, message: 'The request failed inside this service.' } },
      { 'cache-control': 'no-store' },
    )
  }
}

/**
 * A store-read operation: `run(params, {store, queue, startWorker})` composes an answer out of
 * the persistent store — many identities in one response, where mode A serves exactly one. The
 * first user is `asset-hub/netflows-series` (decision 0020), which folded a page's fifty-six
 * per-month requests into this one.
 *
 * Completeness decides the caching, exactly as it does for mode A: a complete answer is
 * immutable data and may be held; an incomplete one is `no-store`, because it is the thing a
 * reader polls while the store fills and a cached partial would strand them on a chart that
 * never gains its months.
 *
 * SINGLE-FLIGHT, because the composition is not free: the first user reads ~55 identities and
 * serialises the result to the better part of a megabyte, all on the HTTP thread. N identical
 * concurrent requests — the edge's burst limit admits 60 — must cost one composition, not N
 * heaps of it. Identical requests share the promise; the params space is enum-bound, so the
 * in-flight map cannot be grown by an attacker.
 */
const storeReadsInFlight = new Map()

async function serveStoreRead(ctx, res, sourceId, operationId, { source, operation }, query) {
  if (!ctx.store) {
    return sendJson(
      res,
      503,
      {
        error: {
          kind: 'server',
          source: sourceId,
          message:
            'This operation is served from the persistent store, which this instance could not ' +
            'open. Cached (mode B) operations are unaffected.',
        },
      },
      { 'cache-control': 'no-store' },
    )
  }

  let params
  try {
    params = readParams(Object.fromEntries(query), operation.schema ?? {})
  } catch (problem) {
    if (problem instanceof ParamError) {
      return sendJson(res, 400, { error: { kind: 'request', message: problem.message } })
    }
    throw problem
  }

  try {
    const key = cacheKey(sourceId, operationId, params)
    let flight = storeReadsInFlight.get(key)
    if (!flight) {
      flight = Promise.resolve().then(() => operation.run(params, { store: ctx.store, queue: ctx.queue, startWorker: ctx.startWorker }))
      storeReadsInFlight.set(key, flight)
      // Both arms, not .finally(): a .finally() chain re-throws the rejection into a promise
      // nobody awaits, which Node treats as an unhandled rejection even though every actual
      // caller handled theirs.
      const evict = () => storeReadsInFlight.delete(key)
      flight.then(evict, evict)
    }
    const answer = await flight
    return sendJson(
      res,
      200,
      { source: source.id, operation: operationId, params, data: answer.body },
      {
        'cache-control': answer.complete ? 'public, max-age=300' : 'no-store',
        'x-store': answer.complete ? 'complete' : 'partial',
      },
    )
  } catch (problem) {
    console.error(`[api] ${sourceId}/${operationId} (store-read) failed:`, problem)
    return sendJson(
      res,
      500,
      { error: { kind: 'server', source: sourceId, message: 'The request failed inside this service.' } },
      { 'cache-control': 'no-store' },
    )
  }
}

/* --------------------------------------------------------------------------- streaming ---- */

/**
 * GET /api/stream/<source>/<operation> — an identity watch over Server-Sent Events.
 *
 * A reader who was answered a partial series holds this open and is handed each identity's
 * complete envelope as it lands, instead of re-fetching the whole aggregate on a timer. The
 * envelope is the SAME one the mode-A endpoint answers for that identity, so arrival over the
 * stream and arrival over HTTP are one decoding path on the page.
 *
 * What this endpoint deliberately is NOT:
 *
 *   · NOT DEMAND. It calls `storedAnswer` — the read-only sibling of `serveFromStore` — and
 *     never enqueues, raises, or spawns. The aggregate (or per-month) read is what turns a
 *     reader into demand; holding a connection open must not be a way to hold a job open, or an
 *     idle tab becomes a standing order against a volunteer-run RPC.
 *   · NOT A NOTIFICATION BUS. There is no pub/sub anywhere in this service (the drain worker
 *     writes SQLite and exits; nothing emits events), so this polls the store on a slow tick.
 *     That is a deliberate ceiling: the freshness a human watching a chart needs is seconds,
 *     and a poll every few seconds against a local indexed SQLite aggregate costs microseconds.
 *   · NOT UNBOUNDED. Concurrent watches are capped, the watch itself has a lifetime cap, and a
 *     `gave-up` identity is reported as `stalled` and dropped from the watch — a surrendered
 *     job will not resolve on its own (decision 0018's cousin: waiting on it politely is still
 *     waiting forever), so keeping it in the wanted set would pin every such stream at its
 *     lifetime cap for nothing.
 *
 * Wire shape: `retry:` hint first, then per landed identity one `event: <handler.watch.event>`
 * whose `id` is the canonical params and whose `data` is the envelope; `event: stalled` for a
 * surrendered identity; a comment heartbeat every few ticks so proxies keep the pipe open; and
 * `event: done` (then a clean end) once nothing is left to watch. A client that misses events
 * and reconnects re-sends its wanted list, and re-delivered envelopes are idempotent to apply.
 */
async function serveStream(ctx, req, res, segments, query) {
  const config = ctx.streamConfig
  if (segments.length !== 2) {
    return sendJson(res, 404, { error: { kind: 'request', message: 'Expected /api/stream/<source>/<operation>.' } })
  }
  const [sourceId, operationId] = segments
  const job = ctx.registry.resolveJob(sourceId, operationId)
  if (!job.handler) {
    return sendJson(res, 404, { error: { kind: 'request', message: `No store-backed operation \`${sourceId}/${operationId}\` to watch.` } })
  }
  const watch = job.handler.watch
  if (!watch) {
    return sendJson(res, 404, { error: { kind: 'request', message: `\`${sourceId}/${operationId}\` does not declare a watch.` } })
  }
  if (!ctx.store) {
    return sendJson(
      res,
      503,
      { error: { kind: 'server', source: sourceId, message: 'The persistent store is not available on this instance.' } },
      { 'cache-control': 'no-store' },
    )
  }

  let params
  try {
    params = readParams(Object.fromEntries(query), watch.schema ?? {})
  } catch (problem) {
    if (problem instanceof ParamError) {
      return sendJson(res, 400, { error: { kind: 'request', message: problem.message } })
    }
    throw problem
  }

  if (ctx.streams.size >= config.maxConcurrent) {
    return sendJson(
      res,
      503,
      {
        error: {
          kind: 'server',
          source: sourceId,
          message: `This instance is already holding ${ctx.streams.size} watches open, which is the cap. Poll the aggregate endpoint instead, or ask again shortly.`,
        },
      },
      { 'cache-control': 'no-store' },
    )
  }

  // The wanted set. Keyed by the canonical identity so a duplicate in the request collapses.
  const wanted = new Map()
  for (const identityParams of watch.identities(params)) {
    wanted.set(JSON.stringify(identityParams), identityParams)
  }

  res.writeHead(
    200,
    baseHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // Tells nginx-family proxies not to buffer. Caddy streams `text/event-stream` on its own;
      // this header is for whatever else ends up in the path, and costs nothing where it is
      // ignored. The client keeps a polling fallback either way — a proxy that buffers this
      // stream downgrades the page to polling, it does not break it.
      'x-accel-buffering': 'no',
    }),
  )
  // A HEAD probe gets the headers and a clean end — never a held-open connection with no body.
  if (req.method === 'HEAD') return res.end()

  res.write(`retry: ${config.retryMs}\n\n`)

  const stream = { res, timer: null }
  ctx.streams.add(stream)
  const startedAt = Date.now()
  let ticks = 0
  let pumping = false

  const stop = () => {
    if (stream.timer) clearInterval(stream.timer)
    stream.timer = null
    ctx.streams.delete(stream)
  }
  // `reason` is MACHINE-READABLE and the client dispatches on it: only `complete` means "close
  // and stop following". Anything else ('lifetime', 'failure') tells the client the watch ended
  // for the server's reasons while months are still pending, and the client falls back to
  // polling. A prose-only note here was the first confirmed finding of this change's review —
  // the client cannot read prose, so every redeploy and every lifetime cap read as "finished"
  // and permanently orphaned a mid-fill page.
  const finish = (reason, note) => {
    if (res.writableEnded || res.destroyed) return stop()
    res.write(`event: done\ndata: ${JSON.stringify({ reason, note })}\n\n`)
    stop()
    res.end()
  }

  const pump = async () => {
    if (pumping || res.writableEnded || res.destroyed) return
    pumping = true
    try {
      // A client that has stopped reading is not a client — it is a buffer filling on this
      // process's heap. The frames a watch delivers are bounded (each identity once), but a
      // stalled socket must not hold what it will never drain: past this high-water mark the
      // watch is ended, and the client's reconnect or polling fallback picks it back up.
      if (res.writableLength > 4 * 1024 * 1024) {
        return finish('failure', 'This connection stopped reading and was dropped. Re-subscribe or poll.')
      }
      for (const [key, identityParams] of wanted) {
        const answer = await storedAnswer({
          store: ctx.store,
          queue: ctx.queue,
          sourceId,
          operationId,
          params: identityParams,
        })
        if (res.writableEnded || res.destroyed) return
        if (answer.state === 'complete') {
          res.write(`event: ${watch.event}\nid: ${key}\ndata: ${JSON.stringify(answer.body)}\n\n`)
          wanted.delete(key)
        } else if (answer.state === 'stalled') {
          res.write(`event: stalled\nid: ${key}\ndata: ${JSON.stringify({ params: identityParams, job: answer.job })}\n\n`)
          wanted.delete(key)
        }
      }
      if (wanted.size === 0) return finish('complete', 'Everything watched has landed or stalled.')
      if (Date.now() - startedAt >= config.maxMs) {
        return finish('lifetime', `Watch lifetime reached with ${wanted.size} identities still pending.`)
      }
      ticks += 1
      if (ticks % config.heartbeatEvery === 0) res.write(`: watching ${wanted.size}\n\n`)
    } catch (problem) {
      console.error(`[stream] ${sourceId}/${operationId} failed:`, problem)
      finish('failure', 'The watch failed inside this service.')
    } finally {
      pumping = false
    }
  }

  res.on('close', stop)
  stream.timer = setInterval(pump, config.pollMs)
  await pump()
}

/**
 * GET /api/jobs/:id — the poll target a partial answer hands out.
 *
 * What is deliberately absent:
 *
 *   · NO LISTING. `/api/jobs` is a 404, not an index. This is a public, ungated site and who is
 *     looking at what is nobody's business; `job list` on the CLI serves the operator.
 *   · NO CANCEL, NO RETRY, NO ENQUEUE. Those are state changes, and this service answers GET
 *     only. They stay CLI-only: an anonymous caller who could cancel could erase another
 *     reader's fetch, and one who could retry could undo a `gave-up` surrender — which is the
 *     one thing that stops a dead range being ground forever.
 *
 * Job ids are sequential, so a caller can walk them. That is acceptable precisely because a job
 * row holds nothing private — its source, operation and params all arrived from a public URL in
 * the first place — and it is the reason nothing else may be added to this response.
 */
function serveJobStatus(ctx, res, segments) {
  if (segments.length !== 2 || !/^\d+$/.test(segments[1])) {
    return sendJson(res, 404, { error: { kind: 'request', message: 'Expected /api/jobs/<id>.' } })
  }
  if (!ctx.store) {
    return sendJson(
      res,
      503,
      { error: { kind: 'server', message: 'The persistent store is not available on this instance.' } },
      { 'cache-control': 'no-store' },
    )
  }
  const job = ctx.queue.get(Number(segments[1]))
  if (!job) {
    return sendJson(res, 404, { error: { kind: 'request', message: `No job ${segments[1]}.` } })
  }
  return sendJson(res, 200, describeJob(ctx.store, job), { 'cache-control': 'no-store' })
}

/* ------------------------------------------------------------------------------ app ---- */

/**
 * Build the request handler. Binds nothing, listens on nothing, and is the whole of the
 * server's behaviour — so a test drives the real routing by calling `handle(req, res)`.
 *
 * @param {object} [options]
 * @param {boolean} [options.dev]        dev mode: Vite owns the documents, this serves /api only
 * @param {string}  [options.dataDir]    where the store lives
 * @param {object}  [options.store]      an already-open Store (tests); otherwise opened here
 * @param {object}  [options.registry]   `{ resolve, resolveJob }` — the injection seam; see the
 *                                       file header. Defaults to the real source registry.
 * @param {(o: object) => unknown} [options.ensureWorker]  spawns the drain worker
 * @param {object}  [options.queueOptions]  passed to JobQueue (a test clock, mostly)
 * @param {boolean} [options.deferStore]  do not open the store during construction; the caller
 *                                        calls `app.openStore()` once it is listening. See the
 *                                        entry point below for why that ordering matters.
 */
export function createApp({
  dev = false,
  dataDir = defaultDataDir(),
  store: givenStore,
  registry = { resolve: resolveOperation, resolveJob },
  ensureWorker = spawnWorker,
  queueOptions,
  deferStore = false,
  cache = new TtlCache({ maxEntries: 400, maxBytes: 48 * 1024 * 1024 }),
  // The identity-watch stream's clocks and caps (serveStream). Injectable so a test can tick in
  // milliseconds; the defaults are the production numbers and each is a decision:
  //   pollMs 3s      — the store is local SQLite and a coverage probe is an indexed aggregate,
  //                    so the cost of a tick is microseconds; 3s is well inside "feels live" for
  //                    a chart that fills over minutes.
  //   heartbeatEvery — a comment frame every 8th quiet tick (~24s), inside every proxy's idle
  //                    timeout that matters here.
  //   maxMs 15min    — longer than any warm month backlog a reader realistically waits out
  //                    (a netflows month is ~45s), shorter than an abandoned tab's afternoon.
  //   maxConcurrent  — watches are cheap but they hold sockets; 32 is far above the readership
  //                    of this site and far below anything that hurts.
  //   retryMs        — the reconnect hint EventSource honours after a drop.
  stream: streamOptions,
} = {}) {
  const sweeper = setInterval(() => cache.sweep(), 60_000)
  sweeper.unref?.()

  /** The "is there runnable work yet" tick. Null until `startBackgroundWork` starts it, so a
   *  test that never asks for background work never gets one. */
  let poller = null

  // `store` and `queue` live on ctx rather than in closed-over consts because they may be
  // attached AFTER the request handler exists — see `openStoreNow` and the entry point.
  const ctx = {
    cache,
    store: null,
    queue: null,
    registry,
    startWorker,
    startedAt: Date.now(),
    // Never checked yet. `ok: null` is not `ok: false` and is certainly not `true` — see
    // server/lib/canary.mjs, and CLAUDE.md on null never standing in for a value.
    canaries: { ok: null, checkedAt: null, reports: [] },
    // Open identity watches (serveStream), so shutdown can end them instead of waiting them out.
    streams: new Set(),
    streamConfig: {
      pollMs: 3_000,
      heartbeatEvery: 8,
      maxMs: 15 * 60_000,
      maxConcurrent: 32,
      retryMs: 5_000,
      ...streamOptions,
    },
  }

  function startWorker() {
    // The worker exists to drain work that exists. `hasRunnable` is the gate: an idle queue
    // spawns nothing, and a queue whose only jobs are backing off spawns nothing either.
    //
    // The worker opens its OWN connection to the same file, so it needs the directory, not our
    // handle. Derived from the store we actually opened rather than from `dataDir`, which a
    // test passing a ready-made store never sets.
    if (ctx.queue?.hasRunnable()) ensureWorker({ dir: ctx.store ? dirOf(ctx.store.path) : dataDir })
  }

  /**
   * Run the durability canaries and keep the answer for `/api/health` to publish. Guarded
   * against overlap for the same reason the re-warm is: each canary talks to an upstream, and two
   * passes in flight would double a request that exists to be cheap.
   *
   * It cannot throw. `runCanaries` turns a handler's failure into an `unknown` report rather than
   * propagating it, and the catch here is for the case that surprises even that — a canary must
   * never be able to take down a server that is serving perfectly well.
   */
  let checking = false
  async function checkCanaries(options = {}) {
    if (!ctx.store || checking) return ctx.canaries
    checking = true
    try {
      ctx.canaries = await runCanaries({ store: ctx.store, ...options })
    } catch (problem) {
      console.error('[canary] check failed:', problem?.message ?? problem)
    } finally {
      checking = false
    }
    return ctx.canaries
  }

  function attach(store) {
    ctx.store = store
    // Constructing the queue IS the recovery: JobQueue's constructor calls recover(), which
    // re-queues any job left `running` by a process that died. Once, because this is the only
    // place a queue is constructed on the HTTP side — the worker thread opens its own.
    ctx.queue = store ? new JobQueue(store, queueOptions) : null
    return store
  }

  /**
   * Open the store, or report why not and carry on. Opening it is NOT fatal: the production
   * container runs `--read-only`, so a deployment whose volume is missing or misconfigured is a
   * state this service has to survive, and it must cost mode A only. A site that refuses to
   * boot because a volume is missing is a worse outage than a site with two operations
   * answering 503.
   *
   * Idempotent, so the entry point can call it without knowing whether construction already
   * did.
   */
  function openStoreNow() {
    if (ctx.store) return ctx.store
    try {
      return attach(openStore({ dir: dataDir }))
    } catch (problem) {
      console.error(`[store] mode A is unavailable: ${problem.message}`)
      return attach(null)
    }
  }

  if (givenStore) attach(givenStore)
  else if (!deferStore) openStoreNow()

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    // Read-only service. Nothing here accepts a write, so anything but GET/HEAD is a mistake or
    // a probe, and either way it gets a flat answer rather than a code path.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    }

    let pathname
    let url
    try {
      url = new URL(req.url, 'http://localhost')
      // INSIDE the try, and that placement is the whole point. A lone `%`, or any truncated
      // escape (`/%E0%A4%A`), makes decodeURIComponent throw URIError — and this function is
      // `async`, so a throw out here is a REJECTED PROMISE that `createServer` never awaits.
      // Node's default unhandled-rejection policy is `throw`, so `GET /%` from any anonymous
      // visitor terminated the process. Verified: one request, one dead container, and the
      // socket hung with no response besides. A malformed escape is a client mistake and gets
      // the client's answer.
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return send(res, 400, 'Bad request', { 'content-type': 'text/plain; charset=utf-8' })
    }

    try {
      if (pathname === '/healthz') {
        // Untouched, and it must stay that way: no upstream, no store, no queue, no filesystem.
        // The container's HEALTHCHECK asserts this exact body, and anything that can fail in
        // here is something that can restart the container.
        return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const segments = pathname.slice(5).split('/').filter(Boolean)
        return await serveApi(ctx, req, res, segments, url.searchParams)
      }
      if (dev) {
        // In dev, Vite owns the documents and proxies /api here. Anything else reaching this
        // process is a misrouted request, and saying so beats a confusing 404 from a stale dist.
        return sendJson(res, 404, { error: { kind: 'request', message: 'In dev mode this process serves /api only.' } })
      }
      return await serveStatic(res, pathname)
    } catch (problem) {
      console.error('[server]', problem)
      // A response that already started streaming cannot take a 500 status line — writing one
      // throws ERR_HTTP_HEADERS_SENT out of the catch, which is how an error page becomes a
      // crashed handler. Ending the stream is the whole of what can still be done for it.
      if (res.headersSent) return res.end()
      return send(res, 500, 'Internal error', { 'content-type': 'text/plain; charset=utf-8' })
    }
  }

  return {
    handle,
    cache,
    // Getters, not values: `openStoreNow()` may attach these after this object was built.
    get store() {
      return ctx.store
    },
    get queue() {
      return ctx.queue
    },
    openStore: openStoreNow,

    /**
     * Get the fetching moving without waiting for a visitor. Three things, every one of which
     * used to need somebody to load a page first:
     *
     *   · WARM. A handler that declares `warm()` names the identities worth having before
     *     anybody asks. See server/lib/warm.mjs for what that does and does not enqueue.
     *   · RESUME. A redeploy in the middle of a backfill leaves runnable jobs in the store and
     *     no worker. Nothing spawned one at boot — `startWorker` was reachable only from the
     *     request path — so a half-filled series stayed half-filled until the next visitor
     *     happened along, which on a quiet site is hours.
     *   · KEEP LOOKING. And this is the one a single boot-time check does NOT cover, because
     *     "runnable" is a function of the clock, not only of the rows:
     *       — a job SIGKILLed mid-batch keeps a lease for up to `leaseMs` after its owner
     *         died, so at the instant a redeploy comes back up it is `running`, not runnable,
     *         and a one-shot check at boot finds nothing to do and never looks again
     *         (reproduced: a backfill sat at 30/31 across a restart);
     *       — a `failed` job backs off for up to an hour before it is due.
     *     Both resolve on their own a minute or an hour later, with nothing watching. A tick is
     *     what turns "resumes when someone visits" into "resumes". It costs one indexed SELECT
     *     against a local SQLite file per minute, and it spawns nothing while there is nothing
     *     to run — `startWorker` gates on the same `hasRunnable()` predicate `claim()` uses.
     *
     * Never throws: a warm-up that fails must not be able to take down a server that is
     * already serving.
     */
    async startBackgroundWork({ pollMs = 60_000, canaryMs = CANARY_INTERVAL_MS, ...options } = {}) {
      if (!ctx.store) return { warmed: null, resumed: false, canaries: ctx.canaries }
      let warmed = null
      try {
        warmed = await warmStore({ store: ctx.store, queue: ctx.queue, ...options })
      } catch (problem) {
        console.error('[warm] skipped:', problem?.message ?? problem)
      }
      const resumed = Boolean(ctx.queue?.hasRunnable())
      startWorker()
      await checkCanaries(options)

      if (pollMs > 0 && !poller) {
        // The tick re-warms as well as starting the worker, and the re-warm is the half that is
        // easy to leave out. `warmStore` at boot alone would mean an instance warms the months
        // that exist the moment it starts and never again — but the list grows by three
        // identities a month, so a long-lived instance silently reverts to reader-triggered
        // fetching for every month after its own boot, which is the behaviour decision 0014
        // exists to remove. It also gives a boot-time upstream outage a second chance instead of
        // costing the instance its whole warm-up.
        //
        // Cheap enough to do every minute BECAUSE of the refusal `warmStore` already enforces:
        // a `done` identity is skipped, not re-enqueued (enqueue is find-or-create over LIVE
        // states, and `done` is not one — it would mint a second job with a null cursor and
        // refetch from segment one). So the steady state is a list walk and nothing else.
        let rewarming = false
        poller = setInterval(() => {
          try {
            startWorker()
            // Guarded because a slow warm must not overlap itself: `warmStore` reads the whole
            // identity list, and two concurrent passes would each see the other's not-yet-created
            // jobs as absent.
            if (!rewarming) {
              rewarming = true
              warmStore({ store: ctx.store, queue: ctx.queue, ...options })
                .catch((problem) => console.error('[warm] re-warm failed:', problem?.message ?? problem))
                .finally(() => {
                  rewarming = false
                })
            }
            // On the SAME tick but a much slower clock — see CANARY_INTERVAL_MS. Not awaited,
            // and it cannot throw out of here: checkCanaries swallows its own failures into an
            // `unknown` report, which is the answer a check that could not run should give.
            if (canaryMs > 0 && Date.now() - (ctx.canaries.checkedAt ?? 0) >= canaryMs) void checkCanaries(options)
          } catch (problem) {
            // A poll that throws must not become an unhandled rejection that kills the process.
            console.error('[warm] poll failed:', problem?.message ?? problem)
          }
        }, pollMs)
        poller.unref?.()
      }
      return { warmed, resumed, canaries: ctx.canaries }
    },

    /**
     * End every open identity watch. Called on shutdown BEFORE `server.close()` waits for
     * in-flight requests, because an SSE response is an in-flight request that never finishes on
     * its own — without this, every redeploy rides the 5-second force-exit timer instead of
     * closing cleanly.
     *
     * Deliberately NO `done` frame: `done` is the protocol's "stop following" and a redeploy is
     * the opposite of that. Ending the response mid-stream is precisely the case EventSource's
     * reconnection exists for — the browser waits out the `retry:` hint and re-subscribes, and
     * the NEW instance answers it. The wire protocol hands us instance-handover for free; a
     * farewell frame would have suppressed it.
     */
    endStreams() {
      for (const stream of [...ctx.streams]) {
        try {
          if (stream.timer) clearInterval(stream.timer)
          if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.end()
        } catch {
          // A socket that died mid-write is already what we wanted: closed.
        }
        ctx.streams.delete(stream)
      }
    },

    close() {
      clearInterval(sweeper)
      if (poller) clearInterval(poller)
      this.endStreams()
      if (!givenStore) ctx.store?.close()
    },
  }
}

function dirOf(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep))
  return at === -1 ? path : path.slice(0, at)
}

/* --------------------------------------------------------------------------- server ---- */

// Only when this file IS the process. Importing it (a test, a script) must not bind a port —
// that is the whole reason createApp exists as a separate export.
const invokedDirectly =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const dev = process.argv.includes('--dev')

  // `deferStore` — THE PORT IS BOUND BEFORE THE FILESYSTEM IS TOUCHED, and that ordering is
  // load-bearing rather than tidy. Opening the store means creating a directory and opening a
  // SQLite file on a mounted volume, and a volume can be slow, wedged or hostile in ways a
  // local disk never is. Whatever that costs, it must not be able to cost us the listener:
  // a process that is alive and not listening is the worst of the three states, because every
  // health check, load balancer and human reads it as "starting" for as long as it lasts.
  // (It happened. See the ensureDir note in server/lib/store.mjs: one unbounded mkdir and the
  // container held a port open in the scheduler's eyes forever, printing nothing.)
  const app = createApp({ dev, deferStore: true })

  // `handle` is async, and `createServer` does not await it — so a rejection it does not catch
  // is an UNHANDLED rejection, which under Node's default policy kills the process. One
  // anonymous GET should never be able to do that, whatever future edit reintroduces the
  // possibility, so the last line of defence lives here rather than in a code comment.
  const server = createServer((req, res) => {
    Promise.resolve(app.handle(req, res)).catch((problem) => {
      console.error('[server] request handler rejected:', problem)
      if (res.headersSent) return res.end()
      send(res, 500, 'Internal error', { 'content-type': 'text/plain; charset=utf-8' })
    })
  })

  server.listen(PORT, HOST, () => {
    console.log(`polkadot-analytics ${dev ? '(api only) ' : ''}listening on http://${HOST}:${PORT}`)

    // Now, and not before. Until this returns, mode A answers 503 and mode B answers normally —
    // which is exactly the degraded state this service is designed to survive, so a slow volume
    // costs a few store-backed requests rather than the whole site.
    app.openStore()

    // Deliberately not awaited. Warming enqueues rows and spawns the drain worker; the worker
    // is a thread doing hours of polite serial fetching, and the HTTP server has no business
    // waiting on any of it.
    app.startBackgroundWork().then(({ warmed, resumed, canaries }) => {
      // Silent when there is nothing to say. A line on every boot of an instance that warms
      // nothing is a line nobody reads, and this one has to be read when it appears.
      if (warmed?.considered) {
        console.log(
          `[warm] ${warmed.enqueued} of ${warmed.considered} identities enqueued ` +
            `(${Object.entries(warmed.skipped)
              .filter(([, count]) => count > 0)
              .map(([why, count]) => `${count} ${why}`)
              .join(', ') || 'nothing skipped'})`,
        )
      }
      if (resumed) console.log('[warm] the queue had runnable work; the drain worker was started')
      // Only when there is something to say. `runCanaries` already logged each non-ok report in
      // full; this is the one line that says the boot check happened and found nothing, and it is
      // printed only when a check actually ran — silence must not read as "all clear".
      if (canaries?.ok === true) {
        console.log(`[canary] ${canaries.reports.length} durability check(s) passed; the store is still re-derivable`)
      }
    })
  })

  // Compose sends SIGTERM on redeploy. Closing cleanly means in-flight requests finish instead
  // of being cut, which otherwise shows up in monitoring as a blip on every single deploy.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // Streams first: an open identity watch is an in-flight request that never ends on its
      // own, so `server.close()` would otherwise sit on it until the force-exit timer fires.
      app.endStreams()
      server.close(() => {
        app.close()
        process.exit(0)
      })
      setTimeout(() => process.exit(0), 5000).unref()
    })
  }
}
