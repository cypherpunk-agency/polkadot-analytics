// The one place this service talks to the outside world.
//
// Every upstream call in the repo goes through `callUpstream`. That is not tidiness for its own
// sake — it is what makes three separate promises checkable in one file:
//
//   1. NO SECRETS EVER LEAVE. No Authorization header, no cookie, no API key is attached here,
//      because there is none anywhere in this repo. If a future upstream needs one, it has to
//      be added *here*, in the open, and that is the moment to argue about it.
//   2. NOTHING THE BROWSER SENDS BECOMES A URL. The caller supplies a source id and an operation
//      name; this file resolves both against a static table. A public service that forwarded a
//      client-supplied URL would be an open proxy and an SSRF hole.
//   3. FAILURES KEEP THEIR SHAPE. `transport` (we could not reach them) and `upstream` (they
//      answered, with an error) mean different things to a reader and imply different actions,
//      so they never collapse into a single "error".

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {object} detail
   * @param {'transport'|'upstream'|'decode'} detail.kind
   * @param {string} detail.source
   * @param {number} [detail.status]
   * @param {unknown} [detail.cause]
   */
  constructor(message, { kind, source, status, cause }) {
    super(message)
    this.name = 'UpstreamError'
    this.kind = kind
    this.source = source
    this.status = status
    this.cause = cause
  }

  /** What the browser sees. Deliberately not the raw upstream body. */
  toPayload() {
    return { error: { kind: this.kind, source: this.source, message: this.message, status: this.status ?? null } }
  }
}

/**
 * One outbound HTTP call, with a timeout and a size ceiling.
 *
 * The size ceiling is not paranoia: an archive query with a mistaken filter can return tens of
 * megabytes, and on a 256 MB container that is an OOM crash-loop rather than an error message.
 *
 * @param {object} spec
 * @param {string} spec.source   id of the source, for error attribution only
 * @param {string} spec.url      resolved server-side, never client-supplied
 * @param {'GET'|'POST'} [spec.method]
 * @param {unknown} [spec.body]
 * @param {number} [spec.timeoutMs]
 * @param {number} [spec.maxBytes]
 */
export async function callUpstream({ source, url, method = 'GET', body, timeoutMs = 30_000, maxBytes = 24 * 1024 * 1024 }) {
  const headers = { accept: 'application/json' }
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    const why = cause?.name === 'TimeoutError' ? `did not answer within ${timeoutMs / 1000}s` : 'could not be reached'
    throw new UpstreamError(`${source} ${why}.`, { kind: 'transport', source, cause })
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new UpstreamError(`${source} offered ${declared} bytes, over the ${maxBytes}-byte ceiling.`, {
      kind: 'transport',
      source,
      status: response.status,
    })
  }

  const text = await readCapped(response, maxBytes, source)

  if (!response.ok) {
    throw new UpstreamError(`${source} returned HTTP ${response.status}.`, {
      kind: 'upstream',
      source,
      status: response.status,
    })
  }

  try {
    return JSON.parse(text)
  } catch (cause) {
    // A 200 that is not JSON is almost always a proxy or a captive portal, not the service.
    throw new UpstreamError(`${source} returned a response that is not JSON.`, { kind: 'decode', source, cause })
  }
}

/** Read a body, abandoning it past `maxBytes` rather than buffering whatever arrives. */
async function readCapped(response, maxBytes, source) {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new UpstreamError(`${source} body exceeded the ${maxBytes}-byte ceiling.`, {
        kind: 'transport',
        source,
        status: response.status,
      })
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(concat(chunks, total))
}

function concat(chunks, total) {
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** GraphQL over POST, with the `errors` array treated as a real failure rather than a warning. */
export async function graphql({ source, url, query, variables, timeoutMs, maxBytes }) {
  const body = await callUpstream({ source, url, method: 'POST', body: { query, variables }, timeoutMs, maxBytes })
  if (body.errors?.length) {
    throw new UpstreamError(body.errors.map((e) => e.message).join('; '), { kind: 'upstream', source })
  }
  return body.data
}

/**
 * NDJSON (`application/jsonl`) over POST — one JSON value per line, which is how archive
 * gateways stream a range of blocks. It does its own `fetch` rather than going through
 * `callUpstream` for one reason: that function ends in `JSON.parse(text)`, and a line-delimited
 * body is not a JSON document. Everything else it promises is kept here — the timeout, the size
 * ceiling, and `transport` vs `upstream` staying distinguishable.
 *
 * The response HEADERS come back too, and that is not incidental. SQD's portal reports its
 * archive head on `x-sqd-head-number` of every stream response, so the liveness assertion costs
 * nothing on a call that was happening anyway. See docs/platform/sqd-portal.md.
 *
 * @returns {Promise<{lines: unknown[], headers: Headers, bytes: number}>}
 */
export async function ndjson({ source, url, body, timeoutMs = 60_000, maxBytes = 24 * 1024 * 1024 }) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/jsonl, application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    const why = cause?.name === 'TimeoutError' ? `did not answer within ${timeoutMs / 1000}s` : 'could not be reached'
    throw new UpstreamError(`${source} ${why}.`, { kind: 'transport', source, cause })
  }

  const text = await readCapped(response, maxBytes, source)
  if (!response.ok) {
    // The portal reports parameter errors as a JSON object with a readable message. Surfacing it
    // beats "HTTP 400", which for a query DSL is almost never enough to fix the query.
    let detail = ''
    try {
      detail = ` ${JSON.parse(text)?.error?.message ?? ''}`.trimEnd()
    } catch {
      /* not JSON; the status is all we have */
    }
    throw new UpstreamError(`${source} returned HTTP ${response.status}.${detail}`, {
      kind: 'upstream',
      source,
      status: response.status,
    })
  }

  const lines = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      lines.push(JSON.parse(line))
    } catch (cause) {
      throw new UpstreamError(`${source} returned a line that is not JSON.`, { kind: 'decode', source, cause })
    }
  }
  return { lines, headers: response.headers, bytes: text.length }
}

/** Substrate JSON-RPC over anonymous HTTPS POST. */
export async function jsonRpc({ source, url, method, params = [], timeoutMs, maxBytes }) {
  const body = await callUpstream({
    source,
    url,
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
    timeoutMs,
    maxBytes,
  })
  if (body.error) {
    const detail = body.error.message ?? JSON.stringify(body.error)
    throw new UpstreamError(`${method} was rejected: ${detail}`, { kind: 'upstream', source })
  }
  return body.result
}
