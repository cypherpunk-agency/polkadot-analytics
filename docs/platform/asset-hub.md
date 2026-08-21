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

| Asset id | Name | Symbol | Decimals | `min_balance` | Supply | Owner |
|---|---|---|---|---|---|---|
| 1337 | USD Coin | `USDC` | 6 | 10,000 (= 0.01 USDC) | 350,019,956.32 | `12xLgPQunSsPkwMJ3vAgfac7mtU3Xw6R4fbHQcCp2QqXzdtu` |
| 1984 | Tether USD | `USDt` | 6 | 10,000 (= 0.01 USDt) | 77,998,622.06 | `15uPcYeUE2XaMiMJuR6W7QGW2LsLdKXX7F3PxKG8gcizPh3X` |

Both are `is_sufficient: true`. *Verified live 2026-08-20 at Asset Hub #19,681,346 by reading
`Assets::Metadata` and `Assets::Asset` for both ids.*

**Asset 1984's symbol is `USDt`, with a lowercase `t`.** Not `USDT`. Almost every write-up of Asset
Hub, including earlier revisions of this document, says `USDT`; `Assets::Metadata(1984)` says
`USDt`. It matters for anything that asserts a symbol as a decimals canary — a case-sensitive
assertion on `USDT` fails against a chain that is behaving perfectly.

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

`parents: 2` means "go up past the relay chain" — i.e. out of the Polkadot consensus system
entirely, which is why every bridged Ethereum and Kusama asset has it. See [xcm.md](xcm.md) for
what `parents` and junctions mean.

Reading that encoding: the first byte is `parents`; the second selects the `Junctions` variant,
whose **index is the junction count** (`00`=Here, `01`=X1 … `08`=X8) followed by exactly that many
junctions with no length prefix of their own; then each junction is a variant byte plus its fields.

| Junction | Index | Payload |
|---|---|---|
| `Parachain` | `00` | `Compact<u32>` |
| `AccountId32` | `01` | `Option<NetworkId>`, `[u8; 32]` |
| `AccountIndex64` | `02` | `Option<NetworkId>`, `Compact<u64>` |
| `AccountKey20` | `03` | `Option<NetworkId>`, `[u8; 20]` |
| `PalletInstance` | `04` | `u8` |
| `GeneralIndex` | `05` | `Compact<u128>` |
| `GeneralKey` | `06` | `u8` length, then **always 32 bytes** of data |
| `OnlyChild` | `07` | — |
| `Plurality` | `08` | `BodyId`, `BodyPart` |
| `GlobalConsensus` | `09` | `NetworkId` |

| `NetworkId` | Index | Payload |
|---|---|---|
| `ByGenesis` | `00` | `[u8; 32]` |
| `ByFork` | `01` | `u64` block number, `[u8; 32]` hash |
| `Polkadot` | `02` | — |
| `Kusama` | `03` | — |
| *(removed: Westend, Rococo, Wococo)* | `04`–`06` | — |
| `Ethereum` | `07` | `Compact<u64>` chain id |
| `BitcoinCore` | `08` | — |
| `BitcoinCash` | `09` | — |
| `PolkadotBulletin` | `0a` | — |

**`GeneralKey` is the one that desynchronises a decoder.** Its `data` field is a fixed `[u8; 32]`
on the wire and `length` says how much of it is meaningful. Reading only `length` bytes leaves the
cursor 32 − `length` bytes short and every junction after it decodes as garbage — or, worse,
decodes into something plausible. Two live keys use it: Bifrost's BNC (`GeneralKey{2, 0x0001}`) and
vDOT (`GeneralKey{2, 0x0209}`), plus Equilibrium's EQD (`GeneralKey{3, 0x657164}` — ASCII `eqd`).

`NetworkId` indices 4, 5 and 6 were removed and the later variants were **not renumbered**. A
decoder that writes the variants as a contiguous array maps `Ethereum` onto index 4 and relabels
every bridged Ethereum asset as a Westend one, with no error.

#### The `parents` discriminator is a runtime guarantee, not a pattern in the data

That 34 of today's 52 keys begin with `02` is an observation, and observations about a registry can
be coincidences. The rule behind it is not. **Source-verified 2026-08-20** against
`polkadot-fellows/runtimes` and `paritytech/polkadot-sdk`:

Asset Hub's `pallet_assets::Config<ForeignAssetsInstance>` sets

```rust
type CreateOrigin = ForeignCreators<(
    FromSiblingParachain<parachain_info::Pallet<Runtime>, Location>,
    FromNetwork<UniversalLocation, EthereumNetwork, Location>,
    KusamaAssetFromAssetHubKusama,
), LocationToAccountId, AccountId, Location>;
```

and those three are the only permissionless ways an entry can come into existence. Each pins
`parents` exactly:

- **`FromSiblingParachain`** (`cumulus/parachains/runtimes/assets/common/src/matching.rs`) returns
  false unless `a.unpack()` is `(1, interior)` whose first junction is `Parachain(id)` with
  `id != 1000`. Sibling assets are `parents: 1`.
- **`FromNetwork`** calls `ensure_is_remote(UniversalLocation, a)`
  (`polkadot/xcm/xcm-builder/src/universal_exports.rs`). Asset Hub's `UniversalLocation` is
  `[GlobalConsensus(Polkadot), Parachain(1000)]` — two elements — and `appended_with` strips
  `parents` of them. At parents 0 or 1 the result still opens with `GlobalConsensus(Polkadot)`,
  which `ensure_is_remote` rejects as not remote; at parents 3 the append fails outright. Only
  `parents: 2` leaves the asset's own leading junction in first position, and it must be
  `GlobalConsensus(n)` with `n != Polkadot`.
- **`KusamaAssetFromAssetHubKusama`** is `RemoteAssetFromLocation<StartsWith<KsmLocation>,
  AssetHubKusama>` with `KsmLocation = Location::new(2, GlobalConsensus(Kusama))`
  (`asset-hub-polkadot/src/xcm_config.rs`), so the asset must start with parents 2 and Kusama.

So **`parents: 1` ⇔ a sibling parachain's own asset and `parents: 2` ⇔ another consensus system**,
by construction of the runtime.

Two caveats, both worth carrying:

- `type ForceOrigin = AssetsForceOrigin` can `force_create` an arbitrary `Location`, so **governance
  is not bound by those three filters.** Check the invariant on read (parents 2 must open with
  `GlobalConsensus(X)`, X ≠ Polkadot) rather than assuming it.
- `assets_common::ForeignAssetsConvertedConcreteId` — which *does* carry
  `StartsWithExplicitGlobalConsensus` — is the matcher the XCM executor uses when **transacting**,
  not the filter that governs **creation**. It is consistent with the rule above but it is not
  where the rule comes from.

#### Enumerating it costs three requests

`Blake2_128Concat` appends the key in plaintext, so a `ForeignAssets::Asset` storage key is

```
twox128("ForeignAssets") ++ twox128("Asset") ++ blake2_128(encodedLocation) ++ encodedLocation
       └──────────────── 32 bytes ────────────┘  └── 16 bytes ──┘  └── the location, readable ──┘
```

One `state_getKeysPaged` sweep therefore hands back every asset's full identity — there is no
reverse map on chain and none is needed. `Metadata` keys are then derived from the same location
bytes, and one `state_queryStorageAt` returns all 52 values. Whole inventory: three requests, about
1.4 s. *Verified live 2026-08-20.*

Pin every read to one block hash (`chain_getFinalizedHead`, then pass it as the trailing argument
to `state_getKeysPaged` / `state_queryStorageAt` / `state_getStorage`). Without pinning, a
reconciliation between a supply read and a holder sweep fails intermittently for reasons that have
nothing to do with a bug — and gets "fixed" by loosening the check.

#### The inventory, verified live 2026-08-20 (#19,681,346)

52 keys: **34 bridged** (`parents: 2`) and **18 sibling** (`parents: 1`). Of the bridged, 33 are
`GlobalConsensus(Ethereum{1})` and one is `GlobalConsensus(Kusama)`.

| Symbol | Decimals | Supply on Asset Hub | Location |
|---|---|---|---|
| MYTH | 18 | 473,031,022.23 | Ethereum `0xba41ddf0…eb2003` |
| KILT | 15 | 58,152,417.94 | Ethereum `0x5d3d01fd…6288eb` |
| TRAC | 18 | 23,952,749.44 | Ethereum `0xaa7a9ca8…0f0a6f` |
| PEPE | 18 | 6,948,040.26 | Ethereum `0x69825081…311933` |
| SKY | 18 | 2,526,139.37 | Ethereum `0x56072c95…ed9279` |
| USDC (Snowbridge) | 6 | 550,876.15 | Ethereum `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| USDT (Snowbridge) | 6 | 403,367.57 | Ethereum `0xdac17f95…831ec7` |
| LDO | 18 | 342,501.70 | Ethereum `0x5a98fcbe…ef1b32` |
| SHIB | 18 | 179,748.33 | Ethereum `0x95ad61b0…64c4ce` |
| KSM | 12 | 76,618.91 | `{parents: 2, X1(GlobalConsensus(Kusama))}` |
| sUSDe | 18 | 41,513.64 | Ethereum `0x9d39a5de…7a3497` |
| LINK | 18 | 18,721.24 | Ethereum `0x514910771af9ca656af840dff83e8264ecf986ca` |
| AAVE | 18 | 3,126.51 | Ethereum `0x7fc66500…2ddae9` |
| ETH | 18 | 1,024.15 | `{parents: 2, X1(GlobalConsensus(Ethereum{1}))}` — native ether, no `AccountKey20` |
| wstETH | 18 | 642.94 | Ethereum `0x7f39c581…5e2ca0` |
| WETH | 18 | 471.54 | Ethereum `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` |

Then a tail of small ones (CGT2.0, tBTC, EURC, DAI, TONCOIN, WBTC, LBTC, sUSDS, TBTC).

**Eight of the 34 bridged assets have no `ForeignAssets::Metadata` entry at all.** They are
registered and several carry real supply — one holds 2.1e24 raw units — but nothing on chain says
how many decimals they use. Their amount is an unscaled `u128` and there is no correct way to
render it as whole units; `null` and a stated reason is the only honest answer. Rendering a raw
integer as a token amount is wrong by up to eighteen orders of magnitude and looks entirely
ordinary.

**Never key or sum by symbol.** At this block Asset Hub carries two assets called MYTH (Ethereum
`0xba41ddf0…` and `Parachain(3369)`), two called NEURO, two called XRT, two spellings of tBTC, and
across the two pallets two called USDC — Ethereum's at `0xa0b86991…` in `ForeignAssets` and
Circle's at id 1337 in `Assets`. They are different assets with different issuers and different
backing. Key on the location.

#### Sibling-parachain entries name paras the relay chain does not

Of the 18 `parents: 1` entries, two name paras that appear in **no** relay-chain enumeration:
`Parachain(2004)` (GLMR, supply 0) and `Parachain(2039)` (TEER, supply 323,136.89). See
[Sovereign accounts](#sovereign-accounts-and-the-parachains-nobody-enumerates) below — this makes
Asset Hub's own key set a useful *fourth* enumeration of "which parachains exist".

### `PoolAssets` — keyed by `u32`, but not created by hand

These are the LP share tokens minted by the `AssetConversion` pallet. You never create one directly;
you create a pool and the pallet mints the share asset.

### `AssetConversion` — the on-chain DEX

A constant-product AMM on Asset Hub whose pools are keyed by a pair of asset `Location`s. Its main
purpose is not to be a trading venue — it is to let the runtime price an arbitrary asset against DOT
so that **fees can be paid in something other than DOT**. If a DOT/USDT pool exists, a transaction can
be paid for in USDT because the runtime can convert at the pool rate.

## The value layouts, byte by byte

*All verified live 2026-08-20 against `polkadot-asset-hub-rpc.polkadot.io` and
`rpc.polkadot.io`, runtime `statemint`/`polkadot` spec 2003002.* Every decoder built on these must
consume its input **exactly** and throw on leftover bytes: a runtime upgrade that inserts a field
does not error on its own, it shifts every field after it and returns a plausible number with the
wrong meaning.

`pallet_assets::AssetDetails` — **190 bytes**, identical in `Assets` and `ForeignAssets`:

| Field | Offset | Width |
|---|---|---|
| `owner`, `issuer`, `admin`, `freezer` | 0 | 4 × 32 |
| `supply` (u128 LE) | **128** | 16 |
| `deposit` | 144 | 16 |
| `min_balance` | 160 | 16 |
| `is_sufficient` | 176 | 1 |
| `accounts`, `sufficients`, `approvals` (u32 LE) | 177 | 3 × 4 |
| `status` (`Live`=0, `Frozen`=1, `Destroying`=2) | 189 | 1 |

`pallet_assets::AssetMetadata` — `deposit` (u128), `name` and `symbol` as `Compact` length + bytes,
`decimals` (u8), `is_frozen` (bool). Variable width.

`pallet_assets::Account` is a `StorageDoubleMap<Blake2_128Concat AssetId, Blake2_128Concat
AccountId>`, so its key is

```
prefix(32) ++ blake2_128(assetId) ++ assetId ++ blake2_128(account) ++ account
```

Both halves concat, which means a sweep under one asset's partial prefix returns every holder's
account id in the key itself. *Verified live: the derived key for (WETH, `sibl` 2034) returns
`0x29bc70fc7b13ac0000000000000000000001`, and that exact key appears in a `state_getKeysPaged`
sweep of the WETH prefix.*

`AssetAccount` is **not fixed width**: `balance` (u128), `status` (`Liquid`/`Frozen`/`Blocked`),
then an `ExistenceReason` enum that is 1 byte for `Consumer`/`Sufficient`/`DepositRefunded`, 17 for
`DepositHeld(Balance)` and 49 for `DepositFrom(AccountId, Balance)`. Values of 18, 34 and 66 bytes
all occur on the live chain. A decoder that asserts 18 throws on the first deposit-held holder it
meets.

`frame_system::AccountInfo` — **exactly 80 bytes**, and the last sixteen are the trap:

| Field | Offset | Width |
|---|---|---|
| `nonce`, `consumers`, `providers`, `sufficients` (u32 LE) | 0 | 4 × 4 |
| `free` (u128 LE) | **16** | 16 |
| `reserved` | 32 | 16 |
| `frozen` | 48 | 16 |
| `flags` | **64** | 16 |

Two ways to get this wrong, both silent:

- **`flags` read as a balance.** It is `ExtraFlags`, whose top bit is set —
  `0x80000000000000000000000000000000`, *verified live* on Hydration's sibling account. Decoded
  with the pre-2023 `AccountData { free, reserved, misc_frozen, fee_frozen }` schema it lands where
  a balance is expected and reads as ~1.7e38. That is exactly what Statescan's public account index
  currently shows.
- **`frozen` added to `free`.** `frozen` is a **lock on part of `free`**, not a fourth pot. What an
  account holds is `free + reserved`; what it could spend is `free − frozen`. Adding `frozen`
  double-counts the locked portion.

## Supply is not the sum of the accounts

**`Σ ForeignAssets::Account(location, *) == ForeignAssets::Asset(location).supply` is NOT an
invariant on this chain.** Verified live 2026-08-20 at #19,681,357 by sweeping all 1,025 holder
keys of all 34 bridged assets: **28 reconcile to the last unit, 6 do not**, and every one of the
six is short in the same direction — supply *above* the accounts, never below.

| Asset | Supply | Σ holders | Short by |
|---|---|---|---|
| USDT (Snowbridge) | 403,367.571886 | 403,352.571886 | 15.000000 |
| USDC (Snowbridge) | 550,876.150733 | 550,865.000733 | 11.150000 |
| TRAC | 23,952,749.44 | — | 0.5 |
| KSM | 76,618.91 | — | 0.091090925517 |
| ETH | 1,024.15 | — | 0.015219309277966885 |
| *(metadata-less ERC-20 `0x38eeb52f…fe8a6a`)* | 2.10078e24 raw | — | 4e18 raw |

**It is not a gap in the read.** For all 34 assets the number of holder keys swept equals
`AssetDetails.accounts`, the pallet's own counter, so each map was read whole.

It was then settled by probe rather than by argument:

- Sampled back through history, the gap moves in **steps, not as accumulated dust**. Snowbridge
  USDT: 0 at #13,681,483 (2026-03-22), 15.000000 at #16,681,483 (2026-06-05), and 15.000000 still
  today — while supply itself moved by tens of thousands. USDC: 0 → 10.02 → 11.15 over the same
  samples. KSM drifts upward steadily from 0 in Dec 2024.
- **Bisected, the whole of that 15.000000 appears in ONE BLOCK: #14,915,236,
  2026-04-24T06:10:36Z.** Across that block `supply` rose 583,285.074178 → 583,300.074178 while
  every one of the 44 holder balances and the account count were **unchanged**.
- The only non-inherent extrinsic in that block is `ParachainSystem::set_validation_data` — the
  inherent that carries inbound XCM.

So `ForeignAssets` supply can be minted on Asset Hub without any account being credited. **What
inside XCM does it is not established** and should not be guessed at; see the research queue.

What follows for anything drawn from these numbers:

- A "supply decomposed across chains" chart whose segments are *defined* as sovereign holdings plus
  `supply − Σ sovereign` adds up by construction and is still telling you something false: part of
  that residual is in no account at all. Split it — holders, and unaccounted — or the geometry
  asserts a no-double-counting property the chain does not have.
- The magnitudes are small today (15 USDT against 403,367 is 0.004%) but the sign is systematic and
  the drift is upward. A fold of `Issued − Burned` from genesis that is required to equal the live
  supply "to the last unit" needs to account for this before it can be published.

## Sovereign accounts, and the parachains nobody enumerates

A parachain's DOT holding is the **sum of two accounts on two chains**:

```
relay chain view   b"para" ++ u32_LE(paraId) ++ [0u8; 24]   = 0x70617261 ‖ id ‖ zeros
sibling chain view b"sibl" ++ u32_LE(paraId) ++ [0u8; 24]   = 0x7369626c ‖ id ‖ zeros
```

Literal ASCII plus trailing zeros — `into_account_truncating`, not a hash. `src/core/topology.js`
derives both and self-checks at import against two independently verified addresses.

⚠️ **Both prefixes exist on both chains and only one of them is the answer on each.** Sweeping
`para`-prefixed accounts *on Asset Hub* returns about 20 DOT of existential deposits. That renders
perfectly and is wrong by a factor of half a million.

*Verified live 2026-08-20* (relay #32,636,218, Asset Hub #19,681,571):

| | Relay `para` | Asset Hub `sibl` | Total |
|---|---|---|---|
| accounts that exist | 44 | 50 | 52 of 127 enumerated |
| DOT (`free + reserved`) | 27,622.95 | 9,891,904.30 | 9,919,527.25 |

`Balances::TotalIssuance` at the same blocks: relay 243,539.34 DOT, Asset Hub 1,698,894,142.13 DOT.
Sovereign holdings are 0.58% of Asset Hub's issuance. The migration is visible in one number.

Largest holders, `free + reserved` summed across both legs: Hydration 4,534,054 · Acala 3,008,330 ·
Bifrost 2,170,781 · Astar 101,512 · Hyperbridge 46,201 · Zeitgeist 17,154 · Interlay 9,307.

### Four enumerations, and none of them is complete

"Which parachains exist" has no single correct answer on chain. All counts *verified live
2026-08-20*:

| Source | Count | What it means |
|---|---|---|
| `Paras::ParaLifecycles` (relay) | 89 | registered with a current lifecycle. 86 `Parathread`, 3 `Parachain` (1002, 1004, 1005) — under agile coretime almost everything is a parathread with a broker-assigned core, and the value must never be printed as a description. Re-verified 2026-08-21 at #32,648,511; see [polkadot.md](polkadot.md#paralifecycles-says-parathread-for-almost-everything-and-it-is-not-a-description) |
| `Registrar::Paras` (relay) | 123 | holds a registration deposit. A strict superset of the 89 |
| `Parachain(N)` junctions in Asset Hub's `ForeignAssets` keys | 14 | Asset Hub registers an asset issued by this para |
| `src/core/topology.js` | 33 (Polkadot) | this repository names it |

Union: **127**. Also live: `Paras::Heads` returns 90 ids and `Paras::CurrentCodeHash` 90 — one id,
3440, is in both but in neither `ParaLifecycles` nor `Registrar::Paras`. `Registrar::NextFreeParaId`
is 3443. `Slots::Leases` has 10 entries.

### Para 2004 (Moonbeam) is deregistered, and still holds DOT

This was an open question (research queue B1) and is now settled as far as relay state can settle
it. **Verified live 2026-08-20 at relay #32,635,964**, para 2004 is absent from *every* relay
storage item that would name a registered para:

| Read | Result |
|---|---|
| `Paras::ParaLifecycles(2004)` | `null` (89 keys, none is 2004) |
| `Paras::Heads(2004)` | `null` (90 keys) |
| `Paras::CurrentCodeHash(2004)` | `null` (90 keys) |
| `Registrar::Paras(2004)` | `null` (123 keys) |
| `Slots::Leases` | 10 keys, none is 2004 |

It is not a lifecycle quirk — the registration itself is gone from this relay chain. What is **not**
gone is the money or the asset:

| Read | Result |
|---|---|
| relay `System::Account(para 2004)` | 264.998883732 free + 50 reserved DOT |
| Asset Hub `System::Account(sibl 2004)` | 0.01 free + 10.20079 reserved DOT |
| Asset Hub `ForeignAssets::Asset(Parachain(2004)/PalletInstance(10))` | GLMR, supply 0, 1 account |
| Asset Hub `ForeignAssets::Account` sweeps | Moonbeam's `sibl` account holds 8 bridged assets — 312.29 USDC, 111 USDT, 81 KSM, and WETH/wstETH/DAI/WBTC/ETH |

**It is not alone.** Three more chains hold sovereign DOT while appearing in neither relay
enumeration: Equilibrium (2011, 532.65 DOT), Parallel (2012, 140.35), and para 2039 — Integritee,
whose TEER is a registered `ForeignAsset` — with 2.36. Together with Moonbeam that is ~1,000 DOT
plus 400-odd USD of stablecoins that a payload built from `Paras::ParaLifecycles` alone would show
as *absent*, which a reader reads as *holds nothing*.

The lesson generalises past Moonbeam: **enumerate from several sources, record on every row which
of them produced it, and name the ones the chain's own enumeration would have dropped.** Absent
from an enumeration and holding nothing are different facts.

**Both of the questions this section left open have since been answered**, by going to the relay's
*history* rather than to its current state. Moonbeam's own manager sent `Registrar.deregister(2004)`
in relay block 32,489,786 (2026-08-10T07:29:24Z), and a re-registration under another id is ruled
out — that manager account is the `manager` field of **zero** of the 123 current `Registrar::Paras`
entries, and no live para carries Moonbeam's final code hash. Full derivation, the four departures
it turned up, and what was ruled out and how, in [moonbeam.md](moonbeam.md). What remains genuinely
unanswerable from these two endpoints is the mapping from a para id to a *chain name*: relay state
does not carry one, which is why `src/core/topology.js` exists.

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

## Reading sovereign balances day by day, back to 2022

`/netflows/` draws DOT in every parachain sovereign account once per UTC day from 2022-01-01 to
yesterday. Everything below was established while building it, and every figure marked *verified
live* was read on **2026-08-20** from `https://rpc.polkadot.io` and
`https://polkadot-asset-hub-rpc.polkadot.io`.

### Both public RPCs are full archives

Neither endpoint prunes historical state. Probed at ten heights each:

| | Deepest readable state | What it says |
|---|---|---|
| Relay chain | block **#1** — `Timestamp::Now` = 2020-05-26T15:36:18Z | archive to genesis |
| Asset Hub | block **#305,204** — `Timestamp::Now` = 2021-12-18T18:52:54.582Z | archive to genesis, but see below |

Asset Hub's blocks **below #305,204 have state and no clock**: `state_getRuntimeVersion` at #305,203
answers `statemint 601`, and `state_getStorage(Timestamp::Now)` at the same block answers `null`.
That is Statemint's pre-launch period, not pruning. It is why the daily series starts in **January
2022** rather than at the first parachain slots: before 2021-12-18 a UTC day has no readable Asset Hub
close, and the second leg of every sum would be `null` rather than `0`.

Nothing was lost by starting there. **No parachain sovereign account held any DOT at all until
2022-02-02** — read directly off the relay at the close of every day of January 2022, and the archived
Polkalytics dataset's first non-null value (Acala, 1.23 DOT) is that same day.

### A pruned read looks exactly like an empty account, so guard on the clock

A node that has discarded historical state answers `state_queryStorageAt` for `System::Account` with
`null`, which is indistinguishable from "this account does not exist" — a whole chart of zeros that
renders perfectly. The guard is **`Timestamp::Now`, which every block has**: the handler refuses a day
unless the block it read carries a timestamp *inside* that UTC day. A balance key can legitimately be
absent; the clock key cannot.

### A day is its CLOSE, and this is checkable

`src/data/netflows.json` defines a day as "the last balance observed at or before the end of that UTC
day". Reading `System::Account` at the **last block of the UTC day** reproduces that *exactly*.
Verified against the file's 2022-05-31 row, read at relay **#10,549,397** (`Timestamp::Now` = 2022-05-31T23:59:54.011Z):

| Chain | Archived (2023) | Read at that block |
|---|---|---|
| Acala | 1,462,204.19 | 1,462,204.186283087 |
| Moonbeam | 257,493.08 | 257,493.0765709934 |
| Parallel | 649,004.98 | 649,004.9792496555 |
| Astar | 103,221.23 | 103,221.2311821044 |

Reading at 00:00 of the same day instead lines the series up one day EARLY against that file and reads
as a genuine one-day lead rather than as an off-by-one. This is the same trap CLAUDE.md records for
oracle bars, in the other direction: there a daily bar is labelled by its open, here by its close, and
neither convention is guessable from the numbers.

### What the 2023 study measured, and what it could not

Compared across the whole overlap — 2022-02-02 to 2023-04-08, 431 days, 8 chains, 2,442 chain-days —
the archive and a fresh read of the **`para` leg alone** agree to a **median deviation of 4.0 × 10⁻⁹**.
The widest disagreement outside the archive's final day is **0.244%**, on Acala holding 1.23 DOT: the
file stores two decimal places, so 1.2330 is recorded as 1.23. All 91 chain-days above 0.01% are small
balances where that rounding dominates.

Two things that comparison turned up, both worth knowing before trusting the 2023 numbers:

- **The archive's final day is not a whole day.** On 2023-04-08 all eight chains disagree, by up to
  **23.6%** (Moonbeam: 920,379.34 in the file against 1,137,849.16 at that day's last block). The
  file's own coverage caveat says its captures run eight days past the report's window and stop; its
  last row is therefore the last observation it happened to take, not that day's close. **Its published
  "at the end" figures are mid-day readings.**
- **It measured one of the two accounts.** It read `para` on the relay chain only. On **883 of the
  2,442 chain-days in the overlap** the same chain also held DOT in its `sibl` account on Asset Hub —
  at most 1.12% of that chain's total then, and essentially all of it now. Comparing the archive
  against the SUM scores that leg as a disagreement when it is simply something the original never
  had.

Both readings use `free + reserved` and neither uses `frozen`. Confirmed on three chain-days: Acala at
the close of 2023-02-14 is `free` 1,559,813.6607 + `reserved` 170.0000 = 1,559,983.6607, and the file
says 1,559,983.66.

### `AccountInfo` has been 80 bytes throughout

Every `System::Account` value read across 2022–2026 on both chains is exactly 80 bytes, so
`decodeAssetDetails`-style strict decoding never trips. **It would not catch the one layout change in
the window either**: pre-2023 `AccountData` is `{free, reserved, misc_frozen, fee_frozen}` and current
`AccountData` is `{free, reserved, frozen, flags}` — four `u128`s both times. The two fields we use,
`free` and `reserved`, occupy the same offsets in both, so the amounts are right; `frozen` and `flags`
read out of a 2022 block are `misc_frozen` and `fee_frozen` under the wrong names and must not be
reported. This series does not report them.

### The Migration emptied the relay's account map — a top-holders read there returns small change

Measured 2026-08-21. The relay's **entire** `System::Account` map is **1,493 accounts holding
220,772.38 DOT in total** — read in full (2 `state_getKeysPaged` pages + 5 `state_queryStorageAt`
calls of ≤300 keys) against `rpc.polkadot.io`, pinned to the finalized head. The largest entry is
Hydration's `para 2034` sovereign at 21,417.81 DOT (20,957.81 free + 460 reserved); only two
accounts hold ≥ 10,000 DOT and fifty hold ≥ 1,000; 45 of the 1,493 are `para` sovereigns, 2 are
`sibl`, 3 are `modl` pallet accounts, and the reserved-heavy remainder is deposit dust. Asset Hub's
map, estimated the same day by hashed-key density (a 1,000-key `state_getKeysPaged` page covers a
measurable fraction of the uniform blake2_128 space — here 0.0242 %, so total ≈ 1000/0.000242,
±~3 % at that sample size), holds **~4.14 million accounts**.

So "who holds DOT" is an Asset-Hub-only question today: a ranking read from the relay returns
sovereign remnants and deposit dust and renders perfectly. At pre-Migration blocks the relay map is
fully populated and the archive serves it — the netflows backfill reads it daily across 2022–2026 —
so any per-account series spanning 2025-11-04 must read both chains on every day and sum, exactly
as the sovereign netflows series already does.

Cost of ranking Asset Hub's full map, extrapolated from per-request timings measured the same day
(key pages 195–345 ms; a 300-key `state_queryStorageAt` at a pinned block 444 ms, all 300 values
non-null): ~4,141 key pages + ~13,803 storage reads ≈ **2 hours sequential** against the public
endpoint — a one-off, resumable snapshot job, not a standing cost. A pinned-block read stays
answerable for the whole sweep because the endpoint is a full archive.

### Block rates are not constant, and Asset Hub's has sped up more than fivefold

Never extrapolate a height from a date here. Measured across the range:

| | Blocks per UTC day | Seconds per block |
|---|---|---|
| Relay chain, 2022-05-31 | 14,173 | 6.10 |
| Relay chain, 2023-01-15 | 14,398 | 6.00 |
| Relay chain, 2024-03-01 | 14,291 | 6.05 |
| Asset Hub, 2022-05-31 | 6,905 | 12.51 |
| Asset Hub, 2023-01-15 | 7,158 | 12.07 |
| Asset Hub, 2024-03-01 | 6,748 | 12.80 |
| Asset Hub, 2025-11-04 | 13,154 | 6.57 |
| Asset Hub, 2026-08-19 | 38,627 | **2.24** |

Asset Hub's rate has moved by a factor of six inside the window this series covers — twelve seconds until the
Asset Hub Migration, about six and a half seconds on the day of it, roughly two and a fifth today — and none of
those steps is at a round date. A global average is worse than useless: it sits between the two regimes and is
wrong in both halves. The day-boundary search therefore measures the rate **locally**, from the two
samples nearest the target, and verifies every answer against the chain's own timestamps before using
it.

### The lease-expiry spike is real

On **2023-10-24/25** the sovereign accounts of Acala and Parallel jump by an order of magnitude and
then decay for months:

| Day | Parallel (para 2012) | Acala (para 2000) | All chains |
|---|---|---|---|
| 2023-10-23 | 393,949 | 1,445,754 | 4,125,571 |
| 2023-10-24 | 407,501 | **12,632,507** | 15,802,282 |
| 2023-10-25 | **16,357,149** | 10,819,202 | 29,848,746 |
| 2023-11-05 | 8,016,733 | 8,160,958 | 19,112,003 |

This is not a decode fault. The same storage key at the same block was read from a **second,
independent public node** (`polkadot.api.onfinality.io/public`) and agrees to the planck:
16,357,118.7446 DOT for para 2012 at relay #17,883,304, against 16,357,118.7446 from
`rpc.polkadot.io`. Polkadot's first 96-week leases, won in the December 2021 auctions, expired in
late October 2023; both chains ran liquid-crowdloan products that had contributed from the chain's own
account, so the returned contributions land back in the sovereign account and drain out again as
holders redeem. **Any peak-holding ranking over this range is dominated by that event rather than by
bridged reserves**, and the shape — a step up followed by a months-long decay — is what says so.

### The cost, measured

`asset-hub/netflows-daily`, filling calendar months into `server/data/store.sqlite` on 2026-08-20:

| | |
|---|---|
| one stored day, JSON payload | **1,392 B mean** over all 1,673 days (322 B smallest, 1,925 B largest) |
| a whole month, over the wire | **15 kB** in January 2022, **65 kB** in July 2026 — it grows with the number of parachains, not with the amounts |
| the whole 2022-01 → 2026-07 series | **1,673 days, 2.33 MB** of stored payload; 2.5 MB served as 55 month responses |
| HTTP requests per day | **5.70**, measured 2026-08-21 — see the correction below |
| time per day | **~1.1 s**, ten days per committed batch |
| a whole month | **~45 s** |
| the whole backfill | **~50 minutes**, one drainer, resumable at any point |

⚠️ **The request figure that was here — "~2.2 per chain" — does not reproduce, and the arithmetic
that produced it is the interesting part.** Re-measured on 2026-08-21 by counting real `fetch` calls
through the job handler, with the boundary hint carried across batches exactly as the engine carries
it: **171 requests for 30 Polkadot days (5.70/day)** and **163 for 30 Kusama days (5.43/day)**. The
2.2 counted the boundary search and the account reads and forgot `netflowsHeads`, which runs on
*every* batch — `pin()` is five un-batched calls per host, so ten requests per ten-day batch, a full
request per stored day spent re-reading two heads that moved a few hundred blocks. Research queue O55
asks whether three of those five are needed mid-month. Kusama's whole backfill, for comparison: 61
months, 1,857 days, **33.1 minutes**, 1.07 s a day ([kusama.md](kusama.md#what-it-costs-to-read)).

Five of the fifty-five months failed once mid-run with `could not be reached` against one endpoint or
the other and succeeded on the retry — a public RPC drops a connection occasionally and that is
ordinary weather, not a fault. It matters only because the attempt budget is three: a month that
loses three attempts becomes `gave-up` and stays there until `node scripts/job.mjs retry <id>`. Check
`job list gave-up` after any long fill.

The two things that make a day cheap are `state_queryStorageAt` — many keys at one block — and
**JSON-RPC batching**, which both endpoints accept (an array of calls in one POST returns an array of
results). Batching across DAYS as well as across keys is what turns a boundary search into two HTTP
requests per round regardless of how many days are in flight. Responses are matched back by `id`, never
by position: a server may reorder a batch response, and reading it positionally would attribute one
block's balances to another day.

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
| Relay chain RPC | `https://rpc.polkadot.io` (public, no key) — `Paras::ParaLifecycles`, `Registrar::Paras`, relay-side `System::Account` |
| Parachain enumeration | `Paras::ParaLifecycles` (89), `Registrar::Paras` (123), `Paras::Heads` (90) — all relay-side, all current-state only |
| Chain clock, for liveness | `Timestamp::Now` (u64 ms), read at the pinned block |
| Day boundaries, historical | `chain_getBlockHash(height)` + `Timestamp::Now` at that hash, searched and **verified**, never extrapolated from a block time |
| Native token units | `system_properties` → `{ss58Format: 0, tokenDecimals: 10, tokenSymbol: "DOT"}` on both chains |
| Runtime version | `state_getRuntimeVersion` → `specName: statemint`, `specVersion: 2003002` on 2026-08-20; relay `polkadot` 2003002. `system_version` is `1.24.1-8ae9775dc43` on both |
| Aggregate XCM flows | `https://api.data.parity.io/api/xcm-top-routes`, `/api/daily-usdc` |

This site reads all of the above through one source module, `server/sources/asset-hub.mjs`:

| Operation | What it answers |
|---|---|
| `/api/asset-hub/bridged-inventory` | every `ForeignAssets` entry with its location decoded from its own key, split bridged/sibling, grouped by consensus system, plus the two locally-issued stablecoins in a separate block |
| `/api/asset-hub/bridged-holders` | each bridged supply decomposed across the parachain sovereign accounts, as one flat row per (chain, asset), plus the supply reconciliation above |
| `/api/asset-hub/sovereign-dot` | DOT in every enumerated chain's `para` and `sibl` accounts, two flat rows per chain, plus the chains the relay's own enumeration does not name |
| `/api/asset-hub/sovereign-dot-recent` | the same reading for the most recent CLOSED UTC days — the tail a month-bucketed store cannot serve |
| `/api/asset-hub/netflows-daily` (job) | one stored fact per UTC day, a calendar month at a time: both sovereign legs for every enumerated parachain at that day's last block on each chain |
| `/api/asset-hub/netflows-series` (store-read) | every settled month of the above in ONE response, each month carrying the same `{data, coverage, job}` envelope. This is what `/netflows/` draws — one request instead of one per month (decision 0020) |
| `/api/stream/asset-hub/netflows-daily` (SSE) | the identity watch: given `network` and a list of `months`, hands each month's complete envelope over as one Server-Sent Event when it lands. Read-only — it observes fetches, it never starts one |

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
