# Moonbeam: how a parachain leaves Polkadot

Moonbeam (para id 2004) **is no longer a Polkadot parachain, and its chain has stopped**. It was
deregistered by an ordinary `Registrar.deregister(2004)` extrinsic on 2026-08-10, and the relay
finished offboarding it four hours later. Moonriver (Kusama para 2023) went the same way the same
morning.

This note exists for two reasons. The first is the fact itself: a lot of this repository's
historical data names Moonbeam, several bridge routes are described as passing through it, and
anything read off it today is a **frozen snapshot of 2026-08-10T11:36:12Z** that will never advance.
The second is the mechanism, which generalises: a parachain leaving is a *quiet* event. There is no
error anywhere. The relay's maps simply stop containing an id, the chain's own RPC keeps answering
in full, and every number derived from either renders perfectly.

Everything below was read on **2026-08-20**. Evidence grades follow the `research-and-build`
skill: *verified live* (called it today, response below), *source-verified* (read out of the
runtime that defines the behaviour), *inferred* (reasoned from those two).

---

## The headline, with the exact blocks

*Verified live*, by binary search over the Polkadot archive at `https://rpc.polkadot.io`, and
reproduced independently on OnFinality's and Dwellir's Polkadot archives:

| Event | Relay block | Block hash | Timestamp (`Timestamp::Now`) |
|---|---|---|---|
| Last block with `Registrar::Paras(2004)` | 32,489,785 | — | 2026-08-10T07:29:18Z |
| **`Registrar.deregister(2004)` executed** | **32,489,786** | `0xaffe159802bf027d54c6144399dca1cea85c3dd3199aed9bcb74ef8f53493d41` | **2026-08-10T07:29:24Z** |
| Last block with `Paras::Heads(2004)` and `ParaLifecycles(2004)` | 32,492,252 | `0xcb4d5e64dc0bb2270ff40a0ee4d8a7e926364280448f253abc90c4e8727ffb00` | 2026-08-10T11:36:12Z |
| **First block with the para fully cleaned up** | **32,492,253** | `0x511de8d905fdffb01b5e6d65a892152d6d9c5bfc743658c5b8c5f2e11fc19ffd` | **2026-08-10T11:36:18Z** |

At the relay head (#32,636,293, 2026-08-20T11:50:18Z) para 2004 is absent from every relevant map,
while 2034 is present in all of them from the identical key derivation — which is what proves the
derivation rather than the absence:

```
para 2004: Heads=ABSENT  Lifecycle=ABSENT  Registrar=ABSENT
para 2034: Heads=0x5904e9fb3f96983fc3…(280B)  Lifecycle=0x01  Registrar=0x12ec4426bd4c3d506b…
para 2000: Heads=0x910346bdea1449fd40…(230B)  Lifecycle=0x01  Registrar=0x2240ade23679dd27a7…
para 1000: Heads=0xb903324b659e4cc10d…(240B)  Lifecycle=0x01  Registrar=0x908626870725d87736…

Paras::Heads          90 ids   has 2004 = false   has 2034 = true
Paras::ParaLifecycles 89 ids   has 2004 = false   has 2034 = true
Registrar::Paras     123 ids   has 2004 = false   has 2034 = true
```

The three storage keys, for anyone reproducing this:

```
Paras::Heads(2004)           0xcd710b30bd2eab0352ddcc26417aa1941b3c252fcb29d88eff4f3de5de4476c39f434b9dae0bfb8ed4070000
Paras::ParaLifecycles(2004)  0xcd710b30bd2eab0352ddcc26417aa194281e0bfde17b36573208a06cb5cfba6b9f434b9dae0bfb8ed4070000
Registrar::Paras(2004)       0x3fba98689ebed1138735e0e7a5a790abcd710b30bd2eab0352ddcc26417aa1949f434b9dae0bfb8ed4070000
```

---

## The mechanism: what "deregistered" is, exactly

This is the generalisable half, and it is worth reading even if Moonbeam is not your question.

### The three maps mean three different things

They are usually all present together, which is precisely why nobody notices they are different
questions until one of them disagrees.

| Storage item | Question it answers | What it holds |
|---|---|---|
| `Registrar::Paras(id)` | *Is this id registered, and who pays for it?* | `ParaInfo { manager, deposit, locked }` |
| `Paras::ParaLifecycles(id)` | *Is this para onboarding, running, or being offboarded?* | a `ParaLifecycle` enum byte |
| `Paras::Heads(id)` | *What was the last head the relay included?* | SCALE `HeadData` — the parachain's own header |

`Registrar::Paras` had **123** entries at the head and `Paras::Heads` **90**. The 33-entry gap is
not a bug: `Registrar::reserve` claims an id without registering a runtime, so a reserved-but-unused
id sits in `Registrar::Paras` and nowhere else. **Enumerating from `Paras::Heads` and enumerating
from `Registrar::Paras` give different sets, and neither is "the parachains".**

### `ParaLifecycle` byte values

*Source-verified* against `polkadot/runtime/parachains/src/paras/mod.rs`
([polkadot-sdk](https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/runtime/parachains/src/paras/mod.rs)):

| Byte | Variant |
|---|---|
| `0x00` | `Onboarding` |
| `0x01` | `Parathread` (on-demand) |
| `0x02` | `Parachain` (lease holding) |
| `0x03` | `UpgradingParathread` |
| `0x04` | `DowngradingParachain` |
| `0x05` | `OffboardingParathread` |
| `0x06` | `OffboardingParachain` |

**Every live para on Polkadot today reads `0x01`, including Asset Hub** — *verified live*. Since
Agile Coretime there are no leases, so nothing is a `Parachain` in the lifecycle sense; cores come
from the Coretime Chain's `Broker` pallet instead. Reading `0x01` as "this is only a parathread, not
a real parachain" would be wrong about every chain on the network.

### The sequence Moonbeam actually went through

1. **2026-08-07T19:35:48Z, relay #32,453,922** — `Registrar::Paras(2004).locked` flips from
   `Some(true)` (`0x0101`) to `Some(false)` (`0x0100`). *Verified live* by bisection.
   That block contains **only** the timestamp and `paras_inherent` extrinsics, and
   `Scheduler::Agenda(32453922)` was absent at the block before — so this was neither a signed
   call nor an enacted referendum. `Registrar::remove_lock` accepts only Root or *the para itself*
   (`ensure_root_or_para`, *source-verified*), so the remaining route is an XCM `Transact` from
   para 2004 dispatched during `on_initialize`: **Moonbeam's own governance unlocked Moonbeam's
   registration.** *Inferred* — the discriminating probe would be to decode the relay's message
   queue at that block.

   The lock matters because `ensure_root_para_or_owner` refuses the manager while the para is
   locked (*source-verified*). The unlock is what made step 2 possible.

2. **2026-08-10T07:29:24Z, relay #32,489,786** — extrinsic index 2, a signed extrinsic of 112
   bytes. *Verified live*, decoded by hand:

   ```
   0xb90184 00 3a2d163712bfa3a894b26009f3e8c092d5b99da1375a06f4036e93eadcebcc65
            01 24ba9bf907…                                 (sr25519 signature, 64 bytes)
            4503 04 00 00                                  (era, nonce 1, tip 0, metadata-hash mode)
            46 02 d4070000                                 ← the call
   ```

   `0x46` = pallet 70. *Source-verified* against the Polkadot relay runtime
   ([polkadot-fellows/runtimes](https://github.com/polkadot-fellows/runtimes/blob/main/relay/polkadot/src/lib.rs)):
   `Registrar: paras_registrar = 70`. Call index `0x02` is `deregister(origin, id: ParaId)`
   (*source-verified*, `polkadot/runtime/common/src/paras_registrar/mod.rs`). The argument
   `d4070000` is u32 little-endian **2004**.

   The signer is `12KHAurRWMFJyxU57S9pQerHsKLCwvWKM1d3dKZVx7gSfkFJ`, which is exactly the
   `manager` field of `Registrar::Paras(2004)` read at the block before:

   ```
   Registrar::Paras(2004) @ #32489785 =
     0x3a2d163712bfa3a894b26009f3e8c092d5b99da1375a06f4036e93eadcebcc65   manager
       80c7dcd89107000000000000000000                                     deposit 832.299 DOT
       0100                                                               locked = Some(false)
   ```

   So this was **the para's own manager voluntarily deregistering it** — not a Polkadot governance
   action, not a slash, not an expiry.

3. **The deposit came back, and it reconciles.** *Verified live*, `System::Account` of the manager
   across that one block:

   | | free (DOT) | reserved (DOT) |
   |---|---|---|
   | #32,489,785 | 1,905.6384727103 | 832.299 |
   | #32,489,786 | 2,737.9246240468 | 0 |

   free increases by 832.2861513365 = the 832.299 deposit less 0.0128486635 DOT of fee. That is
   `do_deregister`'s `Currency::unreserve(&info.manager, info.deposit)` (*source-verified*) landing
   exactly.

4. **Cleanup happens at the next session boundary, not immediately.** `do_deregister` calls
   `schedule_para_cleanup`, which sets `OffboardingParathread` and defers the rest. For 2,467 relay
   blocks — a little over four hours, one Polkadot session — para 2004 sat at lifecycle `0x05` with
   `Registrar::Paras` already gone but `Paras::Heads` still present and still advancing:

   ```
   #32490000  2026-08-10T07:50:48Z   lifecycle=0x05  registrar=ABSENT  heads=present
   #32492252  2026-08-10T11:36:12Z   lifecycle=0x05  registrar=ABSENT  heads=present
   #32492253  2026-08-10T11:36:18Z   lifecycle=ABSENT registrar=ABSENT heads=ABSENT
   ```

   **A read taken inside that window sees a chain that is registered nowhere and still producing
   blocks.** Neither map alone is the truth during an offboarding.

5. **HRMP was torn down with it.** At the head, `Hrmp::HrmpChannels` has 224 keys and **none**
   mentions para 2004 (*verified live*). What survives is an empty index entry —
   `Hrmp::HrmpEgressChannelsIndex(2004) = 0x00` and the same for ingress, a zero-length `Vec`. So
   an enumeration that reads the *index* still finds 2004 and finds it connected to nothing.

---

## The chain itself: still answering, permanently frozen

Moonbeam's own RPC did not go away. It serves its full history and its final state, and every
question you ask it gets a correct, current-looking answer about a chain that stopped ten days ago.

*Verified live*, four independent providers, across both the Substrate and the Ethereum RPC
surfaces — they agree on the head hash to the byte:

| Endpoint | Surface | Head |
|---|---|---|
| `https://moonbeam.api.onfinality.io/public` | Substrate | #16,796,699 `0x253a65d6…` |
| `https://moonbeam.unitedbloc.com` | Substrate | #16,796,699, identical `parentHash`/`stateRoot` |
| `https://moonbeam.drpc.org` | Ethereum | #16,796,699 `0xb0f26105835bc47af66c29df7a60acd7abda9fb709cd051bc5e65ccec415fb6d` |
| `https://moonbeam-rpc.n.dwellir.com` | Ethereum | same block, same hash |

```
system_chain                                  "Moonbeam"
system_version                                "0.52.3-dd58b13e70d"
system_health                                 {"peers":1,"isSyncing":false,"shouldHavePeers":true}
ParachainInfo::ParachainId                    2004
Timestamp::Now                                2026-08-10T11:36:12.000Z
ParachainSystem::LastRelayChainBlockNumber    32492252
eth_getBlockByNumber("latest").timestamp      1786361772  =  2026-08-10T11:36:12Z
eth_getBlockByNumber("latest").transactions   0
eth_getBlockByNumber("latest").gasUsed        0
```

Two things in there are worth pausing on.

**`LastRelayChainBlockNumber = 32,492,252` is the same block as the last `Paras::Heads(2004)`.**
The chain's own record of the last relay parent it saw and the relay's own record of the last head
it included are the same number, from opposite sides. That is the whole finding closed in one line,
and it is why "a stale RPC node" is not a live hypothesis here.

**`system_health` reports `isSyncing: false`.** The node is not behind; it is caught up to a chain
that has no more blocks. Health checks that ask "are you syncing?" answer *no* and mean *yes,
everything is fine* — the wrong answer to the question anybody was actually asking.

### Maintenance mode, on-chain

Moonbeam carries a `MaintenanceMode` pallet, and it is on. *Verified live*:

```
key    0xe11a6a33190df528cea25070debd8681e11a6a33190df528cea25070debd8681
value  0x01   (true)
```

Bisected on Moonbeam's own archive, it switched at **Moonbeam block 16,672,927,
2026-08-01T00:01:30Z** (`0xa88a190e447af22e7a43dd367c6d72d68025741e4068660a63811ce86b6c1afe`);
block 16,672,926 at 00:01:24Z still reads `false`. So the chain spent its last nine days producing
empty blocks with all transactions rejected — which is exactly what the final block's
`transactions: 0, gasUsed: 0` shows, and it matches the publicly announced "maintenance mode at
00:00 UTC on 1 August 2026" to within one block.

---

## Moonriver went too, and two others went earlier

*Verified live* against `https://kusama-rpc.polkadot.io`. Moonriver (Kusama para 2023) is absent
from `Registrar::Paras`, `Paras::ParaLifecycles` and `Paras::Heads` at Kusama #34,889,896:

| Event | Kusama block | Timestamp |
|---|---|---|
| `Registrar::Paras(2023)` last present | 34,747,314 | 2026-08-10T07:09:54Z |
| first absent | 34,747,315 | 2026-08-10T07:10:00Z |
| `Paras::Heads(2023)` last present | 34,748,075 | 2026-08-10T08:27:48Z |
| first absent | 34,748,076 | 2026-08-10T08:27:54Z |

Same morning, same operation, twenty minutes earlier than Moonbeam's.

Auditing **every** para id in `src/core/topology.js` against both relays turned up two more that
this repository was still listing as live (*verified live*, bisected the same way):

| Chain | Para | `Registrar::Paras` removed | `Paras::Heads` removed |
|---|---|---|---|
| Moonbeam | polkadot 2004 | #32,489,786 — 2026-08-10T07:29:24Z | #32,492,253 — 2026-08-10T11:36:18Z |
| Equilibrium | polkadot 2011 | #26,787,649 — 2025-07-08T09:51:54Z | #26,791,067 — 2025-07-08T15:36:18Z |
| Parallel | polkadot 2012 | #29,144,539 — 2025-12-20T01:33:18Z | #29,148,136 — 2025-12-20T07:36:18Z |
| Moonriver | kusama 2023 | #34,747,315 — 2026-08-10T07:10:00Z | #34,748,076 — 2026-08-10T08:27:54Z |

Every one of them shows the same four-hour-ish gap between the two removals, i.e. one session.
Equilibrium had been gone for **thirteen months** and nothing in this repository noticed, which is
the real lesson: this is not a Moonbeam story, it is a class of silent staleness that needs a check.

---

## What was ruled out, and how

Each of these was a cheaper explanation than "a flagship parachain left", so each was tested rather
than argued.

**A single stale or frozen RPC node.** *Ruled out, verified live.* Four independent providers on two
protocol surfaces return the same head hash, and the relay's own last-included head for 2004 decodes
to Moonbeam header #16,796,696 — three blocks behind the chain's own tip, which is normal inclusion
lag, not a stall. Both sides tell the same story.

**Moonbeam moved to a different para id.** *Ruled out, verified live.* Two checks. The manager
account `12KHAurRW…` appears as `manager` on **zero** of the 123 current `Registrar::Paras` entries.
And Moonbeam's `Paras::CurrentCodeHash` at #32,492,252 was
`0x43eff74f05632950d049db14806c5637158687280031e71279467a3a929f2757`; no live para on Polkadot
carries that code hash today.

**Parachain registration migrated to Asset Hub with the November 2025 Asset Hub Migration, leaving
the relay's maps as stale husks.** *Ruled out, verified live.* Asset Hub Polkadot
(`https://polkadot-asset-hub-rpc.polkadot.io`, runtime 1.24.1) has **no** `Registrar`, `Paras`,
`Slots`, `Auctions`, `Coretime` or `Broker` pallet — the strings do not appear in its metadata at
all, and the corresponding storage prefixes return zero keys. `Crowdloan` and `Staking` did move;
the parachain registrar did not. The relay is still the authority on who is a parachain.

**A storage-key derivation error on our side.** *Ruled out, verified live.* The identical derivation
returns data for 2034, 2000, 2006 and 1000 at the same block, and returns data for 2004 at
#32,492,252 and `null` at #32,492,253 — a key that is wrong is wrong at every block.

**An artefact of one relay archive.** *Ruled out, verified live.* Parity's `rpc.polkadot.io`,
OnFinality's `polkadot.api.onfinality.io/public` and Dwellir's `polkadot-rpc.n.dwellir.com`
independently return the same present/absent pair at #32,492,252 / #32,492,253, and the first two
independently return the same `Registrar.deregister(2004)` extrinsic bytes.

**Nothing announced it.** *Not the case, but treat this as the weakest evidence here.* The public
record says Moonbeam announced on 2026-07-03 that it was ending Polkadot parachain operations,
migrating GLMR 1:1 to Base, closing the migration window at 2026-07-31, and relaunching as an
AI-agent protocol; and that both Moonbeam and Moonriver entered maintenance mode at 00:00 UTC on
2026-08-01. Every checkable element of that lines up with chain state — the maintenance-mode flag
flipping at 00:01:30Z on 1 August, the empty final block, both chains deregistering on the same
morning. The chain evidence stands on its own; the announcements only explain the *why*.
`moonbeam.network` and `kucoin.com` are both blocked by this environment's egress proxy, so the
primary announcement was **not** read directly — this paragraph is secondary reporting.

---

## What this means for this repository

- **The para id must stay in `src/core/topology.js`.** Historical Dotlake rows and the committed
  netflows dataset both name Moonbeam and Moonriver; dropping the entry would turn named history
  into `para 2004`. The entry now carries a `retired` field instead, and `retiredChains()` is the
  reconciliation call that puts it in a page's data notes — the same shape as `unknownChains()` and
  `assumedChains()`.
- **Anything read off Moonbeam is a snapshot of 2026-08-10T11:36:12Z.** It is not a current
  balance, it cannot change, and it cannot move: there are no HRMP channels and no core. A page
  that shows a Moonbeam-resident figure must say the date on the figure, not the date of the page.
- **Do not enumerate parachains from one map.** `Registrar::Paras` (123) is registrations,
  `Paras::Heads` (90) is inclusion, `Paras::ParaLifecycles` (89) is lifecycle, and during an
  offboarding they disagree by design. Whichever one a feature picks, say which one on the page.
- **`Paras::*` is current-state-only.** There is no "was ever registered" map. A lifetime per-chain
  series needs the union of ever-registered ids from somewhere else — see `research-queue.md` O1.
  `Registrar::Deregistered` events are one route to it, now that we know the event exists and what
  it looks like.

---

## Where this was read from

| Endpoint | Used for |
|---|---|
| `https://rpc.polkadot.io` | the whole relay bisection; archive-complete back to at least #26,787,648 (2025-07) — *verified live* |
| `https://polkadot.api.onfinality.io/public` | independent reproduction of the bisection and the extrinsic |
| `https://polkadot-rpc.n.dwellir.com` | third independent reproduction of the boundary |
| `https://kusama-rpc.polkadot.io` | Moonriver / para 2023 |
| `https://polkadot-asset-hub-rpc.polkadot.io` | ruling out the Asset Hub migration hypothesis |
| `https://moonbeam.api.onfinality.io/public` | Moonbeam Substrate RPC, metadata, `MaintenanceMode` bisection |
| `https://moonbeam.unitedbloc.com` | independent Moonbeam Substrate RPC |
| `https://moonbeam.drpc.org`, `https://moonbeam-rpc.n.dwellir.com` | independent Moonbeam Ethereum RPC |

Not reachable from this environment, and therefore not evidence either way:
`rpc.api.moonbeam.network`, `moonbeam-rpc.dwellir.com`, `moonbeam.rpc.subquery.network`,
`rpc.ibp.network/polkadot` (`fetch failed`); `moonbeam.public.blastapi.io` (retired by its
operator); `rpc.ankr.com/moonbeam` (needs an API key, which this repository does not use);
`1rpc.io/glmr` (530); `moonbeam.public.curie.radiumblock.co` (1016). Blocked by this environment's
egress proxy: `moonbeam.network`, `www.kucoin.com`, `cryptoslate.com`.

## Further reading

- [`polkadot.md`](polkadot.md) — the relay chain, cores, and Agile Coretime
- [`bridges.md`](bridges.md) — the Wormhole/Axelar/LayerZero routes that used to land on Moonbeam
- [`asset-hub.md`](asset-hub.md) — what para 2004's sovereign accounts still hold
- [polkadot-sdk `paras_registrar`](https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/runtime/common/src/paras_registrar/mod.rs) — `register`, `deregister`, `remove_lock`, and the origin checks
- [polkadot-sdk `parachains::paras`](https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/runtime/parachains/src/paras/mod.rs) — `ParaLifecycle` and `schedule_para_cleanup`
- [polkadot-fellows/runtimes, relay/polkadot](https://github.com/polkadot-fellows/runtimes/blob/main/relay/polkadot/src/lib.rs) — the pallet index list
