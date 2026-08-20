# 0002 — One shared library, not one app per dashboard

**Status:** accepted · 2026-08-19

## Context

The dashboards were ported from `yolodot`, where each was an independent Vite app with its own
`package.json`, its own stylesheet, its own fetch layer and its own idea of what a chart looks
like. That was correct there — they were separate experiments on separate domains.

Here they are pages of one site.

## Decision

One package. One data layer (`server/sources/` plus `src/core/client.js`), one set of shared pure
modules used by both runtimes (`src/core/`), one design system (`src/design/`). Pages are thin
views.

## Why

Independent apps drift. Three months in there are three ways to format a dollar figure, two
loading spinners and a chart using a colour outside the validated palette, and no one edit fixes
all of them.

The concrete test was the swap dashboard. HyperFX and Hydration share nothing at the protocol
level — intent orders bridged across five EVM chains versus an Omnipool on a parachain. They
share everything at the reporting level: somebody sent one asset and received another, at a
time, on a venue. Normalising both into one `Trade` shape means one `aggregate()`, one renderer,
and two page files of about twenty lines each.

`src/core/` being importable by **both** the browser bundle and the Node server is what makes
this real rather than aspirational: when the server aggregates Hydration swaps it calls the same
function the browser would have.

## Consequences

- Adding a DEX is a normaliser on the server and no dashboard code.
- Adding a source is one module and one line.
- A design change is one file.
- The shared modules must stay dependency-free and runtime-neutral — no DOM, no Node built-ins.
- Chain-specific decoding still lives with its source (`bulletin-chain.js`), because that is
  knowledge about one chain rather than shared machinery.
