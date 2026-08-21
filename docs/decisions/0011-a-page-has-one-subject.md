# 0011 — A page has one subject, and the subject goes first

**Status:** accepted · 2026-08-20 · decided by Tommi, on seeing the page

## Context

`/netflows/` exists for one chart: a multi-line time series of DOT held in parachain sovereign
accounts, 2021–2023, every chain on one shared linear scale. That chart is the only long look
anyone has taken at those accounts and it is the whole reason the page was built.

On 2026-08-20 the page gained a live half — the same accounts read from the relay chain and Asset
Hub at load time (Wave E item E3, which the plan had scoped as "a second series on an existing
page, not a new page"). Everything added was true, carried its caveats, and was worth publishing.
The result was that a reader arrived at the top of a page named for a time series and scrolled
past **eight blocks** before reaching one:

1. a liveness banner
2. a "Two measurements, three years apart" warning notice
3. a "Today" heading, four hero stat tiles, a ranking and its table
4. a "N days with no observations" gap card
5. a then/now comparison card and its table
6. a section `<h2>` marking where the archive began
7. a paragraph explaining that heading
8. a four-tile stat row about the archive

Tommi's verdict, looking at it: *"you filled the netflows screen with a lot of stuff that is
interesting, but not netflows."*

Nothing in that list was wrong. The failure was one level up — additive edits to a page never
re-ask what the page is *for*, so each block is defensible on its own and the page as a whole
stops answering its own title.

## Decision

**A dashboard has one subject. That subject is drawn first, under at most a title and a sentence
or two.** Material that is interesting but is a different subject gets its own page rather than a
position further down this one.

Applied here: `/netflows/` opens on its time series, and nothing else goes above it. The live read,
the gap drawn to scale, and the then/now comparison moved to `/sovereign/`, where they are the
subject rather than the preamble. Both pages point at each other in prose.

> **Updated 2026-08-20, later the same day.** When this was written, the only time series
> `/netflows/` had was the 2021–2023 archive, so "the page is the archive" and "the page opens on
> its chart" were the same sentence. They are no longer: the 2023 → 2026 hole was filled from the
> chains themselves, and `/netflows/` now draws 2022-01 → yesterday with the archive alongside it as
> a cross-check. See [decision 0012](0012-netflows-is-a-store-plus-a-live-tail.md). **The decision
> above is unchanged** — the page still has one subject and still opens on it. What changed is which
> data draws that subject, and one of the consequences below, which is corrected in place.

Rejected alternatives:

- **Reorder within one page** — put the chart at the top and the live half beneath it. This keeps
  a page whose title names one thing and whose body is mostly another, and it leaves the same
  additive pressure pointed at the same page. It is the option that got us here.
- **Collapse the live half behind a `<details>`.** Hiding material is not the same as it having a
  home; a `<details>` nobody opens is the same as deleting it, with extra markup.
- **Delete the live half.** It answers a real question — *what do these accounts hold now* — and
  it cost a source module to build. The problem was never its existence.

## Consequences

- `src/sources/pages.js` gains an entry, and the site map is the only place that had to change:
  Vite discovers `sovereign/index.html` by directory, and the nav and home deck both read `PAGES`.
- ~~**`live` on a page entry becomes correct again.** `/netflows/` reads nothing at run time, so it
  is `live: false`.~~ **Corrected 2026-08-20:** that held for about six hours. Once
  [decision 0012](0012-netflows-is-a-store-plus-a-live-tail.md) filled the 2023 → 2026 hole,
  `/netflows/` reads a store-backed job for whole past months and a TTL-cached operation for the
  current one, so it is **`live: true` and stays there** — Kusama alone is still archive-only, and
  the page says so on that toggle rather than in the flag. The *rule* the sentence was making is
  the part that survives, and it is restated in
  [design-system.md](../architecture/design-system.md#a-page-has-one-subject-and-it-goes-first):
  `live` is part of a page's identity, and a page that stops reading an upstream goes back to
  `live: false`. Getting it wrong in either direction is the same failure — for one day this flag
  said the wrong thing about both halves at once.
- **The 2023 dataset is now drawn by two pages**, `/netflows/` (as a cross-check against the
  re-derived series, where the two overlap) and `/sovereign/` (for its "then" bars). Each asserts
  its own `frozen` liveness report about the same bundled file. That is duplication, accepted
  knowingly at two pages and worth extracting at three — it is research queue **O32**.
- Splitting is not free: a reader who wanted the comparison now has to follow a link. That is the
  right trade when the two subjects are genuinely different questions asked of the same accounts,
  and the wrong one when a page is split merely because it got long.
- The test to apply before adding a block to any dashboard here: **does the page still open on
  the thing its title names?** If not, the new material wants a page, not a position.

## Why this was decided rather than researched

Nothing external is involved and no probe settles it — the evidence was the page itself, read by
the person who asked for it. Recorded here so the next additive edit meets the question rather
than re-discovering it.
