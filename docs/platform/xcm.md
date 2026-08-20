# XCM: Cross-Consensus Messaging

XCM is a **language**, not a transport. An XCM message is a small program — an ordered list of
instructions — that the sender wants the receiver to execute on its behalf. It says nothing about how
the bytes get there, nothing about who pays, and nothing about whether the receiver should agree. The
transport is a separate layer (XCMP/HRMP for parachain-to-parachain, UMP/DMP for parachain-to-relay),
and the trust decisions are made locally by the receiving chain's XCM executor configuration.

Understanding that split is most of understanding XCM. A message that "fails" almost never failed in
transit. It arrived, it was decoded, and the receiving chain's executor decided it did not like
something about it.

All version claims and live readings below are as of **2026-08-19**.

---

## The transport layer

| Channel | Direction | Status |
|---|---|---|
| **UMP** (Upward Message Passing) | parachain → relay chain | Live |
| **DMP** (Downward Message Passing) | relay chain → parachain | Live |
| **HRMP** (Horizontally Relay-routed Message Passing) | parachain ↔ parachain, via relay chain storage | Live; this is what "XCMP" means in practice today |
| **XCMP** proper | parachain ↔ parachain, only message *hashes* on the relay chain | Still under development; HRMP is the stand-in |

The distinction matters for cost and for where you read data. HRMP puts the full message body into
relay chain storage, so the relay chain pays for every byte and channels must be explicitly opened
between each pair of chains (a two-sided handshake, `hrmp_init_open_channel` /
`hrmp_accept_open_channel`, and for system chains this is done by governance). Real XCMP would put
only a commitment on the relay chain and pass the body directly between collators, which is what
makes it O(1) for the relay chain. Until that ships, "how many chains can talk to each other" is
bounded by how many HRMP channels governance and parachain teams have opened.

On the receiving side, messages land in `MessageQueue` (via `XcmpQueue` for horizontal messages) and
are executed in later blocks. **Execution is therefore asynchronous and not atomic with the send.** A
message can be sent successfully in block N on chain A and fail in block N+3 on chain B, and there is
no rollback on chain A. This is the root cause of most "my tokens disappeared" reports.

## Locations: the addressing system

Every place XCM can talk about is a `Location` (called `MultiLocation` before XCM v4). It has two
parts:

```
Location { parents: u8, interior: Junctions }
```

`parents` is how many levels to walk *up* the consensus hierarchy before descending. `interior` is
the path down. Junctions include `Parachain(u32)`, `PalletInstance(u8)`, `GeneralIndex(u128)`,
`AccountId32 { network, id }`, `AccountKey20 { network, key }`, and `GlobalConsensus(NetworkId)`.

Read from the point of view of the chain doing the reading:

| Location | Meaning, if you are Hydration (para 2034) |
|---|---|
| `{ parents: 0, interior: Here }` | Hydration itself; its native token HDX |
| `{ parents: 1, interior: Here }` | The relay chain; DOT |
| `{ parents: 1, X1(Parachain(1000)) }` | Asset Hub |
| `{ parents: 1, X3(Parachain(1000), PalletInstance(50), GeneralIndex(1337)) }` | USDC on Asset Hub |
| `{ parents: 2, X1(GlobalConsensus(Kusama)) }` | KSM, outside the Polkadot consensus system |
| `{ parents: 2, X2(GlobalConsensus(Ethereum{chain_id:1}), AccountKey20{..}) }` | An Ethereum ERC-20 |

`PalletInstance(50)` is the index of the `Assets` pallet in the Asset Hub runtime and
`GeneralIndex(1337)` is USDC's asset id inside it. That exact triple was observed live in
`PolkadotXcm.transfer_assets_using_type_and_then` calls on Hydration on 2026-08-19.

**Reanchoring** is the operation that rewrites a location from the sender's frame into the receiver's
frame. Asset Hub calls its own USDC `{ parents: 0, X2(PalletInstance(50), GeneralIndex(1337)) }`;
when it sends a message to Hydration, it must reanchor that to
`{ parents: 1, X3(Parachain(1000), PalletInstance(50), GeneralIndex(1337)) }`. Every transfer program
in `pallet-xcm` calls `reanchor()` and returns `CannotReanchor` if it fails. Getting this wrong means
the receiver looks up an asset that does not exist in its registry and the message trips.

## The instruction model

The XCM executor is a small virtual machine with **registers**:

| Register | What it holds |
|---|---|
| **Holding** | Assets currently in flight, owned by nobody, waiting to be deposited somewhere |
| **Origin** | Who the message is currently acting as; starts as the sender's location, can be descended or cleared |
| **Error** / **Error handler** | The last error, and a program to run on failure |
| **Appendix** | A program to run after the main program, success or failure |
| **Surplus / Refunded weight** | Weight bought but not used |
| **Fees** (v5) | Assets set aside for fees by `PayFees` |
| **Transact status**, **Topic** | Result of a `Transact`; a correlation id set by `SetTopic` |

XCM v5 has 52 instructions. The ones that carry almost all real traffic:

| Instruction | Effect |
|---|---|
| `WithdrawAsset(assets)` | Take assets out of the origin's local account into **holding** |
| `ReserveAssetDeposited(assets)` | "The reserve has credited you." Mints the local representation into holding. **Only meaningful if the receiver trusts the sender as a reserve for those assets** |
| `ReceiveTeleportedAsset(assets)` | "These were burnt on the other side." Mints into holding. Requires trusting the sender as a teleporter |
| `BurnAsset(assets)` | Destroy assets from holding |
| `BuyExecution { fees, weight_limit }` | Take `fees` from holding, pay for execution weight. Pre-v5 fee mechanism, still dominant |
| `PayFees { asset }` | v5 replacement for `BuyExecution`: moves the asset into the fees register; only the first one counts |
| `DepositAsset { assets, beneficiary }` | Move assets from holding into `beneficiary`'s account on this chain |
| `TransferAsset { assets, beneficiary }` | Move assets directly between two local accounts, without touching holding |
| `TransferReserveAsset` / `DepositReserveAsset` | Move assets into a destination's sovereign account here, and send that destination a message starting with `ReserveAssetDeposited` |
| `InitiateReserveWithdraw { assets, reserve, xcm }` | Burn the local representation and send `xcm` to the `reserve` chain, prefixed with a `WithdrawAsset` |
| `InitiateTeleport` | Burn locally, send `ReceiveTeleportedAsset` |
| `InitiateTransfer` (v5) | Generalised replacement for the three above: per-asset choice of teleport / reserve-deposit / reserve-withdraw in one instruction |
| `ClearOrigin` | Drop the origin. Everything after this executes as nobody |
| `DescendOrigin(interior)` | Narrow the origin, e.g. from "parachain 2034" to "account X on parachain 2034" |
| `Transact { origin_kind, call }` | Dispatch an encoded local call |
| `SetAppendix` / `SetErrorHandler` | Attach cleanup / failure programs |
| `SetTopic([u8;32])` | Stamp a correlation id. **This is the field that lets you join a send to a receive across chains** |
| `RefundSurplus`, `ClaimAsset`, `Trap` | Reclaim unused weight; claim assets that were trapped by a failed program |

`ClearOrigin` is the most important small instruction. Anything before it runs with the sender chain's
authority; anything after it runs with none. It appears immediately after
`ReserveAssetDeposited`/`ReceiveTeleportedAsset` in every standard transfer program precisely so that
a `DepositAsset` cannot be turned into an arbitrary privileged action.

## Sovereign accounts

A chain cannot hold an account on another chain in the normal sense, so XCM gives every location a
deterministic **sovereign account** on every other chain. For parachains the derivation is *not* a
hash — it is a literal byte prefix plus the SCALE-encoded para id, zero-padded:

| Context | Prefix | Example (para 2034 = `0xf2070000` LE) |
|---|---|---|
| A parachain's account **on the relay chain** | `b"para"` = `0x70617261` | `0x70617261f2070000` + 24 zero bytes |
| A sibling parachain's account **on another parachain** | `b"sibl"` = `0x7369626c` | `0x7369626cf2070000` + 24 zero bytes |

Verified live on 2026-08-19: `0x7369626cf20700000000000000000000000000000000000000000000000000 00` is Hydration's
sovereign account on Asset Hub, and reading `Assets::Account(1337, that_account)` gives
**5,285,506.68 USDC**.

Some older documentation says these are `blake2(b"para" ++ id)`. That is wrong for the parachain
converters in current `xcm-builder` (`ChildParachainConvertsVia`, `SiblingParachainConvertsVia`),
which use `into_account_truncating` — literal bytes with trailing-zero padding. Hashed derivations
*do* exist, for describing remote *accounts* (`HashedDescription`, used so that account X on chain A
gets a distinct derived account on chain B), but not for the chains themselves.

## Reserve-backed vs teleport

These are the two ways an asset can move, and they encode different trust assumptions.

|  | Reserve-backed transfer | Teleport |
|---|---|---|
| Physical model | The real asset never moves. It sits in a sovereign account on the **reserve chain**; other chains hold IOUs | The asset is **burnt** on the source and **minted** on the destination |
| Total supply | Conserved by construction; the reserve's holdings are the backing | Conserved only if both chains are honest |
| Trust needed | Every participant must agree who the reserve is, and trust it | Both chains must trust each other's *entire runtime* not to mint |
| Used for | Almost everything: USDC, USDT, parachain tokens, bridged assets | DOT between the relay chain and system chains; assets between system chains |
| Config knob | `IsReserve` in the XCM executor | `IsTeleporter` in the XCM executor |

**When is a teleport valid?** Only when the two chains are under the same governance and you are
willing to say "if that chain's runtime is compromised, my chain's supply is compromised". That is
true of Polkadot's system chains, which are all upgraded by Polkadot's own OpenGov. It is not true of
a third-party parachain, which is why no parachain teleports with Asset Hub — they reserve-transfer.

**When is a reserve transfer valid?** When the receiver's `IsReserve` says that *this specific origin*
is the reserve for *these specific assets*. Asset Hub is the reserve for all Asset Hub-issued assets;
each parachain is the reserve for its own native token. A `ReserveAssetDeposited` from a chain that is
not the configured reserve is rejected — and this is not a formality, it is the only thing stopping
any parachain from minting unlimited USDC on your chain by simply asserting it.

### The reserve invariant, verified

If the model holds, the total supply of USDC on Hydration should equal the USDC held by Hydration's
sovereign account on Asset Hub. Read live on 2026-08-19:

| Reading | Value |
|---|---|
| `Assets::Account(1337, 0x7369626cf2070000…)` on Asset Hub | 5,285,506.68 USDC |
| `Tokens::TotalIssuance(22)` on Hydration | 5,285,081.65 USDC |
| Difference | 425.03 USDC |

The gap is in-flight messages and fees consumed on the Asset Hub side. This is a genuinely useful
health check: if a parachain's local issuance of a reserve-backed asset ever *exceeds* its sovereign
holdings on the reserve, something is badly wrong.

## Fees and barriers

XCM execution is not free, and the receiving chain has no way to charge the sender's account — the
sender is on another chain. So the message must **bring its own fee asset in holding** and spend it.

The classic pattern is `BuyExecution { fees, weight_limit }`: take `fees` from holding, convert to
weight at the chain's local rate, and refuse to continue if the message needs more weight than that
buys. XCM v5 replaces it with `PayFees { asset }`, which moves an asset into a dedicated fees register
rather than leaving fee payment tangled up with holding. Both exist in the wild; v5 chains still
accept `BuyExecution`.

A **barrier** is the receiving chain's admission policy — a predicate run over the message *before*
execution. Typical composition:

- `TakeWeightCredit` — allow if weight credit already exists
- `AllowTopLevelPaidExecutionFrom<Everything>` — allow if the message begins with a recognisable
  "withdraw/receive assets, then buy execution" preamble
- `AllowExplicitUnpaidExecutionFrom<ParentOrSiblings>` — allow specific trusted origins to send
  `UnpaidExecution`
- `AllowSubscriptionsFrom<..>` — allow version subscription handshakes

The barrier is why the *order of instructions matters* and why `pallet-xcm` explicitly prepends fee
instructions rather than appending them: "for remote XCM they have to be prepended instead of appended
to pass barriers" (comment in `add_fees_to_xcm`, `polkadot-sdk`). A perfectly valid program that pays
its fees in the wrong position is rejected before a single instruction runs.

## Why messages fail

In rough order of how often you will see each:

1. **Insufficient fee asset.** The message carries too little of the fee asset for the destination's
   weight price, or carries a fee asset the destination cannot value at all. Symptom: the message is
   received and immediately errors; assets are usually **trapped** (recoverable with `ClaimAsset`, but
   only by whoever the asset claimer is).
2. **Untrusted reserve.** `ReserveAssetDeposited` from an origin the destination's `IsReserve` does
   not accept. Symptom: `UntrustedReserveLocation`.
3. **Barrier rejection.** The program shape did not match any allowed pattern. Symptom: the message
   is dropped at the barrier and you will not see per-instruction errors, only a `Barrier` failure.
4. **Version mismatch.** The destination does not support the version the message was encoded in and
   no downgrade path exists. See below.
5. **Asset not registered.** The reanchored location does not exist in the destination's asset
   registry. Symptom: `AssetNotFound` / `FailedToTransactAsset`.
6. **Weight limit exceeded.** `weight_limit` was set too low.

Trapped assets are worth calling out. When a program fails after assets are already in holding, the
executor deposits them into an `AssetTrap` keyed by (origin, assets hash). They are not lost, but
recovering them requires sending a *new* message containing `ClaimAsset` with an exactly matching
asset description. XCM v5's `SetAssetClaimer` lets a program nominate in advance who may claim, which
is the fix for "the trapped assets can only be claimed by a chain that has no way to sign".

## Versions

XCM versions are negotiated **per destination**, not set globally.

- `SafeXcmVersion` is the conservative fallback used when nothing is known about a destination.
  Verified live 2026-08-19: **3** on the Polkadot relay chain, Asset Hub, and Hydration.
- `SupportedVersion(version, location) -> version` records what each peer has advertised, learned
  through `SubscribeVersion` / `QueryResponse` handshakes. Reading Asset Hub's map on 2026-08-19 shows
  peers on **3, 4 and 5 simultaneously**.
- For the route we care about, **Asset Hub and Hydration have both negotiated v5 with each other** —
  verified live by reading `PolkadotXcm::SupportedVersion(5, V5{parents:1, X1(Parachain(…))})` on
  each chain and getting `5` back.

What changed in v4 → v5, briefly: `MultiLocation`/`MultiAsset` were renamed to `Location`/`Asset`;
`Junctions::X1..X8` became `Arc`-wrapped arrays; and v5 added `PayFees`, `InitiateTransfer`,
`SetAssetClaimer` (via `SetHints`), `ExecuteWithOrigin` and `AliasOrigin`. Note that the `NetworkId`
enum kept its v4 discriminants when Westend/Rococo/Wococo were removed, so `Ethereum` is still
variant 7 and the indices are not contiguous — a decoder that assumes contiguity will misread every
bridged asset.

An important practical point: **the version a user's wallet encodes a call in is not the version the
chains negotiated.** Live on Hydration on 2026-08-19 we observed
`PolkadotXcm.transfer_assets_using_type_and_then` calls submitted with `V3`-wrapped and `V4`-wrapped
arguments on a route where both chains support v5. The runtime converts. If you are decoding
extrinsic arguments you must handle every version wrapper, not just the current one.

---

## Worked example: USDC from Asset Hub to Hydration

This is a **reserve-backed transfer with a local reserve** — Asset Hub issues USDC, so Asset Hub *is*
the reserve. The program below is what `pallet-xcm`'s `local_reserve_transfer_programs` constructs
(source: `polkadot/xcm/pallet-xcm/src/lib.rs`, read 2026-08-19); the batched-fee variant is shown
because it is the common one.

Alice on Asset Hub sends 1,000 USDC to Bob on Hydration.

### Step 1 — Alice submits an extrinsic on Asset Hub

`PolkadotXcm::transfer_assets` (or `limited_reserve_transfer_assets`) with:

- `dest = { parents: 1, X1(Parachain(2034)) }`
- `beneficiary = { parents: 0, X1(AccountId32 { id: Bob }) }`
- `assets = [ { id: { parents: 0, X2(PalletInstance(50), GeneralIndex(1337)) }, fun: Fungible(1_000_000_000) } ]`
  (1,000 USDC at 6 decimals)
- `fee_asset_item = 0` — fees are taken from the same USDC
- `weight_limit = Unlimited`

### Step 2 — Asset Hub executes locally

The runtime builds a **local program** and executes it in Alice's extrinsic, with Alice as origin:

```
TransferAsset {
  assets:      1_000_000_000 of (0, [PalletInstance(50), GeneralIndex(1337)]),
  beneficiary: (1, [Parachain(2034)]),
}
```

`TransferAsset` with a *location* beneficiary resolves that location through Asset Hub's
`LocationToAccountId` converter, which turns `(1, [Parachain(2034)])` into the sibling sovereign
account `0x7369626cf2070000…`. So the concrete effect on Asset Hub is a plain `assets` transfer from
Alice to Hydration's sovereign account. **The USDC never leaves Asset Hub.** This is the step that
grew that account to the 5.28M USDC we read above.

If this step fails — Alice is short, or the asset is frozen — the whole extrinsic reverts and no
message is sent. This is the only part of the operation that is atomic with Alice's transaction.

### Step 3 — Asset Hub sends the message

Asset Hub reanchors the asset id into Hydration's frame
(`(0, [PalletInstance(50), GeneralIndex(1337)])` → `(1, [Parachain(1000), PalletInstance(50), GeneralIndex(1337)])`)
and queues an HRMP message to para 2034 containing:

```
ReserveAssetDeposited( 1_000_000_000 of (1, [Parachain(1000), PalletInstance(50), GeneralIndex(1337)]) )
ClearOrigin
BuyExecution { fees: <part of the same USDC>, weight_limit: Unlimited }
DepositAsset { assets: Wild(AllCounted(1)), beneficiary: (0, [AccountId32 { id: Bob }]) }
SetTopic([u8; 32])
```

The origin as seen by Hydration will be `(1, [Parachain(1000)])`. `SetTopic` is appended by the
router; its value is the message id you can join on.

### Step 4 — Hydration receives and executes

Hydration's `XcmpQueue` accepts the message into `MessageQueue`; it is executed in a subsequent
block. Instruction by instruction, **on Hydration**:

| # | Instruction | What Hydration does | How it can fail |
|---|---|---|---|
| 0 | *(barrier)* | Checks the program starts with a recognised paid-execution preamble from an allowed origin | `Barrier` — message dropped, no assets touched |
| 1 | `ReserveAssetDeposited` | Consults `IsReserve`: is `(1,[Parachain(1000)])` the trusted reserve for this asset? Yes. Looks the location up in `AssetRegistry` → local asset id **22**. Mints 1,000 USDC into **holding** | `UntrustedReserveLocation` if the origin is not the configured reserve; `AssetNotFound` if the location is not registered |
| 2 | `ClearOrigin` | Origin register set to `None`. Nothing after this carries Asset Hub's authority | — |
| 3 | `BuyExecution` | Takes USDC out of holding, values it against HDX via Hydration's fee mechanism, buys weight for the rest of the program | `TooExpensive` if the fee portion cannot cover the weight; assets are then **trapped** |
| 4 | `DepositAsset` | Moves everything left in holding into Bob's account, as `Tokens` asset 22. Increments `Tokens::TotalIssuance(22)` | `FailedToTransactAsset` if Bob's account cannot exist (asset 22 is sufficient on Hydration, so this is rare) |
| 5 | `SetTopic` | Records the correlation id in the execution context, emitted on the completion event | — |

Bob now holds USDC on Hydration. The invariant is preserved: Hydration's local issuance went up by
1,000, and Hydration's sovereign account on Asset Hub went up by 1,000.

### The return trip

Hydration → Asset Hub is the mirror image, and it uses a **destination reserve** because the reserve
(Asset Hub) is the destination. Observed live on Hydration on 2026-08-19 as
`PolkadotXcm.transfer_assets_using_type_and_then` with `assetsTransferType: DestinationReserve`.
Source-verified programs:

```
on Hydration:      WithdrawAsset(assets)      // take Bob's local USDC
                   BurnAsset(assets)          // destroy the IOU

on Asset Hub:      WithdrawAsset(reanchored)  // take real USDC from Hydration's sovereign account
                   ClearOrigin
                   BuyExecution { fees, weight_limit }
                   DepositAsset { assets: Wild(AllCounted(n)), beneficiary }
```

Note the asymmetry: outbound, the local chain does a `TransferAsset` into a sovereign account;
inbound, the local chain does `WithdrawAsset` + `BurnAsset` and the *remote* chain does the
`WithdrawAsset` against the sovereign account. Both preserve the invariant, from opposite ends.

### The third case: remote reserve

If neither chain is the reserve — say moving USDC between two parachains that are not Asset Hub — the
program routes through the reserve as a middle hop, and the fee asset is **split in half**, one half
for the reserve chain and one for the destination:

```
on origin:    WithdrawAsset(assets)
              SetFeesMode { jit_withdraw: true }
              InitiateReserveWithdraw { assets: Wild(AllCounted(n)), reserve, xcm: [
                  BuyExecution { fees: reserve_fees, weight_limit }
                  DepositReserveAsset { assets: Wild(AllCounted(n)), dest, xcm: [
                      BuyExecution { fees: dest_fees, weight_limit }
                      DepositAsset { assets: Wild(AllCounted(n)), beneficiary }
                  ]}
              ]}
```

Three chains, two hops, two independent fee payments, and any of the three can fail. This is why
most parachain UIs route stablecoin transfers via Asset Hub explicitly rather than letting the
executor do a remote-reserve hop.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| Negotiated version per peer | `PolkadotXcm::SupportedVersion(u32, VersionedLocation)` on any parachain; `XcmPallet::SupportedVersion` on the relay chain |
| Fallback version | `PolkadotXcm::SafeXcmVersion` (3 everywhere we checked on 2026-08-19) |
| Outgoing messages | `PolkadotXcm.Sent` event (carries `message_id`); `XcmpQueue` outbound state |
| Incoming messages | `MessageQueue.Processed` / `MessageQueue.ProcessingFailed`; `XcmpQueue.Success` / `.Fail` |
| Execution outcome | `PolkadotXcm.Attempted` (local execution); the `Outcome` in queue events |
| Trapped assets | `PolkadotXcm::AssetTraps(H256) -> u32` |
| Sovereign account balances | Asset Hub `Assets::Account(1337, 0x7369626c ++ para_id_le ++ zeros)` |
| Reserve invariant on Hydration | Hydration `Tokens::TotalIssuance(22)` for USDC |
| Extrinsics that start transfers | `PolkadotXcm.transfer_assets`, `.limited_reserve_transfer_assets`, `.transfer_assets_using_type_and_then`, `.execute` |
| Aggregated flows | `https://api.data.parity.io/api/xcm-summary`, `/api/xcm-top-routes`, `/api/xcm-daily-stats` |

Joining a send to a receive: the reliable key is the **message id** (the `SetTopic` value, surfaced in
`PolkadotXcm.Sent` and in the destination's queue events). Matching on amount and timestamp works
until two users send the same round number in the same block, and then it silently mismatches.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Polkadot Wiki — Introduction to XCM](https://wiki.polkadot.com/learn/learn-xcm/)
- [Polkadot Wiki — XCM transport (XCMP, HRMP, UMP, DMP)](https://wiki.polkadot.com/learn/learn-xcm-transport/)
- [XCM v5 `Instruction` enum (rustdoc)](https://paritytech.github.io/polkadot-sdk/master/staging_xcm/v5/opaque/type.Instruction.html)
- [`pallet_xcm` source — transfer program construction](https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/xcm/pallet-xcm/src/lib.rs)
- [XCM format specification (polkadot-fellows/xcm-format)](https://github.com/polkadot-fellows/xcm-format)
- [RFC-0100 — `InitiateTransfer` / multi-type asset transfer](https://polkadot-fellows.github.io/RFCs/approved/0100-xcm-multi-type-asset-transfer.html)
- [XCM docs — reserve-backed transfers](https://paritytech.github.io/xcm-docs/journey/transfers/reserve.html)
- [Polkadot Developer Docs — claiming trapped assets](https://docs.polkadot.com/develop/interoperability/xcm-guides/from-apps/claiming-trapped-assets/)
