# The design system

One stylesheet, one component vocabulary, one chart kit. Every page is built from them and adds
no CSS of its own — which is what "uniform design" has to mean in practice, because otherwise it
lasts until the third page.

| file | what it holds |
|---|---|
| `src/design/tokens.css` | every colour, size, space and typeface. Nothing else in the repo names one. |
| `src/design/base.css` | reset, page frame, header, footer |
| `src/design/components.css` | stat tile, card, notice, legend, bar row, table, chart frame, tooltip |
| `src/design/dom.js` | element construction, and the CSP-safe style setter |
| `src/design/shell.js` | header, nav, theme toggle, footer |
| `src/design/page.js` | the four-state page harness |
| `src/design/loading.js` | the loading state: elapsed clock, progress bar, skeletons |
| `src/design/liveness.js` | how a source's liveness assertion appears on a page |
| `src/design/charts.js` | six chart forms |
| `src/design/swap-dashboard.js` | the whole dashboard for any venue that produces `Trade[]` |

## The palette is validated, not chosen

The eight categorical hues are a **validated set**, not a taste decision. Both modes pass:

| check | light | dark |
|---|---|---|
| lightness band | all 8 inside L 0.43–0.77 | all 8 inside L 0.48–0.67 |
| chroma floor | all ≥ 0.1 | all ≥ 0.1 |
| worst adjacent CVD separation | ΔE 9.1 (protan) | ΔE 8.4 (protan) |
| worst adjacent normal-vision | ΔE 19.6 | ΔE 19.3 |
| contrast vs surface | 3 hues under 3:1 — see below | all ≥ 3:1 |

Rules that follow, and are not negotiable:

- **Fixed order, never cycled.** Series 9 and beyond are `--series-rest`, a chromaless grey.
  A ninth hue would either be indistinguishable from an existing one or outside the validated
  set, and a repeated colour reads as a repeated thing. The "n others" row is grey for the same
  reason: it is a residual, not a category.
- **Colour follows the entity, not the rank.** A filter that changes the series count must not
  repaint the survivors.
- **Dark is selected, not inverted.** The same eight hues re-stepped for the dark surface,
  declared under both `prefers-color-scheme` and `[data-theme]` so a reader's explicit choice
  beats their OS in both directions. The toggle has three states — light, dark, and *auto* —
  because the third is what most people actually want and a two-state toggle takes it away.
- **Three light-mode hues sit under 3:1 contrast.** That is a documented WARN, and it obligates
  relief. The relief here is that **every legend carries the value, not just the name**, and
  every chart has a table view. Colour never carries meaning alone on this site.
- **Status colours are reserved.** `--good` / `--warning` / `--critical` are never a series
  colour. The one place they appear in a chart is the XCM delivery breakdown, where the segments
  genuinely *are* states — and even there the legend spells out the word.

Sequential encoding is one hue light→dark (`--seq-*`). Never a rainbow.

## Chart forms

Seven, hand-rolled. The SVG ones:

- `stackedBars` — daily volume by series. The default chart of this site.
- `lineChart` — one line over an ordered index: cumulative totals, concentration curves.
- `multiLine` — several series on one shared scale, for the netflows daily series and the 2023
  archive it is cross-checked against.
- `matrix` — an n-by-n directed relation: origin down the side, destination across the top.
- `flowGraph` — node/edge topology on a fixed circular layout, with value-weighted edges.

And the row forms, which are DOM rather than SVG because a list of rows wants to be a list of
rows — they get hover, focus, text selection and printing for free:

- `.rank-row` — bar rows in CSS: rankings, breakdowns, routes.
- `.seg-row` (`segmentedRows`) — one bar per item, split by who holds it. See below.

**Both restack at `36rem`, and the shared breakpoint is deliberate.** They are the same form with
a different column count, so restacking them at different widths on a page that draws both would
read as a bug rather than as a design. `.rank-row` was brought onto `.seg-row`'s breakpoint rather
than onto its own measurement (which said 412–480px) for exactly that reason.

⚠️ **Measure a row against its own container, never against the document.** `.scroll-y`
(`max-height: 28rem; overflow-y: auto`) is *also* a horizontal scroller, because CSS computes
`overflow-x: visible` to `auto` whenever the other axis is not `visible`. An over-wide row inside
one produces `documentElement.scrollWidth === 390` at a 390px viewport — a perfect score over a
broken row, with the only visible symptom a `2fr` bar track squeezed to 9px. That is how
`.rank-row` stayed broken on two of three pages while being actively edited. The measurements are
in CLAUDE.md's facts list; a check that would catch it in CI is research queue **O49**.

### `segmentedRows`, and why the kit grew

The other six answer "how did this change" or "what flowed where". This one answers a question
none of them can: **where does a known quantity currently sit?**

Asset Hub's supply of a bridged token is an exact number, and every parachain's sovereign
holding is a slice of that same number — so the slices must add back up to it. Drawn this way,
**the arithmetic is the picture**: if the segments do not fill the bar, something is unaccounted
for and you can see it. A grouped bar or a pie hides precisely that.

So it takes the total **separately** rather than summing the segments and calling that the
total. Summing would make every row reconcile by construction and the check would be worth
nothing. Instead:

- **segments short of the total** → the shortfall is drawn as a hatch, never omitted. Usually
  that is real (value the chain holds itself rather than on anyone's behalf), so the caller
  passes it as a named series and watches it disappear. When it does not disappear, that is the
  finding.
- **segments over the total** → the row is outlined in `--critical`, because that cannot be
  drawn honestly at all. Two sources disagree, and clipping the bar would look fine.

The hatch is deliberately not a hue. It is an absence, and a colour from the categorical set
would make it read as one more category.

**⚠️ Scaling is a unit decision, and the wrong one renders perfectly.** Linear from zero always,
but denominated one of two ways:

| mode | denominator | honest when |
|---|---|---|
| `shared` (default) | the largest total across rows | every row is in the **same unit** — in practice, USD |
| `row` | each row's own total | units differ, or the value could not be priced at all |

Drawn from raw token amounts, `shared` is a lie: 4,210 WETH beside 88,400,000 USDC puts WETH at
0.005% of the track, so eight figures of real value renders as a 1px sliver next to a
stablecoin. **Compare rows in USD, or do not compare them.** The returned tally carries `faint`
— rows under 2% of the track under shared scaling — so a page whose units are not comparable is
told so rather than left to look plausible.

Sub-pixel segments are floored to 1px instead of rounded away, so a small-but-real holding is
never invisible. That means the smallest segments are deliberately **not** to scale, which is
the lesser evil: the alternative is a genuine balance drawing as nothing and reading as zero,
and here `null` is not `0` and neither is "small".

`matrix` and `flowGraph` were added for cross-chain flow, and both refuse the chart that
question usually gets. **A Sankey is wrong for XCM** because the graph is cyclic — Asset Hub
sends to Hydration and Hydration sends back — and a Sankey cannot draw a cycle without either
double-counting the pair or silently dropping one direction. A matrix shows both directions of
every pair next to each other; the graph shows the topology when the topology is the point. A
chord diagram is the third view and is still not built.

Rules specific to those two, on top of the mark rules below:

- **Sequential is one hue, five steps, and the band edges are printed in the legend.** The ramp
  is `--seq-100` through `--seq-700` and no hue is invented for it. Bands are linear from zero
  by default, which on a skewed matrix collapses most cells into the lightest band — that is
  what the data says, and a caller with a defensible reason to band otherwise passes explicit
  edges, which then appear in the legend rather than hiding in the code.
- **A pair never observed is an outline, not the lightest fill.** `null` is not `0` holds in two
  dimensions as well as one.
- **Node size in `flowGraph` carries nothing.** Radius is fixed; a circle's area is the encoding
  people most reliably misread, and the total is one hover or one table row away. Node colour
  encodes a *kind* in fixed slot order, never a rank.
- **The circular layout is deterministic, in the caller's order.** A force simulation would draw
  a different picture on every load, and "the cluster moved" would be an artefact rather than a
  fact.
- **Edge width is linear from a stated floor.** Without the floor the smallest corridors round
  to invisible and the graph quietly claims they do not exist; the colour band carries the
  magnitude a hairline cannot.

No charting library. The CSP forbids external scripts, and a multi-megabyte plotting bundle to
draw a stacked bar chart would dominate the page weight of a site whose entire payload is 50 kB
gzipped. More to the point, the forms are *chosen* rather than configured.

Mark rules:

- **Linear from zero, always.** A log scale on a ranking makes a long tail look like a
  distribution of equals, which is the opposite of what the chart is for.
- **Rounded on the data end only.** The zero end stays square against the baseline, so a bar
  never looks like it starts slightly above zero.
- **A 1px surface-coloured stroke between stacked segments,** or two adjacent hues read as one
  taller segment.
- **Empty days are drawn empty, never dropped.** A gap in activity is information; compressing
  it out makes a dead fortnight look like a busy one.
- **`null` breaks a line; it does not draw to zero.** "No data yet" and "the value was zero" are
  different facts.
- **One y-axis.** There is deliberately no dual-axis variant.
- Crosshair and tooltip on every plot; a table view under or beside every chart.

## The nav is grouped, and the group is a `<details>`

The header bar reads `NAV` from `src/sources/pages.js`, not `PAGES`. `NAV` is derived: a page
naming a `group` is folded into that group, which is emitted where its first member sits. So the
bar is reordered by reordering the site map, a group cannot list a page that was never built,
and a page cannot fall out of the nav by being moved.

Grouping exists because half the dashboards here are Hydration. Flat, that put "Money market",
"Wrap map" and "Pegs & OTC" on the bar as peers of XCM and Bulletin — three labels that name a
subject without naming the chain, so nine entries read as nine unrelated things.

**The group is a `<details>` element, and that is load-bearing rather than lazy.** It opens,
closes, answers the keyboard and announces its own expanded state with no script at all. The
knowledge base emits its chrome as static HTML and is meant to read with scripting off, so a
scripted menu would have had to exist twice — once in `shell.js` and once in
`scripts/knowledge.mjs` — in two languages, and the two would drift. `wireNavGroups()` adds
three manners on top (opening one closes the others, Escape closes and restores focus, a press
outside closes) and none of them are load-bearing: with it never called the nav still works.

Two consequences worth not rediscovering:

- **The group's label is not a link.** `/hydration/` is a real page, so pointing the summary at
  it is tempting and wrong: on a touch device the tap that should open the panel navigates
  instead, and the other three pages become unreachable from the bar. The DEX page is the first
  entry *inside* the panel.
- **`display` is never set on the `<summary>`.** A summary is a `list-item`, and changing that
  has a history of breaking the disclosure itself in WebKit — marker and click both. The marker
  is removed with `list-style: none` plus the `::-webkit-details-marker` rule, which leaves the
  box alone. The caret is drawn from two borders rather than typed as `▾`, because that glyph is
  a lottery across the system font stacks and the way it loses is a tofu box in the header of
  every page.

A page in the group marks its summary `aria-current="true"` and its panel link
`aria-current="page"` — being *in* a section and *being* the page are different facts, and the
stylesheet marks them differently.

## A page has one subject, and it goes first

Every dashboard here is `renderPage({ page, intro, load, render })`, and `render` appends blocks
to one host in order. That makes adding a block the cheapest possible edit and re-asking what the
page is *for* the most expensive one — so pages drift by accretion, each new block defensible on
its own while the page as a whole stops answering its title.

`/netflows/` is the worked example. It exists for one chart, and for one day it carried eight
blocks above that chart, every one of them true. The fix was not to reorder them: the live half
became `/sovereign/`, and `/netflows/` opens on its time series again. See
[decision 0011](../decisions/0011-a-page-has-one-subject.md), which carries the list and the
alternatives that were rejected.

Two practical consequences for anyone adding to a page:

- **The test is the title.** After the edit, does the page still open on the thing its title
  names, under at most a lede and a control row? If not, the new material wants a page of its
  own — which costs one directory, one entry in `src/sources/pages.js`, and no config at all.
- **`live` on the page entry is part of the page's identity, not metadata.** A page that stops
  reading an upstream goes to `live: false` and its home tile says *archive — fixed dataset*; a
  page that starts reading one goes back. That flag is the only thing standing between a reader
  and taking a 2023 archive for today's numbers, and it is wrong in both directions: `/netflows/`
  went `true → false → true` inside 24 hours on 2026-08-20 as it lost its live half to
  `/sovereign/` and then gained a chain-read daily series of its own
  ([decision 0012](../decisions/0012-netflows-is-a-store-plus-a-live-tail.md)). Each of those three
  values was correct when it was set. Set it from what the page reads *today*, never from what the
  page is named after.

A lede is prose and prose grows. At 390px the page head is the whole first screen before anything
is drawn, so a lede that runs past four lines is spending the reader's only screen on sentences.

## The control row

**A control belongs to the smallest thing it changes** —
[decision 0017](../decisions/0017-a-control-sits-with-what-it-changes.md). There are two controls
and the difference between them is which question the choice answers.

- **`choiceControl` — a load parameter.** Something `load()` actually reads. It navigates, `load()`
  re-runs, and the choice lives in the URL.
- **`localChoiceControl` — a view parameter.** `onChange` redraws in place from data already in
  memory; the choice still lands in the URL via `history.replaceState`, so the view stays linkable
  and bookmarkable. **Use it whenever the parameter does not appear in `load()`.** A `choiceControl`
  for a parameter `load()` never reads is a silent full refetch: on `/xcm/` it cost about forty
  seconds against an upstream we do not own, to change how one graph was drawn from data the browser
  already had, and nothing about it looked wrong.

Three properties of the pair worth knowing before writing one:

- Its options are real `<a href>`s. A modified click (ctrl/cmd/shift/alt, or a non-primary button)
  is left alone and opens a new tab at the right URL; only a plain primary click is handled in place.
- `replaceState`, not `pushState`: a view is not a new place, and Back should leave the page rather
  than walk back through every flip. Verified — two flips add nothing to `history.length`.
- **Every control relinks when any control moves the URL.** `page.js` keeps a `relinkers` set for
  this. Without it, a control's `href` still carries the values the page *loaded* with, so using
  Network after flipping the graph silently reverts the graph — the exact failure `choiceControl`
  was written to prevent, one level up, rendering perfectly.

`renderPage({ controls })` wraps them in `.controls-bar`, which is **sticky under the site header**,
and lifts each control's `hint` out of the bar into `.control-hints` beneath it. That lift is not
cosmetic: **a sticky element's flow box is the box it paints**, so any height change while it is
stuck shifts every pixel below it and the page jumps under the reader at exactly the moment they
scroll past. "Compact the row when it sticks" is therefore not available — the row has to be born
compact, and at 390px a one-sentence hint is five lines and was the only part of the bar that was
not already one line.

`--head-h` and `--controls-h` are measured by `measureStickyChrome()` and published on `<html>`.
They are the one pair of sizes not in `tokens.css`, because they are facts about the rendered page
rather than choices: the header is **53px at 1280 and 143px at 390**, where it wraps, so any offset
written into the stylesheet is right at exactly one width. `html { scroll-padding-top }` is built
from them plus `var(--s2)`, so a focused control lands clear of both bars *and* of its own focus
ring, which is drawn 4px outside its box.

A control a page places in its own body rather than in `renderPage({ controls })` — `/hyperfx/` does
— is untouched: `.controls` keeps `margin-bottom: var(--s5)` and its hint stays inline. Only
`.controls-bar > .controls` zeroes the margin. The selected option is styled by
`.theme-btn[aria-current]` in `base.css` rather than by an inline `style` prop, so the visible state
and the accessible state cannot disagree.

## The four-state page

`renderPage()` owns the states a data page actually has, which is the thing pages get wrong when
each one hand-rolls it: **loading**, **ready**, **failed**, and — the one usually missing —
**succeeded but empty**. A page that draws only the first two shows a permanently empty chart
when an upstream is down, and it reads as "there was no activity".

Failure copy comes from the error's `kind`, so a reader is told whether this site is broken,
the chain is down, or a format changed. Those imply different actions.

**Loading is a state, not a gap between two others.** A 40-second fetch behind a bare spinner is
indistinguishable from a hang, and the rational response to a hang — reload — makes it worse. So
`src/design/loading.js` gives the loading state three things a spinner cannot:

- **How long it has been.** An elapsed clock that ticks is the cheapest possible proof the page
  is alive, and copy that escalates at 8s, 25s and 60s says out loud that a long read is normal
  for this upstream rather than leaving a reader to guess.
- **What it is doing.** `load()` is handed a `progress` reporter. Using it is optional; a load
  that reports counts turns the bar determinate, and one that does not gets a bar that is
  visibly indeterminate rather than one claiming 0% for forty seconds.
- **What shape the answer will be.** Skeletons built from the real components, so the layout is
  reserved and the page does not jump when the data lands.

The clock stops in a `finally`, so a failed page does not tick behind its error notice. Motion
is dropped entirely under `prefers-reduced-motion` — the animation was never the message.

Filter controls navigate rather than refetch in place, so the choice lives in the URL and can be
linked, bookmarked and reported in a bug. `choiceControl` rebuilds the whole query string, not
just its own parameter — a page with two controls where each link carries only its own would
silently reset the other.

## The CSP trap, written down because it already bit

**Never set styles with `setAttribute('style', …)`.**

Production serves `style-src 'self'` with no `'unsafe-inline'`. Under it the browser *silently*
refuses inline style attributes. The page renders, every request returns 200, and every
proportional bar on the site draws at **zero width** — indistinguishable from a dataset with no
values in it.

Setting the same declarations through CSSOM (`node.style.setProperty`) is not governed by
`style-src` and works under the same policy. The `style` prop on `el()` and `svg()` routes
through `style()` in `dom.js`, which parses the declaration string and sets each property that
way. Every dynamic dimension and series colour on this site goes through there.

Tooltips are built as DOM, never as an HTML string, for the same reason plus one more: their
labels are chain data — token symbols, addresses — and building them as text nodes means there
is no string concatenation for anything to be injected into.

SVG `fill` and `stroke` are *presentation attributes*, not CSS. They are unaffected and are set
as ordinary attributes.

## Typography and assets

System font stacks only. The CSP has no external origins, so a webfont from a CDN would not
merely be slow — it would silently not load and the page would render in a fallback nobody chose.
Mono for anything numeric or identifier-shaped (`font-variant-numeric: tabular-nums` everywhere a
column of figures appears), sans for prose.

The only image asset is a 400-byte inline SVG favicon.
