# 0017 — A control sits with what it changes

**Status:** accepted · 2026-08-21 · decided while laying out `/xcm/`

## Context

`/xcm/` put "Corridor graph: by value / by messages" in the global control row, beside Network and
Window. Its position said it affected the page. It affected one card.

The cost was not cosmetic. Every control in that row was a `choiceControl`, which navigates, so
`load()` re-ran — all four Dotlake endpoints including `xcm-value`, the row-level read that pages
the upstream up to twenty times. **About forty seconds to change how one graph is drawn from data
already in the browser.** Nothing about it looks wrong: the page reloads correctly and shows the
right answer.

## Decision

**A control belongs to the smallest thing it changes.**

- The **global control row** is for **load parameters** only — things `load()` reads, where the cost
  of a re-read is the honest price of the choice.
- A control that changes **one card** goes on that card and redraws in place, using
  `localChoiceControl` — **and still writes the choice to the URL**, with `history.replaceState`.

Keeping the URL write is the point of the second half. The reason `choiceControl` navigates at all
is that the choice then lives in the URL and can be linked, bookmarked and reported in a bug
("this page, with these settings"); none of that is true of in-memory state. A local control keeps
both properties rather than trading one for the other.

Measured after the change, 2026-08-21: flipping the in-card control issues **zero** `/api/` requests.

## Rejected

- **Leave it in the global row and just make it not navigate.** The row would then contain two kinds
  of control that look identical and behave completely differently, and nothing on screen would say
  which is which.
- **Make it local without the URL write.** That throws away the linkable, bookmarkable property
  `choiceControl` exists for. `src/design/page.js` says why that property matters, at the top of
  `choiceControl` itself.

## Consequences

- `src/design/page.js` gained `localChoiceControl` beside `choiceControl`. They share one body,
  `optionRow`; `onPick` is the whole difference. Both render real `<a href>` options, and a modified
  click (ctrl/cmd/shift/alt, or a non-primary button) is left alone so it opens a new tab at the
  right URL.
- **`replaceState`, never `pushState`.** A view is not a new place, and Back should leave the page
  rather than walk the reader back through every flip. Verified: two flips add nothing to
  `history.length`.
- **Every control now relinks.** This is the trap the change created and had to close in the same
  edit: `choiceControl` rebuilds the whole query string, but *once*, at build time — which was
  enough while every control navigated away. Add one control that rewrites the URL in place and
  every other control's `href` still carries the values the page **loaded** with, so using Network
  after flipping the graph silently reverts the graph. `page.js` keeps a `relinkers` set and every
  control relinks whenever `writeParam` moves the query string. Regression-tested 2026-08-21: flip
  `edges=messages`, then click Network → Kusama, and the URL is `?days=7&edges=messages&relay=kusama`
  with the graph still on "by messages".
- The rule is restated for people writing pages in
  [design-system.md](../architecture/design-system.md#the-control-row), which also carries the sticky
  bar's geometry and why the hints are lifted out of it.
