# polkadot-analytics

Public analytics dashboards over Polkadot ecosystem data —
**[analytics.cypherpunk.agency](https://analytics.cypherpunk.agency)**.

Read live from public chains, indexers and APIs. No accounts, no API keys, no tracking, nothing
stored about anyone. Every number on the site says where it came from and what is wrong with it.

## Dashboards

| Page | What it shows | Read from |
|---|---|---|
| [XCM message flow](https://analytics.cypherpunk.agency/xcm/) | Which chains talk to each other, how much lands, how long it takes | Parity Dotlake |
| [Hydration DEX activity](https://analytics.cypherpunk.agency/hydration/) | Omnipool swaps regrouped from per-leg events into real trades, valued in dollars | Hydration Subsquid archive + RPC |
| [HyperFX swap volume](https://analytics.cypherpunk.agency/hyperfx/) | Every intent order bridged through Hyperbridge, by day, route and account | Hyperbridge nexus indexer |
| [Bulletin chain storage](https://analytics.cypherpunk.agency/bulletin/) | What is stored, what shape it is, and how long its leases have left | Bulletin devnet RPC |
| [Parachain netflows](https://analytics.cypherpunk.agency/netflows/) | Archived 2021–2023 study of DOT and KSM in parachain sovereign accounts | Committed dataset |

The machine-readable description of every query this site can make is at
[`/api`](https://analytics.cypherpunk.agency/api), generated from the server's own source
registry.

## Also a knowledge base

`docs/platform/` documents the platforms this site reads — XCM, Asset Hub, smart contracts on
Polkadot, the People Chain, Hydration, Hyperbridge and the Bulletin chain — kept next to the code
that queries them so the two stay honest about each other.

## The three rules

**1. No secrets, ever.** No API key, no token, no service-account file, no `.env` — not stored
carefully, absent. Every upstream is anonymous public HTTP. Wanting a credential is a design
conversation, not a config line, and the build fails on anything credential-shaped.

**2. The browser talks only to this origin.** Every upstream call happens server-side, and the
build fails if an absolute URL appears outside the source registry. Two reasons: the production
CSP allows this origin and nothing else, so a direct fetch would fail *silently* — page renders,
200 everywhere, chart empty — and these pages are heavy clients that would otherwise flatten a
volunteer-run node once per visitor.

**3. Say what is wrong with the number.** Every page carries a data-notes section generated from
the same payload the charts are drawn from. An unpriced asset, an interpolated timestamp, a
pallet account sitting in a "top traders" list, a dollar figure that is really a floor — these get
stated on the page. A number without its caveat is worse than no number.

## Running it

Requires Node 22+.

```bash
npm install
npm run dev
```

Vite on `:5180`, the API on `:8080`, `/api` proxied so the browser only ever talks to one origin
— the same shape as production.

```bash
npm run preview   # production build served by the real server on :8080
npm run check     # syntax, secret scan, source-registry contract, no-third-party-fetch check
```

## How it is built

No framework, no charting library, no CDN, no webfonts, one npm dependency (Vite, dev-only). The
runtime image installs nothing.

- `server/` — the API. Node 22, zero runtime dependencies. Static files, one cached read-only
  API, one health check.
- `server/sources/` — one module per upstream. This is the security boundary: `/api/:source/:op`
  resolves both segments against a static table, so there is no path from a client string to a
  URL.
- `src/core/` — shared by the browser bundle **and** the Node server: chain codecs, price
  derivation, the canonical swap model.
- `src/design/` — the design system. Every page is built from it and adds no CSS of its own.
- `src/pages/` — one entry per dashboard, most about twenty lines.

## Documentation

[`docs/`](docs/README.md) is three kinds of document, kept apart on purpose:
`architecture/` is how this repo works, `platform/` is how Polkadot works, and `decisions/` is
why we chose what we chose — argued, with what was rejected and what it costs.

Good places to start: [`docs/architecture/overview.md`](docs/architecture/overview.md) for the
map, [`docs/architecture/middleware.md`](docs/architecture/middleware.md) for the data layer and
why the browser never talks to a third party, and [`CLAUDE.md`](CLAUDE.md) for the working
agreements, several of which exist because something failed silently once.

Most of `docs/` is also published, rendered from the same source, at
[analytics.cypherpunk.agency/knowledge/](https://analytics.cypherpunk.agency/knowledge/).

## Deployment

Containerised, pushed to GHCR, deployed to a GCP VM behind Caddy with keyless Workload Identity
Federation — no long-lived cloud credential. See
[`docs/architecture/deployment.md`](docs/architecture/deployment.md).

**This repository contains no secrets and needs none.** Every upstream is anonymous public HTTP.
See [`docs/decisions/0003-no-secrets.md`](docs/decisions/0003-no-secrets.md).

## Provenance

The HyperFX and Bulletin dashboards began as apps in `yolodot`; the Hydration page is the
descendant of 2022 Mangata X DEX-stats work; the netflows page is a re-rendering of a 2023
Polkalytics study. Re-deriving that last one from its raw CSVs turned up three places where the
published report and the data disagree, which the page lists rather than reconciles.
