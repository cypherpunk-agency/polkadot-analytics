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

**Cost.** Cheap — sub-second, pre-aggregated. Cached 2–60 minutes by operation.

> ⚠️ **`total_value_usd` is a floor, not a total.** Dotlake prices only the assets it can
> resolve and reports everything else as exactly `0.0`, which is indistinguishable from a message
> that genuinely moved nothing. On a live check, one 24-hour window returned `total_value_usd: 0.0`
> for 374 messages and a 7-day window returned $478k for 3,540. The `/xcm/` page therefore leads
> with **message counts**, which are exact, and labels the dollar figure as a lower bound.

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

## Hydration — `explorer.hydradx.cloud` and `rpc.hydradx.cloud`

Two upstreams for one page. The Subsquid archive is the same indexer the official Hydration UI
uses; the RPC is the chain itself, read for the asset registry — an indexer that hands you
`asset: 1000624` and nothing else cannot tell you what was traded. See [hydration.md](hydration.md).

**What we read.** `Broadcast.Swapped3` events over a block-height range, keyset-paged 1,000 at a
time; and `AssetRegistry::Assets` for exactly the asset ids that appeared.

**Cost — the reason the window is capped.** About 11,000–13,000 swap legs per day. A three-day
window is roughly 35,000 events and 25 MB from the archive, taking ~5 s warm. The `days` parameter
is capped at 7 and cached 15 minutes, and the page states the cap rather than presenting it as a
preference.

> ⚠️ **One event per swap LEG, not per trade.** A single router route through four pools emits
> four events. Summing them multiplies volume by the hop count, and the result looks entirely
> plausible. Legs of one trade share the first element of `operationStack`, which is what we group
> on.

> ⚠️ **Filter by block height, not timestamp.** A height-filtered count returns in 0.5 s; the same
> count filtered by `block.timestamp` took 11 s. Buckets are then stamped from each event's own
> timestamp, so the fast filter costs no accuracy.

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

## The archived netflows dataset

Not an endpoint. `src/data/netflows.json` is 83 kB derived from 447,000 balance observations in
the 2023 [Polkalytics parachain-netflows](https://github.com/Polkalytics/parachain-netflows)
study, regenerated by `npm run data:netflows`.

Committed rather than fetched because it is finished history: nothing in it has moved since April
2023. The original's 25 MB of plotly HTML is not used — it relies on inline script, which this
site's CSP forbids, so the charts are redrawn from the source CSVs.

> ⚠️ **Daily resampling clips intraday spikes, unevenly.** Polkadot's Bifrost line understates its
> true peak by 55%; Interlay and Equilibrium by nothing at all. Every series carries its own
> `clipped` fraction and the page marks the affected ones.

Re-deriving it also surfaced three disagreements between the published report and the data. The
page lists them rather than reconciling them, because the report is still online saying otherwise.

---

## Adding one

One module in `server/sources/`, one line in `server/sources/index.mjs`, and a section here. The
module declares its own operations, TTLs and parameter schemas; nothing else in the repo changes.
If a candidate source needs a credential, that is a
[decision](../decisions/0003-no-secrets.md) to record before it is a line of code.
