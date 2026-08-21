# Pricing an asset in dollars, from chains only

Decision [0008](../decisions/0008-no-off-chain-price-oracle.md) settled *where* a dollar figure on
this site comes from: **Hydration's money-market oracle, read on-chain, never an off-chain feed.**
Decision [0009](../decisions/0009-pricing-is-a-composed-source.md) settled *how a second module
gets one*: a pricing source that other sources compose.

This file is the knowledge base entry behind both. [hydration.md](hydration.md#pricing-in-dollars)
explains how DOT in particular reaches the dollar; this one answers the more general question a
page asks when it wants to value an inventory — **which assets can be priced at all, and what
happens to the ones that cannot.**

Everything below was measured on **2026-08-21** against `rpc.hydradx.cloud`, Hydration block
**13,715,537**, `Timestamp::Now` 2026-08-21T08:28:33Z, runtime `hydradx 435`. Grades are marked:
*verified live* means the call was made and the response is quoted.

---

## The short version

| | |
|---|---|
| The oracle prices | **23 of 1,438** registered Hydration assets (verified live) |
| Which 23 | exactly the money-market reserve set — but **only if `Erc20` assets are asked for by contract**, see the trap below |
| A second path | the Omnipool's own implied spot, **19** assets, agreeing with the oracle to **0.56 %** worst case on the four that both price (verified live) |
| The join to another chain | the **SCALE bytes of the XCM location**, byte-for-byte. Never the ticker, and never the ERC-20 address |
| Of Asset Hub's 34 bridged assets | **8** can be valued ($15.9 M); 26 cannot, for three different reasons |
| Why so few | Hydration registers the same token **once per route** — five USDCs, three WETHs — and the money market never took the Snowbridge leg |

---

## The oracle universe: 23 assets, and it is the reserve list

`getAssetPrice(address)` was called on the price oracle for **every one of the 1,438 ids in
`AssetRegistry::Assets`** (verified live 2026-08-21, one `eth_call` each, batched 120 at a time).
It answered for 23 and reverted with `VM Exception while processing transaction: revert` for the
other 1,415.

```
       id  symbol         type        dec   USD
        5  DOT            Token        10   0.86849149
       10  USDT           Token         6   0.99931701
       15  vDOT           Token        10   1.43861370
       19  WBTC           Token         8   76897.28251163
       22  USDC           Token         6   0.99985723
       34  ETH            Token        18   2384.58893699
       39  PAXG           Token        18   4562.50561004
       43  PRIME          Token         6   1.05050000
       44  EURC           Token         6   1.16909441
       46  apyUSD         Token        18   1.36723180
      103  3-Pool         StableSwap   18   1.02106310
      110  2-Pool-HUSDC   StableSwap   18   1.01741801
      111  2-Pool-HUSDT   StableSwap   18   1.02125164
      112  2-Pool-HUSDS   StableSwap   18   1.02046288
      113  2-Pool-HUSDe   StableSwap   18   1.02404146
      690  2-Pool-GDOT    StableSwap   18   0.94427782
      816  SIGIL          Token        18   1.00000000
     4200  2-Pool-GETH    StableSwap   18   2420.28752105
    10044  2-Pool-HEURC   StableSwap   18   1.01165133
    90001  2-Pool-GSOL    StableSwap   18   92.23065972
  1000752  SOL            Token         9   90.99287904
  1000765  tBTC           Token        18   76857.09235143
      222  HOLLAR         Erc20        18   1.00000000     ← only when asked for by CONTRACT
```

That set is exactly **`Pool.getReservesList()`**, the market's 23 reserves.

### ⚠ The oracle is keyed by two different kinds of address, and asking wrong looks like no price

The first 22 rows are Substrate registry assets, which the oracle knows by the synthetic EVM form
(`0x` + 31 zero bytes + `01` + the u32 id, big-endian). **HOLLAR is not.** It is an `Erc20`-typed
registry asset — a real contract on Hydration's own EVM at
`0x531a654d1696ed52e7275a8cede955e82620f99a` — and the oracle knows it by that address. Asking for
`getAssetPrice(0x…010000_00de)` reverts.

A revert is this module's signal for "no price", so a sweep keyed only by id **silently drops
HOLLAR** — and HOLLAR is the market's dollar-pegged asset and its best hub anchor. The visible
symptom is not an error: the Omnipool's hub-price median loses an anchor and its spread widens (109
bps from three anchors against 76 bps from four, measured within the same hour on 2026-08-21), and
HOLLAR quietly reappears with an *Omnipool implied spot* label instead of the oracle's exact
`1.00000000`. Both readings are plausible. Neither is an error.

So: for an `Erc20` registry asset, ask by the contract in its `AssetLocations` entry; for everything
else, by the synthetic form. `server/sources/prices.mjs` does this in `oracleAddressOf`.

The rule to carry forward is still:

> **The oracle prices its own reserves and nothing else.** It is not a price feed for the chain;
> it is the collateral valuation of one Aave fork. A revert means "this asset is not a reserve",
> not "this asset has no market".

`getAssetPrice(aDOT)` reverts for the same reason and it is worth restating, because it is the one
revert that looks like a bug: **the oracle prices underlyings, not aTokens.** An aToken's price is
its underlying's, and reading the revert as `0` values the Omnipool's largest DOT position at
nothing while the page still renders.

### Discovery, never a constant

The oracle address is derived on every read and each hop is checked against the next — the same
chain `hydration-evm.mjs` uses:

```
AssetRegistry::Assets(1001)          must decode as an Erc20 asset called aDOT
AssetRegistry::AssetLocations(1001)  -> 0x02639ec01313c8775fae74f2dad1118c8a8a86da   (the aToken)
aToken.UNDERLYING_ASSET_ADDRESS()    must equal 0x…0100000005, i.e. DOT
aToken.POOL()                        -> 0x1b02e051683b5cfac5929c25e84adb26ecf87b38
Pool.ADDRESSES_PROVIDER()            -> 0xf3ba4d1b50f78301bdd7eaea9b67822a15fca691
provider.getPool()                   must equal the Pool above   <- the round trip
provider.getPriceOracle()            -> 0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760
oracle.BASE_CURRENCY_UNIT()          -> 100000000  (1e8)
```

All seven verified live 2026-08-21. A Substrate registry asset's EVM address is
`0x` + 31 zero bytes + `01` + the u32 id big-endian, so asset 5 is
`0x0000000000000000000000000000000100000005`.

---

## The second path: the Omnipool's implied spot

Independent of the oracle and useful because it covers a different 19 assets. For an Omnipool
asset, price-in-hub is `hub_reserve / reserve` in whole units; anchoring the hub against the
assets the oracle *does* price gives dollars:

```
hubUsd  = median over priced Omnipool assets of (reserve × oraclePrice) / hubReserve
spotUsd = hubReserve × hubUsd / reserve
```

**Verified live 2026-08-21:** `hubUsd = 5.8191` H2O/USD from four anchors (HOLLAR, PAXG, vDOT,
tBTC), spread **76.5 bps**. Re-measured ten minutes later it read 5.8343 at **109.5 bps** — the
anchors genuinely drift apart intraday, so the spread is published on every read rather than quoted
from here.

### The reconciliation that makes this path usable

Four assets are in **both** venues, so the two constructions can be compared directly:

| Asset | Money-market oracle | Omnipool implied spot | Difference |
|---|---:|---:|---:|
| vDOT | 1.43861370 | 1.44036671 | **+0.122 %** |
| PAXG | 4562.50561 | 4585.68916 | **+0.508 %** |
| HOLLAR | 1.00000000 | 0.99878442 | **−0.122 %** |
| tBTC | 76857.09235 | 76657.87743 | **−0.259 %** |

Two independent constructions of the same number, worst case half a percent. Re-run an hour later
the worst was tBTC at −0.559 % and PAXG at +0.535 %, so treat "under one percent" as the claim and
the live figure on the page as the measurement. The Omnipool path is
therefore published as a real price with a **different `source` label**, never merged into the
oracle's figure — the same discipline `hydration-evm.mjs` already applies to HDX.

The 19 Omnipool assets on 2026-08-21 were `0 (HDX), 9 (ASTR), 14 (BNC), 15 (vDOT), 33 (vASTR),
35 (TRAC), 38 (ENA), 39 (PAXG), 222 (HOLLAR), 420 (GETH), 1001 (aDOT), 9001 (GSOL), 1000624 (AAVE),
1000753 (SUI), 1000765 (tBTC), 1000771 (KSM), 1000794 (LINK), 1000795 (SKY), 1000796 (LDO)`.

Together the two paths price **38 distinct assets** — 23 + 19 with four in the overlap.

---

## Joining two chains: the location bytes, and nothing else

To value Asset Hub's `ForeignAssets` inventory you need Hydration's price for *the same asset*.
The join key is the **SCALE-encoded XCM location**, compared as raw bytes.

This works because both chains store the asset's *canonical* location, and both are parachains, so
`parents: 2` means the same thing from either: up past the relay chain and out of Polkadot's
consensus. Verified live 2026-08-21 — Asset Hub's `ForeignAssets` storage-key tail and Hydration's
`AssetRegistry::AssetLocations` value are byte-identical for every asset both chains carry:

```
Asset Hub  ForeignAssets key tail   0x02020907040300c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
Hydration  AssetLocations(1000189)  0x02020907040300c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
```

decoding as `{parents: 2, X2(GlobalConsensus(Ethereum{1}), AccountKey20(0xc02aaa…756cc2))}` — WETH.

**22 of Asset Hub's 34 bridged assets match a Hydration id this way** (verified live 2026-08-21).

### The corroboration: issuance agrees to the unit

The match is not merely structural. Hydration's `Tokens::TotalIssuance` for the matched id and
Asset Hub's `ForeignAssets` `supply` for the matched location are the *same raw integer* on several
assets — because essentially everything bridged onto Asset Hub in these tokens has been forwarded
on to Hydration:

| Asset | Asset Hub supply | Hydration issuance |
|---|---:|---:|
| ENA (`0x57e114…1e6061` / 38) | 640825362750203073648870 | **640825362750203073648870** |
| sUSDe (`0x9d39a5…7a3497` / 1000625) | 94748825612618188631693 | **94748825612618188631693** |
| LBTC (`0x8236a8…634494` / 1000851) | 22022 | **22022** |
| USDC (`0xa0b869…06eb48` / 1000766) | 568475571981 | 564519928080 |
| tBTC (`0x18084f…d93a88` / 1000765) | 70806803874213158447 | 70805873791759138400 |

Byte-identical on three, within 0.7 % on the rest. Two chains, one asset, and no ticker was
involved in establishing it.

---

## ⚠ The trap: Hydration registers the same token once per ROUTE

This is the finding that decides which prices may be used and which may not, and it is completely
invisible in a symbol column.

Hydration's money-market oracle prices assets called **USDT, USDC, WBTC and EURC**. None of them is
the asset Asset Hub's `/bridged/` page is about. Their locations say so (verified live 2026-08-21,
`AssetRegistry::AssetLocations`):

| Hydration id | Symbol | Location (raw) | What it actually is |
|---|---|---|---|
| 10 | USDT | `0x010300a10f043205011f` | `{parents:1, X3(Parachain(1000), PalletInstance(50), GeneralIndex(1984))}` — **Asset Hub's own USDt**, issued by Tether on Asset Hub |
| 22 | USDC | `0x010300a10f043205e514` | `…GeneralIndex(1337)` — **Asset Hub's own USDC**, issued by Circle |
| 19 | WBTC | `0x000306027768…05 08 0620…2260fac5…` | `GeneralKey("wh")` + `GeneralIndex(2)` + `GeneralKey(0x…2260fac5…)` — **Wormhole**-bridged Ethereum WBTC |
| 44 | EURC | same shape, token `0x60a3e3…adb42` | Wormhole-bridged, and a **different ERC-20** from Asset Hub's EURC (`0x1abaea…1bc33c`) |
| 1000766 | USDC | `0x02020907040300a0b869…06eb48` | **Snowbridge** Ethereum USDC — the one on `/bridged/`. `getAssetPrice` **reverts** |
| 1000767 | USDT | `0x02020907040300dac17f…831ec7` | Snowbridge Ethereum USDT. **Reverts** |
| 1000190 | WBTC | `0x020209070403002260fac5…c2c599` | Snowbridge Ethereum WBTC — *same ERC-20 as id 19, different bridge*. **Reverts** |

So Hydration holds **two WBTCs and two sUSDSs backed by the identical Ethereum contract**, one via
Wormhole and one via Snowbridge, as separate registry ids with separate liquidity — and the money
market took the Wormhole one.

### It is worse than two, and there are five route shapes

Sweeping the whole registry for every asset whose ticker matches one on `/bridged/` (verified live
2026-08-21) turns up **five USDCs, three WETHs, three WBTCs, three USDTs and three DAIs**. The
route is legible in the location's own leading bytes, so it is read rather than guessed:

| Leading bytes | Route | Example |
|---|---|---|
| `0202090704…` | **Snowbridge** — `{parents:2, GlobalConsensus(Ethereum{1}), AccountKey20}` | 1000766 USDC |
| `000306027768…` | **Wormhole** — `GeneralKey("wh")`, `GeneralIndex(chain)`, `GeneralKey(token)` | 21 USDC, 19 WBTC |
| `010300a10f0432…` | **issued on Asset Hub** — `Parachain(1000)`, `PalletInstance(50)`, `GeneralIndex(id)` | 22 USDC (1337), 10 USDT (1984) |
| `010200411f0615…` | **via Acala** — `Parachain(2000)`, `GeneralKey(0x02 + address)` | 7 USDC, 4 WETH |
| `0101 00<para>` | **the issuing parachain's own token** | 28 KILT (2086), 30 MYTH (3369) |

The full sweep, with what the oracle says about each:

```
   id  symbol   dec   price                     route
    2  DAI       18   unpriced                  via Acala (para 2000)
   18  DAI       18   unpriced                  Wormhole
    3  WBTC       8   unpriced                  via Acala (para 2000)
   19  WBTC       8   $77448.6  (oracle)        Wormhole
 1000190 WBTC     8   unpriced                  Snowbridge
    4  WETH      18   unpriced                  via Acala (para 2000)
   20  WETH      18   unpriced                  Wormhole
 1000189 WETH    18   unpriced                  Snowbridge
    7  USDC       6   unpriced                  via Acala (para 2000)
   21  USDC       6   unpriced                  Wormhole
   22  USDC       6   $0.999857 (oracle)        issued on Asset Hub  (asset 1337)
 1000766 USDC     6   unpriced                  Snowbridge
   10  USDT       6   $0.999317 (oracle)        issued on Asset Hub  (asset 1984)
   23  USDT       6   unpriced                  Wormhole
 1000767 USDT     6   unpriced                  Snowbridge
   42  EURC       6   unpriced                  no location at all
   44  EURC       6   $1.16909  (oracle)        Wormhole, token 0x60a3e3…adb42
   28  KILT      15   unpriced                  KILT's own chain (para 2086)
   30  MYTH      18   unpriced                  Mythos' own chain (para 3369)
 1000745 sUSDS   18   unpriced                  Wormhole
 1000626 sUSDS   18   unpriced                  Snowbridge
```

**The money market prices at most one leg of each family, and it is never the Snowbridge one.**
That single sentence is why only 8 of Asset Hub's 34 bridged assets can be valued: the assets are
there, the tickers are there, the prices are there — and they are prices for different assets.

`/bridged/` publishes this per-asset as a *namesake* list next to each unpriced row, so a reader
who asks "Hydration obviously prices WBTC, why is this one blank" gets the real answer instead of a
blank. It is a diagnostic and never a price.

> **Never key a price by the ticker, and — one level up — never key it by the underlying contract
> either.** `0x2260fa…c2c599` identifies an ERC-20 on Ethereum; it does not identify an asset on a
> parachain, because the bridge that wrapped it is part of the asset's identity. Substituting
> id 19's price onto id 1000190 would render perfectly, would be within a fraction of a percent of
> right today, and would be a claim this repository has no evidence for.

CLAUDE.md already carries the Asset Hub half of this ("USDC 1337 and USDt 1984 are not bridged;
Ethereum's USDC exists separately"). The Hydration half is the same fact seen from the other end,
and it has a second bridge in it.

---

## What that leaves for Asset Hub's bridged inventory

**Verified live 2026-08-21 at 08:41 UTC**, Asset Hub block 19,715,478 against Hydration block
13,715,682. These are *live prices*: re-read ten minutes later the total was $16,002,179, so treat
the composition and the ranking as the finding and the total as a reading.

| | Count | Value |
|---|---:|---:|
| Priced | **8** | **$15.9 M** |
| Not in Hydration's registry under this location | 10 | — |
| Registered on Hydration, priced by neither venue | 8 | — |
| No decimals on Asset Hub at all | 8 | — |
| Decimals disagree between the two chains | 0 | — |
| **Total** | 34 | |

```
TRAC   Omnipool spot      0.287738 ×   24,002,813.32  =  $6,906,511
tBTC   oracle         77290.710271 ×           70.81  =  $5,472,708
ETH    oracle          2398.273361 ×        1,034.54  =  $2,481,100
AAVE   Omnipool spot    108.255207 ×        3,090.48  =    $334,561
KSM    Omnipool spot      3.308649 ×       76,439.63  =    $252,912
LINK   Omnipool spot     11.617234 ×       18,518.66  =    $215,136
SKY    Omnipool spot      0.065381 ×    2,495,644.51  =    $163,168
LDO    Omnipool spot      0.352504 ×      342,501.70  =    $120,733
```

Two by the oracle ($7.95 M) and six by the Omnipool's implied spot ($8.02 M) — so **half the
measured value on that page rests on the second path**, which is why its cross-check against the
oracle is recomputed and published on every read rather than asserted once here.

The conspicuous absences are **USDC ($568 k face), USDT ($403 k face), WETH (471.54), wstETH
(642.94) and MYTH (473 M tokens)**. Each is absent for a reason that is stated rather than
guessed at:

- USDC / USDT / WBTC — matched to a Hydration id, but that id is the Snowbridge registration and
  the oracle prices the Wormhole and Asset-Hub-native ones. See the trap above.
- WETH, wstETH, sUSDe, LBTC, sUSDS — matched, but in neither the money market nor the Omnipool.
  Some are in a **stableswap** pool (`3-Pool` 103 holds `1000766`/`1000767`; `2-Pool-GETH` 4200
  holds wstETH `1000809`; `2-Pool-HUSDe` 113 holds sUSDe `1000625`), which would price them if
  the stableswap invariant were implemented. It is not — see the research queue.
- MYTH, KILT, PEPE, SHIB, XRT, CGT2.0, EURC, DAI, TONCOIN, TBTC — **not in Hydration's registry
  under their Asset Hub location.** Five of them have a namesake there that is a different asset:
  Hydration carries native MYTH (30) and native KILT (28) from the issuing parachains, two DAIs
  (Acala and Wormhole), a Wormhole EURC on a different ERC-20 entirely, and a `tBTC` that is Asset
  Hub's *other* tBTC. None is a price for the asset on this page.

### Decimals: the divisor is Asset Hub's, or there is no figure

Eight of the 34 have **no `ForeignAssets::Metadata` entry**, so Asset Hub does not say how many
decimals they use and their supply cannot be turned into a token count, let alone a dollar figure.

Hydration's registry does carry decimals for three of them — `0x458048…cbaf78` is PAXG at 18,
`0x57e114…1e6061` is ENA at 18, `0x38eeb5…fe8a6a` is apyUSD at 18 — and at those decimals they
would be worth about **$1.30 M, $87 k and $2.85 M**, or **$4.24 M** together — more than a quarter
again on top of the $15.9 M that could be measured. That is **not used**: it is a
second chain's claim about the divisor, and a wrong divisor is a silent factor of 10ⁿ on a figure
that renders perfectly. The page states the amount at stake instead of quietly including or
quietly dropping it.

Two of the eight (`0x163f8c…318753`, `0xb62132…815206`) are in neither registry, so nothing anywhere
this repo reads says what they are.

Where Asset Hub *does* give decimals, they are compared against Hydration's for the matched asset
and must agree — on all 16 matched-and-scaled assets they do (18/18, 6/6, 12/12, 8/8, verified live
2026-08-21), so the `decimals-disagree` count on the page is currently zero and the check has never
fired. A disagreement is refused rather than resolved: the two chains would be describing
different tokens.

---

## The stepped feed, and what to say on a page

The money-market oracle is **not continuous**. Sampled every 60 blocks over 24 hours it returned
**18 distinct values** for DOT (recorded in [hydration.md](hydration.md#pricing-in-dollars)), so it
can lag a fast move by up to about an hour. Any page quoting it says so.

Drafted caveats, so the next page does not re-derive them:

> Dollar figures are Hydration's money-market oracle (an Aave v3 fork) read live, with the
> Omnipool's own implied spot for assets the oracle does not carry. The two agree to 0.51 % on the
> four assets both price. The oracle is a stepped feed — about 18 updates a day — so it can lag a
> fast move by up to an hour.

> An asset with no price is absent from the bars, not drawn at zero: "we could not value this" and
> "this was worth nothing" are different facts.

## Reproducing any of this

Every number above came from anonymous `POST` to `https://rpc.hydradx.cloud` — `state_getKeysPaged`
and `state_queryStorageAt` for the registry, and a JSON **array** of `eth_call` for the EVM plane
(that batching is what makes a 1,438-asset price sweep 12 requests instead of 1,438). No key, no
header, no account.
