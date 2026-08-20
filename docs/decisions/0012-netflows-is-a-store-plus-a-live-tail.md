# 0012 — The netflows series is a month-bucketed store plus a live tail

**Status:** accepted · 2026-08-20 · decided while filling the 2023 → 2026 hole

## Context

`/netflows/` drew 2022-02-02 → 2023-04-08 from a committed archive and stopped. `/sovereign/` drew
today. Between them was a three-and-a-half-year hole, and the ask was one continuous series from the
beginning until now.

The measurement itself is cheap and completely known: `System::Account` for every parachain
sovereign account, at the last block of a UTC day, on the relay chain and on Asset Hub. About 2.2
HTTP requests and 1.4 seconds per day per chain-pair, and roughly 0.9 kB stored. A day's state is
also **immutable in the strongest sense available here** — it is a finalised historical block, not
an indexer's opinion — which is the ideal case for the store
([decision 0006](0006-demand-driven-store.md), [jobs.md](../architecture/jobs.md)).

So the interesting question was never "can we fetch it". It was: **what is the identity of a stored
fact**, given the two constraints that pull against each other.

## The two constraints

1. **A job that reaches `done` frees nothing.** `serveFromStore` answers *complete* for an identity
   whose job finished and never enqueues another one. An identity meaning "every day up to now" is
   permanently frozen at whatever "now" meant when it finished — and `immutable()` would have had to
   lie to let it start.
2. **The params are part of the fact key**, so two identities never share a segment. A free
   `{from, to}` range re-fetches and re-stores every day of every window anyone asks for.

Which leaves a fixed bucket, coarse enough to be shared by many readers, fine enough that new data
is not held hostage to it.

## What was decided

**The identity is a calendar month; the segment is an ISO day; the current month is a separate,
TTL-cached operation.**

- `asset-hub/netflows-daily` (job) — `{month}`, segments are that month's ISO dates, `immutable` is
  "the month ended more than an hour ago, and is not before 2022-01".
- `asset-hub/sovereign-dot-recent` (operation) — the last N *closed* UTC days, same payload shape,
  30-minute TTL, hard cap of 40 days.
- The page reads every whole past month from the store and one tail request, and joins them on one
  day axis.

One implementation, two callers: the day-reading code is shared and the only difference is whether
each upstream call goes through the job engine's politeness gate.

## What that costs, stated rather than discovered

**Fifty-five requests per page load** for 2022-01 → 2026-07, about 860 kB in total, 16 kB each and
individually cacheable. That is fine now and will not be in 2029. It is the price of the month
bucket and it is the first thing to revisit when it hurts.

**A seam that moves.** On the 1st of a month the store reaches yesterday and the tail is empty; by
the 28th the tail is 27 days of live reading, which is ~20 s on a cold cache. The seam is real, it
is bounded by one month, and the page says which side of it a day came from.

**Today is never on this page.** A day's value is its close and today has not closed. `/sovereign/`
is the page that answers "right now".

## What was rejected, and why

**A year bucket** (4 requests instead of 55). The current year can never be immutable, so 2026-01-01
to today — 232 days — would have to come from the live operation. At ~1.4 s a day that is a
four-minute request. Dead on arrival.

**A quarter bucket** (19 requests). Same failure, smaller: at the end of a quarter the tail is 92
days and about 3 minutes.

**Two identities — years for closed years, months for the current one.** This works and is the
obvious escape hatch, but it stores and fetches the current year twice and
[jobs.md](../architecture/jobs.md) is explicit that duplicated segments across identities is the
expensive mistake. Not worth paying before the 55 requests actually hurt.

**Storing the archive's shape instead of the chain's.** The 2023 dataset is one file with one array
per chain. Reproducing that would have made the page a second archive with a newer end date, and the
next hole would need the same rescue. A day per fact is resumable, auditable, and re-derivable one
day at a time.

## The consequence that mattered most

Because both legs are stored **separately** per chain — `para` on the relay, `sibl` on Asset Hub —
the Asset Hub Migration is a chart rather than a caveat, and the 2023 archive can be compared
against the **relay leg alone**, which is what it actually measured. Comparing it against the sum
scored the Asset Hub leg as a 0.09% disagreement on hundreds of chain-days; comparing it against the
right leg gives a median deviation of 4.0 × 10⁻⁹ over 2,434 chain-days and turns two genuine
findings loose — that the archive's final day is a mid-day reading, and that it only ever measured
one of the two accounts. See [asset-hub.md](../platform/asset-hub.md).

A payload that had pre-summed the two legs would have hidden all of that behind a number that looked
right.
