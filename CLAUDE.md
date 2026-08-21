# polkadot-analytics

Public analytics dashboards over Polkadot ecosystem data, at
[analytics.cypherpunk.agency](https://analytics.cypherpunk.agency). Also a knowledge base: the
`docs/platform/` notes exist so a question about the relay chain, Asset Hub, Kusama, XCM, contracts,
the People Chain, Hydration, Hyperbridge, Bulletin, the bridges, how a parachain leaves, how an asset
gets a dollar figure, or what every upstream costs can be answered from this repo without going and
reading a chain first. `docs/README.md` is the index and lists every one of them.

**This is not an app built on the Polkadot SDK.** It reads public chains, indexers and APIs and
draws the result. It may use the SDK if something genuinely needs it; nothing does yet.

## The three rules

**1. No secrets. Ever.** There is no API key, no token, no service-account file and no `.env`
anywhere in this repo, and there must not be. Every upstream is anonymous public HTTP. If you
find yourself wanting a credential, that is a design conversation, not a `.env` line — say so
before writing any code. `npm run check` fails the build on credential-shaped files.

**2. The browser talks only to this origin.** Every upstream call happens server-side. This is
enforced, not hoped for: `npm run check` fails if an absolute URL appears outside
`server/sources/`. Two reasons — the production CSP is `connect-src 'self'`, so a direct fetch
would fail *silently* (page renders, 200 everywhere, chart empty); and the pages are heavy
clients that would otherwise DoS a volunteer-run devnet node once per visitor.

**3. Say what is wrong with the number.** Every page carries a data-notes section generated from
the same payload the charts are drawn from. An unpriced asset, an interpolated timestamp, a
pallet account in a "top traders" list, a dollar figure that is really a floor — these get
stated on the page. A number without its caveat is worse than no number.

## Layout

```
server/                 the API. Node 22, zero runtime dependencies.
  index.mjs             static files + /api + /healthz
  lib/                  cache (TTL + single-flight), upstream calls, param validation
  sources/              ONE MODULE PER UPSTREAM — the security boundary, see below
src/
  core/                 shared by browser AND server: codec, pricing, swap model, API client
  design/               the design system. Every page is built from this and adds no CSS.
  sources/pages.js      the site map — nav and home index both read it
  pages/<name>/main.js  one entry per dashboard, mostly ~20 lines
  data/                 committed derived datasets (netflows)
docs/
  README.md             the index. Every architecture, platform and decision doc is listed here
  architecture/         how this repo works
  platform/             how POLKADOT works — the knowledge base
  decisions/            why we chose what we chose
  concept/              working notes, NOT published: plan.md, research-queue.md, dated sweeps
<name>/index.html       one directory per page; the directory IS the URL
```

## Where to start for a given task

| Task | Start here |
|---|---|
| Add a data source | `server/sources/` — add a module, register it in `index.mjs`. Nothing else changes. |
| Add a dashboard | `src/sources/pages.js` + a `<name>/index.html` + `src/pages/<name>/main.js`. Vite discovers the directory. |
| Change how anything looks | `src/design/tokens.css`. Nothing else names a colour or a size. |
| Add a chart form | `src/design/charts.js`. Read `docs/architecture/design-system.md` first — the palette is validated, not chosen. |
| Store history rather than re-fetch it | A `jobs` entry on an existing source module. Read `docs/architecture/jobs.md` first — the fact's *identity* is the decision, and it is the expensive one to get wrong. |
| Understand a chain | `docs/platform/`, indexed by `docs/README.md` |
| Find out what is open | `docs/concept/research-queue.md`. Add to it before you finish. |
| Deploy | `docs/architecture/deployment.md` |

## Working agreements

- **Write down what you learned, before you move on.** This repo is a knowledge base as much as
  a site, and the only thing that keeps it one is that findings get written down at the moment
  they are found. When you learn how a chain, pallet, contract, indexer or API *actually*
  behaves — especially where it differs from its own documentation — record it before the task
  that turned it up is finished. Where it goes:
  - **`docs/platform/`** — how the thing works. One file per chain or protocol. This is the
    knowledge base proper: the test is whether the next person can answer the question from
    this repo without going and reading a chain first.
  - **`CLAUDE.md`'s "Facts worth not re-deriving"** — traps that fail *silently*. A wrong
    number that renders perfectly belongs here, in one or two sentences, stating the trap and
    why it is quiet.
  - **`docs/decisions/`** — why a choice went the way it did, including the options rejected.
  - **`docs/concept/plan.md`** — what we decided to build, and what is still open.
  - **`docs/concept/research-queue.md`** — questions this task *opened* and did not answer. Almost
    every task here turns some up, and they decay fast: unrecorded, they are either re-derived
    later at full cost or dropped along with whatever they would have unlocked. Record them
    **and say so in your report** — a question the reader can see is a thread they can start now
    rather than next week.

  Two rules about *how*: carry the evidence and its date (what you read, off which endpoint,
  when — the way `docs/platform/hyperbridge.md` does), and mark the difference between what you
  verified and what you inferred. And **correct what is already there when it turns out to be
  wrong** — appending a contradiction and leaving both is worse than either, because the next
  reader cannot tell which one is current.

  **This applies to subagents in full, and matters more for them.** A subagent's context is
  discarded when it finishes: research it did not write into the repo is not merely un-shared,
  it is destroyed, and the next agent pays to re-derive it. A subagent that finds something
  worth knowing writes it down as part of the task, not as an optional extra — and says in its
  final report what it recorded and where.

- **Research first, write it down, then build.** For anything that touches a chain, a pallet, a
  contract or an upstream: find out how it actually behaves, record it in `docs/platform/`, and
  only then write code against it. The ordering is what makes the finding survive — research that
  goes straight into an implementation is research nobody can check and the next task pays for
  again. A task touching only this repo's own code (a component, a layout, a refactor) skips this;
  the trigger is an external system, not size.

- **When the evidence is inconclusive, write the probe.** Do not reason harder, and do not stop at
  "unverified" — write the smallest script that would settle the question and run it. It is almost
  always cheaper than the argument: three RPC calls settled what `ForeignAssets` actually holds
  after several thousand words of careful inference had not. Then keep what it returned — paste the
  real response into the `docs/platform/` note with the date and the endpoint it came from, the way
  `docs/platform/hyperbridge.md` does. A probe that settled a question once is the reproduction for
  whoever doubts it next.

  **But a probe tells you WHAT, and only the source tells you WHY.** "34 keys begin with `02`" is
  an observation that could be a coincidence of today's registry. "The runtime's filter refuses to
  create any other kind" is a guarantee. Same fact, completely different confidence — and only the
  second is safe to build a discriminator on. Probe when the question is what is *there*; read the
  runtime when the question is what a value *means*, or when a rule has to still hold next month.

- **Storage keys are computed, never hardcoded.** A hardcoded prefix is right until a runtime
  upgrade moves it, and then reads as "this map is empty" rather than as an error. See
  `server/sources/hydration.mjs` and `bulletin-chain.js`.
- **Decoders self-check.** `decodeAssetDetails` throws if it does not consume its input exactly,
  and the registry is verified against three known assets before any price is computed. Wrong
  decimals are a silent factor of 10ⁿ on every total on the page — they must fail loudly.
- **Never set styles with `setAttribute('style', …)`.** Under `style-src 'self'` the browser
  silently drops it and every proportional bar renders at zero width. Use the `style` prop on
  `el()`/`svg()`, which routes through CSSOM. This has already bitten once.
- **No inline `<script>`, no CDN, no webfonts, no external anything.** The CSP forbids it and it
  fails silently, not loudly.
- **`null` is not `0`.** "We could not value this" and "this was worth nothing" are different
  facts and the arithmetic must keep them apart. Same for a chart series: a missing value breaks
  the line, it does not draw to zero.
- **Empty days are drawn, not dropped.** A gap in activity is information.
- **Bars are linear from zero.** A log scale on a ranking makes a long tail look like a
  distribution of equals.
- **One y-axis. Never two.**
- Prefer plain, boring frontend. There is no framework and there does not need to be.

## Running it

```bash
npm install
npm run dev       # Vite on :5180, API on :8080, /api proxied
npm run preview   # production build + the real server on :8080
npm run check     # syntax, secrets, source registry, no external URLs, docs, no local paths
```

## Facts worth not re-deriving

- Hydration emits **one `Broadcast.Swapped3` per swap LEG**. Legs of one trade share the first
  element of `operationStack`. Not grouping them multiplies volume by the hop count.
- Hydration accounts beginning with hex `6d6f646c` are `modl` — pallet accounts, not people.
  On a normal day two thirds of the "trades" are the fee processor and DCA machinery.
- **Hydration's Omnipool hub asset (id 1) is `H2O`, not LRNA.** It was renamed; a lot of writing
  about Hydration, including its own older material, still says LRNA. The registry is the
  authority and it says H2O.
- `operationStack` variants **verified live in runtime 435** are `Omnipool`, `Router`, `DCA` and
  `Batch` (2026-08-19), plus `Xcm`, observed on /hydration/ on 2026-08-20. `Direct` is ours, for a
  leg with no stack. `ICE` appears in third-party writing about
  Hydration but has **no pallet, no storage and no metadata presence** — do not report it as a
  category. The code uses whatever the chain sends rather than mapping onto a fixed list.
- **Bulletin's `RETENTION_BLOCKS = 201_600` is inherited, not verified here.** On the sibling
  chain `paseo-bulletin-next`, `AuthorizationPeriod` is *also* 201,600 while `RetentionPeriod`
  differs — so a wrong transcription would be completely invisible. Settle it by reading the
  `TransactionStorage` constants out of `state_getMetadata`.
- The Bulletin devnet is a **single node and it does go down** (observed unreachable for several
  minutes on 2026-08-19). Unreachable is an ordinary state, not an error to retry through.
- HyperFX's own headline volume is cumulative protocol dust × 2,000, not a sum of its orders.
  This site sums the orders, and the two disagree.
- USDC and USDT are **18 decimals on BNB Chain and 6 everywhere else**. Keying decimals by
  symbol rather than by chain is a factor-of-a-trillion error that renders perfectly.
- Dotlake's `total_value_usd` is `0.0` for anything it cannot price, which is indistinguishable
  from a message that moved nothing — **and** it contains decimals-corrupted rows (summed to
  $39.9 quadrillion in one day's data). It is neither a floor nor a ceiling: use row-level
  records with a sanity cap, and state on the page how many rows were excluded and why.
- The Bulletin devnet RPC is `bulletin-paseo.tservices.es:8443`. **Not**
  `paseo-bulletin-next-rpc.polkadot.io` — a different chain, which renders a plausible and
  entirely wrong view.
- **Three "global consensus" sovereign prefixes exist in current SDK source, and Ethereum uses
  none of them.** `GlobalConsensusConvertsFor` hashes `(b"glblcnsnss_", network)`; the current
  `ExternalConsensusLocationsConverterFor` hashes `(b"glblcnsnss/prchn_", network, para_id)` for a
  parachain behind a foreign consensus and `(b"glblcnsnss", network, tail)` for everything else —
  **except Ethereum, which it special-cases onto `(b"ethereum-chain", chain_id: u64)`**
  (source-verified in `polkadot/xcm/xcm-builder/src/location_conversion.rs`, 2026-08-20). All of
  them derive a valid-looking `AccountId32`; the wrong one returns `null`, which renders as "the
  Ethereum bridge holds nothing". Verified live on Asset Hub the same day: Ethereum's reserve is
  `1jMhfSJv5MkSQmEq97UmXCmMV63SHoQ3ednwkRSKETrCREU` with 20,679.76 DOT (both `glblcnsnss`
  derivations have no account at all), and Kusama Asset Hub's is
  `12GvRkNCmXFuaaziTJ2ZKAfa7MArKfLT2HYvLjQuepP3JuHf` with 407,487.13 DOT — para id encoded as a
  **plain u32**, not SCALE-compact. Two further traps in the preimage, each producing a
  valid-looking account with no state: the Ethereum `chain_id` is a **plain u64 little-endian**
  there even though the same field is `#[codec(compact)]` inside `NetworkId`; and the tail is a
  `&[Junction]`, which SCALE-encodes with a compact length prefix, so a bare global-consensus
  preimage **ends in `0x00`**.
  **But do not transcribe any of this — ask the runtime.** Asset Hub exposes
  `LocationToAccountApi_convert_location` over plain anonymous `state_call` (arg: a
  `VersionedLocation`, `0x05` for V5; result: `Result<AccountId, Error>`, so `0x00` then 32 bytes).
  Hand-derivation and the runtime API agree byte-for-byte on all five locations tested — and the
  API **cannot go stale across a runtime upgrade, because it is the tuple rather than a copy of
  it.** This is the same principle as computing storage keys instead of hardcoding them, one level
  up: when a chain will tell you the answer, do not re-implement its logic.
  One more thing the derivation makes look broken when it is not: the **Kusama global-consensus
  sovereign is genuinely empty**. KSM does not arrive from Kusama-the-relay; it arrives from
  **Kusama Asset Hub**, whose para-level sovereign
  `12GvRkNCmXFuaaziTJ2ZKAfa7MArKfLT2HYvLjQuepP3JuHf` is the one holding the 407,487 DOT.
- `pallet-assets` emits `Issued { asset_id, owner, amount }` but `Burned { asset_id, owner,
  balance }` — **the same quantity under a different field name** (source-verified,
  `substrate/frame/assets/src/lib.rs`, 2026-08-20). Reading `amount` on a burn gives `undefined`,
  and a supply series built as mints minus burns quietly becomes a series of mints.
- **USDC (1337) and USDt (1984) on Asset Hub are not bridged.** Circle and Tether issue them
  directly — no wrapper, no bridge custodian. Ethereum-issued USDC
  (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) exists **separately** in `ForeignAssets`, with a
  supply of 550,876 on 2026-08-20 (verified live). Two USDCs, different ids, different provenance,
  same three letters. Never sum by symbol, and never call the total "bridged".
- **Chainflip's DOT leg moved from the relay chain to Asset Hub, and the relay leg is deprecated
  in place.** `cf_supported_assets` still returns `Polkadot.DOT` beside `Assethub.DOT/USDT/USDC`,
  and every fee, delay and safety-margin map still carries a `Polkadot` key — but
  `cf_available_pools` has an `Assethub.DOT / Ethereum.USDC` pool and **no `Polkadot.DOT` pool at
  all** (verified live, `archive.mainnet.chainflip.io`, 2026-08-20). Its own SDK agrees:
  `@chainflip/utils` 2.2.8 has `legacyChainflipChains = ["Polkadot"]`. Measuring the relay vault
  today reads a deprecated address, and nothing in the RPC says so.
- **iBTC's 8 decimals are a compile-time Rust constant** — `IBTC("interBTC", 8) = 1` in
  `interbtc/primitives/src/lib.rs` (source-verified 2026-08-20) — and cannot be read from any
  storage item. It is the one asset here whose divisor does not come from a registry, so it needs
  a plausibility canary instead: chain-wide issuance was **2.118 iBTC** on 2026-08-20
  (`Tokens::TotalIssuance(Token(IBTC))`, verified live), and a decimals error is a factor of 10ⁿ,
  so any figure in the thousands of BTC is the constant being wrong rather than the protocol
  growing.
- **Moonbeam removed `pallet_assets` entirely.** Its runtime carries the tombstone
  `// [Removed] Assets: pallet_assets = 104` and registers
  `EvmForeignAssets: pallet_moonbeam_foreign_assets = 114`, whose assets are native EVM ERC-20
  contracts read with `eth_call` (source-verified in `runtime/moonbeam/src/lib.rs`;
  `pallet_assets` appears zero times in its live metadata, verified live 2026-08-20). A
  Substrate-only read of Moonbeam finds GLMR and nothing else — not an empty map, not an error,
  just a chain that appears to hold one token.
- **DOT is Hydration asset 5, it is in NO Omnipool and NO stableswap pool, and it is still priced.**
  It reaches the dollar through a **1:1 money-market wrap to `aDOT`** (verified live: across all 282
  `AAVE`-filled DOT↔aDOT legs in 24 h, deviation from 1:1 was exactly `0`), which *is* in the Omnipool.
  A pool-membership search therefore enumerates the Omnipool, the 17 stableswap pools and the 290 XYK
  pools, finds no liquid DOT/stable pair, and concludes DOT is unpriceable — **which was reported on
  2026-08-20 and is wrong.** DOT traded against USDT 168× and USDC 50× that same day, and
  `server/sources/hydration-evm.mjs` was already publishing `oraclePrice: 0.826` for it in production.
  The repo's own canary `[5,'DOT',10]` in `arbs-hydration.mjs` had been asserting this and throwing on
  disagreement the whole time. Price DOT with `getAssetPrice(0x…0100000005) / 1e8`; see
  `docs/platform/hydration.md`.
- **`getAssetPrice(aDOT)` reverts — the oracle prices underlyings, not aTokens.** An aToken's price is
  its underlying's price. Reading the revert as "no price" and falling back to `0` values the
  Omnipool's largest DOT position at nothing, and the page still renders.
- **Hydration block time is a trailing average, never a constant: ~5.71 s recently, ~6.85 s over a
  year — not 12 s.** Extrapolating a block height from a target date rendered as a perfectly plausible
  **4.5 % oracle discount** on 2026-08-20 before the sampled blocks were checked. Bisect on
  `Timestamp::Now`; never multiply an assumed rate. This is the **second** recorded instance —
  `docs/concept/plan.md` and `docs/concept/research/critique.md` already carry the measurements
  (6.22 s / 1 k, 5.82 / 20 k, 5.61 / 200 k) and `hydration.mjs` already opens by warning about it.
  The trap is not that the rate is unknown; it is that the arithmetic is so convenient.
  **And the trailing averages above understate the spread badly once you walk history**: measured
  day by day off orca on 2026-08-20, a UTC day held **6,188 blocks on 2025-01-25 (13.96 s/block)**
  and **17,702 on 2026-07-15 (4.88 s/block)** — a factor of 2.9, with the halving falling between
  April and June 2025. A backfill that steps day by day must carry the *previous day's measured*
  block count forward and check it; `swaps-daily` does, and never needed its scan fallback in 61
  days. See `docs/platform/hydration.md`.
- **A daily bar is labelled by its OPEN.** A price read on-chain at 00:00 UTC on day D lines up with
  day D's open, not its close. Comparing against the close leaves a ~1.4 % median offset that reads as
  genuine oracle drift rather than as an off-by-one-day.
- **A parachain can answer every call and still be weeks stale.** On 2026-08-20 Moonbeam's
  `Timestamp::Now` read 2026-08-10T11:36:12Z and Interlay's read 2026-07-27T12:13:01Z — 10 and 24
  days behind the wall clock — while both RPCs served state normally, Interlay's GraphQL squid
  answered with 102 query fields, and the relay chain had no `Paras::Heads` entry for Moonbeam's
  para 2004 at all. Nothing is down; the numbers are simply old, and they render perfectly. Read
  `Timestamp::Now` and compare it against the clock before believing any per-chain figure.
- **A `jobs` entry SHADOWS an `operations` entry of the same name — it does not sit beside it.**
  `/api/<source>/<name>` resolves mode A first (`server/index.mjs`), so naming a store-backed job
  after a live operation takes the URL away from it: the page keeps getting 200s, now carrying a
  store envelope it cannot draw, and nothing throws or logs. This is why the first handler is
  `hydration/swaps-daily` and not `hydration/swaps`. `npm run check` now fails the registry group
  on a collision, and `server/test/api.test.mjs` asserts the shadowing so the reason survives.
- **A store fact is keyed by its PARAMS, so two identities never share a segment.** An operation
  parameterised by a free `{from, to}` range re-fetches and re-stores every day of every window
  anyone asks for — ten overlapping year-long readers are ten full backfills against an upstream we
  do not own, with correct answers, a full coverage bar and nothing anywhere reporting it. Pick a
  fixed bucket many readers land on (`swaps-daily` uses `{month}`, segments = its ISO days). The
  opposite mistake is equally quiet: an identity of "everything up to now" can never be immutable,
  and if it completes anyway `serveFromStore` answers *complete* forever and no later day is ever
  fetched. **And the same rule bites backwards: ADDING a param to a filled job orphans everything
  already in it.** `{"month":"2026-01"}` and `{"month":"2026-01","network":"polkadot"}` are
  different canonical params, so making `network` required on `netflows-daily` re-derived all 1,673
  stored Polkadot days and left the old rows as dead weight — correct answers, full coverage bar,
  nothing reporting it. Pay it knowingly, or run the forward-only `UPDATE` in
  `docs/decisions/0015-netflows-is-parameterised-by-network.md`. See
  `docs/architecture/jobs.md`.
- **`queue.enqueue` is find-or-create over LIVE states only, and `done` is not one of them.**
  Enqueuing an identity that already finished does not join it — it mints a NEW job and refetches
  every segment already stored. Anything that enqueues without asking `describeIdentity` first (a
  boot warm-up, a cron, a retry loop) turns "immutable data is fetched once and never again" into
  "refetched every time", with correct answers, a full coverage bar and nothing anywhere reporting
  it. `server/lib/warm.mjs` checks; `server/test/warm.test.mjs` asserts it.
- **`MAX_LIVE_JOBS_PER_OPERATION` is counted per `(source, operation)` ACROSS ALL PARAMS, so
  warming half a page is worse than warming nothing.** `countLive` in `server/lib/jobs.mjs` does not
  look at params. Warming is deliberately exempt from the cap, but a *reader* is not — so a boot
  warm-up that enqueued only Polkadot's 55 netflows months would refuse a Kusama reader arriving
  during the drain with "the queue is busy" for the whole of it, having made the half it did not
  warm strictly harder to fetch than before. `netflows-daily` warms both networks for that reason,
  not for a reason about cost.
- **A job SIGKILLed mid-batch is not runnable for up to `leaseMs` afterwards.** Its lease was
  heartbeated seconds before the process died, so at the instant a redeploy comes back up the row is
  `running` with a lease still in the future — `hasRunnable()` is false, a one-shot check at boot
  correctly finds nothing to do, and then never looks again. Reproduced 2026-08-21: a netflows
  backfill sat at 30/31 across a restart. Anything that resumes work at boot needs a **tick**, not a
  check; `failed` jobs backing off for up to an hour have the same shape.
- **A daily balance series is labelled by its CLOSE, and the 2021–2023 netflows archive is too.**
  `src/data/netflows.json` defines a day as "the last balance observed at or before the end of that
  UTC day", and reading `System::Account` at the UTC day's LAST BLOCK reproduces it to the planck —
  Acala 1,462,204.186283087 DOT at relay #10,549,397 against that file's 2022-05-31 row (verified
  2026-08-20). Reading at 00:00 of the same day instead shifts the whole series one day EARLY and
  reads as a genuine one-day lead. This is the mirror of the oracle-bar entry above: there a bar is
  labelled by its open, here by its close, and neither is guessable from the numbers.
- **Both Asset Hubs have state but NO CLOCK below a launch block** — Polkadot's **#305,204**
  (2021-12-18T18:52:54.582Z, `statemint 601`) and Kusama's **#66,687** (2021-06-03T15:36:00.509Z,
  `statemine 1`). Below those, `state_getRuntimeVersion` answers normally while `Timestamp::Now`
  answers `null` (verified live 2026-08-20 and 2026-08-21). That is the pre-launch period, not
  pruning — but it looks identical to a pruned archive, and a balance read against a pruned block
  also answers `null`, which is indistinguishable from "this account holds nothing". Guard on
  `Timestamp::Now`, which every real block has: refuse a day whose block cannot produce a timestamp
  inside that UTC day. It is what sets each netflows series' floor — 2022-01 for Polkadot, 2021-07
  for Kusama. All four public endpoints (`rpc.polkadot.io`,
  `polkadot-asset-hub-rpc.polkadot.io`, `kusama-rpc.polkadot.io`,
  `kusama-asset-hub-rpc.polkadot.io`) are otherwise full archives to genesis.
- **Asset Hub's block rate has moved by a factor of six inside 2022–2026** — 12.51 s/block on
  2022-05-31, 12.80 on 2024-03-01, 6.57 on the migration day 2025-11-04, **2.24 on 2026-08-19**
  (all measured day-over-day from the chain, 2026-08-20). The relay chain sat at 6.00–6.10
  throughout. A block rate averaged over the whole range sits between Asset Hub's two regimes and
  is wrong in both halves, so a date→height extrapolation is worse here than the Hydration case
  already recorded above. Measure the rate LOCALLY from the samples nearest the target, and verify
  every boundary against the chain's own timestamps. See `docs/platform/asset-hub.md`.
- **The 2023 netflows study measured ONE of the two sovereign accounts, and its last day is not a
  whole day.** It read `para` on the relay chain only; on 883 of the 2,442 Polkadot chain-days in its
  window the same chain also held DOT in its `sibl` account on Asset Hub (up to 1.12% of its total
  then, essentially all of it now). **On Kusama the same omission is not a footnote: 1,714 of 3,515
  chain-days, and up to 96.77% of the holding** — Picasso on 2022-12-23 held 66.11 KSM on the relay
  and 1,981.38 KSM in its `sibl` account on Statemine. And on its final row all chains disagree with
  a fresh read by up to 23.6% (Polkadot, 2023-04-08) and 7.22% (Kusama, 2023-03-12) — its captures
  stop mid-day, so its published "at the end" figures are mid-day readings, not day-end ones, on
  both networks independently. Everywhere else the two agree to a median 4.0 × 10⁻⁹ (Polkadot) and
  8.3 × 10⁻⁸ (Kusama).
- **`overflow-y: auto` silently turns on horizontal clipping too, so a page can measure clean while
  a row inside it is broken.** CSS computes `overflow-x: visible` to `auto` whenever the other axis
  is not `visible`, so `.scroll-y` (`max-height: 28rem; overflow-y: auto`) is also a horizontal
  scroller. On 2026-08-21 the same over-wide `.rank-row` overflowed the document to 423px at a 390px
  viewport on `/netflows/`, which appends its list straight to the card — and produced
  `documentElement.scrollWidth === 390`, a perfect score, on `/hydration/` and `/hyperfx/`, which
  put theirs inside `.scroll-y`. The only symptom left there was a `2fr` bar track squeezed to 9px
  at 390 and 0px at 360: a chart of nothing, rendering perfectly. Measure the ROW, not the document
  — `documentElement.scrollWidth` cannot see inside a scroll container.
- **KSM is 12 decimals and DOT is 10, and the netflows page divided planck by a module constant.**
  A Kusama series drawn with the DOT divisor is exactly **100× too large** and renders perfectly —
  Karura's 2022 peak reads 17.0 M KSM instead of 169,884. `series.js` now takes the divisor from the
  network and throws without one, and `netflowsHeads` asserts token and decimals against
  `system_properties` on every read rather than trusting its own table. Kusama's SS58 prefix is
  **2**: a sovereign address rendered at prefix 0 is a valid-looking *Polkadot* address for a Kusama
  account. See `docs/platform/kusama.md`.
- **The Kusama Asset Hub Migration is 2025-10-07, and that is now bisected rather than
  transcribed.** Karura's `para` account on the Kusama relay falls 40,394.8 → 160.0 KSM across
  #30,424,405→#30,424,406 (2025-10-07T14:47:54Z), and it was **progressive, not atomic** — four
  other chains had not moved at that block. The date decides which leg holds the money on which side
  of it, so a wrong one silently misattributes the whole series; it was carried in two
  `docs/platform/` files as an unchecked transcription until 2026-08-21, and the transcription
  happened to be right. **No storage item says it** — bisect a large sovereign account, do not
  transcribe. Afterwards each chain keeps a *round* number of KSM plus exactly one existential
  deposit on the relay, so reading only the relay leg returns a few hundred KSM per chain and looks
  entirely reasonable.
- **A relative-deviation verdict against the 2023 netflows archive is set by the smallest balance in
  the overlap, not by whether the two readings agree.** The archive rounds every balance half-up to
  **two decimal places** on both networks, so a value can be out by 0.005 tokens whatever it is —
  0.25 % of Polkadot's smallest overlapping balance (1.23 DOT) and **7.3 % of Kusama's (0.03 KSM)**.
  Two readings agreeing to the planck therefore score "agrees" on Polkadot and "disagrees on 35 of
  115 chain-days" on Kusama, and the only thing that changed was the denominator. Judge on the
  **absolute** gap against `ARCHIVE_QUANTUM = 0.005` and report the relative figure beside it. The
  bound is measured, not assumed: across 2,434 Polkadot chain-days the largest absolute gap is
  0.004999620 DOT — 99.99 % of the quantum, zero exceedances.
- **`fs.mkdirSync(dir, {recursive: true})` can SPIN FOREVER, and it never throws while it does.** It
  reads `ENOENT` from a mkdir as "the parent does not exist yet", creates the parent and retries the
  child — so on a filesystem that answers `ENOENT` to *creating* a child whose parent already exists,
  the two alternate forever. procfs does exactly that: `mkdir('/proc/x')` is `ENOENT` while `/proc`
  stats as a directory (verified on Linux 6.18, 2026-08-21, from Node and from `/bin/mkdir` alike).
  `ANALYTICS_DATA_DIR=/proc/nonexistent/nope node server/index.mjs` spun in C++ at 100 % CPU, thread
  state `R`, printed nothing, and never reached `server.listen` — so the `try/catch` that exists to
  degrade mode A could never fire, because **a catch only helps if the call returns.**
  `server/lib/store.mjs` now walks ancestors once, bounded by path depth. A process that is alive
  and not listening reads as "still starting" to every health check there is.
- **An unparseable answer from OUR OWN ORIGIN is not a `decode` error.** `src/core/client.js` threw
  `kind: 'decode'` for any `/api/*` response that would not JSON-parse, and `decode`'s on-screen
  advice is "a runtime upgrade changed a format" — so a 503 caused by a missing volume rendered as a
  chain-decoder bug and cost ten minutes of hunting the wrong layer. Every `/api/*` answer this
  server produces is JSON, including its errors, so a body that will not parse **did not come from
  the app**: it came from the edge, or the response was truncated. `decode` now only ever comes from
  the server's own `error.kind`, and the client quotes the first 80 characters of whatever answered.
- **SQD's portal stream TRUNCATES a block range and says nothing.** Ask `asset-hub-polkadot` for
  39,000 blocks and you get 25,699 — HTTP 200, well-formed NDJSON, and **no header, field or
  sentinel** marking the cut (measured twice, 2026-08-21; the cut looks byte-driven at roughly
  6.7 MB). The only signal is that the last row's block number is below your `toBlock`. A caller that
  does not loop on `last + 1` gets a window short at its **newest** end — the part a reader is most
  likely looking at — and every chart drawn from it renders perfectly. `fetchRange` in
  `server/sources/transfers.mjs` loops and throws if the stream ever fails to advance.
- **SQD accepts an event name that does not exist and answers 200 with no events.**
  `Bananas.Wobbled` verified live 2026-08-21. There is no schema check and no introspection to
  validate a name against, so a typo — or a name a runtime upgrade moved — renders as "this account
  never transferred anything" rather than as a failure. Pin the names as a constant with a test, and
  publish the per-name chain-wide match count on the payload so a name that has stopped matching
  shows up on the page as a zero.
- **SQD's `real_time` flag cannot tell a live dataset from a dead one.** Every Polkadot-ecosystem
  dataset reports `real_time: false`, including the two that are current. On 2026-08-21
  `asset-hub-polkadot` was ~2 h behind and `hydradx` was **104.5 days** behind, both flagged
  identically, both answering in under a second with well-formed rows. Only the head TIMESTAMP
  separates them, and `/datasets/<name>/head` does not publish one — stream the head block for it.
  The portal also publishes in batches: the Asset Hub head was byte-identical across 41 minutes of
  observation while its lag grew from 82 to 122 minutes.
- **Transfer events are ~30 % of the balance-changing events on Asset Hub, and the rest have no
  counterparty at all.** Over 1,600 blocks on 2026-08-21: `Deposit` 405, `Transfer` 399, `Withdraw`
  325, `Minted` 144, `Endowed` 69, `Assets.Transferred` 13. `Deposit`/`Withdraw`/`Minted` are
  single-ended `{who, amount}` — fees, staking rewards, the mint and burn halves of XCM — so they
  belong in a balance fold and cannot be graph edges. A page that folds transfers and calls it
  "everything this account did" is claiming a completeness it does not have.
- **Hydration registers the same Ethereum ERC-20 once PER BRIDGE, and the money market took the
  Wormhole one.** Asset 19 `WBTC` (oracle-priced) is `GeneralKey("wh") + GeneralIndex(2) +
  GeneralKey(0x…2260fac5…)` — Wormhole-wrapped; asset 1000190 is the *same Ethereum contract*
  arriving over Snowbridge, and `getAssetPrice` **reverts** on it. Likewise Hydration's oracle-priced
  `USDT` (10) and `USDC` (22) are `Parachain(1000) + PalletInstance(50) + GeneralIndex(1984 / 1337)`
  — Asset Hub's own Tether and Circle coins, the two that are *not* bridged. Never key a price by the
  ticker, and — one level up — **never key it by the underlying contract address either**: the bridge
  that wrapped it is part of the asset's identity. All locations read live from
  `AssetRegistry::AssetLocations`, 2026-08-21. See `docs/platform/prices.md`.
- **Hydration's money-market oracle prices 23 of 1,438 registered assets, that set is exactly
  `Pool.getReservesList()`, and it is keyed by two different kinds of address.** A revert means "not
  a reserve", not "no market" — it is the collateral valuation of one Aave fork, not a price feed for
  the chain (verified live 2026-08-21 by calling `getAssetPrice` on every registry id). A Substrate
  registry asset is `0x` + 31 zero bytes + `01` + the u32 id big-endian; an `Erc20`-typed one is the
  contract in its `AssetLocations` entry — **asked by id, HOLLAR reverts**, so a sweep keyed only by
  id silently drops the market's dollar-pegged asset and the Omnipool's best hub anchor. Nothing
  errors: the hub median just loses an anchor (109 bps from three against 76 bps from four, measured
  an hour apart) and HOLLAR reappears with an *Omnipool implied spot* label instead of the oracle's
  exact `1.00000000`. Both readings are plausible. The Omnipool's implied spot covers a different 19
  assets and agrees with the oracle to **under 1 %** on the four in the overlap.
- **Asset Hub's `ForeignAssets` key tail and Hydration's `AssetLocations` value are byte-identical
  for the same asset.** That is the join between the two chains — raw SCALE bytes, no decoding, no
  ticker. 22 of Asset Hub's 34 bridged assets match a Hydration id this way, and the match is
  corroborated independently: `Tokens::TotalIssuance` on Hydration equals `ForeignAssets` `supply` on
  Asset Hub *to the unit* for ENA, sUSDe and LBTC (verified live 2026-08-21), because essentially
  everything bridged in has been forwarded on to Hydration.
- **Every "Giga" token on Hydration is an aToken of a STABLESWAP POOL, no name-based filter catches
  it, and the registry cannot tell a 1:1 wrapper from one that is not.** `GDOT` (69) wraps the pool
  `2-Pool-GDOT` (690); `GETH` (420) wraps `2-Pool-GETH` (4200), whose own reserves are `aETH` — itself
  the aToken of ETH; `GSOL` (9001) wraps `2-Pool-GSOL` (90001); `GIGAHDX` (67) wraps `stHDX`. The
  Omnipool's third-largest position is therefore four hops from a token that is not a claim on
  something else on the same chain, and summing the four venues double-counts **$27.19 M of
  $90.02 M — 30.2 %** (verified live 2026-08-21; with the recursive-deposit deduction below it is
  $32.32 M, 36 %). Ask the contract — `UNDERLYING_ASSET_ADDRESS()` for
  an aToken, `asset()` for an ERC-4626 vault — plus registry type `StableSwap`/`XYK`. And the two
  answers are not equivalent: **an aToken is 1:1 with its underlying, an ERC-4626 vault share is
  not.** `uBIL` (550) is a 4626 vault over HOLLAR whose `convertToAssets(1e18)` reads **1.00988** — a
  0.99 % error today that grows with the vault's yield, and it renders perfectly. Both appear as
  `AssetType::Erc20`; only the contract distinguishes them. See
  `docs/platform/hydration-capital.md`.
- **Hydration's venues hold more of four assets than the CHAIN HAS, and that is correct Aave
  behaviour, not a bug.** A depositor can borrow the same asset and re-deposit it, and the money
  market's `supplied` — the aToken supply — counts every turn of the loop, so it is not a quantity of
  tokens in custody. Verified live 2026-08-21 against `Tokens::TotalIssuance`: **DOT 5,660,420 held
  gross against a chain supply of 4,489,790 (126 %)**, EURC 137 %, SOL 120 %, ETH 103 %. Netting the
  borrowed leg out (`supplied − borrowed`, floored at zero because HOLLAR is *minted* as debt rather
  than lent) brings all 28 checkable assets back under supply. Any Hydration TVL that adds
  `supplied` to pool reserves is counting looped deposits, and the number looks entirely reasonable
  — **the supply comparison is the only thing that distinguishes the two figures.**
- **A control that navigates re-runs `load()` — even for a parameter `load()` never reads — and the
  fix for that breaks every other control's link.** Both halves fail silently. `/xcm/`'s edge
  weighting was a `choiceControl`, so flipping "by value / by messages" re-fetched all four Dotlake
  endpoints including the row-level read that pages the upstream up to twenty times: about forty
  seconds to change how one graph is drawn from data already in the browser, with the page reloading
  correctly and showing the right answer. Use `localChoiceControl` when the parameter does not appear
  in `load()`. But `choiceControl` builds each option's `href` from the whole query string **once, at
  build time**, which was enough only while every control navigated away — add one control that
  rewrites the URL with `replaceState` and every other control still carries the values the page
  LOADED with, so using Network after flipping the graph silently reverts the graph. `src/design/page.js`
  keeps a `relinkers` set for exactly this. See
  `docs/decisions/0017-a-control-sits-with-what-it-changes.md`.
- **The store stops being a cache the day an upstream's floor moves past a day we hold, and nothing
  in the system would notice.** The no-backup DR position (decision 0006) is a claim about
  UPSTREAMS, not about us: it holds only for as long as every stored segment can still be fetched
  again. orca publishes a routed-trade floor — para block **6,837,788 @ 2025-01-25T05:58:36Z**, read
  live 2026-08-21 — and if it moves forward, the days beneath it stop being re-derivable and the
  volume silently becomes their only copy. Every request still answers, every chart still draws, the
  coverage bar still reads complete, and a refill onto a fresh volume comes back **short at its
  OLDEST end**. `hydration/swaps-daily` now declares a `canary` (`server/lib/canary.mjs`) that
  compares the live floor against the store at boot and every 15 min, published as `canaries.ok` on
  `/api/health`. **And the naive version of that comparison is a false alarm on day one**: a healthy
  store deliberately holds 2025-01-01…24 as `coverage: 'before-source-floor'`, so "stored days below
  the floor" fires immediately, gets explained away once, and is then ignored for ever — an alarm
  nobody reads is indistinguishable from no alarm. The discriminator is the stored payload's own
  `coverage`: only a day holding INDEXED content that now sits below the floor has actually been
  lost. See `docs/decisions/0019-the-store-canaries-its-own-derivability.md`.
