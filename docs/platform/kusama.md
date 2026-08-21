# Kusama

Kusama is not a testnet and it is not a smaller Polkadot. For the purposes of this repository it is
a **second network with the same shape and different constants**, and the constants are exactly
where a reader gets hurt: a KSM figure divided by Polkadot's divisor is 100× too large and renders
perfectly.

Everything below was **verified live on 2026-08-21** against anonymous public HTTPS JSON-RPC unless
it says otherwise. Endpoints are named on every claim. What this site reads Kusama for is one
measurement — parachain sovereign balances, every UTC day — through the same module that reads
Polkadot's, `server/sources/asset-hub.mjs`; see
[decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md).

## The two endpoints, and their identity checked rather than assumed

| host | `system_chain` | `system_name` | `system_version` | `system_properties` |
|---|---|---|---|---|
| `https://kusama-rpc.polkadot.io` | `Kusama` | `Parity Polkadot` | `1.24.1-8ae9775dc43` | `{ss58Format: 2, tokenDecimals: 12, tokenSymbol: "KSM"}` |
| `https://kusama-asset-hub-rpc.polkadot.io` | `Kusama Asset Hub` | `polkadot-parachain` | `1.24.1-8ae9775dc43` | `{ss58Format: 2, tokenDecimals: 12, tokenSymbol: "KSM"}` |

Same runtime release as the two Polkadot hosts, same operator. Liveness at 2026-08-21T08:05Z
(`chain_getFinalizedHead`, then `Timestamp::Now` at that hash):

```
kusama relay    #34,901,623   2026-08-21T08:05:30.000Z    0.5 min behind the wall clock
kusama AH       #20,476,826   2026-08-21T08:04:48.000Z    1.2 min behind
polkadot relay  #32,648,433   2026-08-21T08:05:30.001Z    0.6 min behind
polkadot AH     #19,714,496   2026-08-21T08:05:12.000Z    0.9 min behind
```

Do not skip that check because the hostname looks right. A parachain can answer every call and
still be weeks stale — see the Moonbeam and Interlay cases in
[data-sources.md](data-sources.md) — and `system_properties` is also the only thing standing
between a Kusama balance and Polkadot's divisor.

## KSM is 12 decimals; DOT is 10. SS58 is 2, not 0.

Both Kusama hosts report `tokenDecimals: 12`. A netflows series that divides KSM planck by `1e10`
renders **every Kusama figure 100× too large** and looks entirely plausible — Karura at 4.0 M KSM
instead of 40 k, or a 2022 peak of 17.0 M KSM instead of 169,884.

This is not hypothetical: `src/pages/netflows/series.js` held a module constant `PLANCK = 1e10`
until 2026-08-21. It now takes the divisor per network, `units(raw, decimals)` throws without one,
and `netflowsHeads` in `server/sources/asset-hub.mjs` asserts `token` and `decimals` against
`system_properties` on every read rather than trusting the table.

SS58 prefix is **2** on both Kusama chains. A Kusama sovereign account rendered at prefix 0 is a
valid-looking *Polkadot* address for a Kusama account, and nothing about it looks wrong.

## Archive depth: both are full archives, and Kusama Asset Hub has a clockless prefix

The Kusama relay serves state to genesis — `#1` is **2019-11-28T17:27:54.000Z**, and every probe
from `#1` to `#500,000` answers `Timestamp::Now`.

Kusama Asset Hub (Statemine) is the mirror of the Polkadot case. It **has state but no clock below
block #66,687**, bisected 2026-08-21:

```
#66,685   hash ok   Timestamp::Now = null    state_getRuntimeVersion = statemine 1
#66,686   hash ok   Timestamp::Now = null    state_getRuntimeVersion = statemine 1
#66,687   hash ok   2021-06-03T15:36:00.509Z
#66,688   hash ok   2021-06-03T15:36:48.350Z
#66,689   hash ok   2021-06-03T15:45:42.623Z
```

That is Statemine's pre-launch period, not pruning — but it is indistinguishable from a pruned
archive, and a pruned balance read answers `null`, which is indistinguishable from "this account
holds nothing". Guard on `Timestamp::Now`, exactly as the Polkadot path does
([asset-hub.md](asset-hub.md)).

**Consequence for the series floor.** The first UTC day whose Kusama Asset Hub close is readable is
2021-06-03, so **2021-07 is the first whole month** the store can hold, and that is where the
Kusama series begins (`firstMonth` in `NETFLOW_NETWORKS`). It coincides exactly with the 2023
archive's first day, 2021-07-01 — a coincidence worth stating rather than a design choice.

## The Kusama Asset Hub Migration is 2025-10-07, and that is now bisected rather than transcribed

`asset-hub.md` and `polkadot.md` both carried **2025-10-07** as a transcription that had never been
re-derived. It is correct. Bisected against the Kusama relay chain on 2026-08-21, the same way
Polkadot's 2025-11-04 was.

Day granularity — the sum of the `para` legs of 15 Kusama parachains at each UTC day's last block:

```
2025-10-05   relay #30,401,450    90,436.5 KSM on the relay    14,192.4 on Asset Hub
2025-10-06   relay #30,415,659    90,264.9                     14,228.1
2025-10-07   relay #30,429,843     1,210.0                    102,580.8   ← handover complete
2025-10-08   relay #30,444,021     1,210.1                    102,793.3
```

Block granularity — Karura (para 2000), `para` account on the Kusama relay:

```
#30,424,404   2025-10-07T14:47:42.000Z    40,394.8 KSM
#30,424,405   2025-10-07T14:47:48.000Z    40,394.8 KSM
#30,424,406   2025-10-07T14:47:54.001Z       160.0 KSM   ← Karura's leg moves here
#30,424,407   2025-10-07T14:48:00.000Z       160.0 KSM
```

**It was progressive, not atomic** — the same shape as Polkadot's. At #30,424,406, with Karura
already down to 160 KSM, Bifrost (2001) still held 19,525.2 KSM on the relay, Kintsugi (2092)
6,481.3, Basilisk (2090) 2,528.5 and Picasso (2087) 2,470.8, while Moonriver (2023), Heiko (2085)
and Mangata (2110) were already at 40–90 KSM. The whole handover completes inside 2025-10-07.

**Method note.** The migration date is not readable from any storage item. It is established by
bisecting a large sovereign account's balance and confirming the collapse is not a single transfer.
Anyone re-deriving it should bisect, not transcribe.

## The post-migration residue on the relay is a round number plus the existential deposit

After the migration each Kusama parachain keeps a small, near-constant `para` balance on the relay.
Read exactly, at relay #30,429,843 (the close of 2025-10-07), every one of them is a round number
of KSM plus **0.000333333333** — which is the Kusama relay chain's existential deposit, already
recorded in [asset-hub.md](asset-hub.md):

```
para 1000   150.000333333333      para 2087    60.000333333333
para 2000   160.000333333333      para 2090   130.000333333333
para 2001   155.000333333333      para 2092    70.000333333333
para 2007   135.000333333333      para 2110    40.000333333333
para 2023    90.000333333333      para 2125     0.000333333333
para 2085    60.000333333333      para 2124    20.000333333333
```

So the residue is "a round retained amount, plus exactly one existential deposit" — not dust, and
not an accident. The fifteen legs sampled sum to ~1,178 KSM on 2026-08-20 against ~76,121 KSM on
Asset Hub. **Reading only the relay leg after 2025-10-07 therefore returns a few hundred KSM per
chain and looks entirely reasonable.** What decides the *round* part is not established — it is
research queue O53, and Polkadot's equivalent (~27,622 DOT in total) has not been decomposed at
all.

## The 2023 archive, cross-checked against the chain

`src/data/netflows.json` carries a 2023 Polkalytics dataset for both networks. Over the full Kusama
overlap — **2021-07-01 → 2023-03-12, 620 days, 8 chains, 3,515 chain-days** — against the `para`
leg of this series (measured 2026-08-21):

| | pairs | median deviation | largest absolute gap | chain-days beyond the file's 0.005 KSM quantum |
|---|---|---|---|---|
| everything except the archive's final day | 3,507 | **8.27 × 10⁻⁸** | 1.962 KSM | **4** |
| 2023-03-12, the archive's final day | 8 | 9.77 × 10⁻⁴ | 1,140.06 KSM | 8 |

The four real disagreements outside the final day, named rather than summarised:

```
2022-07-21   Heiko     archive  9,035.5300   read  9,037.492347   gap 1.962347 KSM  (0.0217%)
2022-03-14   Karura    archive 68,666.3400   read 68,667.342838   gap 1.002838 KSM  (0.0015%)
2023-02-21   Heiko     archive 13,685.1500   read 13,684.149937   gap 1.000063 KSM  (0.0073%)
2021-07-23   Karura    archive 19,322.2200   read 19,322.318691   gap 0.098691 KSM  (0.0005%)
```

Three of the four are within a hundredth of a *whole* KSM, in both directions, which is the shape of
a transfer landing between the archive's last sample of that day and the day's actual last block —
the file's own resampling caveat, visible as four rows out of 3,507. **Not established:** whether a
1 KSM transfer is actually present in those blocks. That is a bisection away and nobody has done it.

**The final day repeats the Polkadot finding exactly.** All 8 chains disagree on 2023-03-12, worst
Heiko by 1,140.06 KSM (7.22 %), then Karura 113.39, Moonriver 37.37, Bifrost 26.45, Basilisk 21.18.
The archive's captures stop mid-day, so its last row is the last observation it happened to take
rather than that UTC day's close — the same conclusion Polkadot's 2023-04-08 produced, now
independently reproduced on a different network and a different final day.

### The verdict is set by the smallest balance, not by whether the readings agree

The archive stores every balance **rounded half-up to two decimal places** on both networks
(`scripts/build-netflows-dataset.mjs`, confirmed by scanning the file: max 2 dp across all 3,520
Kusama and 2,443 Polkadot values). So a value can be out by up to 0.005 tokens whatever it is —
which is 0.25 % of Polkadot's smallest overlapping balance (1.23 DOT) and **7.3 % of Kusama's
(0.03 KSM)**.

Two readings that agree to the planck therefore score "agrees" on Polkadot and "disagrees on 35 of
115 chain-days" on Kusama, and the only thing that changed was the denominator. `crossCheck` in
`src/pages/netflows/series.js` now takes its verdict on the **absolute** gap against
`ARCHIVE_QUANTUM = 0.005` and reports the relative figure beside it.

The quantum is the right bound, and Polkadot is what measures it. Re-running the comparison over
the 2,434 Polkadot chain-days (2022-02-02 → 2023-04-07, i.e. excluding the archive's partial final
day):

```
median deviation        4.036e-9        ← reproduces the 4.0e-9 already recorded
largest ABSOLUTE gap    0.004999620 DOT
chain-days beyond 0.005 DOT:  0  (of 2,434)
```

**Not one** Polkadot chain-day exceeds the archive's own quantum, and the largest gap anywhere lands
at 99.99 % of it. That is as strong a confirmation as the data can give that 0.005 is the right
bound, and that the 91 Polkadot chain-days once reported as "over 0.01 %" were never disagreements.
On Kusama the same test finds **4** genuine exceedances out of 3,507, which is the number worth
chasing.

### A second, independent reconciliation: the peaks

The archive stores two peaks per chain — `peak` (the highest value in its raw captures) and
`dailyPeak` (the highest daily close), with `clipped` recording the gap between them. `dailyPeak` is
the one this series is comparable to, and over the archive's own window it reproduces:

```
                archive dailyPeak     this series (both legs)
Karura                    168,214     168,214    identical
Heiko                      72,007      72,007    identical
Kintsugi                   54,258      54,258    identical
Moonriver                 152,961     152,966    +5, the `sibl` leg the archive never read
Bifrost                   120,288     120,296    +8,  "
```

The three that match to the token are chains whose Statemine `sibl` account was empty at their peak;
the two that exceed it do so by exactly the size of the leg the 2023 study could not see. That is a
stronger check than the day-by-day deviation, because it tests the peak-finding and the leg
summation as well as the balances. Basilisk's archive line is `clipped 9.76 %` — the largest on
either network — so the page's "the archive's own lines understate their peak" notice fires on the
Kusama toggle.

### The study's missing leg is far bigger on Kusama than on Polkadot

The 2023 study read `para` on the relay chain only. On Polkadot that omission touches 883 of 2,442
chain-days at up to **1.12 %** of a chain's total. On Kusama the same measurement gives **1,714 of
3,515 chain-days (49 %) and a maximum share of 96.77 %** — Picasso on 2022-12-23 held 66.11 KSM on
the Kusama relay and **1,981.38 KSM in its `sibl` account on Statemine**.

So on Kusama the single-leg measurement is not a rounding footnote; for some chain-days it misses
almost the whole holding. Anyone quoting the 2023 KSM figures as a chain's sovereign balance is
quoting one of two accounts, and on Kusama that is sometimes the small one.

### The archive's addresses reproduce, on both networks

All **16** `address` values in `src/data/netflows.json` (8 Kusama, 8 Polkadot) reproduce exactly from
`sovereignAccount(paraId, { on: 'relay' })` at that network's SS58 prefix — 2 for Kusama, 0 for
Polkadot (verified 2026-08-21). That is a third independent check of the derivation, after
[xcm.md](xcm.md)'s live Hydration read and the two fixtures asserted at import in
`src/core/topology.js`.

It also confirms the id↔name pairing for eight Kusama rows the registry currently marks
`evidence: 'assumed'`: Karura 2000, Bifrost 2001, Moonriver 2023, Heiko 2085, Picasso 2087, Basilisk
2090, Kintsugi 2092, Mangata 2110.

**Not done, and worth doing:** `DERIVATION_FIXTURES` in `src/core/topology.js` has no Kusama entry,
so the SS58-prefix half of the derivation is the one half not asserted at import. Karura's relay
sovereign at prefix 2 is `F7fq1jSNVTPfJmaHaXCMtatT1EZefCUsa7rRiQVNR5efcahG` — hex
`0x70617261d0070000000000000000000000000000000000000000000000000000`, *the same bytes as* Polkadot's
Acala row, which is the point: only the prefix differs, and only the prefix is untested.

## Picasso is stranded, and the series shows it

Picasso (Kusama para 2087) holds **4,431.4 KSM** in its `sibl` account on Kusama Asset Hub, flat from
2025-11-01 through 2026-08-20 (verified live). Its chain has been dead ~310 days and cannot send the
XCM that would move it. A dead chain in this series is information, not an error — and it is the
concrete case behind research queue O22.

## What it costs to read

`asset-hub/netflows-daily`, measured 2026-08-21 by counting real `fetch` calls through the job
handler with the boundary hint carried across batches exactly as the engine carries it:

```
kusama    2026-06   30 days   163 requests   5.43 per day   0.75 s/day
polkadot  2026-06   30 days   171 requests   5.70 per day   1.09 s/day
```

**This corrects an earlier figure of "~2.2 requests and ~1.4 s per day", measured 2026-08-20 and
carried in three files.** That arithmetic counts the boundary search and the account reads and
forgets `netflowsHeads`, which runs on *every* batch: `pin()` is five un-batched calls per host, so
ten requests per ten-day batch — a full request per stored day spent re-reading two heads that moved
a few hundred blocks since the last batch. Research queue O55 asks whether three of those five are
needed mid-month.

End to end, the whole Kusama backfill — 61 months, 1,857 days, 2021-07-01 → 2026-07-31 — took
**33.1 minutes** through the politeness gate: **1.07 s per stored day**, **1,542 B mean stored per
day**, 2.73 MB in total. (Polkadot's is 1,392 B per day; see
[jobs.md](../architecture/jobs.md#what-the-store-actually-costs).)

## Where we read this from

| What | Endpoint / storage |
|---|---|
| Relay RPC | `https://kusama-rpc.polkadot.io` (public, no key) |
| Asset Hub RPC | `https://kusama-asset-hub-rpc.polkadot.io` (public, no key) |
| Sovereign balances | `System::Account(AccountId32)` for the `para` leg on the relay and the `sibl` leg on Asset Hub |
| Parachain enumeration | `Paras::ParaLifecycles` and `Registrar::Paras` on the relay, read at each stored day's own block |
| Chain clock | `Timestamp::Now` (u64 ms), at the pinned block — the guard for both liveness and day boundaries |
| Native token units | `system_properties` → `{ss58Format: 2, tokenDecimals: 12, tokenSymbol: "KSM"}` on both chains, asserted on every read |
| Existential deposit | 0.000333333333 KSM on the relay, 0.0000033333 KSM on Asset Hub — see [asset-hub.md](asset-hub.md) |

## What is not read here, and would be next

- **`/sovereign/` is still Polkadot-only** and no longer has a reason to be. `sovereign-dot` reads
  the Polkadot hosts directly rather than through `NETFLOW_NETWORKS`. The one thing that needs a
  decision is `bridged-holders`, which is genuinely Polkadot-specific: `ForeignAssets` on Kusama
  Asset Hub is a different registry answering a different question. Research queue O50.
- **The Kusama topology registry is entirely `evidence: 'assumed'`** — 16 rows in
  `src/core/topology.js`. The backfill just produced the evidence to fix it: every stored Kusama day
  carries the union of `Paras::ParaLifecycles` and `Registrar::Paras` at that day's own block, so the
  store now holds a dated, chain-sourced list of every para id that has ever held KSM. Research
  queue O52.
- **Kintsugi's kBTC** is the Kusama half of the Interlay measurement and is entirely unmeasured —
  research queue O20, and [bridges.md](bridges.md) for the Polkadot half.

## Further reading

- [asset-hub.md](asset-hub.md) — the Polkadot side of the same measurement, and the machinery
- [polkadot.md](polkadot.md) — relay chains, para ids, Agile Coretime
- [xcm.md](xcm.md) — sovereign account derivation, `para` versus `sibl`
- [decision 0015](../decisions/0015-netflows-is-parameterised-by-network.md) — why one module, and
  why `network` is required rather than defaulted
