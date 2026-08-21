# 0013 — The pricer and the valuation share a module, and only one half may fetch

**Status:** accepted · 2026-08-21

## Context

Decision [0009](0009-pricing-is-a-composed-source.md) said pricing is a source that other sources
compose, and set one rule to keep composition from becoming a fetch graph nobody can see:

> composition is **one level deep** — a source may call the pricer, and the pricer calls no one.

Implementing it for `/bridged/` immediately met the case 0009 had not pictured. The consumer that
wants dollars is `bridged-inventory`, which lives in `server/sources/asset-hub.mjs` — and that file
was under concurrent edit by another agent when this work happened, so it could not be touched.
The alternatives were:

| Shape | What it costs |
|---|---|
| Put the valuation in `asset-hub.mjs`, as 0009 pictures | Not available this round. It is still the right end state |
| A third module that imports both `asset-hub.mjs` and the pricer | Two registry entries; the new one makes **no upstream call of its own**, in a directory whose whole premise is one module per upstream |
| A client-side join | Disqualified by 0009, on the merits, and nothing here changes that |
| Put the valuation **beside** the pricer, in the pricing module | Bends 0009's one-line rule, unless the rule is made precise |

## Decision

**`server/sources/prices.mjs` carries both halves, and the boundary between them is stated in the
file and enforced by reading it:**

- The **pricing half** imports nothing from `server/sources/`. Its only upstream is
  `rpc.hydradx.cloud`. It answers `/api/prices/hydration-oracle` and exports `quotes()` for
  in-process use by any other source.
- The **valuation half** imports `bridged-inventory` from `asset-hub.mjs`, read-only, and multiplies.
  It answers `/api/prices/bridged`. It fetches nothing itself.

0009's rule is restated in the form that actually holds:

> **A price is never assembled by chaining sources.** One source, one upstream, one price. A
> *valuation* — a price multiplied by somebody else's inventory — may compose two sources, and it
> is one level deep in both directions: the pricer calls no one, and the inventory it reads calls
> no one for prices.

That is the property 0009 was defending. "The pricer calls no one" was a proxy for it, and the
proxy failed on a case where the pricer's *file* legitimately holds something else.

## Why not a third module

`server/sources/` is "one module per upstream" because that is what makes the security boundary
reviewable: every hostname is in one directory and each file is one thing that can be audited. A
module with **no upstream at all** is not a source; it is a join, filed among the sources, and the
next reader has to open it to discover that. Two modules would also mean two registry entries for
one subject — "prices" and "prices applied to one inventory" — which reads as two upstreams and is
one.

## Consequences

- **`asset-hub.mjs` gains nothing and loses nothing.** It is imported read-only, through its public
  `operations` table, exactly as an HTTP caller would reach it — so it can change underneath the
  valuation without breaking it, and the valuation cannot make it fetch anything new.
- The valuation's cache is its own (`ttlMs`), and it sits on top of both underlying caches. Three
  TTLs, and the payload therefore carries **both** source blocks — Asset Hub's block height and
  Hydration's — because they are two reads at two instants and a reader needs to see that.
- **Caching stays with the pricer** (0009's fourth consequence, unchanged). One `quotes()` call is
  memoised behind a TTL, so two callers in the same minute cannot value the same asset differently.
- **`null` propagates** (0009's third consequence, unchanged), and it now has a second reason to
  appear: an asset can be unpriceable *or* unscalable. Those are different facts and the payload
  keeps them apart with `priceStatus` rather than folding both into a missing number.
- If `asset-hub.mjs` becomes free, **moving `bridged` into it is a clean win** and this record does
  not stand in the way — the pricing half is already the importable half, which is the shape 0009
  asked for.

## What would reverse this

A second valuation with a different inventory — the Moonbeam stranded-value row, or the per-chain
value work in plan §7. At two, the pattern is established and each should live with its own
inventory source rather than accumulating in `prices.mjs`. At that point this file should say so
and the `bridged` operation should move.
