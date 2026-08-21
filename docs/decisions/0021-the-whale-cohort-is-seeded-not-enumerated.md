# 0021 — The whale cohort is seeded, not enumerated

**Status:** accepted · 2026-08-21 · direction set by Tommi mid-design

## Context

The ask (plan §15.1): a daily balance series for the top DOT accounts on Polkadot — the netflows
treatment generalised from sovereign accounts to arbitrary holders. The first design question is
where the list of accounts comes from, because no upstream this repo can use serves "accounts
ranked by balance": the chain indexes `System::Account` by key, Dotlake has no balance endpoint of
any kind (probed 2026-08-21 — its one per-account endpoint is activity stats and answers "not
found" for the treasury), SQD carries events but no state, and the explorers that do rank holders
put their APIs behind keys, which [0003](0003-no-secrets.md) rules out.

The first proposal was to enumerate: sweep all ~4.14 M `System::Account` keys on Asset Hub
(~18,000 paged requests, ~2 h, measured) and rank locally. It works, and a full relay sweep the
same day is what established that the relay map is empty (1,493 accounts, 220,772 DOT — see
`docs/platform/asset-hub.md`). Tommi rejected it as the standing method: we do not need every
account, only the rich ones, and chasing 4.14 M rows to find 1,000 is the expensive way round.

## What was decided

**Discovery and measurement are separated, and only measurement has to be trusted.**

- **Discovery** — *which* accounts are worth watching — comes from Subscan's public holder list
  (`assethub-polkadot.subscan.io/account_list`), read anonymously as server-rendered HTML pages,
  once, on a stated date. No API key (the keyed Subscan API is untouched), no runtime dependency:
  the site could vanish tomorrow and nothing on this site would break or even notice. The seed is
  a one-off editorial input with its provenance stated, the same standing as the 2023 netflows
  archive in `src/data/netflows.json`.
- **Measurement** — *what those accounts hold* — is read from the chain, at one pinned finalized
  block, via the same batched `state_queryStorageAt` the netflows series uses. Every number this
  site will publish about the cohort is chain-read; Subscan's balances were used only as a
  cross-check (all 200 of the first capture agreed to a median of 0.000 DOT), and the committed
  dataset re-ranks by what the chain said, not by Subscan's ordering.

The result is `src/data/dot-whales.json`: cohort `2026-08-21-full`, **1,000 accounts read at
Asset Hub block #19,730,050 — 1,412,928,784 DOT free+reserved, 83.16 % of
`Balances::TotalIssuance`**, floor 102,433 DOT. 54 accounts carry Subscan's labels (exchanges,
treasury, sovereigns, staking proxies) plus one this repo knew and Subscan did not (the Kusama
Asset Hub global-consensus sovereign); 9 are system accounts by account-id prefix and must be
labeled on any page, never ranked as people.

> **Corrected the same day, and the wrong version taught the real lesson.** The first cohort
> (`2026-08-21`, 990 accounts, 66.54 % of issuance) silently lost **seed ranks 1–10 — the ten
> largest accounts, including the Treasury at 24.31 M DOT** — because Subscan renders the top ten
> with medal-styled rows that lack the rank-badge markup the capture parser keyed on, and the
> parser skipped rows whose rank it could not read. This decision originally explained the ten
> missing rows as "page-boundary reshuffling", an inference that was never checked and was wrong;
> the miss was caught by the page-build agent comparing the file's `seedRank` field against its
> chain-derived `rank` (11–1000, no gaps) and then reading the Treasury live at the pinned block.
> The capture now derives rank from row position and cross-checks the badge where present, and
> the superseded cohort's partially-filled series stays in the store unread (decision 0006 never
> deletes). The lesson is the probe-versus-inference rule this repo already states: the
> reshuffling story was plausible, unverified, and off by the ten most important rows.

**The cohort is fixed, dated, and versioned in git.** Tommi's scope decisions, same day: current
cohort only — no historical cohorts, no union of dated snapshots (dropped from the earlier
sketch) — which means the series answers "what did today's whales hold on each past day", and
every page drawing it states the survivorship caveat: accounts that were large and exited before
2026-08-21 are invisible by construction. A future re-seed is a new cohort id and a new store
identity beside this one, never a mutation of it.

## What was rejected

- **The full enumeration as the standing method.** Kept on the shelf as the only *complete*
  method — it is the one way to bound what the seed missed — but it is not needed to build the
  series, and 2 h of paged reads against a public archive to refresh a list Subscan maintains
  anyway is cost without information.
- **Subscan's keyed API.** Rule 1; also unnecessary, since the SSR pages carry the list.
- **Scraping as a runtime dependency** — a `server/sources/` module that reads Subscan on a
  schedule. The seed is an input, not an upstream: it changes only when a human decides to re-seed,
  so it belongs in git with a date on it, not in the cache with a TTL on it.
- **Deriving the cohort from SQD event history** (accounts that ever received a large credit).
  Cheaper on the RPC nodes but blind to any balance the Asset Hub Migration wrote without emitting
  credit events — dormant whales are exactly who a top list must not miss — and settling that
  question costs a probe the seed approach makes unnecessary.

## Consequences

- `src/data/dot-whales.json` is the cohort: seed rank, chain rank, address, account hex, label,
  system-account flag, and the pinned chain reading, under a dated `cohort` id.
- The daily series job (in build as `asset-hub/whales-daily`) is parameterised by `{month,
  cohort}`, so a future cohort re-fills beside this one instead of orphaning it
  ([jobs.md](../architecture/jobs.md) — params are identity).
- Any page publishing the cohort states three things from the payload, per rule 3: the seed's
  provenance and date (Subscan requires attribution for public use), the survivorship caveat, and
  the labels on system and custodial accounts.
- The 990 accounts hold two-thirds of the DOT on Asset Hub, so "what the whales did" and "what
  the chain's float did" are nearly the same question — a fact worth showing, not hiding.
