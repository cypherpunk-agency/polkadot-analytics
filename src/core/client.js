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
        return 'Something failed inside this service.'
    }
  }
}

/**
 * @param {string} source     a source id from /api
 * @param {string} operation  an operation id on that source
 * @param {Record<string, string|number|boolean>} [params]
 * @param {{signal?: AbortSignal}} [options]
 */
export async function read(source, operation, params = {}, { signal } = {}) {
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

  let body
  try {
    body = await response.json()
  } catch {
    throw new ApiError('This site returned something that is not JSON.', { kind: 'decode', source, status: response.status })
  }

  if (!response.ok || body.error) {
    const error = body.error ?? {}
    throw new ApiError(error.message ?? `Request failed with HTTP ${response.status}.`, {
      kind: error.kind ?? 'server',
      source: error.source ?? source,
      status: response.status,
    })
  }

  return body.data
}

/** The service's own description of what it can answer. Used by the home page. */
export async function catalogue(options) {
  const response = await fetch('/api', { ...options, headers: { accept: 'application/json' } })
  if (!response.ok) throw new ApiError('The API catalogue is unavailable.', { kind: 'server' })
  return response.json()
}
