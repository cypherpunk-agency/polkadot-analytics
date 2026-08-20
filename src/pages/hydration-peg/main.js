// Hydration's pegs, the HOLLAR stability module, and the OTC book.
//
// Three readings that belong together because they are the same question asked three ways:
// **what does this venue currently believe things are worth, and who is on the hook for that
// belief being right?**
//
//   · A PEG-AWARE STABLESWAP POOL carries a ratio saying how many units of one asset equal one
//     of another — vDOT against DOT, wstETH against ETH, sUSDe against a dollar. That ratio is
//     a claim, fed by an oracle, and it is only as good as the last time something updated it.
//     So the age of each peg is on this page in BLOCKS, next to the peg itself.
//   · THE HSM is the module that defends HOLLAR's peg. Its configured band is a protocol fact
//     worth publishing on its own: the chain says the buy-back coefficient is 0.998 and the
//     purchase fee is exactly zero, while Hydration's own published documentation says 0.995.
//     Correcting a protocol's documentation with a live reading is what a page like this is for.
//   · THE OTC BOOK is a public orderbook. It is rendered as one: what is resting, in what size,
//     at what ratio the maker is asking. No comparison against pool prices, no flag saying a
//     row is worth taking, no sizing.
//
// ── the one number here with an external anchor, and why that matters ───────────────────────
// Everything else on this page is Hydration talking about itself, which cannot be checked from
// inside. The vDOT peg can: Bifrost issues vDOT and publishes what it redeems for. Comparing
// the two is an oracle-health measurement — and this site can only take ONE reading of it,
// which the page says plainly, because the interesting form of that measurement is a time
// series and there is no store behind this yet. The research this page came from found 112 bps
// of lag on one day and none forty days later. A single sample cannot distinguish those.
//
// ── what is deliberately absent ─────────────────────────────────────────────────────────────
// No "this one is executable" flag, no takeable size, no per-block remaining buy-back capacity.
// A number describing a state is analytics; the same number with a size and a countdown beside
// it is an instruction, and this is a public page with no idea who is reading it.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { compact, formatCount, percent, shortAddr } from '../../core/format.js'

const dash = '—'
const named = (symbol, id) => (id === null || id === undefined ? symbol ?? dash : `${symbol ?? 'asset'} · ${id}`)
const bps = (value, digits = 2) => (value === null || value === undefined ? dash : `${value >= 0 ? '+' : ''}${value.toFixed(digits)} bps`)
const ratio = (value, digits = 6) => (value === null || value === undefined ? dash : value.toFixed(digits))

function render(host, data) {
  clear(host)

  if (data.empty) {
    append(host, notice('warning', 'No stableswap pools were returned', 'The chain answered and its pool map is empty. That is the reading, not a failure to read.'))
    return
  }

  const { chain, hsm, pools, vdot, otc, notes } = data
  const pegged = pools.filter((pool) => pool.pegged)

  append(
    host,
    statRow([
      statTile('vDOT peg vs the issuer', bps(vdot.gapBps, 3), vdot.gapBps === null ? 'not measurable right now' : 'one reading, no history behind it', { hero: true }),
      statTile('Peg-aware pools', `${pegged.length} / ${pools.length}`, 'the rest have no peg concept at all'),
      statTile('HSM collaterals', formatCount(hsm.collaterals.length), hsm.collaterals.map((c) => c.symbol ?? `asset ${c.assetId}`).join(', ') || 'none'),
      statTile('Open OTC orders', formatCount(otc.count), `${otc.partiallyFillable} partially fillable`),
    ]),

    vdotCard(vdot, chain),
    stalenessCard(pegged, chain),
    pegTableCard(pools),
    hsmCard(hsm),
    otcCard(otc),
    notesSection(notes, chain),
  )
}

/* ───────────────────────────────────────────────────────── vDOT: the oracle vs the issuer ── */

function vdotCard(vdot, chain) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'vDOT: what the pool believes, against what the issuer says' }),
      el('p.note', {
        text:
          'Pool 690 pairs vDOT with aDOT and carries a peg saying how much DOT one vDOT is worth. Bifrost issues vDOT and publishes the same number from its own books. A gap between them is a stale oracle, and an oracle that lags on a liquid-staking derivative is a risk fact — it prices a redemption that is not available at that price.',
      }),
    ),
    statRow([
      statTile('On-chain peg', ratio(vdot.oraclePeg), `recorded ${vdot.blocksAgo === null ? dash : `${formatCount(vdot.blocksAgo)} blocks ago`}`),
      statTile('Bifrost’s own rate', ratio(vdot.trueRate), vdot.bifrost ? `from ${compact(vdot.bifrost.tvm)} DOT against ${compact(vdot.bifrost.totalIssuance)} vDOT` : 'unavailable'),
      statTile('Gap', bps(vdot.gapBps, 3), 'peg minus issuer, as a share of the issuer’s rate'),
      statTile('Bifrost staking APY', vdot.bifrost?.apy === null || vdot.bifrost?.apy === undefined ? dash : percent(vdot.bifrost.apy, 2), 'the issuer’s own figure, not an on-chain read'),
    ]),
  )

  if (vdot.oracleSource) {
    append(
      card,
      el('p.note', {
        text:
          vdot.oracleSource.kind === 'MMOracle'
            ? `The peg is fed by a money-market oracle contract at ${vdot.oracleSource.address}. That address is read from the pool's own peg record, not assumed.`
            : `The peg for this leg is a fixed value of ${vdot.oracleSource.numerator}/${vdot.oracleSource.denominator} written into the pool, not an oracle feed.`,
      }),
    )
  }

  append(
    card,
    vdot.bifrostError
      ? notice(
          'warning',
          'The gap cannot be measured right now',
          vdot.bifrostError,
          'The on-chain peg above is still a real reading. The gap is blank rather than zero: falling back to the on-chain number would make this monitor agree with itself by construction, which is the one failure mode a monitor must not have.',
        )
      : notice(
          'info',
          'This is one sample, and one sample cannot tell you whether a lag is normal',
          'The research behind this page measured 112 bps of lag on 2026-07-10 and about none on 2026-08-19 — same oracle, same mechanism, opposite conclusions. The mechanism is real and worth watching; the reading is a moment. What answers the question is a time series, and this site does not keep one yet.',
          'Bifrost’s figure is also Bifrost’s: it is the implied rate from its own public site aggregate (DOT under management divided by vDOT issued), not a decode of its chain storage. It is an external anchor, not an independent one.',
        ),
  )

  append(card, el('p.note', { text: `Read at block ${formatCount(chain.block)}.` }))
  return card
}

/* ────────────────────────────────────────────────────────────────────────── peg staleness ── */

/**
 * How long ago each peg record was written, in blocks. Linear from zero, because the whole
 * point is that one of these is orders of magnitude older than the rest and a log scale would
 * flatten exactly that.
 */
function stalenessCard(pegged, chain) {
  if (!pegged.length) return null
  const sorted = [...pegged].sort((a, b) => (b.pegBlocksAgo ?? 0) - (a.pegBlocksAgo ?? 0))
  const max = Math.max(...sorted.map((pool) => pool.pegBlocksAgo ?? 0), 1)

  const rows = el('div.rows')
  for (const pool of sorted) {
    const age = pool.pegBlocksAgo ?? 0
    append(
      rows,
      el(
        'div.row',
        null,
        el('div.name', { text: `${pool.label ?? 'pool'} · ${pool.id}` }),
        el('div.track', null, el('div.fill', { style: `width:${Math.max(0.5, (age / max) * 100)}%` })),
        el('div.amt', null, document.createTextNode(formatCount(age)), el('span.cnt', { text: ' blocks ago' })),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'How old is each peg' }),
      el('p.note', {
        text:
          'The block at which each pool’s peg record was last written, counted back from the head. Blocks, not hours: the block interval on Hydration is a trailing average that has moved from 6.9 s to 5.6 s inside a year, so converting would add an estimate to an exact number. A stale peg is not a wrong peg — it is a peg that nothing has needed to move.',
      }),
    ),
    rows,
    el('p.note', { text: `Head is block ${formatCount(chain.block)}.` }),
  )
}

/* ─────────────────────────────────────────────────────────────────────────── the peg book ── */

function pegTableCard(pools) {
  const body = el('tbody')
  for (const pool of pools) {
    // The id is not decoration: two registered assets share the ticker USDT, and a pool that
    // listed both as "USDT" would read as a pool of one asset against itself.
    const legs = pool.assets
      .map((asset) => {
        const label = `${asset.symbol ?? 'asset'} #${asset.id}`
        return asset.peg && asset.peg.ratio !== null ? `${label} ×${asset.peg.ratio.toFixed(6)}` : label
      })
      .join('  /  ')
    append(
      body,
      el(
        'tr',
        null,
        el('td.num', { text: String(pool.id) }),
        el('td.mono', { text: pool.label ?? dash }),
        el('td', { text: legs }),
        el('td.num', { text: percent(pool.feePercent, 3) }),
        el('td.num', { text: formatCount(pool.amplification) }),
        el('td', { text: pool.ramping ? `ramping from ${formatCount(pool.initialAmplification)}, ends at block ${formatCount(pool.rampEndsAtBlock)}` : 'settled' }),
        el('td.num', { text: pool.pegBlocksAgo === null ? dash : formatCount(pool.pegBlocksAgo) }),
        el('td.num', { text: pool.maxPegUpdatePercent === null ? dash : percent(pool.maxPegUpdatePercent, 4) }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Every stableswap pool, and what it is pegged to' }),
      el('p.note', {
        text:
          'The full pool topology: which assets each pool joins, its fee, its amplification and whether that amplification is still ramping. Where a pool carries a peg record, each leg shows the ratio the pool currently applies to it. A blank peg means the pool has no peg record at all — not that its assets trade at par.',
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
            el('th.num', { text: 'Pool' }),
            el('th', { text: 'Share token' }),
            el('th', { text: 'Assets, with their current peg' }),
            el('th.num', { text: 'Fee' }),
            el('th.num', { text: 'Amp' }),
            el('th', { text: 'Amp state' }),
            el('th.num', { text: 'Peg age (blocks)' }),
            el('th.num', { text: 'Max peg move' }),
          ),
        ),
        body,
      ),
    ),
  )
}

/* ────────────────────────────────────────────────────────────────────────────────── HSM ── */

function hsmCard(hsm) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'How HOLLAR’s peg is configured to be defended' }),
      el('p.note', {
        text:
          'The HOLLAR Stability Module mints HOLLAR against collateral and buys it back. These are its CONFIGURED parameters — what governance has set it up to do. Nothing here is a live capacity reading: whether the module has room to act at this instant is a different number, and publishing it on an open page would announce, in real time, that a stablecoin’s defence is momentarily out of ammunition.',
      }),
    ),
  )

  if (!hsm.collaterals.length) {
    append(card, notice('warning', 'The HSM has no collateral configured', 'The map is empty on chain right now. That is the reading.'))
    return card
  }

  const body = el('tbody')
  for (const collateral of hsm.collaterals) {
    append(
      body,
      el(
        'tr',
        null,
        el('td.mono', { text: named(collateral.symbol, collateral.assetId) }),
        el('td.num', { text: String(collateral.poolId) }),
        el('td.num', { text: percent(collateral.purchaseFee * 100, 4) }),
        el('td.num', { text: collateral.maxBuyPriceCoefficient.toFixed(4) }),
        el('td.num', { text: percent(collateral.buybackRate * 100, 4) }),
        el('td.num', { text: percent(collateral.buyBackFee * 100, 4) }),
        el('td.num', { text: collateral.maxInHolding === null ? 'no limit' : compact(collateral.maxInHolding) }),
      ),
    )
  }

  append(
    card,
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
            el('th', { text: 'Collateral' }),
            el('th.num', { text: 'Pool' }),
            el('th.num', { text: 'Purchase fee' }),
            el('th.num', { text: 'Buy-back coefficient' }),
            el('th.num', { text: 'Buy-back rate' }),
            el('th.num', { text: 'Buy-back fee' }),
            el('th.num', { text: 'Max holding' }),
          ),
        ),
        body,
      ),
    ),
    notice(
      'info',
      'The chain and the documentation disagree, and the chain wins',
      `Hydration’s published documentation puts the buy-back price coefficient at 0.995. Every collateral configured on chain right now reads ${[...new Set(hsm.collaterals.map((c) => c.maxBuyPriceCoefficient.toFixed(3)))].join(' / ')}. The purchase fee is exactly zero, so the module’s sell side carries no fee at all.`,
      'The collateral set itself is read from storage on every refresh and never hardcoded. It was four assets in July 2026 and is two now — anything carrying a fixed list would have rendered a subset of the truth without any sign that it had.',
    ),
    el('p.note', {
      text: `Flash minter contract: ${hsm.flashMinter ?? dash}. \`HollarAmountReceived\` currently holds ${formatCount(hsm.hollarAmountReceivedEntries)} entries — that item is reset in \`on_finalize\`, so an RPC read always lands on a block boundary and finds it empty. A time series of it would be a flat line of zeros and would mean nothing.`,
    }),
  )
  return card
}

/* ────────────────────────────────────────────────────────────────────────────── OTC book ── */

function otcCard(otc) {
  if (!otc.count) {
    return el(
      'section.card',
      null,
      el('header', null, el('h2', { text: 'The OTC book' })),
      notice('info', 'Nothing is resting on the OTC book', 'The order map is empty right now.'),
    )
  }

  const body = el('tbody')
  for (const order of otc.orders) {
    append(
      body,
      el(
        'tr',
        null,
        el('td.num', { text: String(order.id) }),
        el('td.mono', { text: order.isPallet ? order.owner : shortAddr(order.owner ?? order.ownerHex, 8, 6), title: order.owner ?? order.ownerHex }),
        el('td.mono', { text: named(order.symbolIn, order.assetIn) }),
        el('td.num', { text: order.amountIn === null ? dash : compact(order.amountIn) }),
        el('td.mono', { text: named(order.symbolOut, order.assetOut) }),
        el('td.num', { text: order.amountOut === null ? dash : compact(order.amountOut) }),
        el('td.num', { text: order.price === null ? dash : order.price.toPrecision(6) }),
        el('td', { text: order.partiallyFillable ? 'partial ok' : 'all or nothing' }),
      ),
    )
  }

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'The OTC book' }),
      el('p.note', {
        text:
          'Every open order in the OTC pallet, as it stands in storage. The amounts are the order’s current ones: for a partially fillable order the pallet works them down as it fills, so what is shown is a residue and the size it was opened at is not recorded anywhere in this map. The "asks" column is the maker’s own out-over-in ratio and nothing else — it is not compared against any pool, and no row here is marked as worth taking.',
      }),
    ),
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
            el('th.num', { text: '#' }),
            el('th', { text: 'Maker' }),
            el('th', { text: 'Offers' }),
            el('th.num', { text: 'Amount' }),
            el('th', { text: 'Wants' }),
            el('th.num', { text: 'Amount' }),
            el('th.num', { text: 'Asks' }),
            el('th', { text: 'Fill' }),
          ),
        ),
        body,
      ),
    ),
    otc.unpricedAssets.length
      ? el('p.note', {
          text: `${otc.unpricedOrders} order${otc.unpricedOrders === 1 ? '' : 's'} show${otc.unpricedOrders === 1 ? 's' : ''} no amount: ${otc.unpricedAssets.length} of the assets on this book have no decimals recorded in the asset registry (${otc.unpricedAssets
            .map((asset) => `${asset.id}${asset.type ? ` · ${asset.type}` : ''}`)
            .join(', ')}), and an amount without its decimals is wrong by a power of ten while looking entirely reasonable.`,
        })
      : null,
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
        'Every storage key on this page is computed from its pallet and item name, and every structure is decoded to exactly its own length — leftover bytes throw rather than yielding a plausible number with the wrong meaning. Two of the peg record’s fields are named by inference from their values rather than read from runtime metadata, and the page says which.',
    }),
    el('p', {
      text:
        'The interesting version of every table here is the one with a time axis: how often the vDOT oracle lags, how long a peg record usually goes unwritten, whether the HSM band has ever moved. All three need a persistent store this site does not have yet, so what is published is a sample and is labelled as one.',
    }),
  )
}

renderPage({
  page: pageByKey('hydration-peg'),
  intro:
    'A peg is a claim, and a claim has an age. This is every peg-aware stableswap pool on Hydration with the ratio it currently applies and how many blocks ago that ratio was last written; the vDOT peg checked against Bifrost, which is the one number here with an anchor outside Hydration; the configured band the HOLLAR stability module defends; and the open OTC book.',
  load: () => read('arbs-hydration', 'peg-state'),
  render,
})
