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

**What we read.** `xcm-summary`, `xcm-daily-stats`, `xcm-top-routes`, `daily-summary`,
`daily-tps`, `daily-usdc`, `daily-usdt`, `defi-tvl`, `coretime-utilization`,
`coretime-sale-metrics`, `contracts-deployed-heatmap`, `contract-calls-heatmap`,
`monthly-opengov-participation`, `monthly-treasury-balances`, `monthly-percent-staked`.

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
