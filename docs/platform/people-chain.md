# People Chain

The People Chain is the Polkadot system parachain at **para id 1004** whose only job is identity. When
`pallet-identity` and all of its data were moved off the relay chain, this is where they went. If you
want to turn an address like `1zugca…` into "Web3 Foundation" or "Jaco", the People Chain is the only
place that answer exists on Polkadot — it is not on the relay chain and it is not on
[Asset Hub](asset-hub.md).

It is also the intended home of Polkadot's proof-of-personhood work ("Project Individuality"), which
is a separate system from the registrar-based identity described below and, as far as we can verify,
is not yet producing queryable state on Polkadot mainnet.

All live readings below are from `https://polkadot-people-rpc.polkadot.io` on **2026-08-19**
(`specName: people-polkadot`, `specVersion: 2003002`).

---

## Why identity moved off the relay chain

Identity data is bulky — display names, legal names, URLs, Matrix handles, PGP fingerprints, images —
and every byte of it sat in relay chain state, which is the most expensive state in the network
because every validator carries it and it constrains the relay chain's block size. It also has nothing
to do with the relay chain's actual job of validating parachains.

Moving it to a dedicated system chain shrank the relay chain, and gave identity its own coretime and
its own upgrade cadence. The relay chain's `Identity` pallet prefix now returns **no keys**
(*verified live 2026-08-19*), and neither does Asset Hub's.

## What is stored

Live entry counts on 2026-08-19:

| Storage item | Entries | What it is |
|---|---|---|
| `Identity::IdentityOf(AccountId32)` | 3,054 | The registration: judgements, deposit, and the identity fields |
| `Identity::SubsOf(AccountId32)` | 335 | For a "super" account: the deposit it holds and the list of its sub-accounts |
| `Identity::SuperOf(AccountId32)` | 923 | For a "sub" account: its super account and its local name |
| `Identity::Registrars` | 7 registrars | A single `Vec<Option<RegistrarInfo>>` |
| `Identity::UsernameInfoOf(Username)` | 421 | The username system: username → owner |
| `Identity::UsernameOf(AccountId32)` | 322 | An account's primary username |
| `Identity::AuthorityOf(AccountId32)` | 2 | Username authorities (who may grant usernames under a suffix) |

So the whole of Polkadot has roughly **three thousand** on-chain identities. This is a small dataset
and it is entirely feasible to fetch all of it and keep it in memory, which is the right approach for
an analytics tool — do not do a live RPC round trip per address.

**A trap worth naming.** `Identity::UsernameAuthorities` and `Identity::AccountOfUsername` both return
**zero keys** — they are the *old* names for the username storage, superseded by `AuthorityOf` and
`UsernameInfoOf`. Querying the old names does not error; it returns empty. Every wrong-but-plausible
storage name in Substrate fails this way, which is why "the dashboard shows nothing" is a much more
common bug than "the dashboard shows an error".

## The `IdentityOf` record, decoded by hand

The value is a `Registration`:

```
Registration {
  judgements: Vec<(RegistrarIndex: u32, Judgement)>,
  deposit:    Balance (u128),
  info:       IdentityInfo,
}
```

A real entry read live on 2026-08-19 (account `0x5c5062…2f28`):

```
04                          Vec length 1 (compact)
01000000                    RegistrarIndex = 1
02                          Judgement::Reasonable
20b1cf7700…00               deposit = 2,010,000,672 planck ≈ 0.201 DOT
05 4a61636f                 Data::Raw(4)  = "Jaco"                      -> display
16 44616e69…6666            Data::Raw(21) = "Daniel Jacobus Greeff"     -> legal
1a 68747470…6772            Data::Raw(25) = "https://github.com/jacogr" -> web
19 406a6163…2e696f          Data::Raw(24) = "@jacogr:matrix.parity.io"  -> matrix
00 00 00 00 00 00           six empty fields
```

Two encodings you have to know to read this at all:

**`Data`** is an enum where the discriminant carries the length:

| Byte | Meaning |
|---|---|
| `0x00` | `None` |
| `0x01`–`0x21` | `Raw(n)` where `n = byte − 1`, so `0x01` is a zero-length string and `0x21` is 32 bytes |
| `0x22` | `BlakeTwo256(hash)` |
| `0x23` | `Sha256(hash)` |
| `0x24` | `Keccak256(hash)` |
| `0x25` | `ShaThree256(hash)` |

The hashed variants exist so an identity can *commit* to a value without publishing it. If you are
extracting display names, you must handle the case where the display name is a hash and there is no
string to show. Rendering `0x22…` as a name is wrong; rendering it as blank is right.

**`IdentityInfo`** on the People Chain is ten `Data` fields in this order:

```
display, legal, web, matrix, email, pgp_fingerprint, image, twitter, github, discord
```

`pgp_fingerprint` is `Option<[u8; 20]>` rather than `Data`, so it encodes as a bare `0x00` when absent.
The order is positional and there are no field names in the encoding — miscount one field and every
subsequent value is attributed to the wrong label. The decode above lines up exactly (four populated,
six empty) which is how you know the field list is right.

Note there is no `additional` field. The relay chain's older `IdentityInfo` carried an
`additional: Vec<(Data, Data)>` of arbitrary key/value pairs; the People Chain version dropped it in
favour of named fields. Historical relay-chain identity data from before the migration therefore has a
*different shape* than People Chain data.

## Judgements and registrars

An identity is self-asserted. Anyone can call `Identity::set_identity` and claim to be anyone. What
makes an identity trustworthy is a **judgement** from a **registrar**.

The flow:

1. The user calls `set_identity(info)`, reserving a deposit (a base amount plus a per-byte amount).
2. The user calls `request_judgement(reg_index, max_fee)`, naming a registrar and the most they are
   willing to pay. A registrar whose fee exceeds `max_fee` cannot take the job. The fee is reserved.
3. The registrar does whatever off-chain verification it does — Matrix challenge, email round-trip,
   Twitter/GitHub proof, or a formal KYC process.
4. The registrar calls `provide_judgement(reg_index, target, judgement, identity_hash)`. The
   `identity_hash` binds the judgement to the *exact* identity data that was judged.

`Judgement` variants, in encoding order:

| Index | Variant | Meaning |
|---|---|---|
| 0 | `Unknown` | No judgement yet (the default) |
| 1 | `FeePaid(Balance)` | Fee is held, judgement in progress |
| 2 | `Reasonable` | Data looks plausible; no formal verification |
| 3 | `KnownGood` | Registrar certifies the data is correct |
| 4 | `OutOfDate` | Was good, no longer is |
| 5 | `LowQuality` | Imprecise but fixable |
| 6 | `Erroneous` | Wrong, possibly deliberately |

`KnownGood` and `Reasonable` are "sticky": the deposit and judgement survive, and **if the user
changes their identity, sticky judgements are cleared**. That is the `identity_hash` binding doing its
job. A judgement always refers to specific bytes, never to an account in the abstract.

There are **7 registrars** on Polkadot as of 2026-08-19 (read from the single `Identity::Registrars`
value, a `Vec<Option<RegistrarInfo>>` of 400 bytes: one compact length byte plus 7 × 57 bytes of
`Some(account, fee, fields)`). Registrars are added by governance. The `Option` matters — a removed
registrar leaves a `None` hole so that existing `RegistrarIndex` values in judgements do not shift.

**The failure mode for analytics.** "This address has an identity" and "this address has a *verified*
identity" are very different claims. Displaying a self-asserted display name with no judgement, styled
identically to a `KnownGood` one, is how impersonation works. If you render identities, render the
judgement.

## Sub-identities

A sub-identity lets one entity register many addresses under one name — an exchange with hot wallets,
a validator operator with several nodes.

- The super account calls `set_subs(vec![(sub_account, Data)])`, paying an additional deposit per sub.
- `SubsOf(super) -> (deposit, Vec<AccountId32>)`
- `SuperOf(sub) -> (AccountId32, Data)` — the super's address and the sub's *local* name.

An account may have up to **100** sub-accounts.

Resolution rule: a sub-account has **no identity of its own**. To display a name for it you must read
`SuperOf(sub)` to get `(super, local_name)`, then read `IdentityOf(super)` to get the display name, and
present it as something like `Super/local_name`. Live counts show 923 subs against 335 supers, so
roughly a quarter of all named things on the People Chain are subs. **A resolver that only reads
`IdentityOf` will silently fail to name 923 accounts.**

## Usernames

Newer than the registrar system and structurally different. Instead of a self-asserted string judged by
a registrar, a **username authority** is granted a suffix by governance and may allocate names under
it.

- `AuthorityOf(AccountId32) -> AuthorityProperties { suffix, allocation }` — 2 authorities live.
- `UsernameInfoOf(Username) -> UsernameInformation { owner, provider }` — 421 entries. The storage key
  is the raw username bytes, SCALE-length-prefixed.
- `UsernameOf(AccountId32) -> Username` — an account's chosen primary username, 322 entries.

Real keys read live on 2026-08-19, with the compact length prefix stripped: `radha.id`,
`certified.dot`, `0000000000test01.dot`. So both `.dot` and `.id` suffixes are in use.

Because the authority controls the suffix, a username is closer to a DNS name than to a self-asserted
identity: `alice.dot` means something because whoever runs the `.dot` authority says so. Note this is
*not* the same system as DotNS `.dot` domains used for app publishing on the Products Devnet — see
[bulletin.md](bulletin.md). Same string, different registry; do not join them.

## Proof of personhood

Polkadot's identity pallet answers "what is this account called". Proof of personhood answers a
different question: "is there exactly one human behind this?" — the sybil-resistance problem that
matters for any per-person allocation, quadratic voting, or airdrop.

The programme is called **Project Individuality**. What we can state:

- It is designed to run on the People Chain and be governed by Polkadot's own governance.
- It uses zero-knowledge cryptography and **Bandersnatch Ring VRFs** to produce *contextual aliases*:
  a person can prove membership of the personhood set and derive a per-context pseudonym, without the
  contexts being linkable to each other or to their real identity. No KYC.
- It is described in two tiers: **DIM1** (proof of individuality) and **DIM2** (proof of *verified*
  individuality), with DIM1 the lighter-weight one.
- Reported roadmap has DIM1 in Q1 2026, DIM2 in Q2 2026, and full mainnet deployment in Q3 2026.

**What we could verify on-chain, and it is a negative result:** on 2026-08-19 the Polkadot People Chain
returns **no storage keys** under the `People`, `ProofOfInk` or `MobRule` pallet prefixes. Either those
pallets are not in the runtime, or they are present with empty storage. Either way, **proof of
personhood is not producing data you can query on Polkadot mainnet today**, and any claim that it is
live should be treated as unverified. Roadmap dates for this programme have slipped before.

## Resolving an address to a name, in practice

The algorithm an analytics tool should implement:

1. Fetch **all** of `Identity::IdentityOf`, `Identity::SuperOf` and `Identity::UsernameOf` from the
   People Chain once, and refresh periodically. Three thousand entries is nothing.
2. For an address:
   - If `IdentityOf` has an entry, take `info.display`. If it is a `Raw` variant, decode as UTF-8. If
     it is a hash variant, treat as no name.
   - Else if `SuperOf` has an entry, resolve the super's display name and render `Super/sub_name`.
   - Else if `UsernameOf` has an entry, use the username.
   - Else, no name — show the truncated address.
3. Alongside the name, carry the best judgement (`KnownGood` > `Reasonable` > everything else) so the
   UI can distinguish verified from self-asserted.

Two more things that will bite you:

- **SS58 encoding.** The same 32-byte public key renders as a different string on every chain: prefix
  0 on the relay chain and Asset Hub, prefix 63 on Hydration, and so on. Store and join on the raw
  32 bytes; format to SS58 only at the point of display, and say which prefix you used.
- **Identities are not on the chain you are analysing.** If you are looking at Hydration trades, the
  swapper's identity lives on the People Chain, and the two are joined only by the raw account bytes.
  An address that is Ethereum-derived (see [smart-contracts.md](smart-contracts.md) — ends in twelve
  `0xEE` bytes) will never have a People Chain identity.

---

## Where we read this from

| What | Endpoint / storage |
|---|---|
| RPC | `https://polkadot-people-rpc.polkadot.io` (public, no key). `specName: people-polkadot` |
| Identities | `Identity::IdentityOf(AccountId32) -> Registration` |
| Sub-identities | `Identity::SubsOf(AccountId32)`, `Identity::SuperOf(AccountId32)` |
| Registrars | `Identity::Registrars -> Vec<Option<RegistrarInfo>>` (single value) |
| Usernames | `Identity::UsernameInfoOf(Username)`, `Identity::UsernameOf(AccountId32)`, `Identity::AuthorityOf(AccountId32)` |
| Extrinsics | `Identity.set_identity`, `.request_judgement`, `.provide_judgement`, `.set_subs`, `.clear_identity`, `.set_username_for` |
| Events | `Identity.IdentitySet`, `.JudgementGiven`, `.JudgementRequested`, `.IdentityCleared`, `.SubIdentityAdded`, `.UsernameSet` |
| Bulk fetch | `state_getKeysPaged` over the `Identity` prefixes, then `state_queryStorageAt` in batches |

`Identity` has **no** keys on the Polkadot relay chain or on Asset Hub — *verified live 2026-08-19*.
Historical identity data from before the migration is on the relay chain, in the older `IdentityInfo`
shape with an `additional` field.

Operational detail for these endpoints — rate limits, caching policy, and the known
quirks of each — lives in [data-sources.md](data-sources.md).

## Further reading

- [Polkadot Wiki — Account identity](https://wiki.polkadot.com/learn/learn-identity/)
- [Polkadot Wiki — Identity management with Polkadot-JS](https://wiki.polkadot.network/learn/learn-guides-identity/)
- [Polkadot Developer Docs — People and identity](https://docs.polkadot.com/reference/polkadot-hub/people-and-identity/)
- [Polkadot Support — how to set and clear an identity](https://support.polkadot.network/support/solutions/articles/65000181981-how-to-set-and-clear-an-identity)
- [Polkadot Support — how to request and cancel identity judgement](https://support.polkadot.network/support/solutions/articles/65000181990-how-to-request-and-cancel-identity-judgement)
- [Proof of Personhood — Project Individuality (polkadot.network blog)](https://polkadot.network/blog/proof-of-personhood-polkadot-project-individuality/)
- [proofofpersonhood.how](https://www.proofofpersonhood.how/)
- [Polkadot Blockchain Academy — identity and proof of personhood](https://pbax.polkadot.academy/course/identity-and-proof-of-personhood)
- [w3f/polkadot-registrar-challenger — how a registrar actually verifies](https://github.com/w3f/polkadot-registrar-challenger)
