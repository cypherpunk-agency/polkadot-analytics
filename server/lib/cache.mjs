// A bounded TTL cache with single-flight.
//
// This is the whole reason the site is a container rather than a `dist/` on a file server.
// The dashboards are heavy clients by design — the Bulletin explorer resolves signers at two
// RPC calls per block, the HyperFX page sums every order ever placed — and the site answers
// the open internet with no auth gate. Without a cache in front, N visitors are N full fan-outs
// at a volunteer-run devnet node. With it, N visitors are one.
//
// Three properties matter, and each of them is a bug we would otherwise ship:
//
//   · TTL          a stale answer is fine; a hammered upstream is not.
//   · SINGLE-FLIGHT ten simultaneous cold requests for the same key must produce ONE upstream
//                  call, not ten. Without this the cache makes a thundering herd *worse*,
//                  because a cold cache is exactly when traffic spikes.
//   · BOUNDED      the container has a 256 MB ceiling. An unbounded cache keyed on
//                  user-supplied parameters is a memory-exhaustion vector on a public URL,
//                  and it fails as an OOM crash-loop rather than as a clean error.

/** @typedef {{ value: unknown, expiresAt: number, bytes: number }} Entry */

export class TtlCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries] hard cap on key count
   * @param {number} [options.maxBytes]   approximate cap on retained payload size
   */
  constructor({ maxEntries = 500, maxBytes = 64 * 1024 * 1024 } = {}) {
    /** @type {Map<string, Entry>} insertion-ordered, which is what makes the eviction below LRU-ish */
    this.entries = new Map()
    /** @type {Map<string, Promise<unknown>>} in-flight work, keyed the same way */
    this.inflight = new Map()
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.bytes = 0
    this.stats = { hits: 0, misses: 0, coalesced: 0, evictions: 0, errors: 0 }
  }

  /** Fresh value, or `undefined`. Reading refreshes recency so eviction sheds cold keys first. */
  peek(key) {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      this.#drop(key)
      return undefined
    }
    // Re-insert to move to the end of the Map's insertion order.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  /**
   * Fresh value for `key`, computing it with `produce` at most once across concurrent callers.
   *
   * A rejected `produce` is NOT cached — an upstream blip must not be pinned for the whole TTL —
   * but it IS shared with everyone waiting on that same flight, so a failing upstream still
   * costs one call rather than one per waiter.
   */
  async resolve(key, ttlMs, produce) {
    const cached = this.peek(key)
    if (cached !== undefined) {
      this.stats.hits += 1
      return cached
    }

    const running = this.inflight.get(key)
    if (running) {
      this.stats.coalesced += 1
      return running
    }

    this.stats.misses += 1
    const flight = (async () => {
      try {
        const value = await produce()
        this.set(key, value, ttlMs)
        return value
      } catch (error) {
        this.stats.errors += 1
        throw error
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, flight)
    return flight
  }

  set(key, value, ttlMs) {
    this.#drop(key)
    // Approximate, and deliberately so: measuring the true retained size of a decoded object
    // would cost more than the cache saves. JSON length tracks it closely enough to keep the
    // container off its memory ceiling, which is the only thing this number is for.
    let bytes = 1024
    try {
      bytes = JSON.stringify(value)?.length ?? 1024
    } catch {
      /* cyclic or otherwise unmeasurable — keep the floor estimate */
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, bytes })
    this.bytes += bytes
    this.#evict()
  }

  #drop(key) {
    const hit = this.entries.get(key)
    if (!hit) return
    this.bytes -= hit.bytes
    this.entries.delete(key)
  }

  #evict() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.#drop(oldest.value)
      this.stats.evictions += 1
    }
  }

  /** Expired-but-not-yet-read entries still hold memory; the server sweeps periodically. */
  sweep() {
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.#drop(key)
  }

  report() {
    return {
      entries: this.entries.size,
      approxBytes: this.bytes,
      inflight: this.inflight.size,
      ...this.stats,
    }
  }
}
