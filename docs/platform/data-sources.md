# Data sources

Every endpoint this site reads, what it is, what it costs, and what is wrong with it.

All of them are **anonymous public HTTP**. There is no API key anywhere in this repo and there
must not be — see [decision 0003](../decisions/0003-no-secrets.md). None of these services agreed
to serve us, so the caching in [middleware.md](../architecture/middleware.md) is not an
optimisation, it is the terms on which we are entitled to use them.

The live, machine-readable version of this list is at `/api`, generated from
`server/sources/index.mjs`. This document is the prose that does not fit there.

---

## Dotlake — `api.data.parity.io` {#dotlake}

Parity's ecosystem-wide data API; the backend behind [data.parity.io](https://data.parity.io).
The broadest source here by far: XCM message flow, per-chain daily activity, DeFi TVL,
stablecoin holdings, coretime, contracts and OpenGov, all pre-aggregated.

**Auth.** Its OpenAPI document declares `security: [{}, {BearerAuth: []}]`. The empty first
alternative is the important half — authentication is *optional*, and every endpoint we use was
verified answering an anonymous request. Its own words (source-verified in `openapi.json`,
`info.description`, API version 0.1.1, read 2026-08-20): *"The data endpoints are public — no API
key required. Anonymous requests are rate-limited per IP; exceeding either limit returns HTTP
429."*

> ⚠️ **Anonymous is optional, but a *wrong* credential is fatal — send no header at all.**
> Verified live 2026-08-20: no `Authorization` header → `200`; `Authorization: Bearer
> not-a-real-key` → **`401`** `{"status":"error","message":"Invalid or inactive API key"}`. There
> is no "fall back to anonymous" — a malformed or expired key fails the request outright.
> `server/lib/upstream.mjs` sends only `accept: application/json` and attaches no credential of
> any kind, which is exactly the behaviour that works, and is the same rule as
> [decision 0003](../decisions/0003-no-secrets.md) rather than a coincidence.
>
> On rate limits: ~150 anonymous requests across this probe and the earlier one never drew a
> `429`, and **no `x-ratelimit-*` or `retry-after` header is exposed** on any response, so the
> published limit cannot be observed before it is hit (*verified live* that none was returned;
> the limit's existence is *source-verified* from the text above, its value unknown). The caching
> in [middleware.md](../architecture/middleware.md) is what keeps us well inside it.

**Attribution is required.** The same `info.description` states plainly: *"Attribution required by
any public use."* This site is a public use. Every page drawing a Dotlake figure must name Parity's
Dotlake as the source — this is an obligation the provider states, not a courtesy, and it is the
one condition attached to an otherwise free and anonymous API.

**What we read.** Only four of the fifteen registered operations are actually called by a page:
`xcm-summary`, `xcm-daily-stats`, `xcm-top-routes` and `xcm-value`, all of them by `/xcm/`. The
other eleven — `daily-summary`, `daily-tps`, `daily-usdc`, `daily-usdt`, `defi-tvl`,
`coretime-utilization`, `coretime-sale-metrics`, `contracts-deployed-heatmap`,
`contract-calls-heatmap`, `monthly-opengov-participation`, `monthly-treasury-balances`,
`monthly-percent-staked` — are registered and reachable at `/api/dotlake/…` but no dashboard
reads them. Three of those are described below, because "registered" and "understood" are not
the same thing and the difference is where a wrong number comes from.

**What it cannot do: balances.** Probed for the top-holders work (full `paths` list read out of
`openapi.json`, 50 endpoints, 2026-08-21): there is **no account-balance or holder-ranking endpoint
of any kind**. The one per-account endpoint, `/api/explorer/account/{address}/summary`, is activity
stats — its own description says *"total transactions, first/last seen timestamps, and top 3
most-used pallets"* — and it answered `"Account … not found"` for both the Polkadot treasury and a
parachain sovereign (verified live 2026-08-21), so it indexes signed activity, not state: the
biggest balance-holders on the chain are exactly the accounts it has never heard of. Anything
needing "who holds what" starts from chain state, not from Dotlake.

**Cost.** Cheap — sub-second, pre-aggregated. Cached 2–60 minutes by operation.

> ⚠️ **`total_value_usd` is neither a floor nor a ceiling.** ~~It is a floor, not a total.~~
> **Corrected 2026-08-20** — this said "a floor" and that was actively wrong in the dangerous
> direction, because a floor is safe to publish and this is not.
>
> It is wrong in *both* directions at once. **Too low:** Dotlake prices only the assets it can
> resolve and reports everything else as exactly `0.0`, indistinguishable from a message that
> genuinely moved nothing — one 24-hour window returned `0.0` across 374 messages while a 7-day
> window returned $478k for 3,540. **Too high:** it also carries decimals-corrupted rows, where an
> 18-decimal amount is labelled `asset_decimals: 6`. Two years of it sums to
> **$39,917,060,621,977,640**; one week of 2025-11 held thirteen rows over the ceiling summing to
> **$108.6 billion**, two of them a single USDC corridor at $44.2B and $42.2B, against $25.6M of
> believable value in the same four days.
>
> So the aggregate column is unusable and `/xcm/` does not use it. It reads **row-level records**
> and applies three rules per row — `decimals-disagree`, `magnitude-outlier` (a *detached cluster*
> at the top of a symbol's magnitude distribution, not a distance from the median, because the
> median form threw out a genuine $1.05M USDT transfer and understated a week by 13%) and a
> `$25,000,000` `over-ceiling` backstop. **Every excluded row comes back with the payload and is
> named on the page**, with its value on it. An exclusion nobody can see is just a different silent
> error. The page still leads with **message counts**, which are exact.

> ⚠️ **"Matched" is not "delivered".** A matched message is one whose arrival was observed. An
> unmatched one may have arrived and gone unrecorded, or may never have arrived — from the index
> alone those are the same thing. `xcm-top-routes` defaults to `matched_only: true` here, because
> counting unmatched messages overstates every destination.

**Naming.** Dotlake uses historical parachain identifiers: `statemint` is Asset Hub, `hydradx` is
Hydration. The page relabels them for display; the data is not altered.

> ⚠️ **And it does not use the same identifiers on every endpoint.** `daily-usdc` and `daily-usdt`
> say `hydradx` and `polkadot_asset_hub`; `defi-tvl`, from the same warehouse, says `hydration`
> and `assethub` (verified live 2026-08-20). Joining two Dotlake endpoints on `chain` therefore
> drops the two largest rows in the ecosystem and reports a clean, complete-looking result over
> what is left.

### `daily-usdc`, `daily-usdt`, `defi-tvl` — registered since v1, never called

Probed 2026-08-20 (**verified live**, `curl` against `api.data.parity.io`, anonymous). All three
answer `200` with a bare JSON **array** — no envelope, no `total`, no `next`.

> ⚠️ **The date parameters are required on two of these three and optional on the third.** Not a
> symmetry anyone would guess, and this repo registered all three as optional until 2026-08-20.
> **Source-verified** in the OpenAPI document (`required: true` on both stablecoin endpoints,
> `required: false` on `defi-tvl`) and **verified live**: `GET /api/daily-usdc` with no
> parameters is a `422` carrying a FastAPI body,
> `{"detail":[{"type":"missing","loc":["query","start_date"],"msg":"Field required"},…]}` —
> identical on `daily-usdt` — while `GET /api/defi-tvl` with no parameters is a `200` with the
> complete history, 2,925 rows from 2023-01-01. Registered as optional, a caller's omission
> travelled to Parity and came back as a generic "dotlake returned HTTP 422" instead of a local
> "`start_date` is required."

| Operation | Params (⁕ = required) | Row shape | Chains | Newest row on 2026-08-20 | Cut at 1,000 rows |
| --- | --- | --- | --- | --- | --- |
| `daily-usdc` | `start_date`⁕, `end_date`⁕, `chain`, `relay_chain` | `date`, `relay_chain`, `chain`, `sum_of_usdc` | 13 | 2026-08-18 | **yes** |
| `daily-usdt` | `start_date`⁕, `end_date`⁕, `chain`, `relay_chain` | `date`, `relay_chain`, `chain`, `sum_of_usdt` | 21 | 2026-08-18 | **yes** |
| `defi-tvl` | `start_date`, `end_date` | `date`, `chain`, `tvl_usd` | 5 | 2026-08-19 | no |

Chain counts are per day on the newest complete day; across 2026-08-01…19 the distinct-chain
counts are 14 and 22, because Moonbeam has rows early in that window and none after 2026-08-04.

Real rows, exactly as returned for `start_date=2026-08-18&end_date=2026-08-19`:

```json
{"date": "2026-08-18", "relay_chain": "polkadot", "chain": "acala", "sum_of_usdc": 92690.751068}
{"date": "2026-08-18", "relay_chain": "polkadot", "chain": "acala", "sum_of_usdt": 9010.377036}
{"date": "2026-08-18", "chain": "acala", "tvl_usd": 1625222.1517311928}
```

Over 2026-08-13…20 that is 78 rows / 13 chains, 126 rows / 21 chains and 31 rows / 5 chains
respectively — one row per chain per day. **The grid is dense over a short window and not over a
long one**: `daily-usdc` filtered to Asset Hub across 2025-01-01…2026-08-19 returns 576 rows over
a 595-day span, so **19 days inside the covered range have no row at all** (2025-07-20, 2025-08-12,
2025-08-15, … — verified live 2026-08-20). Iterating dates rather than rows is therefore required,
and this repo's rule that empty days are drawn rather than dropped applies directly.

**`chain` and `relay_chain` are declared, not undocumented** (source-verified in the OpenAPI:
both appear as `required: false` query parameters on `daily-usdc` and `daily-usdt`, and neither
appears on `defi-tvl`). Both genuinely filter — `chain=polkadot_asset_hub` returns that one
chain's row. `relay_chain` has exactly one useful value: `relay_chain=kusama` answers `200 []`
rather than an error, so **there is no Kusama stablecoin data here at all**. On `defi-tvl`, which
declares neither, `?chain=assethub` is silently ignored and returns all 2,925 rows across all five
chains — the general rule below.

> ⚠️ **There is no input validation of any kind, and no unknown-parameter error.** All verified
> live 2026-08-20: `start_date=not-a-date` returns `200 []`; a window entirely in the future
> returns `200 []`; a reversed window (`start_date` after `end_date`) returns `200 []`; and an
> unknown parameter — `limit`, `offset`, `page_size`, anything — is **accepted and ignored**, so
> `?limit=5` looks like it worked and changed nothing. Every one of these renders as an empty or
> unchanged chart and never as an error. Our own `readParams` rejects the malformed date before
> the call is made; it cannot help with a well-formed date nobody has data for.

> ⚠️ **`daily-usdc` and `daily-usdt` are cut at exactly 1,000 rows: the OLDEST 1,000 survive and
> everything newer is dropped.** It is a cut, not a page. The response is a `200` with no
> envelope, no `has_more`, no `total`, no `next`, no `Link`, no `206`, and no header of any kind
> that says so — the full header set on a truncated response is `cache-control`, `content-type`,
> `date`, `server: uvicorn`, `x-cache`, `x-content-type-options`, `content-length`, and nothing
> else. There is no `limit`/`offset`/`page_size` to page past it; all are ignored. Verified live
> 2026-08-20: `start_date=2025-01-01&end_date=2026-08-19` returns exactly 1,000 rows covering
> **2025-01-01 to 2025-03-18** — seventeen requested months gone under a success code. The cut is
> a hard boundary: the same start with `end_date=2025-03-17` returns 994 rows and the full range;
> 2025-03-18 returns 1,000 and the full range; every later `end_date` returns 1,000 rows still
> ending 2025-03-18.
>
> At 13 and 21 chains per day the cut lands at about **76 days of `daily-usdc` and 46 of
> `daily-usdt`** — an ordinary quarter-long window is already truncated, and a 50-day `daily-usdt`
> request returns 46 days of it. Narrowing to one chain helps but does not remove the cap:
> `chain=polkadot_asset_hub` over 2023-01-01…2026-08-19 still returns exactly 1,000 rows, ending
> 2026-06-14. `defi-tvl` is **not** cut — 2,925 rows for 2023-01-01…2026-08-19 in one response.

> ⚠️ **The last day of a cut response is itself partial.** The cut lands mid-day, so the final
> date carries a fraction of its chains — **6 against the usual 14** on 2025-03-18 in the probe
> above, and 20 against 21 on `daily-usdt`. The last point of any chart drawn from a truncated
> response is a low number for a reason nothing in the payload states. Drop the trailing date or
> draw it as incomplete; the row count per date is the only signal there is.

> ⚠️ **Falling short of the requested `end_date` is NOT by itself evidence of the cut.** Dotlake
> is a batch warehouse and its newest stablecoin row was a full day behind the clock on
> 2026-08-20 — a request ending 2026-08-19 legitimately comes back ending 2026-08-18. Ordinary
> lag and a 1,000-row cut are indistinguishable in the rows. What separates them is the
> **conjunction**: landing on exactly 1,000 rows *and* falling short of the requested end.

**What this repo does about it.** `server/sources/dotlake.mjs` no longer returns these three as a
bare array. Each returns `{ window, coverage, quality, rows }`, and `coverage` carries the
evidence for its own completeness — computed from the same rows a chart would be drawn from, per
rule 3, so it cannot drift away from them:

```json
{ "rows": 1000, "rowCap": 1000, "atCap": true, "truncated": true,
  "requestedFrom": "2025-01-01", "requestedTo": "2026-08-19", "requestedDays": 596,
  "coveredFrom": "2025-01-01", "coveredTo": "2025-03-18", "coveredDays": 77, "dates": 77,
  "daysPerCap": 71, "trailingPartial": { "date": "2025-03-18", "chains": 6, "typical": 14 } }
```

That is the real payload for the truncating window above (verified end-to-end 2026-08-20). The
honest 19-day window on the same operation returns `atCap: false, truncated: false,
trailingPartial: null` despite also stopping a day short of the request, which is the lag-versus-cut
distinction working. `truncated` is `true` only when proven, `false` only when proven, and `null`
when it cannot be told apart from lag — which happens when the caller named no `end_date`, the
only case `defi-tvl` allows. `daysPerCap` is how many days a single request can ever reach at the
observed chain count: the number to chunk under.

> ⚠️ **`defi-tvl` has the `0.0`-means-unknown disease, and over full history it is most of the
> table.** Across all 2,925 rows, **1,389 — 47.5% — are exactly `0.0`** (verified live
> 2026-08-20), and they are not zeros. Per chain:
>
> | chain | rows | first…last | exact `0.0` | first non-zero |
> | --- | --- | --- | --- | --- |
> | bifrost | 1,326 | 2023-01-01…2026-08-18 | **1,290** | 2026-07-14 |
> | acala | 595 | 2025-01-01…2026-08-18 | 98 | 2025-01-01 |
> | astar | 595 | 2025-01-01…2026-08-18 | 0 | 2025-01-01 |
> | hydration | 230 | 2026-01-01…2026-08-18 | 0 | 2026-01-01 |
> | assethub | 179 | 2026-01-15…2026-08-19 | 1 | 2026-01-15 |
>
> Bifrost carries a row on every day since 2023-01-01 and a *number* only since 2026-07-14; the
> $857,710 that appears that day is Dotlake starting to collect a chain, not a protocol appearing
> overnight. Asset Hub's single `0.0` on 2026-06-25 sits between $346,647 and $339,492 — a
> one-day collection dropout written as a value. This is the same failure as `total_value_usd` on
> the XCM endpoints, in a different column. `quality.zeroRows` in our payload counts them.

> ⚠️ **`defi-tvl`'s "history from 2023-01-01" is one chain's padding, not coverage.** Only Bifrost
> has rows that far back and they are empty until 2026-07-14. The **five chains are only all
> present from 2026-01-15**, when Asset Hub — the largest of them — starts. An ecosystem TVL total
> summed per day across whatever rows exist is therefore a step function of *collection onset*
> rather than of TVL: it is missing Asset Hub entirely before 2026-01-15 and Hydration before
> 2026-01-01. Sum only over the window where every chain you are naming actually has rows, and say
> which window that is.

> ⚠️ **The newest `defi-tvl` date is a partial day.** On 2026-08-20 the last date, 2026-08-19,
> carried **1 of 5 chains** (Asset Hub only): $328k, against $28.4M the day before. A daily total
> that includes it drops 99% on the last bar for no reason on any chain. Drop the trailing
> incomplete date, or draw it as incomplete — the row count per date is the only signal there is.

**The stablecoin endpoints do NOT share that disease, in the windows probed.** Across 90 days:
zero rows with `0.0`, zero nulls, zero negatives, and no magnitude outliers — the largest
day-over-day move in any chain's series was 2.1×, against the 10ⁿ jumps that mark a decimals
fault. Values are plausible on their face (Asset Hub USDC peaked at $36.2M, USDt at $30.8M). That
is evidence of good hygiene in *this* column, not a guarantee: the XCM value fault is a *per-row*
`asset_decimals` error, and these endpoints expose no per-row decimals to check, so the same
class of fault would be undetectable here. Treat them as clean and re-check on every use.

> ⚠️ **A chain that leaves does not go to zero — its rows stop existing.** Moonbeam's last
> `daily-usdc` row is 2026-08-04 ($107,462 on 2026-07-31, its last figure); from 2026-08-05 there
> is no Moonbeam row at all, which is consistent with [Moonbeam leaving
> Polkadot](moonbeam.md). A chart that iterates the chains present in the newest day never learns
> that a chain used to be there; one that iterates chains present anywhere in the window draws a
> line that ends mid-air. Both are right and they are different pictures, so the choice has to be
> stated.

> ⚠️ **`sum_of_usdc` is NOT total issuance, and it is smaller than it by a lot.** Settled by
> reconciliation against the chain on 2026-08-20 rather than left open:
>
> | | Dotlake `polkadot_asset_hub`, 2026-08-18 | Asset Hub live, 2026-08-20 | Dotlake as % |
> | --- | --- | --- | --- |
> | USDC | 25,546,978.05 | **350,019,956.32** | **7.3%** |
> | USDt | 30,678,272.16 | **77,998,622.06** | **39.3%** |
>
> The chain figures are `Assets::Asset(1337).supply` and `Assets::Asset(1984).supply` read at
> finalized block **#19,683,097**, `0xbccc99d8…5433e8`, `Timestamp::Now` =
> 2026-08-20T12:44:48Z — decimals taken from `Assets::Metadata`, not assumed (**verified live**;
> the probe is `state_getStorage` against `polkadot-asset-hub-rpc.polkadot.io`). The two-day gap
> between the figures does not explain a 13× difference, and neither does staleness: Dotlake's
> Asset Hub USDC series sat between $18.9M and $36.2M across the whole of the preceding 90 days
> while real supply was ~$350M. **Whatever "USDC held by chains" counts, it is not the asset's
> issuance** — and the two ratios differ so much between USDC and USDt that it is not a fixed
> fraction either. Anything that presents `sum_of_usdc` as "the USDC on Asset Hub" is wrong by an
> order of magnitude, and it renders perfectly.

**What is still unknown.** *Which* subset `sum_of_usdc`/`sum_of_usdt` counts — a class of holder,
a set of protocols, a set of accounts excluding the largest custodians — is still unsettled;
nothing in the response says, and no Dotlake document seen so far does either. What is now settled
is what it is *not*: not issuance, and not a constant fraction of it. Nor does anything say which
protocols `defi-tvl` counts on each of its five chains. Treat all three as *series* whose shape
over time is consistent, and **not** as quantities that reconcile against a chain read.

**Worth noticing.** `date, chain, <asset>` is nearly the shape `docs/concept/plan.md` §8.1 wants
for per-chain-per-token flow — one row
per chain per day per token, already aggregated. What it is *not* is flow: these are stocks, so a
flow series would be a first difference, and a first difference of a series containing a
collection artefact turns that artefact into a spike. That is a design conversation, not a
transformation. Nothing has been built on these three; this note exists so nobody re-derives it.

---

## Hyperbridge nexus indexer — `nexus.indexer.polytope.technology`

The GraphQL indexer behind [Hyperbridge](https://hyperbridge.network), and the source HyperFX's
own history page reads. See [hyperbridge.md](hyperbridge.md).

**What we read.** `iOrderV3s` — every intent order ever placed, with user, status, referrer,
source and destination chain, input and output assets. Paged 200 at a time, sequentially, once
per 5-minute TTL. Roughly 750 orders as of August 2026, so a full sweep is about four requests.

> ⚠️ **Our total is not HyperFX's headline.** Their front-page "TOTAL VOLUME" derives from
> cumulative protocol dust collected × 2,000. This site sums the actual orders. The two disagree
> and the page says so rather than quietly picking one.

> ⚠️ **Decimals are per chain, not per symbol.** USDC and USDT are 18 decimals on BNB Chain and 6
> everywhere else. A table keyed by symbol is a silent factor-of-a-trillion error on every BNB
> order, and it renders perfectly. The table in `server/sources/hyperbridge.mjs` is keyed by
> `(chain, address)` for this reason.

> ⚠️ **The indexer does not price cNGN**, which nearly every order touches, so rates are derived
> from the order book itself — see `src/core/pricing.js`. An asset the table does not know is
> reported by address on the page rather than valued at zero, because a total that is quietly low
> is worse than a visible gap.

---

## Hydration — `orca.hydration.cloud` and `rpc.hydradx.cloud`

Two upstreams for four pages. **orca** — `orca-prod-pool-01.orca.hydration.cloud/graphql`, with
`orca-prod-pool-02.catfish.hydration.cloud/graphql` as an identical-schema second host — is
Hydration's own liquidity-pools squid, self-hosted, CORS-open, live to the block. The RPC is the
chain itself, read for the asset registry: an indexer that hands you `asset: 1000624` and nothing
else cannot tell you what was traded. See [hydration.md](hydration.md).

> ⚠️ **`explorer.hydradx.cloud` is no longer read by this repository**, and neither is the generic
> SQD `hydradx` dataset. This section used to describe the first of those. The repoint to orca
> landed on 2026-08-20 for three reasons: orca has **already done the leg-grouping** (5,538 routed
> trades against 12,647 raw legs in 24 h), it reaches **730,000 blocks earlier** than the first
> `Broadcast.Swapped3` because it indexes the older event versions too, and it answers. The
> explorer returns `canceling statement due to statement timeout` on an unbounded `Swapped3` scan —
> asking it for the single oldest one timed out after 12.3 s, re-checked 2026-08-20. The SQD
> dataset was found **frozen 103 days** while answering every query in 381 ms with well-formed
> rows, which is the reason every source here carries a liveness assertion.

**What we read.** `routedTrades` over a block-height range, keyset-paged on
`[PARA_BLOCK_HEIGHT_ASC, ID_ASC]` with the connection's own `endCursor`; `AssetRegistry::Assets`
over the RPC for exactly the asset ids that appeared; and `platformTotalVolumesByPeriod` over the
same blocks, so the page can state how far it sits from the number Hydration publishes about
itself.

**Cost — the reason the window is capped.** About **11,050 routed trades a day** on average across
orca's whole 19-month index, 468 bytes a row on the wire, ~330 ms per 1,000-row page. One day is
~3 s; fourteen days ~24 s; thirty days is ~181,000 trades and about a minute, which is a page load
nobody waits through. **The `days` parameter is capped at 14** — doubled from 7 when the repoint
landed, not removed — and cached 15 minutes, and the page states the cap rather than presenting it
as a preference. Longer windows go through the job queue instead: `hydration/swaps-daily` stores one
UTC day at a time, measured at 9.0 s and ~15 kB per day
([jobs.md](../architecture/jobs.md#what-the-store-actually-costs)).

> ⚠️ **One event per swap LEG, not per trade.** A single router route through four pools emits
> four events. Summing them multiplies volume by the hop count, and the result looks entirely
> plausible. Legs of one trade share the first element of `operationStack`. orca's `routedTrades`
> has already done that grouping; the raw-leg path is still described in
> [hydration.md](hydration.md#broadcastswapped3-the-event-our-dashboard-reads) because the event
> is what the chain emits and the grouping is what can be got wrong.

> ⚠️ **Filter by block height, not timestamp.** A height-filtered count returns in 0.5 s; the same
> count filtered by `block.timestamp` took 11 s. Buckets are then stamped from each event's own
> timestamp, so the fast filter costs no accuracy. Resolving a UTC day to a height means bisecting
> on the chain's own clock — **never** multiplying an assumed block rate, which on this chain has
> ranged from 13.96 s to 4.88 s inside nineteen months.

> ⚠️ **Two assets can share a ticker.** The page appends the asset id when a symbol is used by more
> than one traded asset, otherwise a genuine arbitrage between two representations renders as a
> nonsensical `USDT→USDT` route.

> ⚠️ **Some assets have no symbol or decimals on chain.** `External`-type registry entries are
> legitimately blank. Those legs are reported as unresolved rather than guessed at.

**The registry decode is self-checking.** `AssetDetails` is decoded positionally and must consume
its input exactly; the registry is then verified against HDX/12, DOT/10 and USDC/6 before any
price is computed. Wrong decimals are a silent factor of 10ⁿ on every figure on the page, so a
runtime upgrade that changes the layout has to fail loudly.

---

## Polkadot Bulletin chain — `bulletin-paseo.tservices.es:8443`

Content-addressed transaction storage on the Polkadot Products Devnet. See
[bulletin.md](bulletin.md).

**What we read.** Every key under `TransactionStorage.Transactions` (paged 1,000 at a time), then
the values in batches of 250, then two blocks for exact timestamps. About 40 calls, cached 10
minutes.

> ⚠️ **Not `paseo-bulletin-next-rpc.polkadot.io`.** That is a *different chain* with a different
> history. Pointing this at it produces a plausible, fully-rendering, entirely wrong view.

> ⚠️ **There is one node.** Its absence is a first-class state, not an error to retry through.
> Observed unreachable **continuously from 12:26Z to 12:43Z on 2026-08-20** — seventeen minutes,
> longer than the "several minutes" seen on 2026-08-19. The failure mode is worth knowing because
> it is not a routing problem: the `CONNECT` tunnel to `bulletin-paseo.tservices.es:8443`
> establishes and returns `200`, and then the TLS handshake is reset by the origin. DNS, egress
> and the port are all fine; the node itself is not answering. `/bulletin/` renders the
> transport-error notice for this, not a liveness pill — the source throws rather than returning
> a payload carrying `unreachable()`, so the assertion has nothing to travel on.

> ⚠️ **Timestamps are interpolated.** Only two blocks are timed exactly; everything between is
> placed by the measured block rate, so an object stored near midnight can land in the adjacent
> day. The counts are exact regardless, and the page states which is which.

**Deliberately not ported:** the explorer's submitter leaderboard. A signer lives inside its
block's signed extrinsic, so reading them costs two requests per block — about 7,600 for the
window. That is a reasonable thing for one person to opt into in a local tool and an unreasonable
thing to do on every load of a public page.

---

## Polkadot relay chain and Asset Hub — `rpc.polkadot.io`, `polkadot-asset-hub-rpc.polkadot.io`

Parity's public archive nodes for Polkadot's own two chains, read by one module,
`server/sources/asset-hub.mjs`. Anonymous, no key, plain JSON-RPC over HTTPS. This is the only
source here that reads Polkadot itself rather than somebody's index of it. See
[asset-hub.md](asset-hub.md).

**What we read.** `ForeignAssets::{Asset,Metadata,Account}` and `Assets::*` on Asset Hub;
`Paras::{ParaLifecycles,Heads}` and `Registrar::Paras` on the relay; `System::Account` for the
`para` and `sibl` sovereign accounts on both; `Balances::TotalIssuance`; `Timestamp::Now` at every
pinned block, for liveness and for day boundaries. Enumeration is `state_getKeysPaged` over a
prefix; reads are `state_queryStorageAt`, many keys at one block.

**Cost.** `bridged-inventory` and `bridged-holders` are about thirty requests per 15-minute TTL
across two hosts; `sovereign-dot` is roughly five per 10 minutes. The expensive one is history:
`netflows-daily` walks days at **5.4–5.7 requests per stored day** and ~1.1 s a day (counted through
the handler, 2026-08-21 — this corrects a "~2.2 per day" figure measured the day before, which forgot
the per-batch head re-pin). The whole 2022-01 → 2026-07 Polkadot backfill was ~50 minutes and 2.33 MB
stored. What makes that affordable is **JSON-RPC batching** — both endpoints accept an array of calls
in one POST — applied across *days* as well as across keys.

> ⚠️ **Match a batch response by `id`, never by position.** A server may reorder it, and reading it
> positionally attributes one block's balances to another day. Silent, and plausible.

> ⚠️ **Both endpoints are full archives to genesis** — but Asset Hub has state and **no clock**
> below block #305,204 (2021-12-18), which is Statemint's pre-launch period and looks identical to
> a pruned node. A pruned read and an empty account both answer `null`. Guard on `Timestamp::Now`,
> which every real block has.

> ⚠️ **Asset Hub's block rate has moved by a factor of six** across the range these series cover —
> 12.51 s/block in 2022, 2.24 s in 2026. Never extrapolate a height from a date; measure locally
> from the samples nearest the target and verify against the chain's own timestamps.

> ⚠️ **`rpc-composable.luckyfriday.io` serves Centrifuge.** Resolves, answers, wrong chain, silently.
> Recorded here because it was reached for during this work; it is not read by anything.

## Kusama relay chain and Asset Hub — `kusama-rpc.polkadot.io`, `kusama-asset-hub-rpc.polkadot.io`

The same two Parity hosts one network over, read by the **same module** — `netflows-daily` and
`sovereign-dot-recent` take a required `network` of `polkadot | kusama`
([decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md)). Same runtime release
(`1.24.1-8ae9775dc43`), same operator, both full archives to genesis. Everything measured is in
[kusama.md](kusama.md).

**What we read.** `System::Account` for the `para` leg on the relay and the `sibl` leg on Asset Hub;
`Paras::ParaLifecycles` and `Registrar::Paras` at each stored day's own block; `Timestamp::Now` at
every pinned block; `system_properties` on every read, as a canary rather than as configuration.

**Cost.** 5.43 requests per stored day, 0.75 s a day; the whole 2021-07 → 2026-07 backfill was 61
months, 1,857 days, **33.1 minutes** and 2.73 MB stored (measured 2026-08-21).

> ⚠️ **KSM is 12 decimals and DOT is 10.** A Kusama figure divided by Polkadot's `1e10` is exactly
> 100× too large and looks entirely reasonable. SS58 is 2, not 0, so a Kusama account rendered at
> prefix 0 is a valid-looking Polkadot address. `netflowsHeads` asserts both against
> `system_properties` on every read.

> ⚠️ **Kusama Asset Hub has state but no clock below block #66,687** (2021-06-03T15:36:00.509Z) —
> Statemine's pre-launch period, indistinguishable from a pruned archive, and a pruned balance read
> answers `null`, indistinguishable from an empty account. It is what sets the Kusama series' floor
> at 2021-07.

> ⚠️ **The Kusama Asset Hub Migration is 2025-10-07**, bisected out of the relay chain rather than
> transcribed, and it was progressive rather than atomic. After it, each chain's `para` leg on the
> relay holds a round number of KSM plus one existential deposit — a few hundred KSM per chain, which
> looks entirely reasonable if you read only that leg.

## Interlay — `api.interlay.io/parachain`

Interlay's public RPC, read by `server/sources/interlay.mjs` for one number: iBTC issuance, the
BTC-bridged figure on `/bridged/`. One `state_getStorage` on `Tokens::TotalIssuance(Token(IBTC))`.
See [bridges.md](bridges.md).

> ⚠️ **iBTC's 8 decimals are a compile-time Rust constant**, not a registry entry — the one asset
> here whose divisor cannot be read from the chain. It carries a plausibility canary instead:
> chain-wide issuance was **2.118 iBTC** on 2026-08-20, and a decimals error is a factor of 10ⁿ, so
> anything in the thousands of BTC is the constant being wrong rather than the protocol growing.

> ⚠️ **The chain answers normally while weeks behind.** `Timestamp::Now` read 2026-07-27T12:13:01Z
> on 2026-08-20 — 24 days stale — with the RPC serving state and its GraphQL squid answering with
> 102 query fields. The module asserts liveness for exactly this reason.

## Bifrost — `dapi.bifrost.io/api/site`

Bifrost's public site API, read by `server/sources/arbs-bifrost.mjs` for the vDOT redemption rate
that `/hydration-peg/` compares Hydration's on-chain peg against. It is the only **cross-chain
dependency** in the Hydration family: the same rate is set on Hydration by two `MMOracle` peg
sources named in `Stableswap::PoolPegs(690)`, and decoding those would remove it — research queue
**O30**.

---

## The archived netflows dataset

Not an endpoint. `src/data/netflows.json` is 83 kB derived from 447,000 balance observations in
the 2023 [Polkalytics parachain-netflows](https://github.com/Polkalytics/parachain-netflows)
study, regenerated by `npm run data:netflows`.

Committed rather than fetched because it is finished history: nothing in it has moved since April
2023. The original's 25 MB of plotly HTML is not used — it relies on inline script, which this
site's CSP forbids, so the charts are redrawn from the source CSVs.

**It is a cross-check now, not the series.** Until 2026-08-20 this file *was* `/netflows/`. It is
now drawn against a daily series re-derived from the chains themselves over the same days, which is
what turned three of its properties from assumptions into measurements — see
[asset-hub.md](asset-hub.md#what-the-2023-study-measured-and-what-it-could-not) for the full
comparison over 2,442 chain-days.

> ⚠️ **It measured ONE of the two sovereign accounts.** The study read `para` on the relay chain
> only. On **883 of the 2,442 chain-days** in its window the same chain also held DOT in its `sibl`
> account on Asset Hub — at most 1.12% of that chain's total then, and essentially all of it now.
> Compared against the `para` leg alone it agrees to a median **4.0 × 10⁻⁹**; compared against the
> sum it scores the second leg as a disagreement it never claimed to measure.

> ⚠️ **Its final row is not a whole day.** On 2023-04-08 all eight chains disagree with a fresh
> read by up to **23.6%**, because its captures stop mid-day. Its published "at the end" figures
> are mid-day readings.

> ⚠️ **Daily resampling clips intraday spikes, unevenly.** Polkadot's Bifrost line understates its
> true peak by 55%; Interlay and Equilibrium by nothing at all. Every series carries its own
> `clipped` fraction and the page marks the affected ones.

> ⚠️ **Kusama is still archive-only.** `/netflows/?network=kusama` draws this file and nothing
> else, because no source module here reads a Kusama chain. Research queue **O26/O39**.

Re-deriving it also surfaced three disagreements between the published report and the data. The
page lists them rather than reconciling them, because the report is still online saying otherwise.

---

## Adding one

One module in `server/sources/`, one line in `server/sources/index.mjs`, and a section here. The
module declares its own operations, TTLs and parameter schemas; nothing else in the repo changes.
If a candidate source needs a credential, that is a
[decision](../decisions/0003-no-secrets.md) to record before it is a line of code.
