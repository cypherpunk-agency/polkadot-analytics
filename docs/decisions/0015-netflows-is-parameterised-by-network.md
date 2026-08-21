# 0015 — The netflows series is one implementation parameterised by network

**Status:** accepted · 2026-08-21 · decided while giving Kusama the series Polkadot already had

## Context

`/netflows/?network=kusama` was the 2023 archive alone while Polkadot had a continuous daily series
back to 2022-01 ([decision 0012](0012-netflows-is-a-store-plus-a-live-tail.md)). The page said so,
which was honest and not much use.

The measurement is **identical on both networks**: `System::Account` for every parachain sovereign
account at each UTC day's last block, on the relay chain (the `para` leg) and on that network's
Asset Hub (the `sibl` leg). What differs is two hostnames, two token decimals, one SS58 prefix, one
migration date and one series floor — and each of those is a *value*, not a behaviour. See
[kusama.md](../platform/kusama.md) for all of them, measured.

## What was decided

**One implementation, parameterised by `network`, in `server/sources/asset-hub.mjs`.** Both the job
`netflows-daily` and the operation `sovereign-dot-recent` take a **required** `network` of
`polkadot | kusama`. Four hostnames now live in that one module, and `server/sources/index.mjs` did
not change.

Everything that differs sits in one `NETFLOW_NETWORKS` table. Two of its fields are canaries rather
than configuration: `token` and `decimals` are asserted against `system_properties` on every read in
`netflowsHeads`, because a Kusama figure divided by Polkadot's `1e10` is exactly 100× too large and
renders perfectly.

## Why not a second module

`kusama.mjs` would be a copy of ~900 lines of block-boundary search, day summarising and job
plumbing whose only difference is two URLs, two decimals and one prefix. Two copies of a
bisection-on-`Timestamp::Now` is two places for the same off-by-one — and this repo has already paid
for a date→height extrapolation twice, on two different chains.

It would also mean editing `server/sources/index.mjs`, and the module already argues in its own
header that the hostnames belonging to one measurement belong in one module.

## Why `network` is required rather than defaulted

**The params are the store identity.** A default is filled in by `readParams`, so `?month=2026-01`
and `?month=2026-01&network=polkadot` would be two identities holding the same days — the duplicated
segments [jobs.md](../architecture/jobs.md#choosing-the-identity-before-choosing-anything-else)
names as the expensive mistake, with correct answers, a full coverage bar and nothing anywhere
reporting it.

Required means one identity per `(network, month)`, the URL says which network it is, and `/api`
documents it.

**Rejected: an optional `network` whose absence means Polkadot.** It keeps the stored facts (see
below) but leaves the duplicate-identity URL reachable forever.

## What that cost, stated rather than discovered

**Adding a parameter to a store-backed job orphans every fact already stored under the old
identity.** `{"month":"2026-01"}` and `{"month":"2026-01","network":"polkadot"}` are different
canonical params, so they are different identities and share no segment. The **1,673 Polkadot days**
already in the store were orphaned by this change: they are re-derived once, on demand, at ~1.1 s a
day, and the old rows stay in the SQLite file until someone deletes them. `code_version` was bumped
to `asset-hub/netflows-daily@2` in the same change, so a reader comparing two rows can tell which
code wrote each.

That is the honest cost of a self-describing identity, and it is a **general fact about this store**,
not a Kusama one: any new required param on a filled job is a full re-backfill.

**A forward-only SQL migration avoids it**, and was verified on 2026-08-21 against a `VACUUM INTO`
copy of the live store — 55 identities, 1,673 facts rewritten, byte-identical to what
`canonicalParams({month, network: 'polkadot'})` produces:

```sql
UPDATE facts SET params = replace(params, '}', ',"network":"polkadot"}')
  WHERE source = 'asset-hub' AND operation = 'netflows-daily' AND params NOT LIKE '%network%';
UPDATE jobs  SET params = replace(params, '}', ',"network":"polkadot"}')
  WHERE source = 'asset-hub' AND operation = 'netflows-daily' AND params NOT LIKE '%network%';
```

Canonical params sort their keys, so `month` precedes `network` and the rewritten string is exactly
what the canonicaliser produces; `replace()` is safe because a canonical params string for this job
contains exactly one `}`. **It has not been run against the production store**, which has never been
filled — the volume it needs is the subject of
[decision 0014](0014-the-store-gets-a-volume-and-fills-itself.md).

## Consequences

- **The page cost is per network.** 0012 priced a full load at fifty-five month requests plus a tail.
  Kusama's series starts five months earlier, so its load is 61 stored months plus one tail request
  — and a reader who flips the toggle pays it again. That figure is corrected in 0012 and is still
  the first thing to revisit when it hurts (research queue O41).
- **The two networks have different floors and both are chain-facts, not taste.** Polkadot's series
  opens at 2022-01 and Kusama's at 2021-07, each being the first whole calendar month whose every
  UTC day has a readable close on *both* of that network's chains. A single shared floor would
  either lock Kusama out of five months it can serve or ask Polkadot for months it cannot.
- **The Kusama Asset Hub Migration date stopped being a transcription.** It was carried in two
  `docs/platform/` files as 2025-10-07 and had never been re-derived; bisecting it out of the relay
  chain confirmed it, block by block ([kusama.md](../platform/kusama.md)).
- `/sovereign/` is still Polkadot-only and now has no reason to be — it reads the Polkadot hosts
  directly rather than through the table. Research queue O50.
