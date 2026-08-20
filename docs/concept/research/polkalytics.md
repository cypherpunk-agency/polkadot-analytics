# Account & balance analytics — what survives, what it costs

Research sweep for the v2 concept. Everything below was **executed** on **2026-08-19** against live
endpoints, or read out of the named repo. Where I could not verify something I say so in the
[Unverified](#unverified) section rather than guessing.

Repos read (read-only): `parachain-netflows`, `subtrope`,
`subscrape`, `subflow`, `tge-data-aggregation`.

---

## 0. The three findings that reshape everything

**1. Subscan is gone.** Anonymous access to the Subscan API is *dead as of today*. Every endpoint
returns the same body:

```
$ curl -s -X POST https://polkadot.api.subscan.io/api/scan/metadata \
       -H 'Content-Type: application/json' -d '{}'
{"code": 403, "message": "Subscan API strictly requires an API key. Unauthenticated access is
 disabled. Visit https://support.subscan.io/ for details."}
```

Verified identically on `/api/scan/accounts`, `/api/v2/scan/accounts`,
`/api/scan/account/balance_history`, `/api/v2/scan/extrinsics`, and on
`kusama.api.subscan.io`. HTTP status is 400 with a `code: 403` body — a shape worth remembering,
because a naive `res.ok` check would not catch it.

**Consequence:** `subtrope` is 100 % Subscan. Not "mostly" — every one of its three job processors
calls `SubscanClient`, and Subscan now requires authentication on every request. Under our
no-secrets rule, subtrope's *data layer* is unimportable. Its *shape* is still worth stealing (§4).

**2. The balances have left the relay chain.** Polkadot's Asset Hub Migration has happened. As of
now the Polkadot relay chain holds **1,493 `System.Account` entries in total** (counted exactly, two
pages of `state_getKeysPaged`); Polkadot Asset Hub holds **≈3.9 million** (hash-space sampling, five
independent samples: 3.80M / 3.84M / 3.90M / 3.94M / 4.07M). Kusama relay is at 2,247.

The 2023 netflows study measured `System.Account` on the **relay chain**. Re-running that code today
would draw a chart of ~300 DOT per parachain and be completely, plausibly wrong. The equivalent
question today is asked of **Asset Hub**, and against a **different account derivation** (`sibl`, not
`para` — §2.2).

**3. The binary search is obsolete — and I proved it, twice.** The 2023 method (binary search on
`system.account` against an archive RPC) still works and I ran it. But SQD's public portal now serves
the full `Balances` event stream for Polkadot, Kusama and both Asset Hubs, anonymously, from block 0.
I cross-checked the two methods against each other over 20,000 Asset Hub blocks and they agree
**exactly** — and an event-derived running balance reconciles against `system.account`
**to the planck**. Details and the actual numbers in §3.

---

## 1. Endpoint inventory — verified state, 2026-08-19

| Endpoint | Anonymous? | What it gives | Verified |
|---|---|---|---|
| `https://rpc.polkadot.io` | yes | Polkadot relay, **full archive to block 1** | `Timestamp.Now` resolves at blocks 1 / 100k / 1M / 5M / 8M; `System.Account` resolves at 10M / 20M / 25M / 30M |
| `https://polkadot-asset-hub-rpc.polkadot.io` | yes | Asset Hub, **full archive** | `Timestamp.Now` resolves at 1M / 5M / 9M / 12M / 15M / 18M |
| `https://kusama-rpc.polkadot.io` | yes | Kusama relay | account enumeration ran |
| `https://kusama-asset-hub-rpc.polkadot.io` | yes | Kusama Asset Hub | `system_chain` → `"Kusama Asset Hub"` |
| `https://polkadot-people-rpc.polkadot.io` | yes | **On-chain identities** — 3,054 `Identity.IdentityOf` entries, enumerable in 4 requests | full enumeration ran |
| `https://apps-rpc.polkadot.io` | yes | Polkadot relay archive (2nd source) | archive read at block 10M ✓ |
| `https://polkadot.api.onfinality.io/public` | yes | Polkadot relay archive (3rd source) | archive read at block 10M ✓; advertises `x-ratelimit-limit-sec: 10` |
| `https://portal.sqd.dev/datasets/{polkadot,kusama,asset-hub-polkadot,asset-hub-kusama,people-chain,hydradx,acala,bifrost-polkadot,interlay,moonbeam-substrate,bridge-hub-polkadot,collectives-polkadot,…}` | yes | **filtered event/call streams from block 0**, NDJSON, gzip | see §3 |
| `https://polkadot-api.statescan.io` | yes | relay rich list, per-account transfer counts | `/accounts`, `/accounts/{addr}`, `/blocks` all 200; head block matched the node |
| `https://kusama-api.statescan.io`, `https://statemine-api.statescan.io` | yes | same for Kusama / Kusama Asset Hub | 200 |
| `https://api.data.parity.io` (Dotlake) | yes | `/api/monthly-unique-accounts`, `/api/monthly-treasury-balances`, `/api/daily-staking-*`, `/api/opengov-voter-history`, `/api/explorer/*` | see §6 |
| `https://*.api.subscan.io` | **NO** | — | 403, see §0 |
| `https://api-{chain}.moonscan.io` | degraded | works keyless at **0.195 req/s** (subscrape's own empirically-derived figure) | not re-probed |
| `https://blockscout.{chain}.moonbeam.network` | yes | no key at all | not re-probed |
| `https://rpc.ibp.network/polkadot`, `https://polkadot.dotters.network` | **no HTTP** | returned an empty body to plain JSON-RPC POST — presumably WSS-only | probed, empty |
| `https://polkadot-rpc.dwellir.com` | down | `503 Service Unavailable` | probed |
| `https://polkadot.public.curie.radiumblock.co/http` | down | Cloudflare `522` | probed |

Two operational gotchas found the hard way:

- **`polkadot-asset-hub-rpc.polkadot.io` returns `403 Forbidden` to Python's default
  `urllib` User-Agent.** Setting any real `User-Agent` fixes it. `curl` was never blocked. Our
  `lib/upstream.mjs` should always send one.
- **SQD's portal returns HTTP `529`** (overloaded) when you push it. Back off; don't retry hot.

---

## 2. The 2023 balance-history algorithm, written out to reimplement

`parachain-netflows` in the repo contains only the plotting code (`main.py`) and the resulting
CSVs — the capture code is not present. `REPORT.md` describes the method in four bullets. What
follows is that method reconstructed and then **verified against the shipped dataset**, so it is
precise enough to rebuild.

### 2.1 What a row means

`data/in/polkadot.csv` — 213,814 rows, 17 accounts, 2022-02-02 → 2023-04-08.
`data/in/kusama.csv` — 233,353 rows, 25 accounts, 2021-07-01 → 2023-03-12.

```
address,block_number,balance,timestamp
13YMK2efD4gFWcgFw3FTuEJS2cj6PBjPageCoVJNn2ck1uz4,14279002,6702794514718215,2023-02-16 22:33:24 UTC
```

I read that exact block off the archive today:

```
$ curl -s -X POST https://rpc.polkadot.io -H 'Content-Type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"state_queryStorageAt","params":[[
    "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9
      60f69b6b8b493a9201fe96529273bd6d
      70617261f0070000000000000000000000000000000000000000000000000000",
    "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb"],
   "0x89ceded39267cd7ee58a8f1a19781b9c2dd02a93124c035c2ceb9542c5c8c6ab"]}'
```

decoded:

```
free      = 6_701_394_514_718_215 planck
reserved  =     1_400_000_000_000 planck
Timestamp.Now = 1676586804000 → 2023-02-16 22:33:24 UTC   ← matches the CSV timestamp exactly
free + reserved = 6_702_794_514_718_215                   ← matches the CSV balance exactly
```

**So `balance` in the netflows dataset is `free + reserved`, and the timestamp comes from
`Timestamp.Now` at that block, not from an interpolation.** That settles the two questions a
reimplementation has to answer before it writes a single row. (`REPORT.md` says the timestamp was
taken from the `timestamp.set` extrinsic; reading the `Timestamp.Now` storage item at the same block
gives the identical value and costs nothing extra, because it rides along in the same
`state_queryStorageAt` call.)

### 2.2 Deriving the accounts — no address list needed

`REPORT.md` says the sovereign addresses were "captured by manually grabbing them from the Subscan
Parachains screen". They are computable. SS58-decoding the shipped label list gives:

| Address | 32-byte public key | Reading |
|---|---|---|
| `13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy` (Acala) | `70617261 d0070000 00…` | `"para"` + `2000u32 LE` |
| `13YMK2eZbf9AyGhewRs6W6QTJvBSM5bxpnTD8WgeDofbg8Q1` (Moonbeam) | `70617261 d4070000 00…` | `"para"` + `2004u32 LE` |
| `13YMK2efD4gFWcgFw3FTuEJS2cj6PBjPageCoVJNn2ck1uz4` (Interlay) | `70617261 f0070000 00…` | `"para"` + `2032u32 LE` |

So: **relay-side sovereign account = `b"para" ++ u32_le(para_id)`, right-padded to 32 bytes.** The
sibling-side one (what a parachain's reserve looks like *on another parachain*, including Asset Hub)
is **`b"sibl" ++ u32_le(para_id)`**. Both verified live — the `sibl` keys return real balances on
Asset Hub while the `para` keys return dust there.

The `modl` prefix from our own `CLAUDE.md` is the third member of this family: `b"modl" ++ pallet_id`
(+ optional sub-index). Two of the busiest accounts on Asset Hub decode as
`modl` + `dap/buff` and `modl` + `py/stkng` + index — pallet machinery, not people. Same caveat as
Hydration.

### 2.3 Storage key derivation (compute it, never hardcode it)

```
key = twox128("System") ++ twox128("Account") ++ blake2_128(pubkey) ++ pubkey
```

Computed, not recalled:

```
twox128("System")  = 26aa394eea5630e07c48ae0c9558cef7
twox128("Account") = b99d880ec681799c0cf30e8886371da9
twox128("Timestamp") ++ twox128("Now")
                   = f0c365c3cf59d671eb72da0e7a4113c4 9f1f0515f462cdcf84e0f1d6045dfcbb
```

`twox128(x) = xxh64(x, seed=0) as u64 LE ++ xxh64(x, seed=1) as u64 LE`. Our repo's rule ("storage
keys are computed, never hardcoded") applies: derive the pallet/item names from
`state_getMetadata` and hash them, so a runtime rename fails loudly instead of returning "empty map".

`Identity.IdentityOf` on the People Chain uses **Twox64Concat** (8-byte hash + the account), not
Blake2_128Concat — a different hasher for a different map. Read the hasher out of the metadata rather
than assuming.

### 2.4 `AccountInfo` decode, with the self-check

80 bytes, exactly:

```
nonce       u32
consumers   u32
providers   u32
sufficients u32
data: { free u128, reserved u128, frozen u128, flags u128 }
```

Example, Acala's relay sovereign account at head:

```
0x00000000 01000000 01000000 00000000
  0004d0c132000000000000000000000000   free     =        21.8 DOT
  00dd0ee902000000000000000000000000   reserved =       320.0 DOT
  00000000000000000000000000000000     frozen   =         0
  00000000000000000000000000000080     flags    = 2^127
```

Decoder must consume exactly 80 bytes and throw otherwise — the same discipline as
`decodeAssetDetails`. The `flags` field being `0x80…00` is the "new logic" marker; misreading it as
a balance yields `1.7014118346046923e38`, which is exactly the bug Statescan ships (§6).

### 2.5 The search itself

```
probe(b)  -> (total_b, ts_b)      # one state_queryStorageAt over ALL tracked keys + Timestamp.Now
                                   # memoised: probe results are cached by block height

find_changes(lo, hi):
    v_lo = probe(lo);  v_hi = probe(hi)
    stack = [(lo, v_lo, hi, v_hi)]
    while stack:
        a, va, b, vb = stack.pop()
        if va == vb:  continue                 # ASSUMPTION — see the false-negative note
        if b - a == 1: emit(block=b, value=vb); continue
        m = (a + b) // 2
        vm = probe(m)
        stack.push((a, va, m, vm)); stack.push((m, vm, b, vb))
```

Four optimisations, three of them from `REPORT.md` and one new:

1. **Memoise probes** (`REPORT.md`). Essential — sibling intervals share endpoints.
2. **Seed from extrinsics/events** (`REPORT.md`). In 2023 this meant Subscan. Today it means SQD, and
   it does not merely *seed* the search — it **replaces** it (§3).
3. **Read the timestamp at the same block** (`REPORT.md`). Free if you put `Timestamp.Now` in the same
   `state_queryStorageAt` key list.
4. **New: share every probe across all tracked accounts.** `state_queryStorageAt` takes a key *list*
   and one block hash. Put all N accounts plus `Timestamp.Now` in one call and the marginal cost of
   the (N+1)-th account is only the probes *it alone* forces. Measured: searching a 2,048-block window
   for Hydration cost 67 probes; adding Acala to the same run cost **7 more**; adding Bifrost cost
   **0 more**.

**The false negative.** `va == vb ⇒ no change in (a,b)` is not sound. A balance that goes out and
comes back to the *same value* inside one interval is invisible. `REPORT.md` reports exactly this
class of event ("sudden, strong inflows, closely followed by outflows of the same amount") — the
method can see those only because the round trip straddled a probe. Any page built on this must say
so. The event-fold method (§3) does not have this failure mode, which is the strongest argument for
switching.

### 2.6 Measured cost of the binary search, today

**Naive (one HTTP request per RPC call), Asset Hub, 3 accounts, 2,048 blocks:**
148 HTTP requests · 74 distinct block probes · 9 change points · 15.2 s.
(Half the requests are `chain_getBlockHash`; the block→hash map is a permanent cache.)

**Level-synchronous / BFS (batch every probe at a level into 2 HTTP requests):**

```
span 40,450 blocks (one Asset Hub day)   depth = 16 levels
6 sovereign accounts, 130 change points found
975 distinct block probes
53 HTTP requests · 1,950 JSON-RPC calls · 2,257,785 bytes · 16.5 s
```

That is the real shape: **probe count is `K · log2(B/K)`** (130 · log₂(311) = 1,077 predicted,
975 measured), but **HTTP request count is ~2 per level plus batching overflow**, because
`chain_getBlockHash` batches 500-at-a-time in 0.20 s and `state_queryStorageAt` accepts 1,000 keys
in one call.

Batch ceilings, measured on `polkadot-asset-hub-rpc.polkadot.io`:

| call | 50 keys | 200 keys | 1,000 keys |
|---|---|---|---|
| `state_queryStorageAt` | 0.10 s | 0.15 s | **2.81 s** |

Keep key batches at ≈200. Beyond that the node's trie reads dominate and latency goes superlinear.

**Cost per account per unit time, from the same run** (Asset Hub, 2026-08-18/19):

| account | change points / day | probes it forced |
|---|---|---|
| Hydration `sibl`+2034 | 115 | ~700 |
| Acala `sibl`+2000 | 8 | ~90 |
| Bifrost `sibl`+2030 | 7 | ~80 |
| Moonbeam / Astar / Interlay | 0 | 0 (rode along free) |

**Rule of thumb:** one account, one day of Asset Hub, K changes ⇒ `K · log₂(40450/K)` probes.
K=10 → 120 probes; K=100 → 860 probes; K=1000 → 5,300 probes.

**And the search is genuinely precise.** As a demonstration I bisected 12.6 million relay blocks for
the moment Acala's `para`+2000 balance fell off a cliff:

```
23 probes, ~20 s
last block > 100k DOT : 28,493,861   2025-11-04 12:38:00 UTC   3,137,094.16 DOT
first block < 100k DOT: 28,493,862   2025-11-04 12:38:06 UTC          341.00 DOT
```

That is the Asset Hub Migration moving Acala's sovereign account. Note it is **not** one atomic
block for everyone: at 28,493,862 Moonbeam's `para`+2004 still held 1,465,523 DOT, and Interlay /
Hydration / Bifrost / Astar were already down to 281–481 DOT — they had moved their DOT reserve to
Asset Hub earlier and independently. The migration is progressive and per-account.

---

## 3. The 2026 method: fold the `Balances` event stream (and it reconciles exactly)

### 3.1 The source

```
POST https://portal.sqd.dev/datasets/asset-hub-polkadot/stream
Content-Type: application/json
Accept-Encoding: gzip

{"type":"substrate","fromBlock":19630001,"toBlock":19650000,
 "fields":{"block":{"number":true,"timestamp":true},"event":{"name":true,"args":true}},
 "events":[{"name":["Balances.Transfer","Balances.Deposit","Balances.Withdraw", …]}]}
```

Response is NDJSON, one line per block that has a match:

```json
{"header":{"number":19600004,"timestamp":1787042712000},"events":[
 {"name":"Balances.Withdraw","args":{"who":"0xca6c…0920","amount":"8808355"}},
 {"name":"Balances.Transfer","args":{"from":"0xca6c…0920","to":"0x8ebb…b25b","amount":"10000000"}},
 {"name":"Balances.Deposit","args":{"who":"0x6d6f646c6461702f627566661c73746167696e67…","amount":"8808355"}}]}
```

Accounts arrive as raw 32-byte public keys — no SS58, no per-network prefix ambiguity. Good.

Datasets present (of 200 total on the portal): `polkadot`, `kusama`, `asset-hub-polkadot`,
`asset-hub-kusama`, `asset-hub-paseo`, `asset-hub-westend`, `people-chain`, `bridge-hub-polkadot`,
`bridge-hub-kusama`, `collectives-polkadot`, `acala`, `hydradx`, `interlay`, `bifrost-polkadot`,
`bifrost-kusama`, `astar-substrate`, `moonbeam-substrate`, `moonriver-substrate`, `polkadex`,
`peaq-mainnet-substrate`, `shiden-substrate`, `moonsama`. All report `start_block: 0`.
`real_time: false` — `asset-hub-polkadot` head was 19,650,399 while the node was at 19,651,248,
i.e. **~850 blocks / ~30 minutes behind**. That lag is the price of the method and belongs in a
data-note.

### 3.2 Test 1 — does the event set find exactly the blocks the binary search finds?

Binary search over Asset Hub blocks 19,630,000 → 19,650,000 (20,000 blocks, depth 15, 612 probes,
41 HTTP requests, 8.5 s) vs. one SQD stream over the same range:

```
SQD: 1 request, 1,035,735 bytes gzipped, 0.7 s

para 2000: binary-search=7  change blocks | sqd-event blocks=7  | bs∖sqd=0 | sqd∖bs=0
para 2034: binary-search=74 change blocks | sqd-event blocks=74 | bs∖sqd=0 | sqd∖bs=0
para 2030: binary-search=5  change blocks | sqd-event blocks=5  | bs∖sqd=0 | sqd∖bs=0
```

**Exact agreement. Zero false negatives, zero false positives, 86 change points.**

### 3.3 Test 2 — does an event-derived running total reconcile to `system.account`?

Anchor at `system.account` at block 19,630,000, apply nothing but the event deltas, compare to
`system.account` at 19,650,000:

```
para 2000: start=3007981.474344  Δ=  -210.933942  predicted=3007770.540402  actual=3007770.540402  MATCH
para 2034: start=4545836.160821  Δ=-28111.880240  predicted=4517724.280581  actual=4517724.280581  MATCH
para 2030: start=2168188.223662  Δ=  +537.201866  predicted=2168725.425528  actual=2168725.425528  MATCH
```

**Exact to the planck, all three.** The delta rules used:

| event | effect on `free + reserved` |
|---|---|
| `Transfer{from,to,amount}` | `from −amount`, `to +amount` |
| `Deposit{who,amount}`, `Minted`, `Restored` | `+amount` |
| `Withdraw{who,amount}`, `Burned`, `Slashed`, `Suspended` | `−amount` |
| `DustLost{account,amount}` | `−amount` |
| `ReserveRepatriated{from,to,amount,…}` | `from −amount`, `to +amount` |
| `Reserved`, `Unreserved`, `Locked`, `Unlocked`, `Frozen`, `Thawed` | **0** — they move value *within* an account |
| `BalanceSet{who,free}` | absolute; **breaks the delta chain**, must re-anchor |
| `Endowed{account,free_balance}` | informational; the value also arrives as a `Deposit`/`Transfer` |

`Deposit`/`Withdraw` are *not* double counting a `Transfer` — in the sample above the
`Withdraw`+`Deposit` pair is the transaction fee moving to a fee-collector pallet account, and the
`Transfer` is the payment. Both are real, both are needed.

**The trap: the argument shape changes across runtime eras.**

```
relay @1,000,000   Balances.Deposit   args = ["0x1ae2…4d3c","30400001"]              (list)
relay @8,000,000   Balances.Withdraw  args = ["0x0d58…2fb0","158000014"]             (list)
relay @12,000,000  Balances.Withdraw  args = {"who":"0xc253…51eb","amount":"158563148"}  (dict)
relay @15,000,000  Balances.Withdraw  args = {…}                                     (dict)
```

Positional arrays before the runtime that named event fields, named objects after; the flip is
somewhere in **relay blocks 8,000,000 – 12,000,000** (I did not bisect it). A decoder that assumes
`args.who` returns `undefined` for the entire 2020–2022 era and silently produces a flat line. This
is exactly the class of failure our `CLAUDE.md` says must fail loudly: assert on the shape, throw on
neither.

### 3.4 What the binary search is *for* now

Reconciliation. The event fold is a running sum; a running sum drifts if one event class is
mishandled or one runtime era decodes wrong. **Anchor and check**: read `system.account` at the
start of each ingest window and at the end, fold the events in between, and refuse to store the
window if the two disagree. That costs 2 probes per window and converts a silent, cumulative,
invisible error into a loud one. It is also the only honest way to put a number on the page.

### 3.5 Measured wire volume (gzip, per 20,000 blocks, all `Balances` events, whole chain)

| dataset | block | date | events | gz bytes | plain bytes |
|---|---:|---|---:|---:|---:|
| polkadot | 2,000,000 | 2020-10-13 | 8,788 | 364,597 | 1,480,018 |
| polkadot | 8,000,000 | 2021-12-05 | 211,604 | 5,478,334 | 28,614,517 |
| polkadot | 14,000,000 | 2023-01-28 | 97,324 | 3,692,208 | 14,778,970 |
| polkadot | 20,000,000 | 2024-03-21 | 119,950 | 4,019,977 | 19,043,426 |
| polkadot | 26,000,000 | 2025-05-14 | 87,030 | 3,259,860 | 13,067,155 |
| polkadot | 28,500,000 | 2025-11-04 | **301** | 9,302 | 54,808 |
| polkadot | 31,000,000 | 2026-04-28 | **34** | 1,958 | 6,234 |
| asset-hub-polkadot | 2,000,000 | 2022-08-27 | 29 | 989 | 5,473 |
| asset-hub-polkadot | 8,000,000 | 2025-01-15 | 25,612 | 525,566 | 6,083,643 |
| asset-hub-polkadot | 14,000,000 | 2026-03-30 | 40,192 | 1,113,204 | 8,376,528 |
| asset-hub-polkadot | 17,000,000 | 2026-06-13 | 29,798 | 1,009,310 | 5,500,941 |
| asset-hub-polkadot | 19,000,000 | 2026-08-03 | 41,406 | 1,293,529 | 7,965,857 |

The relay's collapse from 87,030 events per 20k blocks (May 2025) to 34 (April 2026) is the Asset Hub
Migration in one column.

Block times, derived from `Timestamp.Now` at sampled heights:

- **Polkadot relay: 6.03 s** (blocks 20M→30M) ⇒ **14,330 blocks/day**
- **Polkadot Asset Hub: 2.12–2.14 s** (blocks 12M→15M→18M) ⇒ **40,450 blocks/day**

Integrating the table over the block ranges (trapezoid, honest ±30 %):

| backfill | gz on the wire | wall time at observed throughput |
|---|---|---|
| `polkadot` relay, block 0 → 32.6M | **≈4.9 GB** | ≈45 min (1,630 chunks of 20k blocks, ~1 s each) |
| `asset-hub-polkadot`, block 0 → 19.65M | **≈0.64 GB** | ≈17 min (983 chunks) |
| **both, full history** | **≈5.5 GB** | **≈1 hour** |
| daily increment, Asset Hub | 2.6 MB/day | seconds |
| daily increment, relay (post-AHM) | ~4 KB/day | seconds |

Compare: the binary search over one Asset Hub *day* for *six* accounts cost 2.26 MB and 16.5 s. The
event stream costs 2.6 MB and a couple of seconds for **every account on the chain**.

---

## 4. `subtrope` — data model, jobs, UI, and what to take

### 4.1 Data model (`src/database/schema.sql`)

Seven tables, SQLite in WAL mode:

| table | key columns | note |
|---|---|---|
| `networks` | `id` TEXT PK, `endpoint`, `symbol`, `decimals` | endpoint = a Subscan host |
| `jobs` | `id` TEXT PK (uuid), `type`, `status`, `network_id`, `data` JSON, `progress` INT, `error_message`, `latest_log`, `created_at/started_at/completed_at` | |
| `accounts` | AUTOINCREMENT id, `UNIQUE(network_id,address)`, `balance`/`locked`/`reserved`/`bonded`/`unbonding` BIGINT, `display_name`, `rank_position` | current state only |
| `account_history` | AUTOINCREMENT id, `(network_id,address,balance,…,timestamp,block_height)` | **no uniqueness constraint** |
| `daily_account_metrics` | `UNIQUE(network_id,date)`, totals/avg/median | never populated by any job I found |
| `transfers` | `UNIQUE(network_id,hash)` | never populated by any job I found |
| `cache_metadata` | `id` TEXT PK, `data_type`, `last_updated`, `expires_at`, `record_count` | the freshness ledger |

Indexes: `(network_id, balance DESC)`, `(network_id, rank_position)`,
`(network_id, address)` on history, `timestamp DESC` on history, jobs by status.

**Three defects worth naming before anyone copies this.**

1. `account_history` has **no unique key** on `(network_id, address, block_height)` and the ingest
   job deletes-then-inserts a whole date window inside a transaction. Any interruption loses history
   permanently; any overlapping window duplicates rows.
2. `fetchAccountHistory.js` **fabricates timestamps.** It has no timestamp from the API, so it does
   `estimatedTime = Date.now() + (blockNumber - 27397990) * 6000` with a **hardcoded reference
   block** (`// From network stats, will be dynamic later`). Every historical point is at an invented
   time, and the error grows with age. Our repo's `Timestamp.Now` read costs nothing and is exact.
3. `convertToBigInt` treats a decimal string by padding to 10 places — Polkadot's decimals hardcoded
   — which is silently a factor of 100 wrong on Kusama (12 decimals). `decimals` is in the
   `networks` table and is not consulted.

### 4.2 Jobs (`src/jobs/`)

`SimpleJobManager` — `maxConcurrentJobs = 1`, an in-memory array queue plus a `jobs` row for
durability, uuid ids, `retry_attempts: 3` with exponential backoff, cancel + cancel-all, and a
`updateProgress(percent, message)` callback that the WebSocket layer relays live to the browser.

Three processors, each one Subscan call pattern:

| job | Subscan endpoint | shape |
|---|---|---|
| `FETCH_TOP_ACCOUNTS` | `POST /api/scan/accounts` `{row,page,order:desc,order_field:balance}` | pages up to `max_pages`, 1 s sleep between pages, `DELETE` then re-insert all |
| `FETCH_ACCOUNT_HISTORY` | `POST /api/scan/account/balance_history` `{address,row:100,page:0,block_range}` | one page, 100 rows, never paginates |
| `FETCH_ACCOUNTS` | `POST /api/scan/account` `{address}` | one request per address, 200 ms sleep |

Cache TTLs (`src/services/CacheStrategy.js`): `accounts` 10 min, `account_history` 5 min,
`networks` 60 min. `DataOrchestrator` routes: cache-hit → immediate; miss/stale → create a job and
answer `{status:"processing", job_id}`; the client correlates by `request_id`.

### 4.3 Frontend

React + Vite + Tailwind + Zustand, WebSocket-only for data (`/ws`, 120 msg/min per client,
30 s heartbeat, `job_updates` channel). Client-side data layer is a small graph store:
`EntityStore` (entities + relationships, stored once) → `GraphDataManager` → `ViewManager`s
(`AccountViewManager`, `RichListViewManager`, `JobViewManager`) → hooks
(`useAccountView`, `useRichListView`, `useJobData`) → pages
(`NetworkPage`, `AccountPage`, `JobsPage`).

**What subtrope's UI does that ours does not:**

- A **rich list** page: rank, address, display name, balance, pagination, "last updated N minutes
  ago", explicit Reload.
- An **account page** with a balance-history line chart and 7d/30d/90d/6m/1y/2y/all range control.
- **Multi-account comparison**: click accounts in the rich list to add them to an overlay chart,
  unlimited selection, per-account background loading with a visible `Queue: X | Active: Y`
  indicator, **selection encoded in the URL so a comparison is shareable**.
- A **Jobs page** — every background job with id, created time, status, latest log line, Cancel and
  Cancel All.
- A **connection indicator** and a **cache indicator** (fresh / stale / loading) on every panel.

### 4.4 Verdict — import the shape, not the code

| take | leave |
|---|---|
| The **job table + progress + latest_log + cancel** model. Our v2 needs long ingests and the user has to see them. | The whole `SubscanClient` and all three processors. |
| **Cache-miss ⇒ job, cache-hit ⇒ immediate, same response envelope.** One client code path for both. | `maxConcurrentJobs = 1` as a permanent property — it is a SQLite-write-conflict workaround, and WAL + a single writer thread solves it better. |
| The **shareable-URL account selection** and the overlay comparison chart. That is a genuinely good idea and we have nothing like it. | The React/Zustand/graph-store stack. Our repo is deliberately framework-free; the *idea* of "store entities once, project them per view" transfers as plain functions. |
| `cache_metadata` as an explicit freshness ledger with `record_count`, surfaced in the UI. | The `daily_account_metrics` and `transfers` tables — declared, indexed, never written. Dead schema. |
| The **WebSocket progress relay** — if we want live ingest progress, this is the pattern. But see the risk in §8: a public ungated site + a WebSocket that triggers work is a DoS surface. | Fabricated timestamps, hardcoded decimals, delete-then-insert history windows. |

---

## 5. `subscrape` — which parts need a key

`subscrape` is the honest one: it states its keyless rate limits in code.

| wrapper | file | key | keyless rate | status for us |
|---|---|---|---|---|
| `SubscanWrapper` | `subscrape/apis/subscan_wrapper.py` | optional in code (`SUBSCAN_MAX_CALLS_PER_SEC_WITHOUT_API_KEY = 2`) | **was** 2 req/s | **DEAD.** The keyless path no longer exists upstream — 403. |
| `MoonscanWrapper` | `subscrape/apis/moonscan_wrapper.py` | optional (`MOONSCAN_MAX_CALLS_PER_SEC_WITHOUT_API_KEY = 0.195` — "empirically determined") | 0.195 req/s ≈ one call per 5.1 s | Usable in principle; **too slow to backfill anything.** Fine for a handful of point lookups. |
| `BlockscoutWrapper` | `subscrape/apis/blockscout_wrapper.py` | **none, ever** ("Blockscout does not need an API key") | self-imposed 5 req/s | **Usable.** The only fully key-free wrapper in the library. |

Reusable *method* independent of the transport:

- **Delta scraping** — "subsequent runs will only fetch deltas", with the stated limitation that an
  uncaught exception mid-scrape leaves an incomplete delta that later runs will not notice. Our
  version must make the window atomic (write the watermark only after the window commits) and must
  reconcile (§3.4).
- **Index deducers** — `f"{block_num}-{event_idx}"` as the natural key for an event. Worth keeping;
  it is stable across re-fetches in a way that a row id is not.
- The EVM side (`decode_evm_log.py`, `decode_evm_transaction.py`, ABI fetch → decode input → decode
  logs → read receipts for final token amounts) is genuinely reusable *if* we ever do Moonbeam, and
  Blockscout can serve it keylessly.

`subflow` and `tge-data-aggregation`, skimmed for method only:

- **`subflow`** is BigQuery + Cloud Run + `gcloud auth` — service credentials at its core, so
  architecturally out of scope. The transferable idea is its **declarative config**: a source is
  `{module, event|call, subscrape:{…}, fetch_filter, post_fetch_filter}`. That is very close to our
  `server/sources/*.mjs` `operations` table, and it is the right shape for "add a pallet, not a
  program".
- **`tge-data-aggregation`** is a one-off distribution calculation. The transferable idea is
  **"distribute exact values with planck precision"** as an explicit pipeline stage with a
  plausibility check against minimum rewards — i.e. integer arithmetic end-to-end and a
  reconciliation gate before output. Same discipline as §3.4.

---

## 6. Key-free substitutes for what Subscan used to give us

| Subscan gave | Key-free replacement | Verified | Caveat |
|---|---|---|---|
| `scan/account/balance_history` | **SQD `Balances` event fold**, anchored + reconciled against `system.account` | §3, exact | ~30 min index lag; args-shape flip across runtime eras |
| `scan/accounts` (rich list) | `state_getKeysPaged` + `state_queryStorageAt` over `System.Account` | 1,000 keys/0.18 s, 1,000 balances/0.33 s measured | ~3.9M accounts on Asset Hub ⇒ **≈7,800 requests, ≈1.3 GB, ≈33 min** for a full pass |
| `scan/accounts` (rich list, relay only) | `https://polkadot-api.statescan.io/accounts?page=&pageSize=` | 200, head block matched the node | **Does not cover Polkadot Asset Hub** (`statemint-api.statescan.io` is a Cloudflare stub, 404 on every API path). Kusama + Kusama Asset Hub do work. |
| `account_display.people` (on-chain identity) | People Chain `Identity.IdentityOf` — 3,054 entries, 4 requests | full enumeration ran; values decode (name, legal name, web, matrix) | Twox64Concat hasher; read it from metadata |
| `account_display.merkle.tag_name` (exchange / entity labels) | **nothing** | — | This is Subscan's proprietary label set. There is no key-free equivalent. Sovereign and pallet accounts are *derivable* (§2.2); exchange labels are not. Say so on the page. |
| per-account transfer count | `statescan /accounts/{addr}` returns `transfersCount` (83,590 for Acala's relay sovereign) | 200 | relay only |
| extrinsic/event scraping | SQD portal, any of 22 Polkadot-ecosystem datasets, block 0 onwards | §3 | `real_time: false` |

**Statescan ships a decoder bug.** Its `/accounts` payload reports
`"feeFrozen":"1.701411834604692317316873037158841E+38"` — that is 2¹²⁷, i.e. it is reading the
**`flags`** field of the modern `AccountData` as the old `feeFrozen`, and it has no `frozen` at all.
`free` and `reserved` are correct (I matched them against the node for Acala's sovereign account:
`free 218000000000`, `reserved 3200000000000`, identical). **Use Statescan for free/reserved and the
rich-list ordering; never for locked/frozen.**

**Dotlake** (`api.data.parity.io`, already a registered source in this repo) has account-adjacent
endpoints that answer anonymously:
`/api/monthly-unique-accounts` (verified: Polkadot relay 891→1,348 unique addresses/month over
Jan–Jul 2026 — a post-AHM ghost town, and a good number to put next to the 1,493 account count),
`/api/monthly-treasury-balances`, `/api/daily-staking-participation`, `/api/daily-staking-rewards`,
`/api/monthly-percent-staked`, `/api/opengov-voter-history`, `/api/explorer/account/{address}/summary`,
`/api/explorer/search`, `/api/explorer/network-stats`.

Two Dotlake gotchas: `/api/explorer/account/{address}/summary` returned
`{"detail":"Account … not found"}` for both a relay and an Asset Hub sovereign account, so its
coverage is narrower than the path suggests; and **its chain name for Asset Hub is `statemint`, not
`assethub`** — `?chain=assethub` returns a row of zeros rather than an error
(`{"chain":"assethub","tx_24h":0,…,"latest_block":""}`), while `?chain=statemint` returns
`tx_24h: 108310, active_accounts_24h: 2246, latest_block: 19651154`. A wrong chain name here produces
a confident zero, which is precisely the failure mode our rule 3 exists for.

---

## 7. Storage — measured, then extrapolated

### 7.1 Bytes per row, measured

I loaded the real 447,167-row netflows dataset into SQLite two ways:

```
CREATE TABLE balance_point(
  acct INTEGER NOT NULL, block INTEGER NOT NULL,
  total <TYPE> NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY(acct, block)) WITHOUT ROWID;
```

| balance column | file after VACUUM | bytes/row |
|---|---:|---:|
| `INTEGER` | 11,182,080 | **25.0** |
| `TEXT` | 15,155,200 | **33.9** |

`WITHOUT ROWID` with `PRIMARY KEY(acct, block)` means the primary index *is* the table and the
account-plus-time-range query — the only query these rows exist for — is covered with no secondary
index. 42 accounts, ~20 months of full history: **15 MB.**

**Caveat on `INTEGER`.** SQLite's INTEGER is signed 64-bit: max 9,223,372,036,854,775,807 planck =
922,337,203 DOT. Total DOT issuance is well above that, so a *pallet* account (staking, treasury)
can in principle overflow it, at which point SQLite silently coerces to REAL and you lose precision.
Either store planck as TEXT (+36 % size) or split into `hi`/`lo` u64s. Do not find out in production.

### 7.2 Rows per unit time, measured

From one 20,000-block Asset Hub window (blocks 19,000,000–19,019,999, ≈11.9 h):

```
32,923 (account, block) rows across 14,960 distinct accounts
median rows per account: 1
top      1 account  → 3,837 rows = 11.7%   (0x6d6f646c "modl" + "dap/buff")
top     10 accounts → 9,917 rows = 30.1%
top    100 accounts → 12,321 rows = 37.4%
top  1,000 accounts → 16,321 rows = 49.6%
top 10,000 accounts → 27,963 rows = 84.9%
```

The two busiest accounts on Asset Hub are `modl`+`dap/buff` and `modl`+`dap/buff`+`staging`; #3 and
#4 are `modl`+`py/stkng`+index. **Pallet machinery, not people** — the same fact our `CLAUDE.md`
already records for Hydration, now confirmed for Asset Hub. Any "most active accounts" ranking that
does not strip `modl` is a ranking of the runtime talking to itself.

Same measurement on the relay at block 20,000,000 (2024-03, pre-AHM): 119,950 events →
**89,742 rows across 33,581 accounts** per 20,000 blocks.

### 7.3 Storage for N accounts over the full history

At 25 B/row, and using the measured shares:

| what you track | rows/day (today) | 1 year | full history |
|---|---:|---:|---:|
| one median account | ~2 | ~700 rows / 17 KB | — |
| one quiet sovereign (Interlay, Astar) | 0–1 | ~300 rows / 8 KB | 828 rows / 21 KB (2022–23 measured) |
| one busy sovereign (Hydration) | 115 | 42,000 rows / **1.0 MB** | — |
| one busy pallet account (`dap/buff`) | 7,760 | 2.8M rows / **71 MB** | — |
| **top 10 accounts** on Asset Hub | 20,000 | 7.3M rows / **183 MB** | — |
| **top 100 accounts** on Asset Hub | 24,900 | 9.1M rows / **227 MB** | — |
| **every account**, Asset Hub | 66,590 | 24M rows / **608 MB** | ≈18M rows / **≈450 MB** (most of the chain's life was quieter than today) |
| **every account**, Polkadot relay, block 0 → 32.6M | ~0 now | — | **≈115M rows / ≈2.9 GB** |
| **every account, relay + Asset Hub, all of history** | | | **≈135M rows / ≈3.4 GB** table, realistically **4–6 GB** on disk with WAL and any secondary index |

The relay figure is the integral of the §3.5 event table converted to rows at the measured
event→row ratio (0.75); treat it as ±30 %. The crowdloan era (block ~8M, Dec 2021) is the peak at
158,000 rows per 20,000 blocks — roughly a quarter of the relay's entire row count sits in
2021–2022.

**Read that against the deployment constraint.** The current target is a 256 MB container with **no
persistent volume**. A full-ecosystem balance index is 4–6 GB and takes an hour to build. These are
not the same order of magnitude and no amount of caching bridges them. The concrete options:

1. **Track a curated set** (sovereign accounts + treasury + a named watchlist). ~50 accounts,
   generously ~50 MB/year. Fits a small persistent disk; the daily increment is a single SQD request.
2. **Full index on a real disk.** 10 GB volume, ~1 h backfill, ~3 MB/day steady state. Enables the
   rich list, the "who moved" questions, and cohort analysis — everything subtrope wanted.
3. **Derived-only.** Store daily *snapshots* rather than every change point: N accounts × 365 ×
   25 B = 9 KB/account/year. 3.9M accounts × 1 day = 98 MB/day, so this only works for a curated set
   too — but for a curated set it is 400× smaller than change-point granularity and loses exactly
   the thing the 2023 report was about (the spikes). Not recommended as the only store.

Option 2 is the honest answer to "what does the deployment have to become". Option 1 is what ships
first.

---

## 7.4 What this repo already has

Worth knowing before anyone estimates effort — the primitives are already here:

| need | already in the repo |
|---|---|
| `twox128` for storage-key prefixes | `src/core/codec/xxhash.js` → `twox128(input)`, `xxhash64(input, seed)` |
| `blake2_128` for the `Blake2_128Concat` map hasher | `src/core/codec/blake2b.js` → `blake2b(input, outLength)` (call with 16) |
| SS58 for display | `src/core/codec/ss58.js` → `encodeSs58(accountId, prefix)`, `shortAddress()`. **Decode is missing** — we only ever encode today. A `decodeSs58` is ~30 lines and needs the same blake2b already imported. |
| SCALE | `src/core/codec/scale.js` — `decodeCompact` and Bulletin-specific shapes only. `AccountInfo` (§2.4) is four `u32`s and four `u128`s, so it needs no general decoder, just fixed offsets and a length assertion. |
| a JSON-RPC transport | `server/lib/upstream.mjs` `jsonRpc` — **single call only.** JSON-RPC *batching* (an array body) is what makes the binary search affordable (§2.6); it is a small addition to that file. |
| a netflows page | `netflows/index.html` + `src/pages/netflows/main.js` + `src/data/netflows.json` (85 KB, committed) + `scripts/build-netflows-dataset.mjs`, which re-derives the dataset from the 2023 CSVs and already carries the resampling/coverage/filter caveats and a list of discrepancies against the original report. **A live netflows v2 was scoped as a second series on this page. It shipped that way on 2026-08-20 and was split back out the same day** — the archive keeps `/netflows/`, the live read is `/sovereign/`. See [decision 0011](../../decisions/0011-a-page-has-one-subject.md). |

So the build is: a persistent store, an ingest writer, a `sqd` source module, and two small codec
additions. None of the cryptographic groundwork has to be redone.

---

## 8. Risks

- **Publishing this openly is a mild deanonymisation surface.** Balance history per address is
  already public on-chain, but an *indexed, searchable, charted* version lowers the cost of
  profiling a specific person from "run an archive node" to "type an address". The mitigation that
  costs nothing: index and expose the accounts we can *name* — sovereign, pallet, treasury,
  identified-on-People-Chain — and make arbitrary-address lookup a deliberate decision rather than
  a side effect of having the table.
- **A public ungated site whose UI can trigger an ingest job is a DoS amplifier.** subtrope's
  WebSocket lets any client create a `FETCH_ACCOUNT_HISTORY` job. Ours must not: ingest is a
  scheduled writer, the API is read-only over what has already been ingested. This is the same
  reasoning as the existing source-registry boundary — the client names an operation, never work.
- **SQD is a single point of failure with no SLA.** It returned `529` under modest probing. The
  archive-RPC binary search is the fallback and must stay implemented, not just documented — it is
  also the reconciliation check, so it earns its keep either way.
- **`real_time: false`.** SQD ran ~30 min behind the node. Any "current balance" must come from the
  RPC, not from the fold, or the page will show a stale number with a confident timestamp.
- **The relay/Asset Hub seam is a correctness trap.** A DOT balance chart that spans 2025-11-04 must
  splice two chains with two different account derivations (`para` → `sibl`) and two different block
  clocks (6.0 s → 2.1 s). Getting it silently wrong produces a chart where every parachain drops to
  zero in November 2025 and stays there. That belongs in the data-notes on day one.
- **Runtime-era decoding.** The event `args` list→dict flip (§3.3) and the `AccountData`
  `feeFrozen`→`frozen`+`flags` change (§2.4, and the live Statescan bug) are both silent-wrong
  failures across historical ranges. Every decoder needs the "consume exactly, or throw" discipline.

---

## 9. Unverified

Things I state above with less than direct evidence, listed so they are not mistaken for measurements:

- **Full-history byte and row totals** (§3.5, §7.3) are trapezoid integrations over 5–7 sampled
  20,000-block windows per chain. The relay's 2021–22 crowdloan spike is sampled once (block 8M).
  ±30 % is a fair band; I did not stream the full history.
- **The exact runtime block where SQD event `args` flips from positional to named** — bracketed to
  relay blocks 8,000,000–12,000,000, not bisected.
- **Whether every balance-changing operation emits a `Balances` event across *all* runtime eras.**
  I proved it exactly for Polkadot Asset Hub over 20,000 blocks in August 2026 (three accounts,
  86 change points, planck-exact reconciliation). I did **not** test the 2020–2022 relay eras, where
  the `Balances` pallet predates the fungible-traits rework and may well have gaps. Reconcile per
  window (§3.4) before trusting any pre-2023 fold.
- **The Asset Hub Migration's overall shape.** I verified Acala's individual cutover to the block and
  observed that Moonbeam had not moved at that block while four other parachains had already left
  earlier. I did not establish the migration's start/end or whether user accounts moved on a
  different schedule than sovereign accounts.
- **`state_queryStorageAt` key limits on the *relay* endpoint** — 1,000-key and 500-call batch tests
  were run against `polkadot-asset-hub-rpc.polkadot.io` only.
- **Whether IBP endpoints (`rpc.ibp.network`, `dotters.network`) work over WSS.** They returned an
  empty body to HTTP POST; I did not open a WebSocket.
- **`archive_v1_storage` / `archive_v1_storageDiff`** are advertised in `rpc_methods` on the public
  Asset Hub node but return `-32603 Internal error` over plain HTTP — they are subscription-shaped
  and presumably need WSS. If they work there, `archive_v1_storageDiff` would give per-block storage
  deltas directly. Untested. `state_queryStorage` (the *range* form, which would answer the whole
  question in one call) is explicitly refused: `4003 "RPC call is unsafe to be called externally"`.
- **Moonscan's current keyless rate limit** — 0.195 req/s is subscrape's empirical figure from 2022,
  not re-measured.
- **Storage-on-disk with realistic indexes.** 25.0 B/row is measured for a `WITHOUT ROWID` table with
  no secondary index. Adding a `(block)` or `(ts)` index for cross-account queries will add roughly
  another 12–16 B/row; I did not measure it.
