# Hydration

Hydration (formerly HydraDX) is the DeFi parachain at **para id 2034**. Its distinguishing idea is the
**Omnipool**: instead of thousands of pairwise liquidity pools, one pool holds every listed asset, and
every trade is routed through a single hub asset. On top of that sit a stableswap layer, an
Aave-v3-derived money market, an over-collateralised stablecoin (HOLLAR), an OTC book, a DCA
scheduler, and a router that stitches them together. From an analytics point of view the important
thing is that Hydration emits **one event type for every swap on the chain, from every venue** —
`Broadcast.Swapped3` — with a call stack attached. That event, regrouped into trades, is what this
repository's dashboard draws.

Live readings below are from `https://rpc.hydradx.cloud` and `https://explorer.hydradx.cloud/graphql`
on **2026-08-19**, against runtime `specName: hydradx`, `specVersion: 435`. From **2026-08-20** the
dashboard no longer reads the generic Subsquid archive: it reads `routedTrades` on Hydration's own
liquidity-pools squid, which has already done the leg-grouping described below. The grouping rule is
unchanged and still the thing you have to understand — see
[the trade grouping](#operationstack-the-call-stack-and-how-to-deduplicate) and
[where we read this from](#where-we-read-this-from).

Everything in [pricing in dollars](#pricing-in-dollars) was read on **2026-08-20** at block
**13,703,473**, across both planes of `rpc.hydradx.cloud` (Substrate `state_*` and EVM `eth_*`) and
Hydration's own `routedTrades` squid. That section exists because the question *"can DOT be priced
from this chain?"* was answered **wrongly** that day, and the wrong answer was reached by a route that
looked thorough.

---

## The Omnipool

A conventional AMM fragments liquidity: a DOT/USDC pool and a DOT/WBTC pool are separate piles of
money, and moving between USDC and WBTC means paying two sets of slippage on two thin pools.

The Omnipool puts every asset in one pool and gives each a reserve balance plus a quantity of the
**hub asset**. A trade of TKN1 → TKN2 is always executed as two hops inside the pool:

```
TKN1  →  hub  →  TKN2
```

This has three consequences worth understanding:

1. **Liquidity is shared.** Every asset's liquidity is usable by every other asset, because the hub
   leg is common. A thinly-traded asset benefits from the depth of the whole pool on the far leg.
2. **Liquidity provision is single-sided.** You add TKN1 alone. The pool mints hub asset against it to
   keep the invariant, and burns hub asset when you withdraw. You never have to hold the other half
   of a pair, and therefore you never take on the exposure of a pair you did not want.
3. **The hub asset is an accounting token, not a trading token.** It is minted and burnt by the pool.
   Its total supply moves with liquidity, not with demand.

Fees come in two flavours: an **asset fee** on the outgoing asset and a **protocol fee** on the hub
leg. Both accrue to the pool.

### LRNA and H2O

The hub asset was launched as **LRNA** ("Lerna"). It has since been renamed to **H2O**, and the
current documentation uses H2O throughout. Verified live on 2026-08-19 by reading
`AssetRegistry::Assets(1)` from `https://rpc.hydradx.cloud`: asset id 1 decodes as
name `"H2O"`, symbol `"H2O"`, `AssetType::Token`, 12 decimals, sufficient, existential deposit
400,000,000.

Older data, older dashboards and some third-party APIs still say LRNA. **Asset id 1 is the hub asset
under either name** — join on the id, not the symbol.

### Caps and safety rails

The Omnipool has per-asset weight caps (a ceiling on how much of the pool's value any single asset may
represent) and a `CircuitBreaker` pallet that limits net liquidity and trade volume per block.
`DynamicFees` adjusts the asset and protocol fees with recent volatility rather than holding them
fixed. If you are computing effective fee rates, do not assume a constant.

## Stableswap

For assets that should trade near parity — a basket of stablecoins, or a liquid-staking token against
its underlying — a constant-product curve wastes capital. Hydration runs separate **stableswap** pools
using a Curve-style amplified invariant, which keeps the price flat near the peg and only bends
sharply when the pool goes badly out of balance.

Stableswap pools are themselves registered as assets. Verified live: asset id **100** is `4-Pool`,
`AssetType::StableSwap`, 18 decimals. Holding asset 100 means holding a share of that pool. This
matters because a "trade" that adds or removes stableswap liquidity shows up in `Broadcast.Swapped3`
with `operation: LiquidityAdd` / `LiquidityRemove` and the pool share token as the output — it is not
a swap in the ordinary sense, and summing it into swap volume inflates the number.

Stableswap pools can also be *inside* the Omnipool: the pool's share token is listed as an Omnipool
asset, so Omnipool trades can route through the stableswap curve.

### Reading a pool's reserves: deriving the pool account

`Stableswap::Pools(u32) -> PoolInfo` gives the asset list, the amplification and the fee, but **not the
reserves**. The reserves are the balances of the pool's own account, and that account is derived, not
stored:

```
poolAccount = blake2_256("sts" ‖ u32le(poolId))
```

Reserves are then `Tokens::Accounts(poolAccount, assetId)` — except for `Erc20`-typed members, whose
balance lives in EVM storage and needs `balanceOf(poolAccount[0..20])` instead. Half the pools have at
least one such member, so a Substrate-only read silently returns `null` for them.

**Tested, not assumed** (2026-08-20): the derivation was run against pool 100 (`4-Pool`) alongside two
plausible alternatives — `blake2_256(u32le(poolId))` and `blake2_256("stableswap" ‖ u32le(poolId))`.
The `"sts"` form returned a non-zero balance for **4 of 4** pool members; both alternatives returned
0 of 4. A wrong derivation here does not error — it produces a valid-looking account holding nothing,
which reads as "this pool is empty".

**17 pools live on 2026-08-20.** The ones that matter for pricing: `2-Pool` (101) USDT/USDC,
`4-Pool` (100), `3-Pool` (103), `2-Pool-GDOT` (690) vDOT/aDOT, and the HOLLAR pairs `2-Pool-HUSDT`
(111), `2-Pool-HUSDC` (110), `2-Pool-HUSDS` (112), `2-Pool-HUSDe` (113).

## The Router

Users do not choose a venue. They call `Router::sell` or `Router::buy` with an input asset, an output
asset and a route, and the router executes the legs across whatever combination of Omnipool,
stableswap, XYK, OTC, AAVE and HSM gives the best result.

**This is the single most important fact for measuring Hydration.** One user action produces *several*
`Broadcast.Swapped3` events, one per leg, each with its own filler. Naively summing `inputs` across all
`Swapped3` events counts the same money once per hop and produces volume figures that are two to four
times too high. The `operationStack` field exists precisely to let you undo that.

## DCA

`DCA` lets a user schedule a trade to be executed in slices over many blocks — the classic use is
buying into a position gradually to reduce price impact. A schedule has an id, and each execution
runs through the Router.

In the event stream, a DCA execution shows up with `ExecutionType::DCA(schedule_id, execution_id)` in
the operation stack, so all the fills belonging to one schedule share a `schedule_id`. That makes
"how much did DCA move this month" answerable and "how many distinct DCA schedules are active"
answerable, which are different questions.

## The money market

Hydration runs an Aave-v3-derived lending market. Deposits are represented by **aTokens** —
interest-bearing receipt tokens whose balance grows in place rather than by distribution. They are
registered in Hydration's asset registry as ERC-20-backed assets: verified live, asset id **1002** is
`aUSDT`, 6 decimals, `AssetType::Erc20`.

That `Erc20` asset type is not decoration. Hydration runs an `EVM` pallet, and these assets are actual
contracts whose balances live in EVM storage, surfaced into the Substrate asset registry so that the
Router and the Omnipool can trade them. A trade filled by the money market appears with
`fillerType: AAVE`.

**E-mode** ("efficiency mode") is the Aave feature that raises the loan-to-value ratio when collateral
and debt are in the same correlated category — stablecoin against stablecoin, or a liquid-staking
derivative against its underlying. It is what makes leveraged looping of correlated pairs viable, and
it is why a chunk of Hydration's TVL is recursive rather than net new deposits. If you report TVL,
say whether you are netting out loops.

There is also a `Liquidation` pallet, which is how underwater positions are closed — worth watching as
a stress signal.

## HOLLAR and the HSM

**HOLLAR** is Hydration's over-collateralised stablecoin, targeting $1. A user deposits collateral
(DOT, ETH, vDOT, USDT, USDC, tBTC, WBTC among others) and mints HOLLAR up to a loan-to-value ratio,
paying an interest rate on the minted amount — documented at around 5% annually, governance-set, and
subject to change.

**HOLLAR's supply is not in `Tokens::TotalIssuance`.** It is an `Erc20`-typed registry asset, so its
balances and its supply live in the EVM contract; the Substrate-side `Tokens` mirror holds only a
small residue. Reading the mirror understates the supply by roughly 560x and the number means
nothing. This generalises to **every `Erc20`-typed asset in the registry** — assets 1001 (aDOT),
420 (GETH) and 9001 (GSOL) all report `0` there. Read the contract.

Verified live 2026-08-20:

| | Value |
|---|---|
| `AssetRegistry::Assets(222)` | name `"Hydrated Dollar"`, symbol `"HOLLAR"`, `AssetType::Erc20`, 18 decimals |
| `totalSupply()` at `0x531a654d1696ed52e7275a8cede955e82620f99a` | **11,489,093.53 HOLLAR** |
| `Tokens::TotalIssuance(222)` | 20,257.08 — a mirror residue, not the supply |

The contract figure cross-checks: summing `bucketLevel` over the Aave facilitators (Hydration Market,
the HSM, GIGAHDX, the FlashMinter) reproduces `totalSupply()` to the wei. Two independent sources,
one number. So HOLLAR is an eleven-and-a-half-million-dollar stablecoin as of that date — small next
to the majors, but not the twenty thousand the mirror suggests — and on that reading roughly 94% of
it was minted by the money market rather than by the HSM. It is a young token and the figure moves;
date any chart of it, and take the supply from the contract.

The **HSM (HOLLAR Stability Module)** is the peg mechanism, and it is deliberately **asymmetric**:

- **Ceiling side:** the HSM will always sell HOLLAR near $1 against approved collateral. That caps the
  upside — nobody pays $1.05 for something the protocol sells at $1.00.
- **Floor side:** the HSM watches the stableswap pools and decides *when and how much* HOLLAR to buy
  back. It does not commit to buying unlimited HOLLAR at $1, because that would be a free option for
  anyone who could push the pool down.

The asymmetry is the design. A symmetric module is a standing bid that an attacker can drain; an
asymmetric one supports genuine undervaluation without guaranteeing an exit price. A trade filled by
the HSM appears with `fillerType: HSM`.

## Pricing in dollars

Every dollar figure this site publishes about Hydration rests on this section. The short version:
**DOT is asset 5, it is in no Omnipool and no stableswap pool, and it is still priced to four
significant figures from this chain alone, key-free.**

### Find DOT by location, never by ticker

`AssetRegistry::AssetLocations` holds exactly one entry equal to `{parents: 1, interior: Here}` — the
relay chain's own token, seen from a parachain. Its raw SCALE value is the two bytes `0x0100`.
Verified live 2026-08-20, block 13,703,473:

| Id | Name | Symbol | Type | Decimals | Sufficient |
|---|---|---|---|---|---|
| 5 | Polkadot | DOT | Token | 10 | yes |

The registry held **1,437 assets** that day, 680 of them with locations. Ticker collisions are not an
edge case here — **seven distinct assets carry `USDC` or `USDT`** (see
[the asset registry](#the-asset-registry)). Match on location; the ticker is a label, not a key.

### Where DOT trades, and where it does not

Verified live, 2026-08-20, block 13,703,473:

| Venue | Contains asset 5? |
|---|---|
| `Omnipool::Assets` — 19 assets | **No.** It carries `aDOT` (1001) and `vDOT` (15) |
| `Stableswap::Pools` — 17 pools | **No.** No pool lists asset 5 |
| `XYK::PoolAssets` — 290 pools | **Yes — 122 of them.** DOT is the single most common XYK asset |
| Money market — 23 reserves | **Yes.** 5,594,982 DOT supplied, $4.62 M |

**This table is a trap, and it was sprung on 2026-08-20.** An agent enumerated the Omnipool, found no
DOT; enumerated the stableswap pools, found no DOT; checked the XYK pools, found nothing but dust
against long-tail tokens; and concluded that DOT cannot be priced from what this repository reads.
Each enumeration was correct. The conclusion was wrong, and this repository was already publishing
DOT's price in production while the report was being written.

Two things defeat the pool-membership reasoning:

- The XYK pools are not uniformly dust. The deepest hold real money — 29,587 DOT against `WUD`,
  20,222 DOT against `MYTH`, 1,565 DOT against `UNQ`. What *is* dust is the only XYK pool pairing DOT
  with a stablecoin: 6.62 USDC against 8.47 DOT. So there is genuinely no liquid DOT/stable **pool**.
- There does not need to be one. **DOT traded against USDT 168 times and against USDC 50 times in a
  single 24-hour window** (300 DOT legs in total). The pair trades constantly; it simply is not a pool.

### The route: how DOT reaches a stablecoin

Traced live, block **13,696,298**, 2026-08-20 — one routed trade, 19.8424 DOT → 15.6708 USDT, six legs:

| # | `fillerType` | Leg |
|---|---|---|
| 0 | **`AAVE`** | 19.8424 DOT → 19.8424 aDOT |
| 1 | `Stableswap` (`2-Pool-GDOT`, 690) | 19.8424 aDOT → 11.9796 vDOT |
| 2 | `Omnipool` | 11.9796 vDOT → 2.8874 H2O |
| 3 | `Omnipool` | 2.8856 H2O → 15.6947 HOLLAR |
| 4 | `Stableswap` (`2-Pool-HUSDT`, 111) | 15.6947 HOLLAR → 15.6708 aUSDT |
| 5 | **`AAVE`** | 15.6708 aUSDT → 15.6708 USDT |

The first and last legs are money-market wraps, and they are **exactly 1:1**. Across **all 282
`AAVE`-filled DOT↔aDOT legs in 24 hours the maximum relative deviation from 1:1 was `0`** — not
approximately equal, identical to the last raw unit (verified live 2026-08-20). The same holds for the
other wrap pairs: `USDT↔aUSDT`, `USDC↔aUSDC`, `ETH↔aETH`.

So **aDOT's price is DOT's price**, by construction rather than by arbitrage, and the Omnipool's aDOT
listing is a DOT listing wearing a receipt token.

### The money-market oracle — the direct answer

The Aave fork carries a price oracle, and it prices DOT directly. Discovery is by traversal, never by
a hardcoded address: `aDOT.POOL()` → `pool.ADDRESSES_PROVIDER()` → `provider.getPriceOracle()`.

| | Verified live 2026-08-20 |
|---|---|
| Oracle | `0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760` |
| Pool | `0x1b02e051683b5cfac5929c25e84adb26ecf87b38` |
| Addresses provider | `0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691` |
| `BASE_CURRENCY_UNIT()` | `100000000` (1e8) |
| `BASE_CURRENCY()` | `0x0` — i.e. USD, not a token |
| `getAssetPrice(0x…0100000005)` | `82600237` → **$0.82600237** |

DOT's EVM address is the Substrate-asset form `0x` + 31 zeros + `1` + the u32 id big-endian, so asset
5 is `0x0000000000000000000000000000000100000005`.

**`getAssetPrice(aDOT)` reverts.** The oracle prices *underlyings*, not aTokens; an aToken's price is
its underlying's price, and there is no separate entry to look up. A caller that treats the revert as
"aDOT has no price" and falls back to zero will value the Omnipool's largest DOT position at nothing.

Each asset has its own feed contract — DOT's is `0xfbca0a6dc5b74c042df23025d99ef0f1fcac6702`, whose
`description()` returns `"DOT/USD Oracle"`.

**The feed is stepped, not continuous.** Sampling every 60 blocks over 24 hours returned **18 distinct
values**, ranging $0.7814–$0.8260. It can therefore lag a fast move by up to about an hour. Say so
wherever the number is drawn.

**Where the feed ultimately sources its number is `inferred`, not verified.** What *is* verified live
is that the price is computed at call time rather than stored: storage slots 0–4 of the feed contract
were byte-identical across a 2,000-block gap while `latestAnswer()` moved. But `debug_traceCall` and
`trace_call` are both `Method not found` on `rpc.hydradx.cloud`, so the call graph could not be
followed and no precompile was found at the usual addresses. Do not claim on a page that this price is
chain-internal and trust-free until someone reads the fork's source.

**How far it reaches is now measured, not asserted.** `getAssetPrice` was called on **all 1,438**
registry ids on 2026-08-21. It answered for **23**, and that set is exactly `Pool.getReservesList()`
— so "a revert means *not a reserve*, not *no market*" is a measured property of today's oracle
rather than an inference from Aave's source. (Reading the fork would upgrade it to a guarantee; not
done.)

⚠️ **That 23 only appears if `Erc20`-typed assets are asked for by CONTRACT.** The oracle is keyed
by two different kinds of address: a Substrate registry asset is `0x` + 31 zero bytes + `01` + the
u32 id big-endian, but an `Erc20`-typed one is the contract in its `AssetLocations` entry. Keyed by
id alone the oracle answers for 22 and **silently drops HOLLAR** — the market's dollar-pegged asset
and the Omnipool's best hub anchor. Nothing errors. See
[prices.md](prices.md#the-oracle-is-keyed-by-two-different-kinds-of-address-and-asking-wrong-looks-like-no-price).

### The second path: the Omnipool's own implied spot

Independent of the oracle, and — as of 2026-08-21 — good enough to be a **labelled fallback** rather
than only a reconciliation. For an Omnipool asset, price-in-hub is `hub_reserve / reserve`, both in
whole units; dividing two of those cancels the hub and gives a ratio. HOLLAR is in the Omnipool and
is dollar-pegged, so:

```
usd(asset) = (hub_reserve_asset / reserve_asset) / (hub_reserve_HOLLAR / reserve_HOLLAR)
```

The catch is `reserve`. `Tokens::Accounts(omnipoolAccount, id)` returns **`null` for 5 of the 19**
Omnipool assets — HOLLAR, aDOT, GETH, GSOL and one more are `Erc20`-typed and their balances live in
EVM storage, reachable only by `balanceOf` on the contract. HDX is a third case again, in
`System::Account`. Three storage paths, one balance sheet; miss one and the asset silently disappears
rather than erroring.

**Reconciliation, 2026-08-20:**

| Path | DOT/USD |
|---|---|
| Money-market oracle | $0.82600237 |
| Omnipool implied spot for aDOT (this repo's `spotUsd`) | $0.826435 |
| Off-chain control (a CEX aggregate, run by hand, not shipped) | $0.8283 |

Oracle against Omnipool: **0.05 %**. Oracle against the off-chain control: **−0.28 %**. Three
independent constructions of the same number.

**Reconciled again on 2026-08-21, this time across every asset both venues carry** — four of them,
which is what turned this path from a check into a fallback:

| Asset | Money-market oracle | Omnipool implied spot | Difference |
|---|---:|---:|---:|
| vDOT | 1.43861370 | 1.44036671 | **+0.122 %** |
| PAXG | 4562.50561 | 4585.68916 | **+0.508 %** |
| HOLLAR | 1.00000000 | 0.99878442 | **−0.122 %** |
| tBTC | 76857.09235 | 76657.87743 | **−0.259 %** |

Worst case half a percent; re-run an hour later the worst was tBTC at −0.559 %. Treat "under one
percent" as the claim and the live figure on the page as the measurement. `server/sources/prices.mjs`
publishes the Omnipool figure with a **different `source` label** and never merges it into the
oracle's — the discipline
[decision 0013](../decisions/0013-the-pricer-and-the-valuation-share-a-module.md) exists for. Between
them the two paths price **38 distinct assets**, 23 + 19 with four in the overlap; the full table and
the hub-anchor arithmetic are in [prices.md](prices.md).

### `deriveRates` already resolves DOT

`src/core/pricing.js` medians implied rates over observed swap legs and sweeps repeatedly. Fed one real
day of Hydration trades (4,099 routed trades, 2026-08-20), it returns **`DOT = 0.802309` from 219
observations** — the third most-observed asset after HDX and H2O. It also resolves `aDOT` (0.8189) and
`vDOT` (1.3103). Nothing needs adding for DOT to price.

**But it is a day median, not a spot.** DOT moved +9.5 % during that window ($0.754 → $0.826), so the
median sits 2.9 % below the oracle's closing figure. That is correct for valuing *that day's trades*
and wrong as "the current price". Do not use `deriveRates` output as a live quote.

### Historical prices, from the archive

`rpc.hydradx.cloud` answers `eth_call` at historical blocks, so the oracle can be read at any past
block. Binary-searched, verified live 2026-08-20:

> The money-market oracle first answers for DOT at block **6,382,861**, timestamp
> **2024-11-12T14:28:24Z**, price **$5.25282543**. Block 6,382,860 returns `0x`.

That is roughly 21 months of daily DOT/USD, at one batched `eth_call` per point. Before that date
there is no on-chain DOT/USD from this source — the market did not exist yet.

Checked against an off-chain daily series over 45 days at 00:00 UTC: **median absolute difference
0.16 %, p90 0.36 %, worst 0.46 %.** They are the same series.

**⚠ Two traps in that comparison, both of which produce plausible wrong numbers.**

1. **Never extrapolate a block height from a date.** See
   [block time is a trailing average](#block-time-is-a-trailing-average-not-a-constant) below. A first
   pass at this reconciliation assumed 12 s blocks and reported a **4.5 % median oracle discount** that
   was entirely an artefact of sampling the wrong blocks.
2. **A daily bar's label is its open, not its close.** A read at 00:00 UTC on day *D* corresponds to
   day *D*'s **open**. Comparing it against day *D*'s close leaves a spurious one-day offset worth
   about 1.4 % median — small enough to look like genuine oracle drift.

### Block time is a trailing average, not a constant

Measured on 2026-08-20 from `Timestamp::Now` at both ends of each window:

| Window | Average block time |
|---|---|
| last 7,200 blocks | **5.730 s** |
| last 50,400 blocks | 5.710 s |
| last 216,000 blocks | 5.612 s |
| last 432,000 blocks | 5.787 s |
| last 1,296,000 blocks | 6.472 s |
| last 2,628,000 blocks | **6.845 s** |

**And it has been much slower than any of those.** Measured a different way on 2026-08-20 — resolving
whole UTC days to block heights off orca's `blocks` table, so each row is a real day divided by its
real block count:

| Day | Blocks in the UTC day | Average block time |
|---|---:|---:|
| 2025-01-25 | 6,188 | **13.96 s** |
| 2025-02-15 | 6,230 | 13.87 s |
| 2025-04-10 | 6,307 | 13.70 s |
| 2025-06-20 | 13,880 | 6.22 s |
| 2025-09-05 | 14,231 | 6.07 s |
| 2025-12-01 | 14,047 | 6.15 s |
| 2026-02-14 | 12,584 | 6.87 s |
| 2026-05-01 | 10,291 | 8.40 s |
| 2026-07-15 | 17,702 | **4.88 s** |
| 2026-08-19 | 14,855 | 5.81 s |

The chain roughly halved its block time between April and June 2025 and has drifted since; a day has
held as few as **6,188** blocks and as many as **17,702**, a factor of 2.9. Anything that walks
history — a backfill stepping day by day, a "block at this date" lookup — must carry a *measured*
local rate forward and check it, never a constant. `server/sources/hydration.mjs`'s `swaps-daily` job
hints each day's boundary with the previous day's own observed block count, cut by a quarter, and
falls back to a full scan when its own probe says the hint overshot.

Assuming 12 s puts a "365 days ago" label on a block that is actually **208 days** old. This repository
already knew: `docs/concept/plan.md` and `docs/concept/research/critique.md` record 6.22 s / 1 k,
5.82 s / 20 k, 5.61 s / 200 k, and `server/sources/hydration.mjs` opens by saying day boundaries come
from asking the chain, never from multiplying an assumed rate. **It was got wrong anyway, on
2026-08-20, by an agent that had read neither.** The rule, restated so the next person meets it here:

> To find the block at an instant, **bisect on `Timestamp::Now`**. Seed the search with a measured
> local rate if you want it fast, but the accept condition is the timestamp, never the arithmetic.

### Page notes

Drafted from the readings above so that whoever builds the next dollar figure does not re-derive the
caveat. Rule 3 says the number carries its own caveat; these are those caveats.

**For a live DOT price:**

> DOT is priced by Hydration's money-market oracle (an Aave v3 fork), read live. It is a stepped feed
> — about 18 updates a day, not per block — so it can lag a fast move by up to an hour. Cross-checked
> against the Omnipool's own implied spot (aDOT priced against HOLLAR), which agreed to 0.05 %. DOT
> itself is in no Omnipool or stableswap pool: it reaches the dollar through a 1:1 money-market wrap
> to aDOT, and every DOT↔aDOT conversion observed over 24 hours was exactly 1:1.

**For a historical DOT series:**

> Historical DOT/USD is read from Hydration's money-market oracle at each day's first block after
> 00:00 UTC. The series begins 2024-11-12, when that oracle was deployed; there is no on-chain DOT/USD
> before that date. Spot-checked against an off-chain reference over 45 days: median difference
> 0.16 %, worst 0.46 %.

## OTC

`OTC` is a simple on-chain order book for bilateral trades: someone posts an order with an id, someone
else fills it partially or fully. It is not an AMM and has no curve. Router legs can be filled from
OTC, in which case `fillerType` is `OTC(order_id)`.

## ICE

**ICE** (Intent Composing Engine) is Hydration's announced intent-based execution layer: users submit
intents rather than trades, solvers compose a solution that clears them against each other and against
the Omnipool, and one solution per block is accepted, with solvers slashable for invalid solutions.

**Status, verified rather than assumed.** As of 2026-08-19 we could find **no evidence that ICE is
live on Hydration mainnet**:

- The live runtime metadata (specVersion 435, 535 KB) contains **zero occurrences** of the strings
  `ICE`, `Ice`, `Solver`, `solver`, `Solution` or `Intent`.
- No storage keys exist under an `ICE`, `Ice`, `Intent`, `Intents` or `Solver` pallet prefix.
- The `ExecutionType` enum in `hydration-node` at the latest tag (v50.0.2) has exactly six variants,
  none of them ICE.
- A sweep of **34,275 legs** across three full days (heights 13,647,603-13,690,804) pulled from the
  Subsquid archive on 2026-08-19 contained **no `ICE` value at all** in `operationStack`.

If your indexer's generated types include an `ICE` variant in `operationStack`, it comes from a
different spec version, a testnet, or a hand-edited schema. **Do not write a decoder that assumes the
enum is closed at six variants** — Hydration adds them — but equally, do not report ICE volume today.
Treat unknown `__kind` values as "unrecognised" and surface them rather than dropping them.

---

## `Broadcast.Swapped3` — the event our dashboard reads

`pallet-broadcast` exists so that every swap on Hydration, whatever executed it, emits one uniform
event. From the pallet source (`pallets/broadcast/src/lib.rs`, tag v50.0.2):

```rust
Swapped3 {
    swapper:         T::AccountId,
    filler:          T::AccountId,
    filler_type:     Filler,
    operation:       TradeOperation,
    inputs:          Vec<Asset>,          // Asset { asset: u32, amount: u128 }
    outputs:         Vec<Asset>,
    fees:            Vec<Fee<T::AccountId>>,   // Fee { asset, amount, destination }
    operation_stack: Vec<ExecutionType>,
}
```

The name is archaeology: `Swapped` had wrong input/output amounts for XYK buy trades, `Swapped2` had
the wrong filler account on AAVE trades, and `Swapped3` is the one that is correct. The doc comments
in the source say exactly this. **Do not read `Swapped` or `Swapped2` from historical data expecting
correct numbers** — that is a real, documented data-quality bug, not a naming preference.

In the Subsquid archive the fields come back camelCased with `__kind` tags on enums:

```json
{
  "swapper": "0x108a74…bc22",
  "filler":  "0x30923f…0615",
  "fillerType":  { "__kind": "XYK", "value": 1000169 },
  "operation":   { "__kind": "ExactIn" },
  "inputs":  [ { "asset": 5,       "amount": "38207071742" } ],
  "outputs": [ { "asset": 1000081, "amount": "235542478991108" } ],
  "fees":    [ { "asset": 1000081, "amount": "708753698067",
                 "destination": { "__kind": "Account", "value": "0x30923f…0615" } } ],
  "operationStack": [ { "__kind": "Batch",  "value": 10623345 },
                      { "__kind": "Router", "value": 10623346 } ]
}
```

That is a real event from block 13,690,119, fetched live on 2026-08-19.

### `Filler` — which venue executed the leg

From source (`pallets/broadcast/src/types.rs`, v50.0.2):

| Variant | Payload | Meaning |
|---|---|---|
| `Omnipool` | — | Filled by the Omnipool |
| `Stableswap(AssetId)` | pool id | Filled by a stableswap pool |
| `XYK(AssetId)` | share token | Filled by a constant-product pool |
| `LBP` | — | Liquidity bootstrapping pool |
| `OTC(OtcOrderId)` | order id | Filled against an OTC order |
| `AAVE` | — | Filled by the money market |
| `HSM` | — | Filled by the HOLLAR Stability Module |

Values observed live: `Omnipool`, `Stableswap`, `XYK`, `AAVE`, `OTC`, `HSM`. `LBP` exists in the enum
but is not currently in use.

**How much each venue actually fills** — 5,000 legs over ~24 h, squid field `fillerType`, verified live
2026-08-20:

| Filler | Legs | Share |
|---|---:|---:|
| `Omnipool` | 3,381 | 67.6% |
| `AAVE` | 803 | 16.1% |
| `Stableswap` | 713 | 14.3% |
| `XYK` | 103 | 2.1% |

**One leg in six is filled by the money market.** That is not a lending event leaking into the swap
stream — it is the router wrapping and unwrapping aTokens mid-route, and it is the mechanism that lets
assets which are in no pool at all still trade against everything else. See
[pricing in dollars](#pricing-in-dollars).

### `TradeOperation`

`ExactIn`, `ExactOut`, `Limit`, `LiquidityAdd`, `LiquidityRemove`.

The last two are **not swaps**. They are liquidity events that happen to go through the same execution
path. Including them in swap volume is a straightforward overcount — in the live sample above, the
fourth leg of a single user action was a `LiquidityAdd` into stableswap pool 4200.

### `operationStack` — the call stack, and how to deduplicate

`operation_stack` is `Vec<ExecutionType>`, and it is a stack: outermost context first, innermost last.
The variants, verified against live runtime metadata at specVersion 435:

| Variant | Payload |
|---|---|
| `Router(id)` | incremental id |
| `DCA(schedule_id, id)` | DCA schedule id plus incremental id |
| `Batch(id)` | incremental id |
| `Omnipool(id)` | incremental id |
| `XcmExchange(id)` | incremental id |
| `Xcm([u8; 32], id)` | XCM message id plus incremental id |

**The grouping rule: legs belonging to one user action share the FIRST element of `operationStack`.**
Look at the live example — four `Swapped3` events in block 13,690,119, all with the same swapper:

| Leg | fillerType | operation | operationStack |
|---|---|---|---|
| 1 | `XYK(1000169)` | ExactIn | `[Batch(10623345), Router(10623346)]` |
| 2 | `XYK(1001150)` | ExactIn | `[Batch(10623345), Router(10623346)]` |
| 3 | `AAVE` | ExactIn | `[Batch(10623345), Router(10623346)]` |
| 4 | `Stableswap(4200)` | LiquidityAdd | `[Batch(10623345), Router(10623347)]` |

All four share `Batch(10623345)`. The first three also share `Router(10623346)`; the fourth is a
*second* router invocation, `Router(10623347)`, inside the same batch. So:

- Group on `operationStack[0]` → one user action.
- Group on the last `Router(...)` → one routed trade within that action.

**`operationStack` can be empty, and the rule as stated above does not cover that case.** A swap
executed with no enclosing context arrives with a zero-length stack, so there is no `operationStack[0]`
to group on. It is not rare enough to ignore — 42 of 12,545 legs in the sample below.

Read literally, "group on `operationStack[0]`" would key every one of those legs to the same missing
value and merge unrelated single-hop trades into one giant fake trade. If you implement the grouping
rule yourself, decide what an empty stack means before you write the key expression, not after: a
stackless leg is its own single-leg trade.

**This repository no longer implements the rule; it checks that somebody else did.** Hydration's own
liquidity-pools squid exposes `routedTrades`, one row per user action, and its `routeId` is the same
`Broadcast::IncrementalId` this rule groups on — so the two agree by construction rather than by
agreement. `server/sources/hydration.mjs` reads those rows and reports
`legCount / tradeCount` on the page, so the factor the grouping removes stays a visible number instead
of becoming an invisible assumption. Measured over 2026-08-07…08-20: **80,656 trades from 182,178
legs, a factor of 2.26.**

A stackless leg arrives from the squid as a `routedTrade` whose `routeId` is `null` and whose single
swap has `operationId: null`. This codebase labels those **`Direct`**, which is a name we invent —
**it is not a chain-side `ExecutionType` variant** and you will not find it in the runtime metadata.

The squid flattens the stack into a string, `Kind:value[:value][/Kind:value…]`, and the first segment
is `operationStack[0]`. Live examples:

```
Omnipool:10633826                                     a direct Omnipool swap
Router:10633824/Omnipool:10633825                     a routed trade
DCA:30104:10619288/Router:10619289                    one instalment of DCA schedule 30104
Batch:10500710/Router:10500711                        a swap inside a batch
Xcm:e7f485122fbaa3c2247c61b1bfc62b66:10623796/Router:10623797   a swap triggered by an XCM message
```

### Observed first-element distribution

Counts for the first element of `operationStack` over one full day (18→19 August 2026, 12,545 legs),
from a sweep of the Subsquid archive on 2026-08-19:

| First element | Legs | Share |
|---|---:|---:|
| `Router` | 4,647 | 37.0% |
| `Omnipool` | 4,554 | 36.3% |
| `DCA` | 3,042 | 24.2% |
| `Batch` | 259 | 2.1% |
| *(empty stack)* | 42 | 0.3% |
| `Xcm` | 1 | 0.008% |

Two things to take from this. First, **`Xcm` is a real live variant, not a theoretical one** — it
appeared once in 12,545 legs, which is exactly the frequency at which a hard-coded list of "the four
kinds we've seen" gets written and then silently drops a real trade. Second, `XcmExchange` did not
appear in this window, which is not evidence it cannot: absence over one day at these rates tells you
very little. Enumerate from the runtime metadata, not from an observed sample, and treat any
unrecognised `__kind` as a value to surface rather than discard.

**Re-confirmed on 2026-08-20 against the squid, over a fourteen-day window** (2026-08-07…08-20,
80,656 trades): `Router`, `DCA`, `Omnipool`, `Batch`, empty-stack, **and `Xcm`** — five `Xcm`-initiated
legs between blocks 13,608,128 and 13,690,441, each carrying a 32-byte XCM message id in the payload
(`Xcm:e7f485122fbaa3c2247c61b1bfc62b66:10623796`). One day of sampling saw `Xcm` once; two weeks saw
it five times. It is rare, it is real, and a fixed five-variant list would have dropped it.
`XcmExchange` still has not been observed.

For volume, the correct figure for a routed trade is the **first leg's `inputs`** and the **last leg's
`outputs`**; the intermediate hops are the same money moving. In the sample, the user sold 38.2 DOT
(asset 5), which passed through asset 1000081, then asset 34, then asset 1007, and ended as a
stableswap LP position in asset 4200. Summing `inputs` across all four legs would count that money
four times.

**Getting this wrong is not a rounding error.** For a chain where most flow is routed through two to
four hops, naive summation reports volume inflated by a factor of two to four, consistently, and the
chart looks entirely plausible.

## The asset registry

`AssetRegistry::Assets(u32)` decodes as, in order:

```
Option<name>            SCALE Option + length-prefixed bytes
AssetType               1 byte: 0=Token, 1=XYK, 2=StableSwap, 3=Bond, 4=External, 5=Erc20
existential_deposit     u128
Option<symbol>
Option<decimals>        u8
Option<xcm_rate_limit>  u128
is_sufficient           bool
```

Verified live on 2026-08-19:

| Id | Name | Symbol | Type | Decimals | Notes |
|---|---|---|---|---|---|
| 0 | Hydration | HDX | Token | 12 | Native token; ED = 1 HDX |
| 1 | H2O | H2O | Token | 12 | Omnipool hub asset (formerly LRNA) |
| 5 | — | DOT | Token | 10 | Reserve-transferred from the relay chain |
| 19 | — | WBTC | Token | 8 | |
| 22 | USDC | USDC | Token | 6 | Reserve-transferred from Asset Hub; `xcm_rate_limit` set |
| 100 | 4-Pool | — | StableSwap | 18 | A stableswap pool's share token |
| 222 | Hydrated Dollar | HOLLAR | Erc20 | 18 | The native stablecoin |
| 1002 | — | aUSDT | Erc20 | 6 | A money-market aToken |

Decimals are **per asset and read from this registry**. HDX is 12, DOT is 10, USDC is 6, WBTC is 8,
HOLLAR is 18. There is no default. Hard-coding 12 because HDX is 12 turns every USDC figure into
nonsense by a factor of a million, and the chart will render happily.

`xcm_rate_limit` is a throttle on how much of an asset may arrive per period via XCM — a bridge-risk
control. Its presence on USDC and absence on HDX is informative in itself.

Cross-chain, remember that **asset id 22 means USDC only on Hydration.** On Asset Hub the same token
is asset 1337, and the only stable identifier across chains is the XCM `Location` — see
[xcm.md](xcm.md) and [asset-hub.md](asset-hub.md).

### One ticker, seven assets

The collision is not hypothetical and it is not rare. Verified live 2026-08-20, every registry entry
whose symbol is exactly `USDC` or `USDT`:

| Id | Symbol | Name | Decimals | Location |
|---|---|---|---:|---|
| 7 | USDC | USD Coin (Acala Wormhole) | 6 | para 2000, `GeneralKey` |
| 10 | USDT | Tether | 6 | para 1000, pallet 50, index **1984** |
| 21 | USDC | USDC (Wormhole) | 6 | local `GeneralKey` `wh`, Ethereum `0xa0b8…eb48` |
| 22 | USDC | USDC | 6 | para 1000, pallet 50, index **1337** |
| 23 | USDT | Tether (Wormhole) | 6 | local `GeneralKey` `wh`, Ethereum `0xdac1…1ec7` |
| 1000766 | USDC | USDC (Ethereum native) | 6 | `GlobalConsensus(Ethereum)` + `0xa0b8…eb48` |
| 1000767 | USDT | Tether (Ethereum native) | 6 | `GlobalConsensus(Ethereum)` + `0xdac1…1ec7` |

Plus `aUSDC` (1003) and `aUSDT` (1002), the money-market receipts, and `HOLLAR` (222), which is not
pegged by a reserve but by the HSM.

**Two of these are the same Ethereum token arriving by two different bridges** (21 and 1000766 are both
Circle's USDC contract, one via Wormhole and one via Snowbridge), which is a real arbitrage and a real
risk difference. Collapsing them by symbol turns that into a nonsensical USDC→USDC route and hides
which bridge a holding depends on.

⚠️ **And the symbol is the *easier* half of this trap.** Hydration registers the same Ethereum ERC-20
**once per bridge**, so the contract address looks like a safe key and is not: it carries **two
WBTCs and two sUSDSs** backed by the same Ethereum contract, one arriving over Wormhole and one over
Snowbridge, as separate registry ids with separate liquidity. Which one the money market took is not
guessable — asset 19 `WBTC` is the **Wormhole** wrapper and is oracle-priced, while the Snowbridge
one (1000190) reverts. Counted by route rather than by ticker there were five USDCs, three WETHs,
three WBTCs, three USDTs and three DAIs on 2026-08-21. **Never key a price by the ticker, and never
key it by the underlying contract either — the bridge that wrapped it is part of the asset's
identity.** The full table, with the location bytes of each route shape, is in
[prices.md](prices.md#the-trap-hydration-registers-the-same-token-once-per-route).

For *rate derivation* specifically, collapsing them is harmless — they are all worth about a dollar,
which is what `USD_PEGGED` in `src/core/pricing.js` assumes. For anything that counts supply, holders
or flows, it is a factual error. `server/sources/hydration.mjs` splits the two cases deliberately:
`symbolOf` (bare ticker) feeds `deriveRates`, `labelOf` (ticker + registry id, applied only when a
ticker is shared) feeds anything a reader sees.

## Balances

Hydration uses `orml-tokens`, not `pallet-balances`, for everything except HDX:

- `Tokens::Accounts(AccountId32, u32) -> AccountData { free, reserved, frozen }`
- `Tokens::TotalIssuance(u32) -> u128`
- `Balances` (the FRAME pallet) holds HDX only.

Verified live 2026-08-19: `Tokens::TotalIssuance(22)` = 5,285,081.65 USDC,
`Tokens::TotalIssuance(5)` = 4,539,428.23 DOT.

`TotalIssuance` is only the supply for `Token`-typed assets. For an `Erc20`-typed asset it is a
mirror residue: `Tokens::TotalIssuance(222)` read 20,257.08 on 2026-08-20 while HOLLAR's contract
reported 11,489,093.53. See [HOLLAR and the HSM](#hollar-and-the-hsm).

The USDC figure is the one to cross-check against Hydration's sovereign account on Asset Hub — see the
reserve invariant in [xcm.md](xcm.md). They agreed to within 425 USDC on 2026-08-19.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| RPC | `https://rpc.hydradx.cloud` (public, no key). `specName: hydradx`, `specVersion: 435` on 2026-08-19 |
| **Trades (what the dashboard reads)** | `https://orca-prod-pool-01.orca.hydration.cloud/graphql` — Hydration's own liquidity-pools squid, `routedTrades`. Second host `https://orca-prod-pool-02.catfish.hydration.cloud/graphql`, identical schema |
| Subsquid archive | `https://explorer.hydradx.cloud/graphql` — generic archive with `blocks`, `events`, `calls`, `extrinsics`, `metadata`. **No longer read by this repository** |
| Swaps, the hard way | `events(where: {name_eq: "Broadcast.Swapped3"})` on the generic archive, then group by hand |
| Asset registry | `AssetRegistry::Assets(u32)`, `AssetRegistry::AssetIds`, `AssetRegistry::AssetLocations` |
| Balances | `Tokens::Accounts(AccountId32, u32)`, `Tokens::TotalIssuance(u32)`, `Balances::*` for HDX |
| Omnipool state | `Omnipool::Assets(u32) -> AssetState { hub_reserve, shares, protocol_shares, cap, tradable }` |
| Stableswap | `Stableswap::Pools(u32)` |
| Money market | `EVM` storage plus the `Erc20`-typed entries in `AssetRegistry`; `Liquidation` pallet events |
| HOLLAR supply | `eth_call totalSupply()` at `0x531a654d1696ed52e7275a8cede955e82620f99a`; cross-checked against the squid's `aaveFacilitators` bucket levels. **Not** `Tokens::TotalIssuance(222)` |
| HOLLAR peg mechanism | `HSM` pallet storage |
| Prices, runtime-internal | `EmaOracle` — exponential moving-average oracle used by the runtime itself |
| **Prices, USD** | `getAssetPrice(address)` on the money-market oracle `0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760`, divided by `BASE_CURRENCY_UNIT()` = 1e8. Discovered by traversal from `aDOT.POOL()`, never hardcoded. Answers at historical blocks back to 6,382,861 (2024-11-12). See [pricing in dollars](#pricing-in-dollars) |
| Omnipool implied spot | `Omnipool::Assets` `hub_reserve` ÷ the reserve, ratioed against HOLLAR's. Reserves come from **three** storage paths — `Tokens::Accounts`, `System::Account` (HDX), and EVM `balanceOf` (`Erc20` assets) |
| XCM in/out | `PolkadotXcm`, `XTokens` extrinsics; `MessageQueue` events |

**Archive query hygiene.** `https://explorer.hydradx.cloud/graphql` will return
`canceling statement due to statement timeout` on an unbounded `Broadcast.Swapped3` scan — the table
is very large. Always constrain with a block height range (`block: {height_gt: N}`) and page. Verified
again on 2026-08-20: asking it for the single oldest `Broadcast.Swapped3` timed out after 12.3 s. That
is the reason this repository stopped reading it.

### How far back the trade data goes, and why the chart starts where it does

Three different floors, and confusing them is how a chart acquires an unexplained start date:

| Floor | Block | Date | What it means |
|---|---:|---|---|
| squid `swaps` (legs) | 5,000,006 | 2024-04-28 | oldest individual leg the squid indexes |
| squid `routedTrades` | **6,837,788** | **2025-01-25 05:58:36 UTC** | oldest leg-grouping — **the floor for this page** |
| first `Broadcast.Swapped3` | 7,567,547 | 2025-05-19 | the event our old source depended on |

All three read live on 2026-08-20. The middle row is the one that bounds the dashboard: orca reaches
**730,000 blocks / almost four months earlier** than the event the previous implementation needed,
because it also indexes the older `Swapped` event versions that `Swapped3` replaced. The page reads
this floor on every request rather than hard-coding it, states it in its data notes, and clamps a
window that would reach past it instead of drawing empty days that only look like a dead market.

**The window is capped at 14 days by us, not by the data.** Measured against orca on 2026-08-20:
~8,500 routed trades a day, 468 bytes a row on the wire, ~330 ms per 1,000-row page — so one day costs
~3 s and fourteen days ~24 s. Thirty days is ~181,000 trades and about a minute, which is a page load
nobody waits through. Longer windows need the job queue, not a bigger number in the schema.

**Two "Hydration volume" numbers, both defensible.** Over blocks 13,494,903–13,700,931 orca's own
`platformTotalVolumesByPeriod` reports **$18,454,010** of pool volume while this dashboard reports
**$7,193,917** — 2.57×. The first is the notional that crossed each *pool*, so a route through a
stableswap and the Omnipool is counted in both; the second is what the traders sent, once. The
dashboard fetches both and states the ratio, because a volume figure without that sentence is
unfalsifiable.

### Backfilling the whole history: what orca actually holds, and what it costs

Read on 2026-08-20 off `orca-prod-pool-01`, one boundary scan and one `totalCount` per month —
exact counts, not a sample. Month edges are the first block at or after `YYYY-MM-01T00:00:00Z`.

| Month | Blocks | Routed trades | Trades/day |
|---|---:|---:|---:|
| 2025-01 | 191,008 | 41,263 | 1,331 (trading starts on the 25th) |
| 2025-02 | 172,858 | 253,894 | 9,068 |
| 2025-03 | 196,985 | 298,804 | 9,639 |
| 2025-04 | 196,965 | 345,473 | 11,516 |
| 2025-05 | 282,447 | 455,657 | 14,699 |
| 2025-06 | 417,414 | 352,149 | 11,738 |
| 2025-07 | 439,960 | 336,631 | 10,859 |
| 2025-08 | 441,463 | **590,441** | **19,046** |
| 2025-09 | 424,876 | 416,086 | 13,870 |
| 2025-10 | 438,915 | 438,374 | 14,141 |
| 2025-11 | 423,257 | 401,000 | 13,367 |
| 2025-12 | 435,841 | 263,994 | 8,516 |
| 2026-01 | 434,408 | 350,473 | 11,306 |
| 2026-02 | 368,732 | 302,077 | 10,788 |
| 2026-03 | 381,025 | 500,239 | 16,137 |
| 2026-04 | 331,724 | 393,960 | 13,132 |
| 2026-05 | 311,157 | 199,520 | **6,436** |
| 2026-06 | 379,230 | 299,287 | 9,976 |
| 2026-07 | 449,931 | 226,758 | 7,315 |
| 2026-08 (1–19) | 289,810 | 119,355 | 6,282 |
| **total** | | **6,585,435** | **11,050** |

**Sizing a backfill off the live window underestimates it by about a third.** The 14-day window
measured ~8,500 trades a day; the mean over the whole history is **11,050**, and August 2025 ran at
19,046 — 3.0× the quietest month. A quarter of all the routed trades orca holds were made in
2025-08 through 2025-11.

**orca's `blocks` table has no gaps.** For every window checked — ten sampled days and all nineteen
months above — `blocks.totalCount` over `[from, to)` was exactly `to - from`. A parachain numbers
its blocks consecutively, so that equality is a free completeness check on any range, and
`swaps-daily` refuses to store a day that fails it.

**What it costs to actually walk it.** Four whole months were ingested day by day on 2026-08-20
(`hydration/swaps-daily`): 121 days, 1,112,356 routed trades. Mean **9.0 s per day**, median 7.8 s,
worst 31.5 s — which fits `2.27 s + 0.563 ms × trades` to about 1 %. The whole 596-day history is
therefore **~84 minutes** of wall time with one request in flight, and **~2.9 GB** off orca. Not one
day in 121 needed the slow boundary scan, and the per-day trade counts summed to orca's own
whole-month `totalCount` exactly, for every month: 41,263 / 253,894 / 590,441 / 226,758.

**What is stored, per day.** `/api/hydration/swaps-daily?month=YYYY-MM` answers from the store, one
fact per UTC day: the day's block window with the timestamps that prove it, trade and leg counts and
the leg-inflation factor, priced input volume and how many trades could not be priced, the pallet
split, per-initiation and per-asset volume, the top forty routes and top fifty accounts, the
concentration shares computed over *every* account, **the rates derived from that day's own trades**
— which is the cheapest daily price series this venue produces — orca's own published pool volume
over exactly those blocks, and the quality counters every caveat on a page is generated from. A day
before 2025-01-25 is stored with `coverage: "before-source-floor"` and `trades: null`, never `0`.

Two other things worth knowing before writing a walker over this data:

- **`routedTrades` keyset-pages cleanly.** `orderBy: [PARA_BLOCK_HEIGHT_ASC, ID_ASC]` with the
  connection's own `endCursor`; ~1.1 s per 1,000-row page, and page 8 costs what page 1 costs.
  Offset paging over the same table does not — the last page of a day costs the most.
- **A day boundary is 0.7 s with a height hint and 1.9–5.0 s without one.** The hint has to come
  from a measured block count, never a block time; see
  [block time is a trailing average](#block-time-is-a-trailing-average-not-a-constant).

### One account: what `account` answers, and what bounds it

`/account/?address=…` is this site's first drill-down and the smallest version of "follow the
money". It answers **one account, on one venue, inside one window**, and the bound is drawn at the
top of the page rather than in a footnote — a drill-down that *looks* complete is worse than no
drill-down.

**orca filters by swapper server-side, which is the only reason this is affordable.**
`RoutedTradeFilter.participantSwappers` is a `StringListFilter` (introspected 2026-08-20), so
`contains: [$account]` is an indexed array-containment test rather than a download of the window
followed by a filter in our process. Measured the same day against `orca-prod-pool-01`: **1,078
trades for one account over the whole index in 1.0 s**, and 116 over a seven-day block range in
0.6 s. Without it, drawing a hundred trades would mean pulling roughly sixty thousand.

Six bounds, all of them deliberate and all of them stated in the payload rather than only in code:

| Bound | Value | Why it is where it is |
|---|---|---|
| Venue | Hydration routed trades only | Not other parachains, not transfers, not the money market. Nothing joins across chains yet |
| Window | `days` ∈ 1…**14**, default 7 | The same cap and the same 15-minute TTL as `swaps`, deliberately: `/account/` links to `/hydration/` and quotes the same fortnight, so different rhythms would show up as two pages disagreeing |
| Floor | orca's `routedTrades` index, block **6,837,788** (2025-01-25) | Nothing before it exists to be found. A window reaching past it is clamped and `window.clamped` says so |
| Ceiling | **40,000** routed trades in the window | It **refuses** rather than truncating. A silently short account is a net-flow figure that is simply wrong and looks fine |
| Rows drawn | the newest **300** trades, **40** routes | Every figure on the page is computed over *all* the trades in the window; only the tables are cut |
| Labelling | structural only — `modl`, `sibl`, `para`, `pallet:…`, plus orca's own `accountType` | Arithmetic over the account's own bytes. Nothing here names or profiles a person; plan §8.3 draws that line |

**How much of the account the window is NOT showing is a number, not a hedge.** Every response
carries `activity.tradesEver` (that account's trades across orca's whole index), `firstEverAt` /
`lastEverAt`, and `windowShare`, so the page can always produce the sentence *"117 of 1,079 trades,
of an account first seen on 2025-07-10"*. Those four fields are the point of the operation, not
decoration on it.

⚠️ **`contains` and `participantSwappers[0]` are not the same account.** The filter matches the
account *anywhere* in the array; `valueTrades` attributes a trade to the **first** swapper. Those
differ only on multi-swapper trades — 0 of 9,537 in a 24 h sample on 2026-08-20 — but "rare" is not
"never", so the rows where the requested account is not the attributed trader are **counted**
(`activity.notFirstSwapper`) and stated rather than dropped or silently folded in.

⚠️ **The busiest accounts on this venue are pallet accounts, not people.** Measured over a
seven-day block range on 2026-08-20: `pallet:py/trsry` 10,250 trades, `pallet:feeproc/` 9,165. A
fourteen-day window on one of those is ~20,000 rows, which is what the 40,000 ceiling is sized
against. `isPallet` is on every response.

**Paging is bigger here than in the window pager, and that is measured too.** An orca page costs
almost all fixed overhead — 1,000 rows in 1.71 s, 3,000 rows in 1.88 s (2026-08-20, busiest
account) — so this operation pages at **3,000** rather than the window pager's 1,000: ten pages of a
thousand is 17 s, four of three thousand is 7.5 s, for the same rows.

**The address may be hex or SS58 in any network prefix.** `readParams` normalises it to the public
key before anything is looked up (`server/lib/params.mjs`), which is both a correctness property and
a cache property: the same account is one entry, not four. Joining on the display string instead
would answer "this account never traded here" for a perfectly active account whose address the
reader happened to copy off the relay chain. Responses echo the account back in Hydration's own
prefix (**63**) alongside the hex.

### This site's Hydration surface

| Operation | What it answers |
|---|---|
| `/api/hydration/swaps` | routed trades over the last `days` (1–14), aggregated: volume, routes, assets, initiations, accounts, derived rates, and orca's own pool volume over the same blocks for comparison |
| `/api/hydration/account` | one account inside that same window — flows by asset, the trades behind them, and how much of the account's history the window covers. Bounds above |
| `/api/hydration/swaps-daily` (job) | the same daily summary as a stored fact, one UTC day per segment, a calendar month per job identity. Fetched once and never again. Costs and payload above |
| `/api/hydration-evm/market` | the money market's 23 reserves and the USD oracle — a separate source module, because it speaks the `eth_*` namespace against the same RPC host |
| `/api/arbs-hydration/wrap-map`, `/peg-state` | the wrap graph and the peg/HSM/OTC book, read from chain storage rather than from the indexer |
| `/api/arbs-bifrost/vdot` | the vDOT redemption rate, from Bifrost rather than from Hydration. The one cross-chain dependency in this family, and research queue **O30** is about removing it |

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Hydration docs](https://docs.hydration.net/)
- [Hydration docs — Omnipool](https://docs.hydration.net/products/trading/pools/omnipool/)
- [Hydration docs — single-sided LPing](https://docs.hydration.net/products/trading/liquidity/single_sided_lp/)
- [Hydration docs — HOLLAR](https://docs.hydration.net/quick_start/hollar/)
- [Hydration docs — DCA](https://docs.hydration.net/products/trading/pro/dca/)
- [galacticcouncil/hydration-node](https://github.com/galacticcouncil/hydration-node)
- [`pallet-broadcast` types (Filler, ExecutionType, TradeOperation)](https://github.com/galacticcouncil/hydration-node/blob/master/pallets/broadcast/src/types.rs)
- [Hydration newsletter (Substack)](https://hydration.substack.com/)
- [Hydration on Polkadot Ecosystem](https://polkadotecosystem.com/dapps/defi/hydration/)
