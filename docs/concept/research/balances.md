# Live balances and top holders — what is actually possible, anonymously

Research sweep for v2. Everything below was **measured on 2026-08-19**, not recalled. Where a
number is an extrapolation from a sample, it says so and shows the sample. Where something could
not be verified it is in [Unverified](#unverified).

Two questions were asked:

1. **How much DOT each parachain sovereign account holds today, and across its lifetime** — the
   parachain-netflows chart, live, instead of frozen at April 2023.
2. **Top accounts on Asset Hub by DOT, by USDT, by USDC** — a holder leaderboard.

Both are answerable, anonymously, with no API key. The costs are wildly different from each other
and one of the three leaderboards is largely meaningless as a "top holders" list once you look at
the distribution.

---

## 0. The finding that reorders everything: DOT no longer lives on the relay chain

The Asset Hub Migration completed on **2025-11-04**. Verified by binary search on
`Balances::TotalIssuance` at historical block hashes on both chains:

| chain | block | UTC | `Balances::TotalIssuance` |
|---|---|---|---|
| relay | #28,493,732 | 2025-11-04T12:25:06Z | 1,001,164,757.395 DOT |
| relay | #28,493,733 | 2025-11-04T12:25:12Z | 999,890,103.984 DOT |
| Asset Hub | #10,257,722 | 2025-11-04T12:58:48Z | 998,558,157.648 DOT |
| Asset Hub | #10,257,723 | 2025-11-04T12:58:54Z | 1,000,888,810.248 DOT |

The migration ran as a sustained drain, not a single extrinsic — coarse samples:

```
RELAY   #28,400,000  2025-10-28  issuance 1,631,551,402 DOT
RELAY   #28,500,000  2025-11-04  issuance       150,172 DOT
AH      #10,200,000  2025-10-31  issuance    11,296,633 DOT
AH      #10,300,000  2025-11-07  issuance 1,633,942,476 DOT
```

**Today (2026-08-19):**

| | relay chain | Polkadot Asset Hub |
|---|---|---|
| `Balances::TotalIssuance` | **243,526.59 DOT** | **1,698,775,805.26 DOT** |
| `Balances::InactiveIssuance` | 2,225.08 DOT | 27,236,432.57 DOT |
| `System::Account` entries | **1,493** (full sweep, exact) | **≈ 3,893,120** (4/256 shards) |
| sum of relay `System::Account` free+reserved | 221,869.05 DOT | — |

So: **every balance question about Polkadot is now an Asset Hub question.** A v2 that reads the
relay chain for DOT balances would render a confident, empty, wrong page. The relay's 1,493
remaining accounts are pallet accounts, sovereign dust and leftovers.

Head heights at the time of the sweep: relay #32,625,019, Asset Hub #19,651,051, both
`spec 2003002`, client `1.24.1-8ae9775dc43`.

---

## 1. Endpoints: what answers anonymously and what does not

### Substrate RPC (the workhorse)

| endpoint | reachable | archive (state at old blocks) |
|---|---|---|
| `https://rpc.polkadot.io` | yes | **YES — genesis to head** |
| `https://polkadot-asset-hub-rpc.polkadot.io` | yes | **YES — genesis to head** |
| `https://polkadot.api.onfinality.io/public` | yes | yes (verified at relay #10,000,000) |
| `https://rpc-polkadot.luckyfriday.io` | yes | yes (verified at relay #10,000,000) |
| `https://polkadot-rpc.publicnode.com` | yes | **NO** — `4003 UnknownBlock: State already discarded` |
| `https://polkadot-rpc.dwellir.com` | HTTP 503 | — |
| `https://polkadot.public.curie.radiumblock.co/http` | HTTP 522 | — |
| `https://1rpc.io/dot` | HTTP 200, `-32600 Not Allowed` | — |
| `rpc.ibp.network`, `sys.ibp.network`, `*.dotters.network` | **DNS did not resolve** from this machine | — |
| `polkadot.rpc.subquery.network`, `asset-hub-polkadot-rpc.dwellir.com`, `asset-hub-polkadot.rpc.permanence.io` | fetch failed | — |
| `https://polkadot-people-rpc.polkadot.io` | yes (`Polkadot People`) | not tested |

The archive test that matters, verbatim:

```
$ state_getStorage(twox128("Balances")+twox128("TotalIssuance"), hash_of_block_10_000_000)
rpc.polkadot.io          -> 0x12305718d26ca6a40000000000000000     (ok)
polkadot-rpc.publicnode  -> {"code":4003,"message":"Client error: UnknownBlock:
                             State already discarded for 0x6c5137763210…"}
```

Asset Hub archive verified at #1, #100, #10,000, #100,000, #500,000 … #18,000,000 —
`ParachainInfo::ParachainId = 0xe8030000` (= 1000) and a valid `state_getReadProof` at **block 1**.
The archive is complete; there is no pruning cliff.

**⚠ Trap:** `Timestamp::Now` is **absent on Asset Hub before roughly block 1,000,000**
(2022-04-04). `state_getKeysPaged` under the whole `Timestamp` prefix at AH #100,000 returns `[]`.
`state_getStorage` returns `null`, not an error — so a naive date index silently dates every early
Asset Hub block to 1970. SQD reports `timestamp: 0` for the same blocks, confirming this is on-chain
reality and not an archive gap.

### RPC methods available on the Parity public nodes (117 on AH, 130 on relay)

| method | status | use |
|---|---|---|
| `state_getKeysPaged` | **works**, max 1000/page | key discovery, sharding |
| `state_getKeysPagedAt` | listed | — |
| `state_getKeys` (unpaged) | **works** — 757 keys / 82 KB returned for `Assets::Asset` | fine on small maps, do not point at `System::Account` |
| `state_queryStorageAt(keys[], at?)` | **works**, ≥500 keys per call accepted | the batch value read |
| `state_getStorage(key, at)` | **works at any historical hash** | historical point reads |
| `archive_v1_storage` (**WebSocket only**) | **works** — `descendantsValues` streams key+value under any byte prefix | the bulk sweep |
| `archive_v1_storage` over HTTP POST | `-32603 Internal error` | subscription method; must be WS |
| `archive_v1_storageDiff` | **exposed but non-functional** — see below | — |
| `state_getPairs` | `4003 RPC call is unsafe to be called externally` | blocked |
| `state_queryStorage` (block-range form) | `4003 RPC call is unsafe to be called externally` | blocked on both chains |

`archive_v1_storageDiff` was tested five times: 10-block gap, 100-block gap, 300-block gap and
600-block gap, on both `System::Account` and the USDT prefix, up to 180 s each. One run emitted 24
`storageDiff` events over a 300-block gap and never finished; every other run returned an
operation id and then **nothing at all — no events, no `done`, no error**. **Do not design around
it.** The incremental path is SQD (§4).

### SQD Portal — `https://portal.sqd.dev` — anonymous, no key, decoded substrate events

This is the find of the sweep. 200 datasets, including `polkadot` and `asset-hub-polkadot`, both
`start_block: 0`:

```
GET /datasets/polkadot/metadata            -> {"dataset":"polkadot","real_time":false,"start_block":0}
GET /datasets/polkadot/head                -> {"number":32624949, …}      (≈360 blocks behind)
GET /datasets/asset-hub-polkadot/head      -> {"number":19650399, …}      (≈1,400 blocks ≈ 1 h behind)
```

`POST /datasets/asset-hub-polkadot/stream` with a JSON query returns NDJSON, one line per block,
events already decoded with named arguments:

```json
{"header":{"number":19600004,"hash":"0x70e399…","timestamp":1787042712000},
 "events":[{"extrinsicIndex":2,"name":"Balances.Transfer",
            "args":{"from":"0xca6cba86…","to":"0x8ebb5cfe…","amount":"10000000"}}]}
{"header":{"number":19600019,…},"events":[{"name":"Assets.Transferred",
            "args":{"assetId":1337,"from":"0x4bc8000f…","to":"0x60fb5333…","amount":"50000000"}}]}
```

A single stream response is capped at ~24,200 blocks / ~1.38 MB, so long ranges page by
`fromBlock = last_returned + 1`. It returns HTTP **529 `rate_limit_error / overloaded`** under load
(hit once during this sweep; a plain retry succeeded). Treat 529 as an ordinary state.

### Everything else

| source | verdict |
|---|---|
| **Subscan** | **disqualified.** `polkadot.api.subscan.io` → `{"code":403,"message":"Subscan API strictly requires an API key. Unauthenticated access is disabled."}` on every path, including `/api/scan/metadata`. |
| **Statescan** `polkadot-api.statescan.io` | anonymous and live for chain stats (`/overview` → `latestHeight:32625333`, matches our RPC head) but its **account index is stale and pre-AHM**: the top account reports 7,005,709 DOT while the relay's entire issuance is 243,526 DOT. It also decodes the modern `AccountData` with the **pre-2023 schema** — `feeFrozen` comes back as `1.70e38`, which is the `flags` field (`0x80000000…`) misread as a balance. No Asset Hub instance found (`statemint-api.statescan.io` resolves but 404s on `/accounts`, `/assets`, `/chain`). **Unusable for a live leaderboard.** |
| **Subsquid legacy** | `polkadot.explorer.subsquid.io` does not resolve; `squid.subsquid.io/gs-explorer-polkadot/graphql` → nginx 404; `v2.archive.subsquid.io/network/polkadot-mainnet` → `unknown dataset`. Superseded by the SQD Portal above. |
| **Blockscout** `blockscout-asset-hub.parity-chains-scw.parity.io` | live and anonymous, and `/api/v2/addresses` *does* return a top-addresses-by-balance list — but it is the **EVM/revive view only**: `total_addresses: 6,334`, `total_transactions: 21,020` against 3.89M substrate accounts. Balances are in 18 decimals. Good for "top EVM accounts on Asset Hub", useless for a DOT leaderboard. `assethub-polkadot.blockscout.com` 404s. |
| **sub.id** | `sub.id` does not resolve. |
| **Parity Dotlake** | see §2. |

---

## 2. Parity Dotlake: the full path list, and what it does *not* have

`GET https://api.data.parity.io/openapi.json` → 200, 129,110 bytes, `Dotlake API 0.1.1`,
`security: [{}, {"BearerAuth": []}]` — the empty first alternative means auth is optional, still
true. **50 paths.** We currently use 15. The full list:

```
daily-uptime  daily-tps  daily-fees  daily-opengov-referenda-results
daily-staking-participation  daily-staking-rewards  daily-summary  coretime-utilization
defi-tvl  daily-usdc  daily-usdt  monthly-active-validators  monthly-opengov-participation
monthly-opengov-tokens  monthly-percent-staked  monthly-treasury-balances
monthly-unique-accounts  contracts-deployed-heatmap  contract-calls-heatmap
contracts-search  contract-transactions-search  code-by-owner  contracts-with-code
contract-call-details  coretime-sales  coretime-sale-metrics  coretime-purchases
coretime-renewals  coretime-account-spend  coretime-total-burn  coretime-regions
coretime-region-events  coretime-region-history  opengov-voter-history
opengov-parent-bounty-summary  opengov-child-bounties
explorer/network-stats  explorer/recent-extrinsics  explorer/recent-events
explorer/domain-activity  explorer/block/{block_number}  explorer/extrinsic/{extrinsic_hash}
explorer/account/{address}/summary  explorer/search
xcm-transfers  xcm-transfers-count  xcm-transfer  xcm-summary  xcm-daily-stats  xcm-top-routes
```

**There is no balances endpoint, no holders endpoint, and no per-account balance anywhere.** The
three that sound like they might be, tested anonymously:

- **`/api/explorer/account/{address}/summary`** — activity only, no balance:
  ```
  GET /api/explorer/account/15oF4uVJwmo4…/summary
  {"chain":"polkadot","address":"15oF4uVJwmo4…","total_txs":55,
   "first_seen":"2023-12-16T18:40:36","last_seen":"2025-10-10T13:13:12",
   "top_pallets":["balances","vesting","xcmPallet"]}
  ```
  It indexes **relay-chain extrinsic signers only**. The Treasury (`13UVJyLnbVp9RB…`) and
  Hydration's sovereign account both return `404 Account not found`, with or without
  `chain=polkadot_asset_hub`. Not a balances source; possibly useful as an "is this a person"
  signal on a leaderboard.

- **`/api/monthly-treasury-balances`** — real, anonymous, per-asset, monthly:
  ```
  [{"month":"2026-07-31","chain":"polkadot_asset_hub","asset":"DOT","balance_token":25075549.43,…},
   {…"asset":"USDC","balance_token":4174147.35},{…"asset":"USDT","balance_token":7581321.46},
   {…"asset":"MYTH","balance_token":0.0},{…"asset":"aDOT","balance_token":304.33}]
  ```
  Treasury only, and it **disagrees with the chain**: on-chain today the `modl py/trsry` account
  holds 3,706,949.91 USDt, against Dotlake's 7,581,321.46 for 2026-07-31. Either 19 days of
  outflow or Dotlake aggregates several treasury-controlled accounts. Unresolved — see
  [Unverified](#unverified).

- **`/api/xcm-transfers`** — anonymous, 500 rows max, `account` / `asset_symbol` / `start_date` /
  `end_date` / `origin_chain` / `dest_chain` filters, plus `/api/xcm-transfers-count`. Rows carry
  `raw_amount`, `value`, `value_usd`, `asset_symbol`, both block numbers, both timestamps, and
  `dest_account` as **raw hex** — which independently confirms the sovereign derivation below:

  ```json
  {"dest_account":"0x7369626cf2070000000000000000000000000000000000000000000000000000",
   "dest_ss58_account":"13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6",
   "asset_symbol":"DOT","raw_amount":"5000000000","value":0.5,"outcome":"Success"}
  ```

  `0x7369626c` = `sibl`, `f2070000` = 2034 LE = Hydration. But the `account` filter is nearly
  useless for sovereign flows: `xcm-transfers-count?account=13cKp89Uh2yW…` returns **`{"count":1}`**,
  because most rows record the beneficiary rather than the reserve account. Use
  `origin_chain`/`dest_chain` + `asset_symbol`, not `account`.

  It is also a partial `para_id → chain name` registry: 500 recent rows yielded 13 distinct pairs
  (`1000=statemint 1002=polkadot-bridgehub 1004=people 1005=coretime 2000=acala 2006=astar
  2030=bifrost 2034=hydradx 2043=origintrail 3369=mythos 3397=jamton`, plus `3377=` **blank**).
  Not a complete registry — see [Unverified](#unverified).

---

## 3. Goal 1 — sovereign accounts: derivation, verification, live numbers

### The prefix scheme, verified three ways

A parachain's sovereign account is a 32-byte AccountId built as:

```
relay chain view  : b"para" ++ u32_LE(para_id) ++ [0u8; 24]     = 0x70617261 ‖ id ‖ zeros
sibling chain view: b"sibl" ++ u32_LE(para_id) ++ [0u8; 24]     = 0x7369626c ‖ id ‖ zeros
```

Verified:

1. **Against this repo's own frozen dataset.** `src/data/netflows.json` gives Acala the address
   `13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy`; `ss58(b"para" ++ 2000_LE ++ zeros, 0)`
   produces exactly that string. ✓
2. **Against Dotlake**, which returns `0x7369626cf2070000…` ↔
   `13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6` for Hydration. ✓
3. **Against the chain** — every derived key resolves to a real `System::Account` entry with
   plausible balances (below). ✓

Hashing was done with this repo's own `src/core/codec/{blake2b,xxhash,ss58}.js`. **The
`Blake2_128Concat` half must be BLAKE2b with a 16-byte digest, not BLAKE2b-512 truncated** — the
two differ, because the digest length is mixed into BLAKE2b's parameter block. Using the truncation
produced keys that resolved to `null` for all 89 accounts and looked exactly like "these accounts
are empty". Cost an hour. The repo's `blake2b.js` header already warns about this; heed it.

### The current parachain set

`Paras::Parachains` returns only **3** ids (`[1002, 1004, 1005]`) — under agile coretime almost
everything is lifecycle `Parathread` with a broker-assigned core, so that storage item is the wrong
one to enumerate. The right one is **`Paras::ParaLifecycles`**: **89 registered paras**, one
`state_getKeysPaged` page (8.3 KB) plus one batched value read (3.7 KB) — 2 requests total.

```
1000 1001 1002 1004 1005 1010 2000 2002 2003 2006 2007 2008 2013 2015 2018 2019 2021 2025 2026
2027 2028 2030 2031 2032 2034 2035 2037 2038 2040 2043 2046 2048 2051 2052 2053 2055 2056 2058
2086 2090 2091 2092 2093 2094 2097 2101 2104 3333 3334 3336 3338 3341 3342 3344 3345 3346 3353
3354 3356 3360 3366 3367 3369 3370 3374 3375 3377 3378 3388 3393 3395 3396 3397 3403 3404 3405
3406 3407 3408 3415 3417 3419 3421 3424 3425 3426 3428 3429 3442
```

Lifecycles: `1002, 1004, 1005 = Parachain`; the other 86 = `Parathread`. **Para 2004 (Moonbeam) is
not in the set** — see [Unverified](#unverified). A *lifetime* chart needs the union of all para ids
ever registered, which this storage item does not contain (it is current state only).

### Live balances — one request per chain, 89 accounts

`state_queryStorageAt([89 keys])` — **89 keys, one call, ~22 KB, ~300 ms**:

```
### relay `para` accounts   — 41/89 exist,  total free      23,676.86 DOT
### Asset Hub `sibl` accounts — 44/89 exist, total free   9,896,679.43 DOT
```

Asset Hub `sibl`, top of the list (free DOT, block `0xbbc321c2…`):

| para | address | free DOT |
|---|---|---|
| 2034 | `13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6` | 4,518,713.28 |
| 2000 | `13cKp89Msu7M2PiaCuuGr1BzAsD5V3vaVbDMs3YtjMZHdGwR` | 3,007,770.54 |
| 2030 | `13cKp89TtYknbyYnqnF6dWN75q5ZosvFSuqzoEVkUAaNR47A` | 2,168,724.62 |
| 2006 | `13cKp89P5dSS97HR8gme172QkfBaMDXK5rYHegYGH7m6yxhA` | 101,230.27 |
| 3367 | `13cKp88n27dzGussks75PWsnuKzQf4iMJSee31yvDBVvWDmU` | 46,200.51 |
| 2092 | `13cKp88o1zkKMvPyFeAbQqermahkmMyFRMvgzgjEfS6t1fBd` | 16,901.76 |
| 2032 | `13cKp89UHns9eDQQV3CZ1seFH6QQ6bnVeLHe4SpsekeJse1r` | 8,970.20 |
| 2040 | `13cKp89VtmJboAps452NZLkp49hjFVFUS24D7J9NP6v4gdaN` | 7,609.95 |
| 2104 | `13cKp88qRTQVbMXf7BuKj3KhwAekVhAibtaYZxhykxWWjKbq` | 6,673.27 |
| 2025 | `13cKp89StSUt1NukjdrTfbAkbfmV65FdxMjteCfwWhQXHTAf` | 5,634.91 |

Relay `para`, what is left: 2034 = 20,957.81, 2030 = 1,769.37, 3377 = 209.97, 2006 = 121.93,
2032 = 116.83, then a long tail of 21-ish DOT deposits.

**⚠ Both prefixes exist on Asset Hub and only one of them is the answer.** Sweeping the
`para`-prefixed accounts *on Asset Hub* returns 35 live accounts totalling **20.01 DOT** — mostly
the 0.01 DOT existential deposit. Reading the wrong prefix gives you a chart that renders perfectly
and is off by a factor of half a million.

### The lifetime series: it is a **sum**, not a splice

The `sibl` leg on Asset Hub is not new — it predates the migration, and the frozen dataset never
had it:

```
AH #3,920,000 (2023-06-06) sibl DOT: 2000=0     2030=3      2034=0
AH #6,000,000 (2024-04-05) sibl DOT: 2000=5     2030=53     2034=1
AH #8,700,000 (2025-04-23) sibl DOT: 2000=2     2030=1,722  2034=3,931,599
```

and the relay leg for Hydration over the same period:

```
RELAY -25,000,000 blocks  absent
RELAY -15,000,000 blocks  575,651.18 DOT
RELAY -10,000,000 blocks  8,704,921.45 DOT
RELAY  -5,000,000 blocks  9,328,862.20 DOT
RELAY  -1,000,000 blocks  22,496.22 DOT      ← post-AHM
RELAY          head       20,957.81 DOT
```

So **"DOT held by parachain X on day D" = relay `para` balance + Asset Hub `sibl` balance**, both
read at day D. Before ~2024 the `sibl` leg rounds to zero and the frozen Polkalytics series is
effectively correct; from 2025 it is the whole story. The chart must be built as the sum from the
start, and the data-notes must say that the pre-2023 portion of the old series omitted the Asset Hub
leg.

### Measured cost of the historical series

30 daily snapshots × 89 accounts on Asset Hub, end to end:

```
30 daily snapshots x 89 sovereign accounts: 60 requests, 0.64 MiB, 14.8 s
per-day cost: 22 KiB, 2.0 requests
  2026-07-21 #18464227 44 accounts    9,290,961 DOT
  2026-08-03 #18989108 44 accounts   10,803,459 DOT
  2026-08-19 #19623828 44 accounts    9,923,495 DOT
```

**The expensive half is not the balances, it is the date → block index.** Naive bisection over
18.6M blocks costs 26 iterations = **52 RPC reads per day-point**. A forward walk seeded from the
previous day's observed block rate got it to **21.7 reads per day-point** (measured, 30 points,
652 reads, 40.8 s) — still poor, because Asset Hub's block time has moved from 6.34 s (2025) to
2.32 s (now) and a single linear model does not fit. Two ways out, both one-time:

- keep tuning the interpolating search — a good one should land near 6 reads/point ⇒ ~14k reads for
  2,276 days ([unverified](#unverified) — not measured);
- or take the index from SQD: `includeAllBlocks:true` with only `{number, timestamp}` costs
  **57.0 bytes/block measured** (24,200 blocks / 1.38 MB / 0.93 s per response) ⇒ a full Asset Hub
  block↔time index is **≈ 1,068 MiB over ≈ 812 requests, ≈ 13 minutes**, and is reusable by every
  other feature in the site.

Either way the index is built **once** and stored as ~2,276 rows per chain. After that the series
costs **2 requests and 22 KiB per day, forever**.

---

## 4. Goal 2 — the holder leaderboards

### How big the maps actually are

`pallet-assets` stores the holder count in `AssetDetails.accounts`, so USDT/USDC need no
estimation at all — one storage read gives the exact number. `System::Account` has no counter, so
it was measured two independent ways that agree.

Decoded `Assets::Asset` + `Assets::Metadata` (both decoders self-check that they consume their input
exactly):

```
asset 1984: USDt "Tether USD" dec=6 | supply=77,998,622.058 | ACCOUNTS=13,894
            sufficients=13,790 approvals=22 status=Live isSufficient=true minBalance=10000 (0.01)
asset 1337: USDC "USD Coin"  dec=6 | supply=350,019,956.32 | ACCOUNTS=2,079,249
            sufficients=2,079,237 approvals=10 status=Live isSufficient=true minBalance=10000
```

757 assets exist in `Assets::Asset` on Asset Hub (one unpaged `state_getKeys`, 82 KB).

**Counting method A — hash-space sampling.** `Blake2_128Concat` keys are uniform over 2¹²⁸ and
`state_getKeysPaged` walks them in order, so *n* keys starting at *X* span a measurable fraction of
the space: `total ≈ Σn / (Σspan / 2¹²⁸)`. Validated against the two known counts:

| map | estimate | truth | error | cost |
|---|---|---|---|---|
| `Assets::Account[1984]` | 13,859 | 13,894 | −0.25% | 8 requests, 321 KiB |
| `Assets::Account[1337]` | 2,105,672 | 2,079,249 | +1.3% | 8 requests, 801 KiB |
| `System::Account` (AH) | **3,940,570** | — | ±1.0% 1σ | 10 requests, 1.6 MiB |
| `System::Account` (relay) | 1,498 | **1,493** (full sweep) | −0.3% | 10 requests |
| `Identity::IdentityOf` (People) | 3,276 | — | ±3.5% | 4 requests, 117 KiB |

**Counting method B — leading-byte shards**, which is also the sweep mechanism. `archive_v1_storage`
accepts *any* byte prefix, so `System::Account` prefix + one byte is exactly 1/256 of the map:

```
shard 00: 15,171 items   shard 40: 15,160   shard 80: 15,155   shard c0: 15,343
4/256 shards = 60,829 items  ⇒  System::Account ≈ 3,893,056
```

The two methods agree to 1.2%. **Take 3.89M.**

### Measured sweep costs

All via one WebSocket to `wss://polkadot-asset-hub-rpc.polkadot.io`, `archive_v1_storage` with
`type: "descendantsValues"`, one JSON-RPC notification per key/value pair.

| target | entries | measured | full-sweep cost | requests |
|---|---|---|---|---|
| **USDT** `Assets::Account[1984]` | 13,894 | **5.11 MiB, 14–27 s** | as measured — complete | **1** |
| **USDC** `Assets::Account[1337]` | 2,079,249 | 2/256 shards: 16,180 items, 5.96 MiB, 47.9 s | **≈ 762 MiB, ≈ 102 min** | 256 (sharded) |
| **DOT** `System::Account` | ≈ 3,893,056 | 4/256 shards: 60,829 items, 27.27 MiB, 54–80 s | **≈ 1,746 MiB, ≈ 58–85 min** | 256 (sharded) |

Sharding is what makes this safe: 256 independent operations, each ~7 MiB / ~20 s, resumable and
throttleable. `paginationStartKey` also works and resumes *within* a shard — verified on USDT from
`0x80…`, returning 6,793 of 13,894 items, i.e. exactly the upper half.

Throughput observed between 969 and 2,498 items/s on the same endpoint minutes apart, so treat
wall-clock as a range, not a constant.

### The USDT leaderboard — complete, exact, one request

Real output, block `0xcd100149ec7e26041d3667ec08bb8a82a1dd182a93c642ab4bd8b3cbee55516f`:

| # | address | USDt |
|---|---|---|
| 1 | `15cZ2zHq5b2fVh8iDqNJKyvHCtwVKWYGqNLQMakHh6e4wicX` | 41,000,982.998 |
| 2 | `13vg3Mrxm3GL9eXxLsGgLYRueiwFCiMbkdHBL4ZN5aob5D4N` | 10,580,073.693 |
| 3 | `13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6` | 6,175,827.001 ← **sibl#2034, Hydration** |
| 4 | `13FzGLWoueKvUqFePiJgvFYWhH5KckHGtVBXvAX7SBtVZbXu` | 5,105,504.463 |
| 5 | `13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB` | 3,706,949.914 ← **`modl py/trsry`, Treasury** |
| 6 | `1UJSCYLh44UYhkm1WwXAwT2W8nirTD74VzPsdhfsstY8S3u` | 2,226,190.377 |
| 7 | `1WqcGu9P9mi9CrMYx2LYfftki6V6Rr8Zrk5kzGvmwGaQANd` | 1,484,245.477 |
| 8 | `131AUdeYZz5kPcazyzzNvNkgB7BgVLVeij1HH3ckwRuc7q5H` | 1,322,085.831 |

Sum of holder balances 77,998,620.944 USDt against `AssetDetails.supply` 77,998,622.058 — a
1.114 USDt gap, i.e. the decode is right to 14 parts per billion. Distribution:
**8** holders ≥ 1M, **20** ≥ 100k, **63** ≥ 10k, **149** ≥ 1k, **384** ≥ 100, **1,253** ≥ 10,
**3,814** ≥ 1, **13,879** ≥ 0.01.

Note rows 3 and 5: a sovereign account and a pallet account sit in the top five. Any leaderboard
must label them (`0x6d6f646c` = `modl`, `0x7369626c` = `sibl`, `0x70617261` = `para`) or it is
reporting "Hydration's reserve" as if it were a whale.

### The USDC leaderboard — the number is a lie and the page must say so

2/256 sampled shards, 16,180 holders (extrapolates to 2,071,040 against the chain's 2,079,249 — 0.4%
error, so the sample is sound). Extrapolated distribution:

| holding at least | holders |
|---|---|
| 1,000 USDC | ~0 in sample |
| 100 USDC | ≈ 256 |
| 1 USDC | ≈ 1,280 |
| 0.01 USDC | **2,071,040** |

The largest holder in a 1/128 sample was **423 USDC**. USDC's `min_balance` is 0.01 and
`is_sufficient = true`, so anyone can be handed a cent and become a permanent "holder". **USDC has
~2.08 million accounts and roughly 1,300 of them hold as much as one dollar.** Publishing "2.08M
USDC holders" without that sentence is exactly the failure mode rule 3 of `CLAUDE.md` exists to
prevent.

### The DOT distribution — 4/256 shards, 60,830 accounts

| holding at least | accounts (extrapolated ×64) |
|---|---|
| 10,000,000 DOT | 0 |
| 1,000,000 DOT | 128 |
| 100,000 DOT | 1,344 |
| 10,000 DOT | 5,888 |
| 1,000 DOT | 35,200 |
| 100 DOT | 164,224 |
| 10 DOT | 415,168 |
| 1 DOT | 1,410,624 |

**Counts extrapolate; sums do not.** The sample's extrapolated total is 1,152,418,440 DOT against
an issuance of 1,698,775,805 — a 32% shortfall, because the top of the distribution is so heavy that
whether one whale lands in your 4 shards moves the total by hundreds of millions. Use shard sampling
for *shape*, never for *totals*.

Largest accounts in the sample (top of a 1/64 slice, so these are **not** the network's top ten):
`166JJ1tU9Jsjs…` 8,451,152.9 DOT, `16QKZ5DLg57Fy…` 1,129,829.4, `12Yji2iAEqqM7…` 957,587.5 — all
plain (non-`modl`) accounts.

---

## 5. Keeping it current: the incremental design

The full sweep is a **one-time baseline**. After that, SQD tells you exactly which accounts moved,
and you re-read only those from RPC.

Asset Hub block rate, measured over 100,000 blocks: **2.322 s/block ⇒ 37,217 blocks/day**
(it was 6.34 s/block through 2025, so do not hardcode this).

**DOT — 24 h of `Balances.*` on Asset Hub, measured:**

```
2 requests, 8.56 MiB, 1.0 s
5,410 blocks with events | 48,318 events | DISTINCT ACCOUNTS TOUCHED 14,012 (155 modl, 4 sibl)
Balances.Transfer=25,873  Deposit=9,637  Withdraw=7,676  Minted=3,355  Endowed=1,583
DustLost=139  Reserved=18  Unlocked=18  Unreserved=12  Locked=3  Burned=2  Issued=2
```

**USDT + USDC — 7 days of `Assets.*`, measured:**

```
11 requests, 0.95 MiB, 4.4 s, 4,678 events over 260,519 blocks
  asset 1984 (USDT): 2,556 events, 284 distinct accounts touched in 7 days
  asset 1337 (USDC): 2,090 events, 291 distinct accounts touched in 7 days
```

So the daily refresh is:

| feed | SQD | RPC re-read | total |
|---|---|---|---|
| DOT balances | 2 req, 8.6 MiB | 14,012 accounts ÷ 500 = **29** `state_queryStorageAt`, ≈ 4.8 MiB | ~31 req, ~13 MiB/day |
| USDT + USDC | ~2 req, 0.15 MiB | ~85 accounts/day = **1** call, ~30 KiB | ~3 req, ~0.2 MiB/day |
| 89 sovereign accounts | — | 2 req (hash + query), 22 KiB | 2 req, 22 KiB/day |

**≈ 36 requests and ≈ 13 MiB per day** keeps all of it exact. Re-run the full sweep monthly as a
consistency check, not as the refresh mechanism.

Caveat to state on the page: an account can enter the top N through a mechanism that emits no
`Balances` event (a runtime migration, a storage-force, a genesis-style injection). Between full
sweeps the leaderboard is exact for anything that moved through the balances pallet and blind to
anything that did not. A monthly full sweep bounds that window.

---

## 6. Storage sizing for the state we would have to keep

There is no persistent volume today. These are what v2 would need.

| dataset | rows | raw | with SQLite index | notes |
|---|---|---|---|---|
| date → block index, both chains | 2 × ~2,300 | 100 KB | < 1 MB | one-time, then append 1 row/day |
| sovereign daily series (89 paras × 2 legs × 2,276 days) | ~405k | ~10 MB | ~25 MB | the netflows chart, complete history |
| **current DOT balance snapshot, all accounts** | 3.89M | 3.89M × 80 B = **311 MB** | **~500 MB** | pubkey 32 B + free/reserved/frozen 16 B each |
| DOT snapshot, ≥1 DOT only | 1.41M | 113 MB | ~180 MB | drops 64% of rows, 0 of the leaderboard |
| DOT snapshot, ≥100 DOT only | 164k | 13 MB | ~20 MB | **plenty for any top-N page** |
| USDT holders, all | 13,894 | 0.7 MB | ~2 MB | keep all of it |
| USDC holders, ≥0.01 | 2.08M | 100 MB | ~160 MB | keep ≥1 USDC (~1,300 rows) and a count of the rest |
| daily history of the top 100k DOT accounts | 100k × 365 | 876 MB/yr | ~1.4 GB/yr | **do not** — see below |
| daily history of a curated set (sovereigns + treasury + top 1,000) | ~1,100 × 365 | ~10 MB/yr | ~15 MB/yr | this is the affordable version |
| block↔timestamp index for AH, if taken from SQD | 19.65M | 236 MB | ~400 MB | optional; only day boundaries are needed (~2,300 rows) |

**Recommended footprint: ~250 MB.** Keep the full DOT snapshot trimmed at ≥100 DOT (20 MB), the
complete USDT table (2 MB), USDC ≥1 (negligible) plus an aggregate row for the dust, the sovereign
daily series (25 MB), the date index (1 MB), and the curated daily history (15 MB/yr). The
untrimmed 3.89M-row snapshot is only needed transiently during a sweep and can be streamed into an
aggregate rather than stored.

That is comfortably a single SQLite file on a small disk. It is **not** compatible with the current
"no persistent volume" deployment, and it does not fit in a 256 MB RSS budget as an in-memory
structure — the sweep itself must stream to disk, not accumulate in a `Map`.

---

## 7. Recommendations

### Goal 1 — parachain sovereign holdings, live and lifetime

**Do this.** It is cheap, exact and mostly already understood.

1. Enumerate paras from **`Paras::ParaLifecycles`** on the relay (2 requests) — not
   `Paras::Parachains`, which returns 3.
2. Derive both `para` and `sibl` sovereign AccountIds; the value for a chain on a day is the
   **sum of the two legs**.
3. Live: **one `state_queryStorageAt` per chain** — 89 keys, ~22 KB, ~300 ms. Refresh every
   5–10 minutes; the existing TTL cache handles it with no new machinery.
4. History: build a date→block index once (§3), then backfill 2 requests × 22 KB per day-point.
   The relay leg goes back to 2020-05-26; the Asset Hub leg to 2022-04-04 (before which
   `Timestamp::Now` does not exist and dates must come from the relay).
5. Splice onto the frozen Polkalytics series with a stated caveat: that series is the **relay leg
   only**, and its clipping/resampling caveats already in `netflows.json` still apply to its own
   segment.
6. Say on the page: the migration on 2025-11-04 moved the leg from relay to Asset Hub; the line is
   a sum and does not jump.

**Needs state:** yes, but small (~25 MB). Could even be a committed derived dataset regenerated by
a script, like `netflows.json` is today — which would keep the "no datastore" deployment intact for
this feature alone.

### Goal 2 — holder leaderboards

**USDT: do it now.** 13,894 holders, **one WebSocket request, 5.11 MiB, ~15 s**, exact, complete,
with the true supply as a self-check. Refresh daily via ~284 changed accounts. This is the highest
value-per-effort item in the whole sweep. Label `modl`/`sibl`/`para` accounts.

**DOT: do it, sharded, on a schedule.** 256 shards × ~7 MiB, ~60–85 min for a full baseline;
~31 requests and ~13 MiB/day to stay exact after that. Store trimmed at ≥100 DOT. Publish top 100
with account-class labels and an explicit "as of block N" line.

**USDC: publish the distribution, not a leaderboard.** A "top USDC holders" table is ~1,300
meaningful rows discovered at a cost of 762 MiB and 100 minutes per baseline. Worth doing once, but
the honest headline is the shape: 2.08M accounts, ~1,300 above $1. Consider leading with that as a
finding in its own right rather than as a ranking.

**Do not** design around `archive_v1_storageDiff`, Subscan, or Statescan's account index.

### Deployment consequence

Everything here is a **sync-then-serve** shape, not a read-through cache. The container needs:

- a **persistent disk** (a few hundred MB) and a datastore — SQLite is sufficient and adds no
  runtime dependency to the server if the sync runs as a separate scheduled process;
- an **outbound WebSocket** for the bulk sweeps (the HTTP-only `state_getKeysPaged` +
  `state_queryStorageAt` path costs ~11,800 requests and ~2 GB for the same job — 6× the bytes and
  4 orders of magnitude more requests, because every key is sent back to the node);
- a **job runner** that is not the request path. An 85-minute sweep inside a request handler on a
  256 MB container is an OOM crash-loop.

None of it needs a credential.

---

## Unverified

Stated plainly rather than guessed at.

- **Why para 2004 (Moonbeam) is absent from `Paras::ParaLifecycles`.** *Partly settled 2026-08-20 —
  see [platform/asset-hub.md](../../platform/asset-hub.md).* `Registrar::Paras` has since been
  enumerated: 123 ids, a strict superset of the 89, and **2004 is in neither**, nor in
  `Paras::Heads` (90), `Paras::CurrentCodeHash` (90) or `Slots::Leases` (10). It is deregistered
  from this relay chain, not merely lifecycle-less — while still holding 265 + 50 DOT on the relay,
  10.21 DOT on Asset Hub, and eight bridged assets in its `sibl` account. Still open: *why*, and
  whether it re-registered under another id. A lifetime chart still needs the union of
  historically-registered ids and no current-state storage item provides it.
- **Dotlake's treasury figure vs the chain.** Dotlake reports USDT 7,581,321.46 for the Polkadot
  treasury on 2026-07-31; `modl py/trsry` holds 3,706,949.91 USDt today. Not resolved whether that
  is 19 days of outflow or a different aggregation.
- **A complete anonymous `para_id → chain name` registry.** Dotlake's `xcm-transfers` yields a
  partial map (13 pairs from 500 rows, one of them blank). Alternatives not tested: reading each
  chain's own `system_chain` over its public RPC, or polkadot-js `apps-config` from GitHub raw —
  the latter is untrusted open-web input under `docs/architecture/middleware.md` and would need the
  text-node treatment.
- **IBP / dotters endpoints** (`rpc.ibp.network`, `sys.ibp.network`, `*.dotters.network`) and
  `polkadot.rpc.subquery.network` failed **DNS resolution** from this machine. That is very likely
  a local resolver problem, not an outage — they should be re-tested from the deployment VM before
  being written off, as they are the natural failover for the Parity endpoints.
- **Whether an interpolating date→block search can reach ~6 reads/point.** Only 52 (bisection) and
  21.7 (forward walk) were measured. The ~14k-reads-for-full-history figure derived from 6/point is
  an estimate.
- **`archive_v1_storage` behaviour under sustained 256-shard load.** Four shards were run
  back-to-back without trouble; a full sweep was deliberately not executed. Rate limiting,
  per-connection operation caps and fair-use policy on the Parity node are unknown.
- **SQD Portal fair-use limits.** HTTP 529 `overloaded` was observed once and cleared on retry. No
  documented quota was checked.
- **Long-run stability of `Assets::Account` and `System::Account` value layouts.** Both decoders
  self-check length here (`AccountInfo` 80 bytes, `AssetAccount` 18 bytes, `AssetDetails` consumed
  exactly), but a runtime upgrade can change them; the check must stay in the code and must throw.

---

## Appendix — reproduction

Probe scripts live in the scratchpad (not committed):
`sub.mjs` (RPC + key building, importing this repo's `src/core/codec/*`), `probe-archive.mjs`,
`probe3.mjs` (sovereign sweep), `probe-assets.mjs`, `estimate.mjs` (hash-space estimator),
`probe-ws4.mjs` (shards, pagination, storageDiff), `sweep.mjs` (USDT leaderboard + DOT shards),
`usdc.mjs`, `sqd2.mjs`/`sqd3.mjs` (SQD event volume), `histseries.mjs`, `ahm.mjs`/`ahm2.mjs`.

Key constructions used throughout:

```js
System::Account[acct]        = twox128("System")  ++ twox128("Account") ++ blake2_128(acct) ++ acct
Assets::Account[id][acct]    = twox128("Assets")  ++ twox128("Account")
                               ++ blake2_128(u32le(id)) ++ u32le(id)
                               ++ blake2_128(acct)      ++ acct
Assets::Asset[id]            = twox128("Assets")  ++ twox128("Asset")   ++ blake2_128(u32le(id)) ++ u32le(id)
Paras::ParaLifecycles[id]    = twox128("Paras")   ++ twox128("ParaLifecycles") ++ twox64(u32le(id)) ++ u32le(id)
sovereign(id, "para"|"sibl") = ascii(prefix) ++ u32le(id) ++ [0u8; 24]
```

`blake2_128` is BLAKE2b with `outLength = 16`. It is **not** BLAKE2b-512 truncated.
