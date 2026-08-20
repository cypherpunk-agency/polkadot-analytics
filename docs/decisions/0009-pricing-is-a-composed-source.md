# 0009 — Pricing is a source others compose, not a library others import

**Status:** accepted · 2026-08-20 · decided by Tommi

## Context

Three modules are going to want dollars — `/bridged/`, the Moonbeam stranded-value row (E4), and
the per-chain value work in plan §7 — and exactly one of them can reach a price. Decision 0008
settled *where* prices come from: Hydration's money-market oracle, read on-chain, no off-chain
feed. It did not settle *how* a second module gets one.

The obvious answer is a shared pricer in `server/lib/`, and it is not available to us. Rule 2 of
CLAUDE.md is enforced by `npm run check`: an absolute URL outside `server/sources/` fails the
build. That is not a lint preference, it is the boundary that keeps every upstream in one
reviewable directory. A pricer in `server/lib/` cannot call Hydration, and making it able to
would delete the property that the check exists to defend.

So the real question was never "should pricing be shared" — it was **which of two shapes** the
sharing takes.

| Shape | What it costs |
|---|---|
| **A source that other sources compose** | A new pattern here: no source has ever called another. Needs a composition path that does not become a hidden fetch graph. |
| **A client-side join** | The browser fetches prices from `/api/hydration-evm/...` and multiplies. No new server pattern at all. |

## Decision

**Pricing is a source that other sources compose.** `server/sources/` gains a pricing module with
a stated asset→USD interface; other source modules call it in-process and return already-valued
payloads.

The client-side join is not merely the worse option, it is disqualified. Rule 3 says every number
carries what is wrong with it. A price has caveats that are inseparable from the multiplication —
which oracle, at which block, how stale, and whether the asset was priceable at all. Joining in
the browser produces a dollar figure whose provenance lives in a different response from the
number, and `null`-means-unpriceable degrades to `0`-means-worthless at exactly the moment nobody
is looking. That is the failure mode this repo exists to avoid, and it renders perfectly.

## Consequences

- **A source may import another source.** This is new and it needs a rule, or it becomes a fetch
  graph nobody can see: composition is **one level deep** — a source may call the pricer, and the
  pricer calls no one. If a second composable source ever appears, that rule gets revisited
  deliberately rather than by accident.
- The pricer is a source, so it is registered, self-described at `/api`, and independently
  reachable. Its prices can be inspected without the module that consumed them.
- **`null` propagates.** An unpriceable asset yields `null`, never `0`, through every caller. The
  canary in `arbs-hydration.mjs` (`[5,'DOT',10]`) is the model: assert a known value and throw on
  disagreement rather than degrade.
- Caching belongs to the pricer, not to its callers, or three modules will each hold a different
  minute's price and the same asset will be worth two amounts on one page.

## What would reverse this

A second consumer that needs prices at a different granularity than the pricer serves — per-block
historical rather than latest — could make the one-level rule bind painfully. The answer then is a
second operation on the same source, not a second layer of composition.
