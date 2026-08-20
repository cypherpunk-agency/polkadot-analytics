# Asset Hub

Asset Hub is the Polkadot system parachain at **para id 1000** that has become, in practice, the main
chain of the network. It started life as a place to issue fungible assets and NFTs without needing a
whole parachain; it now also holds every DOT balance, the staking system, OpenGov, the treasury, and —
since January 2026 — smart contracts. Its on-chain `specName` is still `statemint`, which is what most
indexers and Parity's Dotlake API call it.

Everything below is stated as of **2026-08-19** and, where marked *verified live*, was read from
`https://polkadot-asset-hub-rpc.polkadot.io` on that date.

---

## What is done and what is not

This section is dated on purpose. The migration of relay-chain functionality to Asset Hub happened in
stages and a lot of writing about Polkadot still describes the pre-migration world.

| Capability | Where it lives now | Status |
|---|---|---|
| DOT balances | Asset Hub `Balances` | **Done.** Migrated 2025-11-04 (Kusama 2025-10-07) |
| Staking, nomination pools, validator election | Asset Hub `Staking`, `NominationPools`, `VoterList`, `DelegatedStaking` | **Done.** `Staking::CurrentEra` = 2268 on Asset Hub, empty on the relay chain — *verified live* |
| OpenGov referenda, conviction voting | Asset Hub `Referenda`, `ConvictionVoting`, `Origins`, `Whitelist` | **Done.** `Referenda::ReferendumCount` = 1935 on Asset Hub, empty on relay — *verified live* |
| Treasury, bounties | Asset Hub `Treasury`, `Bounties`, `ChildBounties` | **Done.** `Treasury::ProposalCount` = 1047 — *verified live* |
| Fungible assets, NFTs | Asset Hub `Assets`, `ForeignAssets`, `PoolAssets`, `Nfts`, `Uniques` | **Done**, and always was |
| Smart contracts | Asset Hub `Revive` | **Live.** Launched on Polkadot Hub 2026-01-20; `Revive` storage present — *verified live*. See [smart-contracts.md](smart-contracts.md) |
| Identity | **People Chain** (para 1004), not Asset Hub | `Identity` has no storage keys on Asset Hub — *verified live*. See [people-chain.md](people-chain.md) |
| Technical Fellowship referenda | **Collectives** (para 1001) | `FellowshipReferenda` has no storage keys on Asset Hub — *verified live* |
| Coretime market | **Coretime Chain** (para 1005) | `Broker` has no storage keys on Asset Hub — *verified live* |
| Validator set registration | Relay chain, fed from Asset Hub | Both `StakingRcClient` (Asset Hub) and `StakingAhClient` (relay) exist, which is how the elected set gets back to `Session` on the relay chain |

The relay chain still *contains* `Balances`, `Staking`, `Referenda` and `Treasury` pallets with
residual storage, so probing "does this pallet have keys" is not a reliable test of where a system
lives. The reliable test is whether the counters advance. Verified live on 2026-08-19:

| | Relay chain | Asset Hub |
|---|---|---|
| `Balances::TotalIssuance` | 2,435,265,933,917,291 plancks ≈ **243,527 DOT** | 16,987,684,038,964,684,790 plancks ≈ **1,698,768,404 DOT** |
| `Staking::CurrentEra` | empty | 2268 |
| `Referenda::ReferendumCount` | empty | 1935 |

**The failure mode.** DOT has 10 decimals. A balance of `16987684038964684790` is 1.699 billion DOT,
not 1.699e19 of anything. Every chain in this ecosystem has its own decimals per asset and there is
no global convention: DOT is 10, KSM is 12, HDX is 12, USDC is 6, WBTC is 8, HOLLAR is 18. Getting the
divisor wrong is a silent factor of 10^n — the chart still renders, the number is just wrong by four
orders of magnitude. Always read decimals from the chain's own registry, never from a hard-coded map.

## The three asset pallets

Asset Hub runs three separate instances of FRAME's `pallet-assets`, plus a DEX. They differ in what
type is used as the asset key, and that difference is the whole design.

### `Assets` — keyed by `u32`

The original instance. An asset is a small integer chosen by whoever created it. This is where
locally-issued assets live, including the stablecoins:

| Asset id | Name | Symbol | Decimals | `min_balance` | Sufficient |
|---|---|---|---|---|---|
| 1337 | USD Coin | USDC | 6 | 10,000 (= 0.01 USDC) | yes |
| 1984 | Tether USD | USDT | 6 | 10,000 (= 0.01 USDT) | yes |

*Verified live 2026-08-19 by reading `Assets::Metadata` and `Assets::Asset` for both ids.*

Storage worth knowing:

- `Assets::Asset(u32) -> AssetDetails` — owner/issuer/admin/freezer, supply, `min_balance`,
  `is_sufficient`, account counts, status.
- `Assets::Metadata(u32) -> AssetMetadata` — deposit, `name`, `symbol`, `decimals`, `is_frozen`.
- `Assets::Account(u32, AccountId32) -> AssetAccount` — the per-holder balance.

### `ForeignAssets` — keyed by an XCM `Location`

Anything that originates outside Asset Hub is registered here, and the key is the asset's XCM
`Location` (formerly `MultiLocation`) rather than an integer. This is the correct design: an integer
id is only meaningful relative to one chain's registry, whereas a `Location` is a globally
interpretable path.

Real keys pulled from `ForeignAssets::Asset` on 2026-08-19 and decoded by hand:

| SCALE-encoded key tail | Decoded `Location` | What it is |
|---|---|---|
| `02 01 09 03` | `{ parents: 2, interior: X1(GlobalConsensus(Kusama)) }` | KSM, arrived over the Polkadot↔Kusama bridge |
| `02 02 09 07 04 03 00 c02aaa39…756cc2` | `{ parents: 2, interior: X2(GlobalConsensus(Ethereum{chain_id:1}), AccountKey20{network:None, key:0xC02aaa39…756Cc2}) }` | WETH, bridged from Ethereum mainnet |
| `01 01 00 6d1f` | `{ parents: 1, interior: X1(Parachain(2011)) }` | A sibling parachain's native token, referenced by the chain itself |

Reading that encoding: the first byte is `parents`; the second selects the `Junctions` variant
(`00`=Here, `01`=X1, `02`=X2, …); then each junction is a variant byte plus its fields.
`09` = `GlobalConsensus`, `00` = `Parachain(compact u32)`, `03` = `AccountKey20`, `04` =
`PalletInstance`, `05` = `GeneralIndex`. Inside `GlobalConsensus`, `NetworkId` variant `03` is Kusama
and `07` is `Ethereum { chain_id }` — the numbering is preserved from XCM v4 into v5 even though v4's
Westend/Rococo/Wococo variants were removed, so the indices are *not* contiguous. See [xcm.md](xcm.md)
for what `parents` and junctions mean.

`parents: 2` means "go up past the relay chain" — i.e. out of the Polkadot consensus system entirely,
which is why every bridged Ethereum and Kusama asset has it.

### `PoolAssets` — keyed by `u32`, but not created by hand

These are the LP share tokens minted by the `AssetConversion` pallet. You never create one directly;
you create a pool and the pallet mints the share asset.

### `AssetConversion` — the on-chain DEX

A constant-product AMM on Asset Hub whose pools are keyed by a pair of asset `Location`s. Its main
purpose is not to be a trading venue — it is to let the runtime price an arbitrary asset against DOT
so that **fees can be paid in something other than DOT**. If a DOT/USDT pool exists, a transaction can
be paid for in USDT because the runtime can convert at the pool rate.

## Sufficient assets and the existential deposit

Substrate accounts are reference-counted. An account exists as long as something holds a *provider*
reference on it, and the usual provider is a native balance at or above the **existential deposit**.
Fall below the ED and the account is reaped: the dust is destroyed and any data hanging off the
account goes with it.

| Chain | ED |
|---|---|
| Polkadot relay chain | 1 DOT |
| Polkadot Asset Hub | 0.01 DOT |
| Kusama relay chain | 0.00033333333 KSM |
| Kusama Asset Hub | 0.0000033333 KSM |

An asset marked **sufficient** (`is_sufficient: true` in `Assets::Asset`) can itself provide that
reference. An account holding only USDT on Asset Hub, and no DOT at all, is a valid account: the USDT
balance keeps it alive, and — combined with `AssetConversion` — it can pay its own fees. This is why
USDC and USDT being sufficient was a governance decision rather than an issuer decision; it changes
the chain's account-lifecycle rules and is granted by referendum.

For a non-sufficient asset the rule is the opposite: an account must already hold at least the ED in
DOT before it can receive the asset at all. A transfer to an account with no DOT will fail.

Each asset also has its own `min_balance` — a per-asset dust threshold in that asset's units. For
USDC and USDT it is 10,000, which at 6 decimals is one cent.

**The failure mode.** "How many accounts hold USDC on Asset Hub" is a different question from "how
many accounts exist on Asset Hub", and `AssetDetails` tracks both `accounts` and `sufficients`
separately. Conflating them, or summing balances across `Assets` and `ForeignAssets` without noticing
that a bridged USDC and a locally-issued USDC are *different assets*, produces double counting.

## Why USDC and USDT live here

Two reasons, one technical and one political.

Technically, a stablecoin needs to be reachable from every parachain, and the reserve-transfer model
in XCM requires all participants to agree on a single **reserve chain** for the asset — the one chain
whose sovereign accounts hold the real backing. If USDC lived on a random DeFi parachain, every other
chain would have to trust that parachain as a reserve. Asset Hub is a system chain whose runtime is
governed by Polkadot's own governance, so trusting it as a reserve is close to trusting Polkadot
itself. Every parachain's XCM config therefore lists Asset Hub as the reserve for Asset Hub-issued
assets, and that is what makes a single USDC fungible network-wide.

Politically, Circle and Tether issue directly on Asset Hub. There is no wrapper, no bridge custodian,
no synthetic. Asset 1337 is USDC issued by Circle, and the `owner`/`issuer`/`admin` fields in
`Assets::Asset(1337)` are Circle-controlled accounts.

The consequence for analytics is that **Asset Hub is the origin of most cross-chain value flow on
Polkadot.** Over a rolling 7-day window in August 2026, the top Polkadot XCM value route reported by
Parity's Dotlake API was `statemint → hydradx` — Asset Hub sending stablecoins to
[Hydration](hydration.md).

## Asset ids are chain-local; multilocations are not

This is the single most common source of wrong numbers in Polkadot analytics.

| Chain | How USDC is identified |
|---|---|
| Polkadot Asset Hub | `Assets` asset id `1337` |
| Hydration | `AssetRegistry` asset id `22` (*verified live*: name `USDC`, 6 decimals, sufficient) |
| Any chain, canonically | `{ parents: 1, interior: X3(Parachain(1000), PalletInstance(50), GeneralIndex(1337)) }` |

`PalletInstance(50)` is the `Assets` pallet's index in the Asset Hub runtime, and `GeneralIndex(1337)`
is the asset id within it. That triple is what actually travels inside an XCM message. Every chain
then maps it onto whatever local integer it prefers.

So: **never join on asset id across chains.** Join on the `Location`, or on a hand-maintained mapping
that you can point at a source. Asset id 22 means USDC on Hydration and something completely different
on Asset Hub; asset id 1337 means USDC on Asset Hub and nothing at all on Hydration.

## Reading the migration in historical data

Because balances, staking and governance moved on 2025-11-04, any time series that spans that date
must switch source chains at that date.

- Before 2025-11-04: read `Balances`, `Staking`, `Referenda`, `Treasury` events from the **relay
  chain**.
- After 2025-11-04: read them from **Asset Hub**.

There is no event that announces this in the data. A query that reads only Asset Hub shows staking
starting from zero in November 2025; a query that reads only the relay chain shows it stopping dead.
Both look like real phenomena. If you are producing a chart of staked DOT or referendum volume across
2025, you are producing a union of two chains and you should say so in the chart.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| RPC | `https://polkadot-asset-hub-rpc.polkadot.io` (public, no key) |
| Local fungibles | `Assets::Asset(u32)`, `Assets::Metadata(u32)`, `Assets::Account(u32, AccountId32)` |
| Cross-consensus fungibles | `ForeignAssets::Asset(Location)`, `ForeignAssets::Metadata(Location)`, `ForeignAssets::Account(Location, AccountId32)` |
| LP share tokens | `PoolAssets::*` |
| DEX pools | `AssetConversion::Pools((Location, Location))` |
| DOT balances | `Balances::TotalIssuance`, `System::Account(AccountId32)` |
| Staking | `Staking::CurrentEra`, `Staking::ActiveEra`, `Staking::ErasStakersOverview`, `NominationPools::*` |
| Governance | `Referenda::ReferendumCount`, `Referenda::ReferendumInfoFor(u32)`, `ConvictionVoting::*` |
| Treasury | `Treasury::ProposalCount`, `Treasury::Spends`, `Bounties::*` |
| Contracts | `Revive::*` — see [smart-contracts.md](smart-contracts.md) |
| Runtime version | `state_getRuntimeVersion` → `specName: statemint`, `specVersion: 2003002` on 2026-08-19 |
| Aggregate XCM flows | `https://api.data.parity.io/api/xcm-top-routes`, `/api/daily-usdc` |

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Polkadot Wiki — Asset Hub overview](https://wiki.polkadot.com/learn/learn-assets/)
- [Polkadot Developer Docs — Polkadot Hub Assets](https://docs.polkadot.com/reference/polkadot-hub/assets/)
- [Polkadot Developer Docs — Polkadot Hub overview](https://docs.polkadot.com/reference/polkadot-hub/)
- [Polkadot Support — What is the existential deposit?](https://support.polkadot.network/support/solutions/articles/65000168651-what-is-the-existential-deposit-)
- [Polkadot Support — Asset Hub migration: what you must know](https://support.polkadot.network/support/solutions/articles/65000190561)
- [The Asset Hub Migration — a primer (HackMD)](https://hackmd.io/@seadanda/B1QIVXrwJg)
- [Referendum 174 — proposal for USDC sufficiency on Asset Hub](https://polkadot.subsquare.io/referenda/174)
