# Where the money is on Hydration

[hydration.md](hydration.md) explains what Hydration *is* — the Omnipool, the stableswap layer, the
Aave-fork money market, HOLLAR — and how to price an asset from it. This note answers the different
question the `/hydration-capital/` page asks: **how much capital sits on this chain right now, and
in which assets.**

That is a stock question, not a flow question, and it has one dominant trap: **Hydration's venues
hold each other's receipt tokens, several layers deep.** Adding the four venues together
double-counts \$27.1 M of \$72.5 M — 37 % — and the result looks entirely reasonable.

Everything below was read live off `https://rpc.hydradx.cloud` (both planes) on **2026-08-21**,
around block **13,715,470** (`Timestamp::Now` = 2026-08-21T08:21:21Z, 21 s behind the wall clock).
Probes are in this repo's history as `server/sources/hydration.mjs`'s `capital` operation, which
re-derives all of it.

---

## The four venues, and what each one is

| Venue | Count | How its reserves are read |
|---|---:|---|
| Omnipool | 19 assets | the Omnipool account's balances, via **three** storage paths — see [hydration.md](hydration.md#pricing-in-dollars) |
| Stableswap | 17 pools | each pool's derived account, `blake2_256("sts" ‖ u32le(poolId))`, same three paths |
| XYK | 290 pools | `XYK::PoolAssets` maps a pool ACCOUNT to its asset pair; balances are that account's |
| Money market | 25 reserves across 2 markets (Core, GIGAHDX) | Aave v3 fork in EVM contracts — `getReserveData`, aToken supply |

`XYK::PoolAssets` is keyed by the pool's `AccountId32` with the asset pair as the **value**, which
is the opposite of what the name suggests. The key *is* the account whose balances are the
reserves, so no derivation is needed. 290 keys, verified live 2026-08-21.

## The wrap stack: every "Giga" token is an aToken

This is the finding that reorganises everything else, and it cannot be guessed from the names.

`AssetRegistry` type `Erc20` covers 26 assets. Asking each contract
`UNDERLYING_ASSET_ADDRESS()` and `asset()` (ERC-4626) — verified live 2026-08-21 — sorts them:

| Asset | Id | It is an aToken of | Which is |
|---|---:|---|---|
| `aDOT` `aUSDT` `aUSDC` `aWBTC` `avDOT` `atBTC` `aETH` `aSOL` `aPAXG` `aPRIME` `aEURC` `aapyUSD` `aSIGIL` | 1001–1816 | DOT, USDT, USDC, WBTC, vDOT, tBTC, ETH, SOL, PAXG, PRIME, EURC, apyUSD, SIGIL | a plain token |
| **`GDOT`** | 69 | **asset 690 `2-Pool-GDOT`** | a **stableswap share token** |
| **`GETH`** | 420 | **asset 4200 `2-Pool-GETH`** | a stableswap share token |
| **`GSOL`** | 9001 | **asset 90001 `2-Pool-GSOL`** | a stableswap share token |
| **`GIGAHDX`** | 67 | asset 670 `stHDX` | staked HDX |
| `HUSDC` `HUSDT` `HUSDS` `HUSDe` `HEURC` | 1110–4444 | assets 110, 111, 112, 113, 10044 | stableswap share tokens |
| `a3-Pool` | 1008 | asset 103 `3-Pool` | a stableswap share token |
| `BIL` | 55 | asset 550 `uBIL` | an **ERC-4626 vault over HOLLAR** |
| `HOLLAR` | 222 | — | a plain ERC-20; the only `Erc20` registry asset that is not a wrapper |

So the Omnipool's third- and sixth-largest positions, `GETH` (\$1.95 M) and `GSOL` (\$0.51 M), are
**aTokens of stableswap pools**: Omnipool → GETH → 2-Pool-GETH shares → (aETH, wstETH) → aETH →
ETH. Four hops from the Omnipool to a token that is not a claim on something else here.

`uBIL` is the one ERC-4626 in the set and its share is **not** 1:1 with its asset: verified live
2026-08-21, `convertToAssets(1e18)` = **1.00988 HOLLAR**, `totalAssets` 1,355,823 against
`totalSupply` 1,342,554. Treating a 4626 share as 1:1 is a 0.99 % error today and grows with the
vault's yield. aTokens *are* 1:1 (see hydration.md); vault shares are not, and the two look
identical in the registry.

### The classification that follows

An asset is **derived** — a claim on another Hydration venue — if it is any of:

- an aToken (`UNDERLYING_ASSET_ADDRESS()` answers),
- an ERC-4626 vault share (`asset()` answers),
- registry type `StableSwap` (17 assets),
- registry type `XYK` (730 assets).

Everything else is **base**. All four tests come from the registry or from the contract itself, not
from a symbol pattern — `GDOT` and `GETH` would both survive any name-based filter.

## What double-counts, exactly

Verified live 2026-08-21:

| Venue | Gross | Of which held in derived tokens |
|---|---:|---:|
| Money market (supplied) | \$43.80 M¹ | \$15.18 M — stableswap share tokens supplied as collateral |
| Stableswap (17 pools) | \$15.94 M | \$7.62 M — aTokens sitting in pools |
| Omnipool | \$12.69 M | \$4.26 M — aDOT, GETH, GSOL |
| XYK (290 pools) | \$0.10 M | \$0 |
| **Gross** | **\$72.54 M** | **\$27.05 M (37 %)** |
| **Distinct** | **\$45.48 M** | |

¹ \$43.80 M excludes `stHDX`, which the oracle does not price; see *what is not priced* below.
`hydration-evm/market` reports \$57.92 M supplied because it values stHDX at the Omnipool's HDX
spot as an explicit floor.

**The rule that removes the double count:** count a position only when the token is **base**. A
position in a derived token is a claim on reserves that are counted where they physically sit. This
is exact, not an estimate — the aDOT the Omnipool holds is *inside* the money market's
`supplied` DOT figure, not beside it.

## The reconciliation that proves it

Nine of the 17 stableswap pools have a share token the money-market oracle prices. For those,
`sharePrice × Tokens::TotalIssuance(poolId)` is a **second, independent reading** of the same pool's
value. Verified live 2026-08-21:

| Pool | Σ priced legs | share price × supply | gap | gap % | unpriced leg |
|---|---:|---:|---:|---:|---|
| 2-Pool-GDOT | \$3,944,182 | \$3,969,728 | \$25,547 | 0.64 % | — |
| 2-Pool-HUSDT | \$2,170,285 | \$2,171,915 | \$1,629 | 0.08 % | — |
| 2-Pool-HUSDC | \$1,971,244 | \$1,972,470 | \$1,226 | 0.06 % | — |
| 2-Pool-HEURC | \$1,208,241 | \$1,207,142 | −\$1,099 | −0.09 % | — |
| 2-Pool-GETH | \$2,056,521 | \$3,953,442 | \$1,896,921 | 48 % | wstETH 640.85 |
| 3-Pool | \$383,814 | \$1,039,882 | \$656,068 | 63 % | USDC 304,198 + USDT 351,861 |
| 2-Pool-GSOL | \$547,910 | \$1,004,526 | \$456,616 | 45 % | jitoSOL 3,875.65 |
| 2-Pool-HUSDS | \$76,426 | \$136,914 | \$60,488 | 44 % | sUSDS 54,522.6 |
| 2-Pool-HUSDe | \$56,973 | \$106,528 | \$49,556 | 47 % | sUSDe 39,791 |

**Where every leg prices, the worst disagreement across four pools is 0.64 % and three are under
0.1 %.** Two constructions of the same number, from different data, agreeing — which is what makes
the fifth column trustworthy where a leg does *not* price.

**Where exactly one leg is unpriced, the gap IS that leg's value.** The implied unit prices that
falls out are all plausible, which is the check on the check:

| Leg | Implied | Sanity |
|---|---:|---|
| wstETH | \$2,960 | ETH was \$2,384.59; wstETH/ETH = 1.24 ✓ |
| jitoSOL | \$117.82 | SOL was \$90.99; jitoSOL/SOL = 1.29 ✓ |
| sUSDS | \$1.109 | a yield-bearing dollar ✓ |
| sUSDe | \$1.245 | a yield-bearing dollar ✓ |
| USDC + USDT (Ethereum-native, 3-Pool) | \$1.0000 combined | two dollar stables ✓ |

3-Pool is the one case with **two** unpriced legs, so its \$656,068 cannot be split between them
without assuming both are near parity. It is reported as unattributed rather than split.

Total value of unpriced stableswap legs recovered this way: **\$3,146,952**.

## What is not priced, and why

The money-market oracle prices **exactly the money market's own reserve list** — 23 of the 305
assets asked on 2026-08-21. That is not a defect: an Aave oracle exists to value collateral, and it
has no opinion about a token nobody can borrow against.

Four pricing paths, in the order they are tried, each labelled on the page:

1. **`getAssetPrice(asset)`** on the money-market oracle, discovered by traversal from
   `aDOT.POOL()` → `ADDRESSES_PROVIDER()` → `getPriceOracle()`. 23 assets.
2. **Look-through**: an aToken's price is its underlying's (1:1, verified live over 282 legs — see
   hydration.md); a 4626 vault share's is `convertToAssets` × its asset's.
3. **Omnipool implied spot** — `hub_reserve / reserve` ratioed against HOLLAR's. Adds HDX, AAVE,
   ASTR, TRAC, KSM, SUI, SKY, LINK, LDO, BNC, ENA, vASTR — 12 assets that are in the Omnipool but
   not in the money market.
4. **The stableswap residual** above, for a pool with exactly one unpriced leg.

What remains unpriced after all four is essentially the **XYK long tail**: of 580 XYK legs, 403 are
unpriced and **150 of the 290 pools have no priced leg at all**. Their value is *unknown*, not zero,
and the page says how many. It is bounded above by the priced side of the pools that have one: an
XYK pool's two legs are worth roughly the same, so 290 pools with a \$102 k priced side are not
hiding millions.

`stHDX` (asset 670, 1,258,384,897 supplied into the GIGAHDX market) has no oracle price. It is
staked HDX, so HDX's Omnipool spot is a **floor** — \$14.1 M at \$0.011217 — and it is stated as a
floor wherever it is used. It is *not* a double count of the Omnipool's HDX: the Omnipool holds
125.9 M HDX directly, the staking pallet holds the staked HDX, and they are different accounts.

## What the page deliberately excludes

- **Borrowed money is not added.** \$17.34 M is out on loan against the counted collateral.
  Counting `supplied + borrowed` would count the same collateral twice over.
- **HOLLAR is counted as base capital.** It is minted as money-market debt, so its \$11.78 M of
  borrowings is already excluded by the point above; the HOLLAR itself is a distinct token sitting
  in pools. Counting it is the same convention as counting DAI in a pool.
- **Nothing outside the four venues.** Ordinary user wallets, the Treasury, staking, OTC orders and
  bonds are not capital *in* a venue and are not counted.
- **The XYK share tokens** (730 registry entries of type `XYK`) are derived by definition and never
  counted; their pools' reserves are.

## Numbers, 2026-08-21

Distinct capital **\$45.5 M**, of which the ten largest base assets:

| Asset | USD | Units | Where | Priced by |
|---|---:|---:|---|---|
| PRIME | \$10.31 M | 9,810,200 | stableswap + money market | oracle |
| HOLLAR | \$6.91 M | 6,909,510 | all four venues | oracle |
| DOT | \$4.92 M | 5,661,650 | money market + XYK | oracle (\$0.86849) |
| tBTC | \$4.57 M | 59.41 | Omnipool + money market | oracle |
| vDOT | \$3.39 M | 2,353,870 | all four venues | oracle |
| apyUSD | \$2.86 M | 2,093,950 | stableswap + money market | oracle |
| ETH | \$2.52 M | 1,056.36 | money market + XYK | oracle |
| USDT (10) | \$2.50 M | 2,501,660 | stableswap + XYK + money market | oracle |
| USDC (22) | \$1.80 M | 1,800,750 | stableswap + XYK + money market | oracle |
| HDX | \$1.42 M | 126,095,000 | Omnipool + XYK | Omnipool spot |

**Never sum by symbol.** Seven registry assets are called `USDC` or `USDT`
([hydration.md](hydration.md#one-ticker-seven-assets)); the table above keeps the id, and so does
the page.

## Grades

| Claim | Grade |
|---|---|
| the wrap graph (which `Erc20` asset wraps what) | **verified live** — `UNDERLYING_ASSET_ADDRESS()` / `asset()` on all 26, 2026-08-21 |
| every balance and every price above | **verified live**, 2026-08-21, block ≈13,715,470 |
| the stableswap share-price cross-check | **verified live**, 9 pools, 2026-08-21 |
| aTokens are 1:1 with their underlying | **verified live** in [hydration.md](hydration.md) — 282 legs, deviation exactly 0 |
| an ERC-4626 share is *not* 1:1 | **verified live** — `convertToAssets` = 1.00988 |
| the derived/base classification is complete | **inferred.** It is complete over the four registry/contract tests above; a future wrapper that answers neither `UNDERLYING_ASSET_ADDRESS()` nor `asset()` and is registry-typed `Token` would be counted as base and would double-count silently. There is no on-chain flag that says "this is a wrapper". |
| the XYK long tail is not hiding significant value | **inferred** from pool symmetry, not measured |
