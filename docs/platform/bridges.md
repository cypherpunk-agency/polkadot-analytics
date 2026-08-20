# Bridges

Every bridge on this page answers the same question in a different way: **when a unit of value
that was issued somewhere else appears on Polkadot, what carried it, and what do you have to
believe for it to really be there?** The answers are not interchangeable, and neither are the
numbers they produce — which is the reason this page exists. Adding a Snowbridge TVL to a
Chainflip swap volume produces a figure with no referent at all.

Everything below is stated as of **2026-08-20**. Claims carry their grade:
*verified live* means it was called on that date and the response is quoted;
*source-verified* means it was read out of the runtime or pallet source that defines the
behaviour; anything inherited from elsewhere and not checked here says so in the sentence that
makes it. The endpoints are listed under [Where we read this from](#where-we-read-this-from).

---

## The only classification that matters

Not "which chains does it connect" — **who can take the money**.

| Mechanism | Who can steal it | On this page |
|---|---|---|
| Light client / consensus proof | Nobody short of breaking the source chain's consensus, or the verifier implementation | Snowbridge, the Polkadot–Kusama bridge, Hyperbridge |
| Threshold signature (MPC) | A threshold of the signer set, colluding | Chainflip |
| Committee multisig | A threshold of a named committee, colluding | Wormhole (13-of-19 Guardians), Axelar, LayerZero |
| Over-collateralised vault | Nobody — but you can be repaid in collateral instead of in the asset you wanted | Interlay iBTC, Spacewalk |
| Optimistic, fraud-proved | Anybody, if nobody is watching | Nomad, and it happened |

Two consequences for measurement, before any number appears:

- **"TVL" is only meaningful for lock-and-mint.** A burn-and-mint bridge (Wormhole NTT) locks
  nothing, so there is no pot to point at; a flow protocol (Chainflip) has volume and no stock.
  A table with a TVL column for all three is comparing a balance, a nothing, and a rate.
- **A light client and a multisig can move the same dollar and are not the same event.** If you
  are ranking bridges, rank them inside a trust class or state the class in the row.

## Live on Polkadot mainnet

### Snowbridge — Ethereum, both directions, no committee

Snowbridge is the one that matters, and it is a real bridge in the strict sense: a **BEEFY/MMR
light client of Polkadot deployed as an Ethereum contract**, and an **Ethereum beacon-chain
sync-committee light client running as a pallet on Polkadot BridgeHub**. No attestors, no
multisig, no bonded oracle. What you trust is the two consensus mechanisms and the two
implementations of them.

Verified live on 2026-08-20:

| Thing | Value | How it was checked |
|---|---|---|
| Ethereum Gateway | `0x27ca963c279c93801941e1eb8799c23f407d68e7` | 357 bytes of code — a proxy, not the implementation |
| BEEFY light client | `0x7cfc5c8b341991993080af67d940b6ad19a010e1` | 13,253 bytes of code |
| DOT as an ERC-20 | `0x196c20da81fbc324ecdf55501e95ce9f0bd84d14` | `decimals()` returns 10; `totalSupply()` 205,968,860,766,322 = **20,596.886 DOT** |
| KSM as an ERC-20 | `0x12bbfdc9e813614eef8dc8a2560b0efbeaf7c2ab` | 12 decimals, from the registry |
| Registry package | `@snowbridge/registry` 1.1.13 | published 2026-08-17T21:15:51Z; its own `registry.timestamp` is 2026-08-11T22:18:25Z |

**DOT on Ethereum is a real ERC-20 with a real reserve, and the two sides reconcile.** The
Ethereum sovereign account on Asset Hub held **20,679.762 DOT** against 20,596.886 DOT of ERC-20
supply — a gap of 82.876 DOT, or 0.4%, which is what in-flight transfers and fees look like.
Deriving that account is a trap in its own right and has its own entry in `CLAUDE.md`: the
account is `1jMhfSJv5MkSQmEq97UmXCmMV63SHoQ3ednwkRSKETrCREU`
(`0x204dfe37731e8e2b4866ad0da9a17c49f434542c3477c5f914a3349acd88ba1a`), and it is derived from
`blake2_256(b"ethereum-chain", chain_id: u64)` — **not** from either of the `glblcnsnss` prefixes.
`ExternalConsensusLocationsConverterFor` special-cases Ethereum onto its own prefix and never
reaches the `glblcnsnss` branch (*source-verified*, `polkadot/xcm/xcm-builder/src/location_conversion.rs`);
both `glblcnsnss` derivations were also tried against the chain and returned no account at all
(*verified live*). A wrong prefix here does not error — it renders as an empty bridge.

#### What is actually registered, and in which direction

The registry lists **41 Ethereum assets for Asset Hub**, and that number conflates two
directions. On chain, `ForeignAssets::Asset` on Asset Hub has 52 keys, of which **33 are
Ethereum-origin** — 32 ERC-20s keyed `{parents: 2, X2(GlobalConsensus(Ethereum{1}),
AccountKey20)}` plus native ETH keyed with an `X1`. The other **8 registry entries are
Polkadot-origin tokens wrapped in the opposite direction** — DOT, KSM, PINK, DED, TEER, XRT, WUD
and KOL — which need no `ForeignAssets` key because they are already native or locally issued
here. The counts are *verified live*; that the 8 are the outbound direction is *inferred* from
what they are. So: 33 things arriving, 8 things leaving, one list of 41.

Supplies on Asset Hub, *verified live*, with holder counts from `AssetDetails.accounts`:

| Asset | Supply on Asset Hub | Holders |
|---|---|---|
| TRAC | 23,952,749.4438 | 9 |
| USDC (Ethereum-issued) | 550,876.1507 | 82 |
| USDT (Ethereum-issued) | 403,367.5719 | 44 |
| WETH | 471.5411 | 93 |
| tBTC | 71.0791 | 8 |
| WBTC | 0.1205 | 22 |
| LBTC | 0.0002 | 1 |

Elsewhere the registry carries Hydration (21 assets), Bifrost (2), and Acala, NeuroWeb, Mythos
and JAMTON (1 each); `v2_parachains` is `[1000, 2034]`, so Asset Hub and Hydration are the two
chains Snowbridge V2 addresses directly. It also carries three Ethereum **L2s** — Optimism, Base
and Arbitrum, three assets each — reached not by a second light client but by an `l2Bridge`
config that hops through Across. An L2 leg is therefore a different trust model from the L1 leg,
inside the same registry.

> One Hydration entry in the registry has an empty `name`, an empty `symbol` and `decimals: 0`.
> It is vTAO (`0xe9f6d9898f9269b519e1435e6ebaff766c7f46bf`), which is 18 decimals on Ethereum.
> Reading decimals from the destination-chain entry gives 0 and multiplies every vTAO amount by
> 10^18. The registry is per-chain, and a per-chain entry can be blank.

#### The two indexer URLs, and which one is alive

The Snowbridge app's `.env.example` and the registry disagree about where the indexer is. They do
not merely disagree — one of them is gone:

| URL | Source | Result on 2026-08-20 |
|---|---|---|
| `https://snowbridge.squids.live/snowbridge-subsquid-polkadot@v1/api/graphql` | the app's `.env.example` | **HTTP 404** (nginx) |
| `https://subsquid.snowbridge.network/graphql` | `registry.environment.indexerGraphQlUrl` | **HTTP 200**, live and current |

The live one is an Apollo server with **introspection disabled** (a `__schema` query returns HTTP
400 with a message saying so), and `squidStatus` fails with `relation "squid_processor.status"
does not exist` — so neither of the two usual ways to ask a squid what it holds works. The way in
is the error message: query a field that does not exist and the server suggests near matches. The
entities are `transferStatusToPolkadotV2s` and `transferStatusToEthereumV2s`, each with `…ById`
and `…Connection` variants.

Verified live: **16,158** Ethereum-to-Polkadot transfers and **11,266** Polkadot-to-Ethereum
transfers indexed, the newest timestamped `2026-08-20T11:26:35Z` — about eight minutes before the
query. Fields on a transfer: `id`, `nonce`, `status` (an integer), `timestamp`, `tokenAddress`,
`amount`, `senderAddress`, `destinationAddress`, `blockNumber`, `messageId`.

> `tokenAddress` is **not consistently cased**. Two records read minutes apart gave
> `0x196C20DA81Fbc324EcdF55501e95Ce9f0bD84d14` (EIP-55 checksummed) and
> `0x9d39a5de30e57443bff2a8307a4256c8797a3497` (lower case). The registry is lower case
> throughout. Joining indexer rows to registry entries on the raw string silently matches a
> subset — lower-case both ends.

#### The dashboard REST API, and what its TVL actually is

`https://dashboard.snowbridge.network/api/tvl` returned HTTP 200 with more than the `{tvlUsd}` it
is usually quoted for:

```
{ tvlUsd, balanceEth, ethPriceUsd, ethTvlUsd, tokenTvlUsd,
  tokens: [ { symbol, balance, balanceUsd }, … 18 entries ] }
```

`tvlUsd` was **25,013,346.24** on 2026-08-20. `/api/volume-by-month` returned 13 monthly rows,
`2025-08` through `2026-08`: $2,464,927 so far in August 2026, against a peak of $66,965,294 in
October 2025.

The endpoint publishes no methodology, but the payload gives it away: its per-token `balance`
figures **match Asset Hub's `ForeignAssets` total supply asset for asset** — TRAC is
23,952,749.443789955 on both sides, to nine decimal places (*verified live*, both sides). That
`tvlUsd` is therefore the Polkadot-side minted supply valued at the endpoint's own prices is
*inferred* from that reconciliation, not published. That is a defensible number and it is not the
Ethereum-side locked collateral, it excludes the Kusama leg, and it is somebody else's price
feed. Quote it as Snowbridge's figure, not as ours.

> The client ships `MOCK_TVL_USD = 56337162.01` and a mock monthly series for dev mode. That
> constant is inherited from the brief for this page and was **not verified here**; what was
> verified is that the live endpoint returns a different, moving number. If you ever see exactly
> $56,337,162.01, you are looking at the mock.

### The Polkadot–Kusama bridge — how Ethereum assets reach Kusama

Two GRANDPA light clients, one on each BridgeHub, each following the other relay chain. Same
trust class as Snowbridge, and it is the reason Kusama has Ethereum assets at all: there is **no
direct Kusama-to-Ethereum bridge** — the Snowbridge environment marks `kusama_mainnet` as
"(TBD)". Ethereum assets reach Kusama by crossing to Polkadot Asset Hub first and then over this
bridge.

Verified live: Kusama Asset Hub's `ForeignAssets::Asset` holds **34 keys, 23 of them
Ethereum-shaped**; the Snowbridge registry lists 25 for Kusama Asset Hub, the extra two being DOT
and KSM, which are not Ethereum-origin. On the Polkadot side, the sovereign account of Kusama
Asset Hub held **407,487.127 DOT** — twenty times the Ethereum bridge's reserve, which is worth
remembering before calling Snowbridge the largest thing here. That account is
`12GvRkNCmXFuaaziTJ2ZKAfa7MArKfLT2HYvLjQuepP3JuHf`, derived as
`blake2_256(b"glblcnsnss/prchn_", NetworkId::Kusama, 1000u32)` (*source-verified*) — the para id
as a **plain u32**, not SCALE-compact. The compact encoding derives a different account, which
holds nothing (*verified live*).

### Wormhole — two different paths, and the difference changes the measurement

Wormhole reaches Polkadot twice, by mechanisms with nothing in common but a name. Both are
secured by the **Guardian committee, a 13-of-19 multisig** — materially weaker than any light
client on this page, and worth saying out loud next to a number.

**(a) NTT straight into Hydration.** Hydration has its **own Wormhole chain id, 73**, and it is
registered on the EVM platform — *verified* against `@wormhole-foundation/sdk-base` 6.1.5
(published 2026-07-29), which contains `[73, "Hydration"]` and `Moonbeam: 16`. Native Token
Transfers are **burn on the source chain, mint on the destination**: no wrapper contract, no
Moonbeam hop, and **no locked collateral anywhere**, so asking for this path's TVL is a category
error rather than a hard measurement.

The Polkadot-side machinery is a storage map on Hydration: `EVMAccounts::NttMinters`, asset id to
H160 spoke manager, with a `clear_ntt_minter` emergency stop in the runtime. *Verified live*:
**11 entries** in runtime 435. Resolved against Hydration's own `AssetRegistry`, eight of them are
named assets — `USDC (Wormhole)` (21), `USDT (Wormhole)` (23), `WETH (Wormhole)` (20),
`WBTC (Wormhole)` (19), `DAI (Wormhole)` (18), `EURC (Wormhole)` (44), `Jito Staked SOL` (40) and
`PRIME` (43) — and three are ids above 1,000,000 whose registry entries are not plain tokens.

**(b) MRL through Moonbeam.** Lock on the source chain, mint a Moonbeam ERC-20, then XCM onward.
This is the classic route and it depends on Moonbeam being there — see the Moonbeam section
below, which is not the sentence anyone expected to write.

Traffic, *verified live* from `/api/v1/x-chain-activity/tops` for **July 2026**:

| Destination | Inbound messages | Sources |
|---|---|---|
| Hydration (73) | 33 | Solana 6, Ethereum 22, Sui 3, Base 2 |
| Moonbeam (16) | 120 | Ethereum 47, Solana 64, Klaytn 9 |

The response also carries a `volume` integer whose units the API does not document. Read as
1e8-scaled USD it puts Hydration's July inbound at a few tens of dollars, which is consistent
with the individual NTT payloads inspected (a ten-unit EURC transfer) but is small enough that it
should be confirmed against summed transfer amounts before publishing. **Message counts are
unambiguous; the volume field is not.**

> **The Wormholescan NTT endpoint does not filter by chain.** `/api/v1/native-token-transfer`
> with `fromChain`/`toChain` returns HTTP 404 — the path does not exist. Its real sub-paths are
> `/activity`, `/summary`, `/token-list`, `/top-address`, `/top-holder` and `/transfer-by-time`,
> and they are keyed by `symbol` or `coingecko_id`, never by chain. Chain filtering lives on
> `/api/v1/operations` (`sourceChain`, `targetChain`) and `/api/v1/x-chain-activity/tops`. Both
> accept `73` and `16` and return data.

### Chainflip — not a parachain, and its DOT leg has moved

Chainflip is **not a Polkadot parachain**. It is a standalone Substrate L1 — the "State Chain" —
that holds **MPC vaults secured by FROST threshold signatures** on every connected chain and runs
its own AMM in the middle. Its Polkadot connection is that it is one of the venues where DOT
trades against BTC and SOL without a custodian.

Verified live against `https://archive.mainnet.chainflip.io` (`system_chain` =
`Chainflip-Berghain`, node version `2.2.8-aec046ee199`):

- `cf_supported_assets` returns **18 assets over 7 chains**: Ethereum (ETH, FLIP, USDC, USDT,
  WBTC), Bitcoin (BTC), Arbitrum (ETH, USDC, USDT), Solana (SOL, USDC, USDT), Tron (TRX, USDT),
  **Assethub (DOT, USDT, USDC)** — and **Polkadot (DOT)**, the relay leg, still listed.
- `cf_available_pools` returns **16 pools**, every one quoted in Ethereum USDC. One of them is
  `Assethub.DOT / Ethereum.USDC`. **There is no `Polkadot.DOT` pool.**

That is the whole story in two calls: the relay leg is still in the asset list and in every fee,
delay and safety-margin map, and it has no market. Chainflip's own SDK says the same thing in its
type system — `@chainflip/utils` 2.2.8, published 2026-08-05, has
`chainflipChains = [Ethereum, Arbitrum, Tron, Bitcoin, Solana, Assethub]` with
`legacyChainflipChains = ["Polkadot"]`, and assets `HubDot`, `HubUsdt`, `HubUsdc` beside a legacy
`Dot`. **Anyone measuring Chainflip's DOT vault on the relay chain today is reading a deprecated
address**, and `cf_supported_assets` alone will not tell them so.

> No public volume or TVL endpoint was found for Chainflip. The archive RPC is open and carries
> 245 methods, 60-odd of them `cf_*` — the raw material is key-free, but the finished number is
> not off the shelf, and building it means defining what a Chainflip "TVL" even is when the
> vaults are on seven chains.

### Hyperbridge — serious, and mostly not about Polkadot

Hyperbridge (para 3367) is the most cryptographically ambitious design here: it verifies source
chains' consensus on-chain and proves messages against the state roots that consensus finalised.
It has its own page — [hyperbridge.md](hyperbridge.md) — and the point to carry over here is the
one that page already establishes from live reads: **its traffic is not Polkadot's**. The state
machines seen live are `EVM-1`, `EVM-137`, `EVM-56`, `EVM-8453`, `EVM-42161`, `EVM-100` and
`SUBSTRATE-cere`. No Asset Hub. No other parachain. And 32 of 40 sampled Intent Gateway orders
were **same-chain swaps on Base**.

So its contribution to "value bridged into Polkadot" is close to zero, and a bridge league table
that ranks it by total volume is measuring a chain that happens to be a parachain, not value
arriving on Polkadot.

### Interlay iBTC — vault-secured BTC, on a chain that has stopped

Interlay brings native BTC in through **XCLAIM-style over-collateralised vaults**: a vault locks
collateral worth more than the BTC it holds, and if it misbehaves the user is made whole in
collateral. That is economic security, not cryptographic — the failure mode is not theft, it is
being paid in DOT when you wanted BTC.

The uncomfortable part is *verified live*, and it is not what "live but stagnant" prepares you
for:

All of it read from `https://api.interlay.io/parachain`, which is the **only** Interlay endpoint
reachable from this service's network: `rpc.interlay.io`, `interlay-rpc.dwellir.com` and
`interlay.api.onfinality.io/public` all fail at CONNECT and resolve to no address here, and
whether that is egress policy or a dead host was not established.

| Reading | Value |
|---|---|
| `Timestamp::Now` on Interlay | **2026-07-27T12:13:01.797Z** — 24.01 days stale |
| Head block | 10,885,373, equal to the finalized head |
| `ParachainSystem::LastRelayChainBlockNumber` | 32,291,282, against a relay head of 32,636,169 — 344,887 blocks behind |
| Para 2032's head on the relay | unchanged across a 3m20s window in which 32 of 90 registered paras advanced |
| `Tokens::TotalIssuance(Token(IBTC))` | 211,841,671 = **2.11841671 iBTC** |
| `Tokens::TotalIssuance(Token(KBTC))` | **no such key** — see below |
| `Tokens::TotalIssuance`, whole map | 27 CurrencyIds |
| `VaultRegistry::Vaults` | 133 registrations, 81 distinct operator accounts, **every one wrapping `Token(IBTC)`** |
| `AssetRegistry::Metadata` | 15 entries, every key a bare `u32` — no `Token(...)` entry at all |
| Runtime | `interlay-parachain` 1025008, node `interBTC Parachain 1.25.4-9ae20ea6617` |

Read twice on 2026-08-20, hours apart, by two different agents: identical head, identical
timestamp, identical issuance to the last satoshi. The chain did not move in between either.

**Interlay's parachain has not produced a block in 24 days, and every endpoint answers anyway.**
The RPC serves state, the GraphQL squid at `https://api.interlay.io/graphql/graphql` answers with
102 query fields, storage reads succeed, and a dashboard built on any of it renders a perfectly
formatted 24-day-old number. This is the failure this repository exists to catch: nothing is
down, everything is stale. Read `Timestamp::Now` and compare it to the wall clock before
believing any parachain figure.

The repository-activity dates in the brief for this page — node repo last commit 2025-05-27,
vault clients 2025-07-03, UI 2026-07-27 — **could not be verified here**; the GitHub API is not
reachable from this environment. The UI date and the date the chain stopped being the same day is
suggestive and nothing more.

#### Reading the issuance yourself

`Tokens` is `orml_tokens`, and `TotalIssuance` is
`StorageMap<_, Twox64Concat, CurrencyId, Balance, ValueQuery>`. The key is therefore
`twox128("Tokens") ++ twox128("TotalIssuance") ++ Twox64Concat(CurrencyId)`, and the CurrencyId
is two bytes: `CurrencyId::Token` is enum variant 0 and `TokenSymbol` runs
`DOT = 0, IBTC = 1, INTR = 2, KSM = 10, KBTC = 11, KINT = 12` (*source-verified*,
`interbtc/primitives/src/lib.rs`) — the gap is deliberate, Interlay's tokens below ten and
Kintsugi's above. So **iBTC is `0x0001`** and **kBTC is `0x000b`**, and the finished key for iBTC
is:

```
0x99971b5749ac43e0235e41b0d378691857c875e4cff74148e4628f264b974c80d67c5ba80ba065480001
```

*Verified live* 2026-08-20: that key appears verbatim in the node's own `state_getKeysPaged`
sweep of the prefix, and returns `0x8772a00c000000000000000000000000` — a little-endian `u128` of
211,841,671.

Note there is no `twox64` in this repo's codec and there should not be: the hasher is a 64-bit
digest and what Substrate stores is its **little-endian encoding**, so the eight bytes come from
`xxhash64` (which returns a `BigInt`) through a `DataView.setBigUint64(…, true)`.

#### kBTC is ABSENT on Interlay, which is not zero

`0x000b` is **not in the map**. The sweep returns 27 CurrencyIds and none of them is it — kBTC is
Kintsugi's wrapper, on Kusama, and Interlay never mints it. This matters because the distinction
is invisible in a total: reporting 0 would claim the wrapper exists on this chain and holds
nothing, which is a statement about a different chain. Kintsugi kBTC is the same design with the
same decimals constant (`KBTC("kBTC", 8) = 11`); measuring it means reading Kintsugi, which this
repository has not done.

#### The decimals trap, and the three checks that stand in for a registry

> iBTC's **8 decimals are a compile-time Rust constant**, not a storage item:
> `IBTC("interBTC", 8) = 1` in `interbtc/primitives/src/lib.rs` (*source-verified*). This is the
> one asset on this site whose divisor cannot come from a chain registry, and a wrong divisor is
> a silent factor of 10ⁿ on the headline figure.

That the registry cannot supply it is now *verified live* rather than asserted:
`AssetRegistry::Metadata` holds **15 entries and every key is a bare little-endian `u32`** — the
`ForeignAsset(u32)` ids 1–15 — with no entry whose key is a `Token(...)` CurrencyId at all. There
is nothing on chain to read.

One correction to an earlier reading of this: **the node does serve the number, just not from
state.** `system_properties` returns
`tokenSymbol: ["INTR","IBTC","DOT","KINT","KBTC","KSM"]` beside
`tokenDecimals: [10,8,10,12,8,12]`, position-aligned, and it says IBTC is 8 (*verified live*).
The alignment is corroborated by the other five: DOT reads 10 on this chain, KINT and KSM 12, and
those divisors make `Token(DOT)`'s 91,265,211,340,641 into 9,126.52 DOT and `Token(INTR)`'s
issuance into 999,967,471 INTR against a one-billion cap. But this is the **chain spec's
`properties` block, served by the node** — not consensus state, not part of the runtime, and
signed by nobody. It is corroboration, never the authority.

So `server/sources/interlay.mjs` runs three independent checks, and each catches something
different:

1. **The key is computed and checked against the node's own enumeration.** An empty
   `Tokens::TotalIssuance` sweep is treated as an *error*, not as an empty map — a prefix moved
   by a runtime upgrade reads as "nothing here" rather than as a failure, and would publish
   "0 BTC bridged" in perfect health.
2. **`system_properties` must agree when it speaks.** A disagreement throws; a silence is
   reported as "not corroborated" and never as agreement.
3. **A plausibility canary at 1,000 iBTC**, above which the module refuses to publish. That is
   ~470× today's issuance and more than ten times all the BTC bridged into Polkadot by every
   route combined, so real growth does not reach it — while a divisor short by 10³ puts today's
   supply at 2,118 and by 10⁴ at 21,184, both of which render perfectly.

The canary's blind spot is worth stating because it is real: a divisor that is too **small**
makes the figure enormous and is caught, while a divisor that is too **large** makes it tiny —
and a tiny number is indistinguishable from a bridge that wound down. Only check 2 catches that
direction.

#### What backs it

133 vault registrations across 81 distinct operator accounts, **all 133 wrapping `Token(IBTC)`**
(*verified live* 2026-08-20). `VaultRegistry::Vaults` is a `StorageMap<_, Blake2_128Concat,
VaultId, Vault>` where `VaultId` is `{ account_id: AccountId32, currencies: { collateral, wrapped
} }`, and because the hasher concats, the whole `VaultId` reads back out of the key: 32 bytes of
account, then the two CurrencyIds. All 133 keys re-derive their own 16-byte Blake2 digest from
that plaintext, 133 of 133, which is what makes reading the counts out of keys alone safe — no
vault struct is decoded, so there is no collateral *amount* here and no claim about how
over-collateralised anything actually is. **A registration is not a vault with BTC in it.**

The collateral CurrencyIds, as raw hex, are `0x0000` (66 registrations — `Token(DOT)`,
source-verified), `0x0103000000` (21), `0x0102000000` (18), `0x0203000000` (14), `0x0202000000`
(10), `0x0205000000` (3) and `0x010c000000` (1). Only the `Token` variant is source-verified
here; the `ForeignAsset`/`LendToken`/`LpToken` variants are inferred from live key shapes, so
this site reports them as hex rather than putting a name on a guess.

#### What this site reads

One caveat on the headline framing: **iBTC is not the only BTC-denominated asset on Interlay.**
`Tokens::TotalIssuance` also carries `ForeignAsset(9)` — `Wrapped BTC (WBTC.wh)`, Wormhole's, 8
decimals per `AssetRegistry::Metadata` — at 64 raw units, i.e. **0.00000064 WBTC** (*verified
live* 2026-08-20). It is dust, and `ForeignAsset(5)` (`tBTC v2`, 18 decimals) has no issuance
entry at all. But "iBTC issuance is the BTC Interlay bridged" is a claim about *Interlay's
vaults*, not a claim about all the BTC sitting on that chain, and unlike iBTC these foreign
assets do have readable decimals in the registry.

`/api/interlay/btc-bridged` (`server/sources/interlay.mjs`), 15-minute TTL. It does **not** read
Interlay's sovereign DOT — the `sibl` account on Asset Hub and the `para` account on the relay —
because `/api/asset-hub/sovereign-dot` already sweeps every parachain's from four independent
enumerations, and a second reader would let the two answers drift. And it carries **no dollar
figure**: no BTC/USD price is reachable without an API key, this repo has none, so `usd` is
`null` with the reason attached rather than a number.

### Spacewalk — Pendulum to Stellar

Vault-collateralised, same family as Interlay, deliberately small and capped. Pendulum (para
2094) was producing blocks during the liveness window on 2026-08-20. No further live reads were
made for this page; treat everything else about Spacewalk here as unverified.

### Moonbeam's bridge set — and Moonbeam

Moonbeam is where Wormhole, Axelar and LayerZero land assets for Polkadot, all of them
committee-based, all arriving as ERC-20 contracts of which only some travel onward by XCM. Two
things to know before reading Moonbeam at all.

**First, a Substrate-only read of Moonbeam finds GLMR and nothing else.** Moonbeam removed
`pallet_assets` outright — the runtime source carries the tombstone (*source-verified*,
`runtime/moonbeam/src/lib.rs`)
`// [Removed] Assets: pallet_assets::{Pallet, Call, Storage, Event<T>} = 104,` and
`// Previously 108: pallet_assets::<Instance1>` — and cross-chain assets now live in
`EvmForeignAssets: pallet_moonbeam_foreign_assets = 114` as **native EVM ERC-20 contracts**.
*Verified live*: the string `pallet_assets` appears zero times in Moonbeam's runtime metadata,
while `pallet_moonbeam_foreign_assets` appears six times. Balances there are read with
`eth_call`, not with a storage query.

**Second, Moonbeam has not produced a block in ten days.** *Verified live* on 2026-08-20:

| Reading | Value |
|---|---|
| `Timestamp::Now` on Moonbeam | **2026-08-10T11:36:12Z** |
| Head block | 16,796,699, three ahead of finalized |
| `ParachainInfo::ParachainId` | 2004 |
| `ParachainSystem::LastRelayChainBlockNumber` | 32,492,252 against a relay head of 32,636,169 — 143,917 blocks, about 10 days |
| Para 2004 on the Polkadot relay | **absent from `Paras::Heads`, `Paras::ParaLifecycles` and `Paras::MostRecentContext`** — checked on two independent relay RPCs |

Four independent readings agree, and this page is not the place to explain them. What follows for
the numbers is concrete: **the Wormhole MRL route runs through a chain that is not currently
being included on Polkadot**, and any Moonbeam-sourced figure is at least ten days old. Confirm
this before building on it — it is the single most consequential thing on this page and it was
established from two RPCs on one afternoon.

## Was, and is not

A stale blog post will list all of these as live Polkadot bridges. None of them is.

| | What happened |
|---|---|
| Multichain / Anyswap | Collapsed in 2023 after its CEO was detained and user funds moved; the code stopped. Last commit reported as 2023-05-10, unverified here. |
| ChainBridge | Development stopped; last commit reported as 2022-07-13, unverified here. |
| Nomad | **$190M exploit, August 2022.** Was a major Moonbeam route. Optimistic model whose fraud-proof window never got a chance to matter, because the bug made every message provably valid. |
| Composable / Picasso IBC | The IBC-to-Polkadot work stopped; the project pivoted to Solana restaking. Repo and lease dates reported as 2025-04-10 and 2026-05-03, unverified here — but **para 2019 was producing blocks on 2026-08-20**, so "the lease ended" is not a claim this page can make. |
| t3rn | An execution and intent layer, **never a token bridge**. Listing it as one was always a category error. Last commit reported as 2025-12-09, unverified here. |
| Centrifuge | **Left Polkadot.** CFG migrated to an Ethereum-native multichain deployment using Wormhole, with a migration deadline reported as 2025-11-30. CFG can be bridged back in over Snowbridge — it is in the registry at `0xcccccccccc33d538dbc2ee4feab0a7a1ff4e8a94`, *verified*. Para 2031 was still producing blocks on 2026-08-20. |
| Darwinia | A Substrate-to-Ethereum bridge project whose lease is reported to have ended 2026-02-13. This repository's own `docs/concept/research/drilldown.md` recorded **1 XCM message in 30 days**. Para 2046 was still producing blocks on 2026-08-20. |

> **You cannot read "is this parachain still leased" off the relay chain any more.** Under Agile
> Coretime, `Paras::Parachains` on Polkadot lists **three** entries (BridgeHub, People, Coretime)
> and `Paras::ParaLifecycles` calls 86 of its 89 registered paras `Parathread`, Asset Hub and
> Hydration included. Neither is a liveness or a lease signal. What does work is sampling
> `Paras::Heads` twice and diffing: 32 of 90 heads advanced over 3m20s on 2026-08-20. A head that
> advances proves the chain is alive; one that does not, over a short window, proves nothing.

## Three things that are not what they look like

### Hydration's `Signet` pallet is not a bridge

`Signet` is a **CAIP-2 remote-signing service** — chain abstraction, not asset transfer. A
Hydration account asks the pallet for a signature over a payload or a serialised foreign
transaction, an off-chain responder set produces it, and the result drives an account on another
chain. Nothing is locked, minted, burned or wrapped, so it cannot appear in a bridge volume
figure. Its trust model is the responder set.

*Verified live* in runtime 435 from `state_getMetadata`:

- Calls: `set_config`, `sign`, `sign_bidirectional`, `respond`, `respond_error`,
  `respond_bidirectional`, `pause`, `unpause`, `withdraw_funds`.
- `set_config` takes a `chain_id` documented as "The CAIP-2 chain identifier";
  `sign_bidirectional` takes `caip2_id`, `serialized_transaction`, and both an
  `output_deserialization_schema` and a `respond_serialization_schema`, all as bounded byte
  vectors.
- `Signature` is `{ big_r: AffinePoint, s: [u8; 32], recovery_id }` — a secp256k1 threshold
  signature in the chain-signatures style.
- Events: `ConfigUpdated`, `Paused`, `Unpaused`, `FundsWithdrawn`, `SignatureRequested`.
- Pallet id `py/signt`.

**And it is switched off.** The pallet has exactly one storage item besides its storage version —
`SignetConfig`, documented in the metadata as "Global configuration for the signet pallet. If
`None`, the pallet has not been configured yet and cannot be used." It read **null** at block
13,702,604 on 2026-08-20, with the storage version at 0. So Signet is present, unconfigured, and
by its own definition inoperative. That is a stronger and more useful statement than "usage
unverified", and it will stop being true the moment somebody calls `set_config` — re-read the key
before repeating it.

> A `SerializationFormat { Borsh, AbiJson }` enum and an `EIP1559TransactionMessage` type are
> described in third-party material about Signet. Neither string appears anywhere in Hydration's
> runtime-435 metadata. What the extrinsics actually take is opaque schema bytes. If those types
> exist, they are in the pallet's source and not in its on-chain interface.

### "A Solana bridge" is three different real things

Ask whether Polkadot has a Solana bridge and there are three true answers with three trust models:

| Route | What moves | Trust |
|---|---|---|
| Chainflip | Native SOL, USDC and USDT against Asset Hub DOT/USDC/USDT, through the State Chain's AMM | FROST threshold signatures |
| Wormhole NTT | Burn-and-mint into Hydration directly (chain 73); or Solana to Moonbeam by MRL, then XCM | 13-of-19 Guardian multisig |
| Hydration `Signet` | Nothing. It signs a Solana transaction on your behalf | The responder set — and it is unconfigured today |

Naming one of them "the Solana bridge" in a chart legend makes the other two invisible.

### BTC arrives on Polkadot mainly as an Ethereum asset

The intuitive picture — BTC comes in through Interlay's vaults — is not what the chains say.
*Verified live* on 2026-08-20:

| Asset | Where | Amount |
|---|---|---|
| tBTC (Snowbridge, from Ethereum) | Asset Hub `ForeignAssets` | **71.0791** |
| tBTC (the same coins, forwarded) | Hydration `Tokens::TotalIssuance` | 71.0782 |
| WBTC (Wormhole, id 19) | Hydration | 11.7527 |
| iBTC (Interlay vaults) | Interlay, chain-wide | **2.1184** |
| iBTC | Hydration | 0.3001 |
| WBTC (Snowbridge, id 1000190) | Hydration | 0.000013 |
| WBTC (Acala Wormhole, id 3) | Hydration | 0.1885 |

**Ethereum-routed BTC exceeds Interlay's entire iBTC supply by roughly thirty-fold**, and almost
all of it is tBTC rather than WBTC — WBTC on Asset Hub is 0.12 coins. That inverts the usual
framing of BTC on Polkadot, and it does so through a bridge whose security is a light client
rather than a vault.

Two corrections that this table forces, both of which were live in this repository's own notes:

- A reading of Hydration's stableswap pool 101 as "11 iBTC against 19 WBTC" is a misreading of
  `docs/concept/research/hydration.md`. **11 and 19 are asset ids**, not amounts — pool 101 is
  the iBTC/WBTC pair, as `docs/concept/research/arbs.md` states explicitly.
- The WBTC in that pool is **asset 19, `WBTC (Wormhole)`** — not Snowbridge's. Hydration's
  registry contains **three different assets whose symbol is `WBTC`**: id 3
  `Wrapped BTC (Acala Wormhole)`, id 19 `Wrapped BTC (Wormhole)` and id 1000190
  `Wrapped Bitcoin`. Summing "WBTC on Hydration" by symbol adds three bridges together and calls
  the result one asset. And tBTC there has **18 decimals** where every WBTC has 8, so the same
  mistake in the divisor is a factor of 10^10.

## Four measurement traps

1. **XCM volume is not bridge volume.** A Snowbridge tBTC that arrives on Asset Hub and hops on
   to Hydration is **one** bridged coin and **two** on-chain events. This is not hypothetical —
   Asset Hub reports 71.0791 tBTC of supply and Hydration reports 71.0782 tBTC of issuance, and
   they are the same 71 coins. This site already measures XCM ([xcm.md](xcm.md)); adding a bridge
   inflow series to it double-counts every forwarded transfer.
2. **A flow is not a stock.** Chainflip's swap volume is a rate; Snowbridge's TVL is a balance.
   Adding them produces a number with no unit. Rank within a class, or label the class.
3. **Burn-and-mint has no collateral to point at.** Wormhole NTT into Hydration locks nothing
   anywhere. A "bridge TVL" table with a row for it is either empty or wrong, and the honest
   entry is a dash with a footnote.
4. **CEX flows dwarf every bridge on this page.** Snowbridge's whole TVL is $25M and its best
   month was $67M of volume. A single exchange moves that between hot wallets without anybody
   calling it a bridge. "Value bridged in" is a statement about mechanism, not about how value
   actually arrives — and if the question was "how did the money get here", the honest answer
   starts with a centralised exchange and a withdrawal.

---

## Where we read this from

| What | Endpoint |
|---|---|
| Snowbridge indexer | `https://subsquid.snowbridge.network/graphql` — GraphQL, public, no key, introspection disabled |
| Snowbridge dashboard | `https://dashboard.snowbridge.network/api/tvl`, `/api/volume-by-month` — REST, public, no key |
| Snowbridge registry | the `@snowbridge/registry` npm package — contract addresses, per-chain asset lists, the indexer URL |
| Ethereum contracts | `https://ethereum-rpc.publicnode.com` — `eth_getCode`, `eth_call` for `decimals()` and `totalSupply()` |
| Asset Hub | `https://polkadot-asset-hub-rpc.polkadot.io` — `ForeignAssets::Asset`, `System::Account` for sovereign balances. See [asset-hub.md](asset-hub.md) |
| Kusama Asset Hub | `https://kusama-asset-hub-rpc.polkadot.io` — `ForeignAssets::Asset` |
| Polkadot relay | `https://rpc.polkadot.io` — `Paras::Heads`, `Paras::ParaLifecycles`, `Timestamp::Now` |
| Hydration | `https://rpc.hydradx.cloud` — `EVMAccounts::NttMinters`, `Signet::SignetConfig`, `AssetRegistry::Assets`, `Tokens::TotalIssuance`. See [hydration.md](hydration.md) |
| Wormhole | `https://api.wormholescan.io/api/v1/operations`, `/x-chain-activity/tops`, `/swagger.json`; chain ids from the `@wormhole-foundation/sdk-base` npm package |
| Chainflip | `https://archive.mainnet.chainflip.io` — `cf_supported_assets`, `cf_available_pools`, `cf_environment`, `cf_get_vault_addresses`; chain and asset names from the `@chainflip/utils` npm package |
| Interlay | `https://api.interlay.io/parachain` — `Tokens::TotalIssuance`, `VaultRegistry::Vaults`, `AssetRegistry::Metadata`, `Timestamp::Now`, `system_properties`. The only Interlay host reachable from here: `rpc.interlay.io`, `interlay-rpc.dwellir.com` and `interlay.api.onfinality.io/public` all fail at CONNECT. Also `https://api.interlay.io/graphql/graphql` (squid), which this site does not read |
| Moonbeam | `https://moonbeam.api.onfinality.io/public` — `state_getMetadata`, `Timestamp::Now`. The official `rpc.api.moonbeam.network` was not reachable from this environment |
| Hyperbridge | `https://nexus.indexer.polytope.technology/` — see [hyperbridge.md](hyperbridge.md) |

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Snowbridge documentation](https://docs.snowbridge.network/)
- [Snowfork/snowbridge on GitHub](https://github.com/Snowfork/snowbridge)
- [Polkadot Wiki — bridges](https://wiki.polkadot.com/learn/learn-bridges/)
- [Wormhole NTT documentation](https://wormhole.com/docs/products/native-token-transfers/overview/)
- [Wormhole Guardian set and security model](https://wormhole.com/docs/protocol/security/)
- [Chainflip documentation](https://docs.chainflip.io/)
- [Interlay documentation](https://docs.interlay.io/)
- [Moonbeam cross-chain assets](https://docs.moonbeam.network/builders/interoperability/xcm/xc20/overview/)
- [Hyperbridge](https://hyperbridge.network/)
