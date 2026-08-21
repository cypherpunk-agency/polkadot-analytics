// Capital on Hydration, drawn.
//
// The whole page exists to keep ONE distinction visible: the difference between what the four
// venues say about themselves added together, and what is actually here once. On 2026-08-21 that
// difference was $32.0 M on a gross of $89.3 M — a third of the number — and none of it is
// visible in any individual venue's own figures.
//
// It is removed in two named steps, and both are on the page rather than in a footnote:
//
//   1. RECEIPT TOKENS. A pool holding aDOT, or the money market holding a stableswap share
//      token, is holding a claim on reserves counted where they physically sit.
//   2. MONEY LENT BACK OUT. An Aave market lets a depositor borrow and re-deposit, so `supplied`
//      counts a looped position once per turn. This is not a modelling opinion: at gross, four
//      assets exceeded their own chain-wide supply and DOT exceeded it by 26 %. The supply check
//      that caught it is drawn on the page.
//
// Everything drawn here comes from one payload — `/api/hydration/capital` — so the caveats and
// the numbers cannot drift apart. See docs/platform/hydration-capital.md.

import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { segmentedLegend, segmentedRows } from '../../design/charts.js'
import { livenessNotes } from '../../design/liveness.js'
import { compact, formatCount, formatUtc, money, percent } from '../../core/format.js'

const dash = (value, format = money) => (value === null || value === undefined ? '—' : format(value))
const pct = (fraction, digits = 1) => (fraction === null || fraction === undefined ? '—' : percent(fraction * 100, digits))

/** A token amount at a readable precision, without pretending to more than we have. */
const units = (value) => (value === null || value === undefined ? '—' : compact(value))

export function renderCapital(host, data) {
  clear(host)
  const { totals, venues, assets, pools, supplyCheck, positions, meta } = data

  append(
    host,
    // The chart first, and deliberately first: decision 0011 — a page opens on the thing its
    // title names, and the title names the assets.
    assetCard(assets, totals),
    statRow([
      statTile('Held here, counted once', dash(totals.netUsd), 'across all four venues, after both deductions', { hero: true }),
      statTile('Added up naively', dash(totals.grossUsd), `${pct(totals.derivedShare)} of it is one venue holding another’s receipt`),
      statTile('Lent back out', dash(totals.loopedUsd), 'money-market deposits borrowed again; a re-deposit would count twice'),
      statTile(
        'Could not be priced',
        formatCount(totals.unpricedAssetCount),
        `${formatCount(totals.unpricedPositions)} of ${formatCount(totals.positions)} positions — value unknown, not zero`,
      ),
    ]),
    venueCard(venues, totals),
    supplyCard(supplyCheck, totals),
    poolCard(pools, totals),
    totals.unattributed.length ? unattributedNotice(totals) : null,
    positionTable(positions),
    notesSection(data, meta),
  )
}

/* ══════════════════════════════════════════════════════════════════ capital by asset ═════ */

function assetCard(assets, totals) {
  const drawn = assets.filter((asset) => asset.usd !== null && asset.usd > 0)
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'What the money is in' }),
      el('p.note', {
        text:
          `Every position in all four venues, resolved to the base asset behind it — an aDOT in the Omnipool is ` +
          `DOT in the money market, not a second DOT. ${formatCount(drawn.length)} assets carry value. Bars are ` +
          `linear from zero, and every figure here is the COUNTED one: where the money market has lent an asset ` +
          `back out, that part is not in the bar, because a borrower who re-deposits it would be counted twice. ` +
          `Hover a row for the gross figure and what was removed.`,
      }),
    ),
  )

  // ONE series, deliberately. An earlier draft drew the borrowed leg as a second segment, which
  // put a GROSS figure at the right-hand end of every bar while the page's headline is net —
  // and a reader adding up the column would have got a number the page does not claim. The loop
  // is a money-market phenomenon and it is drawn where it belongs, on the venue chart below.
  const series = [{ label: 'counted once, across every venue' }]
  const rows = drawn.map((asset) => ({
    label: asset.label,
    sublabel: `${units(asset.amount)} · ${asset.venues.join(' + ')}`,
    total: asset.usd,
    segments: [asset.usd],
    note:
      (asset.borrowedUsd
        ? `gross ${money(asset.grossUsd)}, of which ${money(asset.borrowedUsd)} is lent back out and not counted. `
        : '') + (asset.via ? `priced by: ${asset.via}` : 'no price'),
  }))

  const plot = el('div')
  append(card, plot)
  segmentedRows(plot, { rows, series, format: money })
  append(
    card,
    segmentedLegend(series, [totals.netUsd], money),
    el('p.note', {
      text:
        `These sum to ${dash(totals.byAssetTotalUsd)}, against a headline of ${dash(totals.netUsd)} — a residual of ` +
        `${dash(totals.byAssetResidualUsd)}. That equality is the reconciliation: the venue view and the asset view ` +
        `are built from the same positions by two different routes, and if a receipt token were being counted twice ` +
        `they would not agree.`,
    }),
  )
  return card
}

/* ═══════════════════════════════════════════════════════════════════ capital by venue ═════ */

function venueCard(venues, totals) {
  const series = [
    { label: 'counted once' },
    { label: 'a receipt for another venue’s money' },
    { label: 'lent back out' },
  ]
  const rows = venues.map((venue) => ({
    label: venue.venue,
    sublabel:
      `${formatCount(venue.positions)} positions` +
      (venue.unpricedPositions ? `, ${formatCount(venue.unpricedPositions)} unpriced` : ''),
    total: venue.grossUsd,
    segments: [venue.netUsd, venue.derivedUsd, venue.borrowedUsd],
    note: `gross ${money(venue.grossUsd)}, counted ${money(venue.netUsd)}`,
  }))

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Where it sits, and what each venue’s own figure includes' }),
      el('p.note', {
        text:
          `Each bar is what that venue reports about itself. The two pale segments are what has to come out before ` +
          `the four can be added: a claim on another venue, and money lent back out of the money market. ` +
          `${dash(totals.derivedUsd)} and ${dash(totals.loopedUsd)} respectively.`,
      }),
    ),
  )
  const plot = el('div')
  append(card, plot)
  segmentedRows(plot, { rows, series, format: money })
  append(
    card,
    segmentedLegend(series, [totals.netUsd, totals.derivedUsd, totals.loopedUsd], money),
    el('p.note', {
      text:
        `The money market’s own page (/hydration-market/) reports its supplied total and deliberately publishes no ` +
        `combined Hydration figure, because doing that correctly needs the other three venues read at the same ` +
        `instant. This is that number.`,
    }),
  )
  return card
}

/* ══════════════════════════════════════════════════════ the check that set the headline ═════ */

function supplyCard(rows, totals) {
  const check = totals.supplyCheck
  const shown = (rows ?? []).filter((row) => row.grossShare >= 0.05).slice(0, 14)
  const tone = check.overAtNet === 0 ? 'good' : 'critical'

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'The check that decided the headline' }),
      el('p.note', {
        text:
          `The venues cannot hold more of a token than the chain has of it. Each asset below is compared against ` +
          `\`Tokens::TotalIssuance\` — the whole chain’s supply — twice: once at the gross figure and once after ` +
          `netting out what the money market has lent. ` +
          `At gross, ${formatCount(check.overAtGross)} of ${formatCount(check.checked)} assets are over their own ` +
          `supply. After netting, ${check.overAtNet === 0 ? 'none are' : `${formatCount(check.overAtNet)} still are`}. ` +
          `That is why the headline nets, and it is a measurement rather than a preference.`,
      }),
    ),
    el(
      'div.notice',
      { data: { tone } },
      el('span.tag', { text: check.overAtNet === 0 ? 'reconciled' : 'unreconciled' }),
      el(
        'div',
        null,
        el('strong', {
          text:
            check.overAtNet === 0
              ? `Every one of the ${formatCount(check.checked)} checkable assets is now under its chain-wide supply.`
              : `${formatCount(check.overAtNet)} assets still exceed their chain-wide supply after netting.`,
        }),
        el('p', {
          text:
            check.worstAtGross.length
              ? `Worst at gross: ${check.worstAtGross
                  .map((row) => `${row.label} at ${pct(row.grossShare, 0)} of supply`)
                  .join(', ')}. Each falls below 100 % once the borrowed leg is removed.`
              : 'Nothing exceeded its supply even at gross.',
        }),
      ),
    ),
  )

  const table = el(
    'table.data',
    null,
    el(
      'thead',
      null,
      el(
        'tr',
        null,
        el('th', { text: 'Asset' }),
        el('th.num', { text: 'Chain supply' }),
        el('th.num', { text: 'In venues, gross' }),
        el('th.num', { text: 'of supply' }),
        el('th.num', { text: 'In venues, counted' }),
        el('th.num', { text: 'of supply' }),
      ),
    ),
    el(
      'tbody',
      null,
      ...shown.map((row) =>
        el(
          'tr',
          null,
          el('td', { text: row.label }),
          el('td.num', { text: units(row.supply) }),
          el('td.num', { text: units(row.heldGross) }),
          el('td.num', { text: pct(row.grossShare, 0) }),
          el('td.num', { text: units(row.heldNet) }),
          el('td.num', { text: pct(row.netShare, 0) }),
        ),
      ),
    ),
  )
  append(
    card,
    el('div.tablewrap', null, table),
    el('p.note', {
      text:
        `\`Erc20\`-typed assets are left out of this check: their orml row is a mirror residue rather than a supply. ` +
        `HOLLAR’s reads about 13,600 against a real supply near 12.6 M, so scoring it would produce a spectacular ` +
        `and meaningless failure. Rows under 5 % of supply are omitted here and are all in the payload.`,
    }),
  )
  return card
}

/* ═══════════════════════════════════════════════ the stableswap pools, read two ways ═════ */

function poolCard(pools, totals) {
  const withCheck = pools.filter((pool) => pool.viaSharesUsd !== null)
  const clean = withCheck.filter((pool) => !pool.unpriced.length)
  const worst = clean.reduce((max, pool) => Math.max(max, Math.abs(pool.gapPercent ?? 0)), 0)

  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Every stableswap pool, read two independent ways' }),
      el('p.note', {
        text:
          `A pool’s value is the sum of what it holds. For the ${formatCount(withCheck.length)} pools whose share ` +
          `token the money market prices, it is also the share price times the shares in issue — a completely ` +
          `separate reading. Across the ${formatCount(clean.length)} pools where every leg could be priced the two ` +
          `disagree by at most ${percent(worst, 2)}. That agreement is what makes the second reading trustworthy ` +
          `where a leg CANNOT be priced: there the difference is that leg’s value, and its implied unit price falls ` +
          `out of it. ${dash(totals.residualUsd)} of the total is recovered this way.`,
      }),
    ),
  )

  const table = el(
    'table.data',
    null,
    el(
      'thead',
      null,
      el(
        'tr',
        null,
        el('th', { text: 'Pool' }),
        el('th', { text: 'Holds' }),
        el('th.num', { text: 'Sum of legs' }),
        el('th.num', { text: 'Share price × shares' }),
        el('th.num', { text: 'Difference' }),
        el('th', { text: 'What the difference is' }),
      ),
    ),
    el(
      'tbody',
      null,
      ...pools.map((pool) =>
        el(
          'tr',
          null,
          el('td', { text: pool.symbol }),
          el('td', { text: pool.members.map((member) => member.symbol).join(' + ') }),
          el('td.num', { text: dash(pool.legSumUsd) }),
          el('td.num', { text: pool.viaSharesUsd === null ? 'no share price' : money(pool.viaSharesUsd) }),
          el('td.num', { text: pool.gapPercent === null ? '—' : percent(pool.gapPercent, 2) }),
          el('td', {
            text: !pool.unpriced.length
              ? pool.viaSharesUsd === null
                ? 'not cross-checkable'
                : 'agreement — both legs priced'
              : pool.unpriced
                  .map(
                    (leg) =>
                      `${leg.symbol} ${units(leg.amount)}` +
                      (leg.impliedPrice ? ` → $${leg.impliedPrice} each` : ' (cannot be split)'),
                  )
                  .join(', '),
          }),
        ),
      ),
    ),
  )
  append(card, el('div.tablewrap', null, table))
  return card
}

function unattributedNotice(totals) {
  const total = totals.unattributed.reduce((sum, entry) => sum + entry.usd, 0)
  return notice(
    'warning',
    `${money(total)} is in a pool but cannot be attributed to an asset, and is in none of the figures above`,
    totals.unattributed
      .map((entry) => `${entry.pool} is worth ${money(entry.usd)} more than its priceable legs, and has ${entry.legs.length} unpriced legs (${entry.legs.join(', ')}) rather than one — so the difference cannot be split between them without assuming both sit at parity, which is the very thing a stableswap pool is designed to make plausible and does not guarantee.`)
      .join(' '),
    'Every other headline number on this page is therefore a floor by at least this much.',
  )
}

/* ═════════════════════════════════════════════════════════════════ the audit trail ═════ */

function positionTable(positions) {
  const rows = positions.slice(0, 260)
  return el(
    'details.data-table',
    null,
    el('summary', {
      text: `Every position — ${formatCount(positions.length)} of them, ${formatCount(rows.length)} shown`,
    }),
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
            el('th', { text: 'Venue' }),
            el('th', { text: 'Where' }),
            el('th', { text: 'Asset' }),
            el('th.num', { text: 'Amount' }),
            el('th.num', { text: 'Value' }),
            el('th', { text: 'Counted?' }),
            el('th', { text: 'Priced by' }),
          ),
        ),
        el(
          'tbody',
          null,
          ...rows.map((position) =>
            el(
              'tr',
              null,
              el('td', { text: position.venue }),
              el('td', { text: position.pool ?? '—' }),
              el('td', { text: position.label }),
              el('td.num', { text: units(position.amount) }),
              el('td.num', { text: position.usd === null ? 'unpriced' : money(position.usd) }),
              el('td', { text: position.derived ? `no — ${position.derived}` : 'yes' }),
              el('td', { text: position.via ?? '—' }),
            ),
          ),
        ),
      ),
    ),
  )
}

/* ═════════════════════════════════════════════════════════════════════ data notes ═════ */

function notesSection(data, meta) {
  const { totals } = data
  const notes = []

  notes.push(
    `Nothing here is a single confident number. ${dash(totals.grossUsd)} is what the four venues say about ` +
      `themselves added together. ${dash(totals.derivedUsd)} of that is one venue holding another’s receipt token, ` +
      `and ${dash(totals.loopedUsd)} is money-market deposits already lent back out. ${dash(totals.netUsd)} is what ` +
      `is left, and it is the figure the page leads with.`,
  )
  notes.push(
    `An asset is treated as a receipt — and so not counted where it is held — when its contract answers ` +
      `\`UNDERLYING_ASSET_ADDRESS()\` (an aToken) or \`asset()\` (an ERC-4626 vault), or when the registry types it ` +
      `\`StableSwap\` or \`XYK\`. All four tests come from the chain, never from the symbol, and that matters here: ` +
      `\`GDOT\` is the aToken of the stableswap pool \`2-Pool-GDOT\`, and \`GETH\` is the aToken of \`2-Pool-GETH\`, ` +
      `whose own reserves are aETH — itself the aToken of ETH. No name-based filter catches those.`,
  )
  notes.push(
    `An aToken is exactly 1:1 with its underlying — verified across every DOT↔aDOT conversion in a 24-hour window, ` +
      `deviation zero. An ERC-4626 vault share is NOT: \`uBIL\` is worth 1.0099 HOLLAR today, and the two look ` +
      `identical in the registry. The ratio is read from \`convertToAssets\` rather than assumed.`,
  )
  notes.push(
    `Prices come only from chains (decision 0008). In order: the money-market oracle at ${meta.priceOracle}, ` +
      `divided by its own \`BASE_CURRENCY_UNIT\` of ${formatCount(meta.baseCurrencyUnit)}; then a receipt token’s ` +
      `underlying; then the Omnipool’s implied spot for assets the oracle has no opinion about; then, for a pool ` +
      `with exactly one unpriced leg, that leg’s value as the difference between the pool’s two readings. The ` +
      `oracle is discovered by traversal from \`aDOT.POOL()\`, never hardcoded, and it is a stepped feed — about ` +
      `eighteen updates a day — so it can lag a fast move by up to an hour.`,
  )
  notes.push(
    `${formatCount(totals.unpricedPositions)} of ${formatCount(totals.positions)} positions could not be priced at ` +
      `all, spanning ${formatCount(totals.unpricedAssetCount)} assets. They contribute \`null\`, never zero, so every ` +
      `figure above is a floor. Almost all of them are the XYK long tail: ` +
      `${formatCount(totals.xykPoolsWithNoPricedLeg)} of the ${formatCount(totals.xykPools)} XYK pools have no ` +
      `priced leg at all. The whole XYK layer contributes ${dash(data.venues.find((v) => v.venue === 'XYK')?.grossUsd ?? null)} ` +
      `on its priced side, and an XYK pool’s two legs are worth roughly the same, so what is missing there is small ` +
      `— but it is unmeasured, not zero.`,
  )
  notes.push(
    `The money market has ${dash(totals.borrowedUsd)} outstanding in total, of which only ${dash(totals.loopedUsd)} ` +
      `is deducted above. The difference is HOLLAR, which the market MINTS as debt rather than lending out of ` +
      `deposits — its supplied balance is zero, so there is nothing to deduct it from. The HOLLAR itself is counted ` +
      `where it sits, in the pools.`,
  )
  notes.push(
    `Seven registry assets are called USDC or USDT. Every asset on this page carries its registry id for that ` +
      `reason, and nothing is ever summed by ticker.`,
  )
  notes.push(
    `What is NOT here: ordinary wallets, the treasury, staking outside the GIGAHDX market, OTC orders and bonds. ` +
      `This is capital inside the four trading and lending venues, not everything on the chain.`,
  )
  notes.push(
    `stHDX is staked HDX and the oracle does not price it. It is valued at HDX’s Omnipool spot, which is a FLOOR — ` +
      `a staking receipt is worth at least one unit of what it wraps and generally more. It is the largest single ` +
      `asset on the page, so that floor matters.`,
  )

  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text:
        `Read from Hydration’s public RPC across both planes — Substrate \`state_*\` for the registry and the pool ` +
        `reserves, EVM \`eth_*\` for the money market and the ERC-20 balances — at block ` +
        `${formatCount(meta.headBlock)}, ${formatUtc(Date.parse(data.fetchedAt))}, in ${formatCount(data.elapsedMs)} ms. ` +
        `The server caches it for five minutes so a visitor never fans out to the node.`,
    }),
    el('ul', null, ...notes.map((note) => el('li', { text: note }))),
    livenessNotes(meta.liveness),
    el('p', {
      text:
        `Pool accounts are computed, never hardcoded: a stableswap pool’s reserves live at ` +
        `\`blake2_256("sts" ‖ u32le(poolId))\`, and an XYK pool’s key IS its account. Balances are read on three ` +
        `paths — orml, \`System::Account\` for HDX, and EVM \`balanceOf\` for \`Erc20\` assets — because a ` +
        `Substrate-only sweep returns null for the largest positions rather than erroring. ` +
        `Full derivation, evidence and grades: docs/platform/hydration-capital.md.`,
    }),
  )
}
