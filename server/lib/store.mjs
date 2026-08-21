// The persistent store — mode A of the architecture (docs/concept/plan.md §2.1).
//
// Anything immutable that has been fetched once is never fetched again. This file is where
// "never again" lives: a single SQLite file holding FACTS — payloads keyed by
// (source, operation, canonical params, segment) — plus the job queue's tables (the queue
// itself lives in jobs.mjs, but its schema is migrated here so there is exactly one
// forward-only migration history for the one file).
//
// Three properties are load-bearing:
//
//   · CANONICAL KEYS. `{a:1, b:2}` and `{b:2, a:1}` are the same request and must be the same
//     row, or the store silently halves its own hit rate — the same rule params.mjs applies to
//     the TTL cache key, made durable.
//   · SEGMENTS. A year of history is not one row; it is one row per day (or per page, per
//     block window — the operation chooses). That is what makes a long fetch resumable, the
//     coverage bar drawable, and a partial answer servable.
//   · THE EVENT LOOP IS NOT BLOCKED BY A BIG READ. `node:sqlite` is synchronous, and a
//     synchronous `.all()` over a large result stalled the HTTP thread for 1.6 s in probing;
//     `.iterate()` with a periodic `setImmediate` yield brought the same read to ~43 ms of
//     stall. Every potentially-large read goes through `#drain` below, so the pattern lives
//     in one place instead of being re-remembered at every call site.
//
// Every fact row carries the upstream `head` it was computed against and the code version
// that produced it (plan §6.1): a store you cannot audit is a store you cannot re-derive.

import { DatabaseSync } from 'node:sqlite'
import { accessSync, constants as FS, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolvePath(fileURLToPath(new URL('../..', import.meta.url)))

/** Where the SQLite file lives. Overridable so the CLI, tests and production can each point
 *  somewhere explicit without any of them hardcoding a path into shared code. */
export function defaultDataDir() {
  return process.env.ANALYTICS_DATA_DIR ?? join(ROOT, 'server', 'data')
}

/**
 * Forward-only migrations. Each entry runs once, in order, inside its own transaction, and
 * `schema_version` records how far this file has come. There is deliberately no "down" — a
 * store of facts fetched from upstreams that may since have died is not something to roll
 * back; a wrong migration gets a correcting migration.
 *
 * An entry is SQL, or a `(db) => void` for the cases SQL cannot express idempotently — see
 * migration 3, and `migrate()` at the bottom of this file.
 */
const MIGRATIONS = [
  // 1 — facts, jobs.
  `
  CREATE TABLE facts (
    source       TEXT NOT NULL,
    operation    TEXT NOT NULL,
    params       TEXT NOT NULL,            -- canonical JSON (sorted keys, undefined dropped)
    segment      TEXT NOT NULL,            -- the chunk id: a day, a page, a block window
    payload      TEXT NOT NULL,            -- JSON
    head         TEXT,                     -- upstream head this was computed against; NULL = not recorded
    code_version TEXT,                     -- what produced it; NULL = not recorded
    stored_at    INTEGER NOT NULL,         -- ms epoch
    PRIMARY KEY (source, operation, params, segment)
  );

  CREATE TABLE jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,
    operation        TEXT NOT NULL,
    params           TEXT NOT NULL,        -- canonical JSON, same rules as facts.params
    state            TEXT NOT NULL,        -- queued | running | partial | done | failed | gave-up
    cursor           TEXT,                 -- JSON; NULL = start from the beginning
    done_units       INTEGER,              -- NULL = not knowable. NULL is not 0.
    total_units      INTEGER,              -- NULL = not knowable. NULL is not 0.
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL,
    next_attempt_at  INTEGER,              -- ms epoch; when a failed job may be claimed again
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_expires_at INTEGER,              -- heartbeat lease while running; stale = owner died
    lease_owner      TEXT,                 -- which JobQueue instance holds the lease; a deposed
                                           -- owner's writes are refused by this, not by luck
    error            TEXT,                 -- last failure, for a human reading \`job status\`
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  -- At most one process drains the queue at a time, across the machine. This is what makes the
  -- per-host politeness gate (an in-process structure) a system-wide guarantee: one drainer,
  -- therefore one HostGate per host that matters. Lease semantics, same as jobs.
  CREATE TABLE engine_lock (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    owner      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Find-or-create's backstop: at most one LIVE job per identity, enforced by the database
  -- rather than hoped for by the code — two processes racing an enqueue cannot both win.
  CREATE UNIQUE INDEX jobs_live_identity ON jobs (source, operation, params)
    WHERE state IN ('queued', 'running', 'partial', 'failed');

  CREATE INDEX jobs_claimable ON jobs (state, next_attempt_at);
  `,

  // 2 — netflows-daily gained a required `network`, which changed its identity.
  //
  // THE PARAMS ARE THE IDENTITY (docs/architecture/jobs.md), so adding a parameter to a
  // store-backed job does not extend the old rows — it ORPHANS them. `{"month":"2022-01"}` and
  // `{"month":"2022-01","network":"polkadot"}` share no segment, no coverage and no `done` job,
  // so 1,673 already-fetched Polkadot days became invisible and would have been re-derived from
  // Parity's public RPC, once, for nothing (~39 minutes of politeness-gated requests). This
  // renames them instead.
  //
  // Data, not schema, and that is the point: a migration is the only place where the identity of
  // a fact can be changed at all. Nothing in the running code may rewrite a params string —
  // `canonicalParams` is the one function allowed to produce one — so a change of identity is a
  // forward-only, once-only, transactional event or it is a bug.
  //
  // Why `replace()` is exactly right here rather than merely plausible: canonical params sort
  // their keys, so `month` precedes `network` and appending the pair before the closing brace
  // produces byte-for-byte what `canonicalParams({month, network:'polkadot'})` produces. The
  // `LIKE '{"month":"____-__"}'` guard is what makes that a proof rather than a hope — it admits
  // only the exact shape this job's old identity could have had (one key, a `YYYY-MM` string,
  // therefore exactly one `}`, at the end). A params string that merely LOOKS right is a fact
  // nothing can ever find again, so the shape is asserted, not assumed. `server/test/store.test.mjs`
  // checks the result against `canonicalParams` itself.
  //
  // The two DELETEs are the collision case, and they are not hypothetical: an instance that
  // served this month both before and after the Kusama change holds BOTH identities. The facts
  // table is keyed (source, operation, params, segment), so renaming into an occupied key is a
  // constraint failure — which, inside `migrate`, means the store does not open AT ALL. The row
  // written by the CURRENT code wins; the orphan is dropped. Same for `jobs`, where the partial
  // unique index admits one LIVE job per identity (a `done` or `gave-up` twin is harmless, and
  // `describeIdentity` already takes the newest `done` by id).
  //
  // Harmless to run twice by construction, not merely by `schema_version`: every statement is
  // guarded on `params NOT LIKE '%network%'`, which nothing it produces can match.
  `
  DELETE FROM facts AS orphan
   WHERE orphan.source = 'asset-hub' AND orphan.operation = 'netflows-daily'
     AND orphan.params NOT LIKE '%network%'
     AND orphan.params LIKE '{"month":"____-__"}'
     AND EXISTS (
       SELECT 1 FROM facts AS current
        WHERE current.source = orphan.source AND current.operation = orphan.operation
          AND current.segment = orphan.segment
          AND current.params = replace(orphan.params, '}', ',"network":"polkadot"}')
     );

  DELETE FROM jobs AS orphan
   WHERE orphan.source = 'asset-hub' AND orphan.operation = 'netflows-daily'
     AND orphan.params NOT LIKE '%network%'
     AND orphan.params LIKE '{"month":"____-__"}'
     AND orphan.state IN ('queued', 'running', 'partial', 'failed')
     AND EXISTS (
       SELECT 1 FROM jobs AS current
        WHERE current.source = orphan.source AND current.operation = orphan.operation
          AND current.params = replace(orphan.params, '}', ',"network":"polkadot"}')
          AND current.state IN ('queued', 'running', 'partial', 'failed')
     );

  UPDATE facts SET params = replace(params, '}', ',"network":"polkadot"}')
   WHERE source = 'asset-hub' AND operation = 'netflows-daily'
     AND params NOT LIKE '%network%'
     AND params LIKE '{"month":"____-__"}';

  UPDATE jobs SET params = replace(params, '}', ',"network":"polkadot"}')
   WHERE source = 'asset-hub' AND operation = 'netflows-daily'
     AND params NOT LIKE '%network%'
     AND params LIKE '{"month":"____-__"}';
  `,

  // 3 — jobs gain a `priority`, so a reader's request is claimed before a warm-enqueued one.
  //
  // Boot warming (decision 0014) put 135 identities in the queue at once on a cold store, and
  // `claim()` was `ORDER BY id LIMIT 1` — FIFO by insertion. So the page that triggered a fetch
  // waited behind every month nobody had asked for: measured in production on 2026-08-21, a
  // reader asking for `netflows-daily?month=2026-07&network=polkadot` was job 74 of 135, about
  // two hours behind, for a month that takes ~45 s on its own. Warming inverted the pre-warm
  // situation, where a reader's request was the only job in the queue.
  //
  // A FUNCTION, not a string, and that is the whole reason `migrate` accepts one. `ALTER TABLE
  // … ADD COLUMN` is the one statement here with no `IF NOT EXISTS` form, so replayed over a
  // store that already has the column it fails with `duplicate column name` — which, inside
  // `migrate`, means the store does not open AT ALL. Every other migration in this list is
  // harmless twice by construction (migration 2's guards are in its own WHERE clauses) and this
  // one has to meet the same standard, because `schema_version` is not the only thing that
  // decides whether a step is replayed: a store half-converted by hand is a real state, and
  // `server/test/store.test.mjs` deliberately rewinds the bookkeeping to prove it.
  //
  // DEFAULT 0 is `JOB_PRIORITY.warm` (jobs.mjs), so every row that already exists becomes a
  // warm-priority row. That is the direction that behaves correctly on the deploy that ships
  // this: a backlog mid-drain is exactly the warm work this exists to get out of a reader's
  // way, and the first reader to ask for one of those identities raises it.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(jobs)').all()
    if (!columns.some((column) => column.name === 'priority')) {
      db.exec('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
    }
    // Claim order is (priority DESC, id ASC) over the runnable set. The table is small — a few
    // hundred rows at most — so this index is about keeping the claim a lookup rather than a
    // sort as the `done` rows accumulate, not about rescuing a slow query.
    db.exec('CREATE INDEX IF NOT EXISTS jobs_priority ON jobs (priority DESC, id)')
  },
]

/** How far a fully-migrated store has come. Exported so a test can assert "every migration ran,
 *  exactly once" without a literal that has to be edited every time one is added — a literal
 *  left stale still passes while half the list has not run. */
export const MIGRATION_COUNT = MIGRATIONS.length

/** How many rows a large read processes between yields to the event loop. */
const YIELD_EVERY = 512

/**
 * Params are canonicalised — keys sorted at every depth, `undefined` values dropped — so that
 * the same request is always the same key. This string IS the identity; nothing ever compares
 * params as objects.
 */
export function canonicalParams(params = {}) {
  return JSON.stringify(sortValue(params))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key])
    }
    return out
  }
  return value
}

export class Store {
  /** @param {DatabaseSync} db @param {string} path */
  constructor(db, path) {
    this.db = db
    this.path = path
  }

  /**
   * Run `fn` inside one transaction. This is what the job engine builds its one invariant on:
   * a batch of rows and the cursor that covers them commit together or not at all.
   * `BEGIN IMMEDIATE` takes the write lock up front, so a concurrent writer waits (via
   * busy_timeout) instead of failing at COMMIT.
   */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (problem) {
      this.db.exec('ROLLBACK')
      throw problem
    }
  }

  /**
   * Insert one fact. `OR REPLACE`, deliberately: facts are immutable in the world, but a
   * resumed job may legitimately refetch the page a crash interrupted, and an explicit
   * re-derive (plan §5.3) overwrites on purpose. Idempotent writes are what make both free.
   *
   * `head` and `codeVersion` default to null — "not recorded" — never to a made-up value.
   */
  putFact({ source, operation, params, segment, payload, head = null, codeVersion = null }) {
    if (typeof segment !== 'string' || segment === '') {
      throw new TypeError('A fact needs a non-empty string `segment`.')
    }
    const json = JSON.stringify(payload)
    if (json === undefined) throw new TypeError('A fact `payload` must be JSON-serialisable.')
    this.#put.run(source, operation, canonicalParams(params), segment, json, head, codeVersion, Date.now())
  }

  /** One fact, or `undefined`. Small by construction (one segment), so a plain `.get` is fine. */
  getFact(source, operation, params, segment) {
    const row = this.#get.get(source, operation, canonicalParams(params), segment)
    return row ? hydrate(row) : undefined
  }

  /**
   * Every fact under an identity, ordered by segment. This is the read that can be a year of
   * days, so it is the one that must not stall the event loop — hence async, and `#drain`.
   */
  readFacts(source, operation, params) {
    // A FRESH statement per call, never the cache: #drain yields to the event loop mid-iteration,
    // and a second concurrent read re-binding the same cached StatementSync would silently mix
    // the two result sets (verified: no error, wrong rows). get/run statements stay cached —
    // they never yield.
    const statement = this.db.prepare(
      'SELECT * FROM facts WHERE source = ? AND operation = ? AND params = ? ORDER BY segment',
    )
    return this.#drain(statement.iterate(source, operation, canonicalParams(params)), hydrate)
  }

  /**
   * What is already filled in, without paying to load the payloads: segment count and range.
   * The coverage bar and the "answer with what we have" path read this, not the facts.
   * Derived from the facts table rather than kept in a second one — bookkeeping that is
   * computed cannot drift from the rows it describes.
   */
  coverage(source, operation, params) {
    const row = this.#coverage.get(source, operation, canonicalParams(params))
    return {
      segments: row?.segments ?? 0,
      earliest: row?.earliest ?? null,
      latest: row?.latest ?? null,
    }
  }

  /**
   * How many facts this (source, operation) holds whose segment sorts BEFORE `bound`, across
   * every identity of the operation.
   *
   * Across identities, deliberately, and that is the point of the pair of methods rather than a
   * per-params one: the question they exist for is "what does this store hold that its upstream
   * can no longer produce" (server/lib/canary.mjs), and an upstream's retention floor is a fact
   * about the operation, not about whichever month bucket a reader happened to ask for.
   *
   * Segments sort as strings (see the handler contract in job-worker.mjs), so `bound` is compared
   * as one — for an ISO-dated segment that is its real order.
   */
  countFactsBefore(source, operation, bound) {
    const row = this.#countBefore.get(source, operation, String(bound))
    return Number(row?.n ?? 0)
  }

  /**
   * The same rows, hydrated. Separate from the count on purpose: the count is a cheap index
   * probe and the caller uses it to decide whether loading payloads is worth doing at all —
   * in the healthy case the answer is zero and no payload is ever read.
   */
  readFactsBefore(source, operation, bound) {
    // Fresh statement for the same reason as readFacts: draining reads must not share.
    const statement = this.db.prepare(
      'SELECT * FROM facts WHERE source = ? AND operation = ? AND segment < ? ORDER BY segment',
    )
    return this.#drain(statement.iterate(source, operation, String(bound)), hydrate)
  }

  /** Segment ids only — for "which days are missing" set arithmetic. Can be large, so drained. */
  listSegments(source, operation, params) {
    // Fresh statement for the same reason as readFacts: draining reads must not share.
    const statement = this.db.prepare(
      'SELECT segment FROM facts WHERE source = ? AND operation = ? AND params = ? ORDER BY segment',
    )
    return this.#drain(statement.iterate(source, operation, canonicalParams(params)), (row) => row.segment)
  }

  close() {
    this.db.close()
  }

  /* ---------------------------------------------------------------------- internals ---- */

  /**
   * The iterate-and-yield pattern, in exactly one place. `node:sqlite` reads are synchronous;
   * over a large result that is a stalled event loop (1610 ms measured, vs 43 ms with this),
   * which on the HTTP thread means every other request waits behind one big chart.
   */
  async #drain(iterator, mapRow) {
    const out = []
    let count = 0
    for (const row of iterator) {
      out.push(mapRow(row))
      count += 1
      if (count % YIELD_EVERY === 0) await new Promise((settle) => setImmediate(settle))
    }
    return out
  }

  // Prepared lazily so constructing a Store does not depend on statement order, and cached
  // because preparation is the expensive half of a synchronous query.
  #statements = new Map()
  #prepare(sql) {
    let statement = this.#statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  get #put() {
    return this.#prepare(
      `INSERT OR REPLACE INTO facts (source, operation, params, segment, payload, head, code_version, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
  }
  get #get() {
    return this.#prepare('SELECT * FROM facts WHERE source = ? AND operation = ? AND params = ? AND segment = ?')
  }
  get #coverage() {
    return this.#prepare(
      `SELECT COUNT(*) AS segments, MIN(segment) AS earliest, MAX(segment) AS latest
       FROM facts WHERE source = ? AND operation = ? AND params = ?`,
    )
  }
  get #countBefore() {
    return this.#prepare('SELECT COUNT(*) AS n FROM facts WHERE source = ? AND operation = ? AND segment < ?')
  }
}

function hydrate(row) {
  return {
    source: row.source,
    operation: row.operation,
    params: row.params,
    segment: row.segment,
    payload: JSON.parse(row.payload),
    head: row.head,
    codeVersion: row.code_version,
    storedAt: row.stored_at,
  }
}

/**
 * Open (creating if needed) the store at `dir`. Runs pending migrations before returning, so
 * a caller holding a Store is always holding one at the current schema.
 *
 * @param {object} [options]
 * @param {string} [options.dir] defaults to ANALYTICS_DATA_DIR, then <repo>/server/data
 */
export function openStore({ dir = defaultDataDir() } = {}) {
  const path = join(dir, 'store.sqlite')
  let db
  try {
    ensureDir(dir)
    // Asked BEFORE SQLite is, purely for the message. `new DatabaseSync` on an unwritable
    // directory says "unable to open database file" and names neither the directory nor the
    // reason; access(2) distinguishes EACCES (wrong owner — a bind mount the container's uid
    // does not own) from EROFS (the --read-only rootfs, i.e. no volume is mounted at all),
    // and those have completely different remedies.
    accessSync(dir, FS.W_OK)
    db = new DatabaseSync(path)

    // WAL lets the HTTP thread read while the worker writes; busy_timeout makes a cross-process
    // write collision a short wait instead of an immediate SQLITE_BUSY error. temp_store MEMORY
    // because the production container runs --read-only: SQLite must never need a temp FILE
    // (a spilled sort or an index build would otherwise fail with SQLITE_CANTOPEN, Linux only,
    // unreproducible on a dev box where the OS temp dir is always writable).
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA temp_store = MEMORY')
  } catch (problem) {
    // Name the path and the remedy. The raw errors here are famously mute — mkdir EACCES on a
    // root-owned mount, or `new DatabaseSync` saying only "unable to open database file" — and
    // in the container the default dir is inside a read-only image layer, so the ONLY fix is
    // pointing ANALYTICS_DATA_DIR somewhere real.
    throw new Error(
      `Cannot open the store at ${path}: ${problem.message}. The directory must exist and be ` +
        `writable by this process — set ANALYTICS_DATA_DIR to a writable location (in a ` +
        `container, a mounted volume).`,
      { cause: problem },
    )
  }

  // Outside the catch above on purpose — a migration failure is a schema problem, not a
  // "point ANALYTICS_DATA_DIR somewhere writable" problem, and dressing it as one would send
  // the reader to the wrong place. But the handle must not leak: without this, a failed
  // migration left an open SQLite connection (and its WAL) behind on a process that then went
  // on running.
  try {
    migrate(db)
  } catch (problem) {
    try {
      db.close()
    } catch {
      /* the migration error is the one worth reporting */
    }
    throw problem
  }
  return new Store(db, path)
}

/**
 * Create `dir` and any missing ancestors. Deliberately NOT `mkdirSync(dir, {recursive:true})`.
 *
 * Node's recursive mkdir is not bounded. It reads ENOENT from a mkdir as "the parent does not
 * exist yet", creates the parent, and retries the child — so on a filesystem that answers
 * ENOENT to *creating* a child whose parent already exists, the two steps alternate forever.
 * procfs does exactly that: `mkdir('/proc/x')` is ENOENT while `/proc` stats as a directory
 * (verified on Linux 6.18, 2026-08-21, from Node and from /bin/mkdir alike).
 *
 * The failure mode is the reason this is worth 20 lines. It is a SPIN, not a block — the thread
 * sits in C++ at 100% CPU, state R, and never throws — so `openStore`'s try/catch cannot fire,
 * `createApp` never returns, and `server.listen` is never reached. A mistyped
 * ANALYTICS_DATA_DIR became a container that starts, never listens, and prints nothing.
 *
 * This walks the ancestor chain ONCE and never revisits a path, so the loop is bounded by the
 * depth of the path: the worst case is an error naming the directory, which is what the caller
 * above is built to turn into a readable remedy.
 */
function ensureDir(dir) {
  const target = resolvePath(dir)

  // Deepest first: stop at the first ancestor that already is a directory.
  const missing = []
  for (let at = target; !isDirectory(at); at = dirname(at)) {
    missing.push(at)
    if (dirname(at) === at) break // the filesystem root itself is not a directory: give up
  }

  // Shallowest first, one mkdir each, no retries.
  for (const path of missing.reverse()) {
    try {
      mkdirSync(path)
    } catch (problem) {
      // A concurrent process (the worker thread, a `job run` in another shell) may have created
      // it between the stat and the mkdir. Anything else is real and is the caller's answer.
      if (problem?.code !== 'EEXIST') throw problem
    }
  }

  // A path that exists as a FILE reaches here having "succeeded": every mkdir said EEXIST.
  // Saying so beats letting SQLite report it as an unopenable database.
  if (!isDirectory(target)) {
    throw new Error(`${target} exists but is not a directory.`)
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // ENOENT, ENOTDIR, EACCES on a parent, or an invalid path (a NUL byte) — all "not a
    // directory we can use", and the mkdir below reports which.
    return false
  }
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const current = db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? 0

  for (let next = current; next < MIGRATIONS.length; next += 1) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // A step is SQL, or a function for the statements SQL has no idempotent form of. Both run
      // inside the transaction opened above, so a function that throws halfway rolls back the
      // same way a bad statement does.
      const step = MIGRATIONS[next]
      if (typeof step === 'function') step(db)
      else db.exec(step)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(next + 1)
      db.exec('COMMIT')
    } catch (problem) {
      db.exec('ROLLBACK')
      throw new Error(`Store migration ${next + 1} failed: ${problem.message}`, { cause: problem })
    }
  }
}
