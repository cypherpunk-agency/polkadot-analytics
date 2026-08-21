# polkadot-analytics v2 — plan

**Date:** 2026-08-20. Written after six research sweeps, an adversarial verification pass and a
completeness critique; then revised against Tommi's decisions on Q1–Q9. Working notes in
`research/`. `docs/concept/` is deliberately **not published** to the website.

---

## 1. The research finding that reorganised everything

The storage sweep's central claim — *Hydration history is unobtainable, so we must persist now or
lose it* — **is false**, and was refuted the same day by an endpoint a sibling sweep had found.

| | `explorer.hydradx.cloud` (what we used until 2026-08-20) | SQD Portal `hydradx` | orca `routedTrades` (**what we read now**) |
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
| **B1** | **Repoint Hydration at `orca.routedTrades`** | Highest value in the plan. Correct by construction, ~80× cheaper. ~~Removes the 7-day window cap immediately~~ — **corrected 2026-08-20: the repoint shipped, but the cap was DOUBLED, not removed.** `hydration.mjs:419` sets `max: 14`, a deliberate cost decision argued at `hydration.mjs:411-418`. Removing it needs the store (C7). |
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
| Dotlake `total_value_usd` over two years sums to **$39,917,060,621,977,640** — rows where an 18-decimal amount is labelled `asset_decimals: 6`. The exact 10¹² bug we already document for HyperFX. ~~`CLAUDE.md` calls it "a floor"; it is actively wrong.~~ **Both fixed 2026-08-20:** CLAUDE.md and `data-sources.md` now say "neither a floor nor a ceiling", and `/xcm/` reads row-level records under three exclusion rules and names every excluded row on the page. | `CLAUDE.md`, `data-sources.md`, `/xcm/` |
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
  exact, not heuristic — but **the guarantee comes from `CreateOrigin`, not from
  `StartsWithExplicitGlobalConsensus`**, which is the matcher the XCM executor uses when
  *transacting* rather than the filter that governs *creation*. Source-verified 2026-08-20: the
  three permissionless creation origins are `FromSiblingParachain` (admits only `parents: 1` with a
  leading `Parachain`), `FromNetwork` (only `parents: 2`, via `ensure_is_remote`) and
  `KusamaAssetFromAssetHubKusama` (only `parents: 2, GlobalConsensus(Kusama)`). **`parents == 2` is
  bridged; `parents == 1, Parachain(N)` is not.** ⚠️ `ForceOrigin` (governance) is not bound by any
  of them, so check the invariant on read. Full derivation in
  [platform/asset-hub.md](../platform/asset-hub.md).
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

⚠️ **But "by construction" is doing real work in that sentence, and it hides something.** Verified
live 2026-08-20 by sweeping every holder of all 34 bridged assets: `Σ ForeignAssets::Account ==
supply` holds for 28 and **fails for 6** — USDT short 15.000000, USDC 11.15, TRAC 0.5, KSM 0.0911,
ETH 0.0152, one metadata-less ERC-20 by 4e18 raw. Always in the same direction, supply above the
accounts. The sweeps are provably complete (`AssetDetails.accounts` equals the key count for all
34), and bisection puts the whole USDT gap in a single block — #14,915,236, 2026-04-24 — where
supply rose 15.000000 while no holder balance and no account count changed. Supply can be minted
without any account being credited. So the residual `supply − Σ sovereign` must be shown SPLIT into
holders and unaccounted; folding the second into the first attributes tokens nobody holds to
"somebody on Asset Hub", which is the double-counting error wearing the geometry's badge. Detail
and the probe in [platform/asset-hub.md](../platform/asset-hub.md).

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
reconcile.** ⚠️ Before building that, settle whether the supply increases described in §7.4 — supply
rising with no account credited — emit an `Issued` event at all. If they do not, the fold cannot
reconcile and the rule above would refuse every window.

Gross in/out is inflated by every routing hop, because an ordinary reserve transfer
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
| E3 | **Netflows v2** — ~~current value only~~ ~~second series on `/netflows/`~~ **DONE, and it went further than this row asked.** Three moves on 2026-08-20: the live read shipped as a second series on `/netflows/`; it was split into its own page `/sovereign/` the same day, because eight blocks had accumulated above the archive's chart ([decision 0011](../decisions/0011-a-page-has-one-subject.md)); and then the 2023 → 2026 hole was filled from the chains themselves, so `/netflows/` draws a continuous daily series 2022-01 → yesterday and the 2023 archive became a cross-check against it ([decision 0012](../decisions/0012-netflows-is-a-store-plus-a-live-tail.md)). Both pages are `live: true`. ~~Kusama is still archive-only on both — research queue O26/O39~~ **Two further moves on 2026-08-21:** Kusama got the same series from one parameterised implementation, so `/netflows/` draws both networks from the chains and O39 is closed ([decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md), [kusama.md](../platform/kusama.md)); and `/sovereign/`'s then/now card and gap strip were **cut** once `/netflows/` covered the gap, because their reference point was the archive's single worst day ([decision 0016](../decisions/0016-a-comparison-inherits-its-worst-reading.md)). `/sovereign/` is still Polkadot-only — research queue O50 | E1 (`sovereign-dot`), then `netflows-daily` + `sovereign-dot-recent` |
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

---

## 8. Direction — recorded 2026-08-20

**Not commitments.** Recorded so the next session does not rediscover it, and so the snapshot work
in §7 is shaped now to survive it rather than be rewritten.

The destination is two shifts, and they are different problems: **from snapshots to flows**, and
**from chains to accounts**.

### 8.1 Netflows and bridged value are the same machine

`sovereign-dot` is the DOT special case of "what does chain X hold on Asset Hub". `bridged-holders`
is the all-assets version at one instant. **Snapshot that same decomposition daily and it is
per-chain, per-token netflows including bridged assets** — chain-to-chain value flow at token
granularity, not message counts, which is the thing `/xcm/` cannot give because Dotlake's
`total_value_usd` is unusable (§5).

Cost after a date→block index exists: ~2 requests and 22 KiB per day, forever.

**What that means for E1 today:** shape the payload as one row per `(chain, asset, date)` so the
store can eat it later without a rewrite. That is the whole preparation, and it is free now and
expensive later.

### 8.2 Accounts are a different transport, not a bigger version of the same one

State reads work for 89 sovereign accounts. They do not work for Asset Hub's ~3.9M: the measured
full `System::Account` sweep is ~1,746 MiB / 58–85 min over WebSocket, or ~11,800 requests / ~2 GB
over HTTP. **You cannot diff 3.9M balances daily.**

So for accounts, stop reading state and **fold transfer events** — SQD's stream from block 0, which
yields the graph edges directly instead of inferring them from balance deltas. That is C5, and it is
also what makes "the earliest transactions on the relay chain" tractable: the archive is verified
complete back to block 1 with a valid read proof, but block-by-block from genesis is the expensive
path and the event stream is not.

**This is what finally forces the deferred infra ask: a disk, and an outbound WebSocket.** Both have
been "size it later" since v1. Account-level flow is the thing that sizes them.

### 8.3 The address registry needs its evidence model before its first row

What this repo does today is **structural** labelling — `modl`, `sibl`, `para`, derived from the
bytes alone, no network call, no name attached to anyone (`src/core/topology.js`). What the
direction needs is two further kinds, and **they must never share a field**:

| Kind | Example | Can it be wrong? |
|---|---|---|
| **Structural** | `6d6f646c` → pallet account | No. It is arithmetic. |
| **Behavioural** | "fan-in/fan-out and volume consistent with an exchange" | It is a claim about observed behaviour, and it names nobody. |
| **Attributed** | "this is Binance" | Yes — and being wrong publishes a false claim about a real company. |

Pattern-matching high-transaction accounts produces the **behavioural** kind, which is defensible
on its own and does not require the third. Every attributed row carries provenance: what the
evidence was, when it was taken, and how confident. The page shows which kind it is showing.

Rule 3 says say what is wrong with the number. **A label is a claim with higher stakes than a
number**, and the registry's schema is where that gets enforced or lost.

**One line drawn now: tag entities, not individuals.** A high-volume exchange wallet is a public
fact. A personal address flagged by behaviour is deanonymisation, and this site is ungated,
anonymous and indexed by design — there is no "only for logged-in analysts" here to hide behind.

### 8.4 Traps to prepare for

- **Join on the public key, never the SS58 string.** The same account is a different string on every
  chain — Polkadot prefix 0, Hydration 63 — while the underlying 32 bytes are identical.
  `src/core/codec/ss58.js` already decodes it. Joining on the display string silently finds nothing,
  which renders as "this account never touched Hydration".
- **The relay is not where the history is, and it is not where the present is either.** Everything
  happened on the relay until the Asset Hub Migration on 2025-11-04, and almost nothing has since
  (243,526 DOT vs 1,698,775,805). Any account or flow series spanning that date is two different
  chains stitched together and must say so.
- **`modl` accounts dominate naive "top accounts" lists.** On a normal Hydration day two thirds of
  "trades" are the fee processor and DCA machinery; the same will be true of transfer graphs.
  `structuralLabel()` already classifies them with no network call — use it before ranking anything.

### 8.5 What this changes about §7

§7 concluded that the store buys history rather than breadth, and therefore that snapshot pages
should come before Wave C. **That conclusion is now reversed: history is the point.** The store is
back on the critical path — but the ordering insight survives, because §8.1 means the snapshot work
is the same machine, and shaping its payload correctly today is what makes the store cheap to add.

Build the snapshots. Shape them for the store. Then build the store.

---

## 9. Audited: what is actually built — 2026-08-20

A full pass over every item in §4 and §7.7, judging each against a strict definition: **SHIPPED**
means the code exists, is *wired up* (a source registered in `server/sources/index.mjs`; a page in
`src/sources/pages.js` with a real directory), and a user or API caller can reach it.

**Of 33 items: 14 SHIPPED, 9 PARTIAL, 10 NOT BUILT, 0 SUPERSEDED.**

### 9.1 The result that matters: Wave C is finished and unreachable

Wave B — the one this plan called "parallel, no state, no decisions" — is the success: 9 of 12
shipped. **Wave C is the failure, and not for the reason anyone would guess.** C1–C4 were built to
a high standard and then stranded:

| file | lines | consumers |
|---|---|---|
| `server/lib/store.mjs` | 328 | 0 |
| `server/lib/jobs.mjs` | 524 | 0 |
| `server/lib/job-worker.mjs` | 306 | 0 |
| `server/lib/demand.mjs` | 364 | 0 |
| `scripts/job.mjs` | 174 | runs; nothing to run |
| `server/test/{store,jobs}.test.mjs` | 585 | 43 tests, all pass |
| mode-A path in `server/index.mjs` | ~150 | dead branch |
| **total** | **~2,430** | **zero** |

Verified at runtime rather than inferred: 8 sources / 27 operations, **`jobs: NONE` on every one**;
`store.sqlite` holds `facts 0, jobs 0`; and an end-to-end CLI run returns
`gave-up: "Source `hydration` has no job `swaps`."` The attempt budget, the persisted gave-up
marker and the resumable lease all work correctly — against nothing.

**§2.5 costed the engine in detail and never named the per-source handler contract as a work
item.** The contract is documented at `server/sources/index.mjs:40-52`. It has no implementations.
That omission, not the queue, was the expensive thing.

### 9.2 The sequencing claim in §4 is contradicted; §8.5's revision is supported

§4 said "C1–C4 are the expensive thing. Everything after them is cheap." C1–C4 were built and
**nothing after them got cheaper**, because the cost was never the queue. Meanwhile **E1 shipped
1,626 lines in one commit with no store, no job and no disk** and produced the most substantive
payload on the site.

§8.5 — *build the snapshots, shape them for the store, then build the store* — is confirmed:
`sovereign-dot` and `bridged-holders` already emit one row per `(chain, asset)` with a block stamp,
which is §8.1's target shape. The preparation was free, as predicted.

**One correction to §8.5.** The store is not "back on the critical path" — it is **already sunk and
stranded**, held out of production by a deployment policy (`docs/architecture/deployment.md:65`:
"No volumes… and CI asserts that it does") that predates the decision to build it and that nobody
revisited. §4 deferred the disk conversation until "C1 exists and we can measure real fill rates."
C1 exists; the fill rate is zero because there is nowhere to put rows and nothing to write them.
**That conversation is overdue and is the single blocker in front of ~2,430 lines of finished work.**

### 9.3 The smallest step that unstrands it

**One `jobs.swaps-daily` handler on `hydration.mjs`**, unit = one closed UTC day. The immutability
predicate is trivial (a UTC day whose last block is below `head − k`), orca is already
cursor-paginated with a stable `Broadcast::IncrementalId` for idempotent inserts, and day-chunking
is exactly what §2.1 asked for.

That single handler closes **C1, C2, C3, C7 and Wave B's B1 unmet cap promise at once** — and converts the
disk ask from an abstract request into a measured number, which is what §4 said to wait for.

### 9.4 Orphans: 16 of 27 registered operations have no page

`/api` describes them, so they are public; nothing renders them. `dotlake` alone has 12, of which
**9 are not mentioned anywhere in this plan**: `daily-summary`, `daily-tps`,
`coretime-utilization`, `coretime-sale-metrics`, `contracts-deployed-heatmap`,
`contract-calls-heatmap`, `monthly-opengov-participation`, `monthly-treasury-balances`,
`monthly-percent-staked`. `arbs-bifrost` is a registered source no page calls — its data reaches
`/hydration-peg/` by a server-side import instead. Neither is a bug; both are undecided.

### 9.5 Built, and never planned

The nav grouping; `segmentedRows`; `docs/platform/moonbeam.md`; `docs/platform/bridges.md`; the
`research-and-build` skill and `docs/concept/research-queue.md`. That last pair is currently the
most accurate description of what is actually blocked — more so than this file was before today.

### 9.6 What to pick up next, in order

| # | Item | Why it is next | Effort |
|---|---|---|---|
| 1 | ~~**E3 — netflows live**~~ **SHIPPED 2026-08-20 as `/sovereign/`** | Page code only, as predicted: `sovereign-dot` needed no change. What was not predicted is that it did not belong on `/netflows/` — decision 0011 | done |
| 2 | **Liveness on the 5 sources and 7 pages missing it** | The site's premise is saying what is wrong with a number, and staleness is the commonest thing wrong. Two chains were caught today answering RPC while 10 and 24 days behind | 2–4 h |
| 3 | ~~**`jobs.swaps` on `hydration.mjs`**~~ **SHIPPED 2026-08-20 as `jobs.swaps-daily`** | §9.3 — unstranded ~2,430 lines and produced the disk number. See §12 | done |
| 4 | **`interlay.mjs`** | One `state_getStorage`. Unblocked: the canary band is settled (reject thousands of BTC; actual issuance 2.118) | hours |
| 5 | **The disk conversation** | §9.2. Blocks nothing else, blocks everything after | decision |
| 6 | **E4 `moonbeam.mjs`** | ~~Blocked on research-queue **B5** — whether a deregistered chain gets a band at all~~ **The shape was decided in §11.4** the same day: a dated "stranded value" row frozen at 2026-08-10T11:36:12Z. What is left is the *number*, which is research-queue **B2**'s `eth_call` machinery over `EvmForeignAssets` | research (B2), not a decision |

---

## 10. Anomalies as a product, not just a check — direction, 2026-08-20

The reconciliation machinery already produces an anomaly feed; it is simply framed as a caveat.
`bridged-holders` returns `reconciliation: { assets: 34, exact: 28, mismatched: [...] }`. Turning
that around — from "here is a caveat about our number" to "here is something odd about the chain" —
costs almost nothing and is a genuinely different product.

**The investigative loop is already proven, manually.** Faced with "USDT is short by 15.000000", the
procedure that worked was: sample the residual back through history → observe it moves in **steps,
not dust** → bisect to a single block (#14,915,236) → confirm every holder balance and the account
count were unchanged → identify the only candidate extrinsic (`set_validation_data`, inbound XCM).
Detect → sample → step-or-drift → bisect → name the extrinsic. That is systematisable as a standing
research agent rather than a one-off.

Two things to get right before building it:

- **An anomaly needs a baseline, and baselines need history.** "Large change" and "unusual volume"
  are meaningless against a single snapshot — same store dependency as everything in §8. The
  reconciliation residuals are the exception, because they are anomalous against an **invariant**
  rather than a trend, which is exactly why they work today with no history at all. **Start there.**
- **"Exploit" is a claim, not an observation** — the same line §8.3 draws for the address registry.
  The defensible output is *"supply rose with no account credited, at this block, in this
  extrinsic"*. Naming it an exploit is a different kind of statement with different stakes, and it
  belongs to a human.

Invariants already available to watch, with no new machinery: `Σ ForeignAssets::Account` vs
`supply`; a parachain's sovereign balance on Asset Hub vs its local mirror's issuance; `Σ` sovereign
holdings vs total issuance; and a chain's `Timestamp::Now` against the wall clock — which today
would have caught Moonbeam, Interlay, and Equilibrium's thirteen-month absence.

---

## 11. Session record — 2026-08-20

§9 audited the plan and is already out of date, because most of §9.6's list shipped the same day.
This is what changed, what it cost, and what it taught. Written before a context compaction, so
the next session starts from fact rather than from summary.

### 11.1 Shipped

| | |
|---|---|
| **`server/sources/asset-hub.mjs`** | The first module here that reads Polkadot's own chains. `bridged-inventory`, `bridged-holders`, `sovereign-dot`. Every read pinned to one finalized head. |
| **`server/sources/interlay.mjs`** | BTC bridged in. One storage read, a three-layer canary, and a liveness assertion that catches the chain being 24 days stale. |
| **`/bridged/`** | 34 bridged assets, 37 holdings across 8 parachains, issuer-minted USDC/USDt kept separate, reconciliation shown as a finding. |
| **`/netflows/` and `/sovereign/`** | The 2023 archive gained a live half, and the live half then gained its own page, so `/netflows/` opens on the time series it is named for. Decision 0011. ~~The three-year gap is drawn to scale on `/sovereign/`, never crossed by a line.~~ **Superseded within a day:** decision 0012 filled the gap from the chains, and on 2026-08-21 decision 0016 cut the gap strip and the then/now card from `/sovereign/` because there is no gap left to draw and their reference day was the archive's worst. |
| **`segmentedRows`** | A seventh chart form. Segments must sum to a separately-stated total; the shortfall is drawn. |
| **Liveness** | 3 sources → 5; `/bulletin/`, `/hydration/`, `/hyperfx/` now render or deliberately abstain. |
| **Nav grouping** | Four Hydration pages under one entry. Top level 9 → 6. |
| **Knowledge** | `docs/platform/bridges.md`, `docs/platform/moonbeam.md`, and substantial additions to `asset-hub.md`, `hydration.md`, `data-sources.md`. |
| **Process** | The `research-and-build` skill, `docs/concept/research-queue.md`, and three working agreements in CLAUDE.md. |

### 11.2 Found — the things that would have shipped as wrong numbers

- **Moonbeam was deregistered on 2026-08-10**, by `Registrar.deregister(2004)` at relay block
  32,489,786, signed by its own manager, deposit refunded to the last decimal. **Three more had
  left unnoticed**: Moonriver, Parallel, and **Equilibrium — thirteen months ago.** This site had
  been listing all of them as ordinary chains.
- **`Σ ForeignAssets::Account ≠ supply`** on 6 of 34 assets. Not a read error: bisected to a single
  block where supply rose 15.000000 USDT while every holder balance and the account count stayed
  put. **Supply can be minted with no account credited.**
- **Two chains answer RPC normally while frozen** — Moonbeam 10 days, Interlay 24. `system_health`
  reports `isSyncing: false` on a dead chain. Picasso on Kusama has been dead **310 days** and
  strands 4,431 KSM + $15,396 behind a chain that cannot send an XCM to move it.
- **Dotlake's `daily-usdc`/`daily-usdt` silently truncate at 1000 rows**, returning the *oldest*
  ones, with HTTP 200 and no envelope. Its chain keys **disagree between its own endpoints**
  (`hydradx` vs `hydration`), so joining on `chain` drops the two largest rows and looks complete.
  `defi-tvl` carries the `0.0`-means-unknown disease — 54 of 446 rows in 90 days.
- **`ParaLifecycles` reads `Parathread` for 86 of 89 paras, Asset Hub included.** It is a
  registration state, not a description. Printed unqualified it calls Hydration a parathread.
- **`rpc-composable.luckyfriday.io` serves Centrifuge.** Resolves, answers, wrong chain, silently.

### 11.3 Corrected — claims this project had already written down and got wrong

Each was believed, recorded, and repeated before being checked.

- **DOT was declared unpriceable.** It is not, and this repo has been publishing its price in
  production all along — `hydration-evm.mjs`'s oracle, **$0.826**, three independent paths agreeing
  to 0.05%. The claim contradicted a canary in `arbs-hydration.mjs:196` that throws if the chain
  disagrees. *A pool-membership search concluded "no DOT↔stable pool" — true, and irrelevant: DOT
  reaches the dollar through a 1:1 AAVE wrap to aDOT, over 200 routed trades a day.*
- **"11 iBTC against 19 WBTC"** — those were asset **ids**, not amounts. iBTC chain-wide is
  **2.118 BTC** against tBTC's 71.08.
- **Wave B item B1's "removes the 7-day window cap immediately"** (§4 — *not* research queue B1) — the cap was **doubled to 14**, not removed.
- **Centrifuge, Composable and Darwinia were written off as dead.** All three produce blocks. What
  died was the *business*: Centrifuge's $1.14bn book is a year-old photograph — tranche supply
  unchanged since 2025-08-19, pool NAV unrecalculated since 2025-08-22.
- **The `parents == 2` discriminator** is guaranteed by `CreateOrigin`, not by the matcher first
  credited with it.

### 11.4 Decided

| Decision | Call |
|---|---|
| Moonbeam band on `/bridged/` | **A dated "stranded value" row**, frozen at its final block, never updating |
| DOT pricing | **The money-market oracle**, live. Historical from the same oracle at archive blocks, back to 2024-11-12 |
| Yahoo Finance for history | **Rejected** — `robots.txt` is `Disallow: /` on the serving host, and the chain matches it to 0.16% median over 45 days |
| The store | **Not blocked by the disk.** Nobody wrote a handler; that is the whole reason. Build one, then decide the volume on a measured fill rate |

### 11.5 Learned about the method itself

- **The render is a probe.** A chart that reasoned correctly drew four of five rows as invisible
  slivers, and later drew a real shortfall as pixel-identical to none. Both were found by looking.
- **A probe tells you WHAT; only source tells you WHY.** Both mattered on the same fact today.
- **Ask the runtime instead of transcribing it.** `LocationToAccountApi_convert_location` cannot go
  stale across an upgrade, because it *is* the tuple. Same principle as computing storage keys.
- **"The RPC answered" is not "the chain is live", and "the chain is live" is not "the numbers on
  it are live."** Three separate facts; all three were confused today.
- **The shared git index is a race that instruction does not close.** Three separate incidents.
  Writing agents now report; the orchestrator stages and commits.

### 11.6 Next

§9.6 items 1, 2 and 4 shipped. What remains — **re-audited against the tree on 2026-08-21**, after
two more commits landed on top of this section:

1. ~~`jobs.swaps`~~ **Shipped as `jobs.swaps-daily`** — see §12. The name in this plan was wrong.
2. ~~The disk conversation~~ **Settled in §12 on the measured number: 1 GB.** Not the same thing as
   *provisioned* — the container still runs `--read-only` with no volume and CI asserts it, so mode
   A is unavailable in production. The ask is now itemised in
   [deployment.md](../architecture/deployment.md#what-is-still-owed) and tracked as research queue
   **O46**.
3. ~~E4 `moonbeam.mjs` is blocked on a decision~~ **the decision was §11.4's; the block is now
   research** — see §9.6 item 6 and research queue **B2**.
4. **A second store-backed handler shipped too**, unplanned by this list: `asset-hub/netflows-daily`
   plus the `sovereign-dot-recent` tail, which is what turned `/netflows/` into a continuous
   2022 → yesterday series (§12.4, [decision 0012](../decisions/0012-netflows-is-a-store-plus-a-live-tail.md)).
5. **`/account/` shipped too**, also unplanned here: `hydration/account` plus a `kind: 'tool'` page,
   the first drill-down on this site and the smallest version of Q5's "follow the money". Bounded to
   one venue and one window, and it says so first — see
   [hydration.md](../platform/hydration.md#one-account-what-account-answers-and-what-bounds-it).

Still genuinely next, in order:

1. **O21 — the whole-network sweep.** 86 paras, `System::Account(sibl)` plus `Paras::Heads`
   deltas, ~1 hour, and `asset-hub.mjs` already has most of the machinery. Highest leverage open.
2. **E4 `moonbeam.mjs`** for the stranded-value row, once B2 gives it a number.
3. **Liveness on the four sources still without it** — `arbs-bifrost`, `arbs-hydration`,
   `hydration-evm`, `hyperbridge` (the last blocked on research queue O23) — **and on `/account/`,
   whose payload already carries the assertion its page does not draw** (research queue O44).

---

## 12. The disk, settled on a measured number — 2026-08-20

§4 deferred this with an explicit condition: *"size it after C1 exists and we can measure real
fill rates."* C1 through C4 had been written since Wave C and had **never executed**, because no
source defined a `jobs` entry. `jobs.swaps-daily` is the first one, and it produced the number.

### 12.1 What a day actually costs

121 days and 1,112,356 routed trades ingested for real on 2026-08-20:

| | |
|---|---|
| indexed day, on disk | **14.3 – 16.7 kB** |
| a day with nothing to index | 544 B |
| SQLite overhead over logical rows | 1.079× |
| per routed trade | 1.35 B |
| time per day | mean **9.0 s**, p90 15.3 s |
| time, as a model | **2.27 s/day + 0.563 ms/trade**, ±1 % across four months |

**Growth is linear in DAYS, not in trades** — a day with 19,046 trades costs 15.5 kB, one with
7,315 costs 13.6 kB. The payload is a summary with bounded lists, so volume barely moves it. That
is the property that decides the sizing, and it was not knowable without measuring.

**Full Hydration backfill, 2025-01-01 → 2026-08-19** (596 days, 6,585,435 trades, counted exactly
rather than sampled): **≈ 9 MB on disk, ≈ 84 minutes, ≈ 2.9 GB pulled from orca.** The store is
**0.3 % of what it reads**, which is the whole point of it.

### 12.2 The decision

**Provision 1 GB. The question was badly posed and the measurement is why.**

The ask was framed as "10 GB for a full sweep", then argued down to "much smaller but not zero".
Both were guesses about the wrong quantity. At 14–17 kB/day/source, **1 GB holds roughly 160,000
source-days** — every source this repo has, at daily granularity, for longer than the chains have
existed. A year of Hydration is 5.5 MB.

Provision a small persistent volume and stop treating storage as scarce, because at this rate it
is not. The scarce resource is **upstream time** — 84 minutes and 2.9 GB pulled to produce 9 MB —
and that is a politeness budget, not a disk budget. It is already governed by `HostGate` (one
in-flight request per host across every job).

**What would reverse this:** storing raw trades rather than summaries is 268 B each — 2.8 MiB/day,
1.64 GiB for the same history, **~190×**. That is a different decision with a different answer,
and it is refused for a second reason anyway: `serveFromStore` returns every segment in one
response with no paging, so a month of raw trades is a ~150 MB single answer. The summary month
measured 428 kB over the wire.

**Applied 2026-08-21, half of it.** The image side is done — `ANALYTICS_DATA_DIR=/data`, `/data`
created owned by uid 1000, and CI runs the container both with and without a volume and asserts
`store.available` in both directions ([decision 0014](../decisions/0014-the-store-gets-a-volume-and-fills-itself.md)).
The VM side is an operator change to a compose file this repository cannot reach; the exact text is
in [deployment.md](../architecture/deployment.md#the-volume-and-the-change-an-operator-has-to-make).
Recording the size and never asking for the mount is what broke `/netflows/` for a day: **a decision
written down is not a decision applied.**

**And the size figure now has a second network under it.** Kusama's netflows series added 1,857 days
and 2.73 MB at 1,542 B a day, so the two together are ~5 MB — still three orders of magnitude inside
1 GB, but the arithmetic in §12.1 predates it and is worth re-running against a filled store rather
than re-derived from the same estimate (research queue O58).

### 12.3 What the measurement corrected

- **`~8,527 trades/day`, measured from the live 14-day window and quoted in `hydration.mjs`,
  understates history by ~31 %.** The true mean over 19 months is **11,050/day**, and 2025-08 ran
  at 19,046. A cost estimate extrapolated from a recent window is an estimate of the recent window.
- **Block time varies far more than the trailing averages suggested**: 13.96 s/block in
  2025-01 → 4.88 s in 2026-07, so a single day holds between 6,188 and 17,702 blocks. CLAUDE.md's
  block-time bullet has been corrected in place — the existing figures were right for recent
  history and badly wrong once you walk backwards.

### 12.4 Still open

`docs/concept/research-queue.md` **O34** is the one that matters: *does orca ever revise a day it
has already indexed?* A stored day is never re-fetched, so a revision would be invisible forever.
It is defended by three checks that refuse rather than annotate, but confirming it needs elapsed
time, not cleverness.

~~**O35** was written here as "nothing renders the stored history yet…"~~ **O35 is closed
(2026-08-21).** `/hydration/?days=3m|12m|all` joins whole stored months to a counted live tail, so
the 0012 pattern is applied on Hydration too and the second handler has a reader. The seam it leaves
is different from netflows' and is worth stating: the counted tail has **no priced volume**, so the
dollar line breaks at the join while orca's own pool volume is continuous (research queue O71).

Two more the backfill opened, both about the store rather than about Hydration: **O36**, because
`/netflows/` asks for 55 month-identities on a cold store against a cap of 8 live jobs; and ~~**O46**,
because the production container still has nowhere to keep any of it~~ — **O46 is closed
(2026-08-21)**: its three open parts were the ask, `ANALYTICS_DATA_DIR`, and what CI asserts, and all
three are settled in [decision 0014](../decisions/0014-the-store-gets-a-volume-and-fills-itself.md)
and written out as an operator instruction in
[deployment.md](../architecture/deployment.md#the-volume-and-the-change-an-operator-has-to-make).
What is left is somebody editing a compose file on a VM, which is not research.

---

## 13. Session record — 2026-08-21

Seven agents in parallel. Written down here so the next reader can tell what moved without reading
the whole log.

### 13.1 Shipped

| | |
|---|---|
| **`/hydration-capital/`** | A fifth Hydration page, and the **stock** counterpart to four flow pages: how much money is on the chain, counted once. It publishes the combined figure `/hydration-market/` deliberately declined to publish, because the four venues hold each other's receipt tokens several layers deep and adding them up double-counts ~30 %. See [hydration-capital.md](../platform/hydration-capital.md). |
| **`/account/`** | The transfer graph. `server/sources/transfers.mjs` over the SQD portal — a new *kind* of upstream (NDJSON streaming, keyless, decoded events from block 0) with four documented silent failure modes. See [sqd-portal.md](../platform/sqd-portal.md). |
| **Kusama netflows** | One implementation parameterised by network, both toggles drawing the same chain-read series. Closes research queue **O39**. [Decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md), [kusama.md](../platform/kusama.md). |
| **`server/sources/prices.mjs`** | Decision 0009 was **decided and never built**; it is now implemented, registered, and composed by `/bridged/`'s own operation. The two remaining named consumers in 0009's context — the Moonbeam stranded-value row E4 and the per-chain value work in §7 — can now `import { quotes }` and get a `Map` keyed by XCM location bytes without touching Hydration. [prices.md](../platform/prices.md), [decision 0013](../decisions/0013-the-pricer-and-the-valuation-share-a-module.md). |
| **The store's home** | `ANALYTICS_DATA_DIR=/data` in the image, `/data` owned by uid 1000, boot-time warm-and-resume, CI asserting `store.available` in both directions. [Decision 0014](../decisions/0014-the-store-gets-a-volume-and-fills-itself.md). Closes **O46** as research; the compose-file line on the VM is still owed. |
| **`/sovereign/` lost its "then"** | 875 → 467 lines. [Decision 0016](../decisions/0016-a-comparison-inherits-its-worst-reading.md). |
| **The control row** | `localChoiceControl`, a sticky bar with its hints lifted out, and every control relinking when any control moves the URL. [Decision 0017](../decisions/0017-a-control-sits-with-what-it-changes.md). |

### 13.2 What the day cost in wrong numbers already written down

Three figures this repository had recorded and got wrong, corrected in place rather than appended to:

- **`netflows-daily` at "~2.2 requests per day"** — it is 5.4–5.7 on both networks. The arithmetic
  forgot what runs per *batch*. Corrected in `asset-hub.md`, `data-sources.md`, `jobs.md`, decision
  0012 and the module header.
- **`/netflows/`'s Kusama toggle described as archive-only** in decision 0011, plan §7.7 and
  `pages.js`. Corrected.
- **`/sovereign/` described as drawing the gap to scale** in plan §7.7 and §11.1. It no longer draws
  it, and the gap no longer exists.

And one that was written down as a decision and never applied, which is the one that reached
visitors: §12.2 settled the volume's size on 2026-08-20 and nobody asked for the mount, so
`/netflows/` answered 503 for every visitor for a day while everything else rendered.

### 13.3 Still open, and where

`docs/concept/research-queue.md`, which opened **28** questions, closed **7** that today's work
answered (O8, O26, O35, O39, O44, O46) plus one — O57 — that was opened and answered inside the same
day, and now stands at 5 blocking and 64 opening. The two worth reading first are **O50**
(`/sovereign/` is the last Polkadot-only page and no longer has a reason to be) and **O56** (a JSON
503 from our own origin reached a browser as something that would not parse, which means every
structured error this service writes may be being discarded at the edge).

---

## 14. The store goes live — 2026-08-21, second half

§13 was written before the volume existed. This is what happened after, and it is the half that
turned a store nothing could reach into one production is filling. Written as a handoff: the next
session is local, and starts from here.

### 14.1 It is live

Verified against production, not inferred: build `40cd7e3`, `store.available: true`, jobs draining,
and the orca canary answering in prose on `/api/health`. `/netflows/`, `/account/`,
`/hydration-capital/`, `/bridged/` and the rest are all serving.

**Infra mounted the volume** — `polkadot-analytics-data:/data`, named, `read_only: true` kept on the
rootfs — after two definition-of-done gates, both of which improved the answer:

| Their gate | What it forced |
|---|---|
| *"Is the store a pure cache?"* | Yes, with a conditional worth writing down: re-derivability depends on upstreams we do not own, and **orca already publishes a floor**. It became the canary. |
| *"Does the store prune?"* | **No, and nothing enforces 1 GB.** The honest answer was a disk tripwire on their side, not a number in our documentation. |

Three corrections came back with it and are applied: the VM compose file **is** tracked
(`cypherpunk-agency/server-setup`, `stack/docker-compose.yml`), it uses `deploy.resources.limits`
rather than `mem_limit` and publishes no ports because Caddy proxies over the `web` network, and
`deployment.md` had invited a 404 by listing a page path and an API path side by side.

### 14.2 Two standing conditions, turned into code rather than promises

Infra asked to be told if a third job handler appeared, and to re-check the orca floor periodically.
Both are now enforced by the repo, because **a promise to remember is not a control**:

- **A third `jobs` handler fails `npm run check`**, compared both ways — a removal invalidates the
  storage figures too. The failure names the four ordered steps: measure, update `jobs.md` and
  `deployment.md`, tell infra, then extend the list.
- **`server/lib/canary.mjs`** compares orca's *live* floor against what the store actually holds, and
  reports on `/api/health` as a sibling of `store` so their existing grep still matches. It states
  the consequence, not the number. Its `ok` is `true`/`false`/**`null`**, because never-checked is
  not fine, and it never throws — an at-risk store is not a reason to restart a container.

The subtlety the brief missed and the implementation caught: a naive floor comparison **cries wolf on
day one**, because a healthy store deliberately holds 2025-01-01…24 as `before-source-floor`. Only a
day holding *indexed* content now below the floor has actually been lost.

### 14.3 The defect the go-live exposed, which was mine

**Warming inverted the queue.** Before decision 0014 a reader's request was the only job in it; after,
it lands behind 135 identities enqueued in advance. Measured in production: a reader asking for
`netflows 2026-07` got **job 74 of 135** — about two hours behind work nobody asked for, for a month
that takes 45 seconds alone. `MAX_LIVE_JOBS_PER_OPERATION` made it worse, not better, because warming
is exempt from it.

Fixed with a priority column, warm at 0 and readers at 10, and a yield at batch boundaries. Cold-boot
measurement: the reader's job goes from **55th claimed to 4th**, and from **52 jobs run before it to
one**.

Three details carry the correctness, and each is a trap:

- **`enqueue` is raise-only and `raisePriority` is public**, because the common case never reaches
  `enqueue` — `demand.mjs` answers a live identity with a lookup, so the reader *joins* the warm job.
- **A yielding job parks as `queued`, not `partial`.** `partial` is not in `RUNNABLE_WHERE`, so
  parking there strands it until the next re-warm.
- **`hasRunnableAbove` is strictly greater**, or two warm jobs ping-pong forever.

**Still open, and genuinely unsolved:** priority fixes the ordering but not the cap. A reader whose
month is not on the warm list is still refused, and the obvious fix — count only jobs at or above the
caller's priority — is unsafe, because an anonymous caller sets its own priority by asking.

### 14.4 What this half taught about the method

- **Two false alarms in one afternoon, both from partial evidence.** The Caddy hypothesis (disproven
  by two `curl`s) and "the worker is not draining" (it was job 74 of a FIFO queue; jobs 1 and 2 were
  already `done`). Both were escalated to the user before being probed. The repo's own rule already
  covers this — *when the evidence is inconclusive, write the probe* — and the failure was not
  reasoning badly, it was **reporting before measuring**.
- **A handover is not a patch.** Two agents handed over code that would have caused outages: the
  netflows migration SQL would have thrown inside `migrate()` and dropped the whole site to mode B,
  and `warm()` shipped wired to nothing. Both were caught by the agent that *applied* them, not the
  one that wrote them. Applying a handover is a review, not a paste.
- **An agent blocked for 2.5 hours on a drain it did not own.** Nine `Bash` sleeps of 16–20 minutes.
  The drain runs at the same rate unwatched, and the store is demand-driven anyway — it never needed
  a complete backfill to finish its task.

### 14.5 Next — for the local session

Ordered. The first is small and the second is the one with a number attached.

1. **`/bridged/` full coverage — B9 then B8.** The only blocking items with money behind them:
   **~$4.9 M currently reads as unpriced** and the page names all 26 assets it cannot value. **B9** is
   cheaper and first — decimals for the 8 assets Asset Hub has no metadata for, worth $4.24 M, needing
   each ERC-20's own `decimals()` on Ethereum, a chain this repo does not yet read. **B8** unlocks
   ~$3.6 M but is a day's work with real risk: Hydration exposes **no routing runtime API**
   (`RouterApi_quote`, `_calculate_sell`, `_calculate_spot_price` all "Exported method not found",
   verified live), so the stableswap D-invariant must be implemented rather than asked for, and a
   plausible wrong price is exactly this repo's stated failure mode.
2. **Bisect the relay's positional→named event-arg flip** (blocks ~8M–12M). `/account/`'s transfer
   graph throws loudly there rather than lying, which is right — but **the entire pre-2022 relay era
   is unreadable until this is settled, and the relay is where all the history is.** This is what
   unlocks the direction in §8: earliest transactions, following large amounts, correlating accounts.
3. **O50 — `/sovereign/` is the last Polkadot-only page.** The netflows table would carry it; the only
   real question left in it is whether `bridged-holders` has a Kusama meaning.

Not urgent, and not worth promoting yet: 64 open O-items, a fair number of them small.

## 15. Session record — 2026-08-21, third: the page stops racing its own edge

Production 429'd `/netflows/` — its ~56 per-month requests crossed the edge's 30-req/min limit,
which was O41 arriving early and angry. Fixed at the read layer, storage identity untouched:
**decision 0020**. One aggregate (`netflows-series`, the new `store: true` dispatch shape), an
SSE identity watch (`/api/stream/<source>/<operation>`, declared per job handler as `watch`),
and the client's `followStore` with a polling fallback. Two requests per load in steady state.
Reviewed by a 31-agent adversarial pass (six confirmed findings, all fixed — the protocol ones:
`done` carries a machine-readable reason, and shutdown severs the stream frameless so
EventSource reconnects to the new instance). Deployed and probed same day: the edge passes SSE
unbuffered (136 ms first bytes of 176 ms total) and gzips the aggregate; a push demonstrably
ships in ~90 s (O59 closed by observation). O41 closed; O83 opened for `/hydration/`, the
second adopter.

### 15.1 Next — direction from Tommi, 2026-08-21

Three asks, recorded before compaction so they survive it:

1. **Top holders on a chain** — by (a) native token value and (b) all-tokens value, at least for
   Asset Hub, Hydration and Hyperbridge. What exists today is adjacent, not this:
   `/bridged/` decomposes each bridged asset across *sovereign* accounts, and
   `/hydration-capital/` decomposes what the protocol holds — neither ranks arbitrary holder
   accounts. The open questions are per chain and belong to research first: enumerating
   `System::Account` / `Assets::Account` / `ForeignAssets::Account` at scale (paged iteration as
   a store job vs an indexer), whether Hyperbridge's holders are enumerable at all through its
   indexer, and valuation through the existing `prices` source with unpriced assets stated, not
   dropped. → **O84**.
2. **Netflows for the top 100 DOT-holding accounts** on Polkadot relay + Asset Hub — the
   sovereign-account treatment, generalised to people. Two halves: the snapshot (who are the
   top 100 now — post-migration that is mostly an Asset Hub question) and the history (a daily
   balance series per account; the netflows machinery fits, but 100 accounts × ~1,700 days is a
   backfill with a real cost that must be measured before it is promised). The account set also
   CHANGES over time — "top 100 today, traced backwards" and "top 100 at each point in time"
   are different products and the difference must be stated on the page. → **O85**.
3. **"Follow the value of money"** — asked whether it is already live. **Partially.**
   `/account/` is live in production: one account's counterparties on Asset Hub and the relay,
   walkable hop by hop, plus its Hydration trades. What it is NOT yet: the window is a few
   days (O63 — extending below the Asset Hub Migration is unmeasured), and there is no
   multi-hop aggregate view (O64 — the two-hop counterparty matrix; hop 2 is already free
   server-side). Those two O-items ARE the roadmap for this ask.

Sequencing note: O84 before O85 — the top-100 snapshot O85 needs is a byproduct of O84's
Asset Hub half.

### 15.2 Delivered — 2026-08-21, fourth session: the whale series, seed to page in one day

Ask 2 above shipped, larger than asked (top 1,000, not 100) and reshaped twice by Tommi
mid-design — both decisions recorded in [0021](../decisions/0021-the-whale-cohort-is-seeded-not-enumerated.md):

- **Never enumerate; seed.** The 4.14 M-account sweep was cancelled for a one-off read of
  Subscan's public holder list, verified account-by-account against the chain at a pinned block.
  Discovery is editorial and dated; measurement is chain-read. `src/data/dot-whales.json`:
  990 accounts, 1,130,529,331 DOT, 66.54 % of Asset Hub issuance.
- **Current cohort only.** Historical cohorts and the union idea were dropped; the series is
  "today's whales traced backwards" with survivorship stated on the page, bounded by the second
  chart (in 2022-01 only 271 of the 990 existed).

Live in production the same day: `asset-hub/whales-daily` (both legs, each day's close block,
~43 MB / ~2.2 h backfill self-filling since deploy), `whales-series` (one ~300 kB aggregate,
decision 0020 machinery), the SSE watch, and `/whales/` — which deliberately withholds the
top-10 concentration line until O87 settles whether its movement is real or a cohort artefact.
Both build agents' findings are recorded: O86–O91, B10, two CLAUDE.md traps, and the
ED-pre-provisioning discovery in `docs/platform/asset-hub.md` (550 of the 990 held exactly one
existential deposit on Asset Hub a year before the Migration).

Still open from the original three asks: O84's Hydration/Hyperbridge halves and the all-tokens
valuation; O63/O64 for "follow the money".
