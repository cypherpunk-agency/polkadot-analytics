# Smart contracts on Polkadot

Polkadot's smart contract story changed shape completely between 2024 and 2026. The old answer was
"contracts are a parachain concern — use `pallet-contracts` with ink! and Wasm, or use a
parachain-specific EVM like Moonbeam's". The current answer is that contracts run on **Asset Hub**
itself, in a pallet called **`pallet-revive`**, on a RISC-V virtual machine called **PolkaVM**, with an
Ethereum JSON-RPC compatibility layer in front so that Hardhat, Foundry and MetaMask work unmodified.
The older `pallet-contracts`/ink! path still exists on some parachains but is no longer the direction
of travel, and ink! itself lost its maintainers in January 2026.

Everything below is as of **2026-08-19**. Live readings are from
`https://polkadot-asset-hub-rpc.polkadot.io`; source references are to `paritytech/polkadot-sdk`
master, read on the same date.

---

## Timeline: what happened when

| When | What |
|---|---|
| 2020–2024 | `pallet-contracts` + ink! (Rust → Wasm, executed in `wasmi`). Deployed on Astar, Aleph Zero and a handful of others; never on a Polkadot system chain |
| 2024–2025 | Project Revive: compile Solidity to RISC-V rather than Wasm, and run it on PolkaVM |
| Late Dec 2025 | Runtime upgrade enabling Revive enacted on **Kusama** Asset Hub |
| **2026-01-20** | Contracts go live on **Polkadot** Asset Hub ("Polkadot Hub"), alongside 2-second block times |
| **Jan 2026** | The ink! team announces it can no longer actively maintain or develop ink! |
| 2026-08-19 | `Revive::CodeInfoOf` holds **302** code entries and `Revive::AccountInfoOf` **402** entries on Polkadot Asset Hub — *verified live* |

The 302 figure is worth internalising before writing anything triumphal: Polkadot Hub contracts are
seven months old and the deployed code base is small. Any dashboard built on it should be framed as
tracking an early ecosystem.

## PolkaVM, and why RISC-V instead of Wasm

`pallet-contracts` executed WebAssembly through `wasmi`, an interpreter. That was safe and portable
but slow, and the deeper problem was that Wasm is a *stack* machine designed for a browser sandbox:
it has structured control flow, no registers, and a memory model that makes ahead-of-time compilation
to native code awkward to do deterministically.

PolkaVM uses a **RISC-V register machine** instead. The practical arguments:

- It is a real hardware ISA, so LLVM already emits excellent code for it and the register allocator
  does its normal job. Compiling PolkaVM bytecode to x86-64 is close to a one-to-one mapping.
- Metering (gas accounting) can be inserted at basic-block boundaries rather than threaded through a
  stack discipline.
- It supports a proper **JIT** path. The stated plan is that contracts are executed by an interpreter
  inside the runtime first, with a full JIT compiler delivered later. *We could not verify from a
  primary source whether the JIT is enabled on Polkadot Asset Hub as of 2026-08-19 — assume the
  interpreter unless you have checked.*

The same choice underpins JAM, which specifies PVM as its execution environment — see
[polkadot.md](polkadot.md). Contracts and JAM converging on one VM is deliberate.

## `pallet-revive` runs two bytecodes

This is the part most summaries get wrong. `pallet-revive` is not "an EVM emulator". It is a contracts
pallet that can execute **two** kinds of code:

1. **PVM bytecode** — the native format. Solidity or Vyper is compiled by **`resolc`** along the path
   Solidity → YUL → LLVM IR → RISC-V ELF → PVM blob. Rust can target it directly.
2. **EVM bytecode** — actual EVM opcodes, executed by **`revm`** (the Rust EVM implementation), which
   `pallet-revive` depends on directly. Its `Cargo.toml` lists both `polkavm` and `revm`, and the
   pallet has a `AllowEVMBytecode: Get<bool>` config constant gating whether raw EVM bytecode may be
   uploaded and instantiated. *Verified from source; we did not verify what that constant is set to in
   the Polkadot Asset Hub runtime.*

Code size limits differ by format: PVM blobs are bounded by `limits::BLOB_BYTES`, EVM bytecode by
EIP-170's `MAX_CODE_SIZE` (24,576 bytes) — so a Solidity contract that is too big for Ethereum is
still too big here if you deploy it as EVM bytecode, but may fit if compiled to PVM.

## Addresses: H160 vs AccountId32

Substrate accounts are `AccountId32`. Ethereum accounts are `H160` (20 bytes). Contracts need both,
and the mapping between them is not symmetric. This is the highest-value detail in this document
because getting it wrong silently attributes activity to the wrong account.

The relevant code is `AccountId32Mapper` in `substrate/frame/revive/src/address.rs`:

**AccountId32 → H160 (`to_address`)**

```
if the account already ends in twelve 0xEE bytes:
    take the first 20 bytes         # it was originally an Ethereum address
else:
    H160 = keccak_256(account)[12..]  # hash first, so the public key is not truncated
```

The hash is there for a specific reason. An `sr25519`/`ed25519` account id *is* a public key; simply
truncating it to 20 bytes would throw away 12 bytes of a key and make collisions cheap to search for.
Hashing first restores the usual 160-bit security.

**H160 → AccountId32 (`to_account_id`)**

```
look up OriginalAccount[address]
    if present:  return it            # the account registered itself via Revive::map_account
    else:        return address ++ [0xEE; 12]   # the "fallback" account
```

So an Ethereum address that has never been mapped resolves to a 32-byte account consisting of the
20-byte address followed by **twelve `0xEE` bytes**. Any account you see on Asset Hub ending in
`eeeeeeeeeeeeeeeeeeeeeeee` is Ethereum-derived — a contract, or a wallet controlled by a secp256k1
key. You can spot these directly in raw storage keys.

**Registering a mapping.** Because `to_address` is lossy for native accounts, the reverse direction
needs state. `Revive::map_account` writes `OriginalAccount[to_address(account)] = account` and takes a
deposit sized for 52 bytes (20 + 32) plus one item. Without it, a native `sr25519` user who receives
tokens at their derived H160 cannot get them back out — the chain has no way to know which
`AccountId32` that H160 belongs to.

Live on 2026-08-19, `Revive::OriginalAccount` has **more than 20,000 entries** on Polkadot Asset Hub,
so mapping is being used at scale. `Revive::AddressSuffix` had no keys.

**The failure mode.** If you are attributing contract activity to users, an H160 in a contract event
and an `AccountId32` in a `Balances` event may be the same person or may not be, and you cannot tell
without reading `Revive::OriginalAccount`. Joining naively on "first 20 bytes" produces a table where
native accounts silently never match anything.

## Ethereum RPC compatibility

`pallet-revive` stores and executes contracts; it does not speak JSON-RPC. That is the job of a
separate process, the **`eth-rpc` adapter**, which sits in front of a node and translates:

- `eth_sendRawTransaction` — takes an RLP-encoded, secp256k1-signed Ethereum transaction, wraps it as
  a Substrate extrinsic, and submits it. The pallet has a dedicated origin variant
  `Origin::EthTransaction(AccountId)` for exactly this.
- `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getTransactionReceipt`, `eth_getLogs`,
  `eth_blockNumber` — served by mapping Substrate blocks, events and state onto their Ethereum shapes.
- Substrate events emitted by contracts are re-presented as Ethereum logs with topics.

The consequence is that MetaMask, ethers.js, viem, block explorers and indexers written for Ethereum
work against Asset Hub without modification. The consequence for *analysts* is that there are now two
views of the same chain — the Substrate view (extrinsics, events, `AccountId32`) and the Ethereum view
(transactions, logs, `H160`) — and they do not line up one-to-one. One Substrate block contains
Ethereum "transactions" that were never Ethereum transactions.

Gas is also translated rather than native: Polkadot prices execution in **weight** (a two-dimensional
measure of time and proof size) plus a storage deposit, and the adapter presents a gas number derived
from that. Do not assume Ethereum gas semantics hold; in particular, storage on Asset Hub is paid for
with a refundable **deposit** held on the depositor, not burnt as gas.

## Tooling

| Tool | What it does |
|---|---|
| **`resolc`** | The Solidity/Vyper → PVM compiler (the "Revive" compiler). Available as `@parity/resolc` on npm and as a binary |
| **`hardhat-polkadot`** (`@parity/hardhat-polkadot`) | Hardhat plugin: wires `resolc` in as the compiler and can spin up a local Substrate node with the `eth-rpc` adapter for testing |
| **`foundry-polkadot`** | A fork of Foundry. `forge` and `cast` work as usual; `--resolc` switches compilation from `solc` to `resolc` so the output is PVM-compatible |
| **`cdm`** | Contract Dependency Manager: builds, deploys, publishes contract metadata and registers addresses in a name registry so downstream apps can resolve a contract *by name* rather than by address. Requires a Rust toolchain (`cdm setup`). It is the contract half of the Polkadot Products Devnet — see [bulletin.md](bulletin.md) |
| **`ink-node`** | A local development node bundling `pallet-revive`, replacing `substrate-contracts-node` (which only ever supported `pallet-contracts`) |

`cdm`'s registry is the piece worth flagging for an analytics tool: if contracts are registered by
name, address→name resolution becomes a chain lookup rather than a hand-maintained CSV. As of
2026-08-19 this is a devnet service, not a Polkadot mainnet one.

## Where ink! stands

ink! is a Rust eDSL for writing contracts. Its history:

- **ink! v5** targets `pallet-contracts` and compiles to Wasm.
- **ink! v6** targets `pallet-revive` and compiles to RISC-V. It requires `cargo-contract` ≥ v6 and a
  chain that includes `pallet-revive`.
- **Since January 2026, the ink! team has stated it is unable to actively maintain or develop ink!
  further.** The wording on the project's own documentation is direct: "Since January 2026, we are
  unfortunately unable to actively maintain or develop ink! further." Issue and PR creation on the
  repository has been locked down.

So the honest position is: ink! v6 exists, works, and produces contracts that run on `pallet-revive`,
but it is unmaintained upstream. If someone asks "should I write a new Polkadot contract in ink!", the
answer as of 2026-08-19 is that Solidity via `resolc` is the supported path and ink! is a
community-maintenance question. *We have not verified whether a successor maintainer has been
appointed since January 2026.*

`pallet-contracts` itself has not been deleted from the SDK — runtimes can carry both pallets — but it
is not what Asset Hub uses and it is not receiving new features.

## How this differs from Moonbeam and the older EVM parachains

Moonbeam, Astar EVM and similar use `pallet-evm` (Frontier), which is a genuine EVM implementation
with Ethereum-style accounts as first-class citizens on a parachain built for that purpose. They have
been live for years and have real TVL.

`pallet-revive` on Asset Hub is different in three ways that matter:

1. **It is on a system chain**, so contracts sit next to DOT balances, USDC/USDT and the
   [XCM](xcm.md) machinery without a hop.
2. **PVM is the native target**; EVM bytecode is supported but is not the fast path.
3. **Accounts are Substrate accounts** with an H160 projection, rather than H160 accounts with a
   Substrate projection. Hence the mapping described above.

Both models will coexist. An analytics tool covering "Polkadot smart contracts" has to decide whether
it means Asset Hub only, or Asset Hub plus Moonbeam plus Astar, and those produce very different
numbers.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| RPC (Substrate view) | `https://polkadot-asset-hub-rpc.polkadot.io` |
| Contract code | `Revive::PristineCode(H256) -> Vec<u8>` — code hash to bytecode |
| Code metadata | `Revive::CodeInfoOf(H256) -> CodeInfo` — 302 entries on 2026-08-19 |
| Accounts and contracts | `Revive::AccountInfoOf(H160) -> AccountInfo` — "the data associated to a contract or externally owned account"; 402 entries on 2026-08-19 |
| H160 → AccountId32 mapping | `Revive::OriginalAccount(H160) -> AccountId32` — >20,000 entries on 2026-08-19 |
| Immutable contract data | `Revive::ImmutableDataOf(H160)` |
| Deployment / call extrinsics | `Revive.instantiate_with_code`, `Revive.instantiate`, `Revive.call`, `Revive.eth_transact`, `Revive.map_account` |
| Ethereum view | An `eth-rpc` adapter endpoint (`eth_getLogs`, `eth_getTransactionReceipt`, …) — availability depends on the provider, none is bundled with this repo |
| Aggregated deployments | `https://api.data.parity.io/api/contracts-deployed-heatmap` — *returned HTTP 500 when probed on 2026-08-19; treat as unavailable until re-checked* |

Note that `Revive::ContractInfoOf` has **no keys** on Polkadot Asset Hub; current `pallet-revive`
carries contract records inside `AccountInfoOf` instead. Querying the old name gets you an empty
result rather than an error, which is exactly the kind of thing that produces a confidently empty
dashboard.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Polkadot Wiki — Smart contracts on Polkadot](https://wiki.polkadot.com/learn/learn-smart-contracts/)
- [Polkadot Developer Docs — Polkadot Hub smart contracts](https://docs.polkadot.com/reference/polkadot-hub/smart-contracts/)
- [Polkadot Developer Docs — transactions and fees on Asset Hub](https://docs.polkadot.com/smart-contracts/for-eth-devs/blocks-transactions-fees/)
- [Polkadot Developer Docs — Hardhat with Polkadot Hub](https://docs.polkadot.com/smart-contracts/dev-environments/hardhat/)
- [`pallet_revive` rustdoc](https://paritytech.github.io/polkadot-sdk/master/pallet_revive/)
- [`AddressMapper` trait rustdoc](https://paritytech.github.io/polkadot-sdk/master/pallet_revive/trait.AddressMapper.html)
- [`pallet-revive` address mapping source](https://github.com/paritytech/polkadot-sdk/blob/master/substrate/frame/revive/src/address.rs)
- [ink! v6 documentation (carries the maintenance notice)](https://use.ink/docs/v6/)
- [ink! — why RISC-V and PolkaVM](https://use.ink/docs/v6/background/why-riscv-and-polkavm-for-smart-contracts/)
- [foundry-polkadot](https://github.com/paritytech/foundry-polkadot)
- [Polkadot App Docs — developer quickstart (`cdm`)](https://docs.polkadotcommunity.foundation/getting-started/developers/)
