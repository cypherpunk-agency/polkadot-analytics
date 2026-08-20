# Hyperbridge

Hyperbridge is a cross-chain interoperability protocol built as a Polkadot parachain (state machine id
`POLKADOT-3367`, *verified live*). Its claim is narrow and worth stating precisely: rather than
securing cross-chain messages with a multisig, an MPC committee, or a set of bonded attestors,
Hyperbridge **verifies the consensus of the source chain on-chain** and then proves individual
messages against the state root that consensus finalised. It is a *coprocessor*: it does the expensive
proof verification once, for everyone, and hands out succinct results.

On top of that messaging layer sits an **Intent Gateway** — a filler-based cross-chain swap
protocol — and on top of that sit consumer apps, of which **HyperFX** is the one this repository
tracks.

Live readings below are from `https://nexus.indexer.polytope.technology/` on **2026-08-19**.

---

## ISMP: the messaging layer

**ISMP** (Interoperable State Machine Protocol) is the message format and verification protocol.
The mental model is IBC's, adapted for chains that do not all have fast finality.

The pieces:

- A **state machine** is any chain Hyperbridge knows about, identified by a string. Formats seen live:
  `EVM-1` (Ethereum), `EVM-137` (Polygon), `EVM-56` (BNB Chain), `EVM-8453` (Base), `EVM-42161`
  (Arbitrum), `EVM-100` (Gnosis), `POLKADOT-3367` (Hyperbridge itself), `SUBSTRATE-cere`. So the
  scheme is `<CONSENSUS>-<identifier>`, where the identifier is an EVM chain id, a Polkadot para id,
  or a chain name.
- A **consensus client** on Hyperbridge tracks a source chain's consensus — for Ethereum that means
  verifying sync committee signatures; for a Polkadot parachain, GRANDPA and parachain inclusion.
  Its output is a verified **state root** at a given height.
- A **request** is a message. `POST` requests carry a payload to a destination module; `GET` requests
  read a storage value from a remote chain and return it as a response. Both are committed to on the
  source chain, so a request's identity is a **commitment** hash.
- A **state proof** shows that a given commitment is in the source chain's storage at a root the
  consensus client has verified. That is what authorises delivery.
- **Relayers** do the work and are not trusted. Consensus relayers submit consensus proofs that
  advance the light client; message relayers submit state proofs plus payloads. They are paid out of
  fees, and because everything they submit is verified, a malicious relayer can only waste its own
  gas.

The security argument reduces to: *if you believe Ethereum's consensus, and you believe Hyperbridge
correctly implements the Ethereum light client, then you believe the message.* There is no committee
to bribe. The costs are that consensus verification is expensive (hence the coprocessor design — pay
for it once on one chain) and that latency is bounded below by source-chain finality.

The nexus indexer exposes this layer directly: `stateMachineUpdateEvents` (light client advances),
`requestV2s` / `responseV2s`, `relayerV2s`, `relayerStatsPerChainV2s`, `hyperbridgeRelayerRewards`.

## The Intent Gateway

Bridging by locking and minting is slow — you wait for source finality plus proof relay before you
have anything on the far side. The Intent Gateway inverts this: a **filler** fronts you the output
asset immediately out of its own inventory, and *then* uses ISMP to prove it did so and collect your
escrowed input.

The flow:

1. **PLACED.** The user calls the gateway on the source chain, escrowing their input assets and
   emitting an order. The order names the outputs they want, on which chain, to which beneficiary,
   with a deadline and a fee.
2. **FILLED.** A filler sees the order, decides it is profitable, and calls `fillOrder` on the
   destination chain, paying the outputs to the beneficiary out of its own balance. **The user is
   done at this point** — they have their money.
3. **REDEEMED.** ISMP delivers a proof of the fill back to the source chain. The source gateway
   releases the escrowed inputs plus the fee to the filler.
4. **REFUNDED.** If the deadline passes with no fill, the user reclaims their escrow.

So the two-sided economics: the user pays a fee for immediacy and the filler earns it for taking
inventory and settlement-latency risk. If the proof never arrives, the filler is out of pocket, not
the user — which is why filler capital is the scarce resource and why fill rates, not proof latency,
are the health metric that matters to users.

**Intent Gateway V2** generalises the order space. Its framing is that an order is a vector with two
components, Δchain and Δasset — so a same-chain swap is just an order with Δchain = 0, and there is no
separate code path for it. This shows up plainly in the data: over a live sample of 40 recent orders on
2026-08-19, **32 had `sourceChain == destChain == EVM-8453`**. If you are counting "cross-chain
volume", you must filter on `sourceChain != destChain` or you will be counting same-chain swaps.

### The status lifecycle, with real timings

`OrderStatus` is an enum with exactly four values (*verified by GraphQL introspection*):

| Status | Set when | On which chain |
|---|---|---|
| `PLACED` | User escrows inputs and the order is emitted | Source |
| `FILLED` | Filler pays outputs to the beneficiary | Destination |
| `REDEEMED` | Escrow released to the filler after ISMP settlement | Source |
| `REFUNDED` | Deadline passed unfilled; escrow returned to the user | Source |

`REDEEMED` and `REFUNDED` are terminal and mutually exclusive. `statusMetadata` carries one row per
transition with its own chain and transaction hash, which means you can measure the two latencies
separately.

A complete order read live on 2026-08-19 (`0xfbbc31f3…01c7`, Polygon → Base, HyperFX):

| Transition | Unix time | Chain | Elapsed |
|---|---|---|---|
| `PLACED` | 1787136900 | 137 (Polygon) | — |
| `FILLED` | 1787136931 | 8453 (Base) | **+31 seconds** |
| `REDEEMED` | 1787140741 | 137 (Polygon) | +64 minutes |

That gap is the whole design in one table. **The user waited 31 seconds. The filler waited an hour.**
Reporting "average bridge time" as PLACED→REDEEMED tells you about proof latency and tells the user
nothing about their experience; reporting PLACED→FILLED tells you about filler competition. Report
both, labelled.

### Order fields

`IOrderV3` as exposed by the nexus indexer, verified by introspection on 2026-08-19:

| Field | Type | Notes |
|---|---|---|
| `id`, `commitment` | String | Both the order hash; equal in every sample we saw |
| `user` | String | The order placer, 20-byte hex |
| `sourceChain`, `destChain` | String | State machine ids, e.g. `EVM-137` |
| `status` | `OrderStatus` | PLACED / FILLED / REDEEMED / REFUNDED |
| `deadline` | BigFloat | A **source-chain block number**, not a timestamp |
| `nonce` | BigFloat | Per-user ordering |
| `fees` | BigFloat | The filler's fee |
| `inputUSD` | BigFloat | Indexer-computed USD value of the inputs |
| `referrer` | String | 32 bytes — see below |
| `session` | String | Optional grouping |
| `predispatchCalldata`, `postDispatchCalldata` | String | Arbitrary calls executed around the fill; this is what makes an intent more than a swap |
| `createdAt`, `blockNumber`, `blockTimestamp`, `transactionHash` | | Placement metadata |
| `inputAssets`, `outputAssets`, `predispatchAssets` | connections | `{ token, amount }`, outputs also carry `beneficiary` |
| `fills`, `partialFills` | connections | `{ filler, … }` |
| `escrowReleases`, `escrowRefunds` | connections | Settlement records |
| `statusMetadata` | connection | `{ status, timestamp, transactionHash, chain }` |

Token addresses and beneficiaries are **bytes32, left-padded**:
`0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913`. The real H160 is the last 20
bytes. Comparing the padded form against an unpadded address list matches nothing, silently.

### The `referrer` field

`referrer` is a `bytes32` carrying a **right-zero-padded ASCII tag**, not an address. Decoded from a
live sample of 40 orders on 2026-08-19:

| Raw | Decoded | Count |
|---|---|---|
| `0x4879706572465800…` | `HyperFX` | 30 |
| `0x6e6f626c6f636b73…` | `noblocks` | 9 |
| `0x4c756d696e657400…` | `Luminet` | 1 |

So attribution to a front end is a decode, not a join: strip trailing `0x00` bytes and read as UTF-8.
This is how you answer "how much of Intent Gateway volume is HyperFX" — and note that an order with an
all-zero or null referrer is unattributed rather than belonging to any particular app.

## HyperFX

HyperFX is an intent-based **foreign exchange** application built by Polytope Labs on top of the
Intent Gateway, at `app.hyperfx.finance`. It grew out of AbokiFX, a Nigerian FX rate service. The
proposition is fiat-currency swaps settled over stablecoin rails — its naira leg settles in cNGN, a
regulated naira-backed stablecoin.

What that means structurally is that HyperFX orders are Intent Gateway orders with `referrer` =
`HyperFX`, and many of them are same-chain (currency A stablecoin → currency B stablecoin on the same
chain) rather than cross-chain. The 32-of-40 same-chain figure above is largely HyperFX.

For an analytics tool this is a clean separation of concerns: Hyperbridge is the settlement layer,
Intent Gateway is the order protocol, HyperFX is one app whose orders you identify by referrer tag.
Nothing about HyperFX requires a separate data source.

## Aggregates the indexer already computes

Worth knowing before you build your own roll-ups:

- `cumulativeIntentGatewayVolumeUSDs` — keyed `<chain>-<STATUS>`, e.g. `EVM-137-PLACED`. Values are
  USD scaled by 1e18, so `6334160340000000000000` is $6,334.16. **That scaling is a trap**: the
  numbers look like token amounts and are not.
- `dailyVolumeUSDs`, `cumulativeVolumeUSDs`, `intentGatewayTokenVolumes`
- `hyperBridgeStats`, `relayerStatsPerChainV2s`, `dailyTreasuryRelayerRewards`
- `tokenPrices`, `tokenPriceLogs` — the price source the indexer used, so your USD figures can be
  reconciled against theirs
- `liquidityPools`, `liquidityProviders`, `vaultSnapshots`, `phantomOrders` — filler-side liquidity
  infrastructure

The schema is PostGraphile-style: every entity has a plural connection (`iOrderV3s`), a singular
lookup (`iOrderV3`), and a `byNodeId` variant, with `filter:`, `orderBy:`, `first:`/`after:`
pagination and a `totalCount` on connections. 237 root query fields as of 2026-08-19.

## What to be careful about

1. **Same-chain orders are the majority.** Filter explicitly.
2. **`deadline` is a block number.** Comparing it to a Unix timestamp produces a date in 1971.
3. **Bytes32 padding** on tokens and beneficiaries.
4. **`referrer` is text in a bytes32**, not an address.
5. **1e18 scaling on USD aggregates**, but `inputUSD` on an order is a plain number
   (`inputUSD: "3987"` for a ~$3,988 order).
6. **Status is a snapshot; `statusMetadata` is the history.** An order currently `REDEEMED` also
   passed through `PLACED` and `FILLED`, and only `statusMetadata` has those timestamps.
7. **`REFUNDED` orders are real demand that went unserved.** Excluding them from your denominator
   turns a fill-rate metric into a tautology.

---

## Where we read this from

| What | Endpoint |
|---|---|
| Nexus indexer | `https://nexus.indexer.polytope.technology/` — GraphQL, public, no key |
| Intent orders | `iOrderV3s(first:, orderBy: BLOCK_TIMESTAMP_DESC, filter: {...})` |
| Order lifecycle | the `statusMetadata` connection on each order |
| Fills and settlement | `fills`, `partialFills`, `escrowReleases`, `escrowRefunds` connections |
| ISMP messages | `requestV2s`, `responseV2s`, `getRequestV2s`, `getResponses` |
| Light client advances | `stateMachineUpdateEvents { stateMachineId chain height }` |
| Relayers | `relayerV2s`, `relayerStatsPerChainV2s`, `relayerActivities`, `hyperbridgeRelayerRewards` |
| Pre-computed volume | `cumulativeIntentGatewayVolumeUSDs`, `dailyVolumeUSDs`, `intentGatewayTokenVolumes` |
| Prices used by the indexer | `tokenPrices`, `tokenPriceLogs` |
| Hyperbridge parachain itself | State machine id `POLKADOT-3367`; reachable as a normal Polkadot parachain over RPC |

Introspection works (`{ __schema { queryType { fields { name } } } }`, `{ __type(name: "IOrderV3") { fields { name } } }`),
which is the fastest way to check whether a field still exists before writing a query against it.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Hyperbridge](https://hyperbridge.network/)
- [Hyperbridge documentation](https://docs.hyperbridge.network/)
- [Hyperbridge documentation — protocol overview](https://docs.hyperbridge.network/protocol/)
- [Intent Gateway V2: two-dimensional intents](https://blog.hyperbridge.network/intent-gateway-v2/)
- [From AbokiFX to HyperFX](https://blog.hyperbridge.network/from-abokifx-to-hyperfx-instant-fx-settlement-built-on-stablecoin-rails/)
- [Hyperbridge blog](https://blog.hyperbridge.network/)
- [Polkadot Wiki — Hyperbridge overview](https://wiki.polkadot.network/docs/learn-hyperbridge)
- [polytope-labs/hyperbridge on GitHub](https://github.com/polytope-labs/hyperbridge)
- [Hyperbridge (Nexus) on parachains.info](https://parachains.info/details/hyperbridge_nexus)
