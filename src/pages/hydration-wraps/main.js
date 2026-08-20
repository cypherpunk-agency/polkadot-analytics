// Hydration's wrap map.
//
// The question this page answers is not "what is the rate" — that is the money-market board.
// It is the question underneath: **how many forms does one asset exist in here, and what binds
// them together?** DOT is on Hydration as DOT, as aDOT (the money market's interest-bearing
// wrapper), and inside GDOT (the share token of the vDOT/aDOT pool). A route that looks like
// four hops is often one asset changing costume three times, and nothing publishes the costume
// list.
//
// Three things make this a reference table rather than a screenshot of somebody's UI:
//
//   · EVERY BINDING IS CONFIRMED TWICE. The Pool contract lists an aToken against an underlying;
//     the aToken is then asked `UNDERLYING_ASSET_ADDRESS()` itself and must name the same
//     address back. A row that fails that is marked unconfirmed rather than dropped.
//   · THE ASSET IDS ARE THE POINT. Most of the money market's "token contracts" are synthetic
//     precompile addresses with the Substrate asset id inside them, and the rest are real ERC-20s
//     resolved through `AssetRegistry::AssetLocations`. Publishing the address without the id is
//     publishing half a map.
//   · THE LIMITS ARE GOVERNANCE FACTS. LTV, liquidation threshold and the supply/borrow caps
//     are what the protocol is *configured* to allow, and they change by vote, not by the block.
//
// What is deliberately NOT here: supply and borrow rates, and utilisation of liquidity. Those
// live on the money-market board. The percentages on this page are headroom against a cap,
// which is a different question with a different answer.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { compact, formatCount, percent, shortAddr } from '../../core/format.js'

const dash = '—'

/** A symbol is never enough on its own here: two registered assets can carry one ticker. */
const named = (symbol, id) => (id === null || id === undefined ? symbol ?? dash : `${symbol ?? 'asset'} · ${id}`)

function render(host, data) {
  clear(host)

  if (data.empty) {
    append(
      host,
      notice(
        'warning',
        'The money market listed no reserves',
        'The Pool contract answered and its reserve list is empty. That is what the chain says right now; it is not a failure to read it.',
      ),
    )
    return
  }

  const { chain, contracts, protocol, reserves, emodes, notes } = data
  const mapped = reserves.filter((reserve) => reserve.aTokenAssetId !== null).length
  const confirmed = reserves.filter((reserve) => reserve.wrapConfirmed === true).length

  append(
    host,
    statRow([
      statTile('Reserves', formatCount(protocol.reserveCount), `${mapped} wrap into an asset that is itself registered`, { hero: true }),
      statTile('Bindings confirmed', `${confirmed} / ${reserves.length}`, 'the aToken names its own underlying back'),
      statTile('Flash loans', `${protocol.flashLoanEnabledCount} / ${reserves.length}`, `enabled reserves, at ${protocol.flashLoanPremiumBps} bps`),
      statTile('e-mode categories', formatCount(protocol.emodeCount), 'correlated-asset borrowing tiers'),
    ]),

    wrapCard(reserves),
    capCard(reserves),
    riskCard(reserves),
    emodeCard(emodes),
    contractsCard(contracts, chain),
    notesSection(notes, chain),
  )
}

/* ─────────────────────────────────────────────────────────────────────────── the wrap map ── */

function wrapCard(reserves) {
  const body = el('tbody')
  for (const reserve of reserves) {
    append(
      body,
      el(
        'tr',
        null,
        el('td.mono', { text: named(reserve.symbol, reserve.assetId) }),
        el('td', { text: reserve.assetType ?? dash }),
        el('td.num', { text: reserve.decimals === null ? dash : String(reserve.decimals) }),
        el('td.mono', { text: reserve.aTokenSymbol ? named(reserve.aTokenSymbol, reserve.aTokenAssetId) : dash }),
        el('td.mono', { text: reserve.aTokenAddress ? shortAddr(reserve.aTokenAddress, 8, 6) : dash, title: reserve.aTokenAddress ?? '' }),
        el(
          'td',
          null,
          el('span.pill', {
            text: reserve.wrapConfirmed === true ? 'confirmed' : reserve.wrapConfirmed === false ? 'disagrees' : 'unknown',
            data: { tone: reserve.wrapConfirmed === true ? 'good' : 'warning' },
          }),
        ),
        el('td.mono', { text: shortAddr(reserve.address, 8, 6), title: reserve.address }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'The wrap map' }),
      el('p.note', {
        text:
          'One row per money-market reserve: the asset, the aToken minted against it, and whether the aToken agrees about what it wraps. The aToken is itself a registered Hydration asset in almost every case, which is what lets a route hop between the two forms inside a single swap — and is why the money market sits inside the swap path rather than beside it.',
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
            el('th', { text: 'Asset' }),
            el('th', { text: 'Registry type' }),
            el('th.num', { text: 'Dec' }),
            el('th', { text: 'Wrapped as' }),
            el('th', { text: 'aToken contract' }),
            el('th', { text: 'Binding' }),
            el('th', { text: 'Underlying contract' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ─────────────────────────────────────────────────────────────────── caps and headroom ── */

/**
 * Headroom against a governance cap, drawn linear from zero. Reserves with no cap are not
 * drawn at 0 % — "uncapped" and "empty" are different facts — they are listed separately
 * underneath, where a reader can see that the set is complete.
 */
function capCard(reserves) {
  const capped = reserves.filter((reserve) => reserve.supplyCap !== null && reserve.supplyCapUsed !== null).sort((a, b) => b.supplyCapUsed - a.supplyCapUsed)
  const uncapped = reserves.filter((reserve) => reserve.supplyCap === null)

  const rows = el('div.rows')
  for (const reserve of capped) {
    append(
      rows,
      el(
        'div.row',
        null,
        el('div.name', { text: named(reserve.symbol, reserve.assetId) }),
        el('div.track', null, el('div.fill', { style: `width:${Math.min(100, Math.max(0.5, reserve.supplyCapUsed * 100))}%` })),
        el(
          'div.amt',
          null,
          document.createTextNode(percent(reserve.supplyCapUsed * 100, 1)),
          el('span.cnt', { text: ` · ${compact(reserve.supplied)} of ${compact(reserve.supplyCap)}` }),
        ),
      ),
    )
  }

  const table = el('tbody')
  for (const reserve of reserves) {
    append(
      table,
      el(
        'tr',
        null,
        el('td.mono', { text: named(reserve.symbol, reserve.assetId) }),
        el('td.num', { text: reserve.supplied === null ? dash : compact(reserve.supplied) }),
        el('td.num', { text: reserve.supplyCap === null ? 'no cap' : compact(reserve.supplyCap) }),
        el('td.num', { text: reserve.supplyCapUsed === null ? dash : percent(reserve.supplyCapUsed * 100, 1) }),
        el('td.num', { text: reserve.borrowed === null ? dash : compact(reserve.borrowed) }),
        el('td.num', { text: reserve.borrowCap === null ? 'no cap' : compact(reserve.borrowCap) }),
        el('td.num', { text: reserve.borrowCapUsed === null ? dash : percent(reserve.borrowCapUsed * 100, 1) }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Room left under the caps' }),
      el('p.note', {
        text:
          'How full each reserve is against the supply cap governance set for it. This is headroom under a configured ceiling — not utilisation of the pool’s liquidity, which is the borrowed-over-supplied ratio and lives on the money-market board. Bars are linear from zero and reserves with no cap are not drawn, because a reserve with no ceiling is not a reserve that is 0 % full.',
      }),
    ),
    rows,
    uncapped.length
      ? el('p.note', { text: `No supply cap is set on: ${uncapped.map((reserve) => named(reserve.symbol, reserve.assetId)).join(', ')}.` })
      : null,
    el(
      'details.data-table',
      null,
      el('summary', { text: `Supplied, borrowed and both caps — ${reserves.length} reserves` }),
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
              el('th.num', { text: 'Supplied' }),
              el('th.num', { text: 'Supply cap' }),
              el('th.num', { text: 'Used' }),
              el('th.num', { text: 'Borrowed' }),
              el('th.num', { text: 'Borrow cap' }),
              el('th.num', { text: 'Used' }),
            ),
          ),
          table,
        ),
      ),
    ),
  )
}

/* ─────────────────────────────────────────────────────────────────────── risk parameters ── */

const flagList = (reserve) =>
  [
    reserve.active ? null : 'inactive',
    reserve.frozen ? 'frozen' : null,
    reserve.paused ? 'paused' : null,
    reserve.borrowingEnabled ? null : 'no borrowing',
    reserve.siloedBorrowing ? 'siloed' : null,
    reserve.borrowableInIsolation ? 'isolation' : null,
    reserve.flashLoanEnabled ? 'flash loans' : null,
  ]
    .filter(Boolean)
    .join(', ') || 'standard'

function riskCard(reserves) {
  const body = el('tbody')
  for (const reserve of reserves) {
    append(
      body,
      el(
        'tr',
        null,
        el('td.mono', { text: named(reserve.symbol, reserve.assetId) }),
        el('td.num', { text: percent(reserve.ltv, 2) }),
        el('td.num', { text: percent(reserve.liquidationThreshold, 2) }),
        el('td.num', { text: percent(reserve.liquidationBonus - 100, 2) }),
        el('td.num', { text: percent(reserve.reserveFactor, 2) }),
        el('td.num', { text: percent(reserve.liquidationProtocolFee, 2) }),
        el('td.num', { text: reserve.emodeCategory ? String(reserve.emodeCategory) : dash }),
        el('td', { text: flagList(reserve) }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'What the configuration allows' }),
      el('p.note', {
        text:
          'Read out of the Aave `ReserveConfigurationMap` — one 256-bit word per reserve carrying eighteen fields as bit ranges, which arrives free inside the reserve data rather than costing eighteen calls. The liquidation bonus is shown as the premium over par, which is what a liquidator actually receives above the debt they repay.',
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
            el('th', { text: 'Asset' }),
            el('th.num', { text: 'LTV' }),
            el('th.num', { text: 'Liq. threshold' }),
            el('th.num', { text: 'Liq. bonus' }),
            el('th.num', { text: 'Reserve factor' }),
            el('th.num', { text: 'Liq. protocol fee' }),
            el('th.num', { text: 'e-mode' }),
            el('th', { text: 'Flags' }),
          ),
        ),
        body,
      ),
    ),
  )
}

function emodeCard(emodes) {
  if (!emodes.length) {
    return el(
      'section.card',
      null,
      el('header', null, el('h2', { text: 'e-mode categories' })),
      notice('info', 'No e-mode category is configured', 'The Pool answered with an unset category at the first index, so there are none to list.'),
    )
  }

  const body = el('tbody')
  for (const emode of emodes) {
    append(
      body,
      el(
        'tr',
        null,
        el('td.num', { text: String(emode.id) }),
        el('td', { text: emode.label ?? dash }),
        el('td.num', { text: percent(emode.ltv, 2) }),
        el('td.num', { text: percent(emode.liquidationThreshold, 2) }),
        el('td.num', { text: percent(emode.liquidationBonus - 100, 2) }),
        el('td.num', { text: emode.maxLeverage === null ? dash : `${emode.maxLeverage.toFixed(2)}×` }),
        el('td', { text: emode.members.length ? emode.members.join(', ') : 'no reserve is in it' }),
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
          'A category raises the loan-to-value ceiling for assets the protocol treats as correlated. The leverage column is the arithmetic ceiling that LTV implies — 1/(1−LTV), the limit of borrowing and re-supplying the same asset forever. It is a property of the number, not a recommendation, and it ignores every cost of getting there.',
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
            el('th.num', { text: '#' }),
            el('th', { text: 'Category' }),
            el('th.num', { text: 'LTV' }),
            el('th.num', { text: 'Liq. threshold' }),
            el('th.num', { text: 'Liq. bonus' }),
            el('th.num', { text: 'Implied ceiling' }),
            el('th', { text: 'Reserves in it' }),
          ),
        ),
        body,
      ),
    ),
  )
}

function contractsCard(contracts, chain) {
  const rows = [
    ['PoolAddressesProvider', contracts.addressesProvider, 'the one address this site carries as a constant'],
    ['Pool', contracts.pool, 'asked of the provider on every refresh'],
    ['PoolDataProvider', contracts.poolDataProvider, 'asked of the provider on every refresh'],
    ['PriceOracle', contracts.priceOracle, 'asked of the provider on every refresh'],
  ]

  const body = el('tbody')
  for (const [label, address, how] of rows) {
    append(body, el('tr', null, el('td', { text: label }), el('td.mono', { text: address ?? dash }), el('td', { text: how })))
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where these numbers come from' }),
      el('p.note', { text: `Read at block ${formatCount(chain.block)}, runtime spec ${chain.specVersion ?? dash}.` }),
    ),
    el('div.tablewrap', null, el('table.data', null, el('thead', null, el('tr', null, el('th', { text: 'Contract' }), el('th', { text: 'Address' }), el('th', { text: 'How it was found' }))), body)),
    notice(
      'warning',
      'One address here is hardcoded, and it should not have to be',
      'The Aave Pool is meant to be discoverable from `Liquidation.BorrowingContract` in Substrate storage — that is the whole point of it being storage and not a constant, because governance can move it. That item is EMPTY on the live chain. So this site anchors on the PoolAddressesProvider instead and asks it for everything else on every refresh, which at least means a governance move shows up as a changed address on this page rather than as a stale read nobody notices.',
    ),
  )
}

function notesSection(notes, chain) {
  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('ul', null, ...(notes ?? []).map((note) => el('li', { text: note }))),
    el('p', {
      text:
        'Storage keys are computed from the pallet and item names, never hardcoded — and the same discipline applies to SET MEMBERSHIP. The reserve list, the e-mode categories and the wrap bindings are all enumerated from the chain on every refresh, because a list that was right in July renders a subset in August without saying so.',
    }),
    el('p', { text: `Every figure above is one reading of current state at block ${formatCount(chain.block)}. Nothing here has a history behind it, so nothing here can tell you whether a value is usual.` }),
  )
}

renderPage({
  page: pageByKey('hydration-wraps'),
  intro:
    'One asset on Hydration is usually several assets. DOT is here as DOT, as aDOT once the money market wraps it, and again inside the share token of the pool that joins the two. This is the map between those forms — every reserve, the aToken minted against it, both asset ids, and what the protocol is configured to allow against each.',
  load: () => read('arbs-hydration', 'wrap-map'),
  render,
})
