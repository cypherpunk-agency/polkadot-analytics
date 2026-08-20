# Hydration

Hydration (formerly HydraDX) is the DeFi parachain at **para id 2034**. Its distinguishing idea is the
**Omnipool**: instead of thousands of pairwise liquidity pools, one pool holds every listed asset, and
every trade is routed through a single hub asset. On top of that sit a stableswap layer, an
Aave-v3-derived money market, an over-collateralised stablecoin (HOLLAR), an OTC book, a DCA
scheduler, and a router that stitches them together. From an analytics point of view the important
thing is that Hydration emits **one event type for every swap on the chain, from every venue** —
`Broadcast.Swapped3` — with a call stack attached. That event is what this repository's dashboard
reads.

Live readings below are from `https://rpc.hydradx.cloud` and `https://explorer.hydradx.cloud/graphql`
on **2026-08-19**, against runtime `specName: hydradx`, `specVersion: 435`.

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

Verified live 2026-08-19:

| | Value |
|---|---|
| `AssetRegistry::Assets(222)` | name `"Hydrated Dollar"`, symbol `"HOLLAR"`, `AssetType::Erc20`, 18 decimals |
| `Tokens::TotalIssuance(222)` | 20,631.55 HOLLAR |

Twenty thousand. HOLLAR is a young, small stablecoin, and any chart of it should be scaled
accordingly.

The **HSM (HOLLAR Stability Module)** is the peg mechanism, and it is deliberately **asymmetric**:

- **Ceiling side:** the HSM will always sell HOLLAR near $1 against approved collateral. That caps the
  upside — nobody pays $1.05 for something the protocol sells at $1.00.
- **Floor side:** the HSM watches the stableswap pools and decides *when and how much* HOLLAR to buy
  back. It does not commit to buying unlimited HOLLAR at $1, because that would be a free option for
  anyone who could push the pool down.

The asymmetry is the design. A symmetric module is a standing bid that an attacker can drain; an
asymmetric one supports genuine undervaluation without guaranteeing an exit price. A trade filled by
the HSM appears with `fillerType: HSM`.

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
value and merge unrelated single-hop trades into one giant fake trade. That is a trap in the *prose*,
not in this repository: `server/sources/hydration.mjs` handles it explicitly. `origin()` returns a
synthetic `{ kind: 'Direct', key: null }` for an empty stack, and the caller then keys off the event
instead of the stack:

```js
// A leg with no operation stack stands alone — its own trade, one hop long.
const groupKey = key ? `${event.block.height}:${key}` : `solo:${event.id}`
```

So a stackless leg becomes its own single-leg trade, keyed on its event id, and `Direct` is a label
this codebase invents to describe it — **it is not a chain-side `ExecutionType` variant** and you will
not find it in the runtime metadata. If you implement the grouping rule yourself, decide what an empty
stack means before you write the key expression, not after.

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

## Balances

Hydration uses `orml-tokens`, not `pallet-balances`, for everything except HDX:

- `Tokens::Accounts(AccountId32, u32) -> AccountData { free, reserved, frozen }`
- `Tokens::TotalIssuance(u32) -> u128`
- `Balances` (the FRAME pallet) holds HDX only.

Verified live 2026-08-19: `Tokens::TotalIssuance(22)` = 5,285,081.65 USDC,
`Tokens::TotalIssuance(5)` = 4,539,428.23 DOT, `Tokens::TotalIssuance(222)` = 20,631.55 HOLLAR.

The USDC figure is the one to cross-check against Hydration's sovereign account on Asset Hub — see the
reserve invariant in [xcm.md](xcm.md). They agreed to within 425 USDC on 2026-08-19.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| RPC | `https://rpc.hydradx.cloud` (public, no key). `specName: hydradx`, `specVersion: 435` on 2026-08-19 |
| Subsquid archive | `https://explorer.hydradx.cloud/graphql` — generic archive with `blocks`, `events`, `calls`, `extrinsics`, `metadata` |
| Swaps | `events(where: {name_eq: "Broadcast.Swapped3"})` |
| Asset registry | `AssetRegistry::Assets(u32)`, `AssetRegistry::AssetIds`, `AssetRegistry::AssetLocations` |
| Balances | `Tokens::Accounts(AccountId32, u32)`, `Tokens::TotalIssuance(u32)`, `Balances::*` for HDX |
| Omnipool state | `Omnipool::Assets(u32) -> AssetState { hub_reserve, shares, protocol_shares, cap, tradable }` |
| Stableswap | `Stableswap::Pools(u32)` |
| Money market | `EVM` storage plus the `Erc20`-typed entries in `AssetRegistry`; `Liquidation` pallet events |
| HOLLAR | `Tokens::TotalIssuance(222)`; `HSM` pallet storage |
| Prices | `EmaOracle` — exponential moving-average oracle used by the runtime itself |
| XCM in/out | `PolkadotXcm`, `XTokens` extrinsics; `MessageQueue` events |

**Archive query hygiene.** `https://explorer.hydradx.cloud/graphql` will return
`canceling statement due to statement timeout` on an unbounded `Broadcast.Swapped3` scan — the table
is very large. Always constrain with a block height range (`block: {height_gt: N}`) and page.

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
