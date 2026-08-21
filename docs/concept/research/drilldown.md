# Drill-down and XCM value — feasibility notes

Research sweep for the v2 concept. Everything below was verified with live requests on
**2026-08-19** unless a line says otherwise. Where a claim could not be checked it is marked
**UNVERIFIED** rather than smoothed over.

Three questions:

1. Can `/hyperfx/` show the individual orders behind a day, and the orders of one address?
2. Can we recover XCM **value** where Dotlake's `total_value_usd` is zero?
3. What data would drive an XCM flow picture, and how big is the graph?

The short answers: **yes, trivially**; **yes, and the situation is worse than we documented —
the aggregate is not only a floor, it is sometimes a wildly inflated ceiling**; and **26 nodes /
107 edges over 30 days, which wants a deterministic circular or matrix layout, not physics**.

> **Marked 2026-08-21: all three shipped, and this sweep's second answer became the design.**
> `/hyperfx/` has the order table and per-address filtering; `dotlake/xcm-value` reads row-level
> records under three exclusion rules and names every excluded row on the page; `/xcm/` draws
> `matrix` first and `flowGraph` second, both deterministic. The "not only a floor" finding is now
> in CLAUDE.md's facts list and in
> [data-sources.md](../../platform/data-sources.md#dotlake). Read the rest of this file as the
> derivation rather than as a proposal.

---

## 1. HyperFX transaction-level view

### Endpoint

`POST https://nexus.indexer.polytope.technology/` — GraphQL, anonymous, no key, CORS `*`,
`cache-control: public, max-age=5`, served behind Caddy. Responses carry a `query-complexity`
header (a trivial query reports `1`; the full history query below reports `35`), so there is a
budget, but nothing we want to do comes close to it.

The indexer is SubQuery (`indexerNodeVersion: 6.5.0`, `queryNodeVersion: 1.0.11`) and indexes
**13 chains**, not five. `_metadatas` reports each one's health and height:

```
42161 ethereum        496236290 / 496236290  healthy   (Arbitrum)
8453  ethereum         50185092 /  50185092  healthy   (Base)
137   ethereum         92303002 /  92303002  healthy   (Polygon)
56    ethereum        116886083 / 116886083  healthy   (BNB)
1     ethereum         25790567 /  25790567  healthy   (Ethereum)
10    ethereum        155780377 / 155780377  healthy   (Optimism)
100   ethereum         47808799 /  47808799  healthy   (Gnosis)
1868  ethereum         27012389 /  27012389  healthy   (Soneium)
420420419 ethereum     19651304 /  19651304  healthy   (Polkadot Hub testnet id)
Hyperbridge (Nexus)   11541995 /  11541996  healthy
Bifrost Polkadot      12862770 /  12862770  healthy
Cere Mainnet Beta     26842737 /  26842737  healthy
Argon                   875183 /    875183  healthy
```

`_metadata` / `_metadatas` is a ready-made **freshness and health line** for the page — we
currently assert nothing about whether the indexer is caught up.

### Schema surface

The root `Query` type has **237 fields** and the schema has **1,060 object types** (mostly
PostGraphile-style aggregate/connection boilerplate). The entities that carry real rows:

| Entity | rows (2026-08-19) | what it is |
|---|---:|---|
| `iOrderV3s` | **754** | the intent orders we already read |
| `iOrderV3Fills` | 607 | who filled an order, when, on which chain, with which assets |
| `iOrderV3PartialFills` | 11 | partial fills, same shape |
| `iOrderV3StatusMetadata` | 2,114 | the **status timeline** per order, each with its own tx hash |
| `iOrderV3EscrowReleases` | 607 | escrow released to the filler |
| `iOrderV3EscrowRefunds` | 138 | escrow refunded to the user (matches the 138 `REFUNDED` orders) |
| `fillerBids` | **6,936** | the filler auction — ~9 bids per order, over 3,769 distinct commitments |
| `requestV2s` | 2,949 | ISMP requests (the messaging layer under the orders) |
| `getRequestV2s` | 31 | ISMP GET requests |
| `responseV2s` | 0 | empty |
| `stateMachineUpdateEvents` | **1,865,455** | consensus state updates relayed between chains |
| `relayerV2s` / `relayerStatsPerChainV2s` | 18 / 32 | relayers and their per-chain delivery stats |
| `relayerActivities` | 18 | |
| `transfers` | 1,159 | |
| `hyperBridgeStats` | 11 | per-chain message counters |
| `phantomOrderV2s` / `phantomOrderLegs` | 3,444 / 50,080 | a *different* product (Phantom orders) — not HyperFX intents |
| `liquidityPools` | 16 | |
| `vaultSnapshots` | 630 | |
| `userActivityV2s` | 50 | per-address rollups |
| `dailyVolumeUSDs` | 486 | per-day/per-chain/per-role USD rollups |
| `cumulativeVolumeUSDs` | 43 | per-contract cumulative USD |
| `intentGatewayTokenVolumes` | 17 | **per-chain token registry with decimals** |
| `tokenPrices` / `tokenPriceLogs` | **0 / 0** | tables exist, are empty |
| `rewards` | 117 | |

### `IOrderV3` — the full field list

We currently read 8 of these. The ones we do not read are in **bold**.

```
id              String      order id == commitment
user            String      lowercase 0x address of the trader
sourceChain     String      "EVM-8453"
destChain       String      "EVM-8453"
commitment      String      == id
deadline        BigFloat    block height the order expires at
nonce           BigFloat
fees            BigFloat    raw units of the input token
session         String      per-order session key address (754 distinct — one per order)
inputUSD        BigFloat    the indexer's own USD valuation. See the warning below.
status          OrderStatus PLACED | FILLED | REDEEMED | REFUNDED
predispatchCalldata  String
postDispatchCalldata String
referrer        String      32-byte word, ASCII-packed
createdAt       Datetime
blockNumber     BigFloat
blockTimestamp  BigFloat
transactionHash String      the placement tx (754 distinct)
── relations ──
inputAssets{ token, amount, index }
outputAssets{ token, amount, index }
fills{ id, chain, filler, timestamp, blockNumber, transactionHash, inputAssets, outputAssets }
partialFills{ …same shape… }
statusMetadata{ status, chain, timestamp, blockNumber, transactionHash, filler }
escrowRefunds{ chain, timestamp, transactionHash, tokens }
escrowReleases{ …same… }
predispatchAssets{ … }
```

A real order, fetched live:

```json
{
  "id": "0xe5d3c75ea7a76a031e8b78605cbbb09e91da870f19cd2f230b951ede9bfdae3d",
  "user": "0x3c43ad0f71bb11ba2cc9466c2c8614bbb2589d3d",
  "sourceChain": "EVM-8453", "destChain": "EVM-8453",
  "deadline": "50183253", "nonce": "489", "fees": "25350",
  "session": "0x8Ed50D523dB299F2fF2D87Ac3aDea272A70573E7",
  "inputUSD": "822", "status": "FILLED",
  "referrer": "0x4879706572465800000000000000000000000000000000000000000000000000",
  "createdAt": "2026-08-19T16:09:01", "blockTimestamp": "1787155741",
  "transactionHash": "0x1782b3652c8164bd243489fcba791b4a516332b498f57e605c74c457b59f072d",
  "inputAssets":  { "nodes": [{ "token": "0x…833589fcd6edb6e08f4c7c32d4f71b54bda02913", "amount": "822588500", "index": 0 }] },
  "outputAssets": { "nodes": [{ "token": "0x…46c85152bfe9f96829aa94755d9f915f9b10ef5f", "amount": "1145865780500", "index": 0 }] },
  "fills": { "totalCount": 1, "nodes": [{
      "filler": "0x18f23e630077b1dA3eD97C0469d0504a93FAd9e2",
      "chain": "8453", "timestamp": "1787155813",
      "transactionHash": "0xf168e32aa924831babf42ff8f593989a7ec4ea149aa53505316374fa5daa1012" }] },
  "statusMetadata": { "totalCount": 3, "nodes": [
      { "status": "PLACED",   "timestamp": "1787155741", "filler": null,        "transactionHash": "0x1782b365…" },
      { "status": "FILLED",   "timestamp": "1787155813", "filler": "0x18f23e63…", "transactionHash": "0xf168e32a…" },
      { "status": "REDEEMED", "timestamp": "1787155813", "filler": null,        "transactionHash": "0xf168e32a…" }] },
  "escrowReleases": { "totalCount": 1 }, "escrowRefunds": { "totalCount": 0 }, "partialFills": { "totalCount": 0 }
}
```

Note `fills[].chain` is `"8453"` (bare chain id) where the order says `"EVM-8453"`. Two
namespaces for the same thing; a joiner that assumes one form silently matches nothing.

### Filtering — everything Tommi asked for, server-side

`iOrderV3s` accepts `first, last, after, before, offset, orderBy, filter, distinct,
orderByNull, blockHeight`. `IOrderV3Filter` exposes `and / or / not` plus a typed filter on
**every scalar column** and on every relation. `BigFloatFilter` has
`equalTo notEqualTo isNull in notIn lessThan lessThanOrEqualTo greaterThan greaterThanOrEqualTo
distinctFrom notDistinctFrom`. Verified live:

| Question | Filter | Result |
|---|---|---|
| this address's orders | `{user: {equalTo: "0x3c43ad…"}}` | 13 orders |
| …case-insensitively | `{user: {likeInsensitive: "%3C43AD0F%"}}` | 13 orders (same set) |
| one day's orders | `{blockTimestamp: {greaterThanOrEqualTo: "1787097600", lessThan: "1787184000"}}` | 14 orders |
| refunded only | `{status: {equalTo: REFUNDED}}` | 138 orders |
| **orders filled by this market maker** | `{fills: {some: {filler: {equalTo: "0x18f23e63…"}}}}` | 4 orders |

Nested relation filters work. `orderBy` includes `INPUT_U_S_D_DESC`, `BLOCK_TIMESTAMP_ASC/DESC`
and every other column.

`user` is stored lowercase; `filler` is stored **checksummed (mixed case)**. `equalTo` is
case-sensitive, so an address drill-down must either normalise or use `likeInsensitive`.

### Server-side aggregation — no paging needed for the rollups

Connections expose `aggregates { count distinctCount sum min max average stddev* variance* }`
and `groupedAggregates(groupBy: [...])`. The `IOrderV3GroupBy` enum includes
`CREATED_AT_TRUNCATED_TO_DAY` and `CREATED_AT_TRUNCATED_TO_HOUR`.

```graphql
{ iOrderV3s { groupedAggregates(groupBy: [SOURCE_CHAIN]) {
    keys sum { inputUSD fees } distinctCount { id } } } }
```

```
EVM-8453  561 orders   inputUSD 486520
EVM-56    107 orders   inputUSD  39196   fees 3140539795579859261  ← 18-dec chain, raw units
EVM-1      42 orders   inputUSD  11009
EVM-137    41 orders   inputUSD   6695
EVM-42161   3 orders   inputUSD    765
```

Daily counts come back the same way with `groupBy: [CREATED_AT_TRUNCATED_TO_DAY]` — one request
for the whole daily series. **Do not sum `fees` across chains**: it is raw token units and BNB
Chain is 18 decimals, so a cross-chain sum is meaningless (the number above is 3.14 × 10¹⁸).

### `inputUSD` — do not use it

The indexer values orders itself, and it is **worse than what we already compute**.

- **419 of 754 orders (55.6 %) have `inputUSD = 0`.** None are `null`.
- It is only populated at all from **2026-07-17** onward (`min(blockTimestamp)` for
  `inputUSD > 0` is 2026-07-17T12:09:47Z; the order history starts 2026-06-02).
- Even after that date, **208 of 543** orders are zero — including plain USDC on Base and a
  17,991,000 cNGN order (worth roughly $12,900 at the rate implied by its own neighbours).
- Where it is populated it is correct and integer-valued: 89,955,000 cNGN → `inputUSD` 64,408,
  implying 1,397 NGN/USD.
- `tokenPrices` and `tokenPriceLogs`, the tables that would explain it, are **empty (0 rows)**.

Sum of all `inputUSD` = **544,185**. Our derived-rate figure will be materially higher, and the
difference is not an error on our side. Keep `src/core/pricing.js`; expose `inputUSD` only as a
labelled comparison column if at all.

### `intentGatewayTokenVolumes` — a live decimals registry

Seventeen rows, `(chain, tokenAddress, tokenSymbol, decimals, volumeType, amount)`:

```
EVM-1     USDC   6   0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
EVM-1     USDT   6   0xdac17f958d2ee523a2206206994597c13d831ec7
EVM-137   USDC   6   0x3c499c542cef5e3811e1192ce70d8cc03d5c3359
EVM-137   USDT0  6   0xc2132d05d31c914a87c6611c10748aeb04b58e8f   ← we label this "USDT"
EVM-42161 USDC   6   0xaf88d065e77c8cc2239327c5edb3a432268e5831
EVM-56    USDT  18   0x55d398326f99059ff775485246999027b3197955
EVM-56    USDC  18   0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d
EVM-8453  USDC   6   0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
EVM-8453  USDT   6   0xfde4c96c8593536e31f229ea8f37b2ada2699bb2
EVM-8453  cNGN   6   0x46c85152bfe9f96829aa94755d9f915f9b10ef5f
EVM-8453  ZARP  18   0xb755506531786c8ac63b756bab1ac387bacb0c04
```

This **independently confirms the whole hardcoded `TOKENS` table in
`server/sources/hyperbridge.mjs`**, including the BNB-is-18-decimals trap. It also names the
Polygon USDT as `USDT0`. It does not list `EXT` (no volume yet), so it cannot fully replace the
table — but reading it and *diffing against ours* turns "a new token silently prices at zero"
into a loud mismatch. That is the same self-check discipline as `decodeAssetDetails`.

### Cost

The **entire** order history with fills, status timeline and both asset legs is
**one request, 1,067,114 bytes, 1.37 s, `query-complexity: 35`**. `first: 1000` is accepted;
the 200-row paging in `hyperbridge.mjs` is conservative and can stay.

Growth: 754 orders over 65 active days (2026-06-02 … 2026-08-19) = 11.6/day; the last 14 days
average **16.5/day**. At 20/day a full year is ~7,300 orders ≈ 10 MB — still one in-memory blob
well inside the 256 MB ceiling.

**Verdict: the HyperFX drill-down needs no persistent state at all.** A day view, an address
view, an order-detail view and a filler view are all either a filtered GraphQL query (fresh, no
storage) or a slice of the one blob we already fetch every 5 minutes. This is the cheapest item
on the whole v2 list.

Things we could show that we do not: the **filler auction** (6,936 bids, 9 per order — who bid
and who won), the **status timeline** with per-step tx hashes, **partial fills**, **escrow
refund vs release**, **latency** (place → fill; in the sample above, 72 s), and the **13
distinct fillers** as a competitive landscape. `fillerBids.filler` includes Substrate addresses
(e.g. `12ETLkKVJeBQZgh6ikhBmiYtb7q1pSKsucgNCcUGRSQ98v5A`), so the bidder set spans both sides of
the bridge. `bidData` is ~8.5 kB of hex calldata per bid — do not fetch it for a list view.

Distinct counts across all 754 orders: **50 users**, 754 sessions, 6 referrers, 5 source chains,
4 dest chains, 13 fillers (in fills), 9 fillers (in bids).

---

## 2. XCM value transferred

### The OpenAPI document

`GET https://api.data.parity.io/openapi.json` — 129,110 bytes, OpenAPI 3.1.0, `Dotlake API`
v0.1.1, **50 paths**. `security: [{}, {"BearerAuth": []}]` — the empty first alternative means
anonymous is a supported mode, which is what we already rely on.

Three XCM row endpoints, all `GET`, all anonymous, `cache-control: public, max-age=15`:

**`/api/xcm-transfers`** — "Returns XCM transfer rows from `daily_etl.xcm_transfers`."
Filters: `relay_chain, origin_chain, dest_chain, account` (origin **or** dest, raw or SS58),
`asset_symbol, xcm_type, outcome, message_hash, message_id, origin_extrinsic_hash, start_date,
end_date, limit` (default 50, **max 500**, 501 → HTTP 422), `offset`. Ordered newest first.

**`/api/xcm-transfers-count`** — same filter set, returns `{"count": n}`.

**`/api/xcm-transfer`** — single message by `message_hash` / `message_id` /
`origin_extrinsic_hash`; adds `xcm_msg`, `origin_event_data`, `dest_event_data`.

### The row shape — asset and amount ARE there

`XcmTransfer`, 31 fields:

```
relay_chain  origin_chain  dest_chain  origin_para_id  dest_para_id
xcm_type  xcm_version  message_hash  message_id
origin_account  dest_account  dest_ss58_account
asset_symbol  asset_name  asset_decimals  asset_price
value          # "Asset amount in human units (raw / 10^decimals)"
value_usd      # "value * asset_price"
raw_amount     # string
origin_block_number  origin_timestamp  origin_extrinsic_hash
dest_block_number    dest_timestamp    dest_block_hash  dest_author_id
outcome  match_status  latency_seconds  date
```

A live row (2026-08-18):

```json
{
  "relay_chain": "polkadot", "origin_chain": "hydradx", "dest_chain": "statemint",
  "origin_para_id": "2034", "dest_para_id": "1000",
  "xcm_type": "HRMP", "xcm_version": "v4",
  "message_hash": "0x8effcec9e41415c694ff917e7bb5fd5146022c0e2eba231ea0a19554509c23a4",
  "message_id":   "0x60f91e18d30c421e7a609af947e94a662c27110c70cc5d2a66d7187854b4339c",
  "origin_account": "5D5CXBbHWDxUQktVLy5U5xNfyC7tbK1ppHWjQVZrSoo7TgTK",
  "dest_ss58_account": "121VfWrMN1DwrHu1Jc8UE7Cppp7YHcZxtnFDZnZCztpdeHDX",
  "asset_symbol": "USDC", "asset_decimals": 6,
  "asset_price": 0.999922039193865,
  "value": 1156.189092, "value_usd": 1156.0989545663433, "raw_amount": "1156189092",
  "origin_timestamp": "2026-08-18T23:07:36.000", "dest_timestamp": "2026-08-18T23:08:48.000",
  "outcome": "Success", "match_status": "matched", "latency_seconds": 72, "date": "2026-08-18"
}
```

`value_usd == value * asset_price` held for **202 / 202** priced rows on the day tested, zero
mismatches. So `value_usd` adds nothing we cannot recompute — the useful columns are
`asset_symbol`, `asset_decimals`, `raw_amount` and `value`.

### At the row level, `null` is honoured — and that changes the story

Full pull of Polkadot 2026-08-18 (629 rows, 2 requests, 650 kB):

| field | non-null | |
|---|---:|---|
| `message_id` | 629 | 100 % |
| `latency_seconds` | 498 | 79.2 % |
| `origin_extrinsic_hash` | 260 | 41.3 % |
| `origin_account` | 254 | 40.4 % |
| `asset_symbol` | 213 | 33.9 % |
| `raw_amount` | 215 | 34.2 % |
| `value` | 213 | 33.9 % |
| `asset_price` / `value_usd` | 202 | 32.1 % |

`value_usd == 0` occurred **zero** times; the 427 missing values are **`null`**. The `0.0`
problem lives in the *aggregate* endpoints, which collapse `null → 0` before we ever see it.

Of the 629 messages, **416 carry no asset at all** — coretime UMP, HRMP control traffic, and so
on. There is nothing to value there and it is not a gap. Of the 213 that do carry an asset, 202
were priced by Dotlake and 11 were not (9 × NEURO, 2 × AJUN).

Asset breakdown for that day:

```
(no asset) 416    DOT 101   USDC 27   USDT 25   BNC 17   vDOT 14
NEURO 9 (unpriced)   ASTR 6   MYTH 5   ETH 3   vASTR 3   AJUN 2 (unpriced)   KSM 1
```

### But the price feed has whole-day holes

Sampling `asset_symbol=DOT` one day at a time, ten rows each:

```
2026-08-18  priced (DOT $0.7509)      2026-08-11  ALL NULL
2026-08-17  ALL NULL                  2026-08-10  ALL NULL
2026-08-16  ALL NULL                  2026-08-09  priced ($0.7987)
2026-08-15  ALL NULL                  2026-08-08  priced ($0.8147)
2026-08-14  priced ($0.7643)          2026-08-07  priced ($0.8181)
2026-08-13  priced ($0.7722)          2026-08-06  priced ($0.8209)
2026-08-12  ALL NULL                  2026-08-05  priced ($0.8417)
```

**Six of the last seventeen days have no price for DOT at all.** It is not asset-shaped, it is
day-shaped: a day is either fully priced or fully unpriced. Pulling 2026-08-11 in full confirms
it — 799 rows, 306 with an asset, **0 priced**.

Across the last 53 days for which Dotlake has data, **10 days report `total_value_usd = 0`**
while carrying 500–1,350 messages each: 2026-07-20, 07-24, 07-25, 07-26, 08-10, 08-11, 08-12,
08-15, 08-16, 08-17.

### And there is a seven-day hole in the ETL itself

`2026-07-09` … `2026-07-15` return **`count: 0`** from `/api/xcm-transfers-count` and `[]` from
`/api/xcm-daily-stats`. Both neighbours are normal (07-08: 819 messages, 07-16: 1,331). XCM did
not stop for a week — Dotlake simply has no rows. Over the two years 2024-08-19 … 2026-08-18:
**723 of 730 days present, 7 missing entirely, 10 present but valueless — 17 blind days, 2.3 %.**

Any state we build must store "we have no data for this day" as a distinct value from "no
messages that day", and must be able to re-check later in case Dotlake backfills.
**UNVERIFIED: whether Dotlake ever backfills those days.**

### The finding that changes our data note: the aggregate is also catastrophically HIGH

`CLAUDE.md` says `total_value_usd` "is `0.0` for anything it cannot price … Treat it as a
floor." The first half is right at the aggregate level. **The second half is wrong.**

Summing `/api/xcm-daily-stats` for polkadot over two years gives **$39,917,060,621,977,640** —
forty quadrillion dollars. **74 of 723 days (10.2 %) report $1 billion or more.** The median day
is $1.86 M. The 649 days below $1 B sum to $18.8 B, which is the plausible number.

Traced to individual rows. Worst day, 2024-10-01, route `hydradx→statemint`, 69 messages,
$1.7998 × 10¹⁶ — and it is **one row**:

```json
{ "asset_symbol": "USDT", "asset_decimals": 6,
  "raw_amount": "18000000190000000000000",
  "value": 18000000190000000, "asset_price": 0.999885722381212,
  "value_usd": 17997943192840102,
  "message_hash": "0x241051dbe5529f55e168c78ce6ed00aa28327b991824b3350a9f401c2613e67c",
  "xcm_type": "HRMP", "outcome": "Success" }
```

Second-worst day, 2025-06-27, route `statemint→laos`, **one message**:

```
USDC  asset_decimals=6  raw_amount=9515000000000000000000  value=9.515e15  value_usd=9.5142e15
```

Both are exactly **10¹² out**: an 18-decimal raw amount divided by 10⁶. The true figures are
about 18,000 USDT and 9,515 USDC. This is precisely the bug `CLAUDE.md` already records for
HyperFX — *"keying decimals by symbol rather than by chain is a factor-of-a-trillion error that
renders perfectly"* — except here it is in Dotlake, on the origin side, and it has been silently
inflating the ecosystem-wide XCM value figure for two years.

**Consequence for us:** any value we compute from these rows needs a per-asset sanity ceiling
(a single message worth more than, say, the asset's total issuance is not a message, it is a
decoding error) and rows that trip it must be reported as *amount not trusted*, not dropped
silently and not summed. `null` is not `0`, and neither is 1.8 × 10¹⁶.

### Can we price the rest ourselves?

The assets Dotlake left unpriced across the three days sampled: NEURO, AJUN, PEN, UNQ, CFG,
LDOT — plus **everything** on the price-outage days, DOT and USDC included.

Two anonymous paths, both already in the repo:

1. **USD-pegged assets are $1** — `USD_PEGGED` in `src/core/pricing.js`. That alone recovers
   USDC and USDT rows on outage days. On 2026-08-18 those were 52 of 213 asset-bearing rows.
2. **Derive the rest from Hydration swap legs** — `deriveRates()` already takes a median over
   observations and sweeps repeatedly for multi-hop assets. Hydration's `AssetRegistry.Assets`
   has **1,437 entries**, verified live over `https://rpc.hydradx.cloud` via
   `state_getKeysPaged` + `state_queryStorageAt`; every symbol on the unpriced list —
   NEURO, AJUN, DOT, USDT, USDC, PEN, UNQ, CFG, EWT, MYTH, ASTR, BNC, vDOT, KSM, ETH, LDOT,
   vASTR, GLMR, INTR, H2O — appears in the registry blob.

   **Caveat, and it matters:** that check was a substring search over the concatenated SCALE
   values, so it proves *registration*, not that the symbol decodes to exactly that asset, and
   certainly not that the asset **traded** in the window. A rate only exists if there are swap
   legs against a priced asset. Expect a long tail of registered-but-untraded assets that stay
   unpriceable. **UNVERIFIED: how many of the XCM assets actually trade on Hydration in a given
   window.**

A third path, cheaper and worth having regardless: **build a daily price series out of Dotlake's
own `asset_price` on the days it has one**, and forward-fill across the outage days. DOT moved
0.75–0.86 over the sampled fortnight, so a forward-fill over a 3-day gap is a few percent wrong
— which is a stated caveat, not a silent zero. This needs persistent state (a small
`asset × date → price` table), but it is the smallest state in the whole v2 plan: ~20 assets ×
730 days = 14,600 rows.

### Cost

| | |
|---|---|
| bytes per row, as served | **1,031** |
| bytes per row, keeping the 14 fields we need | 268 |
| …gzipped | **62** |
| bytes per row, route+asset+value only | 83 (7 gzipped) |
| Polkadot messages/day (2026-08-18) | 629 |
| Kusama messages/day | 392 |
| both relays, 30 days | ~43,700 rows ≈ 45 MB served, **88 requests**, ~60 s |
| both relays, incremental daily | ~1,021 rows, **3 requests** |
| all time, both relays | **2,497,746 rows** (polkadot 1,851,505 + kusama 646,241) |
| all-time backfill | ~2.57 GB served, **4,996 requests** at limit=500 |
| all-time stored slim + gzip | **~0.16 GB** |

Deep pagination works: `offset=100000` returns 200 in 1.78 s. History goes back at least to
2023 (2023 full year: 152,107 polkadot messages).

**Verdict: yes, we can value XCM ourselves**, and doing so is the only way to get a number that
is neither a silent undercount (10 blind days in 53) nor a quadrillion-dollar overcount (74 days
in 723). It needs persistent state — the row corpus for whatever window we commit to, plus the
price series. A 30-day rolling window fits in memory today (45 MB); anything longer wants a
datastore.

---

## 3. XCM flow visualisation — the data, not the picture

### What drives it

`GET /api/xcm-daily-stats?relay_chain=…&start_date=…&end_date=…&group_by_route=true` returns
one row per `(date, origin_chain, dest_chain)`:

```json
{ "date": "2026-08-18", "relay_chain": "polkadot",
  "origin_chain": "hydradx", "dest_chain": "statemint",
  "total_messages": 92, "completed_messages": 92, "failed_messages": 0,
  "total_value_usd": 34720.84257233477 }
```

That is a directed, weighted edge list with a date dimension, in **one request**. Dotlake's own
parameter documentation for `/api/xcm-top-routes` says `matched_only` is
*"Recommended for Sankey-style flow chart"* — they built this for exactly our purpose.

It has one fatal limitation: **`total_value_usd` inherits every problem in section 2**, and at
route granularity it cannot be repaired, because the aggregate has already collapsed `null → 0`
and already summed in the 10¹²-inflated rows. **A flow picture built on `xcm-daily-stats` alone
would draw a $0 edge for hydradx→ajuna (which carried real AJUN) and, on the wrong window, an
edge worth more than the world economy.**

So the honest driver is **our own aggregation over `/api/xcm-transfers` rows**, which lets each
edge carry four separate quantities that must not be added together:

| per edge, per window | meaning |
|---|---|
| `messages` | exact. Always available. |
| `valueUsd` | sum over rows we could price. A **floor**. |
| `unpricedWithAmount` | count of rows with an asset and an amount but no rate |
| `noAsset` | count of rows carrying no asset (nothing to value — not a gap) |
| `untrusted` | count of rows failing the sanity ceiling |

### Size of the graph

Verified, `group_by_route=true`:

| window | relay | daily-route rows | **nodes** | **edges** |
|---|---|---:|---:|---:|
| 30 d (2026-07-20 … 08-18) | polkadot | 1,143 | **26** | **107** |
| 30 d | kusama | 481 | **14** | **46** |
| 2 y (2024-08-19 … 2026-08-18) | polkadot | 53,839 | 42 | 321 |
| 2 y | kusama | 19,666 | 28 | 179 |

Polkadot, 30 days — edge count by threshold:

```
>=1 msg  107      >=25  39      >=100  26
>=5       75      >=50  33      >=500  14
>=10      64
```

57 of the 107 edges have `total_value_usd > 0`; **50 edges carry 2,473 messages at a reported
value of exactly zero.**

Node degree (distinct neighbours, 30 d, polkadot):

```
statemint 38   hydradx 26   moonbeam 22   polkadot 15   bifrost 13   astar 11
acala 10   coretime 9   interlay 8   pendulum 6   origintrail 5   frequency 5
mythos 4   polkadot-bridgehub 4   energywebx 4   unique 4   centrifuge 4
people 3   manta 3   ajuna 2   collectives 2   jamton 2   xode 2   robonomics 1   darwinia 1
```

Busiest edges, 30 d:

```
coretime → polkadot   5,506 msgs   $0            ← control traffic, correctly valueless
statemint → hydradx   3,782        $3,185,764
hydradx → statemint   3,041        $2,977,947
moonbeam → hydradx    2,728        $15,542
bifrost → hydradx     1,759        $949,867
bifrost → moonbeam    1,666        $86
statemint → (null)    1,252        $531,544      ← missing endpoint
hydradx → moonbeam      753        $18,541
bifrost → statemint     719        $2,320,766
polkadot → moonbeam     664        $0
```

**A node named "unknown" is unavoidable.** 123 daily-route rows carrying **2,310 messages
(8 % of the window)** have a null `origin_chain` or `dest_chain` — `match_status` is
`sent_only` or `received_only`. Dropping them loses 8 % of traffic and quietly rebalances every
remaining edge. Draw the node.

### What layout the data shape needs

External libraries are forbidden, so this is hand-rolled SVG. The data says:

- **n = 26 nodes, m = 107 edges** for the default 30-day Polkadot view. Worst case, all-time
  both relays, n ≈ 70, m ≈ 500. Both are small.
- The topology is **hub-and-spoke, not uniform**: statemint has degree 38, hydradx 26,
  moonbeam 22, and 11 of 26 nodes have degree ≤ 4. Nine nodes have degree ≤ 3.
- Edges are **directed and both directions usually exist** (statemint↔hydradx, hydradx↔moonbeam,
  bifrost↔statemint). Volume is asymmetric, so direction must be visible.
- Node set **changes over time** — the all-time list has 42 chains including recent arrivals
  (jamton, xode, xcavate) and departures (parallel, sora, litentry). A hand-maintained position
  table will go stale.

Which rules things out and in:

| approach | verdict |
|---|---|
| **Sankey** | Wrong. Sankey needs a DAG; XCM is cyclic. Would require splitting every chain into an origin node and a dest node — 52 boxes for 26 chains, and each chain appears twice. Dotlake recommends it; the data does not support it. |
| **Fixed hand-placed positions** | Rejected. The node set is not stable, and a stale table means a new parachain either overlaps something or is dropped. |
| **Force-directed** | Possible but wrong for this site. At n=26 a naive O(n²) Fruchterman–Reingold is 676 pairs × ~300 iterations ≈ 200 k operations — free. The objection is not cost, it is **nondeterminism**: the same data would draw a different picture on every load, on a site whose whole premise is stating facts. Seeding the RNG fixes reproducibility but not the arbitrariness of the result. |
| **Chord / circular arc diagram** | **Recommended.** Nodes on a circle ordered by total volume (or a barycentre pass to reduce crossings), edges as quadratic Béziers through the centre. Fully deterministic, needs only trigonometry, handles direction via arc asymmetry or a gradient, and degenerates gracefully — an edge with unknown value can be drawn thin-and-dashed rather than omitted. 107 arcs on a 26-point circle is legible if the long tail is thresholded (26 edges at ≥100 messages carry most of the picture). |
| **Origin × destination matrix** | **Recommended as the companion, and possibly as the primary.** 26 × 26 = 676 cells, zero layout algorithm, every route visible including the empty ones, and it is the only form where "n messages, value unknown" reads naturally as a distinct cell state rather than as an absent edge. It also honours the house rule that empty is drawn, not dropped. |

The honest recommendation is **matrix first, chord second**: the matrix cannot lie about a
missing edge, and the chord diagram is the one people will screenshot. Both are pure arithmetic
over the same aggregated edge list.

### The honest failure mode

When value is unpriceable, an edge must not be drawn at zero width, because zero width is
indistinguishable from no route. The four counters above are the answer: **encode messages as
the primary channel (always exact) and value as a secondary channel that can be explicitly
absent** — a hatched or outlined edge meaning "n messages moved, we cannot say what they were
worth". On the 30-day Polkadot graph that is 50 of 107 edges under Dotlake's own numbers, and
would be far fewer under our own pricing, but it will never be zero.

---

## Endpoints touched

| endpoint | method | notes |
|---|---|---|
| `https://nexus.indexer.polytope.technology/` | POST GraphQL | anonymous, CORS `*`, `max-age=5`, `query-complexity` header |
| `https://api.data.parity.io/openapi.json` | GET | 129 kB |
| `https://api.data.parity.io/api/xcm-transfers` | GET | limit ≤ 500 |
| `https://api.data.parity.io/api/xcm-transfers-count` | GET | |
| `https://api.data.parity.io/api/xcm-transfer` | GET | detail incl. `xcm_msg` |
| `https://api.data.parity.io/api/xcm-daily-stats` | GET | `group_by_route=true` |
| `https://api.data.parity.io/api/xcm-summary` | GET | |
| `https://api.data.parity.io/api/xcm-top-routes` | GET | |
| `https://rpc.hydradx.cloud` | POST JSON-RPC | `state_getKeysPaged`, `state_queryStorageAt` |
| `https://explorer.hydradx.cloud/graphql` | POST GraphQL | 15 root fields, all Subsquid generic (`events`, `calls`, `extrinsics`, `blocks`, `metadata`) — no asset entity |

None required a credential.

## Incidental observation

`https://analytics.cypherpunk.agency/api` returned **HTTP 502** at 17:05 UTC on 2026-08-19, as
did `/api/hydration/swaps`. Recorded because it blocked a planned cross-check of our own derived
rates against Dotlake's asset list, not as a diagnosis — the cause was not investigated and
belongs to whoever is looking at deployment.

## Claims I could not verify

- Whether Dotlake backfills its missing days (2026-07-09 … 07-15) or whether they are permanent.
- Whether the 10¹²-inflated rows are a bounded historical bug or still occurring; I confirmed the
  mechanism on two days and did not scan all 2.5 M rows.
- How many of the XCM assets actually **trade** on Hydration in a given window, which is what
  decides whether `deriveRates` can price them. Registry presence was verified; tradedness was not.
- Whether `dailyVolumeUSDs` in the nexus indexer (486 rows, ids like
  `IntentGatewayV3.USER.EVM-8453.2026-08-19`, values in 1e18 fixed point) is a reliable daily
  series. The 2026-08-19 USER row reads 223,933.8 against a grouped `inputUSD` sum of 227,914 for
  the same day — close but not equal, and the field is named `last24HoursVolumeUSD` while being
  keyed by date, which is two different things.
- Whether the nexus indexer imposes a request-rate limit. A `query-complexity` header exists; no
  limit was hit and no `429` was seen in ~40 requests.
