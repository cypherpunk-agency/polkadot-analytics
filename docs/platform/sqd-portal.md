# SQD Portal — the transfer-event transport

`https://portal.sqd.dev` is SQD's public archive gateway. It is **anonymous, keyless, HTTP-only**,
and it serves decoded Substrate events from block 0 for around two hundred datasets, of which
roughly two dozen are Polkadot-ecosystem chains. This repository reads it for exactly one thing:
**the edges of the transfer graph** — who sent value to whom — which is the one question state
reads cannot answer at all.

Everything below was measured against the live portal on **2026-08-21** unless it says otherwise.
Where a number is a re-measurement of something already in `docs/concept/research/polkalytics.md`,
it says so, because two of those numbers have moved.

---

## Why events and not state

A transfer is an edge between two accounts. `System::Account` holds a **balance**, not an edge — so
recovering the graph from state means diffing every account against its previous value and then
guessing which fall matches which rise. Beyond being wrong (two transfers in one block are
indistinguishable from one), it does not fit: a full Asset Hub `System::Account` sweep measures
~1,746 MiB and 58–85 min over WebSocket, or ~11,800 requests and ~2 GB over HTTP, for ~3.9M
accounts (`docs/concept/plan.md` §8.2). **You cannot diff 3.9M balances daily.**

`Balances.Transfer` carries `{from, to, amount}`. The edge is in the event. This is the same move as
reading `Issued`/`Burned` instead of differencing supply.

---

## The API, in the four calls that matter

### `GET /datasets`

Every dataset, with an `aliases` list and a `real_time` flag.

```json
[{"dataset":"asset-hub-polkadot","aliases":[],"real_time":false}, …]
```

**`real_time: false` does NOT mean frozen** and reading it that way is a mistake in both
directions. It is a property of the *ingest mode*, not of the head. Every Polkadot-ecosystem
dataset here reports `real_time: false`; one of them (`hydradx`) has not moved in 105 days and two
others (`polkadot`, `asset-hub-polkadot`) were within two hours of the wall clock on the same day.
The flag cannot separate them. Only the head timestamp can.

### `GET /datasets/<name>/metadata`

```json
{"dataset":"asset-hub-polkadot","aliases":[],"real_time":false,"start_block":0}
```

`start_block: 0` on every Polkadot dataset checked — the archives genuinely begin at genesis.

### `GET /datasets/<name>/head`

```json
{"number":19712249,"hash":"0x5613dc27522bcb342696438fac2e10abe889e7f3dd99f02e452ba3a5698e8df9"}
```

**There is no timestamp here.** A block number alone cannot be compared against a clock, and
converting it with an assumed block rate is the trap `CLAUDE.md` records twice. Get the timestamp
by streaming that one block (below).

### `POST /datasets/<name>/stream`

```
POST https://portal.sqd.dev/datasets/asset-hub-polkadot/stream
content-type: application/json

{"type":"substrate","fromBlock":19710000,"toBlock":19711600,
 "fields":{"block":{"number":true,"timestamp":true},"event":{"name":true,"args":true}},
 "events":[{"name":["Balances.Transfer"]}]}
```

The response is `application/jsonl` — one JSON object per block that matched, plus the first and
last block of the range regardless of whether they matched:

```json
{"header":{"number":19710000,"timestamp":1787289552000}}
{"header":{"number":19710013,"timestamp":1787289576000},"events":[
  {"name":"Balances.Transfer","args":{
    "from":"0x6d6f646c6461702f627566661c73746167696e67000000000000000000000000",
    "to":"0x6d6f646c6461702f627566660000000000000000000000000000000000000000",
    "amount":"6886503"}}]}
```

Accounts arrive as **raw 32-byte public keys**. No SS58, no per-network prefix, nothing to
normalise, nothing to get wrong. That is the correct join key and the portal hands it over
directly.

Every stream response also carries the head on its own headers, which makes the liveness check
free on a call you were making anyway:

```
x-sqd-head-number: 19712249
x-sqd-finalized-head-number: 19712249
x-sqd-finalized-head-hash: 0x5613dc…
```

---

## Four traps, all of which fail silently

### 1. The stream TRUNCATES, and says nothing

Ask for 39,000 blocks and you get 25,699 of them, with **HTTP 200, well-formed NDJSON, and no
header, field or sentinel saying it stopped early**. Measured twice on 2026-08-21:

| requested | returned | cut at |
|---|---|---|
| 19,673,000 → 19,712,000 (39,000 blocks) | 25,699 blocks | 19,698,699 |
| 19,300,000 → 19,712,000 (412,000 blocks) | 26,749 blocks | 19,326,749 |

The cut looks byte-driven rather than block-driven: the first response was 6.7 MB of plain NDJSON,
and a 20,001-block range carrying only `Assets.Transferred` (31 KB) came back complete.

**The only way to know is to compare the last returned block number against your `toBlock`** and
re-issue from `last + 1` until they meet. A caller that does not loop gets a window that is short
by however much the portal felt like, over the most *recent* part of the range, and every chart
drawn from it renders perfectly.

### 2. An event name that does not exist returns zero rows, not an error

```
{"events":[{"name":["Bananas.Wobbled"]}]}   →  HTTP 200, zero events
```

Verified 2026-08-21. So a typo in `Balances.Trasnfer`, or an event name that a runtime upgrade
renamed, renders as **"this account never transferred anything"**. There is no schema check and no
introspection endpoint to validate a name against. The defences that do work are (a) hard-code the
names as a constant and cover them with a test, and (b) publish the per-event-name counts in the
payload so a name that has silently stopped matching is visible on the page as a zero.

### 3. The argument shape flips between runtime eras

Recorded in `docs/concept/research/polkalytics.md` and unchanged: events are decoded as
**positional arrays** in the early runtimes and as **named objects** after the runtime that named
event fields, with the flip somewhere in relay blocks 8,000,000 – 12,000,000.

```
relay @8,000,000    Balances.Withdraw  args = ["0x0d58…2fb0","158000014"]
relay @12,000,000   Balances.Withdraw  args = {"who":"0xc253…51eb","amount":"158563148"}
```

Everything this repository reads today is modern (Asset Hub ≥ 19.7M, relay ≥ 32.6M) and comes back
as objects — but a decoder that reads `args.from` without asserting the shape produces `undefined`
for the whole 2020–2022 era and a flat line rather than an error. **Throw on the array shape.**

### 4. `real_time: false` on a live dataset, and a frozen dataset that looks identical

Measured within four minutes of each other on 2026-08-21:

| dataset | head block | head timestamp | lag |
|---|---:|---|---|
| `asset-hub-polkadot` | 19,712,249 | 2026-08-21T06:42:48Z | ~92 min |
| `polkadot` | 32,647,449 | 2026-08-21T06:27:00Z | ~99 min |
| `hydradx` | 12,344,549 | 2026-05-08T19:39:06Z | **104.5 days — unchanged since 2026-05-08** |

All three report `real_time: false`. All three answer in under a second with correctly shaped rows.
`hydradx` is the case `src/core/liveness.js` was written for, and it is in the same portal, one
path segment away from the two that are current. **Assert the head timestamp against the clock on
every payload** — the flag will not do it for you and the transport layer cannot.

**The lag is ~2 hours and the portal publishes in batches, not continuously.** Measured across 41
minutes of direct observation on 2026-08-21:

| observed at (UTC) | `asset-hub-polkadot` head | its timestamp | lag |
|---|---:|---|---:|
| 08:04 | 19,712,249 | 2026-08-21T06:42:48Z | 82 min |
| 08:13 | 19,712,249 | *unchanged* | 91 min |
| 08:45 | 19,712,249 | *unchanged* | 122 min |

The head is byte-identical (same hash) throughout while the lag grows in step with the clock, so
during that window the archive was not advancing at all. Meanwhile the chains themselves moved:

```
Asset Hub  chain head 19,715,577  archive 19,712,249  gap 3,328 blocks   (~2.1 h)
relay      chain head 32,648,830  archive 32,647,449  gap 1,381 blocks   (~2.3 h)
```

And the archive genuinely *stops* at its stated head rather than merely mis-reporting it —
streaming head + 1 returns **HTTP 204**, no content.

**This is stale, not frozen, and the distinguishing evidence is the head TIMESTAMP, not the head
number.** `asset-hub-polkadot`'s newest block is from earlier the same day; `hydradx`'s is from
2026-05-08, 104.5 days back. An archive that had stopped would not have a two-hour-old head. So
the reading is: it ingests in infrequent batches, the batch interval is **at least 41 minutes**
(not measured beyond that), and the lag is comfortably over the ~30 minutes
`docs/concept/research/polkalytics.md` recorded a day earlier.

What that means for a page: never call this live without measuring, always print the lag, and set
the stale threshold at ~30 min and the frozen threshold at several hours rather than at 24 —
`hydradx` proves the failure this guards against is total and permanent, not a slow drift.

---

## What a transfer event actually is, on each chain

### Polkadot Asset Hub (`asset-hub-polkadot`)

| event | args | what it is |
|---|---|---|
| `Balances.Transfer` | `{from, to, amount}` | DOT. 10 decimals, from `system_properties`. |
| `Assets.Transferred` | `{assetId, from, to, amount}` | a local `pallet-assets` asset — USDt (1984), USDC (1337), PINK (23), DED (30)… |
| `ForeignAssets.Transferred` | `{assetId: <XCM location>, from, to, amount}` | bridged/foreign assets. **Zero occurrences** in 20,000 blocks and again in a 26,749-block probe on 2026-08-21 — rare, not absent. |
| `PoolAssets.Transferred` | as `Assets` | AMM LP tokens. Zero occurrences in the same probes. |

Counts over blocks 19,710,000 → 19,711,600 (1,600 blocks, ~1 hour, 2026-08-21):

```
399  Balances.Transfer
 13  Assets.Transferred
  0  ForeignAssets.Transferred
  0  PoolAssets.Transferred
```

**A transfer graph sees under a third of what moves.** Over the same 1,600 blocks, counting every
balance-changing `Balances`/`Assets` event:

```
  405   29.9%  Balances.Deposit
  399   29.4%  Balances.Transfer
  325   24.0%  Balances.Withdraw
  144   10.6%  Balances.Minted
   69    5.1%  Balances.Endowed
   13    1.0%  Assets.Transferred
```

`Deposit`, `Withdraw` and `Minted` are **single-ended**: `{who, amount}`, with no second party in
the event at all. They are fee payments, staking rewards, and the mint/burn half of XCM execution.
They belong in a *balance* series (that is exactly the fold `docs/concept/research/polkalytics.md`
§3.3 reconciles to the planck) and they cannot be edges, because there is no other end to draw one
to. So a transfer graph is not "everything that happened to this account" — it is the ~30 % of
balance events that name two parties, and a page built on it has to say so or it is claiming
completeness it does not have.

`Assets.Transferred` carries the asset id as a **plain integer**, so its decimals must come from
`Assets::Metadata`, read from the chain and never keyed by symbol — see `docs/platform/asset-hub.md`
and the USDC/USDT decimals trap in `CLAUDE.md`. Read live on
`polkadot-asset-hub-rpc.polkadot.io`, 2026-08-21, with computed keys
(`twox128("Assets") ++ twox128("Metadata") ++ blake2_128Concat(u32le(id))`):

```
1337 -> {"name":"USD Coin","symbol":"USDC","decimals":6,"isFrozen":false}
1984 -> {"name":"Tether USD","symbol":"USDt","decimals":6,"isFrozen":false}
  23 -> {"name":"PINK","symbol":"PINK","decimals":10,"isFrozen":false}
  30 -> {"name":"DED","symbol":"DED","decimals":10,"isFrozen":false}
```

Each decode consumed its input exactly (0 bytes left over), which is the self-check that stops a
layout change becoming a factor of 10ⁿ.

### Polkadot relay (`polkadot`)

`Balances.Transfer` only — there is no `pallet-assets` on the relay. And there is **almost nothing
there**: over blocks 32,633,000 → 32,647,449 (14,450 blocks, a full day, 2026-08-21) the relay
carried **3** `Balances.Transfer` events in total, chain-wide, for 1.5 KB on the wire.

That is the Asset Hub Migration of 2025-11-04 in one number, and it is why a transfer graph that
reads only the relay looks like a dead chain and one that reads only Asset Hub silently drops
everything before November 2025. **Any window spanning 2025-11-04 is two chains stitched together
and must say so.**

---

## Cost, measured

Asset Hub, `Balances.Transfer` + `Assets.Transferred`, 2026-08-21:

| range | requests | plain bytes | gzip | wall |
|---|---:|---:|---:|---:|
| 1,600 blocks (~1 h) | 1 | 98 KB | 13 KB | 0.7 s |
| 25,699 blocks (~16 h) | 1 | 6.7 MB | 883 KB | 1.2 s |
| 1 day (~37,800 blocks), full pipeline incl. head + rate probes | 2 streams + 3 header probes | 10.4 MB | — | 3.1–3.7 s |

Approximately **9,600 `Balances.Transfer` events per Asset Hub day**, touching ~14,800 distinct
accounts in a 25,699-block sample. A single-block header probe (`fromBlock == toBlock`, no event
filter) costs 0.27–0.64 s and ~60 bytes, which makes it a cheap and exact way to turn a block
number into a timestamp.

Relay, same events, one day: **1 request, 1.5 KB**. Free.

---

## Finding the block for a date, without extrapolating

`CLAUDE.md` records two separate incidents of a date→height extrapolation producing a plausible,
wrong answer, and Asset Hub is the worse of the two chains for it: its block rate has moved by a
factor of six inside 2022–2026. Measured on 2026-08-21 from the portal's own timestamps:

```
19,712,249 → 19,400,000 :  2.285 s/block
19,400,000 → 19,000,000 :  2.135 s/block
```

7 % apart across four months of very recent history. So the rule this repo uses for the transfer
graph is not "estimate better" but **"never let the estimate decide the boundary"**:

1. Read the head block, then stream that single block for its timestamp.
2. Measure the local rate from one sample ~200,000 blocks back.
3. Estimate the start block for the window and then **bias it 20 % earlier**, so the estimate can
   only ever overshoot backwards.
4. Stream forward from there and **filter on the timestamps in the returned rows**.

The estimate decides where reading *starts*; the chain's own timestamps decide what *counts*. A
rate that is 7 % wrong then costs a few extra kilobytes and cannot move the window's edge.

---

## Rejected alternatives, and why

**Subscan.** Needs an API key. Rule 1 of this repository forbids one, and the keyless path returns
403 (`docs/concept/research/polkalytics.md`). Not evaluated further.

**Statescan.** `https://polkadot-api.statescan.io/accounts/<addr>/transfers` answers the exact
question we want — *per account*, indexed, paginated, no scan, no key — and it works, verified
2026-08-21:

```
GET /accounts/13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy/transfers?page=0&pageSize=3
200  {"items":[{"indexer":{"blockHeight":32506219,"blockTime":1786445622000,…},
      "from":"1jENPtb7…","to":"13YMK2eY…","balance":"2000000000","isNativeAsset":true}, …]}
```

**But it is the relay chain only, and the relay is where three transfers happen per day.**
`statemint-api.statescan.io` returns 404 on every API path, and `assethub-api.statescan.io`,
`polkadot-assethub-api.statescan.io` and `ah-polkadot-api.statescan.io` do not resolve (checked
2026-08-21). A per-account index of the chain that stopped in November 2025 cannot draw the
present. It remains the better transport for **pre-migration relay history** and is worth revisiting
if that becomes the question.

Statescan also ships a decoder bug — it reports `feeFrozen` as 2¹²⁷, i.e. it reads the modern
`AccountData.flags` field as the old `feeFrozen`. Use it for `free`/`reserved` and never for
locked/frozen (`docs/concept/research/polkalytics.md`).

**Hydration's orca.** Serves `routedTrades` — swaps, not transfers, and only on Hydration. It is
what `/account/`'s swap section already reads. Different question.

**A local archive.** The cost of the SQD scan is low enough (10 MB and 3 s for a day of Asset Hub)
that caching decoded blocks in-process beats storing them, at this scale. Revisit when the window
wants to be a year rather than a week.

---

## The labelling line

`docs/concept/plan.md` §8.3 draws it and it is binding for anything built on this data:

| kind | example | can it be wrong? |
|---|---|---|
| **structural** | `6d6f646c…` → pallet account | no. It is arithmetic on the bytes. |
| **behavioural** | "fan-in/fan-out consistent with an exchange" | it is a claim about observed behaviour, and it names nobody |
| **attributed** | "this is Binance" | yes — and being wrong publishes a false claim about a real company |

**Only structural is shipped.** `structuralLabel()` in `src/core/topology.js` decodes `modl`,
`para` and `sibl` from the bytes with no network call and no possibility of being wrong about
*whose* account it is.

This is not decoration. Ranked by degree over 25,699 Asset Hub blocks on 2026-08-21, the top of the
transfer graph is almost entirely machinery:

```
17,825  0x6d6f646c70792f73746b6e670143…   modl py/stkng   (staking payouts)
 4,347  0x6d6f646c6461702f627566661c73…   modl dap/buff
 4,347  0x6d6f646c6461702f62756666000…   modl dap/buff
 1,556  0x967cccc1ff3d1f37b9e6c8a39d8b…   no structural marker
 1,114  0x6d6f646c70792f73746b6e670142…   modl py/stkng
   737  0x6d6f646c70792f73746b6e670141…   modl py/stkng
```

Five of the top six are pallet accounts. A "top counterparties" list that does not classify them is
a list of the chain doing its own bookkeeping.

---

## A worked trail, verified end to end

Three hops walked in a browser against the live page on 2026-08-21, transfer window 2 days. Each
hop is an independent fold of the same window from a different account's point of view, so the
amounts reconciling across a hop is a real check rather than a restatement:

```
13vg3Mrxm3GL9eXxLsGgLYRueiwFCiMbkdHBL4ZN5aob5D4N   837 counterparties, 467 out / 792 in
   └─ sent 1,128,430.34 DOT + 58,488.01 USDt in 3 transfers to
1qnJN7FViy3HZaxZK9tGAA71zxHSBeUweirKqCaox4t8GT7    378 counterparties, 442 out / 3 in
   │  (its own page reports exactly +1,128,430.34 DOT / +58,488.01 USDt from the account above)
   └─ sent 142,181.36 DOT in 1 transfer to
13N4phPSCEJ7hHs8KXmbNHhZQCDqfmKsXWmGx6icL7v5Pch9   2 counterparties, 1 out / 1 in
   │  (received 142,181.36 DOT from the account above)
   └─ sent 142,181.38 DOT onward to 15u2N1pqWr…QCoVy3S5
```

The mirror holds to the planck in both directions. The last account received 142,181.36 and sent
142,181.38, i.e. two hundredths of a DOT more than it took in during the window — it had a prior
balance, which a transfer graph can see the consequence of but never the cause.

None of these accounts is named, and none of them carries a structural marker; they are ordinary
32-byte keys and this repository makes no claim about who operates them.

## Where this is read

| what | where |
|---|---|
| the module | `server/sources/transfers.mjs` |
| the operation | `/api/transfers/account-graph?account=…&days=…` |
| the page | `/account/?address=…` — the "who it moved value with" section |
| liveness contract | `src/core/liveness.js`, rendered by `src/design/liveness.js` |
