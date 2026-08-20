// The registry. Every upstream this service will ever talk to is listed here, and nowhere else.
//
// This file is the security boundary. `/api/:source/:operation` resolves both segments against
// this table before anything leaves the machine, which is what keeps a public, ungated service
// from being an open proxy: there is no code path from a client-supplied string to a URL.
//
// Adding a data source means adding a module here. It does not mean touching the HTTP layer,
// the cache, the design system or any page — see docs/architecture/middleware.md.

import arbsBifrost from './arbs-bifrost.mjs'
import arbsHydration from './arbs-hydration.mjs'
import bulletin from './bulletin.mjs'
import dotlake from './dotlake.mjs'
import hydration from './hydration.mjs'
import hydrationEvm from './hydration-evm.mjs'
import hyperbridge from './hyperbridge.mjs'

export const SOURCES = Object.fromEntries(
  [
    dotlake,
    hyperbridge,
    hydration,
    hydrationEvm,
    arbsHydration,
    arbsBifrost,
    bulletin,
  ].map((source) => [source.id, source]),
)

export function resolve(sourceId, operationId) {
  const source = SOURCES[sourceId]
  if (!source) return { error: `Unknown source \`${sourceId}\`.` }
  const operation = source.operations[operationId]
  if (!operation) return { error: `Source \`${sourceId}\` has no operation \`${operationId}\`.` }
  return { source, operation }
}

/**
 * Job handlers resolve through the same table, for the same reason: the job engine
 * (server/lib/job-worker.mjs) contains no URL and no fetch, so the only way a job reaches an
 * upstream is a handler that lives in this directory. A source that supports long-running
 * ingest exports a `jobs` object next to `operations`, mapping an operation name to
 * `{ summary, immutable(params), plan?(ctx), nextBatch(ctx) }` — the full contract is
 * documented at the top of server/lib/job-worker.mjs.
 */
export function resolveJob(sourceId, operationId) {
  const source = SOURCES[sourceId]
  if (!source) return { error: `Unknown source \`${sourceId}\`.` }
  const handler = source.jobs?.[operationId]
  if (!handler) return { error: `Source \`${sourceId}\` has no job \`${operationId}\`.` }
  return { source, handler }
}

/**
 * The self-description served at `/api`. It is the same object the registry is built from, so
 * it cannot drift from what the service will actually answer — a hand-maintained API listing
 * is wrong within a month.
 */
export function describe() {
  return {
    service: 'polkadot-analytics',
    sources: Object.values(SOURCES).map((source) => ({
      id: source.id,
      label: source.label,
      homepage: source.homepage,
      transport: source.transport,
      doc: source.doc,
      covers: source.covers,
      operations: Object.entries(source.operations).map(([id, op]) => ({
        id,
        path: `/api/${source.id}/${id}`,
        summary: op.summary,
        cacheSeconds: Math.round(op.ttlMs / 1000),
        parameters: Object.entries(op.schema ?? {}).map(([name, spec]) => ({
          name,
          type: spec.type,
          required: Boolean(spec.required),
          default: spec.default ?? null,
          min: spec.min ?? null,
          max: spec.max ?? null,
          oneOf: spec.oneOf ?? null,
        })),
      })),
    })),
  }
}
