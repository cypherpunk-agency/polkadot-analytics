# 0008 — Prices come from chains, not from Yahoo Finance

**Status:** accepted · 2026-08-20 · decided by Tommi

## Context

Every dollar figure on this site needs a price for DOT, and until 2026-08-20 nobody had written down
where one comes from. An investigation that day reported that DOT could not be priced from anything
this repository reads: it is in no Omnipool asset, no stableswap pool and no liquid XYK pair.

On that basis, **the repo owner suggested Yahoo Finance** — `query1.finance.yahoo.com/v8/finance/chart/DOT-USD`
— as a key-free source of both live and historical DOT/USD.

The premise turned out to be false. DOT *is* priceable from Hydration, and this repository was already
publishing its price in production while the report was being written (see
[hydration.md](../platform/hydration.md#pricing-in-dollars)). But the question the suggestion raises —
*may this site take a price from a centralised exchange aggregate?* — is worth settling on its own
terms, because it will be asked again for the next asset that genuinely has no on-chain price.

This record rejects it, and rejects it on evidence rather than on principle.

## Decision

**No off-chain price oracle. Prices are read from chains.**

DOT/USD is read from Hydration's money-market oracle —
`getAssetPrice(0x…0100000005) / BASE_CURRENCY_UNIT` on
`0xad33c0f0c42c5a0eaa65b5895d2bdb20cb6e8760`, discovered by traversal, never hardcoded — for both live
and historical figures. Historical values come from the same call at a historical block.

Yahoo Finance may be used **by hand, as a validation fixture**, the way it was used to check this
decision. It is never added to `server/sources/`, never called by the running site, and never a number
a reader sees.

## Why not: the endpoint forbids it

The decisive fact is one line. `https://query2.finance.yahoo.com/robots.txt`, on the exact host that
serves the chart API, is:

```
User-agent: *
Disallow: /
```

A blanket disallow, all agents, whole host. The `v8/finance/chart` route is the undocumented private
backend of the Yahoo Finance website, not a published API; there is no public grant to use it, and
Yahoo's own terms route programmatic market data through a licensed feed. Building a public site's
dollar figures on it is not a grey area, and "it returns 200" is not consent.

Everything else below is true and would have been survivable. This is not.

## Why not: there is nothing to buy

The chain already has the series, and it is the *same* series.

Hydration's money-market oracle answers `eth_call` at historical blocks. Binary-searched on
2026-08-20, it first answers for DOT at block **6,382,861**, timestamp **2024-11-12T14:28:24Z**,
price $5.25282543. From there to today is roughly 21 months of daily DOT/USD, one batched call per
point.

Checked against Yahoo's own daily series over 45 days, sampling each day's first block after 00:00 UTC:

| | |
|---|---|
| median absolute difference | **0.16 %** |
| p90 | 0.36 % |
| worst | 0.46 % |

At spot the three available constructions agree as closely: the money-market oracle said $0.82600237,
the Omnipool's implied spot for aDOT said $0.826435 (0.05 % apart), and Yahoo said $0.8283 (−0.28 %).

A source that costs an architectural change and adds 0.16 % of nothing is not a source, it is a
liability with a decimal point.

## What it would have cost

Worth writing down, because these costs are easy to under-count when an endpoint returns clean JSON on
the first try.

**It would be this repository's first non-chain, non-Polkadot upstream.** Every source module today
reads a chain, an indexer over a chain, or a bridge's own API. `docs/platform/` is a knowledge base
about how Polkadot works. A price aggregator is a different kind of object and the first of its kind
here.

**It would be the first price oracle that is not on-chain.** Rule 3 says a number carries its caveat.
The caveat here attaches not to one page but to **every page carrying a dollar figure**: *this figure
derives from a centralised exchange aggregate, not from a chain.* That is a data note on the XCM page,
the Hydration pages, the bridges page and everything built after them — a permanent, site-wide
disclosure bought for a rounding difference.

**It would need the whole apparatus anyway** — a `server/sources/` module, a registry entry in
`index.mjs`, a liveness assertion, and a cache — for a host that is explicitly asking not to be
scraped.

**It is less reliable than the chain.** `query1` returned `Edge: Too Many Requests` on first contact
and 200 later; `query2` served eight rapid calls without complaint. Undocumented endpoints behind a
CDN's bot mitigation change without notice, and the failure would arrive as a silent gap in a chart.

## What we give up

One thing, and it is real: **DOT/USD before 2024-11-12**.

Hydration's money-market oracle did not exist before that block, so the on-chain series simply starts
there. Yahoo has 2,191 daily bars going back to 2020-08-21 — the whole of DOT's history, plus 1-minute
granularity for a day and 5-minute for a week, none of which the chain offers.

If a chart is ever wanted that reaches back to 2020, this decision is what stands in the way, and
reopening it is legitimate. But the answer should still not be Yahoo: it should be an on-chain
construction from the Omnipool's own reserves at historical blocks, which held plain DOT in that era
rather than aDOT. That is a different read, it has not been attempted, and it is in the research queue.

Until then a chart that starts on 2024-11-12 says so on the page, which is rule 3 working exactly as
intended: a stated gap beats an unstated borrowing.

## Consequences

- No `server/sources/` module may call a price aggregator, an exchange API, or any off-chain quote
  service. A future one needs a record superseding this.
- DOT/USD, live and historical, comes from the money-market oracle. The caveats that go on the page
  are drafted in [hydration.md](../platform/hydration.md#page-notes).
- The oracle is a **stepped feed** — about 18 updates a day, verified live — and can lag a fast move
  by up to an hour. Any page quoting it says so.
- **Where the feed ultimately sources its number is `inferred`, not verified.** The price is computed
  at call time rather than stored (verified live), but `debug_traceCall` and `trace_call` are both
  unavailable on `rpc.hydradx.cloud`, so the call graph could not be followed. Nothing may claim on a
  page that this price is chain-internal and trust-free until someone reads the fork's source. This
  decision rejects a *known* off-chain oracle; it does not assert that what replaced it is provably
  on-chain.
- Yahoo stays available as a by-hand check, and using it that way is encouraged — it is how the
  0.16 % reconciliation above was obtained, and re-running it is the cheapest way to catch the oracle
  drifting.
