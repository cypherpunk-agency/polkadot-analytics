# 0003 — This repository holds no secrets, and cannot

**Status:** accepted · 2026-08-19 · required by Tommi at the outset

## Context

Stated as a requirement before any code was written: this repo should not need API keys or
secrets.

## Decision

No credential of any kind exists in this repository, in its container, or in its deployment. Not
stored securely — **absent**. Every upstream is anonymous public HTTP.

## Why

It was achievable without compromise, which made it the obvious choice:

| upstream | auth |
|---|---|
| Hyperbridge nexus indexer | none; CORS open |
| Hydration archive and RPC | none |
| Bulletin devnet RPC | none |
| Parity Dotlake | optional bearer; the anonymous alternative is declared in its OpenAPI document and verified working |

A repo with no secrets has no secret rotation, no secret leak, no `.env.example` that drifts from
reality, no "works on my machine because I have the key", and nothing to register in a disaster
recovery manifest. Deployment authenticates with GitHub's OIDC token through Workload Identity
Federation, so there is no long-lived cloud credential either.

## Consequences

- No upstream may be added that requires a key without an explicit decision recorded here first.
  If one is ever needed it goes in `server/lib/upstream.mjs` — in the open, in one place, where
  the argument about whether to take it on can actually happen.
- `.gitignore` and `.dockerignore` both carry credential-shaped patterns as a **tripwire**, not a
  workflow. If one ever matches something real, the answer is to delete the file and rethink, not
  to rely on the ignore. Both files carry them because `.gitignore` does not protect a Docker
  build context.
- `npm run check` and CI fail on credential-shaped tracked files.
- Some data is out of reach. That is the trade, and it is worth it.
