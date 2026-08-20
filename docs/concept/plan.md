# polkadot-analytics v2 — plan

**Date:** 2026-08-20. Written after six research sweeps, an adversarial verification pass and a
completeness critique; then revised against Tommi's decisions on Q1–Q9. Working notes in
`research/`. `docs/concept/` is deliberately **not published** to the website.

---

## 1. The research finding that reorganised everything

The storage sweep's central claim — *Hydration history is unobtainable, so we must persist now or
lose it* — **is false**, and was refuted the same day by an endpoint a sibling sweep had found.

| | `explorer.hydradx.cloud` (what we use) | SQD Portal `hydradx` | orca `routedTrades` |
|---|---|---|---|
| 1 day at block 8,000,000 | 7,160 ms once, then 3× 12 s timeout | **381 ms**, 1.57 MB | **276 ms**, 181 KB |
| coverage | tail only, ~3 days reliably | block 0 → 12,344,549 (**frozen since 2026-05-08**) | block 6,837,788 → head, **live** |
| granularity | raw legs | raw legs | **trades, already de-legged** |
| whole history | not servable | ~340 windows | 6,582,661 rows ≈ 1.2 GB / ~33 min |

`https://orca-prod-pool-01.orca.hydration.cloud/graphql` is Hydration's official liquidity-pools
squid: self-hosted, CORS-open, 242 query fields, live to the block. **It has already done the
`Broadcast.Swapped3` leg-grouping our code does by hand** (5,538 routed trades vs 12,647 legs in
24 h), and it indexes older event versions, so it reaches **730,000 blocks earlier** than the first
`Swapped3` — meaning our current page silently begins in mid-2025 and never said so.

Consequence: history is **re-fetchable on demand**, which is what makes the demand-driven store in
§2 viable. Bulletin is the one genuine exception — it really is pruned at 201,600 blocks (~14
days) — and §2.4 records the decision to accept that loss.

---

## 2. The architecture, as decided

Not three tiers of infrastructure. **Three fetch modes**, chosen per operation.

```
                       ┌─────────────────────────────────────────────┐
  browser ──/api/──────│  A. SERVER, PERSISTED FOREVER  (immutable)  │──→ upstream (once, ever)
                       │  B. SERVER, TTL CACHE          (mutable)    │──→ upstream (per TTL)
                       └─────────────────────────────────────────────┘
  browser ──────────────── C. CLIENT-DIRECT, NEVER STORED ───────────────→ upstream (per view)
```

### 2.1 Mode A — server, persisted forever (the store)

**Decided (Q1):** we build a persistent store, and it is **demand-driven, not a pipeline**.
Anything immutable that has been fetched once is never fetched again. Nothing is pre-fetched on a
schedule. The store fills as the site is used.

What the sweeps got wrong was not that there is machinery — there is — but *what decides to run it*.
There is **no schedule that fetches ahead of demand**. Everything else they designed (a worker, a
job queue, resumable cursors, attempt budgets, politeness gaps) is still required, because a single
demand-driven fetch can be a 33-minute job. See §2.5.

**The load-bearing new concept is an immutability predicate.** Every operation must declare, for a
given set of parameters, whether the answer can still change:

| kind | example | immutable when |
|---|---|---|
| block-range query | Hydration trades in blocks [a, b) | `b <= finalizedHead - k` |
| closed calendar day | XCM messages on 2026-08-18 | the UTC day has ended *and* the source has settled |
| point-in-time state read | balance at block N | always, on an archive node |
| current state | Omnipool TVL now, money-market APY | **never** — mode B |

Getting this wrong in the permissive direction is the one way this design produces silently wrong
data forever: a window marked immutable too early freezes a partial answer permanently. So the
predicate is conservative by default, every stored row records the head it was computed against,
and there is an explicit re-derive path (§5.3).

**Eviction is deferred, deliberately.** Persist everything until storage pressure is real, then
invalidate oldest-first. Recording the decision now so it is not rediscovered as a bug later.

**Cold-start latency is the cost of demand-driven, and it is user-facing.** The first visitor to
ask for a year of Hydration pays the full fetch. Mitigations, in order: make each *day* its own
store entry so the work is chunkable and parallel; stream partial results with a coverage bar
rather than a bare spinner; let a completed request finish filling in the background even if the
reader leaves. This is the same defect as today's 7-day Hydration hang and it must not survive
into v2.

### 2.5 The job system — the piece that makes mode A possible

Demand-driven does **not** mean synchronous. A reader asking for a year of Hydration is asking for
something that takes ~33 minutes; that cannot happen inside an HTTP request, and it must survive a
restart, a redeploy, and the reader closing the tab.

So there is a worker, and there is a persisted job queue. What there is *not* is a scheduler
deciding what to fetch ahead of demand — **jobs are created by demand, not by a clock.**

```
request ──→ store hit?  ──yes──→ answer now
              │
              no
              ↓
        find-or-create job ──→ answer with { partial data, coverage, jobId }
              │
              ↓
        [ persisted job queue ]  ←──────── tier-3 / CLI can enqueue the same jobs
              │
              ↓
        worker: resumable, polite, attempt-budgeted ──→ upstream ──→ store
```

**Job model.** `(source, operation, params)` → a row with state `queued | running | partial | done |
failed | gave-up`, a resumable cursor, progress counters, an attempt budget and a `next_attempt_at`.
Cursor and fetched rows commit in the same transaction, so there is no state where rows exist and
the cursor does not.

Properties that are not optional:

- **Find-or-create, not create.** Ten readers asking for the same window produce one job. This is
  the single-flight property of the existing `TtlCache`, made durable.
- **Resumable.** A SIGTERM mid-page loses at most one page; idempotent inserts on the upstream's
  own id make the refetch free.
- **Cancellable, with progress.** This is exactly subtrope's job/progress/cancel model, which the
  polkalytics sweep identified as the thing worth stealing from it. Its data layer is dead
  (Subscan is key-only now); its job model is the part that was always the valuable half.
- **Attempt-budgeted, with a persisted gave-up marker.** A timeout is indistinguishable from "no
  rows here", so a walker that retries on error grinds against an empty range forever at 12 s an
  attempt. Three tries, then record the surrender.
- **Polite by construction.** One in-flight request per upstream host, globally, regardless of how
  many jobs want it.

**Where it runs.** A `worker_threads` worker in the same process (+17 MB measured, vs ~47 MB for a
second process), with the HTTP thread holding a read-only handle to the store. A separate container
stays available if we ever want ingest to fail independently of serving.

**A thin cron is permitted, and stays thin.** A handful of streams are worth keeping warm without
anyone asking — head-following for the pages we know get looked at. That is a small allowlist of
recurring jobs enqueued on a timer, not a pipeline: it uses the same queue, the same worker and the
same idempotency as a demand-driven job. If that list ever grows past a few entries, it has become
the pipeline we decided not to build, and that is the signal to stop and re-decide.

**This is the tier-3 bridge, and it is why local and production run the same code.** A long
research job — backfill a year, sweep every Asset Hub holder, walk an account graph to depth 4 — is
the same job row, the same worker, the same store. Locally it is a CLI entry point against a local
store file; in production it is the worker. The heavy work simply does not run on the small VM,
which is what makes the VM stop being the constraint that shapes everything.

### 2.2 Mode B — server, TTL cache (unchanged from v1)

Current state: TVL now, reserve APYs, health factors, head block, peg deviations. These are never
immutable, so they keep today's `TtlCache`. No change.

### 2.3 Mode C — client-direct, never stored

**Decided (Q4/Q9):** Bulletin object contents are fetched **by the browser, directly from the
Bulletin RPC**, and never touch our server or our store.

Three reasons this is right, and one cost:

- Bulletin has a large volume of content flowing through it on a ~14-day timer. Persisting it means
  storing bytes we will never be asked for twice.
- It **dissolves the stored-XSS problem** (§4.1): bytes that never transit our origin cannot execute
  with our origin's privileges.
- It removes us as a redistribution point for whatever a stranger uploaded to a devnet.

**The cost is a CSP exception, and it is the first one this project has taken.** `connect-src
'self'` forbids exactly this. We need `connect-src 'self' https://bulletin-paseo.tservices.es:8443`
on our vhost. That is a deliberate, documented, single-origin exception — not a loosening of the
policy — and it needs infra. It should be argued out in `docs/decisions/0007`.

Even client-side, **rendering is structure-first**: decode "this is JSON / a UnixFS directory / N
chunks", verify length against the index's `size` field, and never inject fetched bytes as HTML.
Client-direct removes the same-origin escalation; it does not license rendering hostile content.

### 2.4 What we deliberately do not persist

**Bulletin.** Decided: it is a *live view of what is flowing through*, not an archive. We accept
that history older than the retention window is lost and unrecoverable. The page must say so
plainly — a reader who assumes `/bulletin/` shows everything ever stored is being misled, and the
index legitimately counts *down*.

---

## 3. Answers to Q1–Q9, recorded

| Q | Decision |
|---|---|
| **Q1** store | **Yes** — persistent, demand-driven, fetch-immutable-once. Persist everything; evict later under pressure. |
| **Q2** people | Not a priority now. Taking the cheap safe default: structural labels only (`para`/`sibl`/`modl`/treasury), identity resolved live and never written into a row. Costs nothing, reversible, keeps the store pseudonymous. Revisit if a page needs more. |
| **Q3** arbs | **Publish everything.** Concern raised and overruled by the owner: no real alpha, half a day's work. Proceeding. |
| **Q4** Bulletin files | **Client-direct**, structure-first, never stored. Requires the CSP exception in §2.3. |
| **Q5** follow | **Transaction-graph expansion**, subtrope-style: click an account, expand its transfers in and out, keep walking. Not a watchlist. See §3.1. |
| **Q6** research | Store the code so it is reproducible; **publish artifacts**. The `netflows.json` pattern, generalised. |
| **Q7** CSP | **Tighten production to match the documents** — with §2.3's single named exception. |
| **Q8** how far back | **Obsolete.** Demand-driven: whatever is requested is fetched and kept. |
| **Q9** Bulletin capture | **Do not persist.** Live view only; history loss accepted. |

### 3.1 What "follow the money" actually means

Clicking an account expands its transfers in and out; from there you keep walking. This is a
**graph expansion over transfers**, and it fits mode A perfectly: an account's historical transfers
are immutable, so the first expansion pays the fetch and every subsequent visit is instant.

It also changes what the store's first table is. Not "Hydration trades" — **transfers, keyed by
account**, with the expansion depth driven by the reader rather than by a schema.

Note the one hard boundary: client-*triggered* server ingest is a DoS amplification path. An
expansion must map to a bounded, cacheable server operation, never to "go and index this account."

---

## 4. Sequencing

Waves A and B need no decisions and no store. Wave C is the store. They overlap.

### Wave A — unblock (hours)

| # | Item |
|---|---|
| A1 | **The site returns 502** on `/`, `/api`, `/healthz`. Six sweeps ran a full day and nobody owned it. |
| A2 | Verify `docs/concept/` stays excluded from `/knowledge/`. |

### Wave B — parallel, no state, no decisions

| # | Item | Note |
|---|---|---|
| **B1** | **Repoint Hydration at `orca.routedTrades`** | Highest value in the plan. Correct by construction, ~80× cheaper, **removes the 7-day window cap immediately**. |
| B2 | Money-market board (23 reserves, APY, utilisation, LTV, e-mode) | 121 `eth_call`s in **5 requests / 39 KiB / 1.31 s**. Aave v3 in EVM contracts, not a pallet. |
| B3 | HOLLAR: real supply, facilitators, peg, HSM band | Fixes a live error — see §5.1. |
| B4 | Liquidations, Omnipool TVL history, protocol revenue | Pre-computed by orca. |
| B5 | **HyperFX order table + address drill-down** | 754 orders *ever*; entire history in **one 1.37 s request**, server-side address filtering. No state. |
| B6 | **XCM value from row-level records** + sanity ceiling | Rows carry `asset_symbol`, `asset_decimals`, `raw_amount`; missing USD is `null`, not 0. |
| B7 | XCM flow graph — **origin × destination matrix first** | 26 nodes / 107 edges. Cyclic, so Sankey is wrong. Chord second. |
| B8 | Loading-state UX | A 40 s fetch behind a bare spinner is indistinguishable from a hang. |
| B9 | `RETENTION_BLOCKS` read at runtime; "currently-leased" framing | ~3 lines. It is governance-mutable **storage**, not a constant. |
| B10 | **Liveness assertion per source** | "Is the head advancing?" — one request. Would have caught SQD frozen 103 days *before* we built on it. |
| B11 | Wrapper-graph / topology + asset registry + EVM resolver | Shared enabler for B2–B4. |
| B12 | **arbs-r-us screens** | Unblocked by Q3. State layer first; it shares B11's snapshot. |

### Wave C — the store

| # | Item | Depends on |
|---|---|---|
| C1 | **Store primitive**: persistent memo keyed by `(source, operation, params)`, with per-operation immutability predicate, head-stamping, and a re-derive path | — |
| C2 | **Job queue + worker** (§2.5): find-or-create, resumable, cancellable, attempt-budgeted, polite | C1 |
| C3 | **CLI job runner** — same jobs, local store, no server. The tier-3 bridge. | C2 |
| C4 | Coverage/progress plumbed through `/api` into every chart — partial data with a coverage bar, never a spinner | C2, B8 |
| C5 | **Transfer graph + account expansion** ("follow the money") | C1–C4 |
| C6 | Netflows v2 — live sovereign balances, relay `para` **+** Asset Hub `sibl` | C5 — **but see §7.4: the "today" number needs none of Wave C** |
| C7 | Hydration/XCM history as requested | C4 |
| C8 | Top holders on Asset Hub | C2 |
| C9 | Thin warm-keeping cron for a named handful of streams | C2 |

**C1–C4 are the expensive thing.** Everything after them is cheap. This is the "one expensive
thing plus forty cheap things" the critic warned was uncosted — said out loud, before we pick the
first three.

### Wave D — client-direct

| # | Item | Depends on |
|---|---|---|
| D1 | CSP exception for the Bulletin endpoint; `docs/decisions/0007` | infra |
| D2 | Bulletin object browsing via `bitswap_v1_get`, structure-first | D1 |

### Infra track — start now, blocks nothing

The 502; tightening the production CSP (Q7); the **one** `connect-src` exception (§2.3); and a
disk. The disk ask is now much smaller than the sweep's 10 GB — demand-driven storage of trades and
rollups, no raw-leg archive, no Bulletin — but it is no longer zero, so the conversation is still
needed. Size it after C1 exists and we can measure real fill rates.

---

## 5. What research showed we are shipping wrong

| Finding | Where |
|---|---|
| HOLLAR supply reported as 20,631; actual **11,489,093.53**. `Tokens::TotalIssuance` is meaningless for `Erc20` assets. | `/hydration/` |
| A naive `Tokens::Accounts` Omnipool sweep **silently drops HDX and every `Erc20` asset** (5 of 19, including the two largest) — understates TVL by ~half. | any TVL work |
| Dotlake `total_value_usd` over two years sums to **$39,917,060,621,977,640** — rows where an 18-decimal amount is labelled `asset_decimals: 6`. The exact 10¹² bug we already document for HyperFX. `CLAUDE.md` calls it "a floor"; it is actively wrong. | `CLAUDE.md`, `/xcm/` |
| Dotlake has a **7-day hole** (2026-07-09…07-15) and 10 of the last 53 days report $0 while carrying 500–1,350 messages. | `/xcm/` |
| Our Hydration page silently starts mid-2025 (first `Swapped3` ≈ block 7,567,547). | `/hydration/` |
| `RetentionPeriod` is **storage, not a constant** — governance-mutable, no version bump. | `bulletin-chain.js:42` |
| Block time is a **trailing average with a timestamp**, never a chain property. Hydration: 6.22 s / 1k blocks, 5.82 / 20k, 5.61 / 200k. Two sweeps quoted their own window as a constant. | everywhere |
| Subscan is **dead to us** — hard 403, key required. `subtrope`'s data layer is unimportable; take its **UI model** (job/progress/cancel, shareable comparison URLs) instead. | Q5 work |
| Asset Hub Migration completed **2025-11-04** (relay block 28,493,862). Relay: 243,526 DOT / 1,493 accounts. Asset Hub: 1,698,775,805 DOT / ~3.9M. **Re-running the 2023 netflows code today would draw ~300 DOT per parachain** and be plausibly, completely wrong. | `/netflows/` |
| A chain's sovereign holding is the **sum** of relay `para` + Asset Hub `sibl`. The original series only had the first. | `/netflows/` |
| `Liquidation.BorrowingContract` is **empty** (holds only `:__STORAGE_VERSION__:`) — one sweep marked "verified" advice to read it. Unsettled. | contradiction |

---

## 6. Risks that survive the decisions

**6.1 The immutability predicate is the new single point of silent failure.** v1's superpower was
that every number is a pure function of upstream — fix a decoder, everything is right within one
TTL. A permanent store breaks that, and a *demand-driven* store breaks it unevenly: whatever
someone happened to look at is frozen, the rest is not. Mitigation: stamp every row with the head
and the code version that produced it; keep a re-derive path; make it cheap by never storing
anything that cannot be re-fetched (§1).

**6.2 Upstream churn, at an alarming base rate.** In one day of research: one source died (Subscan
→ key-only), one relocated (orca — its own README's URL 404s), one was found frozen (SQD `hydradx`,
103 days, `real_time:false`), one serves impossible numbers (Dotlake). v1 has ~5 upstreams; this
plan implies ~15, and the ones carrying most weight are unofficial. B10 is the cheapest possible
insurance and should land before anything is built on a new source.

**6.3 Derived data rots and rule 3 cannot reach backwards.** The two best finds here — HOLLAR at
20,631 instead of 11.5M, and Dotlake's 10¹² inflation — are exactly the class of bug that becomes
invisible and permanent once written into eighteen months of rows.

**6.4 Cold-start is a product problem, and the job system is what makes it survivable.** Demand-driven
means the first reader triggers the work — but they must never *wait* for it. The request returns
what the store has plus a job handle; the page shows partial data with a coverage bar and fills in.
The failure to avoid is the one already shipping: a 40 s fetch behind a bare spinner, indistinguishable
from a hang. Every long operation is a job, and every job is observable.

**6.6 The cron is the thing to watch.** It starts as a handful of warm-keeping jobs and there is no
natural limit on it. If that list grows, we have rebuilt the scheduled pipeline we decided against —
and inherited its worst property, that a stream which stops fetching loses days silently while the
charts keep rendering. Cap it by convention, review it when it grows, and keep every cron job
identical to a demand job so nothing special exists to rot.

**6.5 Scope is uncosted.** Forty-plus candidates sized individually; the machinery every "S"
depends on is costed nowhere. The first three items pay for all of it — that is fine, provided it
is said out loud before picking them.

---

## 7. The cross-chain value track — decided 2026-08-20

Added after a four-agent research pass on bridges, bridged value, per-chain holdings and why
`/netflows/` is still frozen. **§§1–6 above are unchanged**; this section records decisions taken
after them and the facts those decisions rest on.

### 7.1 The decisions

| Decision | Call | Consequence |
|---|---|---|
| **Sequencing** | **Build all three workstreams at once** rather than picking one | E1–E4 below run in parallel; they share one module and one page family |
| **The Moonbeam boundary** | **Count Moonbeam-resident bridged assets, in a separate labelled band** — "on Moonbeam, not yet in XCM" | Needs a Moonbeam module doing `eth_call totalSupply()`. The xcUSDC-vs-`USDC.wh` distinction must be handled explicitly or it double-counts |
| **Network policy** | Widened — upstream Polkadot RPCs reachable | Every claim below marked *unverified* is now settleable, and must be settled rather than inherited |

The Moonbeam call is the one that moves the headline most. It was made explicitly, and the page
must show the band separately rather than folding it into one total — Moonbeam-resident value is
bridged onto a Polkadot parachain but has never entered XCM, and those are different facts.

### 7.2 What "value" means here — three quantities, not one

"TVL" is four different things and the acronym hides which. This track measures **value under
custody**: what each chain's ledger controls, counted once. Not DeFi-locked capital (that is a
recursive subset — Hydration's GIGA assets are money-market receipts for stableswap LP shares, so
"Omnipool + stableswap + money market" triple-counts), and not total issuance (which says nothing
about location). **The page does not use the word TVL.**

### 7.3 The mechanism, verified live 2026-08-20

**The core insight holds: you do not need a bridge's cooperation to see what it brought in.**
Asset Hub's `ForeignFungiblesTransactor` is a `FungiblesAdapter` with `NoChecking`, so the XCM
executor mints on inbound deposit and burns on outbound withdrawal. Therefore
`ForeignAssets::Asset(location).supply` **is** the quantity of that token currently represented on
Polkadot.

Read live off `polkadot-asset-hub-rpc.polkadot.io`, 2026-08-20:

- **`ForeignAssets::Asset` holds 52 keys: 34 bridged, 18 sibling-parachain.** The discriminator is
  exact, not heuristic — Asset Hub's filter includes `StartsWithExplicitGlobalConsensus`, so the
  runtime *refuses to create* a `parents:2` key naming Polkadot's own consensus. **`parents == 2`
  is bridged; `parents == 1, Parachain(N)` is not.**
- 33 of the 34 are Ethereum (`GlobalConsensus(Ethereum{chain_id:1})`), one is KSM over the
  Polkadot↔Kusama bridge.
- The `Blake2_128Concat` hasher appends the location **in plaintext**, so one `state_getKeysPaged`
  sweep yields every bridged asset's identity. No reverse map, no guessing. 3 RPC calls total.
- `AssetDetails` is 190 bytes; `supply` is a u128 LE at byte offset **128..144**.
- `Paras::ParaLifecycles` on the relay returns **89** para ids. Use it, not `Paras::Parachains`,
  which returns 3 under agile coretime.

**Ethereum USDC (`0xa0b86991…`) is in `ForeignAssets` while Circle's USDC is asset 1337 in
`Assets`.** Two USDCs on one chain, different ids, different provenance. Circle and Tether issue
1337/1984 directly — no wrapper, no bridge custodian — so **they are not bridged** and must sit
beside the bridged number with their own label, never inside the same bar. Never sum by symbol.

### 7.4 Double counting, and why it becomes the best chart rather than a footnote

A reserve transfer of WETH to Hydration burns from the user on Asset Hub and mints into
**Hydration's `sibl` sovereign account**. Supply is unchanged; Hydration's local mirror is a copy of
a balance already inside that supply. Adding them double-counts silently — the number stays
plausible and roughly doubles.

So rather than *excluding* the parachain view, read `ForeignAssets::Account(location, sibl(paraId))`
per chain. **The segments then sum to supply by construction**, and the no-double-counting property
is visible in the geometry instead of asserted in a footnote. Hydration's own issuance becomes a
*reconciliation*: a gap is in-flight XCM, an excess is unbacked mint.

⚠️ `sibl` is the account a parachain holds **on Asset Hub**; `para` is its account **on the relay**.
Sweeping `para`-prefixed accounts on Asset Hub returns ~20 DOT of existential deposits — a
factor-of-half-a-million error that renders perfectly. `src/core/topology.js` already derives both
with an import-time self-check; use it.

**And this is why the netflows "today" number needs none of Wave C.** Enumerate paras, derive both
sovereign legs, one `state_queryStorageAt` per chain: ~5 requests, cached at 10 minutes by the TTL
cache that already exists. No store, no job, no disk. C6's *history* still needs the store; its
*current* value does not.

### 7.5 Flows: net is exact, gross is inference

Daily `Issued − Burned` per asset is exactly the daily change in supply, and folding it from genesis
must equal the live `supply` to the last unit — **refuse to publish a window that does not
reconcile.** Gross in/out is inflated by every routing hop, because an ordinary reserve transfer
emits `Burned{user}` **and** `Issued{sibl}` — a matched pair, net zero. Splitting them requires
attributing each mint to its causing XCM message, which is inference and must be argued on the page
before it is drawn. Not in v1.

### 7.6 Which bridges the number must cover

Full inventory with evidence dates in `docs/platform/bridges.md`. In order of weight:
**Snowbridge** (light client both ways — the overwhelming majority); **Wormhole**, both paths (NTT
direct to Hydration, which has its own Wormhole chain ID 73, and MRL via Moonbeam, chain 16);
**Polkadot↔Kusama** (how Ethereum assets reach Kusama); **Chainflip** (a standalone L1, not a
parachain, whose DOT leg has moved to Asset Hub and whose relay vault its own SDK marks `legacy`);
then **Interlay iBTC**.

Two things this track will look wrong about unless stated: **Hyperbridge contributes ≈ nothing** to
value bridged *into* Polkadot — its live state machines are all EVM and 32 of 40 sampled orders were
same-chain on Base; it is Polkadot-hosted infrastructure selling verification elsewhere. And **CEX
flows dwarf every bridge here** — "value bridged in" is not "value that arrived", and the page says so.

### 7.7 Wave E — the work

| # | Item | Depends on |
|---|---|---|
| **E1** | **`server/sources/asset-hub.mjs`** — `bridged-inventory`, `bridged-holders`, `sovereign-dot`. ~30 requests per TTL, two hosts, no key, no store | — |
| E2 | **`/bridged/`** — the bridged-value page. Stacked bars per asset, segments = holding chain, summing to supply by construction; issuer-minted USDC/USDT in a separate labelled tile; Moonbeam band separate | E1 |
| E3 | **Netflows v2, current value only** — second series on `/netflows/`, turning the 2023 archive into a comparison rather than the whole page | E1 (`sovereign-dot`) |
| E4 | **`moonbeam.mjs` + `interlay.mjs`** — the separate band, and BTC-in. Interlay is one `state_getStorage`; Moonbeam is `eth_call totalSupply()` over `pallet_moonbeam_foreign_assets` | E1 |
| E5 | `docs/platform/bridges.md`, the trap entries in `CLAUDE.md`, and the `check.mjs` local-path gap | — |
| E6 | Call Dotlake's `defi-tvl` / `daily-usdc` / `daily-usdt` — **registered since v1 and never called by anything.** Cross-check column only, never the lead figure | — |

**E6 is ten minutes and nobody has ever done it.** Its outcome is useful either way: a cross-check
column, or a written-down "these do not answer the question" so the next person does not re-derive it.

### 7.8 Open, and blocking nothing

- **Para 2004 (Moonbeam) is not in `ParaLifecycles`'s 89 ids** — verified live, cause unknown.
  Moonbeam is on the *existing* netflows chart, so a live v2 built off today's para set would
  silently drop a chain the archive shows. Until it is understood, absent must render as
  **"missing, and here is why"**, never as zero.
- `ParaLifecycles` is current-state-only and does not contain the union of ever-registered ids,
  which a lifetime series needs. The plan does not say where that comes from.
- Whether Dotlake indexes the Snowbridge corridor with usable asset detail — unverified.
- Whether Hydration's `Signet` pallet is used at all — unverified. It is **not** a bridge (CAIP-2
  remote signing) and must not be reported as one, nor as unused.
