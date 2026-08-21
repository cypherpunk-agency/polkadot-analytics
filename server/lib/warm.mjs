// Filling the store without a reader — the boot half of mode A.
//
// `server/lib/demand.mjs` answers the question "a reader asked for this; what do we have and
// what is being done about the rest". This file answers the one nobody asks: **which identities
// are worth having before anybody asks for them.**
//
// It exists because of a deployment fact, not a design preference. A fresh volume holds an
// empty store, and the first mode-A reader is what creates the fetch — so on a site with a
// 55-month backfill behind one page, the first visitor after a new volume gets a coverage bar
// and a nearly empty chart, and the fill only progresses while somebody keeps the tab open
// long enough for the worker to be spawned. Warming moves that to boot, where it costs nobody's
// pageview.
//
// ── what this is NOT ─────────────────────────────────────────────────────────────────────────
// It is not a scheduler, not a cron, and not a second job engine. It enqueues rows into the
// SAME queue a reader's request would, using the SAME find-or-create, and the SAME single
// worker drains them at the SAME one-request-per-host politeness. A warmed backfill and a
// reader-triggered one are the same fetch with a different trigger; there is no second code
// path that could fetch differently.
//
// ── the three refusals, and the quiet one ────────────────────────────────────────────────────
//
//   1. NOT IMMUTABLE — refused, exactly as demand.mjs refuses it. A warm list that named the
//      current month would mint a job the engine surrenders three attempts later, once per
//      boot, forever.
//   2. ALREADY COMPLETE — refused, and THIS IS THE QUIET ONE. `enqueue` is find-or-create over
//      LIVE states only; `done` is not one of them, so enqueueing a finished identity creates a
//      NEW job and refetches every segment it already holds. A warmer that skipped this check
//      would turn "immutable data is fetched once and never again" into "refetched on every
//      redeploy" — with correct answers, a full coverage bar, and nothing anywhere reporting
//      it. The whole point of the store, undone by a boot hook.
//   3. SURRENDERED — a `gave-up` identity is a written-down decision that three attempts were
//      spent (jobs.mjs). Rebooting is not new evidence, and a surrender a restart could undo is
//      not a surrender. Only `job retry <id>` leaves that state, same as for a reader.
//
// ── the handler contract ─────────────────────────────────────────────────────────────────────
// Optional, next to `immutable`/`nextBatch` in a source's `jobs` entry:
//
//   warm: () => [ {month: '2026-07', network: 'polkadot'}, … ]   // may be async
//
// Params are run through the handler's own `schema` with readParams, the same validator the
// HTTP layer uses, and that is not ceremony: THE PARAMS ARE THE STORE IDENTITY. A warm entry
// that spells a value differently from the way a reader's query string arrives is a different
// identity — so the backfill would run twice, both copies would be correct, and the page would
// still start empty. Normalising both through one validator is what makes them the same row.

import { JOB_PRIORITY } from './jobs.mjs'
import { readParams } from './params.mjs'

/**
 * A ceiling on what one handler may ask for in one boot. Not a policy about how much data is
 * reasonable — `warm()` is repo code, reviewed like everything else — but a backstop against a
 * generator with an off-by-one that returns a million months. Over the ceiling nothing is
 * enqueued at all and the whole list is reported, because a silently truncated warm list is a
 * backfill with an invisible hole in it.
 */
export const MAX_WARM_IDENTITIES = 1_000

/**
 * WARMING IS NOT SUBJECT TO `MAX_LIVE_JOBS_PER_OPERATION`, and that is deliberate rather than an
 * oversight. That cap (demand.mjs, 8) exists against ONE thing: an anonymous caller walking a
 * parameter through a thousand distinct values to mint a thousand fetches against volunteer-run
 * infrastructure. A warm list is repo code that went through review; there is no caller.
 *
 * The consequence is worth stating, because it is visible from outside. Warming 55 months puts
 * 55 live jobs in the queue, so a reader asking for an identity NOT on the warm list meets the
 * cap and is told "the queue is busy" until the backlog drains. That is the right trade only
 * because the warm list and the page's month list are the same list — a reader asking for a
 * warmed month JOINS its job and never counts against the cap at all. A `warm()` that drifts
 * away from what its page asks for turns this from harmless into a page that cannot start a
 * fetch, so keep the two derived from the same bounds.
 *
 * The drain rate is unaffected either way: one drainer per host, one in-flight request per
 * upstream, so 55 queued jobs finish no slower and no faster than 8 would.
 */

/**
 * Enqueue every identity the registry's job handlers declare worth having.
 *
 * @param {object} args
 * @param {import('./store.mjs').Store} args.store
 * @param {import('./jobs.mjs').JobQueue} args.queue
 * @param {Record<string, any>} [args.sources]  the source table; defaults to the real registry
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{considered: number, enqueued: number, skipped: object, jobs: number[]}>}
 */
export async function warmStore({ store, queue, sources, log = (line) => console.log(line) }) {
  if (!store || !queue) return { considered: 0, enqueued: 0, skipped: {}, jobs: [] }

  // Imported lazily, and through the registry, for the same reason job-worker.mjs does it: this
  // file must not be a second way for a (source, operation) to come into existence.
  const table = sources ?? (await import('../sources/index.mjs')).SOURCES

  const skipped = { complete: 0, live: 0, mutable: 0, 'gave-up': 0, invalid: 0 }
  const jobs = []
  let considered = 0

  for (const source of Object.values(table)) {
    for (const [operationId, handler] of Object.entries(source.jobs ?? {})) {
      if (typeof handler.warm !== 'function') continue

      let wanted
      try {
        wanted = (await handler.warm()) ?? []
      } catch (problem) {
        log(`[warm] ${source.id}/${operationId}: warm() failed, skipping — ${problem?.message ?? problem}`)
        continue
      }
      if (!Array.isArray(wanted)) {
        log(`[warm] ${source.id}/${operationId}: warm() did not return an array, skipping.`)
        continue
      }
      if (wanted.length > MAX_WARM_IDENTITIES) {
        log(
          `[warm] ${source.id}/${operationId}: warm() returned ${wanted.length} identities, over the ` +
            `${MAX_WARM_IDENTITIES} ceiling. NOTHING was enqueued for it — a truncated warm list is a ` +
            `backfill with a hole nobody can see.`,
        )
        continue
      }

      for (const raw of wanted) {
        considered += 1

        // Through the same validator the HTTP layer uses, from the same string form a query
        // string arrives in, so a warmed identity and a requested one are byte-identical.
        let params
        try {
          params = readParams(stringify(raw), handler.schema ?? {})
        } catch (problem) {
          skipped.invalid += 1
          log(`[warm] ${source.id}/${operationId}: ${JSON.stringify(raw)} is not valid — ${problem.message}`)
          continue
        }

        // Refusal 1. A predicate that throws counts as "no", exactly as in demand.mjs: the
        // permissive direction is the one that produces a job nothing can ever finish.
        let immutable = false
        try {
          immutable = handler.immutable(params) === true
        } catch {
          immutable = false
        }
        if (!immutable) {
          skipped.mutable += 1
          continue
        }

        const identity = queue.describeIdentity(source.id, operationId, params)
        // Refusal 2 — see the header. This is the one that quietly costs a full refetch.
        if (!identity.live && identity.done) {
          skipped.complete += 1
          continue
        }
        // Refusal 3.
        if (!identity.live && identity.latest?.state === 'gave-up') {
          skipped['gave-up'] += 1
          continue
        }
        if (identity.live) {
          // Find-or-create would return this same row; counted separately so the log can tell
          // "already running" from "started by us".
          skipped.live += 1
          if (identity.live.state !== 'partial') continue
          // A `partial` job is parked with its cursor intact and boot IS demand: enqueue
          // re-queues it in place (same id, same cursor) rather than minting a second identity.
        }

        // WARM priority — the point of decision 0014's follow-up. Warming fills the store; it
        // must never be in front of somebody. `enqueue` raises but never lowers, so re-queueing a
        // `partial` job that a reader had already lifted (the branch just above) leaves it lifted.
        jobs.push(queue.enqueue(source.id, operationId, params, { priority: JOB_PRIORITY.warm }).id)
      }
    }
  }

  return { considered, enqueued: jobs.length, skipped, jobs }
}

/**
 * readParams reads a query string, so every value it sees is a string. A warm list is written
 * as real values (`{month: '2026-07'}`, and one day `{days: 30}`), and handing it a number
 * would fail the `int` validator's own regex.
 *
 * KNOWN LIMIT, stated rather than discovered: a param a schema declares as `list` arrives here
 * as an array and stringifies with commas, which is exactly what readParams then splits — but
 * a value CONTAINING a comma would not survive the round trip. No schema has one; if one ever
 * does, this is where it breaks, loudly, in the `invalid` branch above.
 */
function stringify(params) {
  const out = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    out[key] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}
