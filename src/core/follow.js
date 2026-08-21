// Follow a store that is still filling.
//
// A page that was answered a partial series has three ways to get the rest, and this module owns
// the choreography between them so every page does not reinvent it:
//
//   1. SUBSCRIBE — an `EventSource` on `/api/stream/<source>/<operation>`, where the server
//      hands over each identity's complete envelope as it lands. The normal path.
//   2. POLL — re-ask the page's own aggregate endpoint on a slow timer. The fallback, entered
//      when the stream cannot be established or dies without ever delivering: an old browser, a
//      proxy that buffers `text/event-stream` into silence, an instance at its watch cap. The
//      symptom of a buffering proxy is precisely "the stream connects and nothing ever arrives",
//      which is why the trigger is repeated errors with zero frames received, not merely an
//      error — EventSource fires a transient error on every reconnect and those are healthy.
//   3. STOP — on `done`, on completeness, on a lifetime cap, or when the caller says so. A tab
//      left open must converge to zero requests, not poll a complete series until the laptop
//      sleeps.
//
// Re-delivery is normal, not an edge case: a reconnecting stream re-sends whatever it was asked
// for that is already complete, and a poll returns months the stream also delivered. Callers
// therefore apply updates idempotently — an envelope keyed by its own identity replaces, never
// appends.
//
// Browser-only by nature (`EventSource`), constructed at call time — importing this module does
// not touch the global, so its presence in `src/core/` costs the server nothing.

/**
 * @param {object} args
 * @param {string} args.source            registry source id, e.g. 'asset-hub'
 * @param {string} args.operation         the JOB operation being watched, e.g. 'netflows-daily'
 * @param {Record<string, string>} args.query   watch parameters, e.g. { network, months: 'a,b' }
 * @param {string} args.event             the SSE event name the handler's watch declares
 * @param {() => Promise<{complete?: boolean}>} args.poll   re-reads the aggregate; its answer is
 *                                        handed to onUpdate and its `complete` ends the follow
 * @param {(update: {kind: 'event'|'stalled'|'poll', data?: object, result?: object}) => void} [args.onUpdate]
 * @param {(why: 'done'|'complete'|'timeout'|'stopped') => void} [args.onSettled]
 * @param {number} [args.pollMs]          fallback poll interval. A minute, not seconds: the poll
 *                                        re-reads the WHOLE aggregate, and a chart that fills
 *                                        over minutes does not need second-fresh gaps.
 * @param {number} [args.maxMs]           hard lifetime cap on the whole follow. Half an hour —
 *                                        smaller than an abandoned tab's afternoon, but sized
 *                                        against the real thing it waits for: a cold-store
 *                                        backfill is tens of minutes of serial fetching, and a
 *                                        cap that fires mid-fill turns the page's "stays
 *                                        subscribed" promise into a lie (review finding of
 *                                        decision 0020). Pages must surface `onSettled` reasons
 *                                        other than 'complete'/'done' to the reader.
 * @returns {{ stop: () => void }}
 */
export function followStore({ source, operation, query, event, poll, onUpdate, onSettled, pollMs = 60_000, maxMs = 30 * 60_000 }) {
  let es = null
  let pollTimer = null
  let polling = false
  let settled = false
  let received = 0
  let errors = 0

  const stop = () => {
    if (es) {
      es.close()
      es = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    clearTimeout(deadline)
  }

  const settle = (why) => {
    if (settled) return
    settled = true
    stop()
    onSettled?.(why)
  }

  const startPolling = () => {
    if (settled || pollTimer) return
    if (es) {
      es.close()
      es = null
    }
    pollTimer = setInterval(async () => {
      // One poll in flight at a time: a slow answer must queue behind itself, not beside itself.
      if (settled || polling) return
      polling = true
      try {
        const result = await poll()
        if (settled) return
        onUpdate?.({ kind: 'poll', result })
        if (result?.complete) settle('complete')
      } catch {
        // A failed poll is weather; the next tick is the retry. The page already drew what it
        // has, so there is nothing to escalate to that would serve a reader better than trying
        // again in a few seconds.
      } finally {
        polling = false
      }
    }, pollMs)
  }

  const deadline = setTimeout(() => settle('timeout'), maxMs)

  const search = new URLSearchParams(query)
  try {
    es = new EventSource(`/api/stream/${source}/${operation}?${search}`)
  } catch {
    // No EventSource in this browser. The follow still works — it just polls.
    startPolling()
  }

  if (es) {
    es.addEventListener(event, (frame) => {
      received += 1
      errors = 0
      try {
        onUpdate?.({ kind: 'event', data: JSON.parse(frame.data) })
      } catch {
        // A frame that does not parse is dropped; the reconciling poll or the next frame carries
        // the same fact again. Applying half a frame is the only losing move.
      }
    })
    es.addEventListener('stalled', (frame) => {
      received += 1
      try {
        onUpdate?.({ kind: 'stalled', data: JSON.parse(frame.data) })
      } catch {
        /* as above */
      }
    })
    es.addEventListener('done', (frame) => {
      // `done` carries a machine-readable reason, and only `complete` means "stop following".
      // The server also ends a watch at its lifetime cap or on an internal failure — with months
      // still pending — and treating those as completion was the worst confirmed finding of this
      // module's review: every such end permanently orphaned a mid-fill page. Anything but
      // `complete` (including a frame that does not parse) downgrades to polling, which already
      // converges to zero requests the moment the aggregate answers complete.
      let reason = null
      try {
        reason = JSON.parse(frame.data)?.reason ?? null
      } catch {
        /* an unreadable reason is not completion */
      }
      if (reason === 'complete') return settle('done')
      startPolling()
    })
    es.onerror = () => {
      errors += 1
      // CLOSED means the browser will not retry — a non-200 answer, typically the watch cap.
      if (es?.readyState === EventSource.CLOSED) return startPolling()
      // Connecting-and-erroring repeatedly with nothing ever delivered is the buffering-proxy
      // signature; transient reconnects on a working stream reset `errors` on every frame.
      if (received === 0 && errors >= 2) return startPolling()
    }
  }

  return { stop: () => settle('stopped') }
}
