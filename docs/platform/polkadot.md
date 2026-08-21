# Polkadot: the relay chain and parachain model

Polkadot is a network of independent blockchains ("parachains") that outsource their security to a
single shared validator set. The relay chain does not execute application logic; it verifies that
someone else's block was executed correctly, and it guarantees that the data needed to check that
claim was actually published. Since the Agile Coretime upgrade, access to that verification service
is bought as a commodity called *coretime* rather than won in a two-year slot auction, and since the
Asset Hub migration completed in November 2025 the relay chain no longer holds balances, staking or
governance at all.

Everything below is stated as of **2026-08-19**. Where a claim is a projection or where we could not
verify it against a primary source, it is marked.

---

## What the relay chain actually does

The relay chain has a deliberately small job. It runs no user-facing pallets to speak of any more.
What it runs is the *parachains protocol*:

1. **Backing.** Validators are split into small groups. Each group is assigned to a *core*. A
   collator for the parachain occupying that core hands the group a candidate parablock plus the
   proof-of-validity (PoV) — a Merkle witness of every piece of state the block read. The group
   re-executes the parachain's runtime against the PoV and signs a statement that it is valid.
2. **Availability.** The PoV is erasure-coded and distributed across the whole validator set. Each
   validator holds a chunk and signs that it holds it. Once enough chunks are attested, the candidate
   is *available*: the network can reconstruct the PoV even if the collator vanishes. This is the
   step that makes the next one possible.
3. **Approval and disputes.** After inclusion, a randomly-chosen subset of validators is required to
   fetch the PoV and re-check it. Any validator that disagrees can raise a *dispute*, which pulls in
   the entire validator set to adjudicate. The losing side is slashed. This is where the security
   actually comes from — not from the backing group, which is small enough to be corrupted, but from
   the threat that anyone can re-check and that being caught costs your stake.

The relay chain finalises with GRANDPA and produces blocks with BABE, at a nominal 6-second block
time. As of 2026-08-19 the active validator set (`Session::Validators` on the relay chain) contains
**600** validators — verified live.

Because the relay chain only ever sees state *roots* and PoVs, adding a parachain costs it almost
nothing in storage. What it costs is validator attention, and validator attention is exactly what a
core represents.

## Cores, concretely

A **core** is a scheduling slot in the parachains protocol: one backing group's attention for one
relay-chain block. If a parachain occupies one core continuously, it gets one parablock validated
every relay chain block — nominally one parablock per 6 seconds.

That "one block per 6 seconds" used to be "one block per 12 seconds" because of *synchronous
backing*: a collator had to wait for the relay parent to be finalised before building on it.
**Asynchronous backing** removed that constraint by letting collators build on unincluded ancestors,
which is what took parachains from 12s to 6s and raised the PoV size limit. Asynchronous backing is
live on Polkadot.

**Elastic scaling** is the next step: assign *N* cores to one parachain and it can have *N*
parablocks validated per relay chain block. Three cores means a 2-second block time; twelve cores
means 500ms, in principle. The parachain's collators must actually be able to author that fast and
the chain must be built to chain candidates together, so this is not free — it is capacity you buy
and then have to use. Elastic scaling landed as part of the "Polkadot 2.0" completion in 2025
(SDK release 2509, October 2025).

The failure mode worth naming: **a core is not a transaction-throughput unit.** It is a
validation-bandwidth unit. Two chains on one core each get one block per 6 seconds regardless of how
many transactions those blocks contain, and a chain with 3 cores that only authors one block per
relay block is paying for two idle cores. Analytics that treat "cores purchased" as a demand signal
without checking utilisation will overstate demand.

### Live core numbers

Parity's public Dotlake API exposes daily core utilisation. Verified live on 2026-08-19 from
`https://api.data.parity.io/api/coretime-utilization`:

| Date | cores offered | system cores | cores available | avg cores used | utilisation |
|---|---|---|---|---|---|
| 2026-01-01 | 72 | 5 | 77 | 25.7 | 33.3% |
| 2026-08-16 | 81 | 5 | 86 | 52.7 | 61.3% |
| 2026-08-17 | 81 | 5 | 86 | 69.7 | 81.0% |
| 2026-08-18 | 81 | 5 | 86 | 51.5 | 59.9% |

`system_cores` are the cores governance assigns to system chains outside the market;
`cores_offered` is what the coretime sale makes available. The jump from ~26 to ~50–70 average cores
used over 2026 is elastic scaling being taken up, not new parachains onboarding — the two look
identical in a "cores used" chart and only `included_candidates` per chain separates them.

## Agile Coretime, and what replaced the auctions

Until 2024, getting a parachain slot meant winning a **candle auction** and locking DOT in a crowdloan
for a lease of up to 96 weeks. That model had two problems. It priced a two-year commitment when most
teams wanted to find out in a month whether anyone would use their chain, and it made blockspace a
capital-allocation game rather than a purchase.

Agile Coretime replaced it. Coretime is sold on the **Coretime Chain** (para id 1005) in two forms:

| | Bulk coretime | On-demand coretime |
|---|---|---|
| Unit | A *region*: one core for a 28-day period | A single parablock's validation |
| Bought | In a periodic sale, priced by a Dutch-style mechanism | Per-block, at a price that moves with congestion |
| Held as | An NFT-like region that can be split, interlaced, transferred, or assigned to a para id | Nothing; you place an order and it is served |
| Suits | A chain with steady traffic | A chain with sporadic traffic, or a test deployment |

Regions are first-class objects. You can **split** a region in time, **interlace** it (take every
other block of a core), **partition** it, and **assign** it to a task, with an option to make the
assignment *final* (irrevocable, which is what lets a chain credibly say it has coretime through a
date). Holders of an existing lease were migrated onto renewal-priced bulk coretime rather than being
cut off.

The important consequence for analytics: **a parachain is no longer a permanent identity with a
lease end date.** It is a `ParaId` that may or may not have a core assigned in any given period. A
chain can go from bulk to on-demand to nothing and back. Any dashboard that computes "active
parachains" needs to define whether it means "has a core assigned", "produced a block today", or
"has a registered head", and those three numbers differ.

### `ParaLifecycles` says `Parathread` for almost everything, and it is not a description

⚠️ **`Paras::ParaLifecycles` is a registration state machine, not an account of how a chain runs.**
*Verified live 2026-08-21* on `https://rpc.polkadot.io`, finalized head **#32,648,511**, by sweeping
the whole prefix and decoding every value:

```
89 keys · 0x01 Parathread ×86 · 0x02 Parachain ×3 → para 1002, 1004, 1005
para 1000 (Asset Hub) -> Parathread
```

So Asset Hub, Collectives, Hydration, Acala, Bifrost and eighty-two others read **`Parathread`**,
and the only three ids reading `Parachain` are **Bridge Hub (1002), People Chain (1004) and Coretime
Chain (1005)**.

That is the coretime model showing through the old vocabulary. `Parachain` in this map means "holds
a lease slot in the sense the pre-coretime registrar understood"; under Agile Coretime a chain
instead has a **broker-assigned core**, which the registrar records as `Parathread`. A chain reading
`Parathread` may be producing a block every 6 seconds on a bulk region it owns outright — and the
three that read `Parachain` are not the three busiest chains, they are three system chains whose
registration happens to have been left in the older state.

So the value is safe to *filter* on only if you know which question you are asking, and it is never
safe to *print*. Rendered unqualified in a legend or a table it calls Hydration a parathread, which
is wrong in the ordinary meaning of the word and looks authoritative because it came off the chain.
Ask `Broker::Workplan` on the Coretime Chain, or `Paras::Heads` deltas, if the question is whether a
chain is running.

The values themselves are a seven-variant enum — `Onboarding`, `Parathread`, `Parachain`,
`UpgradingParathread`, `DowngradingParachain`, `OffboardingParathread`, `OffboardingParachain` — and
the byte encodings are written out in
[moonbeam.md](moonbeam.md#paralifecycle-byte-values), which needed them to prove an absence rather
than misread one.

**And the map is not the roster.** Four enumerations of "which parachains exist" disagree — 89 from
`ParaLifecycles`, 123 from `Registrar::Paras`, 90 from `Paras::Heads` — and none of them is
complete: four chains hold sovereign DOT while appearing in no relay enumeration at all. The
reconciliation, with the counts and the union, is in
[asset-hub.md](asset-hub.md#four-enumerations-and-none-of-them-is-complete).

## System chains

System chains are parachains whose runtimes are governed by Polkadot's own governance and whose
coretime is assigned by governance rather than bought. They exist to move work off the relay chain so
the relay chain can stay small.

| Chain | Para id | Job |
|---|---|---|
| **Asset Hub** | 1000 | Balances, transfers, staking, governance, assets, NFTs, and (since Jan 2026) smart contracts. See [asset-hub.md](asset-hub.md). |
| **Collectives** | 1001 | On-chain bodies — most importantly the Technical Fellowship, which authors and ranks runtime upgrades. |
| **Bridge Hub** | 1002 | Trustless bridges to external consensus systems, notably the Ethereum bridge (Snowbridge) and the Polkadot↔Kusama bridge. |
| **People Chain** | 1004 | The identity pallet and its data. See [people-chain.md](people-chain.md). |
| **Coretime Chain** | 1005 | The coretime market: sales, regions, renewals, assignment. |

Kusama has an analogous set plus **Encointer**, which does proof-of-personhood by physical key-signing
ceremonies. The **Polkadot Bulletin Chain** is a further system chain for content-addressed data
storage; as of 2026-08-19 the deployment we can reach is a devnet, not a Polkadot-secured production
chain — see [bulletin.md](bulletin.md).

Note for anyone parsing chain names out of indexers: **Asset Hub's on-chain `specName` is still
`statemint`**, verified live 2026-08-19 (specVersion 2003002). Parity's Dotlake API and several
Subsquid archives therefore label Asset Hub traffic `statemint` and Hydration `hydradx`. Getting this
wrong means silently dropping the busiest route on the network — over a rolling 7-day window the top
Polkadot XCM value route is `statemint → hydradx`.

## The Asset Hub migration

Between October and November 2025, Polkadot moved balances, staking and governance (including
treasury) off the relay chain onto Asset Hub. Kusama went on **2025-10-07**, Polkadot on
**2025-11-04**. It was done as an atomic state migration under OpenGov, not a hard fork.

This is the single most consequential fact for anyone writing historical queries. **Before November
2025, `Balances`, `Staking`, `Referenda` and `Treasury` events are on the relay chain. After, they are
on Asset Hub.** A query that only reads one of the two chains will produce a series that falls off a
cliff or starts from zero in November 2025, and nothing about the data will announce that. Details in
[asset-hub.md](asset-hub.md).

## JAM, as the announced direction

JAM (Join-Accumulate Machine) is the proposed replacement for the relay chain's parachains protocol.
Rather than the relay chain running a fixed "validate a parachain block" function, JAM exposes a
general service model: *refine* (do work in-core, on a PVM/RISC-V machine, with the result made
available) and *accumulate* (fold the result into shared on-chain state). A parachain becomes one
service among many, implemented as a JAM service rather than being special-cased in the protocol.

Status as we could verify it (all of this is roadmap, not shipped mainnet):

- The **Gray Paper** (the JAM specification) reached version 0.8 in late 2025, with a final pre-audit
  draft expected in early 2026.
- The **JAM Implementers Prize** attracted around 43 teams; roughly 15 Milestone 1 submissions had
  been made by early 2026, against a Milestone 1 conformance suite.
- A **public JAM testnet** launched in January 2026.
- A governance referendum to adopt JAM on mainnet is widely reported as expected in **H2 2026**.
  *We could not verify from a primary source that such a referendum has been tabled as of
  2026-08-19; treat any statement that JAM is live on Polkadot mainnet as false unless you have
  checked the relay chain runtime yourself.*

The practical reading: Polkadot today is the parachains protocol with Agile Coretime and elastic
scaling. JAM is a future runtime for the same validator set and the same DOT. Nothing in this
repository's data model depends on JAM, and nothing should be written as though it has happened.

## How the pieces fit for an analyst

- **The relay chain** is where you read validator sets, sessions, disputes, and para inclusion. It is
  *not* where you read balances or staking any more.
- **Asset Hub** is where accounts, transfers, staking, governance, assets and contracts live.
- **The Coretime Chain** is where you read who bought what blockspace and at what price.
- **Every other parachain** is its own chain with its own indexer, connected to the rest only by
  [XCM](xcm.md).

There is no single node that can answer "what happened on Polkadot today". Any honest dashboard is a
join across chains, and the join key is usually an XCM message id or a sovereign account.

---

## Where we read this from

| What | Endpoint / storage | Notes |
|---|---|---|
| Active validator set | Relay chain `Session::Validators` via `https://rpc.polkadot.io` | Returns `Vec<AccountId32>`; length is the validator count (600 on 2026-08-19) |
| Para inclusion / backing | Relay chain `ParaInclusion` events, `Paras::Heads` | Per-block candidate inclusion |
| Core assignment | Coretime Chain (`para id 1005`) `Broker` pallet: `Regions`, `Workplan`, `SaleInfo`, `Status` | Bulk sale state and region ownership |
| On-demand orders | Relay chain `OnDemandAssignmentProvider` (queue and spot price) | Spot price moves with queue depth |
| Core utilisation, aggregated | `https://api.data.parity.io/api/coretime-utilization` | Public, anonymous, no key. Daily rows per relay chain |
| XCM traffic summary | `https://api.data.parity.io/api/xcm-summary`, `/api/xcm-top-routes`, `/api/xcm-daily-stats` | Chain names use `specName` (`statemint`, `hydradx`) |
| Asset Hub runtime version | `state_getRuntimeVersion` on `https://polkadot-asset-hub-rpc.polkadot.io` | Confirms `specName: statemint` |

All of these are public and unauthenticated. This repository needs no API keys.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Polkadot Wiki — Agile Coretime](https://wiki.polkadot.com/learn/learn-agile-coretime/)
- [Polkadot Wiki — Parallel Computation (Elastic Scaling)](https://wiki.polkadot.com/learn/learn-elastic-scaling/)
- [Polkadot Wiki — System Chains](https://wiki.polkadot.com/learn/learn-system-chains/)
- [Polkadot Wiki — Parachains](https://wiki.polkadot.com/learn/learn-parachains/)
- [Polkadot Developer Docs — Elastic Scaling](https://docs.polkadot.com/reference/parachains/consensus/elastic-scaling/)
- [Polkadot Developer Docs — Polkadot Hub overview](https://docs.polkadot.com/reference/polkadot-hub/)
- [The Asset Hub Migration — a primer (HackMD)](https://hackmd.io/@seadanda/B1QIVXrwJg)
- [JAM Implementers Prize write-up](https://polkadot.cloud/blog/en/polkadot-jam-implementers-prize)
