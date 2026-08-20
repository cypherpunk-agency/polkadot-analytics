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
//   GET /api/:source/:op      one cached, validated, read-only upstream call
//   GET /*                    the static build

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TtlCache } from './lib/cache.mjs'
import { UpstreamError } from './lib/upstream.mjs'
import { ParamError, cacheKey, readParams } from './lib/params.mjs'
import { describe, resolve as resolveOperation } from './sources/index.mjs'

const ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DEV = process.argv.includes('--dev')

const startedAt = Date.now()
const cache = new TtlCache({ maxEntries: 400, maxBytes: 48 * 1024 * 1024 })
setInterval(() => cache.sweep(), 60_000).unref()

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
 * Set here as well as at the edge. Caddy owns the production headers, but this container is
 * also what runs in `npm run preview` and in any future context where it is not behind Caddy,
 * and a security header that only exists in one deployment is a header you cannot rely on.
 *
 * `connect-src 'self'` is the load-bearing one: the browser may talk to this origin and nothing
 * else, which is the whole reason the upstream calls happen server-side. See
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...headers,
  })
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

async function serveApi(res, segments, query) {
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
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        cache: cache.report(),
      },
      { 'cache-control': 'no-store' },
    )
  }

  if (segments.length !== 2) {
    return sendJson(res, 404, { error: { kind: 'request', message: 'Expected /api/<source>/<operation>.' } })
  }

  const [sourceId, operationId] = segments
  const { source, operation, error } = resolveOperation(sourceId, operationId)
  if (error) return sendJson(res, 404, { error: { kind: 'request', message: error } })

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
  const fresh = cache.peek(key) === undefined

  try {
    const value = await cache.resolve(key, operation.ttlMs, () => operation.run(params))
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

/* --------------------------------------------------------------------------- server ---- */

const server = createServer(async (req, res) => {
  // Read-only service. Nothing here accepts a write, so anything but GET/HEAD is a mistake or
  // a probe, and either way it gets a flat answer rather than a code path.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
  }

  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return send(res, 400, 'Bad request', { 'content-type': 'text/plain; charset=utf-8' })
  }

  const pathname = decodeURIComponent(url.pathname)

  try {
    if (pathname === '/healthz') {
      return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const segments = pathname.slice(5).split('/').filter(Boolean)
      return await serveApi(res, segments, url.searchParams)
    }
    if (DEV) {
      // In dev, Vite owns the documents and proxies /api here. Anything else reaching this
      // process is a misrouted request, and saying so beats a confusing 404 from a stale dist.
      return sendJson(res, 404, { error: { kind: 'request', message: 'In dev mode this process serves /api only.' } })
    }
    return await serveStatic(res, pathname)
  } catch (problem) {
    console.error('[server]', problem)
    return send(res, 500, 'Internal error', { 'content-type': 'text/plain; charset=utf-8' })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`polkadot-analytics ${DEV ? '(api only) ' : ''}listening on http://${HOST}:${PORT}`)
})

// Compose sends SIGTERM on redeploy. Closing cleanly means in-flight requests finish instead of
// being cut, which otherwise shows up in monitoring as a blip on every single deploy.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
