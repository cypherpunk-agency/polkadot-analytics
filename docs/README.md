# Documentation

Three kinds of document, kept apart on purpose.

## `architecture/` — how this repo works

| | |
|---|---|
| [overview.md](architecture/overview.md) | the map: request path, directories, where to start for a given task |
| [middleware.md](architecture/middleware.md) | the shared data layer — the source registry, transports, caching, the failure taxonomy, the canonical swap model |
| [jobs.md](architecture/jobs.md) | the store and the job system — facts, segments, job identity, leases, the politeness gate, and the handler contract |
| [design-system.md](architecture/design-system.md) | tokens, the validated palette, chart rules, the four-state page, and the CSP trap that already cost us a silent bug |
| [security.md](architecture/security.md) | public exposure, the CSP, why this is not an open proxy, resource limits, being a good citizen upstream |
| [deployment.md](architecture/deployment.md) | image, health endpoints, push-to-deploy, what infra still owes |

## `platform/` — how Polkadot works

The knowledge base. These exist so a question about the ecosystem can be answered from this repo
without going and reading a chain first, and so the code that queries a chain sits next to a
written account of what it is querying.

| | |
|---|---|
| [polkadot.md](platform/polkadot.md) | relay chain, parachains, Agile Coretime, system chains, where JAM fits |
| [asset-hub.md](platform/asset-hub.md) | assets, foreign assets, multilocations, sufficiency, the migration off the relay chain |
| [xcm.md](platform/xcm.md) | XCM as a language: the instruction model, reserve vs teleport, sovereign accounts, barriers, and a worked transfer |
| [smart-contracts.md](platform/smart-contracts.md) | pallet-revive and PolkaVM, Ethereum RPC compatibility, address mapping, where ink! stands |
| [people-chain.md](platform/people-chain.md) | identity off the relay chain, registrars and judgements, resolving an address to a name |
| [hydration.md](platform/hydration.md) | the Omnipool, stableswap, the Router, DCA, the money market, HOLLAR — and the `Broadcast.Swapped3` event this site reads |
| [hyperbridge.md](platform/hyperbridge.md) | consensus-proof interoperability, the nexus indexer, and HyperFX intent orders |
| [bridges.md](platform/bridges.md) | every bridge that reaches Polkadot, what each one asks you to trust, and why their numbers cannot be added together |
| [moonbeam.md](platform/moonbeam.md) | how a parachain leaves: Moonbeam's deregistration, the exact block, and the three other departures nobody noticed |
| [bulletin.md](platform/bulletin.md) | content-addressed transaction storage, leases, Store vs Renew, the Products Devnet |
| [data-sources.md](platform/data-sources.md) | every endpoint this site reads, what it costs, and what is wrong with it |

## `decisions/` — why we chose what we chose

| | |
|---|---|
| [0001](decisions/0001-containerised-not-static.md) | a container with a caching proxy, not a static bundle |
| [0002](decisions/0002-one-shared-library.md) | one shared library, not one app per dashboard |
| [0003](decisions/0003-no-secrets.md) | this repository holds no secrets, and cannot |
| [0004](decisions/0004-server-side-aggregation.md) | aggregate on the server, render in the browser |
| [0005](decisions/0005-public-no-gate.md) | published publicly, with no authentication gate |
| [0006](decisions/0006-demand-driven-store.md) | a demand-driven store and a job queue, not a scheduled pipeline |
| [0007](decisions/0007-bulletin-client-direct.md) | Bulletin is watched by the client, never stored server-side |
| [0008](decisions/0008-no-off-chain-price-oracle.md) | prices come from chains, not from Yahoo Finance |
| [0009](decisions/0009-pricing-is-a-composed-source.md) | pricing is a source others compose, not a library others import |
| [0010](decisions/0010-unreachable-is-data.md) | an unreachable upstream returns a payload, it does not throw |

## `concept/` — working notes, deliberately not published

`docs/concept/` exists in the repository and is **not** on the website. It holds research
sweeps and working notes — inventories of other repositories, half-formed plans, notes on
strategy — written while working out what a dashboard should be. Some of it concerns things
that are not public analytics at all.

The publication rule is an **allowlist**, in `PUBLISHED_SECTIONS` in `scripts/knowledge.mjs`:
`architecture/`, `platform/` and `decisions/` are rendered to `/knowledge/`, and a directory
that is not named there is not published, including one that did not exist when that line was
written. Publishing a new directory is a deliberate edit to that constant, and `npm run check`
prints every withheld document on every run so the omission is visible rather than forgotten.

A link from a published document into `concept/` renders as plain text rather than as a URL —
the build refuses to name a withheld file on a public page.

---

A note on the split: `architecture/` describes something we control and can change. `platform/`
describes something we do not, and where being wrong is expensive because the code is built on
it — so those documents date their claims and hedge where they are unsure, rather than stating
everything flatly.
