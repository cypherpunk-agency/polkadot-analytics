# The research queue

Questions this project has opened and not yet answered.

**Why this file exists.** Almost every task here turns up questions it will not answer, and those
decay fast — an unrecorded question is either re-derived later at full cost, or silently dropped
along with whatever it would have unlocked. Keeping them in one place is what lets research run in
parallel with delivery instead of behind it.

A question that gets **answered** leaves here and goes into `docs/platform/`, `CLAUDE.md`'s facts
list, or `docs/decisions/` — see the `research-and-build` skill, §4. This file is only for what is
still open.

Two kinds, and they route differently:

- **BLOCKING** — something cannot be built correctly until this is settled. The "blocks" column
  says what is stalled.
- **OPENING** — nothing is stalled, but a capability becomes reachable if it is answered. These
  are the ones that get lost, and they are often where the leverage is.

Cost is a rough order of magnitude for the *research*, not the build.

---

## Blocking

| # | Question | Blocks | Cost |
|---|---|---|---|
| B1 | **What happened to Moonbeam, and is it still a Polkadot parachain?** Narrowed 2026-08-20, not closed. Para 2004 is absent from `Paras::ParaLifecycles`, `Paras::Heads` and `Paras::MostRecentContext` on two independent relay RPCs — and Moonbeam's own `Timestamp::Now` reads **2026-08-10T11:36:12Z**, with `ParachainSystem::LastRelayChainBlockNumber` 143,917 relay blocks behind the head. So it is not an indexing quirk: the chain stopped being included around 2026-08-10 and its RPC still answers. What is open is *why*, whether it is coming back, and what a per-chain series should do with it. | Netflows v2 (E3); any per-chain enumeration; the Wormhole MRL route in `docs/platform/bridges.md` | hours |
| B2 | **Is there a programmatic discriminator between Moonbeam's xcTOKENS and its Wormhole/Axelar assets?** (Two notes from 2026-08-20: the assets live in `EvmForeignAssets` = `pallet_moonbeam_foreign_assets`, index 114, as EVM ERC-20s — `pallet_assets` was removed outright, so this is an `eth_call` problem, not a storage-map problem. And see B1: the chain is not currently producing blocks.) xcDOT/xcUSDC are XCM reserve-backed from Asset Hub and are already counted in the sovereign decomposition; `USDC.wh` and friends are bridged directly onto Moonbeam and are genuinely new value. Without a reliable on-chain discriminator the "on Moonbeam, not yet in XCM" band cannot be built honestly. | E4 (Moonbeam module), and the decided Moonbeam band | hours |

## Opening

| # | Question | Would unlock | Cost |
|---|---|---|---|
| O1 | **Where does the union of ever-registered para ids come from?** `Paras::ParaLifecycles` is current-state-only. A *lifetime* series needs every para that ever existed, and the plan does not say where that set comes from. | Any historical per-chain series, incl. netflows over time | hours |
| O2 | **Does Dotlake index the Snowbridge corridor with usable asset detail?** If `bridgehub-polkadot → statemint` messages carry `asset_symbol`/`raw_amount`, Dotlake becomes a second opinion on bridged flow. CLAUDE.md's warnings about its value column apply in full. | A cross-check column on `/bridged/` | ~1h |
| O4 | **Build the date→block index, or take it from SQD?** Measured: ~21.7 RPC reads per day-point via a forward walk, versus ~1,068 MiB / ~812 requests / ~13 min for a full Asset Hub index from SQD, reusable by every other feature. | Every historical series. This is the gate on §8's whole direction | ~1 day |
| O5 | **Can gross bridged-in and bridged-out be separated from net?** Net is exact and self-checking. Gross needs each mint attributed to its causing XCM message and a check on whether the origin was Bridge Hub — doable with SQD extrinsic linkage, but it is inference and must be argued before it is drawn. | Directional bridge flow, rather than net change | ~1 day |
| O6 | **What is the right schema for the address registry?** Three claim kinds that must never share a field — structural (arithmetic, cannot be wrong), behavioural (names nobody), attributed (can publish a false claim about a real company). Provenance on every attributed row. Design work, not lookup. See plan §8.3. | The whole account-level direction | ~1 day, design |
| O7 | **How are exchange-shaped accounts identified from behaviour alone?** Fan-in/fan-out ratio, counterparty count, volume, periodicity. Must produce a *behavioural* claim that names nobody. `structuralLabel()` already removes `modl`/`sibl`/`para` noise for free. | "Netflows for major accounts" | ~1 day |
| O8 | **Is `hydration-evm`'s Aave oracle enough to price Asset Hub's bridged assets, and what fraction stays unpriced?** It prices Hydration's own reserves and reverts otherwise. The unpriced share decides whether `/bridged/` can have a USD-scaled comparison at all, or only per-row composition. | `/bridged/` layout; the priced/unpriced split | ~1h |
| O9 | **Should pricing become a shared service?** Three modules will want dollars and only `hydration-evm` can reach the oracle. `npm run check` forbids absolute URLs outside `server/sources/`, so a shared pricer in `server/lib/` cannot call Hydration — it is either a source others compose (a new pattern here) or a client-side join that loses the caveat. Architecture decision, not research. | E2/E4 and everything after | decision |
| O11 | **What are the units of Wormholescan's `volume` field?** `/api/v1/x-chain-activity/tops` returns an integer per route with no documented scale. Read as 1e8 USD it puts Hydration's whole July 2026 inbound at tens of dollars, which matches the individual NTT payloads seen but is small enough to want a second opinion. Message counts are unambiguous; the volume is not. | Any Wormhole volume figure on the bridges page | ~1h |
| O12 | **What is a defensible "TVL" for Chainflip, and can it be built key-free?** `archive.mainnet.chainflip.io` is open with 245 methods, ~60 of them `cf_*`, but no published volume or TVL endpoint was found. The vaults are on seven chains and the protocol is a flow, not a stock, so the definition is the hard part, not the fetch. | A Chainflip row on any bridge comparison | ~1 day |
| O13 | **How stale is too stale, and where does the check live?** Moonbeam is 10 days behind and Interlay 24 (2026-08-20), while both RPCs answer normally. `Timestamp::Now` against the wall clock is a two-line probe — the open question is whether it belongs in every source module, in the transport, or on the page as a data note. | Every per-chain figure this site publishes | ~1h, design |
| O10 | **Is 2% the right `faint` threshold** in `segmentedRows`? Chosen by eye against five test rows, not measured against real data. | Nothing — but it is an unexamined constant on a live chart | minutes |

---

## Recently closed

Kept briefly so the same question is not re-opened. Move the finding to its permanent home, then
delete the row.

| Question | Answer | Landed in |
|---|---|---|
| B3 — which global-consensus sovereign prefix does Asset Hub use? | **Neither, for Ethereum.** `ExternalConsensusLocationsConverterFor` special-cases Ethereum onto `(b"ethereum-chain", chain_id: u64)`; `glblcnsnss/prchn_` (plain u32 para id) covers a parachain behind a foreign consensus and `glblcnsnss` the rest. **source-verified** + **verified live**: Ethereum's reserve holds 20,679.76 DOT, Kusama Asset Hub's 407,487.13 DOT, both `glblcnsnss` derivations for Ethereum have no account. | CLAUDE.md facts; `docs/platform/bridges.md` |
| B4 — what are the plausibility bounds for the iBTC decimals canary? | Chain-wide issuance is **2.118 iBTC** (`Tokens::TotalIssuance(Token(IBTC))`, **verified live** 2026-08-20) and the constant is `IBTC("interBTC", 8) = 1` (**source-verified**). A decimals error is a factor of 10ⁿ, not a factor of two, so the band can be wide and still catch the only error it needs to: reject anything in the thousands of BTC. | CLAUDE.md facts; `docs/platform/bridges.md` |
| O3 — is Hydration's `Signet` pallet actually used? | **No, and it cannot be.** Its only storage besides the version is `SignetConfig`, documented in metadata as "if `None`, the pallet has not been configured yet and cannot be used" — and it read `null` at block 13,702,604 on 2026-08-20 (**verified live**), storage version 0. Present, unconfigured, inoperative. Re-read the key before repeating it. | `docs/platform/bridges.md` |
| Is `ForeignAssets` `parents == 2` a real discriminator or a coincidence? | Real. Asset Hub's filter includes `StartsWithExplicitGlobalConsensus`, so the runtime refuses to create a `parents:2` key naming Polkadot's own consensus. **source-verified** | plan §7.3 |
| Does netflows-live need Wave C? | No. ~5 requests against the existing TTL cache. The store buys *history*, not the current number. | plan §7.4, C6 annotation |
| Store first, or snapshots first? | Snapshots first, shaped for the store — history is the point, so the store follows immediately. | plan §8.5 |
| Was a live netflows chart ever planned? | Yes — `plan.md:241` C6, plus three research docs. Never reversed; it was sequenced last, behind Wave C. | plan §7.4 |
