# Polkadot Bulletin Chain

The Bulletin Chain is a Substrate chain whose only job is to **store bytes**. You submit data in a
transaction, the chain computes an IPFS-compatible content identifier for it, indexes it, and
guarantees to keep it retrievable for a fixed number of blocks — a *lease*. It is not a general
smart-contract chain and it has no assets to speak of; it is a content-addressed blob store with an
on-chain index, and its nodes are IPFS peers.

Its practical role in 2026 is as the storage layer for the **Polkadot Products Devnet**: you upload a
web app's static bundle to the Bulletin Chain, point a `.dot` domain at the resulting CID via DotNS,
and the app resolves and loads with no DNS and no hosting provider.

Dates below are as of **2026-08-19**. Note carefully which chain each measurement comes from — there
is more than one deployment and they do not have the same parameters.

---

## Two chains, easily confused

| Endpoint | `specName` | Notes |
|---|---|---|
| `https://bulletin-paseo.tservices.es:8443` | `bulletin-paseo`, specVersion **2003001** | The **Products Devnet** Bulletin chain. This is the one the devnet's `.dot` publishing flow writes to. `system_chain` returns `Bulletin Paseo` |
| `https://paseo-bulletin-next-rpc.polkadot.io` | `bulletin-paseo`, specVersion **1000025** | A **different** chain despite the identical `specName`. `system_chain` returns `Paseo Bulletin Next` |

They share a `specName`, a runtime lineage and therefore a storage layout, but **not their constants,
not their block rate, and not their data**. Pointing an indexer at the wrong one produces a
plausible-looking, entirely unrelated dataset.

**`specName` alone cannot tell them apart — both report `bulletin-paseo`.** Discriminate on
`specVersion` (2003001 vs 1000025) or on `system_chain`, and record which one a dataset came from.

A practical note on availability: the Products Devnet node is a **single point of failure and it does
go down** — it was unreachable for several minutes during testing on 2026-08-19, and answering
normally later the same day. Anything reading this
chain should treat "cannot reach the node" as an ordinary state to be surfaced, not an error to retry
through. There is no second provider to fail over to.

*(We could not reach the `:8443` endpoint from the environment these docs were written in — port 8443
egress is blocked there, confirmed against a control host. Measurements below attributed to the
Products Devnet were taken by the repository operator on 2026-08-19; measurements attributed to Paseo
Bulletin Next were taken directly while writing this document.)*

## Content-addressed transaction storage

The core pallet is `TransactionStorage` (`bulletin-transaction-storage` in the type registry). The
model differs from ordinary blockchain state in an important way:

- **The data is not in state.** It is in the transaction body. Full state does not grow with every
  upload; the chain keeps an *index* in state and the bytes live in block bodies, erasure-coded into
  chunks.
- **The chain proves it still has the data.** Nodes must periodically produce a storage proof over a
  randomly selected chunk of a still-leased transaction. A node that has discarded the data cannot
  produce the proof.
- **Retrieval is off-chain.** The architecture is "write to chain, read from network": you get a CID
  from the chain and fetch the bytes over IPFS from the collators, which are IPFS peers, or via a
  gateway. Nothing serves you a 2 MiB blob over JSON-RPC.

### `TransactionStorage::Transactions`

```
Transactions: StorageMap<Blake2_128Concat, BlockNumber (u32), Vec<TransactionInfo>>
```

Keyed by the block in which the data was stored, valued with one `TransactionInfo` per storing
extrinsic in that block. So the index is **block-major, not CID-major** — see "Finding a CID" below,
because this is the single most awkward property of the design.

`TransactionInfo` is **86 fixed bytes**. Field names below are as they appear in the runtime's own
type registry (read live from `state_getMetadata` on Paseo Bulletin Next, 2026-08-19):

| Offset | Bytes | Field | Type |
|---|---|---|---|
| 0 | 32 | `chunk_root` | `<BlakeTwo256 as Hash>::Output` — Merkle root over the erasure-coded chunks |
| 32 | 32 | `content_hash` | `ContentHash` — the digest of the content itself |
| 64 | 1 | `hashing` | `HashingAlgorithm`: `Blake2b256`, `Sha2_256` |
| 65 | 8 | `cid_codec` | `CidCodec`, little-endian u64 — the IPFS multicodec |
| 73 | 4 | `size` | u32, content length in bytes |
| 77 | 4 | `extrinsic_index` | u32, which extrinsic in the block carried it |
| 81 | 4 | `block_chunks` | `ChunkIndex` (u32) |
| 85 | 1 | `meta` | carries the `EntryKind`: `Store` = 0, `Renew` = 1 |

Because every entry is exactly 86 bytes, a `Vec<TransactionInfo>` decodes as a compact length prefix
followed by *n* × 86 bytes with no per-item framing. That makes bulk decoding trivial and also makes
it trivially easy to be off by one and misread every field — verify by checking that
`(len(value) − prefix) % 86 == 0` before you trust anything.

Real entries decoded live from Paseo Bulletin Next on 2026-08-19:

| Block | `hashing` | `cid_codec` | `size` | `extrinsic_index` | `block_chunks` | `meta` |
|---|---|---|---|---|---|---|
| 1,315,225 | 1 (`Sha2_256`) | 85 | 59 | 2 | 1 | 0 (`Store`) |
| 1,385,201 | 0 (`Blake2b256`) | 85 | 141 | 2 | 1 | 0 (`Store`) |
| 1,385,156 | 0 (`Blake2b256`) | 85 | 136 | 2 | 1 | 0 (`Store`) |

### CIDs

The chain does not store a CID string. It stores the ingredients, and you assemble the CID:

```
CIDv1 = <version=1> <cid_codec> <multihash>
multihash = <hash function code> <length> <content_hash>
```

- `cid_codec` 85 (`0x55`) is the **raw** multicodec — the bytes are the content, unstructured.
- `cid_codec` 112 (`0x70`) is **dag-pb** — the content is an IPFS UnixFS DAG, which is what you get
  when a file was chunked by an IPFS implementation rather than stored whole.
- `hashing` selects the multihash function: blake2b-256 (`0xb220`) or sha2-256 (`0x12`).

On the Products Devnet the split observed on 2026-08-19 was **3,805 raw to 1,000 dag-pb**. That
matters because a raw CID addresses exactly the bytes in the transaction, whereas a dag-pb CID
addresses a root node whose children may be stored separately. If you are reconstructing files, you
cannot treat the two identically.

The `Stored` event emitted by the pallet carries the CID and the index, which is the easy path; the
storage decode above is the path for backfilling history.

## Store, Renew, and leases

Two operations:

- **`store(data)`** — submits new bytes. The chain indexes them and starts a lease from the current
  block. Emits `Stored` with the CID and the `(block, index)` pair.
- **`renew(block, index)`** — extends the lease on data already on chain, identified by where it was
  first stored. It does **not** re-upload the bytes.

The lease length is `RetentionPeriod`, a runtime constant measured in blocks, documented in the
runtime as "Number of blocks for which stored data must [be retained]". On the Products Devnet it is
**201,600 blocks**.

**How long is that in wall-clock time?** Blocks, not seconds, are what the chain counts, so this
conversion is the soft part of every expiry calculation. **The two deployments run at measurably
different rates, and one of them is not even stable across window lengths.** Do not average them and
do not carry a figure between them.

Method for every number below: read `Timestamp::Now` at two heights via `chain_getBlockHash` +
`state_getStorageAt` and divide by the block delta. On-chain timestamps only — never a wall clock.

**Paseo Bulletin Next (specVersion 1000025), 2026-08-19.** Stable at every timescale: 6.000 s/block
over the last 10 blocks, 6.027 over 50,000, **6.077 over a full 201,600-block window** — a lease of
about **14.2 days**.

**Products Devnet (specVersion 2003001), 2026-08-19, anchor block 555,749.** Slower than nominal, and
strongly **monotonic** — the shorter the window, the slower the rate. See why, below the table:

| Window (blocks) | s/block | 201,600 ≈ |
|---:|---:|---:|
| 100 | 9.060 | 21.14 d |
| 1,000 | 7.980 | 18.62 d |
| 50,000 | 7.203 | 16.81 d |
| **201,600 (full window)** | **6.752** | **15.75 d** |

Measured independently by two agents on the same day, agreeing to the third decimal at the full
window. A real difference between the chains, not noise.

**The monotonicity is not noise — the chain is progressively slowing.** Cumulative windows all share
an endpoint, so they smear. Measuring *disjoint* segments instead shows the trend directly
(anchor 555,817, reproduced independently by two agents):

| Segment (older → newer) | s/block |
|---|---:|
| head−201,600 … head−175,000 | 6.683 |
| head−175,000 … head−150,000 | 6.370 |
| head−75,000 … head−50,000 | 6.970 |
| head−25,000 … head−10,000 | 7.389 |
| head−500 … head | 8.008 |

Roughly 6.4-6.7 s in the older half of the window, 7.4-8.0 s recently. The cumulative ladder above is
this same trend seen through a widening window.

**So any single rate is a trailing average with a timestamp on it, not a property of the chain.** This
also explains a figure recorded in `server/sources/bulletin-chain.js` as 6.457 against today's 6.752:
both were correct when taken, and a trailing 200k average necessarily rises as slow blocks enter the
window. Do not treat two such numbers as disagreeing measurements to be averaged or ranged.

Two figures are recorded here so they do not come back. An estimate of ~5.9 s/block was derived from a
wall-clock gap over 143 blocks: **refuted, not merely imprecise** — those blocks took ~18 minutes, not
the ~14 eyeballed. And an earlier revision of this document carried `6.747` attributed only to "a
measurement", cited elsewhere before anyone checked. **Record the method and window beside any rate.**

**What to do with it.**

- **Plan ingestion against nominal, ~14.06 days — not the trailing average.** Retention is denominated
  in *blocks*, so the hazard is the chain running **fast** and burning the window in less wall-clock
  time. Nothing observed sustains faster than nominal, so nominal is the floor; planning against
  today's 15.75 d would leave no margin if the chain caught up.
- **A daily snapshot has roughly 14x margin** against that floor. That margin, not any rate figure, is
  the load-bearing argument — resolve none of the above and daily is still correct.
- **Display expiry as a range**, from a rate measured recently on the chain you are reading.

**Renewal is in use, not theoretical.** A full index read of the Products Devnet on 2026-08-19 found
**20 entries with `meta = Renew`** out of 4,805 objects. Earlier tooling built against this chain
asserted in its own source that no lease had ever been renewed and every entry was `Store`; that is no
longer true, and any decoder that special-cases the `meta` byte to a constant will now be wrong. Renewal
is also the mechanism by which data becomes effectively permanent: a renewed object is held against
the runtime's `MaxPermanentStorageSize` cap rather than aging out, so the chain has a bounded budget
for data that never expires.

A renewal produces a **new** `(block, index)` pair, reported in the `Renewed` event. Subsequent
renewals must reference the latest pair, not the original. Track the current pair, not the first one,
or your second renewal will fail against a lease that has already moved.

### Authorization

You cannot simply submit a `store` — the chain grants accounts an allowance first, in transactions and
in bytes, and that grant is issued by a privileged origin. On the devnet it comes from the console
faucet; you cannot self-authorize programmatically. The relevant storage is
`TransactionStorage::Authorizations`, and a separate constant, `AuthorizationPeriod`, controls how long
a grant lasts — **201,600 blocks on both chains**. That is the same number people quote for the
retention period, and it is a different constant governing a different thing. See the warning below.

### Limits and fees

Both chains cap a single transaction at `MaxTransactionSize` = **2 MiB** and a block at
`MaxBlockTransactions` = **512** (tabulated with the other constants below). Fee storage read live on
Paseo Bulletin Next on 2026-08-19: `TransactionStorage::ByteFee` = 10, `EntryFee` = 1,000.

Larger files must be chunked client-side and stitched together with a dag-pb root. The largest single
object on the Products Devnet was 2 MiB — exactly at the cap, so the cap is binding in practice.

## What is actually on the chain

Products Devnet, full index read on 2026-08-19. Every figure here is a **point-in-time inventory of
currently-leased data**, not a cumulative total — see the pruning result below, which was established
after these numbers were taken:

| Measure | Value |
|---|---|
| Objects | 4,805 |
| Blocks that stored something | 4,019 |
| Total bytes | 1.55 GiB |
| Distinct `content_hash` values | 4,530 |
| Content stored two or more times | 122 pieces (one of them 20 times) |
| Bytes attributable to re-stores | 247 MiB |
| Largest single object | 2 MiB |
| Codec split | 3,805 raw / 1,000 dag-pb |
| Entries with `meta = Renew` | 20 |

Later readings of the same chain on 2026-08-19, at roughly 14-minute spacing:

| Probe | Head | Storage keys |
|---|---:|---:|
| A | 555,536 | 4,002 |
| B | 555,679 | 3,991 |

**The index is pruned at the retention boundary. This is settled, not a hypothesis.** Between the two
probes the head advanced 143 blocks while the key count *fell by 11* — expirations outrunning new
stores. Probe B's populated range confirms the mechanism directly:

```
oldest storing block   354,084
newest storing block   554,723
span                   200,639 blocks   (RetentionPeriod = 201,600)
head − RetentionPeriod 354,079          → oldest sits 5 blocks past the edge
```

The populated window is 200,639 blocks against a 201,600-block retention period, and the oldest
surviving entry sits 5 blocks inside the boundary. Nothing older exists.

Three consequences, in descending order of how much they should change your plans:

1. **Leased history cannot be reconstructed retroactively.** At 201,600 blocks and a measured
   6.08-6.75 s per block depending on the chain, anything not ingested within **14 to 16 days** is
   gone and exists nowhere else. Of every source this project reads, Bulletin is the smallest and by
   far the most *urgent* to persist: Hydration's deep history is merely awkward to fetch and will
   still be there next month. Snapshot early, snapshot on a schedule.
   **One qualifier:** renewed objects are held permanently and are *not* pruned —
   `TransactionStorage::PermanentStorageUsed` read 104,087,942 bytes (99.3 MiB) on 2026-08-19,
   against a 1 TiB `MaxPermanentStorageSize` cap, so 0.0095% consumed. That tier can be fetched at
   leisure. The urgency applies to the retention-window storage, which is the bulk and the part the
   index enumerates.
2. **A full scan enumerates currently-leased objects, never everything ever stored.** Counts derived
   this way are a live inventory, not a cumulative total, and they can legitimately go *down*. Do not
   present such a series as "objects stored to date"; it is "objects currently leased". The earlier
   4,019 reading fits the same decay curve and was never anomalous.
3. **The boundary is 201,600 blocks**, matching the `RetentionPeriod` value read from state — but
   read the warning below on *how* that value is stored, which matters more than the number.

### `RetentionPeriod` is 201,600 — and it is mutable state, not a constant

This gets its own heading because `201_600` is hard-coded in this project, and the way it is stored
matters more than its value.

**Why it is not in the metadata.** `RetentionPeriod` is **not a runtime constant**. The
`TransactionStorage` constants are `MaxBlockTransactions` (512), `MaxTransactionSize` (2 MiB),
`MaxPermanentStorageSize` (1 TiB), `AuthorizationPeriod` (201,600), `StoreRenewPriority`,
`StoreRenewLongevity` (14,400) and `RemoveExpiredAuthorizationPriority`. `RetentionPeriod` is absent
because it lives in **storage**, and storage values never appear in metadata — so a byte search of the
blob finds 201,600 exactly once, under `AuthorizationPeriod`, which is why looking there misled us.

**Read directly from state** on the Products Devnet, 2026-08-19:

```
key  twox128("TransactionStorage") ++ twox128("RetentionPeriod")
     0x0e7b504e5df47062be129a8958a7a1278d69b77f53c8c31f3b84d472fdb7de2b
raw  0x80130300  →  u32 LE = 201,600
```

Confirmed independently by two agents; the same derivation reproduces the known `Timestamp::Now` key
byte for byte, and `ByteFee` (10) and `EntryFee` (1,000) read correctly off the same pallet, so this
is not a lucky offset. It matches the observed pruning boundary to within 5 blocks.

Both `RetentionPeriod` and `AuthorizationPeriod` are 201,600 here. They remain different things
governing different mechanisms, and nothing guarantees they stay equal.

**The consequence, which is the part that matters.** A runtime *constant* can only change in a runtime
upgrade — which bumps `specVersion` and is therefore detectable. **A storage value can be changed by
governance at any time: no upgrade, no version bump, no signal of any kind.**

So a hard-coded `RETENTION_BLOCKS = 201_600` is a snapshot of mutable state: correct today, possibly
wrong next week. Were retention ever shortened, it would overstate every expiry countdown *and* the
ingest safety margin, in the same direction, with nothing in the data to reveal it.

**Read it at runtime from that storage key, cache it, and keep the literal only as a fallback.** This
is cheaper than it sounds: `server/sources/bulletin-chain.js` already imports `twox128` (line 9) and
hard-codes `RETENTION_BLOCKS` (line 42), so it is a key plus one `state_getStorage` — about three
lines, in the file that already has both, with no new dependency.

**The generalised trap: a null from a storage read never means "zero".** Three reads on this pallet
return null for three different reasons, and only one of them is "empty":

| Read | Result | Why |
|---|---|---|
| `RetentionPeriod` via *metadata constants* | absent | It is a storage value, not a constant |
| `MaxPermanentStorageSize` via *storage* | null | It is a constant, not a storage value |
| `MaxPermanentStorageUsed` via storage | null | No such item — the real name is `PermanentStorageUsed` |

A misspelled item, a constant read as storage, and a storage value sought in metadata all look
identical from the caller's side: a quiet `null`. Before concluding a counter is zero, confirm the
item exists and confirm which of the two places it lives in.

The duplication figure is worth dwelling on. **Content addressing does not deduplicate storage here.**
The same bytes stored twice produce the same CID but two separate `TransactionInfo` entries, two
leases, and two copies of the bytes in two block bodies — 247 MiB of the 1.55 GiB total, about 16%.
If you report "data stored on Bulletin", say whether you mean object-bytes or distinct-content-bytes,
because they differ by a sixth. Deduplicating by `content_hash` is the right move for "how much unique
content is here" and the wrong move for "how much is the chain carrying".

Equally: an object appearing 20 times is almost certainly a redeploy loop — the same app bundle
published over and over — not twenty independent users.

## The Polkadot Products Devnet

The Bulletin Chain is one service in a stack assembled by the **Polkadot Community Foundation** and
opened as a public devnet in July 2026. The pieces:

| Service | What it does |
|---|---|
| **Bulletin Chain** | Stores the app bundle; gives you a CID and a storage authorization |
| **DotNS** | Registers `.dot` domains through a commit-reveal flow (`dotns-cli`) and points a name at a CID |
| **CDM** | Contract Dependency Manager — builds, deploys and registers PolkaVM contracts on Asset Hub by name. See [smart-contracts.md](smart-contracts.md) |
| **Identity** | Account identity via the platform SDK. See [people-chain.md](people-chain.md) |
| **`dev-dot.li` gateway** | Resolves and serves published apps in an ordinary browser at `https://<name>.dev-dot.li` |

The publishing flow is: build a static bundle → obtain a storage authorization → `store` the bundle on
Bulletin → register or update a `.dot` name in DotNS to point at the CID → the app is reachable at
`name.dot` inside the Polkadot app and at `https://name.dev-dot.li` outside it. Resolution is
client-side and trustless: the name resolves on-chain, the content loads from Bulletin/IPFS, and the
CID is verified against the bytes. There is no origin server to trust or to take down.

Two caveats to keep front of mind:

1. **It is a devnet.** Tokens have no value, chains and services may be reset, and flows change between
   builds. Nothing here is a Polkadot-mainnet-secured guarantee.
2. **`.dot` here is not the `.dot` on People Chain.** The People Chain's `Identity` username system also
   issues names with a `.dot` suffix (we read `certified.dot` out of `UsernameInfoOf` live on
   2026-08-19). DotNS domains and People Chain usernames are separate registries that happen to share a
   string suffix. Joining them would be wrong.

## Reading the chain

### Finding a CID

The index is keyed by block number, so there is no "look up this CID" query. To answer "is this CID
stored, and until when", you must either:

- have kept the `(block, index)` pair from the `Stored`/`Renewed` event, or
- **scan**: page `state_getKeysPaged` over the `TransactionStorage::Transactions` prefix, fetch each
  value, decode the 86-byte records, and build your own `content_hash → (block, index)` map.

At ~4,000 keys and 4,805 records the full scan is cheap — measured at five key pages in about 1.1
seconds on 2026-08-19. Build the reverse index once, keep it, and update it forward from the head.
Do not answer per-CID queries by scanning on demand.

The storage key itself is `blake2_128(block_number_le) ++ block_number_le`, so the block number is
recoverable from the last 4 bytes of the key without a second round trip — useful when paging keys,
because it lets you compute lease expiry before you fetch any values.

### Expiry

`expires_at_block = stored_at_block + RetentionPeriod`, where `stored_at_block` is the block of the
**most recent** `Store` or `Renew` for that content. Convert to wall-clock with a block rate measured
recently **on that same chain** — not the nominal 6.030 s, and not a rate carried over from the other
deployment, which differs by up to 11%.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| Products Devnet RPC | `https://bulletin-paseo.tservices.es:8443` (non-standard port; may be blocked by some networks; single point of failure) |
| Paseo Bulletin Next RPC | `https://paseo-bulletin-next-rpc.polkadot.io` — a *different* chain, `specName: bulletin-paseo` |
| The index | `TransactionStorage::Transactions(BlockNumber) -> Vec<TransactionInfo>`, 86 bytes per record |
| Upload allowance | `TransactionStorage::Authorizations` |
| Fees | `TransactionStorage::ByteFee`, `TransactionStorage::EntryFee` |
| Permanent tier usage | `TransactionStorage::PermanentStorageUsed` (storage). Its cap `MaxPermanentStorageSize` is a *constant* — reading that name from storage returns null, which does not mean zero |
| Constants | `AuthorizationPeriod`, `MaxTransactionSize`, `MaxBlockTransactions`, `MaxPermanentStorageSize`, `StoreRenewLongevity` — via `state_getMetadata` |
| **Retention period** | **`TransactionStorage::RetentionPeriod` — a STORAGE value, not a constant.** Key `0x0e7b504e5df47062be129a8958a7a1278d69b77f53c8c31f3b84d472fdb7de2b`. Read it at runtime; governance can change it without a `specVersion` bump |
| Real block rate | `Timestamp::Now` read at two heights via `chain_getBlockHash` + `state_getStorageAt`, divided by the block delta. Use a window of days, not minutes, and never your own wall clock |
| Extrinsics | `transactionStorage.store(data)`, `transactionStorage.renew(block, index)` |
| Events | `TransactionStorage.Stored { cid, index }`, `TransactionStorage.Renewed` |
| Content retrieval | IPFS, by CID, from collators or a gateway — **not** over JSON-RPC |
| Published apps | `https://<name>.dev-dot.li` |

No API keys, no credentials. Everything above is public and anonymous.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [paritytech/polkadot-bulletin-chain](https://github.com/paritytech/polkadot-bulletin-chain)
- [Polkadot Developer Docs — store and retrieve data on the Bulletin Chain](https://docs.polkadot.com/chain-interactions/store-data/bulletin-chain/)
- [Polkadot Developer Docs — data storage](https://docs.polkadot.com/reference/polkadot-hub/data-storage/)
- [Polkadot App Docs (Polkadot Community Foundation)](https://docs.polkadotcommunity.foundation/)
- [Polkadot App Docs — developer quickstart (DotNS, CDM, Bulletin)](https://docs.polkadotcommunity.foundation/getting-started/developers/)
- [paritytech/dotli-community — trustless client-side resolution](https://github.com/paritytech/dotli-community)
- [Polkadot Community Foundation on GitHub](https://github.com/Polkadot-Community-Foundation)
- [Storage chain fixes + guide (original Substrate PR)](https://github.com/paritytech/substrate/pull/9504)
