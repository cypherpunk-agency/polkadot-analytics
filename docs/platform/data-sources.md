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
verified answering an anonymous request.

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
answer `200` with a bare JSON **array** — no envelope, no `total`, no `next`. Both parameters are
required: omitting them is a `422`, not a default window.

| Operation | Params | Row shape | Chains | History starts | Newest row on 2026-08-20 |
| --- | --- | --- | --- | --- | --- |
| `daily-usdc` | `start_date`, `end_date` | `date`, `relay_chain`, `chain`, `sum_of_usdc` | 13 | 2023-08-31 | 2026-08-18 |
| `daily-usdt` | `start_date`, `end_date` | `date`, `relay_chain`, `chain`, `sum_of_usdt` | 21 | 2023-08-31 | 2026-08-18 |
| `defi-tvl` | `start_date`, `end_date` | `date`, `chain`, `tvl_usd` | 5 | 2023-01-01 | 2026-08-19 |

Real rows, exactly as returned for `start_date=2026-08-18&end_date=2026-08-19`:

```json
{"date": "2026-08-18", "relay_chain": "polkadot", "chain": "acala", "sum_of_usdc": 92690.751068}
{"date": "2026-08-18", "relay_chain": "polkadot", "chain": "acala", "sum_of_usdt": 9010.377036}
{"date": "2026-08-18", "chain": "acala", "tvl_usd": 1625222.1517311928}
```

Over 2026-08-13…20 that is 78 rows / 13 chains, 126 rows / 21 chains and 31 rows / 5 chains
respectively — dense grids, one row per chain per day, no gaps inside the window. `relay_chain` is
on the two stablecoin endpoints and is **not** on `defi-tvl`. It is also an undeclared *filter*
rather than decoration: `relay_chain=kusama` returns `[]` while an invented parameter is ignored
and changes nothing, so there is no Kusama stablecoin data here at all.

> ⚠️ **`daily-usdc` and `daily-usdt` silently truncate at 1,000 rows, from the RECENT end.** There
> is no cap parameter, no `limit`/`offset`/`page_size` (all three are ignored), and nothing in the
> response says it was cut. Verified live 2026-08-20: `start_date=2020-01-01&end_date=2026-08-20`
> returns exactly 1,000 rows covering **2023-08-31 to 2024-03-25** — a `200`, well-formed, and
> two and a half years out of date. `2026-01-01…2026-08-20` returns exactly 1,000 rows ending
> 2026-03-15. Worse, the last day in a truncated response is itself **partial**: the 90-day probe
> ended on 2026-08-01 with 6 of the 14 chains present, so the final point of any chart drawn from
> it is a low number for a reason nothing in the payload states. 13 chains × 77 days ≈ 1,000, so
> the cap bites at roughly **11 weeks of `daily-usdc` and 7 weeks of `daily-usdt`**. Any caller
> must chunk by date window and stitch, and must check that what came back reaches the date it
> asked for. `defi-tvl` has no such cap — 2,925 rows for 2023-01-01…2026-08-20 in one response.

> ⚠️ **`defi-tvl` has the `0.0`-means-unknown disease.** 54 of 446 rows in the 90 days to
> 2026-08-20 are exactly `0.0`, and they are not zeros: Bifrost is `0.0` on all 53 days before
> 2026-07-14 and $857,710 on the day after, which is Dotlake starting to collect a chain rather
> than a protocol appearing overnight. Asset Hub has a single `0.0` on 2026-06-25 sitting between
> $346,647 and $339,492 — a one-day collection dropout written as a value. Sum `tvl_usd` across
> chains per day and you get a series with a fabricated step and a fabricated trough in it. This
> is the same failure as `total_value_usd` on the XCM endpoints, in a different column.

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

**What is still unknown.** Nothing in the response says what `sum_of_usdc` sums — total issuance
on that chain, or the sum of account balances, or holdings excluding some system account — and no
Dotlake document seen so far settles it. Nor does anything say which protocols `defi-tvl` counts
on each of its five chains. Both figures are usable as *series* (the shape over time is
consistent) and not yet as *quantities* to reconcile against a chain read.

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
