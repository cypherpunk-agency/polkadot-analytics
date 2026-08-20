# 0007 — Bulletin is read by the browser, directly, and never stored

**Status:** accepted · 2026-08-20 · decided by Tommi

## Context

The Bulletin chain is content-addressed transaction storage with a retention window: data is
stored, leased, optionally renewed, and then it is gone. The devnet holds a few thousand objects
at any moment and turns them over on a roughly fourteen-day timer.

Two questions were open. Do we persist what flows through it, now that
[0006](0006-demand-driven-store.md) gives us somewhere to put it? And when a reader clicks an
object to see what it actually is, where do those bytes come from?

Both have the same answer, and it is the opposite of the answer everywhere else on this site.

## Decision

Bulletin object contents are fetched **by the browser, directly from the Bulletin devnet RPC**.
They do not transit our server and they are not written to the store. The index the
`/bulletin/` page draws — what is stored, what shape it is, how long its leases have left —
keeps coming through `/api` on a TTL cache, as it does today.

Nothing about Bulletin is persisted. It is a **watch-stream, not a dataset**.

## Why it is not a dataset

The store exists for facts that are immutable and expensive. Bulletin's contents are neither in
the way that matters. They are a large volume of bytes moving through on a timer, and the honest
description of the page is "here is what is on this chain right now" — an index that legitimately
counts *down* as leases expire.

Persisting it would mean storing bytes we will almost certainly never be asked for a second time,
for a chain whose whole design says they are temporary. It would also quietly change what the
page claims: a reader who opens `/bulletin/` and sees history stretching back months would
reasonably conclude the chain holds it, which it does not.

So we accept the loss. History older than the retention window is gone and unrecoverable from
this site, and the page has to say that plainly. That is rule 3 applied to an absence rather than
to a number.

## Why the bytes go straight to the browser

**It dissolves the stored-XSS problem rather than mitigating it.** Bulletin is a devnet anyone
can write to. If a stranger's object is fetched by our server and served from our origin, it
executes with our origin's privileges if it ever escapes into a document. Bytes that never
transit our origin cannot do that. This is a structural fix, and structural beats careful.

**It stops us being a redistribution point.** Proxying arbitrary uploads from an open devnet
through `analytics.cypherpunk.agency` makes this site a mirror for whatever a stranger put there.
We do not want that role and did not ask for it.

**There is no caching argument on the other side.** The usual reason everything else is
server-side ([0001](0001-containerised-not-static.md)) is that a cache turns N visitors into one
upstream fetch. That argument needs repeated reads of the same thing. Object contents are opened
once, by one curious reader, and then the lease expires.

Client-direct removes the same-origin escalation. It does not license rendering hostile content,
so the page decodes **structure first**: identify that this is JSON, or a UnixFS directory, or N
chunks; verify the length against the index's own `size` field; and never inject fetched bytes as
HTML.

## The cost: one CSP exception, and only one

`connect-src 'self'` forbids exactly this. The browser cannot reach the Bulletin RPC without an
allowance, and the failure mode if we forget is the silent one this repo keeps warning about: the
page renders, the console shows a CSP violation nobody is reading, and the object viewer is
simply empty.

So this decision has a prerequisite that is not ours to grant. When the client-direct viewer
ships, we will ask infra for `connect-src 'self'` plus the single Bulletin devnet RPC origin, on
this vhost only.

**It has not been requested yet, and nothing weakens the CSP today.** The policy in production is
still a pure `default-src 'self'` with no exceptions, and it stays that way until the viewer is
real. The request is deliberately narrow: one named origin, one vhost, one purpose. It is not a
`connect-src` list that new sources get appended to — the moment a second entry is proposed, the
argument in [0001](0001-containerised-not-static.md) applies again and the answer is a server-side
source module, not another line in the policy.

## Risks, stated

**The devnet is a volunteer-run single node and it does go down.** It was observed unreachable
for several minutes on 2026-08-19. Unreachable is an ordinary state here, not an error to retry
through: the page says the node is not answering and offers to try again, it does not spin, and
it does not stack up retries against a node that is already struggling.

**Client-direct means per-visitor load.** Every reader who opens an object hits that node
themselves, with no cache between them and it. That is the exact pattern
[0001](0001-containerised-not-static.md) rejected, and it is accepted here only because the load
is bounded by the page's design: the index — the expensive part, about forty RPC calls — stays
server-side and cached, and the client makes a small number of requests only for objects a human
deliberately clicked. The full client-side explorer, roughly 7,600 calls against this same node,
remains deliberately not ported.

That boundedness is doing real work, and it is most of why nothing else gets this exception.
An operation whose cost scales with what the page draws rather than with what a person clicks
does not qualify.

## Consequences

- The `/bulletin/` page must state, on the page, that it shows a retention window and not a
  history, and that the count going down is the chain working as intended.
- Object contents never appear in the store, in a log, or in any response from our origin. If
  that ever needs to change, it needs a new record, because the XSS argument above stops holding
  the moment it does.
- Until the CSP exception exists, the object viewer does not ship. Shipping it against a policy
  that blocks it would produce a page that looks fine and does nothing.
- The `RetentionPeriod` this page reasons about is governance-mutable storage, not a constant.
  It is read at runtime. See [bulletin.md](../platform/bulletin.md).
