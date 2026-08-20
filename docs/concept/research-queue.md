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
| B1 | **Why is para 2004 (Moonbeam) absent from the relay's `Paras::ParaLifecycles`?** Verified live 2026-08-20: the map returns 89 ids and 2004 is not among them, though 1000/1001/1002/1004/1005 are. Moonbeam is on the *existing* netflows chart, so a live v2 built off today's para set silently drops a chain the archive shows. | Netflows v2 (E3); any per-chain enumeration | hours |
| B2 | **Is there a programmatic discriminator between Moonbeam's xcTOKENS and its Wormhole/Axelar assets?** xcDOT/xcUSDC are XCM reserve-backed from Asset Hub and are already counted in the sovereign decomposition; `USDC.wh` and friends are bridged directly onto Moonbeam and are genuinely new value. Without a reliable on-chain discriminator the "on Moonbeam, not yet in XCM" band cannot be built honestly. | E4 (Moonbeam module), and the decided Moonbeam band | hours |
| B3 | **Which global-consensus sovereign prefix does Asset Hub actually use** — `glblcnsnss_` (older `GlobalConsensusConvertsFor`) or `glblcnsnss` (current `ExternalConsensusLocationsConverterFor`)? Both derive valid-looking accounts. Reading the wrong one returns `null`, which renders as "the Ethereum bridge holds nothing". Derive both, read both, keep the one with a balance. | Bridge-side reconciliation on `/bridged/` | minutes |
| B4 | **What are the plausibility bounds for the iBTC decimals canary?** iBTC's 8 decimals are a compile-time Rust constant, unreadable from any storage item — the one place this repo cannot read decimals from a registry. It needs a canary instead, and the band has to be defensible. | E4 (Interlay module) | minutes |

## Opening

| # | Question | Would unlock | Cost |
|---|---|---|---|
| O1 | **Where does the union of ever-registered para ids come from?** `Paras::ParaLifecycles` is current-state-only. A *lifetime* series needs every para that ever existed, and the plan does not say where that set comes from. | Any historical per-chain series, incl. netflows over time | hours |
| O2 | **Does Dotlake index the Snowbridge corridor with usable asset detail?** If `bridgehub-polkadot → statemint` messages carry `asset_symbol`/`raw_amount`, Dotlake becomes a second opinion on bridged flow. CLAUDE.md's warnings about its value column apply in full. | A cross-check column on `/bridged/` | ~1h |
| O3 | **Is Hydration's `Signet` pallet actually used?** It is a CAIP-2 remote-signing service, **not** a bridge — the only open question is whether it has non-empty storage. Report emptiness as emptiness. | Correctness of the bridge inventory; possibly a new capability | minutes |
| O4 | **Build the date→block index, or take it from SQD?** Measured: ~21.7 RPC reads per day-point via a forward walk, versus ~1,068 MiB / ~812 requests / ~13 min for a full Asset Hub index from SQD, reusable by every other feature. | Every historical series. This is the gate on §8's whole direction | ~1 day |
| O5 | **Can gross bridged-in and bridged-out be separated from net?** Net is exact and self-checking. Gross needs each mint attributed to its causing XCM message and a check on whether the origin was Bridge Hub — doable with SQD extrinsic linkage, but it is inference and must be argued before it is drawn. | Directional bridge flow, rather than net change | ~1 day |
| O6 | **What is the right schema for the address registry?** Three claim kinds that must never share a field — structural (arithmetic, cannot be wrong), behavioural (names nobody), attributed (can publish a false claim about a real company). Provenance on every attributed row. Design work, not lookup. See plan §8.3. | The whole account-level direction | ~1 day, design |
| O7 | **How are exchange-shaped accounts identified from behaviour alone?** Fan-in/fan-out ratio, counterparty count, volume, periodicity. Must produce a *behavioural* claim that names nobody. `structuralLabel()` already removes `modl`/`sibl`/`para` noise for free. | "Netflows for major accounts" | ~1 day |
| O8 | **Is `hydration-evm`'s Aave oracle enough to price Asset Hub's bridged assets, and what fraction stays unpriced?** It prices Hydration's own reserves and reverts otherwise. The unpriced share decides whether `/bridged/` can have a USD-scaled comparison at all, or only per-row composition. | `/bridged/` layout; the priced/unpriced split | ~1h |
| O9 | **Should pricing become a shared service?** Three modules will want dollars and only `hydration-evm` can reach the oracle. `npm run check` forbids absolute URLs outside `server/sources/`, so a shared pricer in `server/lib/` cannot call Hydration — it is either a source others compose (a new pattern here) or a client-side join that loses the caveat. Architecture decision, not research. | E2/E4 and everything after | decision |
| O10 | **Is 2% the right `faint` threshold** in `segmentedRows`? Chosen by eye against five test rows, not measured against real data. | Nothing — but it is an unexamined constant on a live chart | minutes |

---

## Recently closed

Kept briefly so the same question is not re-opened. Move the finding to its permanent home, then
delete the row.

| Question | Answer | Landed in |
|---|---|---|
| Is `ForeignAssets` `parents == 2` a real discriminator or a coincidence? | Real. Asset Hub's filter includes `StartsWithExplicitGlobalConsensus`, so the runtime refuses to create a `parents:2` key naming Polkadot's own consensus. **source-verified** | plan §7.3 |
| Does netflows-live need Wave C? | No. ~5 requests against the existing TTL cache. The store buys *history*, not the current number. | plan §7.4, C6 annotation |
| Store first, or snapshots first? | Snapshots first, shaped for the store — history is the point, so the store follows immediately. | plan §8.5 |
| Was a live netflows chart ever planned? | Yes — `plan.md:241` C6, plus three research docs. Never reversed; it was sequenced last, behind Wave C. | plan §7.4 |
