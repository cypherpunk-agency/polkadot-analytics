// The browser's only way to get data.
//
// Every page calls `read(source, operation, params)` and nothing else. There is no `fetch` to a
// third party anywhere in the browser bundle, and that is enforced rather than hoped for:
// `npm run check` fails the build if an absolute URL appears outside `server/sources/`.
//
// Two reasons it is built this way, and the second is the one that bites:
//
//   1. The production CSP is `connect-src 'self'`. A page that fetched an indexer directly
//      would fail SILENTLY — the document renders, everything returns 200, and the charts are
//      simply empty. Routing through this origin means there is nothing to forget.
//   2. This site is public and ungated. A dashboard that fans out to a shared devnet node once
//      per visitor is a denial-of-service with our name on it. The server holds one cached
//      snapshot; the browser reads that.

export class ApiError extends Error {
  /** @param {'transport'|'upstream'|'decode'|'request'|'server'} kind */
  constructor(message, { kind = 'transport', source = null, status = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.source = source
    this.status = status
  }

  /**
   * What to put on screen. A reader who sees "failed to load" cannot tell whether this site is
   * broken, the chain is down, or the data simply is not there — and those imply completely
   * different actions, so they get different sentences.
   *
   * THE KIND NAMES A LAYER, AND NAMING THE WRONG ONE COSTS REAL TIME. `decode` says "an upstream
   * sent a payload our decoder could not read"; it is a claim about a chain, an indexer and one
   * of our decoders, and it sends whoever reads it to go and look at all three. It is therefore
   * only ever set by the SERVER, which is the only layer that can know it — see the note on
   * `parse` below for the day this class was pinned on a plain 503.
   */
  get advice() {
    switch (this.kind) {
      case 'transport':
        return 'The upstream did not answer. That is their outage, not this page — the numbers below are simply unavailable until it comes back.'
      case 'upstream':
        return 'The upstream answered with an error. Nothing here is stale-but-fine; it is missing.'
      case 'decode':
        return 'The upstream answered with something this site could not read. That usually means a runtime upgrade changed a format, and it is our bug to fix.'
      case 'request':
        return 'This page asked for something the API does not offer. That is our bug.'
      default:
        return 'Something failed inside this service. The message above is what this site said about itself, and it is our bug to fix — no chain and no indexer is involved.'
    }
  }
}

/**
 * The one request. `read` and `readStore` differ ONLY in what they hand back, so everything
 * about talking to the origin — the query string, the fetch, the parse, the classification of a
 * failure — happens exactly once. It used to happen twice, verbatim, and the duplicate is how
 * the misclassification below survived being noticed in one copy.
 *
 * @param {string} source
 * @param {string} operation
 * @param {Record<string, string|number|boolean>} params
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<any>} the whole response body
 */
async function request(source, operation, params, { signal } = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const url = `/api/${source}/${operation}${query.size ? `?${query}` : ''}`

  let response
  try {
    response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError('This site could not be reached.', { kind: 'transport', source })
  }

  const body = await parse(response, source)

  // `body.error` as well as `!response.ok`, because a 200 may still carry an error object, and
  // `body` may not be an object at all (a bare `null` parses fine and used to throw a TypeError
  // out of this line, arriving on the page as a bare "error" with no advice).
  const carried = body !== null && typeof body === 'object' ? body.error : undefined
  if (!response.ok || carried) {
    const error = carried ?? {}
    throw new ApiError(error.message ?? `Request failed with HTTP ${response.status}.`, {
      // THE SERVER'S CLASSIFICATION WINS. `error.kind` was chosen by the layer that knows —
      // `upstream` and `decode` are statements about a chain or an indexer, and only the server
      // talks to those. Anything unlabelled is this service's own failure: `server`.
      kind: error.kind ?? 'server',
      source: error.source ?? source,
      status: response.status,
    })
  }

  return body
}

/**
 * Read the response as JSON, or say honestly which layer failed.
 *
 * THIS IS THE LINE THAT MISDIAGNOSED A 503. It used to throw `kind: 'decode'` — the kind that
 * means "an upstream sent a payload our decoder could not read" — for any response from THIS
 * ORIGIN that did not parse. The two have nothing to do with each other: every `/api/*` answer
 * this server produces is JSON, including its errors, so a body that will not parse did not
 * come from the app at all. It came from the edge (a proxy substituting its own error page for
 * an origin 5xx is the usual one), or the response was truncated in flight.
 *
 * The cost of getting it wrong is not cosmetic. A store-backed page went down because the
 * container had no writable volume; the server said so in a perfectly good JSON 503; and the
 * page displayed "a runtime upgrade changed a format, and it is our bug to fix" — sending the
 * reader to hunt a decoder for ten minutes over a missing mount. So: an unreadable answer from
 * our own origin is reported as an error OF OUR ORIGIN, and when there is an HTTP status the
 * status leads, because it is the one fact that is certainly true.
 */
async function parse(response, source) {
  let text
  try {
    text = await response.text()
  } catch {
    // The headers arrived and the body did not — a connection cut mid-response. That is
    // transport, not content.
    throw new ApiError(`This site answered HTTP ${response.status} and then stopped sending.`, {
      kind: 'transport',
      source,
      status: response.status,
    })
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(
      response.ok
        ? `This site answered HTTP ${response.status} with something that is not JSON${excerpt(text)}.`
        : `This site answered HTTP ${response.status}, and the body was not JSON${excerpt(text)} — so this is ` +
          'the edge or the container answering, not the API.',
      { kind: 'server', source, status: response.status },
    )
  }
}

/** Enough of the body to recognise WHAT answered — an HTML error page, a proxy's plain text, an
 *  empty body — without pasting a whole document into a notice. */
function excerpt(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ' (the body was empty)'
  return ` (it starts: ${JSON.stringify(flat.slice(0, 80))})`
}

/**
 * @param {string} source     a source id from /api
 * @param {string} operation  an operation id on that source
 * @param {Record<string, string|number|boolean>} [params]
 * @param {{signal?: AbortSignal}} [options]
 */
export async function read(source, operation, params = {}, options = {}) {
  const body = await request(source, operation, params, options)
  return body?.data
}

/**
 * Read a STORE-BACKED (mode A) operation, envelope and all.
 *
 * `read()` above unwraps `body.data` because a cached operation's answer IS its data. A stored
 * one is not: the server answers 200 with what it has plus what it is doing about the rest
 * (server/lib/demand.mjs), and dropping that would turn "this is 12 of 31 days and a job is
 * filling the rest" into a chart that is silently short. So this returns the whole envelope —
 * `data` as `[{segment, payload, head, storedAt}]`, plus `coverage` and `job`.
 *
 * The first reader of an identity is what CREATES the fetch. An empty answer here is therefore
 * the normal first response, not an error, and the caller must render it as coverage rather
 * than as failure.
 *
 * @param {string} source
 * @param {string} operation
 * @param {Record<string, string|number|boolean>} [params]
 * @param {{signal?: AbortSignal}} [options]
 */
export async function readStore(source, operation, params = {}, options = {}) {
  return request(source, operation, params, options)
}

/** The service's own description of what it can answer. Used by the home page. */
export async function catalogue(options) {
  let response
  try {
    response = await fetch('/api', { ...options, headers: { accept: 'application/json' } })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    throw new ApiError('This site could not be reached.', { kind: 'transport' })
  }
  if (!response.ok) {
    throw new ApiError(`The API catalogue answered HTTP ${response.status}.`, { kind: 'server', status: response.status })
  }
  // Through `parse` like everything else: `response.json()` here threw a bare SyntaxError that
  // no page renders as anything but "error", which is the same misdiagnosis one layer over.
  return parse(response, null)
}
