// The store's durability canaries — is anything in here no longer re-derivable?
//
// ── the one assumption the whole DR position rests on ────────────────────────────────────────
// This service's answer to backups is that there are none, and that this is fine: the store is a
// CACHE of public upstreams (decision 0006), so a lost volume costs a refill and nothing else.
// Infra accepted that on those terms. It holds for exactly as long as **every stored segment can
// still be fetched again**, and that is a property of the upstreams, not of us.
//
// `hydration/swaps-daily` is where it is thinnest. orca publishes a floor — the oldest block it
// has grouped swap legs into routed trades from, para block 6,837,788 at 2025-01-25T05:58:36Z
// when this was written — and everything below that floor it simply does not have. If that floor
// ever moves FORWARD, the days we already stored beneath it stop being re-derivable, and at that
// moment the volume quietly stops being a cache and becomes the only copy. Nothing in the code
// would notice: every request still answers, every chart still draws, the coverage bar still
// reads complete, and a redeploy onto a fresh volume would refill the series short at its OLDEST
// end and say nothing about it.
//
// Infra's words, and they are right: *"re-check the orca floor periodically: it's the one thing
// that turns their pure cache into state, and neither side would notice."*
//
// ── what a canary is, and what it is not ─────────────────────────────────────────────────────
// It is a REPORTING condition, never an error. It does not throw, it does not fail a request, it
// does not flip `/healthz`, and it does not stop a job. CLAUDE.md's rule about failing loudly is
// about decoders: a wrong number that would render perfectly must fail rather than render. This
// is the opposite shape — the numbers are RIGHT, and what changed is that they can no longer be
// reproduced. Taking the site down over that would destroy the thing it is protecting.
//
// It is also not `src/core/liveness.js`, and the difference is worth stating because the two are
// easy to confuse. Liveness is a caveat on a PAYLOAD: does the data in front of this reader reach
// the upstream's head. It is computed from the same payload the charts are drawn from, it is
// rendered on the page, and it is per-request. A durability canary is a caveat on the VOLUME: a
// reader of `/hydration/` cannot act on it and would not know what to do with it, whereas infra —
// the people who accepted "no backup" and asked to be told — read `/api/health` with alerting.
// So this surfaces there, and on the boot log where a human sees it.
//
// ── the comparison is against the STORE, not against a date ──────────────────────────────────
// "The floor moved" is not by itself actionable, and a hardcoded floor date would be the usual
// trap: right until a runtime — or in this case a retention policy — moves it, and then wrong in
// a way that reads as a fact. What matters is the intersection: **the floor moved past days we
// are holding**. A handler answers that by asking its own upstream where the floor is now and
// asking the store what sits below it. Nothing here knows what a floor is.
//
// ── the handler contract ─────────────────────────────────────────────────────────────────────
// Optional, next to `immutable`/`nextBatch`/`warm` in a source's `jobs` entry:
//
//   canary: async ({ store, sourceId, operationId }) => ({
//     subject,          // what is being watched, in a human's words
//     state,            // 'ok' | 'at-risk' | 'unknown'  — 'unknown' is NOT 'ok'
//     message,          // ONE sentence naming the CONSEQUENCE, not the reading. See below.
//     detail,           // optional, JSON-serialisable: the numbers the message was built from
//   })
//
// May be async, may throw (a throw becomes `unknown`, which is the honest answer for "we asked
// and could not find out"), and may return null for "nothing to report from this handler today".
//
// `message` states the consequence. "Orca's floor moved past 214 stored days; those days can no
// longer be re-derived and this volume is now their only copy" is something somebody can act on.
// "floor: 6837788" is not — it is a reading, and a reading in an alert is a thing people learn to
// scroll past.

/** The three states. `unknown` is a real answer and is never collapsed into `ok`, for the same
 *  reason `liveness` keeps its own `unknown`: an upstream that did not answer is not a healthy
 *  one, and a canary that says everything is fine when it could not check is worse than none. */
export const CANARY_STATES = /** @type {const} */ (['ok', 'at-risk', 'unknown'])

/**
 * Run every job handler's canary, and return one report each.
 *
 * Never throws. A handler that throws, returns nothing usable, or returns a state this file does
 * not recognise still produces a report — `unknown`, naming what went wrong — because a canary
 * that vanishes when it breaks is indistinguishable from one that is passing.
 *
 * @param {object} args
 * @param {import('./store.mjs').Store} args.store
 * @param {Record<string, any>} [args.sources]  the source table; defaults to the real registry
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ok: boolean|null, checkedAt: number, reports: object[]}>}
 *          `ok` is null when there was nothing to check — null is not true.
 */
export async function runCanaries({ store, sources, log = (line) => console.log(line) } = {}) {
  const checkedAt = Date.now()
  if (!store) return { ok: null, checkedAt, reports: [] }

  // Lazily, through the registry, for the same reason warm.mjs and job-worker.mjs do it: this
  // file must not become a second way for a (source, operation) to come into existence.
  const table = sources ?? (await import('../sources/index.mjs')).SOURCES

  const reports = []
  for (const source of Object.values(table)) {
    for (const [operationId, handler] of Object.entries(source.jobs ?? {})) {
      if (typeof handler.canary !== 'function') continue

      let raw
      try {
        raw = await handler.canary({ store, sourceId: source.id, operationId })
      } catch (problem) {
        reports.push(
          report({
            sourceId: source.id,
            operationId,
            checkedAt,
            subject: 'durability',
            state: 'unknown',
            message:
              `The durability check for \`${source.id}/${operationId}\` could not run: ` +
              `${problem?.message ?? problem}. Whether anything in the store has stopped being ` +
              `re-derivable is UNKNOWN, not fine.`,
          }),
        )
        continue
      }
      if (raw === null || raw === undefined) continue
      reports.push(report({ sourceId: source.id, operationId, checkedAt, ...raw }))
    }
  }

  // `ok` over the whole set: false if ANY report is not `ok`, including the unknowns. Nothing to
  // check is null.
  const ok = reports.length === 0 ? null : reports.every((entry) => entry.state === 'ok')
  for (const entry of reports) {
    // Only the ones worth a line. A log line printed on every boot of a healthy instance is a
    // line nobody reads, and this one has to be read when it appears.
    if (entry.state !== 'ok') log(`[canary] ${entry.source}/${entry.operation}: ${entry.state} — ${entry.message}`)
  }
  return { ok, checkedAt, reports }
}

/**
 * Normalise one report. A handler that answers with a state this file does not know, or with no
 * message, is downgraded to `unknown` rather than published as-is — the failure mode to avoid is
 * a malformed report rendering as a confident green, which is the same argument `liveness()`
 * makes for throwing on a bad assertion. Here it degrades instead of throwing, because the
 * caller is a background tick and not a request.
 */
function report({ sourceId, operationId, checkedAt, subject, state, message, detail = null }) {
  const known = CANARY_STATES.includes(state)
  const said = typeof message === 'string' && message.trim() !== ''
  return {
    source: sourceId,
    operation: operationId,
    subject: typeof subject === 'string' && subject.trim() !== '' ? subject : 'durability',
    state: known && said ? state : 'unknown',
    checkedAt,
    message: said
      ? message
      : `\`${sourceId}/${operationId}\` returned a durability report with no message${
          known ? '' : ` and an unrecognised state \`${state}\``
        }, so what it found cannot be reported.`,
    detail,
  }
}
