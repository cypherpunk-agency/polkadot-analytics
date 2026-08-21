# 0016 — A comparison inherits its worst reading

**Status:** accepted · 2026-08-21 · decided by Tommi, on reading the page

## Context

`/sovereign/` carried a "Then and now, for the eight chains the archive tracked" card comparing
today's sovereign balances against the close of **2023-04-08**, and above it a strip drawing the
years since as time nobody measured. Tommi: *"Why would we compare something to the close of eighth
of April 2023? This does not really make any sense to me."*

Three answers, and the third settles it:

1. **The date is arbitrary.** Nothing happened on 2023-04-08 except that a third-party study stopped
   collecting.
2. **It covered 8 of the 52 chains the page lists** — the eight that study happened to track.
3. **It is that archive's single worst day.** The `netflows-daily` backfill established that its
   captures stop mid-day, so its final row is a mid-day reading published as a close: all eight
   chains disagree with a fresh read of the chain by up to **23.6 %**, where everywhere else the
   archive and the chain agree to a median **4.0 × 10⁻⁹**. The card set live data against the one day
   of the archive known to be unreliable and labelled it "then".

The finding has since been reproduced independently on Kusama, whose archive ends on a different day
(2023-03-12) and fails in exactly the same way, worst by 1,140 KSM
([kusama.md](../platform/kusama.md)). It is a property of how that study captured, not an accident of
one date.

And the reason the apparatus existed had expired. It was built when that archive was the only history
of these accounts anyone had. Since
[decision 0012](0012-netflows-is-a-store-plus-a-live-tail.md), `/netflows/` carries the same
measurement for every UTC day from 2022-01-01 to yesterday, read from the chains — so the gap card's
"N days with no observations" had become an assertion that is false.

## Decision

**A page does not carry a comparison whose reference point it cannot defend.** `/sovereign/` is one
thing — what these accounts hold right now — and history is a link to the page that has all of it,
not a smaller copy of it here.

Rejected:

- **Re-point the "then" bar at a better day.** Any single day is still one day out of 1,600 and still
  arbitrary.
- **Keep the card for the eight chains and caveat the final row.** A caveat under a bar does not stop
  the bar being read.
- **Keep the gap strip, because it is honest about the archive.** It is no longer honest about *this
  site*, which now has the data.

## Consequences

- `src/pages/sovereign/main.js` went 875 → 467 lines (152 insertions, 560 deletions) and no longer
  imports `src/data/netflows.json`. Gone: `thenNowCard`, `thenNowTable`, `joinThenNow`,
  `changeLabel`, `gapCard`, `archiveLiveness`, the "Two measurements, three years apart" warning, and
  the two data-notes sections that described the archive, the gap and the join.
- **The 2023 dataset is drawn by one page again**, which retires half of research queue **O32** — the
  duplicated `archiveLiveness()`. The transcribed Asset Hub Migration date is still in three files,
  and `/sovereign/`'s is now a bare `MIGRATED_ON` constant used for one stat-tile caption.
- **The failure path changed shape.** The archive used to be the fallback content, so a failed live
  read left half a page. It now propagates to `renderPage`, which renders the standard error notice
  and sets `body[data-state="error"]` — the honest rendering when there is nothing else to show, and
  what every other single-source page here does.
- **The per-row account-identity check went with the card** (the 2023 CSV's observed address against
  the address this registry derives today). It is not lost: `/netflows/` compares the two sources'
  *balances* on thousands of chain-days, which cannot agree to 4.0 × 10⁻⁹ if the address mapping is
  wrong, and `src/core/topology.js` still throws at import if the derivation stops reproducing two
  verified accounts. All 16 archive addresses were separately reproduced on 2026-08-21, on both
  networks ([kusama.md](../platform/kusama.md)).
- **What is now unchecked is today's reading.** The then/now table was the only per-chain
  reconciliation on that payload, and the live 52-chain figure is compared against nothing. Research
  queue O74.
- Decision [0011](0011-a-page-has-one-subject.md) still holds and this is the same rule applied once
  more: the page opens on the thing its title names. What 0016 adds is the test for material that
  *is* on-subject — a comparison is only as good as the reading it compares against.

## Why this was decided rather than researched

Nothing external is involved. The evidence was the page itself plus a measurement this repo already
had, and it was read by the person who asked for the page. Recorded here so the next person who
wants a "then and now" meets the question rather than re-discovering it.
