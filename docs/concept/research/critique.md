# Completeness critique of the six research sweeps

**Date:** 2026-08-19. **Role:** adversarial completeness pass. **Status:** no code, no repo changes
outside this file.

I did not re-verify what the sweeps verified. I looked for what nobody asked, where two sweeps
disagree, and what the whole plan is assuming without saying so. Everything numeric below came
from a request I made today; where I am reasoning rather than measuring, it says so.

**Headline:** the research is strong on capability and weak on three things — two of Tommi's
requests were never touched, the single most load-bearing architectural finding (that Hydration
history is unobtainable, therefore we need a 10 GB disk and must start ingest now) is **refuted by
an endpoint a sibling sweep found on the same day**, and nobody checked a production response
header or noticed the site is returning 502 right now.

---

## 0. What I verified today, up front

| claim | result |
|---|---|
| SQD Portal has a `hydradx` dataset | **yes** — `start_block: 0`, serves decoded `Broadcast.Swapped3` |
| SQD `hydradx` at block 8,000,000, one 14,400-block day | **HTTP 200, 1.57 MB, 381 ms**, 6,584 event-bearing lines |
| …the same height on `explorer.hydradx.cloud` (storage.md §2.3) | succeeded once at 7,160 ms, then three consecutive 12 s timeouts |
| SQD `hydradx` head | block **12,344,549**, ts **2026-05-08T19:39:06Z** — **103 days stale**, `real_time:false` |
| First `Broadcast.Swapped3` on Hydration | bracketed to blocks **7,567,547 – 7,568,265** (settles storage.md unverified #3) |
| orca `routedTrades` total | **6,582,661**, oldest block **6,837,788**, newest **13,691,403** (live to head) |
| orca, one day of trades at block 8.0 M | **HTTP 200, 181 KB, 0.28 s**, 14,872 trades in window, ~181 B/trade |
| orca per-address filter `participantSwappers:{contains:[…]}` | **works server-side** — 602,676 trades for one address, 1.46 s |
| Bulletin `bitswap_v1_get(cid)` | **works anonymously** — 116 KB file in 435 ms, 958 KB in 742 ms |
| `Liquidation.BorrowingContract` on rpc.hydradx.cloud | **null.** Pallet exists but holds exactly one key, `:__STORAGE_VERSION__:` |
| Hydration block time | **6.2162 s** over 1 k blocks, **5.8206 s** over 20 k, **5.6088 s** over 200 k |
| analytics.cypherpunk.agency | **HTTP 502 on `/`, `/api`, `/healthz`, `/api/hydration/swaps`** |
| deployed CSP | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:` |

---

## 1. Tommi's requests that no candidate answers

Eleven requests. **Two are wholly untouched, one is half-answered, and one is answered on a false
premise.**

### 1.1 Browsing actual Bulletin file contents — NOBODY LOOKED

Not one sweep addressed it. storage.md sizes the Bulletin *index* (4,002 keys, ~440 KB) and proves
it is pruned on a ~14-day timer; docs/platform/bulletin.md and `src/core/codec/cid.js` already
reconstruct CIDs. Every sweep stopped at the CID. Nobody asked whether the bytes are retrievable.

**They are, trivially, and I did it.** `rpc_methods` on `bulletin-paseo.tservices.es:8443` (121
methods) includes **`bitswap_v1_get`**. Given a CID built by the repo's own `buildCid()`:

```
bafkreifcmyg7epeoy5fusu66bkprvddthiyr3dzr2pu5bxptry7xzc4wvm
  -> 435 ms, 115,828 bytes, exactly the `size` field in TransactionInfo
  -> starts: {\n  "aaaaaaaaa": {\n    "label": "aaaaaaaaa",\n    "domain": "aaaaaaaaa.dot", "url": "ht…
bafkreias36t5fdrj4zha3ovdmx7hz5i7hmmhmilw6gqy5afcixnnimto34
  -> 742 ms, 958,451 bytes, dag-pb framing, contains the literal ".bulletin-"
bafybeideesrwu4odxrmo43rgbkj5ykh37jbh3bk4weswedycniwv66t45y  (dag-pb, 309 B)
  -> 52 ms, returns a UnixFS link list: 0x122c0a2401551220d63c… = CIDv1/raw/sha2-256 chunk links
```

So the content is real and legible: a `.dot` **domain-name registry as JSON**, and UnixFS website
bundles. Byte length matches the index's `size` field exactly, so integrity is checkable without
even hashing. Retrieval is one RPC call the repo does not make.

This is the highest value-per-effort item missing from the entire candidate set, and it is the one
request that turns `/bulletin/` from a table of hashes into the thing Tommi asked for. **It also
carries the sharpest security risk in the whole plan — see §4.2. Do not build it before reading
that.**

### 1.2 The knowledge base on the site — no sweep, and a live hazard nobody flagged

`src/sources/pages.js` already carries a `knowledge` entry (`kind: 'section'`, `/knowledge/`,
"Rendered from the markdown in the repository, one page per file"), and
`scripts/knowledge-plugin.mjs`, `knowledge.mjs` and `markdown.mjs` exist. There is no `knowledge/`
page directory yet. So this is being built by the `knowledge-site` agent in parallel and **was
never given a research sweep** — which is defensible for the rendering, and not defensible for
what gets rendered.

**The hazard: publishing `docs/` wholesale publishes `docs/concept/research/`.** That directory now
holds 256 KB across seven files including this one, and it contains, verbatim:

- the arbs sweep's complete enumeration of what constitutes trading edge, including the `steps`
  playbooks, `takeable_usd`, the bot-silence signal and the named-counterparty analysis — i.e. a
  document whose explicit thesis is *do not publish this*, published;
- every "I could not verify this" hedge, presented on a site whose rule 3 is about honesty but
  whose readers will not distinguish a research note from a platform doc;
- the observation that our own production API is 502.

Whoever builds `/knowledge/` needs an explicit allowlist (`docs/platform/`, `docs/architecture/`,
`docs/decisions/`) rather than a directory walk, and `docs/concept/` must be excluded by
construction, not by remembering. Nobody has written that down anywhere.

### 1.3 "Following specific accounts" — everyone answered a different question

All six sweeps read this as *we pick a curated watchlist server-side and index it*: polkalytics
proposes "a curated ~50-account set at ~50 MB/year", balances proposes sovereign + pallet +
People-Chain-identified accounts, arbs proposes not publishing accounts at all.

Nobody asked the actual product question: **what does "follow" mean to a visitor on a site with no
login, no accounts and no cookies?** On an ungated site, a follow is either (a) a URL that encodes
the watchlist — which polkalytics explicitly flagged as the thing worth stealing from subtrope
("its job/progress/cancel model and its shareable-URL multi-account comparison UI") and then never
designed — or (b) an ingest request from a client, which middleware.md forbids as a DoS
amplification path, or (c) not following at all, just a page about accounts we chose.

Pick one before writing a schema. (a) is almost free and needs no state; (c) is what every
candidate actually describes; (b) must never be built.

Related miss: **orca does per-address Hydration filtering natively.** `RoutedTrade` exposes
`participantSwappers`, and `filter:{participantSwappers:{contains:["0x…"]}}` returned 602,676
trades for one address in 1.46 s, whole history, one query. The arbs sweep costs the actor/address
family at "~580 MiB/year raw leg archive plus an offline DuckDB batch pipeline". For *retrieval*
that is now wrong by two orders of magnitude. (The batch pipeline is still needed for the
*informedness estimator*; the drill-down is not.)

### 1.4 "Longer Hydration windows" — answered, on a premise that is false

See §3.1. The answer given ("we must persist, because upstream cannot serve history") is built on
one endpoint. Two others serve exactly that history.

### 1.5 The rest — genuinely covered

XCM value (drilldown §2, and the 10¹² inflation find is the best single result in the sweep set),
XCM flow viz (§3, matrix-first is the right call), Hydration beyond the DEX (hydration.md),
HyperFX drill-down (drilldown §1), cache surviving restarts (storage.md), live parachain netflows
(polkalytics + balances, with the `para`→`sibl` seam correctly identified), Asset Hub top holders
(balances §4), subtrope ingest (polkalytics — Subscan is dead, take the UI model not the data
layer). No complaints.

---

## 2. What nobody looked at

**Sources that exist and were never probed:**

- **SQD Portal's `hydradx` dataset.** polkalytics found the Portal and enumerated 200 datasets;
  storage.md spent its central section proving Hydration history is unobtainable. Neither crossed
  the streams. `hydradx` is in that list. So are `bifrost-polkadot`, `moonbeam-substrate`,
  `centrifuge`, `interlay`, `phala`, `acala`, `bridge-hub-polkadot`, `collectives-polkadot`,
  `astar-substrate`, `pendulum` — every chain the XCM graph names, from block 0, decoded, free.
- **orca `routedTrades` as a history source.** The hydration sweep found orca and used it for TVL
  history and a 24-hour trade count. Nobody asked it for the trade archive. It holds 6,582,661
  routed trades back to block 6,837,788 — **730,000 blocks earlier than the first
  `Broadcast.Swapped3`**, because it indexes the older event versions too. Every plan keyed on
  `Swapped3` silently begins in mid-2025 and nobody said so.
- **Coretime.** `coretime → polkadot` is the single busiest edge in the entire XCM dataset (5,506
  messages in 30 days, drilldown §3) and no sweep looked at coretime sales, renewal prices or core
  utilisation. It is the Polkadot economic story of this era and it is one chain away.
- **Bridge Hub / Snowbridge.** The other half of "XCM value transferred" is Ethereum↔Polkadot, it
  lives on Bridge Hub, and `bridge-hub-polkadot` is an SQD dataset. Zero coverage.
- **Staking and nomination pools.** One passing Dotlake mention. Staking moved to Asset Hub in the
  same migration polkalytics bisected to block 28,493,862 — that seam is exactly what this repo is
  good at explaining, and nobody claimed it.
- **Governance / OpenGov.** Referenda, treasury spends, voter turnout. Dotlake exposes
  `opengov-voter-history`; Polkassembly and Subsquare both have public APIs; nobody probed either.
  Not on Tommi's list, but a public Polkadot analytics site with no governance view is conspicuous
  by absence.

**Modalities nobody considered:**

- **Export.** Not one candidate offers CSV or JSON download. A public analytics site that cannot
  hand you its numbers is a screenshot factory, and the persistent store is what would finally
  make an export honest.
- **`/api` as the product.** It is already self-documenting and generated from the source
  registry. A persistent store makes it genuinely useful to third parties — and changes the load
  model. Nobody costed either direction.
- **RSS / a changes feed.** The natural ungated answer to "following", and the natural home for
  "this parachain's sovereign balance moved" or "a Bulletin lease expires tomorrow".

**The repository nobody read: this one.** `scripts/build-netflows-dataset.mjs` and
`src/data/netflows.json` are the existing, working, shipped answer to "persistence with no disk" —
compute offline, commit the derived dataset, serve it statically. Only arbs mentions it, in
passing, for one candidate. Nobody evaluated *commit the rollups to git* as a serious alternative
to a 10 GB volume. Given §3.1, it deserves a proper hearing: tier-3 rollups are 2.85 MB/year.

---

## 3. Where two sweeps contradict each other

### 3.1 Hydration deep history: unobtainable (storage) vs. one query away (hydration, polkalytics)

**This is the most consequential disagreement in the set, and the storage sweep loses.**

storage.md §2.3 is titled "The archive cannot give us deep history — **this is the central
finding**" and draws three conclusions from it: history not captured now may be unobtainable
later; therefore start ingest before the concept is finished; therefore keep a tier-1 raw NDJSON
archive (192 MB/yr, the largest line in the disk projection) because "a rebuild from upstream is
not a plan, it is a hope."

Every one of those measurements is of **`explorer.hydradx.cloud` specifically**. Two other
anonymous sources serve the same history:

| | explorer.hydradx.cloud (storage.md) | SQD Portal `hydradx` (me) | orca `routedTrades` (me) |
|---|---|---|---|
| 1 day at block 8,000,000 | 7,160 ms once, then 3× 12 s timeout | **381 ms**, 1.57 MB | **276 ms**, 181 KB |
| coverage | tail only, reliably ~3 days | block 0 → **12,344,549** | block **6,837,788** → head, live |
| granularity | raw legs | raw legs, decoded, named args | **trades, already de-legged** |
| whole history | not servable | ~340 windows | 6,582,661 rows @ ~181 B ≈ **1.2 GB / ~33 min** |

The complete trade history of Hydration, already grouped — the grouping this repo does by hand and
`CLAUDE.md` warns about — is a ~33-minute replay against a live endpoint, repeatable. What follows:

1. **The urgency argument is void for Hydration.** It remains entirely valid for Bulletin, which
   really is pruned at 201,600 blocks. Do not let the Hydration correction relax the Bulletin
   deadline; they are unrelated and storage.md is right about the second one.
2. **The tier-1 raw archive loses its justification.** Its stated purpose was rebuilding without
   asking upstream. Upstream answers. Keep an archive if you want a snapshot of what a source said
   on a given day — that is a real and different reason — but not this one, and not at 192 MB/yr.
3. **The disk ask shrinks.** 10 GB was driven by legs (1.28 GB/yr indexed) plus the archive. Drop
   both and year 1 is ~140 MB of trades and rollups. That is small enough that "commit the rollups
   like `src/data/netflows.json`" is back on the table and the volume conversation may be
   avoidable for v2.0.
4. **But do not treat either new source as durable.** SQD's `hydradx` is `real_time:false` and its
   head has not moved since **2026-05-08 — 103 days**. It is a frozen dataset, useful as a bulk
   backfill and worthless as a tail. orca is self-hosted by Hydration and *already moved once*
   (its own README's Subsquid Cloud URL 404s, per the hydration sweep). The right reading is: the
   history is obtainable **today**, from two independent places, so capture it deliberately once —
   but stop claiming it is perishable, and stop sizing a decade of disk around that claim.

### 3.2 `Liquidation.BorrowingContract` — arbs says it holds the Pool address, hydration says it is zero

arbs lists the money-market candidate as `verified: true` with "Pool address read from
`Liquidation.BorrowingContract` storage, governance-settable, **do not hardcode**". hydration says
"`Liquidation::BorrowingContract` is unset (H160 zero) so do not use it to find the pool."

Measured today under `twox128(Liquidation) ++ twox128(BorrowingContract)`:

```
value = null
Liquidation pallet prefix 0x9e9861398fc61607421639b2201415c2 -> exactly 1 key,
  suffix 4e7b9012096b41c4eb3aaf947f6ea429 = twox128(":__STORAGE_VERSION__:")
```

The pallet exists and holds **nothing but its storage version**. **hydration is right; arbs is
wrong and marked verified.** This matters beyond one address: arbs' guidance is the *good*
guidance (discover, don't hardcode) applied to a storage item that is empty, so following it
yields null and the next engineer hardcodes anyway — landing precisely in `CLAUDE.md`'s "reads as
'this map is empty' rather than as an error". Settle where the Aave Pool address actually comes
from before either candidate is built.

### 3.3 Hydration block time — 5.61 s (arbs) vs 6.0 s implied (storage), and both are quoting a trailing average as a constant

arbs asserts "block time is 5.61s not the 6.86s their constants assume" and corrects every
dollars-per-day figure up ~7%. storage.md's windows are 14,400 blocks wide and labelled "one UTC
day" — i.e. an implicit 6.00 s.

Measured today from `Timestamp::Now` at three spans:

```
last     1,000 blocks : 6.2162 s/block  -> 13,899 blocks/day
last    20,000 blocks : 5.8206 s/block  -> 14,844 blocks/day
last   200,000 blocks : 5.6088 s/block  -> 15,404 blocks/day
```

Both sweeps are right about their own window and wrong to state it as a property of the chain.
arbs' 5.61 s is the 200 k trailing average; storage's 6.0 s is nearer the recent rate. **And the
sign of arbs' correction is wrong for recent data:** at today's ~6.22 s, 14,400 blocks is ~24.9
hours, so a 14,400-block "day" *overstates* a day by ~4% rather than understating it by 7%.

The irony is that storage.md documents this exact trap for Bulletin — "the rate is monotonic in
window length here, so any short-window sample is measuring the current stall, not the chain…
treat any single rate as a trailing average with a timestamp, never as a property of the chain" —
and then does not apply it to Hydration. Neither should publish a blocks-per-day constant; both
should carry span and timestamp.

### 3.4 `Tokens::TotalIssuance` and `Tokens::Accounts` for `Erc20` assets

hydration's sharpest correction: `Tokens::TotalIssuance` is **meaningless for `Erc20`-kind
assets** (HOLLAR is 11,489,093.53, not the 20,631 in `docs/platform/hydration.md`), and a naive
`Tokens::Accounts` sweep of the Omnipool account **silently drops HDX and every `Erc20` asset —
5 of 19, including the two largest — understating TVL by roughly half.**

arbs, same day, same chain, proposes `Tokens.Accounts` prefix scans presented as complete ("all 36
`Tokens.Accounts` balances of the Omnipool pallet account in one call") and `Tokens.TotalIssuance`
for basket-share NAV. It half-knows — its HOLLAR candidate does add "plus `eth_call` `balanceOf`
for `Erc20`-kind assets" — but its cost model and its "one request returns the whole picture"
framing do not. Anyone reading the arbs candidates alone walks into the trap hydration documented.

(NAV specifically is probably fine: stableswap share tokens are `Token` kind. The Omnipool balance
sweep is not fine. Someone must decide which reads are Erc20-affected, once, in one table.)

### 3.5 Hydration archive retention — "probably full history" vs. a wall of timeouts

arbs' unverified list: "I read events at head-100 and at head-600,000 successfully, so retention is
at least ~40 days and **probably full history**." storage.md measured the same endpoint at 1 M,
5 M, 6.5 M, 6.9 M, 7.25 M and 8 M and got hard 12 s timeouts at every depth. arbs' inference is
refuted; it should never have been written as "probably" from two shallow samples.

Settled as a side effect of my probes: there are **zero** `Broadcast.Swapped3` events in full
14,400-block windows at 1 M, 5 M, 6.5 M and 7.25 M (HTTP 200, sub-400 ms, empty), and the first
one falls between **7,567,547 and 7,568,265**. So storage.md's unverified #3 resolves in its
favour — the timeouts were masking a genuine absence — but the resolution came from a different
endpoint, which is the whole point of §3.1.

### 3.6 Repo vs. reality: the deployed CSP is weaker than every document claims

Not a sweep-vs-sweep contradiction, but it invalidates reasoning several sweeps lean on, and **no
sweep fetched a single response header from our own production site.**

`docs/architecture/middleware.md`: *"Production serves `default-src 'self'` **with no exceptions**,
including `connect-src 'self'`."* `CLAUDE.md` working agreements: *"Under `style-src 'self'` the
browser silently drops it and every proportional bar renders at zero width"* and *"No inline
`<script>` … The CSP forbids it."*

What Caddy actually serves on `analytics.cypherpunk.agency` today:

```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline';
                         style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
```

`'unsafe-inline'` on **both** script and style, and `img-src … https:` allows any HTTPS image
host. The `connect-src` claim survives only via `default-src`; the inline-script and inline-style
claims are false against the deployed policy. Every v2 feature that renders third-party text
(Bulletin blobs, People Chain display names, Dotlake asset symbols, Subsquid strings) has been
reasoned about against a policy stricter than the one in force.

Either fix the header or fix the docs — but nothing that renders untrusted content should be
built until one of those has happened.

---

## 4. The single biggest unexamined risk

### 4.1 v2 makes this site a publisher of a persistent, searchable, name-attached corpus about identifiable people — and the words "personal data" appear nowhere in 256 KB of research

Assemble what is actually proposed:

- **balances**: enumerate every `System::Account` on Asset Hub (~3.9 M accounts) into a holder
  leaderboard; per-account balance history.
- **polkalytics**: fold every `Balances` event from block 0 into a per-account balance-change store
  (~135 M rows), *plus* index the People Chain — 3,054 identities with **display name, legal name,
  web and matrix handle** — and it names the join itself: "an identity lookup turns a leaderboard
  of hashes into a leaderboard of names."
- **drilldown**: per-address HyperFX order history, filtered server-side.
- **arbs**: a per-address *informedness* score, and it is the only sweep that flinches — "a public
  page naming identifiable pseudonymous parties with behavioural labels, and `docs/architecture/`
  does not contemplate that."
- **orca** (mine): 602,676 trades for a single address, whole history, one 1.46 s query.

Each input is public. The **assembly** is not the same object as its inputs, and the assembly is
what we would be operating: a profiling database over natural persons, run from the EU, on an
ungated public site, joined to legal names.

polkalytics gets closest — one paragraph, and its mitigation ("index accounts we can NAME") is
exactly right — but frames it as a courtesy. It is not a courtesy. Once the People Chain join is
in the store we are a controller of a database of named natural persons, and the defence that "it
is all on-chain anyway" fails for the reason polkalytics itself articulates: we lower the cost of
profiling from *run an archive node* to *type a name*. The chain is immutable and cannot be made
to forget. **Our index is mutable, and that is precisely why we can be told to change it** — and
we would have no mechanism, no contact route, and no policy.

Why this and not one of the technical risks: every technical risk here has an engineering answer
that can be applied late. This one constrains the **schema**, and the schema is what v2 is. Decide
before the first `CREATE TABLE`:

1. Store addresses we can **name structurally** — `para`/`sibl` sovereign, `modl` pallet,
   treasury. Those are institutions, not people, and the decoder polkalytics specifies is pure.
2. Do **not** persist the People Chain join. Resolve identities at read time, from live upstream,
   uncached, and never write a name into a row. That keeps the store pseudonymous and makes
   removal upstream's business, not ours.
3. Arbitrary-address lookup is a **deliberate product decision with a written rationale**, not a
   side effect of owning a table. If it ships, it should read live and store nothing.
4. Write the paragraph — what we index, what we do not, and what happens when someone objects —
   as `docs/decisions/0006-*.md`, before the store exists. `docs/decisions/0005-public-no-gate.md`
   already establishes that this repo argues these things out in writing; this is the sequel.

### 4.2 Runner-up, and the one that will bite first: proxying Bulletin blobs from our own origin

Bulletin is **permissionless storage**. Anyone can put anything in it, and §1.1 shows we can pull
it in 435 ms — including a 958 KB UnixFS bundle whose bytes contain `.bulletin-`, i.e. web content.

Serve that from `analytics.cypherpunk.agency` with a guessed or sniffed content type and it is
**stored XSS with full same-origin privileges over every other page on the site** — and per §3.6
the deployed CSP permits `'unsafe-inline'` script, so the architecture doc's assurance that the CSP
prevents this is factually wrong about the policy in force. Secondary: we would be an unfiltered
redistribution point for whatever a stranger uploaded to a devnet, on a domain with Tommi's name
on it.

None of this forbids the feature — it is the best missing item in the set. It constrains it:
a separate origin or a sandboxed frame, `Content-Disposition: attachment`, never `text/html`,
`nosniff` (already present), a hard size cap well under the 2 MiB `MaxTransactionSize`, decode and
render *structure* (it is JSON, it is a UnixFS directory, it is N chunks) by default rather than
content, and raw bytes only behind an explicit click. Verify the content hash before serving —
the `size` field already gives a free first check.

---

## 5. What makes this plan fail six months in

**1. Upstream churn, against a dependency count that quadrupled — and the good sources are the
fragile ones.** v1 has ~5 upstreams. The candidate set implies ~15, and the ones carrying the most
weight are unofficial: orca (self-hosted, *already relocated* — its own README's URL 404s),
`hydration-explorer.neckwork.net` and its RPC (one volunteer, an API discovered via a CSP header),
SQD Portal (`real_time:false`; its `hydradx` dataset **has been frozen at block 12,344,549 since
2026-05-08**), Dotlake (7 missing days, 10 valueless days, and rows inflated by 10¹² for two
years). In this **single day** of research: one source was found dead (Subscan went key-only), one
found relocated (orca), one found frozen (SQD hydradx), one found serving impossible numbers
(Dotlake's forty-quadrillion-dollar total). That is the base rate. Extrapolate.

*Mitigation the plan lacks:* every source module needs a liveness assertion that fails loudly —
"is this dataset's head advancing?" is one request and would have caught the frozen SQD dataset
before anything was built on it.

**2. Nobody owns ingest, and the evidence is on the screen right now.**
`analytics.cypherpunk.agency` returns **HTTP 502 on `/`, `/api`, `/api/hydration/swaps` and
`/healthz`**. Six sweeps ran a full day against this repo and the only mention is a footnote in
drilldown.md recording it as an "incidental observation" whose cause "belongs to whoever is
looking at deployment." It belonged to nobody.

A stateless cache that is down is embarrassing and self-healing. **A stateful ingest that is down
silently loses the days it did not fetch**, and storage.md's own coverage/`gaps`/`lagSeconds`
design assumes a human reads it. There is one VM, one person, no alerting, no on-call, and a
`/healthz` that is currently 502. Six months in, half the streams have holes nobody noticed,
because the charts still render — which is exactly the failure mode `CLAUDE.md` rule 2 was written
to prevent, relocated from the browser to the ingest worker.

**3. Derived data rots, and rule 3 cannot reach backwards.** v1's quiet superpower is that every
number is a pure function of upstream, recomputed each TTL: fix a decoder, and every number on the
site is correct within one TTL. v2 stores *derived* rows. The two best finds in this whole sweep —
HOLLAR reported as 20,631 instead of 11,489,093, and Dotlake's 10¹² decimal inflation — are
exactly the class of bug that, once written into eighteen months of rows, is invisible and
permanent.

Only polkalytics proposes a reconciliation gate ("read `system.account` at both ends of each
window, fold the events between, **refuse to commit if they disagree**") and only for balances. It
is the best idea in the entire research set and it is scoped to one stream. There is no equivalent
for trades, XCM value or rollups, and no story at all for *we found a decoder bug, now re-derive
eighteen months.* Generalise it: every stream needs an independent check of a stored aggregate
against a live read, run continuously, and a documented re-derive path. §3.1 makes the re-derive
path cheap for Hydration (33 minutes) — which is another reason not to over-invest in the archive
and to invest in reconciliation instead.

**4. Scope, uncosted.** Forty-plus candidates across six sweeps, sized individually as S/M/L. The
effort labels are per-candidate; the machinery every "S" silently depends on — an ingest scheduler,
backfill walkers with attempt budgets, coverage/gap plumbing through the API into every chart,
reconciliation, a store migration path, liveness assertions per source — is costed nowhere. The
first three candidates pay for all of it; that is fine, provided somebody says so out loud before
picking the first three. Right now the plan reads as forty cheap things, and it is one expensive
thing plus forty cheap things.

---

## 6. The cheapest corrections, in order

1. Re-fetch `analytics.cypherpunk.agency` and fix the 502 before designing anything else. It is
   the whole product.
2. Exclude `docs/concept/` from `/knowledge/` **by allowlist**, before that page ships (§1.2).
3. Re-run storage.md §2.3's conclusions against orca and SQD; shrink or drop the tier-1 archive
   and re-derive the disk ask (§3.1). This may remove the volume request from v2.0 entirely.
4. Settle `Liquidation.BorrowingContract` and publish one Erc20-affected-reads table, so arbs and
   hydration stop giving opposite advice (§3.2, §3.4).
5. Reconcile the deployed CSP with the documents — either direction, but pick one (§3.6).
6. Write `docs/decisions/0006` on what we index about people, before the schema (§4.1).
7. Add `bitswap_v1_get` to the Bulletin module as a **structure** reader, with §4.2's constraints
   in the same commit.
8. Add a head-is-advancing liveness assertion to every source module (§5.1).

---

## Unverified in this critique

- I did not test whether orca can be *paged* through all 6,582,661 trades in practice. I verified
  block-range windowing (0.28 s/page at 8.0 M) and `totalCount`; a full 33-minute backfill is an
  extrapolation from one page, and PostGraphile deep-cursor behaviour was not exercised.
- The ~1.2 GB wire estimate for the full orca history is 181 B/trade × 6.58 M rows, measured on one
  window at block 8.0 M with only `paraBlockHeight` + inputs + outputs selected. A wider field
  selection costs more.
- I did not check whether SQD's `hydradx` dataset is permanently frozen or merely lagging. Its head
  has not moved from 12,344,549 across my probes today; 103 days of staleness plus
  `real_time:false` is strongly suggestive, not proof.
- The `Liquidation.BorrowingContract` null is one storage read under one derivation. I confirmed the
  pallet exists and holds only `:__STORAGE_VERSION__:`, which I consider decisive, but I did not
  cross-check the item name against `state_getMetadata`.
- I did not verify the *content* of the Bulletin objects beyond their first bytes, nor confirm the
  sha2-256 multihash matches the CID (I compared byte length to the index's `size` field, which
  matched exactly for both files).
- Legal characterisation in §4.1 is my reasoning about an obvious exposure, not advice. The
  actionable part is that six sweeps never raised it; the remedy is a written decision, and the
  question of whether it needs a lawyer is Tommi's.
- I did not probe coretime, Bridge Hub, staking or governance endpoints at all — I am asserting
  that nobody looked, not that they would work.
