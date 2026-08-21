# Where the money is on Hydration

[hydration.md](hydration.md) explains what Hydration *is* — the Omnipool, the stableswap layer, the
Aave-fork money market, HOLLAR — and how to price an asset from it. This note answers the different
question the `/hydration-capital/` page asks: **how much capital sits on this chain right now, and
in which assets.**

That is a stock question, not a flow question, and it has two traps rather than one. Adding the
four venues together gave **\$90.02 M** on 2026-08-21, and **\$32.32 M of that — 36 % — is not
there**:

1. **Hydration's venues hold each other's receipt tokens, several layers deep** (\$27.19 M). The
   Omnipool's third-largest position is an aToken *of a stableswap pool*.
2. **The money market's `supplied` counts recursive deposits more than once** (\$5.13 M). This was
   not assumed — it was caught by a check: at gross, four assets held **more than the whole chain's
   supply** of themselves.

Both intermediate figures look entirely reasonable and both render perfectly.

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

## Two deductions, not one

Verified live 2026-08-21:

| Venue | Gross (what it says about itself) | Held in derived tokens | Lent back out |
|---|---:|---:|---:|
| Money market (supplied) | \$58.68 M | \$15.27 M — stableswap share tokens posted as collateral | \$5.13 M |
| Stableswap (17 pools) | \$18.33 M | \$7.37 M — aTokens sitting in pools | — |
| Omnipool | \$12.91 M | \$4.30 M — aDOT, GETH, GSOL | — |
| XYK (290 pools) | \$0.10 M | \$0 | — |
| **Gross** | **\$90.02 M** | **\$27.19 M (30.2 %)** | **\$5.13 M** |
| **Distinct** (gross − receipts) | \$62.83 M | | |
| **Net** (− money lent back out) | **\$57.70 M** | | |

### Deduction 1 — receipt tokens

**Count a position only when the token is base.** A position in a derived token is a claim on
reserves counted where they physically sit. This is exact, not an estimate: the aDOT the Omnipool
holds is *inside* the money market's `supplied` DOT, not beside it.

### Deduction 2 — money lent back out, and the check that forced it

This one was not planned; a reconciliation found it.

**An Aave market lets a depositor borrow the same asset and re-deposit it, and `supplied` — the
aToken supply — counts every turn of that loop.** So `supplied` is not a quantity of tokens in
custody, and the way to see that is to compare it against the chain's own supply. Verified live
2026-08-21, `Tokens::TotalIssuance` against what the venues hold:

| Asset | Chain supply | In venues, gross | of supply | In venues, net | of supply |
|---|---:|---:|---:|---:|---:|
| EURC (44) | 360,623 | 493,954 | **137 %** | 348,337 | 97 % |
| DOT (5) | 4,489,790 | 5,660,420 | **126 %** | 3,463,280 | 77 % |
| SOL (1000752) | 5,155.87 | 6,162.47 | **120 %** | 4,672.03 | 91 % |
| ETH (34) | 1,021.11 | 1,055.56 | **103 %** | 921.72 | 90 % |

**At gross, four of the 28 checkable assets hold more than the whole chain has of them. After
netting, none do.** Nothing else about the two figures distinguishes them; the supply comparison
is the only thing that does, and without it a Hydration TVL that adds `supplied` to pool reserves
looks entirely reasonable.

`docs/platform/hydration.md` already said *"a chunk of Hydration's TVL is recursive rather than net
new deposits — if you report TVL, say whether you are netting out loops."* This is the measurement
behind that sentence.

**The deduction is per reserve and floored at zero**, because HOLLAR is **minted** as debt rather
than lent out of deposits: its `supplied` is 0 and its `borrowed` is \$12.28 M, so a global netting
would remove \$12.28 M that was never added. Of the money market's \$17.37 M of total borrowings,
\$5.13 M is lent out of deposits and is deducted; the rest is minted HOLLAR, which is counted where
it sits — in the pools.

`Erc20`-typed assets are excluded from the supply check: their orml row is a mirror residue, not a
supply. HOLLAR's reads ~13,600 against a real ~12.6 M.

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

**Cross-checked against a second implementation.** `server/sources/prices.mjs` reads the same
oracle by an independent path, built by a different author on the same day. Across the **25 assets
both value, the worst relative difference is 0.0004 %** (verified live 2026-08-21) — the largest
being HDX at \$0.011346353 against \$0.011346309, which is the Omnipool spot computed twice. The
chain above additionally resolves four assets `prices.mjs` does not — wstETH, jitoSOL, sUSDS and
sUSDe — through the stableswap residual.

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

Net capital **\$57.70 M** (gross \$90.02 M), of which the ten largest base assets. Amounts and values are
the COUNTED ones — after both deductions:

| Asset | USD, counted | Units | Where | Priced by |
|---|---:|---:|---|---|
| stHDX (670) | \$14.32 M | 1,258,390,000 | money market | Omnipool HDX spot — a **floor** |
| PRIME (43) | \$10.08 M | 9,598,650 | stableswap + money market | oracle |
| HOLLAR (222) | \$6.91 M | 6,910,910 | all four venues | oracle |
| tBTC (1000765) | \$4.55 M | 58.81 | Omnipool + money market | oracle |
| vDOT (15) | \$3.41 M | 2,336,740 | all four venues | oracle |
| DOT (5) | \$3.05 M | 3,463,280 | money market + XYK | oracle (\$0.86849); gross \$4.98 M |
| apyUSD (46) | \$2.84 M | 2,075,110 | stableswap + money market | oracle |
| ETH (34) | \$2.21 M | 921.72 | money market + XYK | oracle |
| wstETH (1000809) | \$1.91 M | 640.85 | stableswap | **implied** from 2-Pool-GETH's share price |
| HDX (0) | \$1.43 M | 126,106,000 | Omnipool + XYK | Omnipool implied spot |

`stHDX` is the largest single asset and its price is a **floor**: it is staked HDX, the oracle has
no entry for it, and a staking receipt is worth at least one unit of what it wraps. It is *not* a
double count of the Omnipool's 126 M HDX — the staking pallet and the Omnipool are different
accounts.

**Never sum by symbol.** Seven registry assets are called `USDC` or `USDT`
([hydration.md](hydration.md#one-ticker-seven-assets)); the table above keeps the id, and so does
the page.

## Grades

| Claim | Grade |
|---|---|
| the wrap graph (which `Erc20` asset wraps what) | **verified live** — `UNDERLYING_ASSET_ADDRESS()` / `asset()` on all 26, 2026-08-21 |
| every balance and every price above | **verified live**, 2026-08-21, block ≈13,715,470 |
| the stableswap share-price cross-check | **verified live**, 9 pools, 2026-08-21 |
| agreement with `server/sources/prices.mjs` | **verified live** — 25 assets, worst 0.0004 %, 2026-08-21 |
| aTokens are 1:1 with their underlying | **verified live** in [hydration.md](hydration.md) — 282 legs, deviation exactly 0 |
| an ERC-4626 share is *not* 1:1 | **verified live** — `convertToAssets` = 1.00988 |
| the money market's `supplied` exceeds chain supply for 4 assets, and netting fixes all 4 | **verified live**, `Tokens::TotalIssuance` against every base asset, 2026-08-21 |
| the derived/base classification is complete | **inferred.** It is complete over the four registry/contract tests above; a future wrapper that answers neither `UNDERLYING_ASSET_ADDRESS()` nor `asset()` and is registry-typed `Token` would be counted as base and would double-count silently. There is no on-chain flag that says "this is a wrapper". |
| the XYK long tail is not hiding significant value | **inferred** from pool symmetry, not measured |
