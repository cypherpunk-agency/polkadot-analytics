# Hydration beyond swaps — data-surface research

**Sweep date: 2026-08-19.** Chain head at time of writing ≈ block **13,691,139**, runtime
`specName: hydradx`, `specVersion: 435`, node `49.2.2-81ab2e0`, metadata **v14**, **80 pallets**.

Everything in this file was produced by an actual request against a live endpoint on 2026-08-19.
Where something could not be verified it says so in a **Not verified** line. Numbers drift between
paragraphs by a few blocks because they were read minutes apart — that is block skew, not
disagreement, and it is called out where it could be mistaken for one.

The headline: our `hydration` page reads the generic Subsquid archive and reconstructs trades by
hand. That is the most expensive way to get the least data. There are **four** anonymous surfaces,
three of which we are not using, and between them they cover every item in the brief.

---

## 0. The four surfaces, ranked

| # | Surface | What it is | Auth | Best for |
|---|---|---|---|---|
| **A** | `https://orca-prod-pool-01.orca.hydration.cloud/graphql` | **The official Hydration liquidity-pools squid** (`galacticcouncil/hydration-data-lake`), self-hosted. 242 query fields. | none, `access-control-allow-origin: *` | Everything DeFi: pools, TVL history, money market, HOLLAR, DCA, OTC, liquidations, fees, **pre-grouped routed trades** |
| **B** | `https://rpc.hydradx.cloud` and `https://hydration-rpc.neckwork.net` | Substrate RPC. **Full archive back to genesis.** Also exposes the whole `eth_*` namespace. | none | Current state, historical state at any block, everything the squid does *not* index (staking, referrals, GigaHDX, farms), money-market contracts via `eth_call` |
| **C** | `https://hydration-explorer.neckwork.net/api/explorer/*` | The explorer Tommi remembered. A **REST API of finished dashboards**. | none, `access-control-allow-origin: *` | Ready-made aggregates you would otherwise spend a week building (HOLLAR peg series, HDX holder cohorts, revenue streams, circuit-breaker state) |
| **D** | `https://explorer.hydradx.cloud/graphql` | The generic Subsquid archive we already use. | none | Raw `events`/`calls`/`extrinsics` when nothing above has it |

Also present but marginal: `https://blockscout.evm.hydration.cloud/api/v2/*` (Blockscout v5.2.2-beta,
anonymous, EVM-side only — 84,238 transactions, 1,185 addresses; useful for contract verification,
not for protocol analytics) and `https://v2.archive.subsquid.io/network/hydradx` (raw Subsquid
archive, height **12,344,549** on 2026-08-19 — roughly **1.35 M blocks / ~93 days behind the chain**;
it is a source for building your own indexer, not a source to read).

---

## 1. The explorer Tommi half-remembered — FOUND

**`https://hydration-explorer.neckwork.net`** — the guess was exact. Resolves to `144.76.37.112`,
nginx 1.29.1, `<title>Hydration Explorer</title>`, `og:description` "Live block explorer for the
Hydration network".

Its CSP is the giveaway for how it is built:

```
content-security-policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline';
  worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self' https://hydration-rpc.neckwork.net wss://hydration-rpc.neckwork.net;
  manifest-src 'self'
```

So the front end talks to exactly two places: its own origin, and its own RPC node. The `'self'`
half is a **Fastify JSON API mounted at `/api`** — its 404 body is Fastify's
(`{"message":"Route GET:/ not found","error":"Not Found","statusCode":404}`) and it serves
`access-control-allow-origin: *`.

The route table was recovered from the SPA bundle `/assets/index-DDHfDQTp.js` (152 KB). Everything
under `/api/explorer/*` answers anonymously; everything under `/api/user/*` requires a bearer token
and is out of scope.

### Verified `/api/explorer/*` endpoints

Base: `https://hydration-explorer.neckwork.net/api`

| Endpoint | Params | Verified response |
|---|---|---|
| `/health` | — | `{"status":"ok"}` |
| `/assets` | — | full registry, 79 KB. `[{"assetId":0,"symbol":"HDX","name":"Hydration","decimals":12,"isStablecoin":false,"isUsdPegged":false,"parachainId":null,"origin":null}, …]` |
| `/explorer/stats` | — | `{"headBlock":13690819,"finalizedBlock":13690811,"headTime":"2026-08-19 17:01:33","avgBlockSec":6,"nominalBlockSec":6,"transfers24h":36944,"extrinsics24h":2644,"activeAccounts24h":102643,"hdxPrice":0.009941126482}` |
| `/explorer/counts` | — | `{"blocks":13690812,"extrinsics":4592353,"events":309602804,"transfers":80004502,"contracts":376,"maxOffset":20000000}` |
| `/explorer/omnipool` | — | pool account, `tvlUsd`, `assetCount`, `hubReserveTotal`, `lrnaPrice`, and per asset `reserve`/`reserveUsd`/`hubReserve`/`weightPct`/`capPct`/`tradable` |
| `/explorer/omnipool/{assetId}/lps` | `offset`,`limit` | LP leaderboard. `{"asset":{…0 HDX},"totalShares":"138138313312964315583","protocolShares":"3757482219481776330","lpCount":123,"positionCount":201,…}`. 404 `{"error":"Asset not in the Omnipool"}` for non-members |
| `/explorer/pools` | — | 164 KB. `totalTvlUsd` + every pool (omnipool / stableswap / xyk) with full composition |
| `/explorer/pool/{id}` | — | one pool, 42 KB, incl. its `modl` account, share token, peg info |
| `/explorer/pool/{id}/lps` | `offset`,`limit` | per-pool LP list with `sharePct` |
| `/explorer/pool/{id}/activity` | `limit` | recent pool events |
| `/explorer/asset/{id}` | — | 62 KB: price, `change24h/7d`, `holderCount`, `dcaCount`, `totalUsd`, `priceSeries` |
| `/explorer/asset/{id}/liquidity` | — | 264 KB: every venue holding that asset, with per-venue TVL |
| `/explorer/asset/{id}/dcas` | — | open DCA schedules buying/selling that asset, with `budgetUsd`, `executionsDone`, `nextExecutionBlock` |
| `/explorer/money-market` | `limit` | `{"totalSupplyUsd":40090453.58,"totalDebtUsd":15789711.69,"positions":[{…,"supplyUsd","debtUsd","netWorthUsd","healthFactor","blockHeight"}]}` |
| `/explorer/hollar` | — | **50 KB complete HOLLAR dashboard** — see §6 |
| `/explorer/hdx` | — | supply split, 61,057 holders, whale/dolphin/fish/shrimp cohorts, lock types, vesting |
| `/explorer/revenue` | `range` (e.g. `30d`) | `{"totals":{"day":2143.50,"week":14191.49,"month":65169.21,"allTime":3037218.41},"history":{…per-stream daily series}}` |
| `/explorer/revenue/flow` | `after` cursor | live per-event revenue feed + `drips` (continuously accruing streams) |
| `/explorer/security` | — | circuit-breaker state: withdraw limit config, usage %, lockdown, 11 egress accounts |
| `/explorer/holders/{assetId}` | `offset`,`limit` | ranked holder list with tags (Treasury, Kraken, …) |
| `/explorer/accounts` | `offset`,`limit`,`sort` | ranked accounts. **Slow: 3.2 s** |
| `/explorer/accounts-daily` | — | `[{"date":"2026-07-20","active":102,"new":3}, …]` 30 days |
| `/explorer/daily/{scope}` | scope ∈ `extrinsics`,`events`,`activity` | 90-day daily counts. Any other scope → `{"error":"Invalid scope"}` |
| `/explorer/activity` | `limit`,`offset`,`type`,`action`,`asset`,`from`,`to`,`min` | unified typed activity feed (`type:"trade"`, …) |
| `/explorer/activity/count` | same | count for the same filter |
| `/explorer/blocks` `/explorer/block/{h}` `/explorer/events` `/explorer/extrinsics` `/explorer/extrinsic/{id}` | `limit`,`offset`,`from`,`to` | ordinary explorer reads |
| `/explorer/dca/{id}`, `/explorer/dca/exec/{a}/{b}`, `/explorer/dca-at/{a}/{b}` | | DCA schedule detail |
| `/explorer/trade/{a}/{b}`, `/explorer/trade-event/{a}/{b}` | | trade detail |
| `/explorer/tags`, `/explorer/tag/{id}/…`, `/explorer/lists`, `/explorer/list/{id}` | | a **curated address-labelling system** — Treasury, Kraken, Parachain Sovereign, Stableswap Pool, Lend & Borrow, GIGAHDX Pot, BIL Issuer … with notes and icons |
| `/explorer/contracts`, `/explorer/contract/{a}/{abi,sources,events,transactions}` | | EVM contract verification data |
| `/explorer/search` | `q` | typed search across tags, assets, accounts |
| `/explorer/filter-names` | — | **every call and event name it has actually observed** — 105 calls, 209 events. A ready-made map of what is live on this chain |
| `/explorer/live` | — | `EventSource` (SSE) stream |
| `/explorer/account-refs` | `addresses` (comma list) | batch label lookup |

**Operational character.** `cache-control: public, max-age=2`, `x-cache-status: HIT` — there is an
nginx cache in front. 20 rapid sequential calls to `/explorer/stats` all returned 200 with no
throttling, no `Retry-After`, no rate-limit headers. `robots.txt` is `User-agent: * / Allow: /`.

**What it is NOT.** It is not a GraphQL API (`/graphql` just serves the SPA shell) and it is not the
official Hydration indexer. It is somebody's independently operated explorer.

> **Not verified:** who runs neckwork.net, whether there are terms of use, and whether there is any
> rate limit that only appears under sustained load. The bundle contains no "about", no operator
> name, and no affiliation notice. Treat it as a courtesy, not a contract.

### The important caveat about surface C

Everything it returns is **untrusted input from the open web**, and unusually so: it embeds
user-authored content — account `profile`s, `identity`s, avatar URLs, and a `tags` system whose
`note` fields are free prose (one is 300 characters about the BIL issuance operation). Per the repo's
existing rule for web sources, this must be built as DOM text nodes and never as HTML, and the tag
`icon` field is sometimes an emoji and sometimes a remote URL (`https://cdn.jsdelivr.net/gh/…`) —
which under our `img-src 'self'` CSP will silently fail to load. Strip or proxy them.

---

## 2. The official Hydration squid — the real find

`galacticcouncil/hydration-data-lake` (Apache-2.0) ships two Sqd indexers, `liquidity-pools` and
`storage-dictionary`. The endpoint its own health-checker README names —
`https://galacticcouncil.squids.live/hydration-pools:unified-prod/api/graphql` — **404s today**
(verified, eight slug variants tried). It has moved to self-hosting. The live endpoints, recovered by
loading `https://app.hydration.net` in a browser and reading `performance.getEntriesByType('resource')`:

```
https://orca-prod-pool-01.orca.hydration.cloud/graphql          ← primary
https://orca-prod-pool-02.catfish.hydration.cloud/graphql       ← second pool, identical schema
https://orca-prod-pool-01.orca.hydration.cloud/rest/service/metadata
```

Both answer anonymously and return identical 242-field schemas.

```
$ curl -s https://orca-prod-pool-01.orca.hydration.cloud/rest/service/metadata
{"metadataVersion":1,"indexer":{"id":"orca-aggregator-mainnet","version":"sh-orca-101",
 "network":"hydration","master":true},
 "coverage":{"timeBounds":{"minTime":"2023-01-01T00:00:00Z","maxTime":"2026-01-29T01:15:00Z"},
 "blockBounds":{"minBlockHeight":0,"maxBlockHeight":-1}}}
```

**That `maxTime` is stale metadata, not stale data.** Verified by query: `blocks(orderBy: HEIGHT_DESC)`
returns `{"height":13691067,"timestamp":"2026-08-19T17:28:51+00:00"}` — current to the block.
Oldest indexed block is **5,000,001 (2024-04-28)**, so the squid covers ~2.3 years, not from genesis.

It is **PostGraphile**, not Subsquid OpenReader: connection args are `first`/`last`/`offset`/
`after`/`before`, ordering is `orderBy: PARA_BLOCK_HEIGHT_DESC` (SCREAMING_SNAKE), filtering is
`filter: { field: { equalTo | greaterThan | in } }`. `x-powered-by: Express`,
`x-graphql-event-stream: /graphql/stream` (live subscriptions exist — untested).
**POST only** — a GET query returns `405 {"errors":[{"message":"Only \`POST\` requests are allowed."}]}`,
so no CDN-cacheable GETs.

### Entity inventory (all `totalCount`s verified live)

| Domain | Entities | Rows |
|---|---|---|
| Omnipool | `omnipools`, `omnipoolAssets`, `omnipoolAssetHistoricalData`, `omnipoolHistoricalData`, `omnipoolAssetsLatestTvl`, `omnipoolAssetVolumeHistoricalData(ByPeriod)`, `omnipoolLiquidityPositions`, `omnipoolAssetLiquidityEvents` | `omnipoolAssetHistoricalData` **196,528,407**; `omnipoolLiquidityPositions` **66,394** |
| Stableswap | `stableswaps`, `stableswapAssets`, `stableswapAssetHistoricalData`, `stableswapHistoricalData`, `stableswapLiquidityEvents`, `stableswapVolumeHistoricalData(ByPeriod)`, `stableswapYieldMetrics`, `stableswapsLatestTvl` | `stableswapHistoricalData` **77,361,543** |
| XYK / LBP | `xykpools`, `xykpoolHistoricalData`, `xykpoolsLatestTvl`, `lbppools`, `lbppoolPriceHistoricalData` | `xykpoolsLatestTvl` **328** pools |
| Money market | `aavepools` **23**, `moneyMarketReserves` **25**, `mmReserveConfigHistoricalData`, `mmReserveIndexesHistoricalData`, `mmSupplies`, `mmWithdraws`, `mmBorrows`, `mmRepays`, `mmLiquidationCalls`, `mmUserEModeSets`, `mmMintedToTreasuryEvents`, `accountMmPositionHistoricalData` **23,586,016**, `moneyMarketEvents` | `mmLiquidationCalls` **9,287** |
| Liquidations | `liquidationLiquidatedEvents` (the pallet's own bot) | **8,553** |
| HOLLAR / HSM | `hsmpools` **1**, `hsmCollaterals` **1**, `hsmCollateralConfigHistoricalData`, `hsmpoolAssetHistoricalData`, `hsmpoolHistoricalData`, `aaveFacilitators` **5** + `aaveFacilitatorHistoricalData` | — |
| OTC | `otcOrders` **982**, `otcOrderEvents` | — |
| DCA | `dcaSchedules` **29,498**, `dcaScheduleEvents`, `dcaScheduleExecutions`, `dcaScheduleExecutionEvents`, `dcaScheduleOrderRouteHops` | — |
| Trades | `swaps` **18,936,456**, `routedTrades` **6,582,409**, `swapFees` **26,390,131**, `swapInputOutputAssetBalances` | — |
| Farming | `omnipoolYieldFarmDeposits` **74,515**, `xykYieldFarmDeposits` | but `omnipoolGlobalFarms` = **0**, `omnipoolYieldFarms` = **0**, `xykGlobalFarms` = **0** |
| Prices | `assetSpotPriceHistoricalData`, `assetLatestSpotPrices`, `emaOracleEntryHistoricalData`, `assetPairPricesAndVolumesByPeriod` | — |
| Accounts | `accounts`, `accountTotalBalanceHistoricalData`, `accountAssetBalanceHistoricalData`, `accountLiquidityBalanceHistoricalData`, `accountOwnedAssets`, `accountChainActivityTraces` | — |
| Chain generic | `blocks`, `events`, `calls`, `extrinsics`, `transfers` | it can replace surface D |
| Platform rollups | `platformTotalTvl`, `platformTotalVolumesByPeriod`, `allAssetsYieldMetrics`, `dustableAccounts` | — |

**Absent from the squid, entirely:** `Staking`, `Referrals`, `GigaHdx`, `GigaHdxRewards`, and the
liquidity-mining **farm definitions**. Those are chain reads only (§9, §10, §11).

### `routedTrades` — the thing that makes our current page obsolete

`CLAUDE.md` records, correctly, that Hydration emits one `Broadcast.Swapped3` per swap **leg**, and
that our code groups them on `operationStack[0]`. The squid has already done that, and exposes the
result as a first-class entity:

```graphql
{ routedTrades(filter:{ paraBlockHeight:{ greaterThan: 13676667 } },
               first:5, orderBy: PARA_BLOCK_HEIGHT_DESC) {
    nodes { id paraBlockHeight inputAssetIds outputAssetIds
            participantSwappers participantFillers
            swaps { totalCount nodes { fillerType operationType } }
            routeTradeInputs  { nodes { assetId amount } }
            routeTradeOutputs { nodes { assetId amount } } } } }
```

A real answer:

```json
{"id":"13691089-10624374","paraBlockHeight":13691089,
 "inputAssetIds":["5"],"outputAssetIds":["10"],
 "participantSwappers":["0x2a94f7991ac5b24e01cc37ca327e1b72088bdb6c3a0582c4572ef32d0909ab0e"],
 "swaps":{"totalCount":6,"nodes":[
   {"fillerType":"AAVE","operationType":"ExactIn"},
   {"fillerType":"Stableswap","operationType":"ExactIn"},
   {"fillerType":"Omnipool","operationType":"ExactIn"},
   {"fillerType":"Omnipool","operationType":"ExactIn"},
   {"fillerType":"Stableswap","operationType":"ExactIn"},
   {"fillerType":"AAVE","operationType":"ExactIn"}]},
 "routeTradeInputs":{"nodes":[{"assetId":"5","amount":"969900951305"}]},
 "routeTradeOutputs":{"nodes":[{"assetId":"10","amount":"74978793"}]}}
```

Six legs, one trade, net in and net out already computed. Over 24 h: **5,538 routed trades vs 12,647
swap legs** — a leg-inflation factor of **2.28×**, consistent with the 2–4× the platform doc warns
about. A full day of routed trades with inputs and outputs is **one query, 210 ms, 288 KB**.

Note `routedTrades` ids look like `{blockHeight}-{incrementalId}` and the second half is the
`Broadcast::IncrementalId` counter, which read **10,624,191** on chain — so the squid's grouping key
is the same call-stack id our decoder uses. The two agree by construction.

### Cost of the squid — measured

| Query | Time | Bytes |
|---|---|---|
| `platformTotalTvl` | 307 ms | 341 B |
| `platformTotalVolumesByPeriod(_24H_)` | 116 ms | 401 B |
| `platformTotalVolumesByPeriod(_7D_)` | 962 ms | 405 B |
| `platformTotalVolumesByPeriod(_30D_)` | 2,694 ms | 412 B |
| `omnipoolAssetsLatestTvl` (20 rows — see trap 21) | 32 ms | 2.6 KB |
| whole money market: 25 reserves × latest config + latest rate indexes | **166 ms** | 23 KB |
| **365 daily TVL points × all 20 Omnipool assets, one query** | **589 ms** | **853 KB** (8,379 rows) |
| 365 daily TVL points, one asset | 368 ms | 58 KB |
| 1,000 routed trades with in/out balances | 210 ms | 288 KB |
| 24 h counts for supplies/borrows/repays/withdraws/liquidations | 34 ms | 175 B |

**The trap: `totalCount` on the big tables.** `omnipoolAssetHistoricalData { totalCount }` took
**11.6 s**; `swapFees { totalCount }` 3.5 s; `assetSpotPriceHistoricalData { totalCount }`
**timed out at 25 s**. Every one of those is instant when a `filter:` narrows it. Never request
`totalCount` on an unfiltered per-block table.

**A resolver that is broken right now:** `stableswapsLatestTvl` returns
`{"errors":[{"message":"column sahd.pool_historical_data_id does not exist"}]}` — a live SQL error on
the deployed squid, verified twice. `omnipoolAssetsLatestTvl` and `xykpoolsLatestTvl` work fine.
Stableswap TVL has to come from `stableswapAssetHistoricalData`, surface C, or chain reads until
that is fixed.

`allAssetsYieldMetrics(filter:{feeMetricsInterval:_1D_})` **exceeded a 5-minute client timeout**.
It is in the schema; do not build on it without a fallback.

---

## 3. The RPC is a full archive node — this changes the storage plan

`https://rpc.hydradx.cloud` exposes **168 methods**, including the entire `eth_*` namespace, a custom
`liquidation_*` namespace, and `archive_v1_*`.

Historical state was tested at ten heights on both public RPCs, reading `Omnipool::Assets(0)` (HDX)
and `Tokens::TotalIssuance(5)` (DOT):

| Block | Date-ish | `rpc.hydradx.cloud` | `hydration-rpc.neckwork.net` | Result |
|---|---|---|---|---|
| 1 | genesis | 754 ms | 84 ms | key absent (pallet not yet live) |
| 1,000,000 | | 367 ms | 43 ms | key absent |
| 3,000,000 | | 361 ms | 42 ms | `hub=23174768359467947 shares=38654090322398471669` |
| 6,000,000 | | 360 ms | 42 ms | `hub=25482634650290088` |
| 9,000,000 | | 350 ms | 42 ms | `hub=80831857248945523` |
| 12,000,000 | | 356 ms | 42 ms | `hub=87204469294943546` |
| head − 432,000 | 30 d ago | 398 ms | 42 ms | `hub=182538416938962715` |
| head | now | 350 ms | 42 ms | `hub=238947126769801031` |

**No pruning anywhere.** `state_getKeysPagedAt` also works historically — enumerating
`Omnipool::Assets` at head−432,000 returned the same 19 asset ids in 177 ms.

The `null` at early heights is not pruning, it is the pallet not existing yet; and note that
`Omnipool::Assets(5)` (DOT) is `null` **today** but populated at block 8,506,923 — because DOT itself
was removed from the Omnipool and replaced by **aDOT (asset 1001)**. That is a real protocol change
you can date precisely from archive state, and a trap if you assume an asset that was in the pool
still is.

**Neckwork's RPC is ~8× faster** (42 ms vs 360 ms, consistently, on identical queries).

**Throughput measured:** 30 daily snapshots of the full `Omnipool::Assets` map (hash → keys → values)
= **90 RPC calls, 16.4 s, 37 KB**. Extrapolating, a year of daily Omnipool snapshots is ~1,095 calls
and ~200 s — a one-off backfill you can run in a container start-up hook, not a datastore project.

**Conclusion that matters for v2:** *historical protocol state does not require an indexer or a
persistent store to backfill.* You can compute any point in the past on demand from the archive RPC.
Persistence is then a **cache of derived series**, not a system of record — which is a much smaller,
much less scary thing to put on a 256 MB container.

`archive_v1_finalizedHeight` (13,690,916) and `archive_v1_hashByHeight` work over plain HTTP;
`archive_v1_storage` returns `{"code":-32603,"message":"Internal error"}` — it is an
operation/subscription-style method that wants a WebSocket. Use `state_getStorageAt` /
`state_getKeysPagedAt` instead; they are plain request/response and they work.

---

## 4. Omnipool liquidity and TVL per asset

### Where it lives

`Omnipool::Assets: AssetId -> AssetState` (Blake2_128Concat, **19 entries**, 1,235 value bytes,
352 ms for the whole map). Decoded from live metadata:

```
AssetState { hub_reserve: u128, shares: u128, protocol_shares: u128,
             cap: u128 /* 1e18 = 100% */, tradable: Tradability { bits: u8 } }
```

**`AssetState` does not contain the asset reserve.** That is the single most important structural
fact here. The reserve is the Omnipool account's *balance* of the asset, and **which storage holds
that balance depends on the asset's registry type** — three different reads:

| Registry type | Read |
|---|---|
| `Token` (orml-tokens) | `Tokens::Accounts(omnipoolAccount, assetId).free` |
| native HDX (asset 0) | `System::Account(omnipoolAccount).data.free` — HDX is `pallet-balances`, not orml |
| `Erc20` | `eth_call balanceOf(omnipoolEvmAddress)` on the contract in `AssetRegistry::AssetLocations(id)` |

Omnipool account = `0x6d6f646c6f6d6e69706f6f6c00…00` (`modl` + `omnipool`),
SS58 `13UVJyLnPLowAMzbZewu9zwEGiSMQKniJ2cp4vM4ru2nci9N`. Its EVM address is the first 20 bytes:
`0x6d6f646c6f6d6e69706f6f6c0000000000000000`.

**A naive `Tokens::Accounts` sweep silently drops 5 of 19 assets, including the two largest.** Tested:
HOLLAR (19.5 % of the pool), GETH (15.0 %), aDOT (14.2 %), HDX and GSOL all return `null`. Summing
what is left understates Omnipool TVL by roughly half, and the chart renders perfectly.

### The verified table (head 13,691,139)

| asset | symbol | type | dec | reserve read path | reserve (raw) | hub_reserve | cap % |
|---|---|---|---|---|---|---|---|
| 222 | HOLLAR | Erc20 | 18 | `eth_call balanceOf @ 0x531a654d1696ed52e7275a8cede955e82620f99a` | 2251699017662591007523470 | 425275089371643277 | 20 |
| 1000765 | tBTC | Token | 18 | `Tokens::Accounts` | 30586086576150504896 | 394086857067270900 | 30 |
| 420 | GETH | Erc20 | 18 | `eth_call balanceOf @ 0x8a598fe3e3a471ce865332e330d303502a0e2f52` | 822195409099172390696 | 327291947154124913 | 20 |
| 1001 | aDOT | Erc20 | 10 | `eth_call balanceOf @ 0x02639ec01313c8775fae74f2dad1118c8a8a86da` | 21160046074107825 | 309895626726434739 | 30 |
| 0 | HDX | Token | 12 | `System::Account(omnipool).data.free` | 127681014429767361487 | 238953063807131967 | 1 |
| 9001 | GSOL | Erc20 | 18 | `eth_call balanceOf @ 0xf5f744a4d14a5f49ce173e39b8361733a6e55152` | 5586749269810621575157 | 86923427950207009 | 10 |
| 39 | PAXG | Token | 18 | `Tokens::Accounts` | 92484977409116044127 | 78375736262293791 | 15 |
| 1000624 | AAVE | Token | 18 | `Tokens::Accounts` | 2747598083712688935255 | 47966073504350883 | 5 |
| 9 | ASTR | Token | 18 | `Tokens::Accounts` | 50747096750374935359237624 | 44640660107554804 | 5 |
| 35 | TRAC | Token | 18 | `Tokens::Accounts` | 782505860666666957679014 | 39618619750073774 | 3 |
| 1000771 | KSM | Token | 12 | `Tokens::Accounts` | 64416877245007359 | 36058404381979370 | 3 |
| 1000753 | SUI | Token | 9 | `Tokens::Accounts` | 194366861743927 | 25116456647058093 | 5 |
| 15 | vDOT | Token | 10 | `Tokens::Accounts` | 1025631555177157 | 24866378208610763 | 15 |
| 1000795 | SKY | Token | 18 | `Tokens::Accounts` | 2107766450598335965122910 | 23677911777701094 | 3 |
| 1000794 | LINK | Token | 18 | `Tokens::Accounts` | 10911414749230835207968 | 20398669863821579 | 3 |
| 1000796 | LDO | Token | 18 | `Tokens::Accounts` | 320592527865104727773771 | 19515292876259148 | 3 |
| 14 | BNC | Token | 12 | `Tokens::Accounts` | 5935863428351209539 | 15703332353540844 | 3.5 |
| 33 | vASTR | Token | 18 | `Tokens::Accounts` | 9332799914437815549142651 | 11881380311015147 | 2 |
| 38 | ENA | Token | 18 | `Tokens::Accounts` | 692758631970285301738071 | 11624681642379322 | 3 |

Sanity check against the two independent surfaces at the same moment: our reserve figures matched
surface C's `/explorer/omnipool` exactly for 12 of 19 assets and differed only in the last five
significant digits for the rest (block skew of a few blocks — surface C reported a snapshot ~30
blocks behind). The 5 `Erc20` assets are the ones a `Tokens::Accounts`-only reader would have missed.

### GDOT / GETH / GSOL are not what they look like

`AssetRegistry::AssetLocations` for an `Erc20` asset stores the contract as
`Location { parents: 0, interior: X1[ AccountKey20 { key: 0x… } ] }`. Following those:

- asset **420 GETH** → `0x8a598fe3…` which is the **aToken of asset 4200 `2-Pool-GETH`**
- asset **69 GDOT** → `0x34d5ffb8…` = aToken of **690 `2-Pool-GDOT`**
- asset **9001 GSOL** → `0xf5f744a4…` = aToken of **90001 `2-Pool-GSOL`**
- asset **1001 aDOT** → `0x02639ec0…` = aToken of **DOT**

So the "GIGA" assets are *money-market receipts for stableswap LP shares*. Omnipool TVL denominated
in them is therefore **the same dollars** already counted in stableswap TVL and again in money-market
supply. Any "Hydration total TVL" figure that adds those three buckets is triple-counting a real
chunk of the total — see §12.

### History

Two independent ways, both cheap:

**`omnipoolAssetsLatestTvl` returns 20 rows for a 19-asset pool.** The extra row is
`assetRegistryId: "1"` — H2O, the hub asset — and its `tvlInRefAssetNorm` is **the whole pool's TVL**,
not H2O's share. Measured at block 13,691,220:

```
hub-asset row (id 1)      = 11,549,352.33
sum of the other 19 rows  = 11,549,320.74
sum of ALL 20 rows        = 23,098,673.07     ← what a naive sum gives you
platformTotalTvl.omnipool = 11,549,320.74     ← the squid's own answer, = the 19-row sum
```

The 31.59 gap between the hub row and the 19-asset sum is rounding. **Filter out
`assetRegistryId == "1"` before summing, or you publish exactly double.** The squid's own
`platformTotalTvl` gets this right, which is the tell.

1. **Squid**, one query for a year of every asset:
   ```graphql
   { omnipoolAssetHistoricalData(
       filter:{ paraBlockHeight:{ in: [13691000, 13676600, … 365 heights …] } },
       orderBy: PARA_BLOCK_HEIGHT_DESC, first: 10000) {
       nodes { assetId paraBlockHeight tvlInRefAssetNorm } } }
   ```
   → 8,379 rows, 365 distinct heights, oldest 8,449,400, **589 ms, 853 KB**. `tvlInRefAssetNorm` is
   already USD-normalised, which saves you the pricing problem entirely.
2. **Archive RPC**, 3 calls per snapshot (`chain_getBlockHash`, `state_getKeysPagedAt`,
   `state_queryStorageAt`) — 30 days in 16.4 s. Use this to *audit* the squid, or for windows before
   block 5,000,001 where the squid has nothing.

**Needs persistent state?** No for the last ~2.3 years — the squid answers a year of daily TVL in one
call. Yes only if you want (a) pre-2024-04-28 history, or (b) sub-second page loads without a
cold-start 589 ms hit — and (b) is a cache, not a database.

---

## 5. Stableswap

`Stableswap::Pools: AssetId -> PoolInfo` — **17 pools**, 441 value bytes, 459 ms. Plus
`Stableswap::ShareIssuance` (17), `Stableswap::PoolPegs` (9), `Stableswap::AssetTradability`,
`Stableswap::PoolSnapshots`, `Stableswap::BlockFee` (**0** entries today).

Verified, decoded live:

| pool id | share token | assets | amplification | fee (‱ permill) | share issuance |
|---|---|---|---|---|---|
| 100 | 4-Pool | 10 USDT, 18 DAI, 21 USDC, 23 USDT | 320 | 200 | 413548267230179471837 |
| 101 | 2-Pool | 11 iBTC, 19 WBTC | 5 | 200 | 56100733643747929 |
| 102 | 2-Pool | 10 USDT, 22 USDC | 100 | 200 | 449209171924618648022125 |
| 103 | 3-Pool | 1002 aUSDT, 1000766 USDC, 1000767 USDT | 222 | 200 | 1018430413418651810536974 |
| 104 | 2-Pool-WETH | 20 WETH, 1007 aETH | 100 | 200 | 100000009345957242391 |
| 105 | 3-Pool-MRL | 21 USDC, 23 USDT, 222 HOLLAR | 222 | 200 | 600410882518850400079645 |
| 110 | 2-Pool-HUSDC | 222 HOLLAR, 1003 aUSDC | 222 | 200 | 1942022494261495828781584 |
| 111 | 2-Pool-HUSDT | 222 HOLLAR, 1002 aUSDT | 222 | 200 | 2149658995788052037865546 |
| 112 | 2-Pool-HUSDS | 222 HOLLAR, 1000745 sUSDS | 111 | 400 | 134168511229043755360470 |
| 113 | 2-Pool-HUSDe | 222 HOLLAR, 1000625 sUSDe | 111 | 400 | 104038576392793295188810 |
| 143 | 2-Pool-PRIME | 43 PRIME, 222 HOLLAR | 100 | 400 | 1052470789450309759848156 |
| 146 | 2-Pool-apyUSD | 46 apyUSD, 222 HOLLAR | 100 | 400 | 996518091589165548171502 |
| 690 | 2-Pool-GDOT | 15 vDOT, 1001 aDOT | 222 | 690 | 4174242816139584939308942 |
| 4200 | 2-Pool-GETH | 1007 aETH, 1000809 wstETH | 100 | 690 | 1673581315143580945205 |
| 10044 | 2-Pool-HEURC | 222 HOLLAR, 1044 aEURC | 50 | 500 | 1194901481019498224567154 |
| 10055 | 2-Pool-BIL | 55 BIL, 222 HOLLAR | 50 | 1000 | 601111374303157752454599 |
| 90001 | 2-Pool-GSOL | 40 jitoSOL, 1009 aSOL | 100 | 690 | 10997081394587731355555 |

Nine of seventeen pools have HOLLAR on one side. Stableswap **is** the HOLLAR liquidity layer.

**Pegged pools.** `Stableswap::PoolPegs` (9 entries) is the interesting one — a pool can peg to an
oracle rather than to 1:1:

```json
{"source":[{"MMOracle":"0xdee587cc569bf1fcbdcd6d1472031d225f34c307"},{"Value":["1","1"]}],
 "updated_at":13690465,"max_peg_update":120,
 "current":[["221880366038343223867867268569959774794","211214056200231531525813677839085935073"],["1","1"]]}
```

`MMOracle` means the peg is read from a money-market oracle contract — so GDOT-style pools track
vDOT's accruing exchange rate rather than assuming parity. `max_peg_update` throttles how fast the
peg may move per block. A stableswap dashboard that assumes 1:1 will misprice every pegged pool.

**Amplification is a ramp, not a number:** `initial_amplification`, `final_amplification`,
`initial_block`, `final_block`. Today every pool has initial == final (no ramp in progress), but
`Stableswap::AmplificationChanging` is a live event and the ramp must be interpolated when active.

**Reads.** Current state from chain (cheap). Volume and TVL history from the squid via
`stableswapAssetHistoricalData` / `stableswapVolumeHistoricalDataByPeriod`. **`stableswapsLatestTvl`
is broken today** (§2). Surface C `/explorer/pools` gives current stableswap TVL in USD for free.

---

## 6. HOLLAR and the HSM

### The existing platform doc is wrong about HOLLAR supply by a factor of ~557

`docs/platform/hydration.md` reports `Tokens::TotalIssuance(222)` = 20,631.55 HOLLAR and concludes
"HOLLAR is a young, small stablecoin". Re-read today, `Tokens::TotalIssuance(222)` =
**20,257.08** — same order, so the reading was right. But **it is not the supply.**

HOLLAR is an `Erc20`-typed registry asset. Its balances live in EVM storage. The Substrate-side
`Tokens::TotalIssuance` mirror is a small residue and means nothing. Verified two independent ways:

```
eth_call totalSupply() @ 0x531a654d1696ed52e7275a8cede955e82620f99a
  → 11489093528190535295145217           = 11,489,093.53 HOLLAR
```

```graphql
{ aaveFacilitators { nodes { id label
    aaveFacilitatorHistoricalDataByFacilitatorId(first:1, orderBy: PARA_BLOCK_HEIGHT_DESC) {
      nodes { bucketCapacity bucketLevel paraBlockHeight } } } } }
```

| facilitator | address | mint cap | minted (level) | as of block |
|---|---|---|---|---|
| Hydration Market | `0x8c0f3b9602374198974d2b2679d14a386f5b108e` | 12,000,000 | **10,841,503.75** | 13,690,620 |
| HOLLAR Stability Module | `0x6d6f646c70792f68736d6f640000000000000000` | 18,000,000 | **425,367.78** | 13,686,782 |
| GIGAHDX | `0x116d7bb8e4e2a4c932b4d36c115d4122dc360462` | 222,222 | **222,222.00** (at cap) | 13,661,840 |
| HOLLAR FlashMinter | `0xb3282db2fb01a9305b753ecca09bf68c45428cf4` | 100,000 | 0.00 | 13,686,782 |
| BIL | `0xef313c2baf19ce58eeb6df9c82ae41c7387afe3e` | — | — | no history rows |
| **sum of levels** | | | **11,489,093.53** | |

The facilitator sum equals the ERC-20 `totalSupply()` **to the wei**. Two independent sources, one
number. HOLLAR is an **eleven-and-a-half-million-dollar** stablecoin, not a twenty-thousand-dollar
one, and 94 % of it is minted by the money market rather than by the HSM.

This generalises: **`Tokens::TotalIssuance` is meaningless for every `Erc20`-typed registry asset.**
Verified: assets 1001 (aDOT), 420 (GETH), 9001 (GSOL) all return `0`. Read the contract.

### The HSM

`HSM::Collaterals: AssetId -> CollateralInfo` — **2 entries**, decoded live:

| collateral | pool | purchase_fee | max_buy_price_coefficient | buyback_rate | buy_back_fee | max_in_holding |
|---|---|---|---|---|---|---|
| 1002 aUSDT | 111 (2-Pool-HUSDT) | 0 | 998000000000000000 (0.998) | 100000 | 100 | 8000000000000 |
| 1003 aUSDC | 110 (2-Pool-HUSDC) | 0 | 998000000000000000 | 100000 | 100 | 8000000000000 |

Also `HSM::HollarAmountReceived` (0 entries today), `HSM::FlashMinter =
0xb3282db2fb01a9305b753ecca09bf68c45428cf4`, and constants `HollarId = 222`,
`MinArbitrageAmount = 1e15`, `FlashLoanReceiver = 0x…090a`, `PalletId = py/hsmod`.

Note the squid's `hsmCollaterals` reports **1**, the chain reports **2** — the squid keys collaterals
by ERC-20 address (`…-0xc64980e4eaf9a1151bd21712b9946b81e41e2b92`) and appears to have missed one.
**Prefer the chain for HSM collateral configuration.**

### Surface C gives the whole HOLLAR dashboard in one call

`GET /api/explorer/hollar` — 50 KB, ~200 ms:

```
price = 0.998515403377
change24h = 0.00023279193916645816
pegDeviationBps = -14.845966230000451
peg.hourly[]           n=720   {"ts":"2026-07-20 18:00:00","close":0.998955317663}
peg.within25bpsPct     = 99.86111111111111
peg.maxDevBps          = -25.219788500000504
peg.min30d = 0.99747802115   peg.max30d = 0.999567820149
supply.total           = 11509275.70904399
supply.holders         = 348
supply.inStablepools   = 4598325.10318337
supply.inOmnipool      = 2252978.90765435
supply.other           = 4657971.69820627
hsm.totalHoldingsUsd   = 425909.33607381594
hsm.collaterals[]      n=4
hsm.arbitrageDaily[]   n=60   {"date":"2026-06-21","hollarIn":0,"hollarOut":0}
hsm.tradesDaily[]      n=60
hsm.lastArb            {ts:"2026-08-19 10:28:45", direction:"in", asset: aUSDC, hollarAmount: 22.78}
pools[]                n=9    per-pool HOLLAR composition and TVL
```

`supply.total` 11,509,275.71 vs our 11,489,093.53 — 20,182 apart, ~0.18 %, consistent with the
minutes between the two reads and continuous interest accrual on the borrow facilitator.

Interesting on its own: the HSM's `hollarIn`/`hollarOut` series is **zero for most of the last 60
days** and the last arbitrage moved 22.78 HOLLAR. The peg mechanism is barely firing because the peg
is barely moving (99.86 % of hours within 25 bps). That is a finding, not a gap.

---

## 7. The money market

**There is no money-market pallet.** The 80-pallet metadata contains `Liquidation` (3 storage/calls)
and `EVM`, and nothing else. The market is Aave v3 running as EVM contracts, surfaced into Substrate
through `AssetRegistry` `Erc20` assets. It is read with `eth_call`, and the public RPC serves
`eth_call` anonymously.

### Contract addresses, all verified live

| Role | Address | How found |
|---|---|---|
| Pool (core market) | `0x1b02e051683b5cfac5929c25e84adb26ecf87b38` | labelled "HOLLAR interest · core" in surface C `/explorer/revenue/flow`; confirmed by `getReservesList()` returning 23 reserves |
| Pool (GIGAHDX market) | `0x2ce2cfff743cdb6637f4b5d351937a541b8c8923` | equals on-chain `GigaHdx::GigaHdxPoolContract`; 2 reserves |
| PoolAddressesProvider (core) | `0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691` | `ADDRESSES_PROVIDER()` on the pool |
| PoolAddressesProvider (giga) | `0x3c7d7b74bb625736b93d859e332f06df64635973` | ditto |
| **AaveProtocolDataProvider** | `0xdf18300261edff47b28c6a6adbcbcf468b52e5a5` | `getPoolDataProvider()` on the provider |
| **AaveOracle** | `0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760` | `getPriceOracle()` on the provider |
| HOLLAR token | `0x531a654d1696ed52e7275a8cede955e82620f99a` | `AssetRegistry::AssetLocations(222)` |

`Liquidation::BorrowingContract` on chain reads **null / H160::zero** — it is a `Default`-modifier
item and has never been set. Do **not** use it to find the pool; use the route above.

**Selectors were computed, not guessed.** A keccak-256 was implemented and validated against
`keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`,
`transfer(address,uint256) = 0xa9059cbb`, `totalSupply() = 0x18160ddd`. (An earlier guess of
`0x6c6f6ea4` for `getEModeCategoryData(uint8)` was wrong; the real selector is `0x6c6f6ae1`.)

### Asset ↔ EVM address convention

For a Substrate-native registry asset, the EVM address is
`0x` + 12 zero bytes + `00000001` + `u32 assetId big-endian`. Verified: asset 22 (USDC) is
`0x0000000000000000000000000000000100000016`; asset 1000765 (tBTC) is
`0x00000000000000000000000000000001000f453d`. For `Erc20`-typed assets the address is instead in
`AssetRegistry::AssetLocations(id).interior.X1[0].AccountKey20.key`.

### `getReserveData(address)` decodes as Aave v3 `ReserveDataLegacy` — 15 words

```
[0]  configuration (packed bitmap)   [8]  aTokenAddress
[1]  liquidityIndex                  [9]  stableDebtTokenAddress
[2]  currentLiquidityRate  (ray)     [10] variableDebtTokenAddress
[3]  variableBorrowIndex             [11] interestRateStrategyAddress
[4]  currentVariableBorrowRate (ray) [12] accruedToTreasury
[5]  currentStableBorrowRate         [13] unbacked
[6]  lastUpdateTimestamp (u40)       [14] isolationModeTotalDebt
[7]  id (u16)
```

Configuration bitmap layout (verified against known values — USDC decoded to 6 decimals, LTV 80.00 %):

```
bits 0–15   LTV (bps)              bits 64–79    reserve factor (bps)
bits 16–31  liquidation threshold  bits 80–115   borrow cap (whole units)
bits 32–47  liquidation bonus      bits 116–151  supply cap
bits 48–55  decimals               bits 152–167  liquidation protocol fee
bit 56 active, 57 frozen,          bits 168–175  e-mode category
58 borrowing enabled, 60 paused    bits 212–251  debt ceiling
```

### The live reserve table (23 core reserves, all fields verified)

| asset | aToken symbol | supply APY % | borrow APY % | util % | LTV | liq thr | liq bonus | e-mode | supply cap | frozen |
|---|---|---|---|---|---|---|---|---|---|---|
| 22 USDC | aHydratedUSDC | 2.905 | 5.140 | 62.83 | 80 | 90 | 103 | 1 | 12,000,000 | |
| 10 USDT | aHydratedUSDT | 2.329 | 4.733 | 54.69 | 80 | 90 | 103 | 1 | 12,000,000 | |
| 5 DOT | aHydratedDOT | 0.918 | 2.610 | 39.10 | 80 | 85 | 107 | 2 | 25,000,000 | |
| 34 ETH | aHydratedETH | 0.129 | 1.229 | 13.17 | 75 | 85 | 107 | 3 | 4,444 | |
| 44 EURC | aHydratedEURC | 0.926 | 3.479 | 29.60 | 75 | 80 | 103 | 5 | 4,000,000 | |
| 1000752 SOL | aHydratedSOL | 0.400 | 2.160 | 23.15 | 70 | 75 | 107 | 4 | 50,000 | |
| 15 vDOT | aHydratedVDOT | 0.004 | 0.212 | 2.27 | 60 | 70 | 108 | 2 | 2,222,222 | |
| 1000765 tBTC | aHydratedTBTC | 0.005 | 0.300 | 1.93 | 80 | 85 | 105 | 0 | 50 | |
| 19 WBTC | aHydratedWBTC | 0.006 | 0.349 | 2.25 | **0** | 70 | 105 | 0 | 1 | **yes** |
| 39 PAXG | aHydratedPAXG | 0.005 | 0.250 | 2.67 | 70 | 75 | 105 | 0 | 250 | |
| 43 PRIME | aHydratedPRIME | 0.001 | 0.060 | 2.25 | 85 | 88 | 107 | 0 | 15,000,000 | debt ceiling 1.2e9 |
| 46 apyUSD | aHydratedAPYUSD | 0.003 | 0.242 | 1.56 | 85 | 88 | 107 | 0 | 5,000,000 | debt ceiling 1e8 |
| **HOLLAR** (`0x531a…f99a`) | aHOLLAR | 0 | **4.402** | — | 0 | 0 | 0 | 0 | 0 | supply 0, **debt 10,964,947.65** |
| 690 GDOT | aHydratedGDOT | 0 | 0 | 0 | 69 | 75 | 107.5 | 2 | 30,000,000 | borrowing disabled |
| 4200 2-Pool-GETH | aHydrated2-POOL-GETH | 0 | 0 | 0 | 80 | 85 | 107 | 3 | 8,000 | borrowing disabled |
| 103 3-Pool | aHydrated3-POOL | 0 | 2.000 | 0 | 75 | 85 | 103.5 | 1 | 5,000,000 | borrowing disabled |
| 110/111/112/113 2-Pool-HUSD* | aHydrated2-POOL-HUSD* | 0 | 2.000 | 0 | 70 | 80 | 103.5 | 1 | 4–8 M | borrowing disabled |
| 10044 2-Pool-HEURC | aHydrated2-POOL-HEURC | 0 | 2.000 | 0 | 70 | 80 | 103.5 | 5 | 8,000,000 | borrowing disabled |
| 90001 2-Pool-GSOL | aHydrated2-POOL-GSOL | 0 | 0 | 0 | 60 | 70 | 107 | 4 | 100,000 | borrowing disabled |
| 816 SIGIL | aHydratedSIGIL | 0 | 2.000 | 0 | 85 | 88 | 107 | 0 | 1,100,000 | supply 0 |

The HOLLAR reserve is the shape of the whole design: **zero supply, eleven million of debt.** Nobody
deposits HOLLAR; it is minted into existence as debt against other collateral. That single row
explains where 94 % of HOLLAR comes from.

The GIGAHDX pool (`0x2ce2cfff…`) has 2 reserves; reserve 670 is **stHDX** with liquidityIndex and
variableBorrowIndex both exactly 1e27 (never accrued) and a 9 % rate parameter.

### e-mode — partially readable, honestly

Per-reserve **`eModeCategory` id is readable** (bits 168–175 of the configuration bitmap; values
0–5 observed, listed above), and `getReserveEModeCategory(address)` on the data provider works
(returned `2` for DOT). Categories cluster exactly as you would expect: 1 = stables, 2 = DOT/vDOT/
GDOT, 3 = ETH, 4 = SOL, 5 = EUR.

**Category *metadata* is not readable from this deployment.** `getEModeCategoryData(uint8)` returns
an all-zero struct; `getEModeCategoryLabel`, `getEModeCategoryCollateralConfig`,
`getEModeCategoryCollateralBitmap`, `getEModeCategoryBorrowableBitmap` all **revert**. So category
LTVs and human labels have to be inferred from membership, or found elsewhere.

> **Not verified:** whether a `UiPoolDataProvider` is deployed that would expose e-mode category
> data. I found `AaveProtocolDataProvider` and `AaveOracle` via the addresses provider but did not
> enumerate the provider's full ID registry.

### USD prices, free

`AaveOracle.BASE_CURRENCY_UNIT() = 0x5f5e100 = 100,000,000` → prices are **8-decimal USD**.

```
getAssetPrice(0x…0100000005)  DOT   =      77109661   → $0.771097
getAssetPrice(0x…0100000016)  USDC  =      99981615   → $0.999816
getAssetPrice(0x…0100000013)  WBTC  = 6801615705010   → $68,016.157
getAssetPrice(0x…0100000022)  ETH   =  208018333357   → $2,080.183
getAssetPrice(0x531a…f99a)  HOLLAR  =     100000000   → $1.000000  (hard-pegged in the oracle)
getAssetPrice(0x…0100000000)  HDX   =  REVERTS
```

**HDX reverts** — the Aave oracle only prices assets that are money-market reserves. And note HOLLAR
is $1.000000 exactly in the oracle while its market price is $0.9985 — the oracle hard-pegs it. Any
liquidation math you reproduce must use the oracle price, but any peg chart must not.

### Per-account health — the liquidation-risk read

`getUserAccountData(address)` on the pool works anonymously. For a real borrower (the first 20 bytes
of an account that was liquidated at block 13,690,264):

```
totalCollateralBase        = 436753887194        → $4,367.54
totalDebtBase              = 305429099818        → $3,054.29
availableBorrowsBase       = 0
currentLiquidationThreshold= 7000                → 70.00 %
ltv                        = 6000                → 60.00 %
healthFactor               = 1000977710434853599 → 1.000978
getUserEMode(address)      = 0
```

A health factor of 1.0010 — that account is 0.1 % from liquidation. This is one `eth_call` per
address. The account list comes from surface C `/explorer/money-market` (which already returns
`healthFactor` per position, sorted) or from the squid's `accountMmPositionHistoricalData`.

**Substrate AccountId32 → EVM address is truncation to the first 20 bytes** on Hydration
(`EVMAccounts` pallet). Verified by round-tripping the liquidated account above.

### Cost

| Route | Calls | Wall time |
|---|---|---|
| Full 23-reserve snapshot with APYs, caps, LTVs, aToken/debt totalSupply — `eth_call` | **70** | **1.05 s** (parallelised) |
| Same via squid, one GraphQL query | **1** | **166 ms**, 23 KB |
| `liquidation_getBorrowers` custom RPC | 1 | returns `[]`, useless (see below) |

The chain exposes `liquidation_getBorrowers`, `liquidation_isRunning`,
`liquidation_maxTransactionsPerBlock`. Verified: `isRunning=false`, `maxTransactionsPerBlock=0`,
`getBorrowers=[]`. These are the offchain-worker liquidation bot's own controls on *that node*, not a
protocol-wide borrower index. **Not usable as a data source.**

---

## 8. Liquidations

Two distinct event streams, and conflating them would double-count:

- **`mmLiquidationCalls`** — the Aave `LiquidationCall` event. **9,287 all-time; 10 in the last 24 h.**
  Fields: `accountId`, `collateralAssetId`, `debtAssetId`, `debtToCoverAmount`,
  `liquidatedCollateralAmount`, `liquidatorAccountId`, `receiveAToken`, `paraBlockHeight`.
- **`liquidationLiquidatedEvents`** — the Substrate `Liquidation::Liquidated` event emitted by
  Hydration's own liquidation pallet/bot. **8,553 all-time.** Fields: `accountId`,
  `collateralAssetId`, `debtAssetId`, **`profit`**, `paraBlockHeight`.

The three most recent of each, at blocks 13,690,262–264, are **the same three liquidations**, seen
from both sides. The liquidator on all three is
`0x6d6f646c6c71646174696f6e00…` = `modl` + `lqdation` — the protocol's own pallet account. So
Hydration self-liquidates via `Liquidation::liquidate`, and `profit` is the protocol's take
(e.g. 2,995,279,516,783,156 on a 41.6 ETH-denominated debt cover).

`8,553 / 9,287 = 92 %` of liquidation calls are the protocol's own bot; the remaining ~8 % are
third-party liquidators. That ratio is itself a chart.

Constants: `Liquidation::GasLimit = 4,000,000`, `Liquidation::HollarId = 222`,
`Liquidation::ProfitReceiver = 0x45544800e52567ff06acd6cbe7ba94dc777a3126e180b6d9…` (an `ETH\0`-prefixed
bound EVM account).

**Needs persistent state?** No. The squid holds the full history and answers a filtered window in
30 ms. History is the whole point of a liquidations chart and the squid already has it.

---

## 9. OTC

`OTC::Orders: u32 -> Order` — **78 open orders**, 5,694 value bytes, 397 ms.
`OTC::NextOrderId = 1540`. Constants: `Fee = 1,000 permill-units` (0.1 %),
`FeeReceiver = modl py/trsry`, `ExistentialDepositMultiplier = 5`.

```json
{"owner":"0x5884b8a663fe4224ec52ceba44d5c79bddc2305121e448d43f3f25bcc81c1942",
 "asset_in":1000771,"asset_out":5,
 "amount_in":"16422000000000","amount_out":"510000000000","partially_fillable":true}
```

Squid: `otcOrders` **982** all-time with `status` (`Created` / `Cancelled` / …),
`totalFilledAmountIn` / `totalFilledAmountOut`, plus `otcOrderEvents` for the fill history, and
`Swap.otcOrderFulfillment` linking a routed-trade leg back to the order it filled.

There is also `OtcSettlements` (pallet 72) — `settle_otc_order`, event `Executed`, constants
`MinProfitPercentage = 10000 perbill` (0.001 %), `ProfitReceiver = modl py/trsry`,
`MaxIterations = 40`. This is the **OTC arbitrage bot**: it settles OTC orders against the pools when
the price gap exceeds the minimum, and pays the profit to the treasury. Its `Executed` events are in
surface C's observed-events list. Worth a panel of its own — "how much did the protocol earn
arbitraging its own order book".

**State:** current book from chain (78 orders, one map read). History from squid. Nothing to persist.

---

## 10. DCA

`DCA::Schedules: u32 -> Schedule` — **36 active** on chain; `DCA::ScheduleIdSequencer = 34,969`
so ~35 k created all-time. Also `RemainingAmounts` (33), `ScheduleIdsPerBlock` (33),
`ScheduleExecutionBlock`, `ScheduleOwnership`, `RetriesOnError`, `ScheduleExtraGas`.

The decoded schedule carries the **whole route**, which is the interesting part:

```json
{"owner":"0x1493dedf1cf70f53beff5b92bad6c09949775f0c6d4b7c140bf771c46652af45",
 "period":3600,"total_amount":"4100000000","max_retries":5,
 "stability_threshold":null,"slippage":200000,
 "order":{"Sell":{"asset_in":10,"asset_out":34,"amount_in":"205000000","min_amount_out":"0",
   "route":[{"pool":"Aave","asset_in":10,"asset_out":1002},
            {"pool":{"Stableswap":111},"asset_in":1002,"asset_out":222},
            {"pool":"Omnipool","asset_in":222,"asset_out":…}]}}}
```

USDT → aUSDT (Aave wrap) → HOLLAR (stableswap 111) → … (Omnipool). Four venues in one scheduled sell.

Squid: `dcaSchedules` **29,498**, with `status`, `totalExecutedAmountIn`/`Out`, `orderType`,
`slippage`, `period`, plus `dcaScheduleExecutions`, `dcaScheduleExecutionEvents` and
`dcaScheduleOrderRouteHops` (the route, normalised into rows).

Surface C: `/explorer/asset/{id}/dcas` returns open schedules touching an asset with USD values
already computed (`valueUsd`, `budgetUsd`, `executionsDone`, `nextExecutionBlock`, `periodSeconds`).

Constants worth surfacing: `MaxSchedulePerBlock = 6`, `MinimalPeriod = 5` blocks,
`MaxNumberOfRetriesOnError = 3`, `BumpChance = 17 %`,
`MaxPriceDifferenceBetweenBlocks = 15,000 permill-units` (1.5 %) — DCA refuses to execute if the
price moved more than that since the last block, which is why `DCA.TradeFailed` exists as an event.

---

## 11. Protocol fees and revenue

Three independent things are all called "fees" and they must not be added together carelessly.

**1. Swap fees (asset fee + protocol fee).** `DynamicFees::AssetFee: u32 -> FeeEntry` — **40 entries**,
live-adjusted per block:

```json
{"asset_fee":2500,"protocol_fee":513,"timestamp":13690867}
```

Permill-style: 0.25 % asset fee, 0.0513 % protocol fee on that asset **right now**. Parameters are in
`DynamicFees::AssetFeeParameters` and `ProtocolFeeParameters` constants (min/max/decay/amplification).
**Do not assume a constant fee rate** — the whole point of the pallet is that it moves.

Squid: `swapFees` (26.4 M rows) with `assetId`, `amount`, `destinationType`, `recipientId`, joined to
the `Swap` that produced it; plus `assetSwapFeeHistoricalDataByPeriod` and
`platformTotalVolumesByPeriod` which returns fee volume alongside trade volume:

```json
{"totalVolNorm":"1652020.31","omnipoolVolNorm":"593942.30","omnipoolFeeVolNorm":"792.13",
 "stableswapVolNorm":"1054321.05","stableswapFeeVolNorm":"116.51",
 "xykpoolVolNorm":"2846.60","xykpoolFeeVolNorm":"1.72","paraBlockHeight":13691113}
```

24 h: $1.65 M volume, $910 of swap fees. 7 d: $8.37 M / $4,495. 30 d: $51.6 M / $25,359.

**2. Transaction fees.** `TransactionPayment.TransactionFeePaid`, and Hydration's `FeeProcessor`
pallet (index 207) which converts fees paid in arbitrary assets into the native one —
`FeeProcessor::HeldFees`, events `FeeReceived` / `Converted` / `ConversionFailed`. Squid:
`transactionPaymentHistoricalData`. **The `modl feeproc/` account appears as a `swapper` in
`routedTrades`** (seen live in the sample above) — this is exactly the "two thirds of trades are
pallet machinery" problem `CLAUDE.md` already records, and it applies to fee-derived revenue too.

**3. Money-market reserve factor.** Every reserve takes 10–20 % of borrow interest to the treasury:
`accruedToTreasury` in `getReserveData`, and the squid's `mmMintedToTreasuryEvents`.

**Surface C has already assembled all of this.** `GET /api/explorer/revenue?range=30d`:

```json
{"totals":{"day":2143.50,"week":14191.49,"month":65169.21,"allTime":3037218.41},
 "history":{"range":"30d","bucketSeconds":86400,
   "series":[{"stream":"omnipool_asset_fee","points":[{"t":1784505600,"usd":86.84}, …]}, …]}}
```

Streams observed include `omnipool_asset_fee`, `network_fee`, `hollar_borrow`. And
`/explorer/revenue/flow` returns a live per-event cursor feed **plus `drips`** — continuously
accruing streams expressed as a rate:

```json
"drips":[{"key":"0x1b02e051683b5cfac5929c25e84adb26ecf87b38","label":"HOLLAR interest · core",
          "stream":"hollar_borrow","usdPerBlock":0.2390500691885586},
         {"key":"0x2ce2cfff743cdb6637f4b5d351937a541b8c8923","label":"HOLLAR interest · gigahdx",
          "stream":"hollar_borrow","usdPerBlock":0.10229627424548118}]
```

Note the discrepancy worth stating on any revenue page: surface C says **$65,169 of revenue in 30
days**, while the squid's swap-fee total for 30 days is **$25,359**. They are measuring different
things (surface C includes borrow interest and network fees). Neither is wrong; a page that shows one
number must say which.

**All-time revenue $3,037,218** is a number worth its own tile — and worth an asterisk, since we
cannot see how surface C computes it.

---

## 12. LP positions and farming incentives

### Omnipool LP positions

`Omnipool::Positions: u128 -> Position` — **3,469 open**; `Omnipool::NextPositionId = 73,288`
(so ~73 k created all-time, 95 % closed). Sweeping all 3,469 costs **19 RPC calls, 6.2 s, 236 KB**.

```json
{"asset_id":14,"amount":"740198148334512","shares":"740802200460041",
 "price":["32437704601793253","3624621278220740721"]}
```

`price` is the (numerator, denominator) of the hub price **at the moment the position was opened** —
that is what makes impermanent-loss and single-sided-LP P&L computable per position, which is a
genuinely differentiated chart nobody else draws.

Positions are NFTs: `Omnipool::NFTCollectionId = 1337`, `Staking::NFTCollectionId = 2222`, both in
`Uniques`.

Squid: `omnipoolLiquidityPositions` **66,394** all-time + `omnipoolLiquidityPositionEvents`.
Surface C: `/explorer/omnipool/{assetId}/lps` gives the LP leaderboard with `sharePct`,
`farmedPositions` and identity tags — e.g. for HDX, **123 LPs / 201 positions**, and the Treasury
holds **97.04 %** of HDX Omnipool shares across 45 positions. That last figure is a whole story about
who actually provides Hydration's liquidity.

### Liquidity mining — chain only

The squid has **no farm definitions** (`omnipoolGlobalFarms` = 0, `omnipoolYieldFarms` = 0,
`xykGlobalFarms` = 0) although it has 74,515 `omnipoolYieldFarmDeposits`. Farms must be read from
chain. Two warehouse pallets, both fully decodable:

| Storage | Entries | Notes |
|---|---|---|
| `OmnipoolWarehouseLM::GlobalFarm` | **70** | 12,950 B total |
| `OmnipoolWarehouseLM::YieldFarm` | **70** | triple map (globalFarmId, yieldFarmId, assetId) |
| `OmnipoolWarehouseLM::ActiveYieldFarm` | **7** | ← only **7 farms are live** out of 70 |
| `OmnipoolWarehouseLM::Deposit` | **2,579** | 318 KB, 15 calls, 4.5 s |
| `XYKWarehouseLM::GlobalFarm` / `YieldFarm` / `ActiveYieldFarm` | 3 / 3 / 3 | |
| `XYKWarehouseLM::Deposit` | 22 | |

A live `GlobalFarm`:

```json
{"id":81,"owner":"0x6d6f646c70792f747273727900…","updated_at":28341443,"total_shares_z":"0",
 "accumulated_rpz":"529039606367523254002619","reward_currency":69,"pending_rewards":"4910",
 "accumulated_paid_rewards":"21268886004977248108624","yield_per_period":"131278538813",
 "planned_yielding_periods":1314000,"blocks_per_period":1,"incentivized_asset":1,
 "max_reward_per_period":"11783049054476712","min_deposit":"456833776462",
 "live_yield_farms_count":1,"total_yield_farms_count":1,
 "price_adjustment":"5477815291225193724212426","state":"Active"}
```

Note `reward_currency: 69` = **GDOT**. Hydration pays farm incentives in a money-market-wrapped
stableswap LP token. `owner` is the Treasury.

A `YieldFarm`:

```json
{"id":94,"updated_at":29230457,"total_shares":"11609581499523016",
 "total_valued_shares":"8215037683104601","accumulated_rpvs":"512381051604744367510040",
 "loyalty_curve":{"initial_reward_percentage":"500000000000000000","scale_coef":12000},
 "multiplier":"0","state":"Stopped","entries_count":"22",
 "left_to_distribute":"1709070570098427925200","total_stopped":0}
```

`loyalty_curve` is the thing to explain: rewards start at 50 % and ramp toward 100 % the longer you
stay. That is a chart — "effective APR by time-in-farm" — that follows directly from
`initial_reward_percentage` and `scale_coef`.

A `Deposit` carries multiple `yield_farm_entries`, so one LP position can be in several farms at once.

Note `updated_at` values (28,341,443 / 29,230,457 / 30,120,978 / 32,594,407) are **larger than the
para block height** — these are relay-chain block numbers, not parachain ones. Dating a farm from
them against parachain heights is a bug waiting to happen.

The squid's `allAssetsYieldMetrics` would give `feeApyPerc` + `incentivesApyPerc` + `incentivesTokens`
per pool in one call, but it **timed out at 5 minutes**. Compute incentive APR from chain instead.

---

## 13. Referrals

Chain only — not in the squid at all.

| Storage | Entries | Meaning |
|---|---|---|
| `Referrals::ReferralCodes` | **676** | code (bounded bytes) → account |
| `Referrals::Referrer` | **676** | account → `(Level, u128)`; sample decoded `["Tier0","0"]` |
| `Referrals::LinkedAccounts` | **16,658** | referee → referrer. **85 calls, 27.7 s, 533 KB to sweep** |
| `Referrals::TraderShares` | **13,264** | 6.0 s to enumerate keys alone |
| `Referrals::ReferrerShares` | **235** | |
| `Referrals::TotalShares` | plain | `0xbcea64d1b6ff052b…` = **3,100,134,656,477,051,426** |
| `Referrals::AssetRewards` | **0** | no per-asset override configured; defaults apply |
| `Referrals::PendingConversions` | 0 | |

Constants: `RewardAsset = 0` (HDX), `PalletId = referral`, `CodeLength = 10`, `MinCodeLength = 4`,
`RegistrationFee = (asset 0, 222,222 HDX-units, modl py/trsry)`, `SeedNativeAmount = 10,000 HDX-units`.
Events: `CodeRegistered`, `CodeLinked`, `Converted`, `ConversionFailed`, `Claimed`,
`AssetRewardsUpdated`, `LevelUp`.

**676 codes, 16,658 linked accounts** — a 24:1 fan-out. That is a real, chartable number and nobody
publishes it.

**Persistent state: YES, and this is the clearest case in the whole sweep.** There is no historical
source for referrals — the squid does not index them and the archive RPC can give you a point-in-time
answer but sweeping 16,658 keys takes 28 seconds per snapshot. "Referral network growth over time"
requires us to snapshot it ourselves on a schedule. That is one row per day of a handful of scalars
(code count, linked count, total shares) plus, if we want the leaderboard, ~700 rows.

---

## 14. Staking and GIGAHDX

Also chain only.

### `Staking` (pallet 69)

```
Staking::Staking (plain) = { total_stake: 863506179152046400197,
                             accumulated_reward_per_stake: 297672263845178591,
                             pot_reserved_balance: 171466325908943372100 }
```

At 12 decimals: **863,506,179 HDX staked**, pot 171,466,326 HDX.

`Staking::Positions` — **2,545** (15 calls, 4.6 s, 255 KB):

```json
{"stake":"8004116746339150","action_points":"150","reward_per_stake":"142855665193183290",
 "created_at":7480810,"accumulated_slash_points":"0","accumulated_unpaid_rewards":"0",
 "accumulated_locked_rewards":"0"}
```

`Staking::PositionVotes` (2,236) and `VotesRewarded` / `ProcessedVotes` tie staking rewards to
governance participation — Hydration pays you more for voting. `action_points` and
`accumulated_slash_points` are the mechanism. Constants: `PeriodLength = 7,200` blocks,
`MinStake = 1,000 HDX`, `TimePointsWeight = 1,000,000 permill-units` (0.1 %),
`ActionPointsWeight = 200,000,000 perbill-units` (20 %), `TimePointsPerPeriod = 1`,
`UnclaimablePeriods = 1`, `CurrentStakeWeight = 2`, `MaxVotes = 25`.

### `GigaHdx` (pallet 86) and `GigaHdxRewards` (87)

Newer, and absent from both the squid and the platform doc.

```
GigaHdx::TotalLocked        = 1263272454072253376663   → 1,263,272,454 HDX (12 dp)
GigaHdx::GigaHdxPoolContract= 0x2ce2cfff743cdb6637f4b5d351937a541b8c8923  (the GIGAHDX Aave pool)
GigaHdx::Stakes             = 649 entries
GigaHdx::PendingUnstakes    = 110 entries
```

```json
{"hdx":"97197373616519831957","gigahdx":"96492405777314198023","unstaking":"0","unstaking_count":0}
```

Constants: `StHdxAssetId = 670` (**stHDX**, confirmed as reserve 670 in the GIGAHDX Aave pool),
`CooldownPeriod = 403,200` blocks (**28 days** at 6 s), `MinStake = 1,000 HDX`,
`MaxPendingUnstakes = 10`, `PalletId = gigahdx!`, `LockId = ghdxlock`.

`GigaHdxRewards` pays for governance voting out of per-referendum pools:

```json
{"track_id":5,"total_reward":"236002767502620032","total_weighted_votes":"2807776747629783114801",
 "voters_remaining":130,"remaining_reward":"161236444321651361"}
```

Storage: `ReferendaTotalWeightedVotes`, `ReferendumTracks`, `ReferendaRewardPool`,
`UserVoteRecords` (611), `UserVoteCount`, `PendingRewards` (224).

Cross-check against surface C `/explorer/hdx`, which already computes the lock breakdown:

| lock type | accounts | HDX |
|---|---|---|
| Vote locks | 1,373 | 1,699,945,914 |
| GIGAHDX (28 d) | 649 | 1,278,175,820 |
| Staking | 2,545 | 865,864,507 |
| Vesting | 1 | 7,550,760 |
| Other | 24 | 411,881 |
| **total locked** | | **2,183,499,024 (55.57 % of user HDX)** |

Its GIGAHDX account count (649) and staking count (2,545) match our chain reads **exactly**, which is
a strong signal that surface C reads the same storage we would. Its `totalHdx` is 6,422,925,001.50
with `protocolHdx` 2,493,986,080.43 and `userHdx` 3,928,938,921.08 across **61,057 holders**.

**Persistent state: YES for time series.** Same argument as referrals — no historical source exists.
Daily scalars (total stake, GIGAHDX locked, position counts) are ~6 numbers a day.

---

## 15. Everything else worth knowing

### Asset registry

`AssetRegistry::Assets` — **1,437 entries** (9 calls, 1.8 s, 44 KB). `NextAssetId = 1,353`.
`AssetLocations` **680**, `Tokens::TotalIssuance` **1,248**.

The decode in `server/sources/hydration.mjs` is correct and was re-verified against live metadata
type 741 — `Option<name>, AssetType(u8), u128 ED, Option<symbol>, Option<u8 decimals>,
Option<u128 xcm_rate_limit>, bool is_sufficient`. `AssetType` = `[Token, XYK, StableSwap, Bond,
External, Erc20]`.

One nuance to add: `AssetRegistry::AssetLocations` is not only an XCM `Location` — for `Erc20`
assets it is the **EVM contract address** wrapped as `X1[AccountKey20]` with `parents: 0`. Same
storage item, two entirely different meanings, distinguished by `parents == 0`.

### Circuit breaker — a security dashboard that already exists

`CircuitBreaker` (pallet 65) has **14 storage items**. Live:

```
GlobalWithdrawLimitConfig = { limit: 100000000000000000000, window: 21600000 }   (6-hour window)
WithdrawLimitAccumulator  = [7747091624125978847, 1787159349000]
AssetLockdownState        = 54 entries, e.g. {"Unlocked":[13609149,"413548267230179471837"]}
EgressAccounts            = 11
TradeVolumeLimitPerAsset  = 0 (defaults apply)
```

Surface C `/explorer/security` renders exactly this, plus `armedAt` (block 11,998,954,
2026-04-06 11:15:12) and **`everTripped: false`**, and names the 11 egress accounts as parachain
sovereigns (Interlay, Bifrost, …). "The circuit breaker has never fired, and it is 7.87 % of the way
through its current 6-hour window" is a good, honest security tile.

### EmaOracle — the on-chain price source

`EmaOracle::Oracles` — **512 entries**, 512 ms. Triple Twox64Concat map keyed
`([u8;8] source, (u32,u32) assetPair, OraclePeriod)`.

Sources observed and counted: `hydraxyk` **214**, `stablesw` **152**, `omnipool` **142**,
`bifrosto` **4**.
`OraclePeriod` variants (from metadata type 239): `LastBlock, Short, TenMinutes, Hour, Day, Week` —
period bytes present are `0x00` (142), `0x01` (142), `0x02` (142), `0x04` (86). **`Hour` (0x03) and
`Week` (0x05) are not stored** — only LastBlock, Short, TenMinutes and Day.

An entry decodes to `(OracleEntry, u32)`:

```json
[{"price":{"n":"176562824445718227201731520635556","d":"256268451033352876126108567726305512863"},
  "volume":{"a_in":"0","b_out":"0","a_out":"0","b_in":"0"},
  "liquidity":{"a":"622885842286901","b":"723259793672112125451"},
  "shares_issuance":null,"updated_at":5969519}, 5884967]
```

Price is an **exact rational**, not a float. Many `hydraxyk` entries are stale (`updated_at`
5,969,519 vs head 13.69 M) — dead XYK pools whose oracles were never cleaned up. **Filter on
`updated_at` before trusting an EmaOracle price.**

For USD, the Aave oracle (§7) is easier where it has coverage, and the squid's
`assetLatestSpotPrices` / `assetSpotPriceHistoricalData` easier still — verified:
`{"assetInId":"5","assetOutId":"10","price":"776212302699716277","paraBlockHeight":13691067}`
(DOT/USDT, 18-dp fixed point).

### The rest of the 80 pallets, briefly

`Signet` (84, 9 calls / 9 events — cross-chain signature requests, `solana-signet-program` exists in
the org), `EthDispenser` (85 — gas faucet), `Bonds` (71, 5 live bonds mapping `assetId -> (u32, u64)`),
`LBP` (73, **0 pools** — dormant), `Duster` (61), `Dispatcher` (40, `AaveManagerCallDispatched` /
`TreasuryManagerCallDispatched`), `Parameters` (83, `IsTestnet` / `RelayParentOffsetOverride`),
`EVMAccounts::NttMinters` (11 entries mapping assetId → minter contract — the Wormhole NTT bridge).

### ICE — still not real, re-confirmed

`CLAUDE.md` says ICE has no pallet. Re-verified against today's metadata blob: the strings `ICE`,
`Ice`, `Intent`, `Solver`, `Solution` occur **zero times** in 535,081 bytes of runtime metadata, and
none of the 80 pallet names match. `Broadcast` still has exactly one event, `Swapped3`, and three
storage items (`IncrementalId`, `ExecutionContext`, `Swapper`). The note stands.

---

## 16. What needs persistent state, and what does not

| Capability | Source | Persistent state needed? |
|---|---|---|
| Omnipool TVL per asset, now | squid `omnipoolAssetsLatestTvl` (32 ms) or chain (3-path read) | **No** |
| Omnipool TVL history, 1 year daily | squid, **one query, 589 ms** | **No** — cache only |
| Omnipool TVL history before 2024-04-28 | archive RPC, 3 calls/snapshot | **No** — but slow, so cache |
| Stableswap pools + pegs + amplification, now | chain (17 entries, 459 ms) | **No** |
| Stableswap TVL history | squid `stableswapAssetHistoricalData` (`stableswapsLatestTvl` is broken) | **No** |
| Money market: reserves, APY, utilisation, LTV, caps, e-mode ids | squid (1 query, 166 ms) **or** 70 `eth_call`s (1.05 s) | **No** |
| Money market history (rates, config changes) | squid `mmReserveIndexesHistoricalData` / `mmReserveConfigHistoricalData` | **No** |
| Per-account health factor | `eth_call getUserAccountData` (1 call/account) + account list from surface C | **No** |
| Liquidations, full history | squid (9,287 + 8,553 rows) | **No** |
| HOLLAR supply, facilitators, peg | squid `aaveFacilitators` + ERC-20 `totalSupply()`; surface C for the 720-hour peg series | **No** |
| HSM collateral config | chain (2 entries) — squid undercounts | **No** |
| OTC book now / OTC history | chain (78) / squid (982) | **No** |
| DCA active / history | chain (36) / squid (29,498) | **No** |
| Swap volume, fee revenue by period | squid `platformTotalVolumesByPeriod` | **No** |
| Routed trades (deduplicated) | squid `routedTrades` — **replaces our hand-rolled grouping** | **No** |
| Protocol revenue by stream | surface C `/explorer/revenue` | **No** |
| Omnipool LP positions + entry prices | chain (3,469, 6.2 s) | **No**, but cache — 6 s is too slow for a page load |
| Farms: global/yield farm definitions, loyalty curves | **chain only** — squid has none | **No** for current; **YES** for "incentives over time" |
| Farm deposits | chain (2,579) or squid (74,515 historical) | **No** |
| **Referrals: codes, links, shares** | **chain only**, 28 s to sweep `LinkedAccounts` | **YES** — no history anywhere; must snapshot |
| **Staking + GIGAHDX totals and positions** | **chain only** | **YES** for time series; no for now-values |
| Circuit-breaker state | chain, or surface C `/explorer/security` | **No** |
| HDX holder cohorts / lock breakdown | surface C `/explorer/hdx` | **No** |

**The persistent-state footprint is small.** Only three domains genuinely need it — referrals,
staking/GIGAHDX, and farm incentives over time — and each is a handful of scalars per day plus an
optional leaderboard. A year of daily rows for all three is on the order of **a few hundred thousand
rows at most, single-digit MB**. That is a SQLite file, not a datastore.

The larger driver for persistence is **latency, not history**: `platformTotalVolumesByPeriod(_30D_)`
is 2.7 s, a full LP-position sweep is 6.2 s, a `Referrals::LinkedAccounts` sweep is 28 s. Those need
to be precomputed and served from something, but "something" can be a warm in-process cache plus a
periodic writer, which is what the existing TTL+single-flight cache already almost is.

---

## 17. Traps, in one place

1. **Omnipool reserves need three different reads.** `Tokens::Accounts` alone drops HDX and every
   `Erc20` asset — 5 of 19, including the two largest. TVL comes out ~50 % low and renders fine.
2. **`Tokens::TotalIssuance` is meaningless for `Erc20` assets.** HOLLAR reads 20,257 there and
   11,489,094 from the contract. The current platform doc has this wrong.
3. **`totalCount` on the squid's per-block tables costs 3–25 s or times out.** Always filter first.
4. **`stableswapsLatestTvl` is broken on the deployed squid today** (`column
   sahd.pool_historical_data_id does not exist`).
5. **`allAssetsYieldMetrics` did not return within 5 minutes.**
6. **The squid's `/rest/service/metadata` reports `maxTime: 2026-01-29`.** That field is stale; the
   data is current to the block. Do not use it as a freshness check — use `blocks(orderBy: HEIGHT_DESC)`.
7. **The documented squid URL (`galacticcouncil.squids.live/hydration-pools:unified-prod`) is dead.**
   The live one was only discoverable by watching the app's network traffic. It could move again;
   whatever we build should fail loudly, and `orca-prod-pool-02.catfish.hydration.cloud` is a
   working second host with an identical schema.
8. **The squid's history starts at block 5,000,001 (2024-04-28)**, not genesis.
9. **The public Subsquid archive `v2.archive.subsquid.io/network/hydradx` is ~93 days behind.**
10. **Liquidations appear in two tables.** 92 % of `mmLiquidationCalls` are the protocol's own bot
    (`modl lqdation`) and also appear as `liquidationLiquidatedEvents`. Summing both double-counts.
11. **The Aave oracle prices HOLLAR at exactly $1.000000** while its market price is $0.9985. Correct
    for liquidation math, wrong for a peg chart.
12. **`getAssetPrice` reverts for non-reserve assets** (HDX among them).
13. **Farm `updated_at` values are relay-chain block numbers**, larger than the parachain height.
14. **Many `EmaOracle` entries are stale** — dead XYK pools with `updated_at` around block 5.9 M.
15. **GDOT / GETH / GSOL are money-market receipts for stableswap LP shares.** Adding Omnipool +
    stableswap + money-market TVL triple-counts them. The squid's own `platformTotalTvl` does exactly
    that sum: `66,618,294 = 11,555,007 omnipool + 18,530,549 stablepools + 187,710 xyk +
    36,345,028 mmSupply`. Surface C reports `totalTvlUsd: 30,306,276` for pools only and
    `totalSupplyUsd: 40,090,454` for the market separately. **Two published "Hydration TVL" numbers
    that differ by 2.2×, both defensible.** Whatever we show must say which one it is.
16. **`Liquidation::BorrowingContract` is unset (H160 zero).** Find the pool via the revenue-flow
    labels or the addresses provider, not via that storage item.
17. **`liquidation_getBorrowers` returns `[]`.** It is a node-local bot control, not a borrower index.
18. **Surface C embeds user-authored text and remote image URLs.** Render as text nodes; the icons
    point at `cdn.jsdelivr.net` and will be blocked by our `img-src 'self'`.
19. **Surface C is one person's server with no stated terms.** Treat as best-effort.
20. **Orca is POST-only** — no CDN-cacheable GET queries.
21. **`omnipoolAssetsLatestTvl` returns 20 rows for a 19-asset pool**, and the extra row
    (`assetRegistryId: "1"`, the H2O hub asset) carries **the whole pool's TVL**. Summing all rows
    publishes exactly 2× the real number: 23,098,673 instead of 11,549,321, verified at block
    13,691,220. Drop asset 1 before summing. The same hub row appears in
    `omnipoolAssetHistoricalData` — verified: 20 rows at block 13,691,220 summing to the same
    23,098,673.07 — so it poisons the 365-day TVL query too.
22. **The squid's `assetId` is a mixed-type key.** In `omnipoolAssetHistoricalData` it is the numeric
    registry id for `Token` assets (`"0"`, `"39"`, `"1000765"`) and the **EVM contract address** for
    `Erc20` assets (`"0x531a654d…"` for HOLLAR, `"0x02639ec0…"` for aDOT). `omnipoolAssetsLatestTvl`
    carries both `assetId` and `assetRegistryId`; `omnipoolAssetHistoricalData` carries only
    `assetId`. Joining historical TVL to the asset registry therefore needs the
    `AssetLocations` → `AccountKey20` mapping from §4, not a numeric cast.

---

## 18. Endpoint appendix

```
# Official squid (PostGraphile, POST only, CORS *)
https://orca-prod-pool-01.orca.hydration.cloud/graphql
https://orca-prod-pool-02.catfish.hydration.cloud/graphql
https://orca-prod-pool-01.orca.hydration.cloud/rest/service/metadata

# Substrate RPC — full archive, 168 methods incl. eth_* and archive_v1_*
https://rpc.hydradx.cloud                    (~360 ms/call)
https://hydration-rpc.neckwork.net           (~42 ms/call)
# others the app uses: hydration-rpc.n.dwellir.com, hydration.rotko.net,
# subway.{sin,coke,shellfish}.hydration.cloud, rpc-catfish-{1..4}.catfish.hydration.cloud

# Community explorer REST API (CORS *, nginx-cached, no observed rate limit)
https://hydration-explorer.neckwork.net/api/explorer/*
https://hydration-explorer.neckwork.net/api/assets
https://hydration-explorer.neckwork.net/api/health

# Generic archive (already in use)
https://explorer.hydradx.cloud/graphql

# EVM explorer (Blockscout v5.2.2-beta) — note: API is on blockscout.*, UI on explorer.*
https://blockscout.evm.hydration.cloud/api/v2/*

# Raw archive for building your own indexer (lags ~93 days)
https://v2.archive.subsquid.io/network/hydradx

# Asset metadata CDN used by both the app and the explorer
https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/assets-v2.json
https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@master/chains-v2.json

# Key EVM contracts
0x1b02e051683b5cfac5929c25e84adb26ecf87b38   Aave Pool (core)
0x2ce2cfff743cdb6637f4b5d351937a541b8c8923   Aave Pool (GIGAHDX)
0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691   PoolAddressesProvider (core)
0xdf18300261edff47b28c6a6adbcbcf468b52e5a5   AaveProtocolDataProvider
0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760   AaveOracle (8-dp USD)
0x531a654d1696ed52e7275a8cede955e82620f99a   HOLLAR
0xb3282db2fb01a9305b753ecca09bf68c45428cf4   HOLLAR FlashMinter
0x8c0f3b9602374198974d2b2679d14a386f5b108e   facilitator "Hydration Market" (= aHOLLAR aToken)
```

Source repos: [`galacticcouncil/hydration-data-lake`](https://github.com/galacticcouncil/hydration-data-lake)
(the squid, Apache-2.0), [`galacticcouncil/hydration-node`](https://github.com/galacticcouncil/hydration-node),
[`galacticcouncil/money-market`](https://github.com/galacticcouncil/money-market),
[`galacticcouncil/hollar`](https://github.com/galacticcouncil/hollar).

`docs.hydration.net` documents **no public API** — checked `/` and `/devs`. Every endpoint above was
found by reading bundles, CSP headers, repo READMEs and live network traffic, not from documentation.
That is worth remembering: none of this is contractual.
