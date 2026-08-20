// Hydration's money market, HOLLAR, and the Omnipool balance sheet.
//
// Three honesty constraints shape this page, and all three come from the same defect upstream:
// an `Erc20`-typed registry asset has no orml-tokens row, and reading one through orml returns
// `null` rather than an error.
//
//   · HOLLAR'S SUPPLY. The orml mirror and the real ERC-20 supply are shown side by side with
//     the ratio between them, because "this number is wrong" is only useful if you can see how
//     wrong. The right number is checked against the facilitator buckets, which must sum to it.
//   · THE OMNIPOOL TOTAL. Its value comes from `hub_reserve`, which exists for every listed
//     asset, so no asset can fall out of the total. The per-asset balances are still read by all
//     three paths, and the page states how much of the pool an orml-only sweep would have
//     missed — measured now, not quoted from when somebody wrote it down.
//   · THE DOLLAR TOTALS ARE FLOORS AND COMPOSITES. A reserve the oracle will not price
//     contributes `null`, never zero; a quarter of the "supplied" figure is receipts for
//     stableswap shares that are already counted in another venue's TVL; and one large reserve
//     is priced off a different venue entirely. Each of those is on the page, not in a footnote.

import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { lineChart, seriesColor } from '../../design/charts.js'
import { compact, formatCount, formatUtc, money, money2, percent, shortAddr } from '../../core/format.js'

/** `null` means "we could not value this", and it renders as an em dash rather than as a zero.
 *  The two are different facts and the page must not collapse them. */
const orDash = (value, format) => (value === null || value === undefined ? '—' : format(value))

const pct = (fraction, digits = 1) => (fraction === null || fraction === undefined ? '—' : percent(fraction * 100, digits))
const bps = (value) => (value === null || value === undefined ? '—' : percent(value / 100, 2))

/** A proportional bar. Linear from zero, always — and never below a hairline, so a real but
 *  tiny value stays visible instead of reading as absent. */
const track = (fraction, colour) =>
  el(
    'div.track',
    null,
    el('div.fill', {
      style:
        `width:${Math.max(0.5, Math.min(100, (fraction || 0) * 100)).toFixed(2)}%` + (colour ? `;background:${colour}` : ''),
    }),
  )

export function renderMoneyMarket(host, data) {
  clear(host)

  const { totals, reserves, eModes, hollar, omnipool, contracts } = data

  if (!reserves.length) {
    append(host, notice('warning', 'The market has no reserves', 'The pool answered and its reserve list is empty.'))
    return
  }

  append(
    host,
    statRow([
      statTile('Supplied', orDash(totals.suppliedUsd, money2), `${formatCount(totals.reserveCount)} reserves across ${totals.marketCount} pools`, {
        hero: true,
      }),
      statTile('Borrowed', orDash(totals.borrowedUsd, money2), `${pct(totals.utilisation)} of what is supplied`),
      statTile('HOLLAR supply', hollar ? compact(hollar.totalSupply) : '—', hollar ? `ERC-20 totalSupply, ${formatCount(hollar.facilitatorCount)} facilitators` : 'not resolved'),
      statTile('Omnipool', omnipool ? orDash(omnipool.tvlUsd, money2) : '—', omnipool ? `${formatCount(omnipool.assetCount)} listed assets` : 'not read'),
    ]),

    compositionCard(totals, omnipool),
    reserveSizeCard(reserves, totals),
    utilisationCard(reserves, totals),
    concentrationCard(reserves),
    reserveTable(reserves),
    eModeCard(eModes, data.eModeCeiling, reserves),
    hollarCard(hollar),
    omnipoolCard(omnipool),
    notesSection(data, contracts),
  )
}

/* ------------------------------------------------------------------- what the total is ---- */

/**
 * The headline dollar figure is a composite, and every part of it needs saying before anyone
 * quotes it. This card exists because "Hydration TVL: $55M" with no decomposition is the exact
 * shape of number this site is supposed to refuse to publish.
 */
function compositionCard(totals, omnipool) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'What the supplied total is made of' }),
      el('p.note', {
        text: 'Three different kinds of dollar go into one figure. They are separated here rather than argued about later.',
      }),
    ),
    statRow([
      statTile('Wrapper receipts', orDash(totals.wrapperSuppliedUsd, money2), `${pct(totals.wrapperShare)} of supplied — already counted in stableswap`),
      statTile('Priced off another venue', totals.spotPricedSymbols.length ? totals.spotPricedSymbols.join(', ') : 'none', 'no money-market oracle price; valued at Omnipool spot'),
      statTile('Not valued at all', formatCount(totals.unpricedCount), totals.unpricedCount ? totals.unpricedSymbols.join(', ') : 'every reserve carries a price'),
      statTile('No utilisation', formatCount(totals.noUtilisationCount), 'nothing supplied, so the ratio is 0/0 — not 0 %'),
    ]),
  )

  append(
    card,
    notice(
      'warning',
      'Adding this to an Omnipool or stableswap TVL double-counts',
      `${totals.wrapperSymbols.length} of the reserves (${totals.wrapperSymbols.join(', ')}) are aTokens over stableswap LP shares — money-market receipts for liquidity that is already counted where it actually sits. ` +
        `That is ${orDash(totals.wrapperSuppliedUsd, money2)}, ${pct(totals.wrapperShare)} of the supplied figure above.`,
      omnipool
        ? `The Omnipool figure on this page (${orDash(omnipool.tvlUsd, money2)}) is a separate venue and overlaps the same way: three of its listed assets are themselves money-market receipts. There is deliberately no "Hydration total TVL" number here, because every honest way of computing one has to decide what to subtract.`
        : 'There is deliberately no "Hydration total TVL" number on this page.',
    ),
    totals.unpricedCount
      ? notice(
          'info',
          `${formatCount(totals.unpricedCount)} reserves have no price, so the dollar totals are a floor`,
          `${totals.unpricedSupplied.map((r) => `${r.symbol}: ${orDash(r.supplied, compact)} supplied`).join(' · ')}. ` +
            'They contribute null to the totals rather than zero — "we could not value this" and "this was worth nothing" are different facts.',
        )
      : null,
  )
  return card
}

/* --------------------------------------------------------------------- reserve size ---- */

function reserveSizeCard(reserves, totals) {
  const max = Math.max(...reserves.map((r) => r.suppliedUsd ?? 0), 1)
  const list = el('div.rows')

  for (const reserve of reserves) {
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: `${reserve.symbol ?? shortAddr(reserve.asset)}${reserve.market === 'Core' ? '' : ` · ${reserve.market}`}` }),
        track(reserve.suppliedUsd === null ? 0 : reserve.suppliedUsd / max, seriesColor(reserve.isWrapper ? 4 : 0)),
        el(
          'div.amt',
          null,
          document.createTextNode(orDash(reserve.suppliedUsd, money)),
          el('span.cnt', {
            text: ` · ${orDash(reserve.borrowedUsd, money)} borrowed${reserve.frozen ? ' · frozen' : ''}${reserve.isWrapper ? ' · wrapper' : ''}`,
          }),
        ),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Reserve size' }),
      el('p.note', {
        text:
          `Supplied value per reserve, linear from zero, largest first. Wrapper reserves — aTokens over stableswap shares — are drawn in a second colour because they are the same dollars as another venue's TVL. ` +
          `A reserve with no price has no bar at all rather than a zero-length one.`,
      }),
    ),
    // Every legend on this site carries the value, not just the name — colour never carries
    // meaning on its own here.
    el(
      'ul.legend',
      null,
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(0)}` }),
        el('span', { text: 'reserve' }),
        el('span.amt', {
          text:
            totals.suppliedUsd !== null && totals.wrapperSuppliedUsd !== null
              ? money(totals.suppliedUsd - totals.wrapperSuppliedUsd)
              : '—',
        }),
      ),
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${seriesColor(4)}` }),
        el('span', { text: 'wrapper receipt' }),
        el('span.amt', { text: orDash(totals.wrapperSuppliedUsd, money) }),
      ),
      el('li', null, el('span', { text: 'total' }), el('span.amt', { text: orDash(totals.suppliedUsd, money2) })),
    ),
    list,
  )
}

/* ---------------------------------------------------------------------- utilisation ---- */

function utilisationCard(reserves, totals) {
  const withUtil = reserves.filter((r) => r.utilisation !== null).sort((a, b) => b.utilisation - a.utilisation)
  const without = reserves.filter((r) => r.utilisation === null)
  const list = el('div.rows')

  for (const reserve of withUtil) {
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: reserve.symbol ?? shortAddr(reserve.asset) }),
        track(reserve.utilisation, seriesColor(1)),
        el(
          'div.amt',
          null,
          document.createTextNode(pct(reserve.utilisation, 2)),
          el('span.cnt', { text: ` · supply ${pct(reserve.supplyApy, 2)} · borrow ${pct(reserve.borrowApy, 2)} APY` }),
        ),
      ),
    )
  }

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Utilisation' }),
      el('p.note', {
        text:
          'Borrowed over supplied, per reserve. Bars run 0–100 % and are linear from zero. Utilisation is what sets both rates through the interest-rate strategy, so this chart and the rate figures beside it are the same fact twice.',
      }),
    ),
    list,
  )

  if (without.length) {
    append(
      card,
      notice(
        'info',
        `${formatCount(without.length)} reserves have no utilisation, and that is not the same as 0 %`,
        `${without.map((r) => `${r.symbol ?? shortAddr(r.asset)} (${r.market})`).join(', ')} have nothing supplied, so borrowed ÷ supplied is 0/0 and has no value at all. ` +
          `HOLLAR is the interesting one: ${orDash(withoutBorrowed(without), money)} of it is borrowed against zero deposits, because it is minted into existence as debt rather than deposited by anyone. ` +
          'Drawing 0 % here would read as "nobody is borrowing it", which is the opposite of the truth.',
      ),
    )
  }
  // Market-wide utilisation is a ratio of the two dollar totals, so it inherits both floors.
  append(
    card,
    el('p.note', {
      text: `Market-wide: ${pct(totals.utilisation, 2)} of the priced supplied value is borrowed. Both halves of that ratio exclude anything the oracle would not price.`,
    }),
  )
  return card
}

const withoutBorrowed = (reserves) => {
  const values = reserves.map((r) => r.borrowedUsd).filter((v) => v !== null)
  return values.length ? values.reduce((a, b) => a + b, 0) : null
}

/* --------------------------------------------------------------------- concentration ---- */

/** Cumulative supplied value over reserves ranked largest first — the concentration curve. One
 *  y-axis, one line, and the reserve names are in the tooltip. */
function concentrationCard(reserves) {
  const ranked = reserves.filter((r) => r.suppliedUsd !== null && r.suppliedUsd > 0)
  if (ranked.length < 2) return null

  const points = []
  let running = 0
  for (const reserve of ranked) {
    running += reserve.suppliedUsd
    points.push(running)
  }
  const total = running
  const half = ranked.findIndex((_, i) => points[i] >= total / 2) + 1

  const plot = el('div.plot')
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'How concentrated the supply is' }),
      el('p.note', {
        text: `Cumulative supplied value, reserves largest first. Half of everything supplied sits in the top ${formatCount(half)} of ${formatCount(ranked.length)} priced reserves.`,
      }),
    ),
    plot,
  )
  queueMicrotask(() =>
    lineChart(plot, {
      points,
      labelOf: (i) => `${i + 1}. ${ranked[i].symbol ?? shortAddr(ranked[i].asset)}`,
      format: money,
    }),
  )
  return card
}

/* ------------------------------------------------------------------------ the table ---- */

function reserveTable(reserves) {
  const body = el('tbody')
  for (const r of reserves) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: r.symbol ?? shortAddr(r.asset) }),
        el('td', { text: r.market }),
        el('td.num', { text: orDash(r.supplied, compact) }),
        el('td.num', { text: orDash(r.borrowed, compact) }),
        el('td.num', { text: orDash(r.available, compact) }),
        el('td.num', { text: pct(r.utilisation, 2) }),
        el('td.num', { text: pct(r.supplyApy, 3) }),
        el('td.num', { text: pct(r.borrowApy, 3) }),
        el('td.num', { text: orDash(r.price, (v) => `$${v < 1 ? v.toFixed(6) : v.toFixed(2)}`) }),
        el('td.num', { text: orDash(r.suppliedUsd, money) }),
        el('td.num', { text: bps(r.ltvBps) }),
        el('td.num', { text: bps(r.liquidationThresholdBps) }),
        el('td.num', { text: r.supplyCap ? formatCount(r.supplyCap) : '—' }),
        el('td', { text: r.eModeCategory ? String(r.eModeCategory) : '—' }),
        el('td', { text: [r.frozen ? 'frozen' : null, r.paused ? 'paused' : null, r.borrowingEnabled ? null : 'no borrowing'].filter(Boolean).join(', ') || '—' }),
      ),
    )
  }

  const head = [
    'Reserve',
    'Pool',
    'Supplied',
    'Borrowed',
    'Available',
    'Util',
    'Supply APY',
    'Borrow APY',
    'Price',
    'Supplied $',
    'LTV',
    'Liq. thr.',
    'Supply cap',
    'e-mode',
    'Flags',
  ]

  return el(
    'details.data-table',
    null,
    el('summary', { text: `Every field, all ${formatCount(reserves.length)} reserves` }),
    el(
      'div.tablewrap.scroll-y',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, ...head.map((text, i) => el(i < 2 || i > 12 ? 'th' : 'th.num', { text })))),
        body,
      ),
    ),
  )
}

/* --------------------------------------------------------------------------- e-mode ---- */

function eModeCard(categories, ceiling, reserves) {
  if (!categories?.length) return null
  const counts = new Map()
  for (const reserve of reserves) counts.set(reserve.eModeCategory, (counts.get(reserve.eModeCategory) ?? 0) + 1)

  const body = el('tbody')
  for (const category of categories) {
    const members = reserves.filter((r) => r.eModeCategory === category.id).map((r) => r.symbol ?? shortAddr(r.asset))
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: String(category.id) }),
        el('td', { text: category.label }),
        el('td.num', { text: bps(category.ltvBps) }),
        el('td.num', { text: bps(category.liquidationThresholdBps) }),
        el('td.num', { text: bps(category.liquidationBonusBps) }),
        el('td', { text: members.length ? members.join(', ') : 'no reserve carries this category' }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'e-mode categories' }),
      el('p.note', {
        text:
          `Correlated-asset mode: borrowing inside a category buys a higher LTV than the reserve's own. Category ids are read from each reserve's configuration bitmap; the parameters and labels come from the pool. ` +
          `Ids 1–${formatCount(ceiling)} were probed and ${formatCount(categories.length)} were allocated — the list is bounded by that ceiling, not by anything the chain publishes. ` +
          `${formatCount(counts.get(0) ?? 0)} reserves are in no category at all.`,
      }),
    ),
    el(
      'div.tablewrap',
      null,
      el(
        'table.data',
        null,
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { text: 'Id' }),
            el('th', { text: 'Label' }),
            el('th.num', { text: 'LTV' }),
            el('th.num', { text: 'Liq. threshold' }),
            el('th.num', { text: 'Liq. bonus' }),
            el('th', { text: 'Reserves' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* --------------------------------------------------------------------------- HOLLAR ---- */

function hollarCard(hollar) {
  if (!hollar) return null

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'HOLLAR — the supply, and the number that is not it' }),
      el('p.note', {
        text:
          'HOLLAR is a GHO fork: nobody deposits it, it is minted into existence as debt by a fixed set of facilitators, each with a capped bucket. That makes its supply an ERC-20 fact, not an orml-tokens one.',
      }),
    ),
    statRow([
      statTile('Real supply', compact(hollar.totalSupply), `ERC-20 totalSupply() at ${shortAddr(hollar.token)}`, { hero: true }),
      statTile('Tokens::TotalIssuance(222)', orDash(hollar.issuanceMirror, compact), hollar.mirrorRatio ? `the real supply is ${formatCount(Math.round(hollar.mirrorRatio))}× this` : 'no entry in the orml mirror at all'),
      statTile('Mint capacity', orDash(hollar.mintCapacity, compact), `${formatCount(hollar.facilitatorCount)} facilitators`),
      statTile(
        'Minted as market debt',
        hollar.reserve ? pct(hollar.reserve.share) : '—',
        hollar.reserve
          ? `${orDash(hollar.reserve.borrowed, compact)} borrowed against zero deposits, across ${hollar.reserve.markets.join(' + ')}`
          : 'no HOLLAR reserve found',
      ),
    ]),
  )

  append(
    card,
    notice(
      'critical',
      'The obvious read of this number is wrong by a factor of hundreds',
      `\`Tokens::TotalIssuance(222)\` reads ${orDash(hollar.issuanceMirror, compact)} HOLLAR. The token contract reads ${compact(hollar.totalSupply)}. ` +
        'HOLLAR is an `Erc20`-typed registry asset, so its balances live in EVM storage and the Substrate mirror is a residue. This is not a HOLLAR quirk: the same read returns exactly `0` for aDOT and no entry at all for HDX.',
      'This site published the small number until today. It is kept on screen rather than quietly corrected, because a dashboard that silently changes a figure by 700× teaches a reader nothing.',
    ),
    hollar.levelSumMatchesSupply
      ? notice(
          'good',
          'The facilitator buckets sum to the supply exactly',
          `All ${formatCount(hollar.facilitatorCount)} bucket levels add up to ${compact(hollar.levelSum)} — the same integer, to the wei, as totalSupply(). Two independent reads of the same quantity agreeing is what makes the figure above trustworthy rather than merely plausible.`,
        )
      : notice(
          'warning',
          'The facilitator buckets do not sum to the supply',
          `The levels add to ${orDash(hollar.levelSum, compact)}, a gap of ${orDash(hollar.levelSumGap, compact)} against totalSupply(). ` +
            (hollar.unreadableFacilitators
              ? `${formatCount(hollar.unreadableFacilitators)} bucket(s) could not be read, which would explain it.`
              : 'Every bucket was read, so this is either interest accruing between the two calls or a real disagreement.'),
        ),
    facilitatorRows(hollar),
    hollar.inOmnipool
      ? notice(
          'info',
          'The same defect, in the place it costs the most',
          `The Omnipool holds ${orDash(hollar.inOmnipool.reserve, compact)} HOLLAR — ${orDash(hollar.inOmnipool.tvlUsd, money2)}, its largest single position. ` +
            `\`Tokens::Accounts(omnipool, 222)\` returns ${hollar.inOmnipool.ormlWouldFind === null ? '`null`' : compact(hollar.inOmnipool.ormlWouldFind)} for it. A TVL sweep built on that read drops the biggest asset in the pool and renders perfectly.`,
        )
      : null,
  )
  return card
}

function facilitatorRows(hollar) {
  const max = Math.max(...hollar.facilitators.map((f) => f.capacity ?? 0), 1)
  const list = el('div.rows')
  hollar.facilitators.forEach((facilitator, i) => {
    append(
      list,
      el(
        'div.row',
        null,
        // Named where the chain names it — a pallet id decoded from the address, or the market
        // whose aHOLLAR contract this is. Anything else stays an address rather than a guess.
        el('div.name', { text: facilitator.label ?? shortAddr(facilitator.address, 8, 6) }),
        track(facilitator.level === null ? 0 : facilitator.level / max, seriesColor(i)),
        el(
          'div.amt',
          null,
          document.createTextNode(orDash(facilitator.level, compact)),
          el('span.cnt', {
            text: ` / ${orDash(facilitator.capacity, compact)} cap${facilitator.atCapacity ? ' · at cap' : ''}${facilitator.unreadable ? ' · unreadable' : ''}`,
          }),
        ),
      ),
    )
  })
  return el(
    'div',
    null,
    el('p.note', {
      text:
        'Minted per facilitator, against its bucket capacity. Bars are linear from zero and share one scale — the widest bucket, not each row’s own — so a facilitator at its cap and a facilitator with room are visibly different things.',
    }),
    list,
  )
}

/* ------------------------------------------------------------------------- Omnipool ---- */

const PATH_LABEL = {
  orml: 'Tokens::Accounts (orml)',
  system: 'System::Account (pallet-balances)',
  evm: 'eth_call balanceOf (ERC-20)',
}

function omnipoolCard(omnipool) {
  if (!omnipool) return null

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'The Omnipool balance sheet, read three ways' }),
      el('p.note', {
        text:
          'An asset’s balance in the pool lives in a different storage item depending on its registry type, and asking the wrong one returns null rather than an error. This is what that costs, measured now.',
      }),
    ),
    statRow([
      statTile('Pool value', orDash(omnipool.tvlUsd, money2), `${formatCount(omnipool.assetCount)} listed assets`, { hero: true }),
      statTile('An orml-only sweep misses', orDash(omnipool.ormlOnlyMissesUsd, money2), `${pct(omnipool.ormlOnlyMissesShare)} of the pool, in ${formatCount(omnipool.ormlOnlyMissesCount)} assets`),
      statTile('Hub asset', orDash(omnipool.hubUsd, (v) => `$${v.toFixed(4)}`), `derived from ${formatCount(omnipool.hubAnchorCount)} priced assets, spread ${orDash(omnipool.hubAnchorSpreadBps, (v) => `${v.toFixed(0)} bps`)}`),
      statTile('Unreadable balances', formatCount(omnipool.unreadableReserves.length), omnipool.unreadableReserves.length ? omnipool.unreadableReserves.join(', ') : 'every asset resolved on its own path'),
    ]),
    readPathRows(omnipool),
  )

  append(
    card,
    notice(
      'critical',
      `A Tokens::Accounts sweep resolves ${formatCount(omnipool.assetCount - omnipool.ormlOnlyMissesCount)} of ${formatCount(omnipool.assetCount)} assets and silently drops the rest`,
      `The ${formatCount(omnipool.ormlOnlyMissesCount)} it misses — ${omnipool.ormlOnlyMissesSymbols.join(', ')} — are ${pct(omnipool.ormlOnlyMissesShare)} of the pool’s value. ` +
        'Four are `Erc20` assets whose balances are in EVM storage; the fifth is HDX, which is `pallet-balances` and not orml at all. Every one of them returns `null`, which a naive sum turns into zero.',
      'The figure above does not depend on those reads at all: an asset’s value in the pool is its `hub_reserve`, which `Omnipool::Assets` carries for every listed asset. The balances are read anyway, because a spot price needs them — and because measuring the gap is the only way to state it as a fact rather than as folklore.',
    ),
    omnipoolTable(omnipool),
  )
  return card
}

function readPathRows(omnipool) {
  const max = Math.max(...omnipool.byReadPath.map((p) => p.tvlUsd ?? 0), 1)
  const list = el('div.rows')
  omnipool.byReadPath.forEach((path, i) => {
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: PATH_LABEL[path.path] ?? path.path }),
        track(path.tvlUsd === null ? 0 : path.tvlUsd / max, seriesColor(i)),
        el(
          'div.amt',
          null,
          document.createTextNode(orDash(path.tvlUsd, money)),
          el('span.cnt', { text: ` · ${formatCount(path.count)} asset${path.count === 1 ? '' : 's'}` }),
        ),
      ),
    )
  })
  return el(
    'div',
    null,
    el('p.note', { text: 'Pool value by the storage item that holds the balance. One scale, linear from zero.' }),
    list,
  )
}

function omnipoolTable(omnipool) {
  const body = el('tbody')
  for (const asset of omnipool.assets) {
    append(
      body,
      el(
        'tr',
        null,
        el('td', { text: asset.symbol ?? `asset ${asset.id}` }),
        el('td.num', { text: String(asset.id) }),
        el('td', { text: asset.type ?? '—' }),
        el('td', { text: PATH_LABEL[asset.readPath] ?? asset.readPath }),
        el('td.num', { text: orDash(asset.reserve, compact) }),
        el('td.num', { text: asset.ormlWouldFind === null ? 'null' : compact(asset.ormlWouldFind) }),
        el('td.num', { text: orDash(asset.hubReserve, compact) }),
        el('td.num', { text: orDash(asset.tvlUsd, money) }),
        el('td.num', { text: orDash(asset.spotUsd, (v) => `$${v < 1 ? v.toFixed(6) : v.toFixed(2)}`) }),
        el('td.num', { text: orDash(asset.oraclePrice, (v) => `$${v < 1 ? v.toFixed(6) : v.toFixed(2)}`) }),
      ),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `Every listed asset, its read path, and what an orml-only sweep would have found` }),
    el(
      'div.tablewrap.scroll-y',
      null,
      el(
        'table.data',
        null,
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            el('th', { text: 'Asset' }),
            el('th.num', { text: 'Id' }),
            el('th', { text: 'Registry type' }),
            el('th', { text: 'Balance read from' }),
            el('th.num', { text: 'Reserve' }),
            el('th.num', { text: 'orml would find' }),
            el('th.num', { text: 'Hub reserve' }),
            el('th.num', { text: 'Value' }),
            el('th.num', { text: 'Pool spot' }),
            el('th.num', { text: 'Oracle' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ---------------------------------------------------------------------------- notes ---- */

/**
 * Generated from the same payload the charts are drawn from, so it cannot end up describing a
 * different dataset than the one on screen.
 */
function notesSection(data, contracts) {
  const { totals, hollar, omnipool, eModes } = data
  const notes = []

  if (hollar) {
    notes.push(
      `HOLLAR's supply is the ERC-20 \`totalSupply()\` at ${contracts.hollarToken}. \`Tokens::TotalIssuance(222)\` reads ${orDash(hollar.issuanceMirror, compact)}${hollar.mirrorRatio ? `, which is ${formatCount(Math.round(hollar.mirrorRatio))}× too small` : ''} and is meaningless: the Substrate mirror of an \`Erc20\` registry asset is a residue, not a supply. It is on the page beside the real figure rather than quietly dropped.`,
    )
    notes.push(
      hollar.levelSumMatchesSupply
        ? `The supply is cross-checked against the facilitator buckets: ${formatCount(hollar.facilitatorCount)} levels summing to the same integer as totalSupply(), to the wei.`
        : `The facilitator levels sum to ${orDash(hollar.levelSum, compact)}, ${orDash(hollar.levelSumGap, compact)} away from totalSupply(). The two calls are one round trip apart and the borrow facilitator accrues interest continuously, so a small gap is expected; a large one is not.`,
    )
  }

  if (omnipool) {
    notes.push(
      `Omnipool value is the sum of every listed asset's \`hub_reserve\`, which exists for all ${formatCount(omnipool.assetCount)} of them — so no asset can drop out of the total. Per-asset balances are read on three different paths; an orml-only sweep would have resolved ${formatCount(omnipool.assetCount - omnipool.ormlOnlyMissesCount)} of ${formatCount(omnipool.assetCount)} and returned \`null\` for ${omnipool.ormlOnlyMissesSymbols.join(', ')} — ${pct(omnipool.ormlOnlyMissesShare)} of the pool's value. The per-asset table carries what orml would have found for every asset, so the claim is checkable rather than asserted.`,
    )
    notes.push(
      `The hub asset has no dollar price of its own. It is anchored by inverting the pool against ${formatCount(omnipool.hubAnchorCount)} listed assets the money market prices (${omnipool.hubAnchors.join(', ')}); those answers disagree by ${orDash(omnipool.hubAnchorSpreadBps, (v) => `${v.toFixed(0)} bps`)}, which is a real spread between two venues and not a rounding error. The median is used. Every Omnipool dollar figure on this page inherits that uncertainty.`,
    )
    notes.push(
      `Pool spot prices are the Omnipool's own ratio (hub reserve ÷ reserve, in dollars). Where a money-market oracle price also exists both are shown, and they do not match — that difference is the venue spread, not a bug in either.`,
    )
  }

  notes.push(
    `The supplied total is a composite, not one kind of dollar. ${orDash(totals.wrapperSuppliedUsd, money2)} of it — ${pct(totals.wrapperShare)}, in ${formatCount(totals.wrapperSymbols.length)} reserves — is aTokens over stableswap LP shares, which are receipts for liquidity already counted where it sits. Adding this page's supplied figure to an Omnipool or stableswap TVL double-counts that much, which is why there is no combined "Hydration TVL" number anywhere on it.`,
  )
  notes.push(
    `Rates are Aave ray values: a linear per-second rate annualised over 365 days. The APY figures compound that rate every second, which is what a borrower pays and what Aave frontends show; the raw APR is carried in the payload for anyone reconciling against a bare \`getReserveData\` read.`,
  )
  notes.push(
    `The money-market oracle prices only its own reserves, to ${formatCount(String(totals.baseCurrencyUnit).length - 1)} decimal places (\`BASE_CURRENCY_UNIT\` = ${formatCount(totals.baseCurrencyUnit)}), and it hard-pegs HOLLAR at exactly $1.00 while HOLLAR's market price is not exactly $1. Liquidation arithmetic must use the oracle price; a peg chart must not, and there is no peg chart here.`,
  )
  if (totals.spotPricedSymbols.length) {
    notes.push(
      `${totals.spotPricedSymbols.join(', ')} has no oracle price and is valued at the Omnipool spot price of the asset it wraps. That is a FLOOR: a staking receipt is worth at least one unit of what it wraps and generally more, so its supplied value is understated by whatever has accrued.`,
    )
  }
  if (totals.unpricedCount) {
    notes.push(
      `${formatCount(totals.unpricedCount)} reserves (${totals.unpricedSymbols.join(', ')}) could not be valued at all. They contribute \`null\` to the dollar totals, never zero, so every dollar figure above is a floor.`,
    )
  }
  notes.push(
    `${formatCount(totals.noUtilisationCount)} reserves have nothing supplied, so their utilisation is 0/0 and is drawn as an em dash rather than as 0 %.`,
  )
  notes.push(
    `The Pool address is not hardcoded and not read from \`Liquidation::BorrowingContract\` — that item is ${contracts.borrowingContractStorage === null ? 'empty on chain (it has never been set), despite circulating notes saying otherwise' : `set to ${contracts.borrowingContractStorage}`}. It is derived from the aDOT registry entry through the aToken's \`POOL()\`, then round-tripped back through the addresses provider's \`getPool()\`; a disagreement at any hop fails the request rather than drawing a market at the wrong address.`,
  )
  notes.push(
    `e-mode ids 1–${formatCount(data.eModeCeiling)} were probed and ${formatCount(eModes.length)} were allocated. There is no count on chain, so that ceiling is ours — a category above it would not appear here. This repo's own research notes record \`getEModeCategoryData\` as returning an all-zero struct on this deployment; read live it returns populated categories with labels, so the note is out of date and this page follows the chain.`,
  )
  notes.push(
    `Contracts, all discovered rather than configured: pool ${contracts.corePool}${contracts.gigaPool ? `, GIGAHDX pool ${contracts.gigaPool} (from \`GigaHdx::GigaHdxPoolContract\` storage)` : ''}, addresses provider ${contracts.addressesProvider}, oracle ${contracts.priceOracle}, data provider ${contracts.poolDataProvider}.`,
  )

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Read from Hydration's public RPC over the \`eth_*\` plane, ${formatUtc(Date.parse(data.fetchedAt))}, in ${formatCount(data.elapsedMs)} ms. JSON-RPC batching turns roughly 180 contract calls into about two dozen HTTP requests; the server caches the result for five minutes so a visitor never fans out to the node.`,
    }),
    el('ul', null, ...notes.map((note) => el('li', { text: note }))),
    el('p', {
      text: 'Selectors are computed with keccak-256, never copied from notes. `UNDERLYING_ASSET_ADDRESS()` is 0xb16a19de — the value 0x89d1a0fc circulates in third-party writing about this market and is wrong.',
    }),
  )
}

