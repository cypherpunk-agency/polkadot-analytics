# arbs-r-us feature inventory — what can become a public dashboard

**Sweep date:** 2026-08-19 · **Source repo:** `arbs-r-us` (last commit era 2026-07-11)
**Target:** `analytics.cypherpunk.agency` — world-readable, no login, no secrets, 256 MB container,
no persistent volume *today*.

Everything numeric in this file is either (a) read out of a file in that repo, or (b) probed live
against a public endpoint on 2026-08-19 and marked **[verified 2026-08-19]**. Where I could not
verify, it says so.

---

## 0. One-paragraph verdict

arbs-r-us is a nine-screen Hydration trading terminal built on **entirely anonymous, entirely
public** upstreams — `https://rpc.hydradx.cloud` (Substrate JSON-RPC + an EVM plane on the same
host) and `https://explorer.hydradx.cloud/graphql` (Subsquid). There is no API key anywhere in it.
Every read it performs is a read this repo could legally and technically perform today.

Two findings dominate everything else:

1. **The cost story is far better than the repo believes.** `docs/research/11-web-dashboard.md`
   states a shared Hydration snapshot is "one 30–60 s / ~80-RPC read". That is an artefact of
   `substrate-interface` doing one HTTP round trip per storage item. The same node answers
   `state_queryStorageAt` with **hundreds of keys in one request** and accepts **JSON-RPC batch
   arrays** on the EVM plane. Measured today: the *entire* money-market screen — 23 reserves,
   rates, utilisation, LTVs, e-modes, 121 `eth_call`s — is **5 HTTP requests, 39 KiB, 1.31 s**.
   A full Omnipool + stableswap snapshot is **44 requests / 729 KiB / 11.9 s** unoptimised and
   ~15–20 requests / ~3–5 s with the asset registry cached. Nothing here needs a bigger box.
2. **The split between "public analytics" and "trading edge" is not screen-by-screen, it is
   layer-by-layer.** The *state* (pool reserves, rates, pegs, NAV, orderbook, schedule book) is
   public analytics. The *sizing and timing layer on top of it* (`takeable_usd`,
   `optimal_size_usd`, `binding_constraint`, `buyback_remaining_block`, the ranked `Signal` list,
   the per-address informedness score, the next-hour execution countdown) is the edge. You can
   ship most screens by cutting one column set, not by dropping the screen.

---

## 1. What I verified live, and how

All probes from this machine, 2026-08-19, no credentials, no headers beyond `Content-Type` and a
browser `User-Agent`. Scripts live in the session scratchpad; the exact requests are reproduced
inline below so this file stands alone.

### 1.1 Hydration node — Substrate plane

`POST https://rpc.hydradx.cloud`

```
$ curl -s -X POST https://rpc.hydradx.cloud -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"system_chain","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"Hydration"}

$ ... -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}'
{"jsonrpc":"2.0","id":1,"result":{"specName":"hydradx","implName":"hydradx",
 "specVersion":435, "transactionVersion":1, ...}}
```

**spec 435** — matches this repo's `CLAUDE.md` note ("verified live in runtime 435"). Note
`system_version` returns the misleading string `"49.2.2-81ab2e0 runtime 430.0.0 node 16.0.1"`;
`state_getRuntimeVersion` is the authority and says 435.

**Gotcha worth writing down:** the node **403s on the default Python `urllib` User-Agent**
(`Python-urllib/3.12`). `curl` and any browser-ish UA are fine. A server-side fetch from Node will
send no UA by default — set one. This failure is a hard 403, not a silent empty, so it is
detectable, but it is exactly the kind of thing that shows up only in production.

Storage prefixes probed with `state_getKeysPaged` (prefix = `twox128(pallet) ‖ twox128(item)`),
all returning keys, all anonymous **[verified 2026-08-19]**:

| Storage item | Entries today | Notes |
|---|---:|---|
| `AssetRegistry.Assets` | **1,437** | id → symbol/decimals/asset_type. 2 paged requests. |
| `Omnipool.Assets` | **19** | ids `[0,9,14,15,33,35,38,39,222,420,1001,9001,1000624,1000753,1000765,1000771,1000794,1000795,1000796]` |
| `Stableswap.Pools` | **17** | (doc 02 said 16) |
| `Stableswap.PoolPegs` | **9** | only peg-aware pools carry an entry |
| `DynamicFees.AssetFee` | **40** | |
| `DCA.Schedules` | **37** | 34 have a `ScheduleExecutionBlock` (3 stale leftovers — exactly as doc 08 describes) |
| `OTC.Orders` | **78** | (doc 06 measured 77) |
| `HSM.Collaterals` | **2** | **doc 06 recorded 4** — see §7 drift |
| `Referrals.ReferralCodes` | **676** | matches H25's "676 codes" |
| `Tokens.TotalIssuance` | 1,248 | full map; you only ever need ~17 keys of it |

Batch read confirmed:

```
$ state_queryStorageAt([19 Omnipool.Assets keys])
  -> 19 (key,value) pairs in ONE request, 0.22 s
$ state_queryStorageAt([36 Tokens.Accounts keys for the Omnipool account])
  -> 36 balances in ONE request
```

The Omnipool pallet account's **entire token balance set** comes back from one
`state_getKeysPaged` over prefix `twox128("Tokens") ‖ twox128("Accounts") ‖ blake2_128concat(account)`
followed by one `state_queryStorageAt`. Same trick works per stableswap pool account
(`blake2_256(b"sts" ‖ pool_id_u32_le)`, SS58 prefix 63).

### 1.2 Hydration node — EVM plane (same host)

```
$ ... -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
{"result":"0x3640e"}                       # 222222
$ eth_call getReservesList() on 0x1b02e051683b5cfac5929c25e84adb26ecf87b38
  -> 23 reserves
```

**JSON-RPC batching works**: posting a JSON *array* of 5 `eth_call`s returns an array of 5
results. This is what collapses the money market from 121 round trips to 5.

Live money-market sample **[verified 2026-08-19]** (ray-encoded `currentLiquidityRate` /
`currentVariableBorrowRate` decoded to simple APR):

```
  USDC     supplyAPR  2.904%  borrowAPR  5.139%
  USDT     supplyAPR  2.325%  borrowAPR  4.731%
  DOT      supplyAPR  0.918%  borrowAPR  2.610%   supplied 5,608,251 DOT  borrowed 2,192,930 DOT
  vDOT     supplyAPR  0.004%  borrowAPR  0.212%   supplied   774,295 vDOT
  HOLLAR   supplyAPR  0.000%  borrowAPR  4.402%   borrowed 10,964,941 HOLLAR
```

Flash-loan config bit re-probed **[verified 2026-08-19]**: `getConfiguration(asset)` bit 63 is
**TRUE on 0 of 23 reserves**; `FLASHLOAN_PREMIUM_TOTAL()` = **5** bps. Doc 14's verdict still
holds 40 days later — the door is still shut.

### 1.3 Subsquid explorer

`POST https://explorer.hydradx.cloud/graphql` — anonymous, no key, no rate-limit hit in this sweep.

```
{ blocks(limit:1, orderBy: height_DESC) { height timestamp } }
-> {"height":13690823,"timestamp":"2026-08-19T17:01:51.000000Z"}
```

A real `Broadcast.Swapped3` event as served (this is the canonical shape everything downstream
depends on) **[verified 2026-08-19]**:

```json
{
 "id": "0013690726-000016-b6c1c",
 "name": "Broadcast.Swapped3",
 "args": {
  "fees": [ {"asset":0,"amount":"763465262094",
             "destination":{"__kind":"Account","value":"0x6d6f646c6f6d6e69706f6f6c00…"}},
            {"asset":0,"amount":"624653396257",
             "destination":{"__kind":"Account","value":"0x6d6f646c66656570726f632f00…"}} ],
  "filler":  "0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000",
  "inputs":  [ {"asset":1,"amount":"1040000000000"} ],
  "outputs": [ {"asset":0,"amount":"553859344681925"} ],
  "swapper": "0x6d6f646c70792f74727372790000000000000000000000000000000000000000",
  "operation":  {"__kind":"ExactIn"},
  "fillerType": {"__kind":"Omnipool"},
  "operationStack": [ {"__kind":"DCA","value":[30104,10624017]},
                      {"__kind":"Router","value":10624018} ]
 },
 "indexInBlock": 16,
 "block": {"height":13690726,"timestamp":"2026-08-19T16:52:42.000000Z"},
 "extrinsic": null
}
```

Two things this repo already knows show up in that one event: the `swapper` begins `0x6d6f646c` =
`modl` (it is the Treasury, `py/trsry`, not a person) and the `operationStack` has two elements, so
this is **one leg of one route** and counting it as a trade double-counts.

`eventsConnection { totalCount }` also works — you can count without paging.

### 1.4 Bifrost (the external anchor for vDOT)

- `POST https://hk.p.bifrost-rpc.liebi.com/ws` → `{"result":"Bifrost Polkadot"}` **but only with a
  browser User-Agent**; with a plain client it returns the literal string `Script access denied`.
  Anonymous, public, no key. The other endpoints in circulation
  (`bifrost-polkadot-rpc.dwellir.com`, `…curie.radiumblock.co`, `…ibp.network`) returned **empty
  bodies** to me over plain HTTPS POST — do not assume they work.
- `GET https://dapi.bifrost.io/api/site` — anonymous JSON, works with a browser UA.
  Live vDOT block **[verified 2026-08-19]**:
  `apy 2.87%, tvm 8,795,844 DOT, totalIssuance 5,310,829 vDOT` → implied redemption rate
  **1.656209** DOT/vDOT.

### 1.5 CoinGecko (external USD anchors, used by `analytics/nav.py`)

`GET https://api.coingecko.com/api/v3/simple/price?ids=polkadot,ethereum,solana&vs_currencies=usd`
→ `{"polkadot":{"usd":0.778669},"ethereum":{"usd":2085.64},"solana":{"usd":81.5}}`
**[verified 2026-08-19]** — anonymous free tier, no key. It is rate-limited (roughly 5–15 req/min
on the free tier, undocumented and enforced by 429) so it must sit behind the same server-side
cache as everything else, and a 429 must degrade to "no external anchor", not to a wrong number.

---

## 2. Upstream inventory

| # | Upstream | Transport | Anonymous? | Used for | Verified today |
|---|---|---|---|---|---|
| U1 | `https://rpc.hydradx.cloud` | Substrate JSON-RPC over HTTPS POST | **yes** | Omnipool, Stableswap, DCA, OTC, HSM, DynamicFees, AssetRegistry, Referrals, Tokens balances | ✅ |
| U2 | `https://rpc.hydradx.cloud` (same host, `eth_*`) | EVM JSON-RPC, batchable | **yes** | Aave-fork money market, aToken/ERC-20 balances, HOLLAR, GETH/GSOL/GDOT share tokens | ✅ |
| U3 | `wss://rpc.hydradx.cloud` | Substrate WS | **yes** | what arbs-r-us actually uses (via `substrate-interface`) | ✅ (10.2 s for a decoded multi-map read) |
| U4 | `https://explorer.hydradx.cloud/graphql` | Subsquid GraphQL | **yes** | historical swap flow (`Broadcast.Swapped3`) | ✅ |
| U5 | `https://hk.p.bifrost-rpc.liebi.com/ws` | Substrate JSON-RPC over HTTPS | **yes**, needs browser UA | vDOT `TokenPool`/`TotalIssuance` → true redemption rate | ✅ (chain name only; storage read not re-decoded) |
| U6 | `https://dapi.bifrost.io/api/site` | REST JSON | **yes** | vDOT APY + tvm/issuance cross-check | ✅ |
| U7 | `https://api.coingecko.com/api/v3/simple/price` | REST JSON | **yes**, free tier | external ETH/SOL/DOT USD anchors for NAV | ✅ |

**No credential appears anywhere in arbs-r-us.** `grep` over the repo finds no `.env`, no key
constant, no auth header. Everything above satisfies rule 1 of this repo's CLAUDE.md as-is.

Two upstreams need a **new** `server/sources/` module each if adopted: `hydration` (U1+U2+U3 —
partially exists here already) and `hydration-flow` (U4). U5/U6 would be a `bifrost` source; U7 a
`coingecko` source with an explicit "this is a third-party price, and it may be missing" note.

---

## 3. Screen-by-screen inventory

Screen list is `src/arbs/ui/page.py` `SCREENS`; compute functions are `src/arbs/ui/screens.py`;
caching/orchestration is `src/arbs/ui/state.py`. All nine are read-only; nothing mutates chain
state. Endpoints: `GET /api/<screen>`, `POST /api/<screen>/refresh`, `GET /api/status`,
`GET /api/overview`.

Cached payload sizes are the **actual files** in `arbs-r-us/data/ui_cache/` — 668 KiB for all nine.

---

### S1 — Overview

**Shows.** One summary card per screen (block height, best route bps, looping APR, #open signals,
#actors…). Reads only from the other screens' caches; computes nothing.

**Upstream.** None. `state.overview()` → `screens.summarize()` over the last cache of each screen.

**Cost.** Zero upstream. Instant.

**State.** Reads whatever the other screens left behind. On the current stateless container this
would just be the in-memory TTL cache.

**Public?** Inherits the verdict of whatever it summarises. As a pattern (a landing grid of "last
computed at" cards) it is exactly what this repo's home index already does.

---

### S2 — Opportunities  ⚠️ **the edge screen**

**Shows.** Two ranked, executable tables.
*Take now* — columns `instrument · takeable $ · opt. size in · edge bps · binding`, each row
expanding to a numbered `steps[]` playbook ("Buy X, deposit single-sided to mint, sell the share in
the Omnipool at the +N bps premium, bundle in one `batch_all`").
*Deploy capital* — `instrument · APR · max deploy $ · horizon · on-chain APR`.

**Question answered.** "I have idle capital right now — what exactly do I execute, at what size?"

**Upstream.** Everything: the shared snapshot (U1+U2), `MoneyMarket().reserves()` (U2),
`hsm_state()` (U1+U2), and optionally Bifrost (U5/U6). `analytics/opportunities.py`,
1,662 lines, five providers, each isolated behind `_safe(...)`.

**Cost.** The union of S3+S4+S5+S6+S8. With batching: ~50–60 HTTP requests, <1 MB, well under 15 s.
Cached payload 25 KB.

**State.** None required — it is a pure function of one snapshot. (Time series would make it more
useful, not more possible.)

**Public?** **No, not as built.** This is the single sharpest item in the repo. It is not a
measurement of the venue, it is an instruction set: `optimal_size_usd`, `realized_profit_usd`, the
`binding_constraint` taxonomy, and a step-by-step extrinsic recipe. See §6.

---

### S3 — Routes (atomic cycle scanner)

**Shows.** Ranked simple cycles up to 5 legs over the whole venue graph, click-to-sort. Columns:
`Route · bps · Takeable $ · Takeable (units) · Opt. size · P&L / $1k · /hr ceil $ · Legs`, each row
expanding to a manual playbook plus caveats.

**Question answered.** "Is this venue internally arbitrage-free right now, and by how much is it
missing?" (Their answer at rest: yes, best cycle −3.31 bps.)

**Upstream.** `simulation/exploit.scan(max_legs=5)` → one `HydrationConnector.snapshot()` (U1+U2)
+ `fetch_external_data()` (HSM state, Bifrost rate, money-market reserves — each in its own
try/except, failures recorded in `external_caveats`). Graph = 41 assets / 432 directed edges at
their 2026-07-10 scan.

**Cost.** One snapshot + the external reads. **Compute** is a DFS over the cycle space — pure CPU,
capped at `MAX_ROUTES = 200` enriched routes; each enrichment runs a golden-section optimiser
(`optimize_size`). Cached payload is **420 KB — by far the largest of the nine**, because it
carries 200 routes × their steps and caveats.

**State.** None. Snapshot-only.

**Public?** **Split.** The *efficiency-boundary number* — "the best atomic cycle on Hydration is
−3.31 bps; this venue is arbitrage-free to within its own fees" — is excellent, honest public
analytics and is genuinely novel; nobody publishes it. The *route list with takeable $, optimal
size and execution steps* is edge. Publish the scalar and a distribution; do not publish the book.

---

### S4 — Money Market  ✅ **best public-analytics candidate in the repo**

**Shows.** (a) hero card with the H10 looping carry — net APR at max leverage, collateral→borrow
pair, e-mode LTV; (b) a looping-candidate table; (c) the **full reserve table**: supply/borrow APY,
utilisation bar, available/supplied/borrowed, LTV, liquidation threshold, e-mode flags; (d) the
e-mode category table (LTV / liq threshold / liq bonus per category).

**Question answered.** "What are Hydration's lending rates, how utilised is each reserve, and what
leverage does each e-mode permit?"

**Upstream.** U2 only, plus one U3 read for the aToken↔asset-id bindings.
Contracts (from `connectors/hydration/money_market.py`, all discovered on-chain, not hardcoded
guesses):

| Contract | Address | Discovered via |
|---|---|---|
| Pool (Aave v3 fork, proxy) | `0x1b02e051683b5cfac5929c25e84adb26ecf87b38` | `Liquidation.BorrowingContract` **storage** (governance-settable — re-read it) |
| PoolAddressesProvider | `0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691` | `Pool.ADDRESSES_PROVIDER()` |
| PoolDataProvider | `0xdf18300261edff47b28c6a6adbcbcf468b52e5a5` | `provider.getPoolDataProvider()` |
| PriceOracle | `0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760` | `provider.getPriceOracle()` |

aToken → underlying resolved by `UNDERLYING_ASSET_ADDRESS()`, selector **`0xb16a19de`** (doc 04
explicitly warns: *not* `0x89d1a0fc`, which circulates in notes). aToken contracts bind to
Substrate asset ids through `AssetRegistry.AssetLocations` X1/AccountKey20 entries.

**Cost — measured today, batched: 121 `eth_call`s in 5 HTTP requests, 39 KiB, 1.31 s.**
That is `getReservesList` (1) + `getReserveData` × 23 + {aToken.totalSupply, vDebt.totalSupply,
underlying.balanceOf(aToken), underlying.symbol} × 23 + `getEModeCategoryData` × 5. Cached payload
20 KB. **This screen is essentially free.**

**State.** None for the table. A rates *time series* (the obviously better dashboard — "DOT borrow
APY over 90 days, with the vDOT staking rate overlaid") needs persistence: 23 reserves × ~8 fields
× 288 samples/day ≈ 53k values/day, trivially small.

**Public?** **Yes, unreservedly, for the reserve + e-mode tables.** Every Aave frontend on earth
shows exactly this; publishing it reveals nothing. It is high-value because Hydration's money
market is under-documented outside its own UI, and because the **wrap map** (§4.1) is a genuine
discovery this repo could publish as a reference table.

The looping-carry hero card is a judgement call. The *arithmetic* is public
(`net = k·(staking+supply) − (k−1)·borrow`, `k = 1/(1−LTV)`) and so are all its inputs bar one. The
staking APY is an **external hint, not an on-chain read**, and the repo is scrupulous about it —
`meta['net_apr_onchain']` carries the staking=0 hard lower bound. Publishing "10% APR available"
next to a step-by-step leverage recipe on an ungated site is, functionally, investment advice. See §6.

Live recomputation of the H10 spread with today's numbers, to show it is not static:

| | doc 04 (2026-07-10) | **today [verified 2026-08-19]** |
|---|---:|---:|
| vDOT staking APY (Bifrost dapi) | 4.48% | **2.87%** |
| vDOT supply APY | ~0.00% | 0.004% |
| DOT variable borrow APY | 3.50% | **2.61%** |
| per-unit spread | +0.98% | **+0.264%** |
| net APR at e-mode-2 6.67× | **+10.1%** | **≈ +4.4%** |

---

### S5 — Pegs

**Shows.** (a) Omnipool price table — every listed asset in H2O and USD (USD derived by pinning
HOLLAR at par), hub reserve, asset/protocol fee; (b) per stableswap pool, **every pair's
peg-adjusted deviation net of fees**, flagged when it exceeds fees; (c) HOLLAR consistency across
its venues vs the HSM band.

**Question answered.** "Where is this venue mispriced against its own anchors, and by how much?"

**Upstream.** Snapshot only (U1+U2). Recomputed in `screens.compute_pegs` from
`exploit.build_usd_prices`, `providers.parse_pegs`, `stableswap_math.spot_price` — deliberately not
by importing `analytics/invariants.py`, which only has a printing `main()`.

**Cost.** Shares the routes/nav snapshot. Cached payload 19 KB.

**State.** None for the table. **Deviation persistence is the whole scorecard metric** and needs
history — doc 07 measured half-lives of 0–685 blocks per pair from 16 days of flow. That is the
single most valuable thing history would buy.

**Public?** **Mostly yes.** A peg-deviation table is standard DeFi analytics (Curve/Frax
dashboards). Two things to cut: the `beyond_fees: true` boolean is a "this one is executable"
flag, and pairing it with a size makes it a trade. Publish `dev_bps` and `net_bps` as measurements
and drop the flag, or rename it to something descriptive ("outside the pool's own fee band") rather
than actionable.

Live stableswap topology **[verified 2026-08-19]** — 17 pools, worth publishing as-is:

```
100:  [10,18,21,23]        fee 0.020%  amp 320    (4-Pool)
101:  [11,19]              fee 0.020%  amp   5    (iBTC/WBTC)
102:  [10,22]              fee 0.020%  amp 100
103:  [1002,1000766,1000767] fee 0.020% amp 222
104:  [20,1007]            fee 0.020%  amp 100    (WETH/aETH)
105:  [21,23,222]          fee 0.020%  amp 222
110:  [222,1003]           fee 0.020%  amp 222    (HOLLAR/aUSDC — HSM collateral)
111:  [222,1002]           fee 0.020%  amp 222    (HOLLAR/aUSDT — HSM collateral)
112:  [222,1000745]        fee 0.040%  amp 111    (HOLLAR/sUSDS)
113:  [222,1000625]        fee 0.040%  amp 111    (HOLLAR/sUSDe)
143:  [43,222]             fee 0.040%  amp 100    (PRIME/HOLLAR)
146:  [46,222]             fee 0.040%  amp 100    (apyUSD/HOLLAR)
690:  [15,1001]            fee 0.069%  amp 222    (GDOT: vDOT/aDOT)   ramp 1000→222 done @ blk 10,308,688
4200: [1007,1000809]       fee 0.069%  amp 100    (GETH: aETH/wstETH)
90001:[40,1009]            fee 0.069%  amp 100    (GSOL: jitoSOL/aSOL)
10044:[222,1044]           fee 0.050%  amp  50    (HOLLAR/aEURC)
10055:[55,222]             fee 0.100%  amp  50
```

---

### S6 — NAV

**Shows.** Per basket share (GETH / GSOL / GDOT / 4-Pool): NAV per share, D per share
("virtual price"), the imbalance premium between the two, per-component single-sided mint and burn
cost in bps, and market-vs-NAV deviation net of round-trip fees per anchor (on-chain anchor and
CoinGecko anchor both shown and labelled).

**Question answered.** "Is this on-chain ETF trading above or below what it redeems into?"

**Upstream.** Snapshot (U1+U2) + best-effort CoinGecko (U7). Math is `simulation/shares.py`, a
float64 port of `pallets/stableswap` — audited line-by-line in doc 17 and found to **match** the
pallet (`ann = amp·n`, the Curve imbalance fee `fee·n/(4(n−1))`, the single-asset withdraw formula,
the peg scaling). Rounding differs ~1e-12 relative, always in the pool's favour.

**Cost.** Shares the snapshot; the mint/burn simulations are pure CPU. Cached payload 6 KB —
the smallest of the nine.

**State.** None for a point reading. A premium time series ("GETH has traded +30 bps for six
weeks") is the interesting version and needs history.

**Public?** **Yes for the headline**, with two caveats to state on the page.
"GETH NAV = 1.0124 ETH/share, market = +34 bps" is exactly the kind of number a public dashboard
should carry and nobody publishes. The caveats the repo already knows and this repo's rule 3 would
demand:
- **GETH's USD anchor is circular.** The ETH cluster's only on-chain USD price *is* GETH, so an
  internal deviation is definitionally zero; the honest comparison needs an external ETH price.
  Both must be shown and labelled (`analytics/nav.py` already does this).
- **The 4-Pool trap.** At the 2026-07-10 snapshot the 4-Pool held **$423 total** and showed a
  spectacular **+371 bps** headline imbalance whose real takeable value was **$0.71**,
  `reserve_cap`-bound. A bps number without a depth number is a mirage. If you publish the bps,
  publish the pool TVL in the same row.

The per-component mint/burn cost table and the "deposit X, withdraw Y" internal-imbalance rows are
the edge-y half (§6).

---

### S7 — DCA Flow  ⚠️ **third-party harm, not just own-edge**

**Shows.** (a) The schedule book by daily notional — `id · pair · amt/exec · period · ex/day ·
daily $ · remaining · next · route`; (b) a **next-hour execution timeline** with exact blocks,
`planned` vs `projected`, amount and ≈USD; (c) per-pair pressure forecast with cumulative price
impact in bps per 100-block window and an H15 pre-position flag at >30 bps.

**Question answered.** "What order flow is already scheduled to hit this venue, when exactly, and
how far will it move price?"

**Upstream.** U1 only: `DCA.Schedules`, `DCA.RemainingAmounts`, `DCA.ScheduleIdsPerBlock`,
`DCA.ScheduleExecutionBlock`, plus `Router.Routes` to resolve empty stored routes, plus the
snapshot for impact math.

**Cost.** Snapshot + 4 map reads + a handful of `Router.Routes` point reads. Cached payload 98 KB.

**State.** None required. Forecast accuracy would improve with observed-cadence history but the
storage is already exact to ±1 block (17 % `BumpChance` jitter).

**Public?** **This is the one I would think hardest about.** Nothing here is secret —
`DCA.Schedules` is public storage and any explorer can show it. But the *packaging* changes its
character. A live countdown that says "address `16VcQ…Lnos` will sell 289 DOT into the Omnipool at
block 13,690,912, ≈$225, and the cumulative hour impact is 17 bps" is a front-running target list
rendered as a web page, for a user who chose DCA precisely because they did not want to time the
market. The repo itself is explicit that the exploit is "position as counterparty just-in-time".

Publishing an **aggregate** — "$209 k/day of scheduled DCA flow exists on Hydration, 76 % of it one
treasury-managed HOLLAR→aUSDC stream, split by pair" — is a genuinely interesting protocol-usage
statistic with none of that hazard. Publishing the per-schedule timeline with owners is different.

Live sample schedule **[verified 2026-08-19]** to show what the raw item contains, owner and all:

```json
{"owner":"13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB","period":10,"total_amount":0,
 "max_retries":9,"stability_threshold":null,"slippage":10000,
 "order":{"Sell":{"asset_in":1,"asset_out":0,"amount_in":1040000000000,"min_amount_out":0,
                  "route":[{"pool":"Omnipool","asset_in":1,"asset_out":0}]}}}
```

(That one is schedule 30104, owner = the DCA pallet's own `FeeReceiver` — the protocol converting
accrued fees, structural flow, no third party harmed. The two neighbours in the same map are
ordinary user addresses.)

---

### S8 — HSM / OTC

**Shows.** (a) HSM per-collateral state: peg, pool spot, sell ceiling, buy floor, buyback
active/imbalance/**remaining this block**, HSM holding, mint headroom; (b) the open OTC orderbook
with gross and net-of-fee prices, fill type, owner.

**Question answered.** "How is HOLLAR's peg actually defended, and what is resting on the OTC book?"

**Upstream.** U1 (`HSM.Collaterals`, `HSM.HollarAmountReceived`, `HSM.FlashMinter`,
`Stableswap.Pools`/`PoolPegs`, `OTC.Orders`) + U2 for the ERC-20 balances of HOLLAR/aToken
collaterals.

**Cost.** ~6–10 requests batched. Cached payload 47 KB.

**State.** None. Note `HollarAmountReceived` is **reset in `on_finalize`**, so an RPC read at a
block boundary always returns 0 — a per-block time series of it would be all zeros and misleading.

**Public?** **Mostly yes, with one column cut.** The HSM's *parameters* are protocol facts and
publishing them is a public good — doc 06 found the published documentation is wrong (docs say the
floor is $0.995; on-chain it is **0.998** on the aUSDT/aUSDC legs, and `purchase_fee` is exactly
**0**, so the ceiling is exactly $1.00). Correcting a protocol's own documentation with a live
reading is precisely what this repo's `docs/platform/` exists for.

The edge-y column is **`buyback_remaining_block`** together with `buyback_active`. That number is
the H7 event playbook trigger: it tells you, in real time, that the peg floor is *soft right now*
because the HSM's per-block throughput (`buyback_rate × imbalance`, live 0.58–16.6 HOLLAR/block) is
exhausted. Publishing "the stablecoin's defence is currently out of ammunition" on a live public
page is a different act from publishing its configured parameters.

The OTC book itself is fine to render — it is a public orderbook. The `roundtrip_edge_bps` /
`is_arb` columns are the edge-y part, and doc 06 measured them all deeply negative anyway
(best −2,142 bps; X2 confirmed closed).

Live HSM state **[verified 2026-08-19]** — and note the drift:

```
asset 1002 (aUSDT): pool 111, purchase_fee 0, max_buy_price_coefficient 0.998,
                    buyback_rate 1e-4, buy_back_fee 1e-4, max_in_holding 8,000,000
asset 1003 (aUSDC): pool 110, purchase_fee 0, max_buy_price_coefficient 0.998,
                    buyback_rate 1e-4, buy_back_fee 1e-4, max_in_holding 8,000,000
HSM.FlashMinter:    0xb3282db2fb01a9305b753ecca09bf68c45428cf4
```

**Two collaterals, not four.** Doc 06 (2026-07-10) recorded aUSDT, aUSDC, sUSDS *and* sUSDe with
0.995 floors. The sUSDS/sUSDe legs have been removed from the HSM. Pools 112 and 113 still exist
with HOLLAR paired against them. Anything hardcoding four collaterals now silently renders a
subset. Good illustration of why the repo's "storage keys are computed, never hardcoded" rule
generalises to *set membership*, not just key derivation.

---

### S9 — Signals  🚫 **the sharpest edge item; do not publish**

**Shows.** A ranked list of forward-looking signals: `kind · pair · score bar · direction ·
horizon · source · rationale`. Six sources:

| kind | What it fires on | Registry |
|---|---|---|
| `scheduled_flow` | upcoming DCA pressure ≥3 bps within the horizon | H15 |
| `decay_shock` | a large recent trade in a **slow-decay** asset that has not been reverted within 20 blocks | doc 07 §3.2 |
| `vdot_rebuild` | pool-690 imbalance + vDOT premium vs the **true** Bifrost rate | H23 |
| `bot_silence` | **time since the CEX-arb bot and the HSM peg-defence executor last acted** | H7/H13 |
| `otc_intent` | a large near-market partially-fillable resting order | H28 |
| `informed_accumulation` | informed actors net-loading a direction | H27 |

**Question answered.** "Where is a gap about to open, so I can be there before it does?"

**Upstream.** Snapshot (U1+U2) + `OTC.Orders` + Bifrost (U5) + **the local flow Parquet archive**
(for `decay_shock` and `bot_silence`).

**Cost.** Snapshot + a bounded DuckDB query over the local Parquet. Cached payload 2.5 KB.

**State.** **Requires the flow archive.** Two of six sources are dead without it, and the repo
notes the fetcher only writes completed block-chunks so it lags head by ~1 h — a live version needs
a tailing ingest.

**Public?** **No.** This screen's stated purpose is to let you *position before* the gap opens.
Three specific hazards, in descending order:
1. `bot_silence` publishes, live, that a named market participant is offline and that its defended
   windows are therefore open. It is a public "the guard has left the building" notice.
2. `decay_shock` publishes open, uncontested dislocations with their dollar size and how many
   blocks they have survived.
3. `informed_accumulation` publishes which addresses are quietly loading which direction.

Even setting Tommi's own edge aside, this is a page that materially changes behaviour on a venue
he depends on, and it does so by naming parties.

---

### S10 — Actors  🚫 **edge + a privacy problem this repo has no policy for**

**Shows.** A leaderboard of **SS58 addresses** with `tags · volume $ · trades · pairs · directional
bias · cadence · informedness`, plus a `informed` boolean. Tags include `cex_arb`, `protocol_bot`,
`hsm_exec`, `market_maker`, `retail`, `directional`, `dust`.

**Question answered.** "Whose flow *predicts* price, and whose is noise?"

**Upstream.** **No live chain read at all** — 100 % the local flow Parquet archive built from U4.

**Cost.** DuckDB over the archive: 330,674 legs / 16 days. Cached payload 23 KB.

**State.** **Hard requirement.** The estimator needs a per-pair, per-block reference price series
and a forward-return window; it cannot exist without ≥ weeks of history. This is the single screen
that *forces* the persistence conversation.

**Public?** **No, on two independent grounds.**

*Edge:* doc 09's own verdict is that the followable cohort is 14 addresses at 52.5 % hit-rate /
+6.45 bp. Publishing the roster crowds it out of existence — including for Tommi.

*Privacy/profiling:* this is a public page that names identifiable pseudonymous parties and
attaches behavioural judgements to them ("informed", "uninformed", "the competition"). The repo
has no policy for that and `docs/architecture/` does not contemplate it. The People Chain angle
makes it worse, not better: an on-chain identity lookup would turn a leaderboard of hashes into a
leaderboard of names. The **aggregate** shape of the same finding is safe and interesting — "27 %
of Hydration's swap legs are protocol module accounts; one address is 29 % of user volume; the
median actor's forward-return score is +0.1 bp" — and can be published without a single address.

---

### Beyond the nine screens

| Module | What it is | Public candidate? |
|---|---|---|
| `ingestion/flow_history.py` | Subsquid → Parquet fetcher, resumable by 1,200-block chunks | **The ingest engine.** Not a screen, but the prerequisite for half the good ones. |
| `ingestion/watch.py` | per-block scan → Parquet log + above-water alerts + `signals.jsonl` | No — it is an alerting daemon. |
| `ingestion/capture.py` + `parquet_store.py` | snapshot → partitioned Parquet | The persistence pattern this repo would copy. |
| `analytics/invariants.py` | peg-deviation CLI (printing only) | Superseded by S5. |
| `analytics/otc_check.py` | X2 verifier — prices every open OTC order against the pool graph | Interesting as a *protocol health* check ("the settlement bot has left nothing on the table"), not as a table of arbs. |
| `simulation/sizing.py` | `max_takeable_{cycle,nav,carry}` + `binding_constraint` taxonomy | **The edge layer itself.** See §6. |
| `connectors/bifrost/client.py` | true vDOT redemption rate | Yes — see §5.4. |
| `docs/research/03-invariant-registry.md` | H1–H29 + closed doors X1–X6 | The taxonomy is a public good; the live status column is a research feed for competitors. Publish as prose in `docs/platform/`, not as a live dashboard. |

---

## 4. Metric inventory — every computed quantity, with its class

Legend: **P** = safe public analytics · **S** = split (publish the state, cut the sizing/flag) ·
**E** = edge-revealing.

### 4.1 Structural / topology

| Metric | Source | State? | Class |
|---|---|---|---|
| Asset registry (1,437 entries: id, symbol, decimals, asset_type) | `AssetRegistry.Assets` | no | **P** |
| The **wrap map**: aToken asset id → underlying asset id, 23 rows | `getReserveData` + `UNDERLYING_ASSET_ADDRESS()` + `AssetRegistry.AssetLocations` | no | **P** — a genuine reference table nobody publishes |
| The wrapper graph (which forms of DOT/ETH/SOL/BTC/USD exist, which pool joins each pair) | derived from the above + `Stableswap.Pools` | no | **P** — highest value-per-effort item in the whole sweep |
| Numéraire classes + the ratio carried by each edge (vDOT 1.656 DOT, wstETH 1.234 ETH, jitoSOL 1.278 SOL, sUSDe 1.237 USD…) | `PoolPegs` + Bifrost | no | **P** |
| Omnipool composition (19 assets, hub reserve share, asset/protocol fee per asset) | `Omnipool.Assets` + `DynamicFees.AssetFee` | no | **P** |
| e-mode categories (id, label, LTV, liq threshold, liq bonus) | `getEModeCategoryData(uint8)` | no | **P** |
| Flash-loan enablement bit per reserve + `FLASHLOAN_PREMIUM_TOTAL` | `getConfiguration(address)` bit 63 | no | **P** — protocol-config transparency |
| HSM configured band per collateral (floor coefficient, purchase fee, buyback rate, max holding) | `HSM.Collaterals` | no | **P** |
| Referral system size (676 codes, linked accounts) | `Referrals.*` | no | **P** |

### 4.2 Rates and prices

| Metric | Source | State? | Class |
|---|---|---|---|
| Supply/borrow APY per reserve (ray → per-second compounded) | `getReserveData` | no | **P** |
| Utilisation, available/supplied/borrowed | aToken/vDebt `totalSupply` + `balanceOf` | no | **P** |
| LTV, liquidation threshold, liquidation bonus, reserve factor, active/frozen/paused | `ReserveConfigurationMap` bitmap | no | **P** |
| Omnipool spot price per asset in H2O and USD (HOLLAR-at-par) | snapshot | no | **P** (with the "HOLLAR-at-par is an assumption" caveat) |
| Stableswap pair spot, peg-adjusted | `spot_price(yp, ann, i, j)` | no | **P** |
| Peg deviation `dev_bps`, and `net_bps` after the pool fee | ditto | no | **S** — publish `dev_bps`; the `beyond_fees` boolean is the actionable bit |
| HOLLAR price in each of its venues + vs the HSM band | snapshot + HSM | no | **P** |
| Basket NAV/share, D/share, imbalance premium | `simulation/shares.py` | no | **P** |
| Basket market-vs-NAV deviation per anchor | + Omnipool + CoinGecko | no | **P** with both anchors labelled |
| Per-component single-sided mint/burn cost in bps | exact pallet math | no | **S** — it is the recipe's cost input |
| vDOT true redemption rate (Bifrost `TokenPool/TotalIssuance`) | U5/U6 | no | **P** |
| vDOT oracle-peg lag: pool-690 `PoolPegs` vs the true rate | U1 + U5 | no | **P** — an oracle-health metric, genuinely public-interest |
| H10 looping spread + net APR at max leverage | derived | no | **S** — see §6 |

### 4.3 Flow and behaviour (all need the archive)

| Metric | Source | State? | Class |
|---|---|---|---|
| Swap legs/day, gross leg volume, route-level volume | U4 archive | **yes** | **P** |
| Volume by venue (Omnipool / Stableswap / AAVE wrap / XYK / HSM / OTC) | archive | **yes** | **P** — the "the money market is inside the swap path" finding is a great chart |
| Hour-of-day and weekday volume profile | archive | **yes** | **P** |
| Trade-size distribution (63 % of routes < $10; 87 % < $100) | archive | **yes** | **P** |
| Module-account share of legs (~27 %) | archive, `modl` prefix decode | **yes** | **P** — and it is *exactly* this repo's existing "pallet accounts are not people" caveat |
| Per-pair deviation half-life / decay regime | archive | **yes** | **S** — "how fast does this venue heal" is analytics; "these pairs stay open for 78 min" is a hunting map |
| Per-address volume, cadence, directional bias | archive | **yes** | **E** (aggregate form is **P**) |
| Per-address informedness score, informed cohort | archive | **yes** | **E** |
| Named actor roster (CEX-arb bot, HSM executor, treasury, liquidator) | archive | **yes** | **E** for the named individuals; **P** for the *categories* |
| Bot last-seen / silence | archive | **yes** | **E** |

### 4.4 The sizing layer — uniformly **E**

`simulation/sizing.py` and everything that consumes it. `TakeableResult` carries
`optimal_size_usd`, `realized_profit_usd`, `realized_bps`, `marginal_bps_at_zero`,
`binding_constraint ∈ {curve_shift, reserve_cap, borrow_liquidity, capacity, below_water}`, and a
`size_curve` for the sparkline. Plus `takeable_usd`, `per_hour_ceiling_usd`, `pnl_at_1k_usd`,
`capital_required_usd`, and the `steps[]` playbooks in `Opportunity`.

This layer is *the* thing that turns "a number about a venue" into "a trade". It is also, ironically,
the most intellectually honest part of the repo — doc 15's whole point is that a 371 bps headline
on a $423 pool is a $0.71 opportunity, and publishing bps without depth is dishonest. There is a
version of this that is public analytics: **publish the depth, not the profit.** "Pool 100 holds
$423" tells the reader the 371 bps is meaningless without telling them what to do about it.

---

## 5. Cost model — measured, not estimated

### 5.1 The batching finding

`docs/research/11-web-dashboard.md` states: *"refreshing any of routes/pegs/nav refreshes the whole
trio off a single `HydrationConnector` snapshot (one 30–60 s / ~80-RPC read shared three ways)"*.

That figure is real for their client. `substrate-interface` issues one WebSocket round trip per
storage read, and their `snapshot()` does one `client.balance()` per (pool, asset) pair — 17 pools
plus the Omnipool, several assets each. My decoded WSS read of just five maps took **10.2 s**.

The same node, over plain HTTPS, answers:

- `state_getKeysPaged(prefix, 1000, start)` — all keys of a map, usually one request.
- `state_queryStorageAt([up to hundreds of keys])` — all their values, **one request**.
- a JSON **array** of `eth_call`s — all their results, **one request**.

### 5.2 Measured refresh costs (2026-08-19, from this machine)

| Refresh | HTTP requests | Bytes down | Wall time |
|---|---:|---:|---:|
| Full Omnipool + stableswap snapshot (registry, omnipool, fees, pools, pegs, issuance, 18 pool-account balance sets) | **44** | **729 KiB** | **11.9 s** |
| …the same with the 1,437-entry asset registry cached and `TotalIssuance` read by key instead of by map | ~15–20 | ~200 KiB | **~3–5 s** (registry phase alone was 3.6 s; the full `TotalIssuance` map was most of the rest) |
| Money-market screen: 121 `eth_call`s | **5** | **39 KiB** | **1.31 s** |
| DCA screen (4 maps + `Router.Routes` point reads), on top of a snapshot | ~5–8 | ~50 KiB | ~1 s |
| HSM/OTC screen (2 HSM maps, 78 OTC orders, pool reads) | ~6–10 | ~60 KiB | ~1 s |
| Flow ingest, 1 hour of chain (600 blocks) | **2 GraphQL** | **619 KiB JSON** | **0.44 s** |

**Everything arbs-r-us computes, in one pass, is roughly 60–70 HTTP requests and under 1 MB.**
Under a minute cold, well inside a 256 MB container, no persistent volume needed for the live half.

### 5.3 Request volume against upstreams

With this repo's existing TTL + single-flight cache, upstream load is independent of visitor count.

| Refresh cadence | Sustained req/s at `rpc.hydradx.cloud` |
|---|---|
| every 60 s | ~1.1 req/s |
| every 5 min | ~0.22 req/s |
| every 15 min | ~0.07 req/s |

Flow ingest at one poll per 10 minutes is 2 GraphQL requests per poll — 288 requests/day. Negligible.

The one upstream that is *not* comfortable at these rates is **CoinGecko** (U7): the free tier is
rate-limited by 429 and is only needed for the NAV external anchor. A 15-minute TTL on that one
source, and a page that says "external ETH anchor unavailable" rather than falling back to the
circular on-chain price, is the right shape.

### 5.4 Data volume and storage sizing

Measured from `arbs-r-us/data/` (their real dataset, not an estimate):

| | |
|---|---|
| Flow archive on disk | **25 MiB Parquet** for **330,674 legs** over **16 days** (blocks 12,870,000–13,071,600) |
| → per leg | **~75 bytes** compressed |
| → per day | **~1.6 MiB** |
| Legs/day today **[verified 2026-08-19]** | ~18,800 (784 legs in the last 600 blocks × 24) |
| Raw JSON from Subsquid | ~14.5 MiB/day (compresses ~9× into the narrow Parquet schema) |
| **1 year of flow** | **~580 MiB** |
| All nine screens' JSON payloads | **668 KiB** total (`routes.json` alone is 420 KiB) |

A rates/pegs/NAV **time series** is far cheaper: ~23 reserves × 8 fields + ~40 pool pairs + 4
baskets ≈ 300 values per snapshot. At one snapshot per 5 minutes that is 86k values/day — under
1 MiB/day uncompressed, a few MiB/year in Parquet or SQLite.

> **Marked 2026-08-21: this two-tier split is the one the measurement confirmed**, and it is the
> only sweep that got the sizing right. Tier 1 is what shipped — daily summaries at 14–17 kB per
> source-day, 9 MB for nineteen months of Hydration — and Tier 2 was priced and refused: raw trades
> are 268 B each, **~190×** the summary, and unservable besides. See `docs/concept/plan.md` §12.2
> and [jobs.md](../../architecture/jobs.md#what-the-store-actually-costs).

**So the persistence ask is two-tier:**
- **Tier 1 — derived time series** (rates, pegs, NAV, deviations, aggregate flow): a few hundred
  MiB for *years*. This could live in a committed dataset in-repo (this repo already does exactly
  that with `src/data/` netflows) or on a small volume.
- **Tier 2 — raw swap-leg archive**: ~580 MiB/year and growing, plus a tailing ingest. This one
  genuinely needs a disk and a background worker, and it is the *only* prerequisite for the actor /
  signal / decay-persistence family — which is also the family I would not publish. **That is a
  convenient alignment: the expensive state is the state you probably do not want.**

If the actor/decay family is dropped, Tier 2 shrinks to "keep daily aggregates, discard the legs",
which is a few MiB/year and needs no volume at all.

### 5.5 Compute

None of it is heavy except two things:

- `scan()`'s cycle DFS over 41 assets / 432 directed edges, with a golden-section optimiser per
  enriched route (capped at 200 routes). This is the only genuinely CPU-bound item and it is
  Python; a Node port would be faster but it is also the screen I would not publish in full.
- `actors.informedness()` builds per-pair block-indexed price series over 330k legs in DuckDB.
  Fine on a laptop, but it is a batch job, not a request handler — it belongs in an offline
  pipeline that writes a small artefact, not in a `/api/` route.

---

## 6. The judgement call — what reveals trading edge

Tommi asked me to make a call and defend it, not to decide for him. Here is the call, the reasoning,
and the cost of each option so he can override per screen.

### 6.1 The principle I applied

**A dashboard is analytics when it describes a state, and a signal when it tells you what to do
about it, at what size, before someone else does.** Concretely, four properties tip a screen from
one to the other, and they can be cut independently of the screen:

1. **A size.** `takeable_usd`, `optimal_size_usd`, `capital_required_usd`. "There is a 30 bps gap"
   is a measurement. "Deposit $1.0M of vDOT and pocket $2,833" is a trade.
2. **An execution recipe.** The `steps[]` playbooks name the extrinsics.
3. **A lead time.** "This will happen at block N" / "the defender has been gone for K blocks" /
   "this actor is loading". Anything whose value is *being early*.
4. **A named counterparty.** Any column containing an SS58 address attached to a behavioural
   judgement or a future action.

Cut those four and almost every screen survives as public analytics. Keep them and almost every
screen is a trading terminal.

### 6.2 Edge-revealing (my recommendation: do not publish as built)

| Screen / metric | Why | What survives if you cut the edge layer |
|---|---|---|
| **Signals** (whole screen) | Its stated purpose is positioning *before* the gap. `bot_silence` publicly announces that a named defender is offline; `decay_shock` publishes live open dislocations with size and age. | Nothing worth keeping. The *historical* version — "how often is this venue undefended, in aggregate" — is a good chart and reveals nothing live. |
| **Actors** (whole screen) | Publishing a 14-address followable cohort destroys the edge by crowding, and profiles identifiable pseudonymous parties with behavioural labels. See §3 S10. | The **anonymised aggregate**: module-account share, volume concentration (top-1 = 29 %, top-20 = 68 %), the informedness *distribution* (median +0.1 bp, p90 +6.9 bp) with no addresses. That is a strong public chart. |
| **Opportunities** — `takeable_usd`, `optimal_size_usd`, `binding_constraint`, `steps[]` | Literally an instruction set with sizing. Also: a public page saying "10 % APR at 6.67× leverage, here's the recipe" on an ungated site with no terms is functionally investment advice. | The *rates and deviations* that feed it — already covered by S4/S5/S6. |
| **Routes** — the route book with takeable/opt-size/per-hour-ceiling | Same. | **The scalar**: "best atomic cycle = −3.31 bps; this venue is internally arbitrage-free to within its own fee structure", plus a time series of that boundary. Genuinely novel, zero edge. |
| **DCA** — the next-hour execution timeline with schedule ids, owners and per-pair impact | Third-party harm, not just own-edge: it is a front-running target list for users who chose DCA *not* to time the market. The data is public storage; the countdown is not. | The **aggregate book**: total scheduled $/day, split by pair, rolling vs fixed, without owners or blocks. |
| **NAV** — internal-imbalance rows ("deposit vDOT, withdraw aDOT, ~$2,833") | Sized mint/burn recipes. | NAV/share, D/share, imbalance premium, market-vs-NAV deviation. |
| **HSM** — `buyback_remaining_block`, `buyback_active` | Publishes, live, that the stablecoin's peg defence is out of ammunition this block. | The configured band (floor 0.998, ceiling exactly 1.00, purchase_fee 0, buyback_rate), which is a *documentation correction* worth publishing. |
| **Pegs** — the `beyond_fees` execute-flag | The flag is the actionable bit; the number is not. | `dev_bps`, `net_bps`, pool depth. |
| **The whole `sizing.py` output family** | See §4.4. | Publish **depth** instead of **profit**. |

### 6.3 Good public analytics (my recommendation: publish)

Ranked by value-per-effort:

1. **Hydration wrapper-graph / topology reference.** Which forms every asset exists in, which pool
   or wrap joins each pair, the 23-row aToken wrap map, the numéraire ratio table. Static-ish, one
   cheap refresh, zero edge, and *nobody publishes it*. It is also a `docs/platform/` knowledge-base
   entry as much as a dashboard.
2. **Money-market reserve + e-mode table.** 5 requests, 1.3 s, 39 KiB. Every Aave frontend shows
   this; Hydration's is under-documented outside its own UI.
3. **HOLLAR peg monitor.** Price across all its venues, plus the *configured* HSM band, plus the
   documented-vs-actual correction (docs say 0.995, chain says 0.998). Stablecoin peg monitoring is
   the most conventionally-public analytics there is.
4. **Basket NAV vs market (GETH / GSOL / GDOT / 4-Pool).** "Is this on-chain ETF at a premium?"
   with both anchors labelled and pool TVL in the same row.
5. **Peg-deviation table across all 17 stableswap pools.** Efficiency measurement, fee-context
   included, execute-flag removed.
6. **vDOT oracle-health.** The pool-690 `PoolPegs` reading vs Bifrost's true
   `TokenPool/TotalIssuance` rate, and the gap between them. An oracle that lags 112 bps is a
   *risk fact*, publishable in the public interest. Today it does **not** lag (see §7) — which is
   itself the point of a monitor.
7. **Flow structure aggregates.** Volume by venue (the "money market is inside the swap path"
   finding), hour-of-day profile, trade-size distribution, module-account share. This is closest to
   what this repo already ships for Hydration swaps and slots straight into `renderSwapDashboard()`.
8. **Protocol-config transparency.** Flash loans disabled on 0/23 reserves at 5 bps premium; OTC
   settlement bot's 0.001 % trigger; DCA constants (`MaxSchedulePerBlock=6`, `BumpChance=17 %`).
9. **The efficiency-boundary scalar** from §6.2.

### 6.4 The genuinely ambiguous ones

- **The H1–H29 invariant registry.** Publishing the *taxonomy* — a structured map of where
  inefficiency can live on a DeFi venue, with six closed doors documented and *why* they are closed —
  is a real public good and a strong piece of writing. Publishing the *live status column* is a
  research feed for anyone competing with Tommi. My suggestion: the taxonomy as prose in
  `docs/platform/`, no live numbers.
- **Deviation persistence / decay half-life.** "How fast does this venue heal?" is a legitimate
  venue-quality metric. "These four assets stay dislocated for 78 minutes and 32 % never heal" is a
  hunting map. Same data, different framing; the safe version aggregates across pairs.
- **The looping-carry APR.** All inputs are public, the arithmetic is textbook, and Hydration's own
  UI arguably implies it. But the headline number leans on an off-chain staking rate, moves a lot
  (10.1 % → 4.4 % in 40 days), and sits next to a leverage recipe. If published, publish
  `net_apr_onchain` (the staking=0 floor) at equal prominence — which is exactly what the repo
  already computes.

---

## 7. Drift since 2026-07-10 — everything in arbs-r-us is 40 days stale

Anything reused from that repo must be re-verified, not transcribed. What has already moved:

| Fact | arbs-r-us (2026-07-10) | **Live 2026-08-19** |
|---|---|---|
| Runtime spec | 428 (docs 06/17) / 435 assumed | **435** |
| Block time | 6.86 s measured (doc 07); 6.0 s assumed in code constants | **5.61 s** over the last 100k blocks |
| ⇒ `BLOCKS_PER_DAY` | 14,400 (hardcoded in `dca_forecast.py`) | **~15,390** — every "$/day" figure is ~7 % low |
| Stableswap pools | 16 | **17** |
| Omnipool assets | 20 | **19** |
| HSM collaterals | 4 (aUSDT, aUSDC, sUSDS, sUSDe) | **2** (aUSDT, aUSDC only) |
| OTC open orders | 77 | **78** |
| DCA schedules | 37 (32 active) | **37** (34 with a planned block) |
| DOT/USD | ~$4 (implied by doc 13's capacity math) | **$0.779** |
| vDOT staking APY | 4.48 % | **2.87 %** |
| vDOT redemption rate | 1.654984 | **1.656209** |
| **pool-690 oracle lag** | **112 bps stale** (the headline of doc 13) | **~0 bps** — peg 1.656209 vs Bifrost 1.656209, updated 158 blocks ago |
| DOT borrow APY | 3.50 % | **2.61 %** |
| H10 net APR at 6.67× | +10.1 % | **≈ +4.4 %** |
| Flash-loan bit | 0/23 enabled | **0/23 enabled** (unchanged) |
| Pool 690 amp ramp | not flagged as mid-ramp | ramp `1000 → 222` completed at block **10,308,688** — `final_amplification` is safe to use |

The pool-690 one is worth dwelling on. Doc 13's entire headline — *"the +81 bps vDOT premium is an
oracle-lag artefact"* — depended on the oracle being 112 bps stale. Today the same oracle matches
Bifrost's rate to six digits. The **mechanism** doc 13 describes is real and worth a monitor; the
**reading** was a snapshot of one moment. That is a good argument for building the oracle-lag chart
(a monitor is right in both regimes) and a bad argument for repeating the number.

---

## 8. Things arbs-r-us knows that this repo should absorb regardless

Independent of any dashboard decision, these are facts worth carrying into
`docs/platform/hydration.md`:

- **`Broadcast.Swapped3` is one event per swap *leg*.** Legs of one route share the outermost
  `operationStack` id. This repo's CLAUDE.md already says this — arbs-r-us corroborates it from the
  flow side (330k legs ≈ 139k routes, a 2.4× multiplier).
- **`0x6d6f646c` = `modl`.** ~27 % of Hydration legs are module accounts; `modl:feeproc/` alone is
  111k dust legs of median $0.03. Already in this repo's CLAUDE.md.
- **The money market is inside the swap path.** aToken wrap legs carry **38.7 % of USD volume** —
  more than any AMM — because every major-asset route goes DOT↔aDOT / USDT↔aUSDT / ETH↔aETH. This
  is the single most surprising structural fact about Hydration and it should be a chart.
- **`ann = amp · n`**, not the Curve-paper `A·nⁿ`. Hydration matches Curve's *contracts*, not its
  paper. Confirmed by quoting `calculate_ann` in doc 17.
- **`UNDERLYING_ASSET_ADDRESS()` is selector `0xb16a19de`.** Compute selectors; do not copy them.
- **aToken `balanceOf` is rebased.** The liquidity index is already baked into the unit count, so
  1 aToken redeems 1:1. Treating the index as a conversion is a double-count.
- **The Pool address lives in `Liquidation.BorrowingContract` *storage*** — governance-settable.
  Re-read it; do not hardcode. Same discipline as this repo's "storage keys are computed" rule.
- **`HSM.HollarAmountReceived` resets in `on_finalize`.** An RPC read at a block boundary always
  returns 0. A naive time series of it would be a flat line of zeros.
- **Hydration's own docs are wrong about the HOLLAR floor** (say 0.995, chain says 0.998 on the
  aUSDT/aUSDC legs) and about the buy-back fee direction (it is `p_exec/(1−f)`, a premium to the
  seller, not a haircut).
- **The RPC 403s on `Python-urllib`'s default User-Agent.** Set one server-side.
- **`state_queryStorageAt` + JSON-RPC batch arrays both work** on `rpc.hydradx.cloud`. This is worth
  a line in `docs/architecture/middleware.md` — it changes the cost of every future Substrate source
  this repo adds, not just Hydration.

---

## 9. Open questions I could not settle

1. **Rate limits.** I made a few dozen requests to each upstream and hit nothing. I did not
   probe for the ceiling, and none of the four publishes one. A production refresh loop should
   assume a limit exists and back off on 429/503 rather than discover it.
2. **Subsquid retention and reorg behaviour.** I read events at head−100 and head−600k
   successfully, so retention is at least 600k blocks (~40 days) and almost certainly full history.
   I did not test what it returns for a re-orged block.
3. **The Bifrost `TokenPool`/`TotalIssuance` storage reads.** I verified the endpoint answers and
   that the *dapi* cross-check (`tvm/totalIssuance = 1.656209`) matches the on-chain pool-690 peg to
   six digits. I did **not** re-decode the two Bifrost storage items directly — the CurrencyId
   encoding (`{"VToken2":0}`, and the footgun that `TokenPool` is keyed by the *vToken* id) is taken
   from doc 13, unverified by me.
4. **Whether the vDOT oracle lag is normally 0 or normally 112 bps.** One reading each, 40 days
   apart, disagreeing. That is a question a time series answers and a snapshot cannot.
5. **`analytics/otc_check.py` and `ingestion/watch.py`** I read only their docstrings and the
   research docs describing them, not line-by-line.
6. **The 567 lines of `opportunities.py` after line 1095** (the graph-derived collapse / cross-check
   path). I read the five hand-rolled providers and the sizing hooks; the Phase-D graph-derived
   validation layer I did not.
7. **Whether Hydration's own UI already publishes any of this.** I did not check
   `app.hydration.net`. If it already shows the money-market table, item 2 in §6.3 loses some of its
   novelty (but none of its safety).
