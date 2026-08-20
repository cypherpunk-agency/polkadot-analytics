# 0010 — An unreachable upstream returns a payload, it does not throw

**Status:** accepted · 2026-08-20 · decided by Claude, put to Tommi who had no strong view

## Context

`src/design/liveness.js` ranks five states — `frozen`, `unreachable`, `stale`, `unknown`, `live` —
and carries a label for each (`unreachable` renders as "*… did not answer*"). One of those five
can never appear on the site, and it is the one the component was built for.

The reason is structural rather than a bug. The liveness pill reads a payload. A source that
cannot reach its upstream throws an `UpstreamError`, the error is caught at the API boundary, and
the page renders a generic transport notice instead of the pill. There is no code path where a
source both fails to reach its upstream and produces something for the pill to display.

This was observed rather than reasoned about: the Bulletin devnet was unreachable for 18 minutes
on 2026-08-20 and `/bulletin/` showed the generic notice. CLAUDE.md already records that the
devnet is a single node, that it does go down, and that **"unreachable is an ordinary state, not
an error to retry through"** — so the transport-error path is treating an expected condition as an
exception.

## Decision

A source that cannot reach its upstream **returns a payload** carrying `unreachable()` — naming
the upstream, when it last answered if known, and what the page would otherwise have shown —
rather than throwing.

Throwing is reserved for what it is actually for: a response we could not make sense of. A
decoder that does not consume its input exactly, a registry that fails its canary, a supply that
disagrees with itself. Those are bugs in our reading and they must fail loudly, because they
produce *wrong numbers that render perfectly*. An upstream being down produces no number at all,
which is a different thing and safe to describe.

## Consequences

- The liveness pill becomes uniform across every source, and gains the state it exists for.
- **A page can render partially.** A dashboard reading four sources with one down shows three
  bands and a pill, rather than an error where the page was. This is the point.
- Sources must distinguish "could not reach" from "reached and could not parse". They largely do
  already — `UpstreamError` carries a `kind` — so this is mostly a change at the boundary, not in
  every module.
- **The risk, stated plainly:** an unreachable source that returns a payload looks more like
  success than a thrown error does, and a caller that ignores the liveness field will treat
  missing data as absent data. `null` is not `0` applies with full force here. Any consumer that
  aggregates across sources must read the state, not just the numbers.

## Why this was decided rather than researched

No probe settles it. It is a question about what we want the page to say when a volunteer-run node
is rebooting, and the answer follows from rule 3: a number's absence has a cause, and the cause is
information the reader should have. Tommi had no strong view; the call is recorded here so that
reversing it is a decision rather than a drift.
