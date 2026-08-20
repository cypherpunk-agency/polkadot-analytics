# Persistence and ingest — research notes

**Sweep:** storage architecture for v2. **Date:** 2026-08-19. **Status:** research, no code written.

Everything numeric below came from a request or a benchmark run on this machine today. Where a
number is extrapolated from a measurement, the measurement and the arithmetic are both shown.
Where something could not be verified it is in [Unverified](#unverified).

Benchmark scratch lives outside the repo, in the session scratchpad; nothing here was committed
to `src/` or `server/`.

---

## 0. The one-paragraph answer

Use **SQLite through `node:sqlite`**, one file on a small persistent disk, with ingest running in
a **`worker_threads` worker** inside the same container and the HTTP thread only ever reading.
Store *trades* and *daily rollups* forever, *legs* for a rolling window, and keep a
**gzipped NDJSON archive** of the raw upstream responses as the thing that lets us rebuild without
asking the archive again — which matters more than it sounds, because the archive **cannot** serve
deep history reliably (measured below). DuckDB is genuinely faster and produces files 5–10× smaller,
and it is still the wrong choice here: 74 MB of native binary, +20–60 MB RSS under load, and a
storage format with only best-effort forward compatibility, bought to accelerate queries that a
TTL cache already hides. Ask infra for **10 GB pd-balanced**, a writable `/data` mount, **384 MB**
memory, and an infra-owned nightly snapshot — because our container has no credentials and must
never get any.

---

## 1. What the constraints actually are

Read first: `CLAUDE.md`, `docs/architecture/middleware.md`, `docs/architecture/deployment.md`.
The binding ones, restated so this file stands alone:

| Constraint | Where it comes from | What it forbids |
|---|---|---|
| No secrets, ever | `CLAUDE.md` rule 1, `docs/decisions/0003-no-secrets.md` | Anything that needs an API key. **Also forbids our container writing backups to GCS**, because that needs a credential. |
| Browser talks only to our origin | `CLAUDE.md` rule 2, CSP `connect-src 'self'` | A browser-side DB (DuckDB-WASM against a public Parquet bucket) — the CSP would block the fetch *silently*. |
| 256 MB container, 2 GB shared VM | `docs/architecture/deployment.md` | Anything with a large resident working set. This is the number under negotiation. |
| No persistent volume today | ditto | Everything in this document. This is the ask. |
| Zero runtime npm dependencies | `Dockerfile` stage 2 | Not absolute, but it is the property that makes the runtime image have no CVE surface but Node itself. Worth defending. |
| `--read-only` container | `Dockerfile`, CI asserts it | A store needs exactly one writable mount and nothing else. |
| Say what is wrong with the number | `CLAUDE.md` rule 3 | A store that starts empty must say "we have N days" on the page, not draw a confident short line. |

---

## 2. Measured data volumes

### 2.1 Hydration swap legs — the only large stream

Endpoint `https://explorer.hydradx.cloud/graphql` (Subsquid archive). Head at time of measurement:

```
$ curl -s -X POST https://explorer.hydradx.cloud/graphql -H 'content-type: application/json' \
    -d '{"query":"{ blocks(limit:1, orderBy: height_DESC) { height timestamp } }"}'
{"data":{"blocks":[{"height":13690803,"timestamp":"2026-08-19T16:59:51.000000Z"}]}}
```

Three consecutive one-day windows pulled with the repo's own keyset-paging query (`limit: 1000`,
`id_gt` cursor, `orderBy: id_ASC`):

| window (heights) | UTC day | legs | pages | upstream bytes | wall clock | bytes/leg |
|---|---|---|---|---|---|---|
| 13676403 → 13690804 | 18→19 Aug | 12,545 | 13 | 9,178,122 | 4,332 ms | 731.6 |
| 13662003 → 13676403 | 17→18 Aug | 12,171 | 13 | 8,871,902 | 5,949 ms | 728.9 |
| 13647603 → 13662003 | 16→17 Aug | 9,559 | 10 | 6,997,494 | 4,425 ms | 732.0 |
| **mean** | | **11,425** | 12 | 8,349,173 | 4,902 ms | **730.8** |

The "~11–13k legs/day" figure in the brief is confirmed, with a floor around 9.5k on a quiet day.

**Derived annual volume, used everywhere below:**

```
legs/year   = 11,425 × 365            = 4,170,125
trades/year = 4,170,125 × 0.43659     = 1,820,600
```

The 0.43659 is not a guess: building a full 4,578,925-row leg table and grouping on the trade key
produced exactly **1,999,105** trade groups. On the single real day it is 12,545 legs → 5,477
trades, **2.29 legs per trade**.

### 2.2 One real leg, verbatim

This is what a row costs before we touch it — 733 bytes of JSON for perhaps 60 bytes of fact:

```json
{"id":"0013676407-000016-1d012","indexInBlock":16,
 "args":{"fees":[{"asset":0,"amount":"752732833446","destination":{"value":"0x6d6f646c6f6d6e69706f6f6c…","__kind":"Account"}},
                 {"asset":0,"amount":"615872318272","destination":{"value":"0x6d6f646c66656570726f632f…","__kind":"Account"}}],
         "filler":"0x6d6f646c6f6d6e69706f6f6c…","inputs":[{"asset":1,"amount":"1040000000000"}],
         "outputs":[{"asset":0,"amount":"546073455535412"}],
         "swapper":"0x6d6f646c70792f74727372790…","operation":{"__kind":"ExactIn"},
         "fillerType":{"__kind":"Omnipool"},
         "operationStack":[{"value":[30104,10614613],"__kind":"DCA"},{"value":10614614,"__kind":"Router"}]},
 "block":{"height":13676407,"timestamp":"2026-08-18T17:40:12.000000Z"}}
```

Cardinality over the 12,545-leg day:

| property | value | consequence for the schema |
|---|---|---|
| distinct swappers | **135** | An `account` dimension table is nearly free and saves 32 bytes × every row. |
| distinct assets traded | 70 | Same — a small dimension. |
| `fillerType` variants | Omnipool, Stableswap, AAVE, XYK | 4 values → a 1-byte enum. |
| `operationStack[0].__kind` | Omnipool 4,554 · Router 4,647 · DCA 3,042 · Batch 259 · Direct 42 · **Xcm 1** | see below |
| max amount digits | **24** | **u128 amounts do not fit an SQLite INTEGER (i64 max is 19 digits).** They must be TEXT, REAL, or split. This is a schema decision, not a detail. |
| legs with >1 input | 1 of 12,545 | The "first leg in / last leg out" model is right, but multi-input legs exist and the schema should not forbid them. |
| fees per leg | 1.27 | If we ever store fees they are a child table, not columns. |

> **`Xcm` is a live `operationStack` variant.** `CLAUDE.md` records the set verified in runtime 435
> as Omnipool / Router / DCA / Batch (+ our own `Direct`). One `Xcm` leg appeared in the 18→19 Aug
> window. The code already uses whatever the chain sends rather than a fixed map, so nothing is
> broken — but the note in `CLAUDE.md` is now incomplete, and the persistence schema must not
> hardcode a closed enum either. Flagged to the docs sweep.

### 2.3 The archive cannot give us deep history — this is the central finding

The `hydration/swaps` operation exists because a 3-day window is expensive. It turns out a 3-day
window is also roughly the *largest window the upstream will serve at all*. Every row below is a
real request made today:

| query | result | time |
|---|---|---|
| 1-day window (14,401 blocks) at the head | 1,000 events (first page) | **695 ms** |
| 30-day window (432,000 blocks), first page | `canceling statement due to statement timeout` | 12,198 ms |
| 365-day window (5,256,000 blocks), first page | `canceling statement due to statement timeout` | 12,092 ms |
| 1-day window at height 8,000,000 (2025-06-20) | 1,000 events — **succeeded once** | 7,160 ms |
| …the same query, 30 s later | `canceling statement due to statement timeout` | 12,148 ms |
| …the same query again, after a 3 s pause | `canceling statement due to statement timeout` | 12,058 ms |
| 1-day window at height 7,250,000 | timeout | 12,098 ms |
| 1-day window at height 6,900,000 | timeout | 12,087 ms |
| 1-day window at height 6,500,000 | timeout | 12,073 ms |
| 1-day window at height 5,000,000 | timeout | 12,084 ms |
| 1-day window at height 1,000,000 | timeout | 12,087 ms |
| 1-day window at the head, immediately after all of the above | 1,000 events | **695 ms** |

Three things follow, and they shape the whole ingest design:

1. **The tail is cheap and reliable; the deep past is neither.** The same shape of query is 695 ms
   at the head and a hard 12-second timeout twelve million blocks back. The endpoint is healthy
   throughout — the last row proves it.
2. **A timeout is indistinguishable from "no rows here."** Walking backwards past the first block
   that ever emitted `Broadcast.Swapped3` produces the same 12-second error as a range that is
   merely slow. A backfill walker that retries on error will wedge forever. It needs an attempt
   budget per window and a "gave up" marker.
3. **History we do not capture now may be unobtainable later.** This is the argument for keeping a
   raw archive of everything we ingest, not just the derived tables. It is also the argument for
   starting ingest before the concept is finished.

No rate-limit headers were returned (`retry-after`, `x-ratelimit-*`, `ratelimit-*` all absent;
`server: cloudflare`). Politeness therefore has to be self-imposed — there is no signal to obey.

### 2.4 Everything else is small

**Bulletin index** — `https://bulletin-paseo.tservices.es:8443`, probed today (the devnet was up):

```
head block           555,536
storage keys under TransactionStorage.Transactions   4,002   (5 key pages, 1,134 ms)
250-key value sample                                 27,418 bytes of raw SCALE → ~110 B/key
whole index, raw                                     ~440 KB
```

The brief's "~5k objects" is confirmed at 4,002. The entire Bulletin index is **smaller than one
page of Hydration legs**.

**But the index is a sliding window, not an archive — and this is the hardest deadline in the
document.** A second probe 143 blocks (~14 min) later returned *fewer* keys, which should be
impossible for a chain that only gains data. It is not, and the reason is decisive:

```json
{"head":555679,"storageKeys":3991,
 "oldestStoringBlock":354084,"newestStoringBlock":554723,"spanBlocks":200639,
 "RETENTION_BLOCKS":201600,"headMinusRetention":354079,
 "oldestMinusRetentionEdge":5}
```

The oldest surviving storing-block sits **5 blocks** past `head - RETENTION_BLOCKS`, and the whole
populated span is 200,639 blocks against a retention period of 201,600.
`TransactionStorage::Transactions` is **pruned at the retention boundary**: a full scan enumerates
*currently-leased* objects, never everything ever stored. Between the two probes the count fell
4,002 → 3,991 while the head advanced 143 — expirations outpacing new stores, exactly as that
model predicts.

Three consequences:

1. **Bulletin history is unobtainable retroactively.** How long the window actually is depends on
   block time. My first pass here used a wall-clock estimate; that was wrong, and it has since been
   measured properly. Method: `chain_getBlockHash` at two heights, then `state_getStorageAt` on
   `Timestamp::Now` (`0xf0c365…dfcbb`) at each — on-chain timestamps, never our own clock.
   Products Devnet, 2026-08-19, anchor block 555,735:

   | Window (blocks) | s/block | 201,600 ≈ |
   |---:|---:|---:|
   | 100 | 8.580 | 20.0 d |
   | 1,000 | 7.962 | 18.6 d |
   | 5,000 | 7.512 | 17.5 d |
   | 50,000 | 7.202 | 16.8 d |
   | 100,000 | 6.992 | 16.3 d |
   | 150,000 | 6.828 | 15.9 d |
   | **201,600 (full retention window)** | **6.752** | **15.75 d** |

   Two things fall out, and both matter more than the headline number.

   **The 6.747 in `docs/platform/bulletin.md` is real.** I reproduced it independently at 6.752 over
   a full retention window, twice, from on-chain timestamps. It is not measurement noise and must
   not be discarded as such. The Products Devnet genuinely differs from Paseo Bulletin Next, which
   measures 6.077 over its own full window — same lineage, same method, same day.

   **My own ~5.87 is refuted, not merely imprecise.** Strike it. Recent blocks on this chain are
   running *slow* (8.58 s over the last 100), so the 143-block gap I eyeballed as "~14 minutes" was
   nearer 18. A wall-clock estimate did not just add noise, it pointed the wrong way — which is the
   general lesson: the rate is monotonic in window length here, so any short-window sample is
   measuring the current stall, not the chain.

   **The chain is progressively slowing, which explains the third figure in our own code.**
   `bulletin-chain.js:108` records 6.457 s over ~200,000 blocks — same chain, same class of window,
   4.5% off today's 6.752. That is not two disagreeing measurements, it is one trend. Measuring
   *disjoint* segments rather than cumulative-from-head windows (anchor 555,799):

   | Segment | s/block |
   |---|---:|
   | head−201,600 … head−175,000 | 6.683 |
   | head−175,000 … head−150,000 | 6.370 |
   | head−125,000 … head−100,000 | 6.433 |
   | head−100,000 … head−75,000 | 6.598 |
   | head−75,000 … head−50,000 | 6.970 |
   | head−25,000 … head−10,000 | 7.389 |
   | head−2,500 … head−500 | 7.629 |
   | head−500 … head | 7.764 |

   Monotonic: ~6.4–6.7 s/block in the older half, 7.4–7.8 s/block recently. A *trailing* average
   over 200k blocks therefore rises as slow blocks enter the window, which is exactly 6.457 → 6.752.
   Both readings were correct when taken; the earlier one is stale, not wrong. Treat any single
   rate as a trailing average with a timestamp, never as a property of the chain.

   **Planning floor: ~14 days, not 13.7.** Retention is denominated in blocks, so the hazard is the
   chain running *fast* and burning the window in less wall-clock. Nothing observed sustains faster
   than nominal: long-run 6.752 (15.75 d), nominal 6.030 (14.06 d), sibling chain 6.077 (14.18 d).
   The prudent floor is the nominal ~14.06 days, and today's chain is slower than that, not faster.
   Compared to Hydration — where deep history is merely *hard* to fetch (§2.3) — this is still a
   hard wall on a two-week timer.
2. **It is therefore the highest-urgency stream to start ingesting**, despite being the smallest.
   A daily snapshot of the decoded index (a few KB) accumulates the history the chain discards —
   and daily is ~14x inside the tightest plausible window. That margin is the robust part of this
   section: it holds under every rate measured, so the cadence does not depend on resolving the
   block-time question at all.
3. **`RETENTION_BLOCKS = 201_600` is now READ FROM THE CHAIN, not inferred — and it is not a
   constant.** `CLAUDE.md` flags it as "inherited, not verified here" and warns of a silently-wrong
   transcription. That is now resolved, and the resolution carries a surprise.

   `RetentionPeriod` **does not appear in the `TransactionStorage` constants at all.** The full
   constants list on the Products Devnet is `MaxBlockTransactions` 512, `MaxTransactionSize`
   2 MiB, `MaxPermanentStorageSize` 1 TiB, `AuthorizationPeriod` 201,600, `StoreRenewPriority`,
   `StoreRenewLongevity` 14,400, `RemoveExpiredAuthorizationPriority`. Searching the metadata blob
   for encoded 201,600 finds it exactly once, under `AuthorizationPeriod` — which is what makes
   the naming collision look alarming.

   It looks that way because we were looking in the wrong section. **`RetentionPeriod` is a
   *storage value*, not a constant**, so its value lives in state and never appears in metadata at
   all. Read directly:

   ```
   key   twox128("TransactionStorage") ++ twox128("RetentionPeriod")
         0x0e7b504e5df47062be129a8958a7a1278d69b77f53c8c31f3b84d472fdb7de2b
   raw   0x80130300   → u32 LE = 201,600
   ```

   (Key derivation self-tested: the same twox128 implementation reproduces the known
   `Timestamp::Now` key byte for byte.) So the constant is confirmed at 201,600, it agrees with the
   empirically observed pruning boundary to within 5 blocks, and the `AuthorizationPeriod`
   collision is real but benign here — the two genuinely both equal 201,600 on this chain while
   being different things in different places.

   **The operational consequence is the part that matters, and it cuts against hardcoding.** A
   constant changes only on a runtime upgrade. A storage value can be changed by governance at any
   time, with no upgrade and no version bump. `RETENTION_BLOCKS = 201_600` in
   `bulletin-chain.js:42` is therefore more fragile than "inherited" suggested: it is a snapshot of
   mutable state. It should be **read at runtime** from the key above and cached, with the literal
   kept only as a fallback. If retention is ever shortened by governance, a hardcoded 201,600
   silently overstates every expiry countdown *and* overstates our ingest safety margin — the one
   number this whole section depends on.

   **And it is nearly free to do.** `bulletin-chain.js` already imports `twox128` from
   `src/core/codec/xxhash.js` (line 9), so reading the live value is a storage key and one
   `state_getStorage` call in a file that already has both — no new dependency, no new module,
   roughly three lines next to the constant it replaces.

   The anomalous "16" that both this sweep and the docs sweep hit when hand-decoding is explained:
   we were parsing a storage-entry structure with a constant-entry shape. It is a structural byte,
   not a value.

So Bulletin needs persistence for *history*, not for size: a daily rollup snapshot is a few KB,
and it is the only copy that will exist after fourteen days.

**One caveat on "everything is pruned": it is not.** `TransactionStorage` has a second, permanent
tier alongside the retention window, and it is in use. Read from state:

```
TransactionStorage::PermanentStorageUsed   0x8641340600000000 -> 104,087,942 bytes (~99.3 MiB)
MaxPermanentStorageSize (constant)                            1 TiB -> 0.0095% consumed
```

So ~99 MiB of Bulletin data is **not** on a fourteen-day timer and can be fetched retroactively.
The urgency argument above applies to the retention-window transaction storage — the bulk of it,
and the part our index enumerates — but not to permanently-stored objects. Worth knowing before
someone reads "unobtainable retroactively" as covering the whole chain.

Naming trap, since it cost the docs sweep a wrong reading: the storage item is
`PermanentStorageUsed`. There is no `MaxPermanentStorageUsed` — querying that name returns null,
which looks exactly like an unconsumed tier. And `MaxPermanentStorageSize` is a *constant* in
metadata, not state, so a storage read of it also returns null. Two different nulls, neither
meaning "empty".

**Dotlake daily series** — ~20 operations in `server/sources/dotlake.mjs`, all daily or monthly
aggregates. 20 series × 365 days × ~60 B ≈ **440 KB/year**.

**Per-account balance histories** — a few hundred accounts × several years of daily points:
300 × 1,825 × ~48 B ≈ **26 MB total**, and ~5 MB/year thereafter.

**The whole non-Hydration corpus is under 40 MB.** Design the store for Hydration; everything else
is rounding error.

### 2.5 What the current design costs, and why "no store" fails

Measured by running `server/sources/hydration.mjs`'s `swaps` operation directly at its default
`days: 3`:

```json
{"seconds":10.5,"payloadBytes":100173,"payloadKB":97.8,
 "meta":{"legCount":34341,"tradeCount":14743,"windowDays":3}}
```

So the cached value is **97.8 KB** — memory was never the problem. The problem is the 10.5 seconds
and the ~25 MB of upstream traffic behind it, and the fact that the window **cannot grow**:

| window | pages | upstream bytes | est. wall clock | works? |
|---|---|---|---|---|
| 3 days (today's default) | 39 | 25.0 MB | 10.5 s measured | yes |
| 7 days (the schema cap) | 91 | 58.4 MB | ~25–35 s | yes, slowly |
| 90 days | 1,170 | 750 MB | ~10 min best case | no — HTTP timeout, and windows that old start timing out |
| 365 days | 4,745 | 3.05 GB | hours | no — deep windows return statement timeouts |

**A longer in-memory TTL does not help.** It reduces how often we pay 10.5 s; it cannot make a
90-day question answerable, because the 90-day answer was never computable in one request. Every
question Tommi asked for v2 — a year of daily volume, an account's history across years, a
retention curve on Bulletin objects — is on the far side of that line. This is the measurement that
decides the whole thing.

---

## 3. Store candidates, measured

All benchmarks: Node v22.22.0 on this machine. Sizes on the *real* three-day corpus (34,275
distinct legs) so compression is not flattered by duplicated rows; row counts on a synthetic
4,578,925-row year built by replaying the real day 365 times (row *count* is honest, per-row
*compressibility* of the columnar formats would be flattered, so the columnar sizes below use the
three-day corpus).

### 3.1 Bytes per row — the honest table

| format | B/row (measured, 34,275 real legs) | 4.17 M legs/yr | 1.82 M trades/yr |
|---|---:|---:|---:|
| raw upstream NDJSON | 730.8 | **3.05 GB** | — |
| NDJSON + gzip -9 | 46.0 | 192 MB | — |
| NDJSON + brotli (default) | 28.5 | 119 MB | — |
| Parquet, snappy | 32.8 | 137 MB | — |
| Parquet, zstd | **22.6** | **94 MB** | — |
| DuckDB file | 61.5 (3 d) / 46.4 (365 d) | ~193–256 MB | — |
| SQLite `leg`, no index | 164.2 | 685 MB | — |
| SQLite `leg` + 3 indexes | 307.8 | **1.28 GB** | — |
| SQLite `trade`, naive (TEXT PK, 32-B account) | 202.0 | — | 368 MB |
| SQLite `trade`, **normalised** + 2 indexes | **76.0** | — | **138 MB** |
| SQLite `trade`, normalised, no index | 47.9 | — | 87 MB |
| SQLite daily rollups (origin + pair + account) | — | — | **2.85 MB/yr** |

The normalised trade schema that produced 76 B/row — integer rowid PK, account as a foreign key
into a 135-row dimension table, origin as a small integer, amounts as REAL, plus indexes on
`(ts)` and `(account_id, ts)`:

```sql
create table account (id integer primary key, addr blob unique not null, pallet text);
create table trade (
  id integer primary key,        -- rowid, monotonic
  ts integer not null,           -- unix seconds
  account_id integer not null,
  origin integer not null,       -- small enum id, open-ended (Xcm appeared today)
  hops integer not null,
  in_asset integer, in_amt real,
  out_asset integer, out_amt real,
  usd real                       -- null is not 0
);
```

Going from the naive shape to this one is a **2.7× size reduction** (202 → 76 B/row) for no loss
of fact. Going from raw legs to trades is another **4×**. Both matter more than the choice of
engine.

### 3.2 Query performance

Same aggregations the dashboards actually run, on a 4.58 M-row leg table with `cache_size = -8000`
(8 MB page cache — a deliberate small-VM setting):

| query | SQLite over 4.58 M legs | SQLite over 2.0 M lean trades | SQLite over daily rollups | DuckDB over Parquet |
|---|---:|---:|---:|---:|
| daily count by origin, **full year** | 1,620 ms | 543 ms | **0.70 ms** | **44.6 ms** |
| daily count by origin, 90 days | 595 ms | 128 ms | 0.71 ms | — |
| top 50 accounts, 30 days | 257 ms | 117 ms | 19.1 ms | 7.3 ms |
| asset-pair matrix, 7 days | 43 ms | — | 0.71 ms | 6.6 ms |
| one account, full history | 89 ms | **1.8 ms** | — | — |
| one day of legs (indexed range) | 20 ms | — | — | — |

DuckDB is **~32× faster** than SQLite on the full-year scan. It is also ~2,300× *slower* than
reading a precomputed rollup. **The rollup column is the one that decides the architecture:** if we
precompute daily aggregates at ingest time — which we must anyway, because that is the natural unit
of an incremental sync — the scan speed of the engine stops being the question.

### 3.3 The event loop is the real SQLite risk, not speed

`node:sqlite` is synchronous. Measured with a 5 ms interval timer watching for starvation:

```json
// .all() on the full-year aggregation
{"baselineJitterMs":11,"queryMs":1593,"worstEventLoopStallMs":1610,"rows":2195}

// the same aggregation via .iterate() with a setImmediate yield every 20,000 rows
{"streamedRows":4578925,"groups":2195,"seconds":5.2,"worstEventLoopStallMs":43}
```

A 1.6-second query is a **1.6-second stall for every other in-flight HTTP request**, including
`/healthz`. At `--interval=30s --timeout=3s --retries=3` the container health check survives that,
but a 5-second query would not. Two consequences, both non-negotiable:

- **The request path never runs an unbounded query.** It reads rollups, or an indexed range, or
  nothing. Anything that scans gets precomputed by the ingest worker.
- **Where a scan is unavoidable, use `.iterate()` and yield.** It costs 3× wall clock (5.2 s vs
  1.6 s) and buys a 37× reduction in worst-case stall (1,610 → 43 ms). `iterate()` exists in
  Node 22 (`StatementSync.prototype` = `iterate, all, get, run, columns, …`) and streams within
  memory: 4,578,925 rows streamed with peak RSS 104.8 MB under `--max-old-space-size=192`.

DuckDB does **not** have this problem — its Node API is promise-based and runs the query off-thread:

```json
{"rowsScanned":4578925,"groups":2195,"queryMs":51,"worstEventLoopStallMs":14}
```

That is a real point in DuckDB's favour, and it is worth naming honestly rather than burying.

### 3.4 Memory footprint

| configuration | RSS |
|---|---:|
| bare Node 22 process, idle | **47.0 MB** |
| the repo's own measurement of the assembled runtime tree (alpine) | 55 MB (`deployment.md`) |
| + `node:sqlite` open on a 1.4 GB file, `cache_size=-8000`, count over 4.58 M rows | 57.3 MB (**+10.3**) |
| + a `worker_threads` ingest worker writing continuously | 63.4 MB (**+17.1** for the worker) |
| + `@duckdb/node-api` loaded, `memory_limit=64MB`, trivial query | 67.3 MB (**+12.1** at rest) |
| DuckDB, `memory_limit=64MB`, full-year group-by | 73.3 MB peak |
| DuckDB, `memory_limit=128MB`, full-year group-by | 126.6 MB peak |
| **SQLite `CREATE INDEX`, 5 columns × 2 M rows, `temp_store=file`** | **93.6 MB peak**, 518 ms |
| **SQLite `CREATE INDEX`, same, `temp_store=memory`** | **171.0 MB peak**, 646 ms |

> **Do not set `temp_store = memory`.** It was 77 MB more expensive *and* slower. SQLite's sort
> arena is malloc, not V8 heap — neither `--max-old-space-size` nor a worker's `resourceLimits`
> caps it, so a big index build under `temp_store=memory` is exactly the OOM-kill-with-no-stack-
> trace the Dockerfile comment is trying to prevent. SQLite's unix temp directory search order is
> `sqlite3_temp_directory` → `SQLITE_TMPDIR` → `TMPDIR` → `/var/tmp` → `/usr/tmp` → `/tmp` → `.`
> (sqlite.org/tempfiles.html), and under `--read-only` none of those exist writable — so
> `SQLITE_TMPDIR` must be set to a directory on the data volume. This is an infra line item.

### 3.5 Dependency cost

| option | package | install | unpacked | native? | musl/alpine? |
|---|---|---|---|---|---|
| **`node:sqlite`** | — built in | none | 0 B | in Node | yes |
| better-sqlite3 | `better-sqlite3@13.0.3` | 0.6 s, no compiler | 27.3 MB | yes | **yes** — `prebuilds/linuxmusl-x64.node`, 2.4 MB, shipped in the npm tarball |
| DuckDB | `@duckdb/node-api@1.5.5-r.4` | 4 s, 4 packages | **73.7 MB** for `@duckdb/node-bindings-linux-x64-musl` | yes | yes, optional dep per platform |
| Parquet read (pure JS) | `hyparquet@1.28.2` | — | 263 KB, **zero deps** | no | n/a |
| Parquet write (pure JS) | `hyparquet-writer@0.16.6` | — | 218 KB, deps: hyparquet | no | n/a |
| Parquet zstd/snappy (pure JS) | `hyparquet-compressors@1.1.1` | — | 161 KB, deps: fzstd, hysnappy | no | n/a |

Notes worth having:

- `node:sqlite` in Node 22.22.0 bundles **SQLite 3.50.4**; better-sqlite3 13.0.3 bundles **3.53.4**.
- `node:sqlite` is **unflagged since v22.13.0** but still prints an `ExperimentalWarning` on Node 22.
  Suppress with `--disable-warning=ExperimentalWarning` (verified working on 22.22.0). Node's own
  docs now carry `Stability: 1.2 - Release candidate` — that RC status is recorded against v25.7.0,
  so on Node 22 the honest description is "unflagged, still experimental."
- better-sqlite3 shipping musl prebuilds *inside the tarball* (no `install` script, no node-gyp, no
  `prebuild-install` network fetch) is new and materially changes the old objection to it. It is a
  perfectly reasonable fallback if `node:sqlite`'s API moves under us.
- 73.7 MB of DuckDB binary in an image that currently contains **no `node_modules` at all** is the
  single largest change to this deployment's attack surface that any option here proposes.

### 3.6 Format durability

- **Parquet** is a frozen, externally-specified format. A file written today will be readable by
  anything, forever. This is why it is the right *archive* format even if it is not the query layer.
- **SQLite's** file format has a published, deliberately never-broken compatibility guarantee, and
  the file is readable by `sqlite3` on any laptop.
- **DuckDB's** storage format is backward compatible only since v0.10, and forward compatibility is
  explicitly *"provided on a best effort basis"* and *"may be (partially) broken on occasion"*
  (duckdb.org/docs/current/internals/storage.html). Storage versions run 1 → 68 across releases.
  Concretely: **if we ever roll the image back, a `.duckdb` file written by the newer version may
  not open.** For a store on a box with no DBA, that is a worse property than it first sounds.

### 3.7 Verdict per candidate

| candidate | keep? | why |
|---|---|---|
| **`node:sqlite`** | **yes — the store** | Zero dependencies, transactional, one file, cross-process WAL reads verified, `iterate()` streams, `VACUUM INTO` and an async `backup()` are built in. Fast enough once rollups exist. Its one sharp edge (event-loop blocking) is measurable and designed around. |
| better-sqlite3 | documented fallback | Same engine, newer SQLite, faster, musl prebuilds. Costs 27 MB and the "no runtime deps" property. Adopt only if `node:sqlite` breaks. |
| DuckDB | **no, for now** | Objectively better at the analytics: 32× faster scans, ~5× smaller files, non-blocking. Costs 74 MB of native binary, +12–60 MB RSS, and a forward-incompatible file format. It buys speed that a precomputed rollup already gives us for 0.7 ms. Revisit **only** if we take on a source that genuinely needs ad-hoc multi-hundred-million-row scans. |
| Parquet + query layer | **yes — as the archive and the export, not the query layer** | 22.6 B/row is the best density measured and the format outlives every engine here. But "query layer" means either DuckDB (see above) or hand-written JS aggregation over `hyparquet` — and hand-written aggregation is exactly the thing SQL already does correctly. |
| Plain JSON/NDJSON snapshots | **yes — as the cold archive** | 46 B/row gzipped, `node:zlib`, zero deps, trivially inspectable, and the only thing that lets us rebuild the derived tables without re-asking an archive that will not answer. Useless as a query path: no index, whole-file parse, 731 B/row raw. |
| No store, longer cache | **no** | Measured in §2.5. It cannot answer the questions. Not a matter of taste. |

---

## 4. The proposed store

One SQLite file, `/data/db/analytics.sqlite`, WAL, three tiers of retention.

```
┌─ tier 1 ─ raw archive ────────────────────────────────────────────────────────┐
│ /data/archive/hydration/legs/2026-08-19.ndjson.gz    46 B/leg   192 MB/yr      │
│ exactly what the upstream said, one line per event, never edited.             │
│ Rebuilds tiers 2 and 3 offline. Not queried.                                  │
└───────────────────────────────────────────────────────────────────────────────┘
┌─ tier 2 ─ facts ──────────────────────────────────────────────────────────────┐
│ trade      1.82 M rows/yr @ 76 B  = 138 MB/yr   kept forever                   │
│ leg          514 k rows    @ 308 B = 158 MB      rolling 45 days only          │
│ account/asset dimensions             < 1 MB      kept forever                  │
│ bulletin_object, balance_point, …    ~31 MB      kept forever                  │
└───────────────────────────────────────────────────────────────────────────────┘
┌─ tier 3 ─ rollups ────────────────────────────────────────────────────────────┐
│ daily_origin · daily_pair · daily_account · daily_asset                       │
│ 72 k rows/yr, 2.85 MB/yr, kept forever, written in the same transaction       │
│ as the facts. THIS is what the request path reads. 0.7 ms.                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

Why legs are kept at all, and only for 45 days: they are the only way to recompute the trade
grouping if we get it wrong, and hop-level questions ("how many hops does a router trade take")
need them. 45 days is one and a half billing-cycle's worth of "we noticed a bug" — beyond that the
tier-1 archive is the recourse, at the cost of a decompress.

### 4.1 Disk projection

| | year 1 | year 3 | year 5 |
|---|---:|---:|---:|
| `trade` (forever) | 138 MB | 415 MB | 692 MB |
| `leg` (rolling 45 d, constant) | 158 MB | 158 MB | 158 MB |
| rollups (forever) | 3 MB | 9 MB | 15 MB |
| NDJSON.gz archive (forever) | 192 MB | 576 MB | 960 MB |
| Bulletin + dotlake + balances | 32 MB | 42 MB | 52 MB |
| **live total** | **523 MB** | **1.20 GB** | **1.88 GB** |
| + WAL, freelist, `VACUUM INTO` copy, 7 nightly gz backups (36 MB each) | ×~2.2 | | |
| **provisioned need** | **1.15 GB** | **2.64 GB** | **4.13 GB** |

**10 GB covers roughly a decade at current rates, or year 5 with a second Hydration-sized source
added.** The nightly-backup figure is measured, not guessed: gzip of a 152 MB SQLite file took
1.7 s and produced 36.5 MB (ratio 0.24).

---

## 5. Ingest

### 5.1 Where it runs — separate process, separate container, or a worker thread?

This is the question with the largest memory consequence, so it was measured rather than argued.

| arrangement | incremental RSS | request-path impact | verified |
|---|---:|---|---|
| ingest in the HTTP process, inline | 0 | **1,610 ms stall** per big query | §3.3 |
| ingest in a `worker_threads` worker | **+17.1 MB** | worst stall **46 ms**, worst read 40.5 ms, 0 errors while the worker wrote 376,000 rows | yes |
| ingest as a second process (same or separate container) | **+~47 MB** (a whole Node runtime; 47.0 MB measured idle) | worst read **70 ms**, **0 errors** over 190 reads while the writer committed 496,000 rows | yes |

Cross-process WAL was tested end to end — a writer process inserting 496,000 rows in 2,000-row
transactions for 8 seconds while a *separate* process held a `readOnly: true` handle and polled:

```json
// reader (a separate process, readOnly handle, ran for 7 s)
{"reads":190,"errors":0,"worstReadMs":70.12,"rowsVisibleAtEnd":466000}
// writer (ran for 8 s)
{"writerInserted":496000}
```

Zero `SQLITE_BUSY`, zero errors. The 466,000 the reader last saw versus the 496,000 finally written
is the reader stopping a second before the writer did, not replication lag — committed rows were
visible immediately throughout. WAL does what it says. **So the separate-container design works** —
it is purely a question of whether ~30 MB extra is worth buying.

**Recommendation: a worker thread, in the existing container.** Reasons, in order:

1. **30 MB on a 256 MB budget is 12% of the container.** That is the whole argument.
2. One image, one deploy, one `SIGTERM` handler, one health endpoint. The existing deploy story
   (`docs/architecture/deployment.md`) survives unchanged apart from the volume.
3. The usual objection — "an ingest bug takes down the server" — is answerable and was tested. A
   worker created with `resourceLimits` is killed alone:

   ```js
   new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 } })
   ```
   ```
   worker error surfaced to parent: Error Worker terminated due to reaching memory limit: JS heap out of memory
   {"workerExitCode":1,"parentStillAlive":true,"parentRssMB":48.8}
   ```
   The parent gets an `error` event, stays up, and restarts the worker with backoff. **Note the
   limit of that containment:** it caps the worker's *V8 heap*. SQLite's own malloc arena (§3.4)
   is not covered, which is the second reason not to use `temp_store=memory`.

Take the separate container instead if, and only if, ingest grows to something that wants its own
CPU share and its own restart cadence — e.g. if we ever run smoldot, which
`docs/architecture/middleware.md` already flags as needing a memory conversation first.

### 5.2 The loop

```
every 15 min, in the worker:
  for each stream (hydration.legs, bulletin.index, dotlake.<series>, …):
    if now < stream.next_attempt_at: skip
    cursor  = SELECT cursor FROM sync WHERE stream = ?
    window  = [cursor.height, min(cursor.height + 14400, head)]      -- never wider than a day
    for each page (keyset on id, limit 1000):
        fetch through server/lib/upstream.mjs        -- unchanged: one place calls out
        BEGIN
          INSERT OR IGNORE the rows
          UPSERT the affected daily rollup buckets
          UPDATE sync SET cursor = <last id of this page>, last_ok_at = now
        COMMIT
        append the raw page to /data/archive/<stream>/<day>.ndjson.gz
        sleep(politeness_gap)
```

**Resume after restart is free and needs no extra machinery.** The cursor is written *in the same
transaction as the rows it describes*. There is no state in which rows exist and the cursor does
not, or vice versa. A `SIGTERM` mid-page loses at most one page (≤1,000 legs, ≤733 KB) and the next
run refetches it; `INSERT OR IGNORE` on the event id makes the refetch idempotent. This is the
single strongest reason to use a transactional store rather than files: **a file-based ingest has
to invent crash-consistency, and will get it wrong.**

### 5.3 Politeness

There is no rate-limit header to obey (§2.3), so the budget is ours to set and ours to honour.

| rule | value | why |
|---|---|---|
| one in-flight request per upstream host | 1 | We are one client. Concurrency here is only ever taking capacity from the Hydration UI's own users. |
| minimum gap between requests | 1,000 ms | Recent pages answer in 695–1,500 ms, so a 1 s gap roughly halves our rate against the head with no practical cost. |
| window width | ≤ 14,400 blocks (1 day) | 30-day and 365-day windows are measured hard timeouts. |
| daily request budget per source | 2,000 | A runaway loop is capped at ~4× a normal day's ingest instead of unbounded. |
| backoff on `transport` error | 2× from 30 s, cap 1 h | The Bulletin devnet "does go down… unreachable is an ordinary state" (`CLAUDE.md`). |
| backoff on statement timeout | treat as backpressure, not error | Measured: the same query alternates success and timeout. Retry twice, then park the window. |
| per-window attempt budget (backfill) | 3, then mark `gave_up` | Otherwise the backfill walker wedges on the pre-`Swapped3` void forever (§2.3). |

**Incremental ingest is dramatically *less* upstream load than what we do today** — this is the
part worth putting in front of anyone who worries that a sync job is rude:

| | requests/day | upstream bytes/day |
|---|---:|---:|
| today, `hydration/swaps` refreshed at its 15-min TTL, if the page is hit once per window | 96 × ~42 = **4,032** | 96 × 25.0 MB = **2.40 GB** |
| proposed: 15-min tail-follow (≈150 blocks ≈ 119 legs ≈ 1 page + head query) | 96 × 2 = **192** | **8.4 MB** |
| ratio | **21× fewer** | **286× less** |

And the proposed version accumulates a year of history while doing it.

**Backfill is a separate, slower, best-effort walker.** 365 days × 13 pages = **4,745 requests and
3.05 GB**. At the 1 s gap that is ~2.6 hours *if every request succeeded* — and §2.3 says they will
not. Realistic plan: run the backfill walker at ≤1 request per 2 s during off-peak, expect the last
~30 days to land in minutes, expect anything below roughly height 8.4 M to be partial or
unobtainable, and **say so on the page** (rule 3). Spread it over a week; there is no deadline.

### 5.4 Never blocking the request path

- The HTTP thread opens the database `readOnly: true` and never writes. This is enforceable by the
  same style of check `scripts/check.mjs` already does for absolute URLs.
- The HTTP thread only executes queries with a bounded plan: a rollup read, or an indexed range
  over `(ts)` / `(account_id, ts)`. Any query that would scan is a bug, and can be caught in CI by
  running `EXPLAIN QUERY PLAN` over the registered operations and failing on `SCAN`.
- `pragma busy_timeout` on the read handle (2,000 ms) — measured unnecessary under WAL, kept as a
  belt.
- `pragma cache_size = -16000` (16 MB) explicitly, on both handles. The default is 2 MB and the
  implicit default on some builds is a page count, not bytes; leaving it implicit is how a memory
  budget stops being a budget.
- **Do not set `mmap_size`.** Mapped database pages are file-backed and count toward the cgroup's
  RSS; on a 256 MB container that is an invisible way to be OOM-killed.
- The existing `TtlCache` stays, but **shrinks from 48 MB to ~16 MB**. Once answers are computed
  from local disk in single-digit milliseconds, a 48 MB response cache is buying nothing and
  costing a fifth of the container.

### 5.5 The empty-store problem

On the day this ships, the store has zero days of history, and it fills up at one day per day.
Under `CLAUDE.md` rule 3 that is a fact the page has to carry, not hide:

- Every series response carries `coverage: { from, to, days, complete: bool, gaps: [...] }`.
- A chart whose window exceeds coverage draws the covered part and says so. It does **not** draw a
  short line as though the rest were zero — "empty days are drawn, not dropped" applies to days we
  have, and days we never fetched are a third state that must not be confused with either.
- `/api/health` gains a `stores` block: per-stream `cursor`, `last_ok_at`, `rows`, `lagSeconds`.
  This is how "the sync died three days ago" becomes visible without anyone noticing a flat chart.

---

## 6. The ASK to infra

Written to be answerable. Every number has a derivation above.

### 6.1 Disk

> **We need one 10 GB zonal `pd-balanced` persistent disk, attached to the existing `e2-small`,
> mounted at `/srv/polkadot-analytics/data` on the host.**

| item | ask | justification |
|---|---|---|
| size | **10 GB** | Live data is 523 MB after year 1, 1.20 GB after year 3, 1.88 GB after year 5 (§4.1); ×2.2 for WAL, freelist, a `VACUUM INTO` copy and 7 nightly compressed backups. 10 GB is ~a decade of headroom, or year 5 with a second source of Hydration's size. |
| type | **pd-balanced, not pd-standard** | This is the part we will not concede. `pd-standard` is 0.75 read IOPS per GiB with **no baseline** — a 10 GB pd-standard gets **~7.5 read IOPS**, which makes random SQLite page reads unusable. `pd-balanced` has a **3,000 IOPS / 140 MiBps baseline regardless of disk size**. The price difference at 10 GB is $0.60/month. |
| cost | **$1.00/month** (us-central1, europe-west1) or **$1.20/month** (europe-west3) | $0.10/GiB-month, $0.12 in europe-west3. |
| alternative we will accept | a 10 GB directory on the existing boot disk | Cheaper and zero new resources, but the data then dies with the VM. If infra prefers this, we need to hear that VM recreation is a planned, announced event, not a routine one. |

### 6.2 Mount

```
docker run -d --name polkadot-analytics \
  --read-only \
  --memory 384m \
  --volume /srv/polkadot-analytics/data:/data:rw \
  --env SQLITE_TMPDIR=/data/tmp \
  --publish 127.0.0.1:8080:8080 \
  ghcr.io/cypherpunk-agency/polkadot-analytics@sha256:<digest>
```

| item | ask |
|---|---|
| container path | `/data` — **exactly one writable path**; `--read-only` stays on everything else, and CI keeps asserting it. |
| host path | `/srv/polkadot-analytics/data` (infra's convention wins; we only need it stable across redeploys). |
| ownership | `chown 1000:1000` — the container runs as the base image's `node` user (uid 1000). The image's own files stay root-owned and unwritable, deliberately; only `/data` is ours to write. |
| layout we create inside it | `/data/db` (SQLite + WAL), `/data/tmp` (**required** — under `--read-only` SQLite has no writable temp dir and a large `CREATE INDEX` or `ORDER BY` will fail; see §3.4), `/data/archive` (NDJSON.gz), `/data/backup` (nightly `VACUUM INTO` + gzip). |
| filesystem | ext4, default options. **No NFS, no network filesystem** — SQLite's locking is not safe over NFS. |
| what we will never do to it | write anywhere outside `/data`; run more than one writer; place the file on a tmpfs. |

### 6.3 Memory

> **Raise the container limit from 256 MB to 384 MB.**

The arithmetic, all from §3.4 and §5.1:

| line | MB |
|---|---:|
| Node 22 baseline (repo's own measurement of the assembled runtime tree) | 55 |
| SQLite page cache, `cache_size = -16000`, on each of two handles | 32 |
| ingest worker thread — **48** is its `resourceLimits` heap cap; **17.1** was measured at rest | 48 |
| response `TtlCache`, **reduced from 48 MB to 16 MB** | 16 |
| one in-flight upstream body (unchanged cap) | 24 |
| **steady-state worst case** | **~175** |
| transient peak during a `CREATE INDEX` on a multi-million-row table, `temp_store=file` — 93.6 MB total process RSS was measured against a 47 MB bare-Node floor | **+~45** |
| **peak** | **~220** |

We can technically live inside 256 MB — the arithmetic fits, with about 36 MB to spare. We are
asking for 384 MB because that margin is thin, and the two things that eat it (a backfill batch and
an index rebuild) are exactly the operations that run unattended at 3 a.m. **128 MB extra is 6.25%
of a 2 GB VM.**
`NODE_OPTIONS=--max-old-space-size` moves 192 → 288 in step, so an overrun still surfaces as a
readable JS heap error rather than a silent kernel kill.

If 384 MB is refused, the fallback is 256 MB with the ingest worker's batch size halved and index
rebuilds moved to a manual, announced operation. That is a worse system, not an impossible one.

### 6.4 Backup

> **We cannot back ourselves up, and we must not be given the ability to.**

This is the part of the ask that is a policy statement, not a resource request.
`docs/decisions/0003-no-secrets.md` and `CLAUDE.md` rule 1 mean this container has no credential
of any kind. Writing a backup to GCS requires one. **We are therefore asking infra to own the
off-box copy**, using the VM's own service account, outside our container.

What we will do, unprompted and with no credentials:

| we do | measured cost |
|---|---|
| nightly `VACUUM INTO /data/backup/analytics-YYYYMMDD.sqlite` | **0.4 s** for a 152 MB database |
| then gzip it and keep 7 | **1.7 s**, **36.5 MB** per copy (ratio 0.24), ~250 MB resident |
| an online `backup()` with progress callbacks if we ever need a hot copy without pausing writes | 0.3 s, 185 progress steps, non-blocking |
| expose `stores.lagSeconds` and `last_ok_at` per stream on `/api/health` | free |

What we need from infra, in preference order:

1. **A daily GCE snapshot of the data disk**, retained 14 days. This is the simplest thing that
   works and needs nothing from us. Standard snapshots are incremental and billed on actual
   compressed size (~$0.05/GiB-month regional); at ~1 GB used that is cents.
2. Or: **a host cron that copies `/srv/polkadot-analytics/data/backup/*.gz` to a GCS bucket**, run
   by the VM's service account. Our container writes the file; infra's cron moves it. The
   credential stays on infra's side of the line, which is the whole point.
3. Or: **nothing, and we accept the loss.** Say so explicitly if that is the answer — see below,
   because it changes what we tell readers about the site.

### 6.5 What changes in the disaster-recovery story

Infra should hear this plainly, because it is a genuine regression in a property they currently
enjoy:

**Today:** this container is stateless. `docker rm -f && docker run` is a complete recovery. The
image is pinned by digest, the cache is a `Map`, and losing the VM loses nothing but uptime.
`docs/architecture/deployment.md` says "the container needs: nothing," and means it.

**After this change:** the *service* is still recoverable that way — it starts, serves every page,
and degrades to "we have N days of history." But the *history* is not in the image, and the archive
we read it from **will not give it back**. §2.3 is the evidence: a one-day window at height
8,000,000 succeeded once and then returned `canceling statement due to statement timeout` on three
consecutive retries; windows further back never succeeded at all. A rebuild from upstream is not a
plan, it is a hope.

Concretely:

| | before | after |
|---|---|---|
| RTO for the **service** | minutes (pull image, run) | **unchanged** — minutes. The store starting empty is a designed, labelled state. |
| RPO for the **data** | n/a (no data) | **24 h** with a daily snapshot; **unbounded loss** with none. |
| "recreate the VM" | free | must re-attach the disk, or the history is gone. Please treat the disk as the durable thing and the VM as disposable — not the reverse. |
| `docker rm -f` | always safe | still safe; the volume is outside the container. **Do not** pass `-v`. |
| rollback to an older image | always safe | safe with SQLite (stable file format). Would **not** be safe with DuckDB — a reason we are not proposing it. |
| what a total loss costs | nothing | every day of history we have not been able to re-fetch. Growing daily from the moment ingest starts. |

The honest summary for infra: **you are being asked to keep 10 GB alive, not to keep a service
alive.** If a snapshot is genuinely not available, we will still ship — and we will put a line in
the site's data notes saying the history is unbacked, because rule 3 applies to us as well as to
the chains we read.

---

## 7. Open questions for the other sweeps

- **netflows-data / main:** how far back does anyone actually need Hydration to go? If the answer
  is "since we turned it on," the backfill walker is optional and §2.3 stops being a problem.
- **deploy-plumbing:** the deploy command in `deploy.yml` gains `--volume` and `--memory 384m`.
  That command is the pinned privileged text infra supplies; this changes what we are asking them
  to pin.
- **docs-platform:** `CLAUDE.md`'s "verified live in runtime 435" operationStack list is missing
  `Xcm`, observed once today. Their reply makes the better point that the list's problem is its
  *provenance* — an observed-frequency list goes stale silently, and `docs/platform/hydration.md`
  already sources the variants from runtime metadata instead. Neither of us should edit `CLAUDE.md`
  on the other's say-so; it needs to go to Tommi.
- **docs-platform, resolved:** their Bulletin count discrepancy (4,019 → 4,002 → 3,991, a chain
  apparently counting down) is answered in §2.4 — the map is pruned at the retention boundary. They
  cannot reach port 8443 from their environment; the probe is in this file and repeatable.

---

## Unverified

Things stated above that were reasoned rather than measured, listed so nobody mistakes them for
measurements:

1. **Alpine/musl RSS.** All RSS figures were taken on Windows with Node 22.22.0. Linux RSS is
   normally lower; the repo's own alpine measurement of 55 MB vs 47 MB bare here suggests the
   deltas transfer but the absolutes should be re-measured in the real image before the memory ask
   is finalised. Docker was not available on this machine.
2. **`SQLITE_TMPDIR` being honoured by `node:sqlite` specifically.** The search order is quoted
   from sqlite.org and applies to the SQLite unix VFS, which `node:sqlite` embeds; it was not
   tested on Linux (Windows uses a different temp resolution).
3. **The Hydration archive's actual retention and the first block emitting `Broadcast.Swapped3`.**
   Heights 1.0 M, 5.0 M, 6.5 M, 6.9 M and 7.25 M all returned statement timeouts, which is
   consistent with "no rows there" but does not prove it. The floor is somewhere at or below
   8.0 M (2025-06-20), where one query did succeed.
4. **DuckDB file size per row at realistic scale.** 61.5 B/row on three real days and 46.4 B/row on
   a 365-day duplicated build; the true figure is between, and closer to the former.
5. **Whether the leg-per-trade ratio holds over a year.** 0.43659 comes from replaying one real day
   365 times, so it is one day's ratio, verified on 12,545 real legs, not a year's.
6. **GCE snapshot pricing** (~$0.05/GiB-month standard, ~$0.019 archive) came from a search summary
   rather than the pricing page itself, which did not render. Disk pricing and IOPS figures *were*
   read from Google's own pages.
7. **Cross-*container* WAL sharing.** Verified across two OS processes on one filesystem. Two
   containers bind-mounting the same host directory use the same mechanism, but that specific case
   was not run.
8. **`e2-small` disk-throughput ceiling.** GCE documents per-VM limits that scale with vCPU count;
   the page did not give an e2-small row. At our volumes (a few MB/day of writes) it cannot bind,
   but the number is not in hand.
