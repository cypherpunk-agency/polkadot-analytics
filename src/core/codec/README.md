# `src/core/codec` — chain byte plumbing

Hashing, SCALE decoding, SS58, multihash/CID and content sniffing. Pure functions over
`Uint8Array`, no DOM and no Node built-ins, which is what lets **the browser bundle and the
Node server import the same files** — see [docs/architecture/middleware.md](../../../docs/architecture/middleware.md).

Provenance: lifted from `yolodot/apps/bulletin-explorer`, where each constant was verified
against a live chain. The verification notes are kept in the comments on purpose; they are the
reason to trust the values, and deleting them would leave magic numbers behind.

| file | what it is |
|---|---|
| `bytes.js` | hex ↔ `Uint8Array`, little-endian u32, UTF-8. Degrades to empty on malformed input rather than throwing. |
| `xxhash.js` | `twox128`, for Substrate storage key prefixes. |
| `blake2b.js` | `blake2b`, for `Blake2_128Concat` map keys and content hashes. |
| `scale.js` | SCALE compact integers and the Bulletin `TransactionInfo` vector. |
| `ss58.js` | account id → SS58 text, per network prefix. |
| `base.js` | base32/base58 and varints, for CIDs. |
| `cid.js` | build and parse CIDv0/v1. |
| `keccak.js` | `keccak256`, for EVM-flavoured calls on Asset Hub. |
| `shapes.js` | classify stored bytes by shape, and walk dag-pb link graphs. |

**Storage keys are computed, never hardcoded.** A hardcoded prefix is right until a runtime
upgrade moves it, and then it is silently wrong — it reads as "this map is empty" rather than as
an error.
