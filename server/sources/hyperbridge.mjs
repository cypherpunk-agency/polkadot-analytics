// The Hyperbridge nexus indexer — the source behind the HyperFX volume dashboard and its
// order-level drill-down.
//
// HyperFX (https://app.hyperfx.finance) has no volume API of its own; its history page fetches
// every intent order from this indexer and totals them in the browser. We read the same thing,
// server-side, once per TTL, instead of once per visitor.
//
// ⚠️ THE NUMBER HERE IS NOT THE NUMBER ON THEIR HOMEPAGE, and that is deliberate. HyperFX's
// headline "TOTAL VOLUME" derives from cumulative protocol dust collected × 2,000. This source
// sums the actual orders. The two disagree; the page says so rather than quietly picking one —
// and `dustHeadline()` below reconstructs THEIR figure from the same rows so the page can
// print both numbers side by side instead of asserting one is wrong.
//
// Two operations:
//
//   `swaps`  — every order ever placed, valued and rolled up into the canonical swap aggregate.
//   `orders` — the drill-down: individual orders, FILTERED SERVER-SIDE by the indexer, with
//              fills, the status timeline, implied rates and per-order fees.
//
// Both read one shared in-module snapshot (`history()`), so a visitor who lands on the
// dashboard and then drills down costs the indexer nothing extra.

import { graphql } from '../lib/upstream.mjs'
import { deriveRates } from '../../src/core/pricing.js'
import { aggregate, trimForWire, dayOf } from '../../src/core/swaps.js'

const URL = 'https://nexus.indexer.polytope.technology/'
const PAGE = 200

/** How long the full-history snapshot is reused. Both operations share it. */
const HISTORY_TTL_MS = 300_000
/** The registry/health self-check moves far more slowly than the orders do. */
const CHECKS_TTL_MS = 900_000

// totalCount comes back on every page, so the first response says how many more to ask for.
// Ordering ascending keeps paging stable while new orders land at the end.
const ORDERS = `
query Orders($first: Int!, $offset: Int!) {
  iOrderV3s(first: $first, offset: $offset, orderBy: BLOCK_TIMESTAMP_ASC) {
    totalCount
    nodes {
      id
      user
      status
      referrer
      fees
      inputUSD
      sourceChain
      destChain
      blockTimestamp
      inputAssets { nodes { token amount } }
      outputAssets { nodes { token amount } }
    }
  }
}`

// The drill-down query. `$filter` is a TYPED variable, never string-built: the filter object is
// assembled from parameters this module has already validated against `schema`, and travels as
// JSON. Nothing a caller sends is ever concatenated into a query document.
const ROWS = `
query Rows($first: Int!, $offset: Int!, $filter: IOrderV3Filter) {
  iOrderV3s(first: $first, offset: $offset, filter: $filter, orderBy: BLOCK_TIMESTAMP_DESC) {
    totalCount
    nodes {
      id
      user
      status
      referrer
      fees
      inputUSD
      sourceChain
      destChain
      blockTimestamp
      transactionHash
      inputAssets { nodes { token amount } }
      outputAssets { nodes { token amount } }
      fills(first: 1, orderBy: TIMESTAMP_ASC) { totalCount nodes { chain filler timestamp transactionHash } }
      partialFills { totalCount }
      statusMetadata(orderBy: TIMESTAMP_ASC) { nodes { status chain timestamp transactionHash filler } }
      escrowReleases { totalCount }
      escrowRefunds { totalCount }
    }
  }
}`

// One address, two roles, two counts — free, and it is what makes the account header able to
// say "13 placed, 418 filled" rather than only describing the page in front of the reader.
const ROLES = `
query Roles($address: String!) {
  asTrader: iOrderV3s(filter: { user: { likeInsensitive: $address } }) { totalCount }
  asFiller: iOrderV3s(filter: { fills: { some: { filler: { likeInsensitive: $address } } } }) { totalCount }
}`

// The indexer's own view of itself: how far it has caught up on each chain, and the decimals
// it believes each token has. One request answers both. See `audit()`.
const CHECKS = `
{
  _metadatas { nodes { chain lastProcessedHeight targetHeight indexerHealthy } }
  intentGatewayTokenVolumes { nodes { chain tokenAddress tokenSymbol decimals } }
}`

export const CHAIN_NAMES = {
  'EVM-1': 'Ethereum',
  'EVM-56': 'BNB Chain',
  'EVM-137': 'Polygon',
  'EVM-8453': 'Base',
  'EVM-42161': 'Arbitrum',
}

/**
 * ⚠️ TWO NAMESPACES FOR ONE THING. An order says `sourceChain: "EVM-8453"`; the fill under it
 * says `chain: "8453"`. A joiner that assumes one form silently matches nothing — no error, an
 * empty column, and a fill that looks like it never happened.
 */
const CHAIN_BY_ID = Object.fromEntries(Object.keys(CHAIN_NAMES).map((c) => [c.slice(4), c]))
const chainKey = (value) => {
  const text = String(value ?? '')
  if (CHAIN_NAMES[text]) return text
  return CHAIN_BY_ID[text] ?? null
}
const chainName = (value) => CHAIN_NAMES[chainKey(value)] ?? String(value ?? '')

/**
 * Block explorers, one per chain. These are LINKS, not fetches — nothing on this site talks to
 * them, and the CSP would stop it if something tried. They live here because
 * `server/sources/` is the only place an absolute third-party URL is allowed, and they travel
 * to the browser inside the payload exactly as `meta.venueUrl` already does.
 *
 * All five are Etherscan-family and share the `/tx/<hash>` and `/address/<addr>` shape.
 */
const EXPLORERS = {
  'EVM-1': 'https://etherscan.io',
  'EVM-56': 'https://bscscan.com',
  'EVM-137': 'https://polygonscan.com',
  'EVM-8453': 'https://basescan.org',
  'EVM-42161': 'https://arbiscan.io',
}

const explorerUrl = (chain, kind, value) => {
  const base = EXPLORERS[chainKey(chain)]
  return base && value ? `${base}/${kind}/${value}` : null
}

// Token addresses and decimals, lifted from HyperFX's own chain config. The indexer sends
// addresses as 32-byte words, so we key on the low 40 hex characters.
//
// ⚠️ DECIMALS ARE PER CHAIN, NOT PER SYMBOL. USDC and USDT are 18 decimals on BNB Chain and 6
// everywhere else. Keying this table by symbol would be a silent factor-of-a-trillion on every
// BNB order — a wrong total that renders perfectly. `audit()` re-checks every row of this table
// against the indexer's own registry on every fetch, precisely because that error is invisible.
const TOKENS = {
  'EVM-1': {
    a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48: ['USDC', 6],
    dac17f958d2ee523a2206206994597c13d831ec7: ['USDT', 6],
    '17cdb2a01e7a34cbb3dd4b83260b05d0274c8dab': ['cNGN', 6],
  },
  'EVM-56': {
    '8ac76a51cc950d9822d68b83fe1ad97b32cd580d': ['USDC', 18],
    '55d398326f99059ff775485246999027b3197955': ['USDT', 18],
    a8aea66b361a8d53e8865c62d142167af28af058: ['cNGN', 6],
    '7c8c11adb8ef7cd3cfa718008ea048445c6e7209': ['EXT', 18],
  },
  'EVM-137': {
    '3c499c542cef5e3811e1192ce70d8cc03d5c3359': ['USDC', 6],
    c2132d05d31c914a87c6611c10748aeb04b58e8f: ['USDT', 6],
    '52828daa48c1a9a06f37500882b42daf0be04c3b': ['cNGN', 6],
  },
  'EVM-8453': {
    '833589fcd6edb6e08f4c7c32d4f71b54bda02913': ['USDC', 6],
    fde4c96c8593536e31f229ea8f37b2ada2699bb2: ['USDT', 6],
    '46c85152bfe9f96829aa94755d9f915f9b10ef5f': ['cNGN', 6],
    b755506531786c8ac63b756bab1ac387bacb0c04: ['ZARP', 18],
    '0e668e5127087e236578893a0e01e41837a28469': ['EXT', 18],
  },
  'EVM-42161': {
    af88d065e77c8cc2239327c5edb3a432268e5831: ['USDC', 6],
  },
}

const keyOf = (token) => String(token).toLowerCase().replace(/^0x/, '').slice(-40)

/* ------------------------------------------------------------------ the decimals audit ---- */

/**
 * Diff our hardcoded table against `intentGatewayTokenVolumes`, the indexer's own per-chain
 * token registry, and decide what each disagreement means. Same discipline as
 * `decodeAssetDetails` on Hydration: wrong decimals are a silent factor of 10ⁿ on every total,
 * so they are checked rather than trusted.
 *
 * Four outcomes, and they are NOT the same thing:
 *
 *   agree           — the usual case. Nothing to say.
 *   decimalsClash   — the dangerous one. We refuse to price that token at all rather than pick
 *                     a winner; the leg becomes `null` (unvalued) and the page says so. A
 *                     guess here is the factor-of-a-trillion error we exist to avoid.
 *   symbolClash     — cosmetic, and reported. The registry calls Polygon's USDT `USDT0`; the
 *                     decimals agree, so the arithmetic is unaffected. We keep our label
 *                     because `USDT0` is not in `USD_PEGGED` and renaming it would stop it
 *                     being held at $1.
 *   adopted         — a token the registry knows and our table does not. We take the registry's
 *                     symbol and decimals rather than valuing it at nothing, and name it in the
 *                     data notes so somebody backfills the table.
 */
function audit(registryNodes) {
  const agree = []
  const decimalsClash = []
  const symbolClash = []
  const adopted = []
  const seen = new Set()

  for (const node of registryNodes ?? []) {
    const chain = chainKey(node.chain)
    if (!chain) continue // the indexer covers 13 chains; HyperFX orders live on five
    const key = keyOf(node.tokenAddress)
    const decimals = Number(node.decimals)
    if (!Number.isInteger(decimals)) continue
    const id = `${chain}|${key}`
    if (seen.has(id)) continue // the registry has one row per (token, volumeType)
    seen.add(id)

    const ours = (TOKENS[chain] || {})[key]
    if (!ours) {
      adopted.push({ chain, key, symbol: String(node.tokenSymbol ?? '?'), decimals })
      continue
    }
    if (ours[1] !== decimals) {
      decimalsClash.push({ chain, key, ourSymbol: ours[0], ourDecimals: ours[1], theirDecimals: decimals })
      continue
    }
    if (ours[0] !== node.tokenSymbol) {
      symbolClash.push({ chain, key, ourSymbol: ours[0], theirSymbol: String(node.tokenSymbol ?? '?'), decimals })
    }
    agree.push(id)
  }

  const onlyOurs = []
  for (const [chain, table] of Object.entries(TOKENS)) {
    for (const [key, [symbol]] of Object.entries(table)) {
      if (!seen.has(`${chain}|${key}`)) onlyOurs.push({ chain, key, symbol })
    }
  }

  return { checked: seen.size, agree: agree.length, decimalsClash, symbolClash, adopted, onlyOurs }
}

/** The five chains HyperFX orders actually live on. The indexer also covers eight others (one
 *  of which is routinely unhealthy) — reporting those would be crying wolf about a number that
 *  does not depend on them. */
function healthOf(metadataNodes) {
  const rows = []
  for (const node of metadataNodes ?? []) {
    const chain = chainKey(node.chain)
    if (!chain) continue
    const behind = Number(node.targetHeight) - Number(node.lastProcessedHeight)
    rows.push({
      chain,
      name: CHAIN_NAMES[chain],
      healthy: node.indexerHealthy === true,
      height: Number(node.lastProcessedHeight),
      behind: Number.isFinite(behind) ? behind : null,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------ resolving a leg to symbol/amount ---- */

/**
 * Build the per-request token resolver from the audit. Returns `{ symbol: null }` for anything
 * it will not vouch for, which is how "we could not value this" stays distinguishable from
 * "this was worth nothing" all the way to the page.
 */
function resolverFrom(check) {
  const blocked = new Set((check?.decimalsClash ?? []).map((m) => `${m.chain}|${m.key}`))
  const extra = new Map((check?.adopted ?? []).map((a) => [`${a.chain}|${a.key}`, [a.symbol, a.decimals]]))

  return function describe(chain, token) {
    const key = keyOf(token)
    const id = `${chainKey(chain) ?? chain}|${key}`
    if (blocked.has(id)) return { symbol: null, decimals: null, blocked: true }
    const hit = (TOKENS[chainKey(chain) ?? chain] || {})[key] ?? extra.get(id)
    return hit ? { symbol: hit[0], decimals: hit[1] } : { symbol: null, decimals: null }
  }
}

/**
 * A leg in human units, plus the decimals actually used — the fee on the same order is quoted
 * in the same token, so it has to be scaled by the same number rather than by the configured
 * one. Returning the decision instead of re-deriving it is what keeps those two in step.
 */
function unitsWith(describe, asset, chain) {
  if (!asset) return null
  const { symbol, decimals } = describe(chain, asset.token)
  if (!symbol) return null
  // Four early ZARP orders were placed with 6-decimal amounts before the token's real 18
  // decimals were wired up; they all refunded. Read the magnitude instead of trusting the
  // config, or those four land twelve orders of magnitude off and dominate the chart.
  const raw = String(asset.amount)
  const dec = symbol === 'ZARP' && raw.length < 12 ? 6 : decimals
  return { symbol, decimals: dec, amount: Number(raw) / 10 ** dec }
}

/**
 * A token this table does not know prices at zero, and the only symptom is a total that comes
 * out quietly low. Name the address instead, so the fix is obvious the next time HyperFX adds a
 * chain or a stablecoin. This travels to the browser and onto the page — see the DATA NOTES
 * section of /hyperfx/.
 */
function unpricedTokens(nodes, describe) {
  const missing = new Map()
  for (const order of nodes) {
    const legs = [
      [order.sourceChain, order.inputAssets.nodes],
      [order.destChain, order.outputAssets.nodes],
    ]
    for (const [chain, assets] of legs) {
      for (const asset of assets) {
        if (describe(chain, asset.token).symbol) continue
        const id = chain + ' 0x' + keyOf(asset.token)
        missing.set(id, (missing.get(id) || 0) + 1)
      }
    }
  }
  return [...missing.entries()].map(([token, legs]) => ({ token, legs }))
}

/** Referrers are ASCII packed into a 32-byte word; all-zero means the order arrived without one. */
function referrer(hex) {
  const bytes = String(hex || '').replace(/^0x/, '').replace(/(00)+$/, '')
  if (!bytes) return null
  const text = (bytes.match(/.{1,2}/g) || []).map((b) => String.fromCharCode(parseInt(b, 16))).join('')
  return /^[\x20-\x7e]+$/.test(text) ? text : null
}

/* ----------------------------------------------------------------------------- fetching ---- */

async function page(first, offset) {
  const data = await graphql({
    source: 'hyperbridge',
    url: URL,
    query: ORDERS,
    variables: { first, offset },
    timeoutMs: 45_000,
  })
  return data.iOrderV3s
}

async function fetchAllOrders() {
  const first = await page(PAGE, 0)
  const nodes = [...first.nodes]

  // Paged sequentially rather than in parallel on purpose: this is somebody else's indexer and
  // we are an uninvited client. One request at a time, once per TTL.
  for (let offset = PAGE; offset < first.totalCount; offset += PAGE) {
    const next = await page(PAGE, offset)
    if (!next.nodes.length) break // an indexer reporting a totalCount it cannot deliver
    nodes.push(...next.nodes)
  }
  return { nodes, totalCount: first.totalCount, fetchedAt: new Date().toISOString() }
}

/**
 * A TTL memo with the single-flight property, shared by BOTH operations.
 *
 * `server/lib/cache.mjs` already does this per operation key — but the drill-down and the
 * dashboard are different keys over the same upstream rows, so without this a reader who opens
 * the dashboard and clicks an address pays for the whole history twice. Ten concurrent readers
 * produce one fetch, not ten.
 */
function memo(ttlMs, load) {
  let state = { at: 0, value: null, inflight: null }
  return () => {
    if (state.value && Date.now() - state.at < ttlMs) return Promise.resolve(state.value)
    if (state.inflight) return state.inflight
    state.inflight = load()
      .then((value) => {
        state = { at: Date.now(), value, inflight: null }
        return value
      })
      .catch((error) => {
        state.inflight = null
        throw error
      })
    return state.inflight
  }
}

const history = memo(HISTORY_TTL_MS, fetchAllOrders)

const checks = memo(CHECKS_TTL_MS, async () => {
  const data = await graphql({ source: 'hyperbridge', url: URL, query: CHECKS, timeoutMs: 20_000 })
  return {
    registry: audit(data?.intentGatewayTokenVolumes?.nodes),
    health: healthOf(data?._metadatas?.nodes),
    at: new Date().toISOString(),
  }
})

/* -------------------------------------------------------------------- shared derivation ---- */

/** The rate table, derived from the orders themselves. See src/core/pricing.js for why this is
 *  a median over observations rather than a single quote: the indexer leaves cNGN — the token
 *  nearly every order touches — at zero. */
function ratesFor(nodes, describe) {
  const legs = []
  for (const order of nodes) {
    const ins = order.inputAssets.nodes.map((a) => unitsWith(describe, a, order.sourceChain)).filter(Boolean)
    const outs = order.outputAssets.nodes.map((a) => unitsWith(describe, a, order.destChain)).filter(Boolean)
    if (ins.length !== 1 || outs.length !== 1) continue
    legs.push({ inSymbol: ins[0].symbol, inAmount: ins[0].amount, outSymbol: outs[0].symbol, outAmount: outs[0].amount })
  }
  return deriveRates(legs)
}

/**
 * The protocol fee on one order, in the token it was actually charged in.
 *
 * ⚠️ `fees` IS RAW TOKEN UNITS OF THE INPUT LEG, AND IT IS NEVER SUMMABLE ACROSS CHAINS. The
 * indexer's own `groupedAggregates` will happily hand you 3,140,539,795,579,859,261 for BNB
 * Chain next to 11,501,381 for Base — an 18-decimal number beside a 6-decimal one. Adding
 * those produces a figure with no unit at all. Scale each order by its own input-leg decimals
 * first, then convert to dollars; dollars are the only column here that may be totalled.
 */
function feeOf(order, input, rates) {
  const raw = order.fees
  if (raw === null || raw === undefined) return null
  if (!input) return { raw: String(raw), symbol: null, amount: null, usd: null }
  const amount = Number(raw) / 10 ** input.decimals
  const rate = rates[input.symbol]
  return {
    raw: String(raw),
    symbol: input.symbol,
    decimals: input.decimals,
    amount,
    usd: rate === undefined ? null : amount * rate,
  }
}

/** The canonical `Trade[]` both the dashboard and the account summary are built from. */
function toTrades(nodes, describe, rates) {
  return nodes.map((order) => {
    const input = unitsWith(describe, order.inputAssets.nodes[0], order.sourceChain)
    const output = unitsWith(describe, order.outputAssets.nodes[0], order.destChain)
    const timestamp = Number(order.blockTimestamp)

    // Value the input leg only. Summing both legs doubles the total.
    let usd = 0
    let priced = false
    for (const asset of order.inputAssets.nodes) {
      const u = unitsWith(describe, asset, order.sourceChain)
      const rate = u && rates[u.symbol]
      if (rate !== undefined && u) {
        usd += u.amount * rate
        priced = true
      }
    }

    return {
      id: order.id,
      account: String(order.user).toLowerCase(),
      timestamp,
      date: dayOf(timestamp),
      venue: chainName(order.sourceChain),
      destination: chainName(order.destChain),
      tokenIn: input ? input.symbol : null,
      tokenOut: output ? output.symbol : null,
      amountIn: input ? input.amount : null,
      amountOut: output ? output.amount : null,
      // `null`, not `0`. "We could not value this" and "this was worth nothing" are different
      // facts and every total downstream keeps them apart.
      usd: priced ? usd : null,
      // The indexer's rival valuation, kept for comparison only. It writes a literal `0` where
      // it could not price an order — which is exactly the confusion `null` exists to prevent —
      // so a zero is read back as "unknown" rather than as "worthless".
      indexerUsd: Number(order.inputUSD) > 0 ? Number(order.inputUSD) : null,
      fee: feeOf(order, input, rates),
      status: order.status,
      failed: order.status === 'REFUNDED',
      referrer: referrer(order.referrer),
    }
  })
}

/**
 * THREE numbers exist for "HyperFX volume" and they do not agree. Rather than pick one and
 * hope, this computes all three from the same rows so the page can print them side by side:
 *
 *   `orderSum`   — what this site reports: every order valued on its input leg with rates
 *                  derived from the orders themselves.
 *   `indexerUsd` — the indexer's own `inputUSD` column, added up over the orders it actually
 *                  priced. It reports a literal `0` — not `null` — for the rest, including
 *                  plain USDC orders, so it is a FLOOR and never a rival total.
 *   `headlineUsd`— HyperFX's own headline method: cumulative protocol dust × 2,000. `fees` is
 *                  that dust, per order, in raw units of ITS OWN input token, so the
 *                  reconstruction must scale each order by its own chain's decimals before
 *                  adding anything. This is our arithmetic over these rows, not a reading of
 *                  their homepage.
 *
 * Printing all three, with the method beside each, is the honest version of "they disagree".
 */
function volumeComparison(trades) {
  let orderSum = 0
  let dustUsd = 0
  let pricedFees = 0
  let unpricedFees = 0
  let indexerUsd = 0
  let indexerPriced = 0
  let indexerZero = 0

  for (const trade of trades) {
    orderSum += trade.usd ?? 0
    if (trade.fee?.usd === null || trade.fee?.usd === undefined) unpricedFees += 1
    else {
      dustUsd += trade.fee.usd
      pricedFees += 1
    }
    if (trade.indexerUsd === null) indexerZero += 1
    else {
      indexerUsd += trade.indexerUsd
      indexerPriced += 1
    }
  }

  return {
    orderSum,
    dustUsd,
    multiplier: 2000,
    headlineUsd: dustUsd * 2000,
    pricedFees,
    unpricedFees,
    indexerUsd,
    indexerPriced,
    indexerZero,
  }
}

/* ------------------------------------------------------------------------------- notes ---- */

/**
 * The caveats, generated from the payload rather than written down beside it. Everything here
 * is a fact about THESE rows: change the data and the sentences change with it.
 */
function notesFor({ check, volume, scope = 'volume' }) {
  const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`
  const notes = [
    'Each order is valued on its INPUT leg — what the trader actually sent. Summing both legs would double the total.',
    'Refunded orders are included in the volume figure and flagged separately; a refunded order was still a real attempt to move that much money.',
    `HyperFX’s own headline total is not a sum of these orders: it is cumulative protocol dust × 2,000. The dust these orders actually paid is ${usd(volume.dustUsd)}, so that method over this dataset gives about ${usd(volume.headlineUsd)}, where summing the orders gives ${usd(volume.orderSum)}. Both numbers are stated here; neither is a correction of the other, they are two different definitions of the word.`,
    `A third figure exists and is also not this one: the indexer’s own \`inputUSD\` column totals ${usd(volume.indexerUsd)} over the ${volume.indexerPriced} orders it priced, but it reports a literal $0 — not “unknown” — for the other ${volume.indexerZero}, including plain USDC orders. That makes it a floor, so this page does not use it.`,
    'Token decimals are keyed BY CHAIN, never by symbol: USDC and USDT are 18 decimals on BNB Chain and 6 everywhere else. A symbol-keyed table would be a silent factor of a trillion on every BNB order.',
  ]

  if (scope === 'orders') {
    notes.push(
      'The fee on each order is raw units of ITS OWN input token, so the fee column is never totalled in tokens. Only the dollar column is added up, and only after each order has been scaled by its own chain’s decimals — the indexer’s own per-chain fee sums put an 18-decimal number beside a 6-decimal one.',
    )
  }

  if (check?.registry) {
    const r = check.registry
    if (r.decimalsClash.length) {
      notes.push(
        `DECIMALS MISMATCH against the indexer’s own token registry for ${r.decimalsClash
          .map((m) => `${m.ourSymbol} on ${CHAIN_NAMES[m.chain] ?? m.chain} (ours ${m.ourDecimals}, theirs ${m.theirDecimals})`)
          .join('; ')}. Those legs are left unvalued rather than guessed at — a wrong choice here is a factor of 10ⁿ that renders perfectly.`,
      )
    } else {
      notes.push(
        `Decimals for ${r.agree} of the ${r.checked} tokens in the indexer’s own registry match the table this site keeps, including the 18-decimal USDC and USDT on BNB Chain. Checked on every fetch, because a wrong decimal is invisible in the output.`,
      )
    }
    if (r.symbolClash.length) {
      notes.push(
        `Symbol differences that do not affect any number: ${r.symbolClash
          .map((m) => `the registry calls ${m.ourSymbol} on ${CHAIN_NAMES[m.chain] ?? m.chain} “${m.theirSymbol}”`)
          .join('; ')}. The decimals agree, so this is a label, not an amount.`,
      )
    }
    if (r.adopted.length) {
      notes.push(
        `Valued using decimals read live from the indexer’s registry because this site’s table does not list them yet: ${r.adopted
          .map((a) => `${a.symbol} on ${CHAIN_NAMES[a.chain] ?? a.chain} (${a.decimals} dp)`)
          .join('; ')}.`,
      )
    }
  }

  const unhealthy = (check?.health ?? []).filter((h) => !h.healthy || (h.behind ?? 0) > 0)
  if (unhealthy.length) {
    notes.push(
      `The indexer reports itself behind or unhealthy on ${unhealthy
        .map((h) => `${h.name}${h.behind ? ` (${h.behind} blocks behind)` : ''}`)
        .join(', ')}. Recent orders on those chains may be missing from these totals.`,
    )
  } else if (check?.health?.length) {
    notes.push(
      `The indexer reports itself caught up to the head on all ${check.health.length} chains HyperFX orders are placed on. It also indexes eight other chains, whose health does not affect these numbers.`,
    )
  }

  if (volume.unpricedFees) {
    notes.push(
      `${volume.unpricedFees} order(s) have a fee in a token with no rate, so they are absent from the dust reconstruction above rather than counted as a zero fee.`,
    )
  }

  return notes
}

/* ------------------------------------------------------------------ the drill-down rows ---- */

/**
 * Turn the validated parameters into the indexer's filter object.
 *
 * ⚠️ `user` is stored LOWERCASE and `filler` is stored CHECKSUMMED (mixed case), and `equalTo`
 * is case-sensitive — verified live: the same address matches 89 orders lowercased and 0
 * as typed. Both sides therefore use `likeInsensitive`, whose `%` and `_` are wildcards. The
 * only reason that is safe is that `address` is validated against `^0x[0-9a-f]{40}$` before it
 * arrives here, so a wildcard cannot exist in it. Loosen that pattern and this becomes a way to
 * ask the indexer for everything.
 */
function buildFilter({ address, role, chain, status, date }) {
  const and = []

  if (address) {
    const a = address.toLowerCase()
    const asTrader = { user: { likeInsensitive: a } }
    const asFiller = { fills: { some: { filler: { likeInsensitive: a } } } }
    if (role === 'trader') and.push(asTrader)
    else if (role === 'filler') and.push(asFiller)
    else and.push({ or: [asTrader, asFiller] })
  }
  if (chain) and.push({ sourceChain: { equalTo: chain } })
  if (status) and.push({ status: { equalTo: status } })
  if (date) {
    const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
    and.push({ blockTimestamp: { greaterThanOrEqualTo: String(from), lessThan: String(from + 86_400) } })
  }

  return and.length ? { and } : null
}

/** One order, flattened for the wire. */
function toRow(order, describe, rates) {
  const input = unitsWith(describe, order.inputAssets.nodes[0], order.sourceChain)
  const output = unitsWith(describe, order.outputAssets.nodes[0], order.destChain)
  const placedAt = Number(order.blockTimestamp)
  const fill = order.fills?.nodes?.[0] ?? null
  const filledAt = fill ? Number(fill.timestamp) : null

  const inRate = input ? rates[input.symbol] : undefined
  const usd = input && inRate !== undefined ? input.amount * inRate : null

  return {
    id: order.id,
    trader: String(order.user).toLowerCase(),
    traderUrl: explorerUrl(order.sourceChain, 'address', String(order.user).toLowerCase()),
    placedAt,
    date: dayOf(placedAt),
    chain: chainName(order.sourceChain),
    chainKey: chainKey(order.sourceChain),
    destination: chainName(order.destChain),
    crossChain: order.sourceChain !== order.destChain,
    tokenIn: input?.symbol ?? null,
    amountIn: input?.amount ?? null,
    tokenOut: output?.symbol ?? null,
    amountOut: output?.amount ?? null,
    // Units of tokenOut per one tokenIn. `null` where either leg is unknown — an implied rate
    // computed against an unvalued leg is a number with no meaning.
    rate: input && output && input.amount > 0 ? output.amount / input.amount : null,
    usd,
    // The indexer's own valuation of the same order, for comparison only. A literal 0 from it
    // means "could not price", not "worth nothing", so it comes back as null.
    indexerUsd: Number(order.inputUSD) > 0 ? Number(order.inputUSD) : null,
    fee: feeOf(order, input, rates),
    status: order.status,
    refunded: order.status === 'REFUNDED',
    tx: order.transactionHash,
    txUrl: explorerUrl(order.sourceChain, 'tx', order.transactionHash),
    filler: fill?.filler ?? null,
    fillerUrl: fill ? explorerUrl(fill.chain, 'address', fill.filler) : null,
    fillTx: fill?.transactionHash ?? null,
    fillTxUrl: fill ? explorerUrl(fill.chain, 'tx', fill.transactionHash) : null,
    filledAt,
    // How long the order sat before somebody filled it. `null` for an order nobody filled —
    // not zero, which would read as "instant".
    latencySeconds: filledAt !== null && Number.isFinite(placedAt) ? filledAt - placedAt : null,
    fills: order.fills?.totalCount ?? 0,
    partialFills: order.partialFills?.totalCount ?? 0,
    escrowReleases: order.escrowReleases?.totalCount ?? 0,
    escrowRefunds: order.escrowRefunds?.totalCount ?? 0,
    referrer: referrer(order.referrer),
    timeline: (order.statusMetadata?.nodes ?? []).map((step) => ({
      status: step.status,
      at: Number(step.timestamp),
      chain: chainName(step.chain),
      tx: step.transactionHash,
      txUrl: explorerUrl(step.chain, 'tx', step.transactionHash),
      filler: step.filler ?? null,
    })),
  }
}

/**
 * The rate board: what recent orders actually got, per route.
 *
 * This is not the USD rate table — it is the raw exchange rate the venue delivered, which is
 * the thing somebody looking at an FX venue came to see. Median over the last observations, so
 * one fat-fingered order does not move it, alongside the latest single observation so drift is
 * visible rather than averaged away.
 */
function rateBoard(trades, { window = 25, limit = 12 } = {}) {
  const byRoute = new Map()
  for (const trade of trades) {
    if (!trade.tokenIn || !trade.tokenOut || !(trade.amountIn > 0) || !(trade.amountOut > 0)) continue
    if (trade.tokenIn === trade.tokenOut) continue
    const route = `${trade.tokenIn}→${trade.tokenOut}`
    const hit = byRoute.get(route) || { route, tokenIn: trade.tokenIn, tokenOut: trade.tokenOut, samples: [] }
    hit.samples.push({ at: trade.timestamp, rate: trade.amountOut / trade.amountIn, settled: !trade.failed })
    byRoute.set(route, hit)
  }

  const rows = []
  for (const entry of byRoute.values()) {
    const settled = entry.samples.filter((s) => s.settled)
    const basis = (settled.length ? settled : entry.samples).sort((a, b) => a.at - b.at)
    const recent = basis.slice(-window)
    const sorted = recent.map((s) => s.rate).sort((a, b) => a - b)
    const median = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2
    const last = basis[basis.length - 1]
    rows.push({
      route: entry.route,
      tokenIn: entry.tokenIn,
      tokenOut: entry.tokenOut,
      observations: entry.samples.length,
      settledObservations: settled.length,
      window: recent.length,
      median,
      latest: last.rate,
      latestAt: last.at,
      // Where the last fill sat relative to the recent median. `null` rather than 0 when the
      // median is not a usable denominator.
      drift: median > 0 ? ((last.rate - median) / median) * 100 : null,
    })
  }

  return rows.sort((a, b) => b.observations - a.observations).slice(0, limit)
}

/** Options for the filter controls, counted from the same snapshot the rows come from, so a
 *  control can never offer a choice that returns nothing. */
function facetsFrom(trades, { days = 21 } = {}) {
  const count = (key) => {
    const map = new Map()
    for (const trade of trades) {
      const value = key(trade)
      if (value === null || value === undefined) continue
      map.set(value, (map.get(value) || 0) + 1)
    }
    return map
  }

  const chains = [...count((t) => t.venue).entries()]
    .map(([name, orders]) => ({
      name,
      key: Object.keys(CHAIN_NAMES).find((k) => CHAIN_NAMES[k] === name) ?? name,
      orders,
    }))
    .sort((a, b) => b.orders - a.orders)

  const statuses = [...count((t) => t.status).entries()]
    .map(([status, orders]) => ({ status, orders }))
    .sort((a, b) => b.orders - a.orders)

  const byDay = count((t) => t.date)
  const recent = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, days)

  return { chains, statuses, days: recent.map(([date, orders]) => ({ date, orders })) }
}

/* --------------------------------------------------------------------------- the source ---- */

const HEX40 = /^0x[0-9a-fA-F]{40}$/

export default {
  id: 'hyperbridge',
  label: 'Hyperbridge nexus indexer',
  homepage: 'https://hyperbridge.network',
  transport: 'graphql',
  doc: 'docs/platform/hyperbridge.md',
  covers: ['Ethereum', 'BNB Chain', 'Polygon', 'Base', 'Arbitrum'],

  operations: {
    swaps: {
      summary: 'Every HyperFX intent order ever placed, valued and rolled up.',
      // Five minutes. The dataset only grows at the far end; a visitor seeing a five-minute-old
      // total is fine, the indexer being paged through on every visit is not.
      ttlMs: 300_000,
      schema: {},

      async run() {
        const [{ nodes, totalCount, fetchedAt }, check] = await Promise.all([history(), checks()])
        const describe = resolverFrom(check.registry)
        const { rates } = ratesFor(nodes, describe)
        const trades = toTrades(nodes, describe, rates)

        const volume = volumeComparison(trades)

        const result = aggregate({
          trades,
          rates,
          meta: {
            venue: 'HyperFX',
            venueUrl: 'https://app.hyperfx.finance/history',
            source: 'hyperbridge',
            sourceLabel: 'Hyperbridge nexus indexer',
            sourceUrl: 'nexus.indexer.polytope.technology',
            unit: 'order',
            unitPlural: 'orders',
            venueLabel: 'chain the order was placed on',
            window: 'every order ever placed',
            indexerTotalCount: totalCount,
            unpricedTokens: unpricedTokens(nodes, describe),
            decimalsCheck: check.registry,
            indexerHealth: check.health,
            volume,
            fetchedAt,
            notes: notesFor({ check, volume }),
          },
        })

        return trimForWire(result)
      },
    },

    orders: {
      summary:
        'Individual HyperFX orders, filtered server-side by address, chain, status or day, with fills, implied rates and per-order fees.',
      // A minute. This is a transaction feed rather than a rollup — a reader who just placed an
      // order should see it — but it is still cached, so a page refresh is not a fetch.
      ttlMs: 60_000,
      schema: {
        // Hex-40 and nothing else. Beyond the obvious, this is what makes `likeInsensitive`
        // safe below: `%` and `_` are wildcards to the indexer and cannot survive this pattern.
        address: { type: 'string', pattern: HEX40, maxLength: 42 },
        role: { type: 'string', oneOf: ['either', 'trader', 'filler'], default: 'either' },
        chain: { type: 'string', oneOf: Object.keys(CHAIN_NAMES) },
        status: { type: 'string', oneOf: ['PLACED', 'FILLED', 'REDEEMED', 'REFUNDED'] },
        date: { type: 'date' },
        limit: { type: 'int', min: 1, max: 200, default: 50 },
        offset: { type: 'int', min: 0, max: 5000, default: 0 },
      },

      async run(params) {
        const { address = null, role = 'either', chain = null, status = null, date = null, limit = 50, offset = 0 } = params

        const filter = buildFilter({ address, role, chain, status, date })

        // The snapshot is what prices these rows, and the filtered query is what selects them.
        // Both matter: pricing from a filtered page would derive a rate table from a handful of
        // orders and value the same order differently depending on how you got to it.
        const [snapshot, check, data] = await Promise.all([
          history(),
          checks(),
          graphql({
            source: 'hyperbridge',
            url: URL,
            query: ROWS,
            variables: { first: limit, offset, filter },
            timeoutMs: 30_000,
          }),
        ])

        const describe = resolverFrom(check.registry)
        const { rates } = ratesFor(snapshot.nodes, describe)
        const allTrades = toTrades(snapshot.nodes, describe, rates)

        const connection = data.iOrderV3s
        const rows = connection.nodes.map((order) => toRow(order, describe, rates))

        // Everything below is a fact about THE ROWS ON SCREEN, and is labelled as such on the
        // page. A total over one page of results is not a total over the filter.
        const priced = rows.filter((r) => r.usd !== null)
        const latencies = rows.map((r) => r.latencySeconds).filter((v) => v !== null).sort((a, b) => a - b)
        const shown = {
          rows: rows.length,
          matching: connection.totalCount,
          usd: priced.reduce((sum, r) => sum + r.usd, 0),
          unpriced: rows.length - priced.length,
          feeUsd: rows.reduce((sum, r) => sum + (r.fee?.usd ?? 0), 0),
          unpricedFees: rows.filter((r) => r.fee && r.fee.usd === null).length,
          traders: new Set(rows.map((r) => r.trader)).size,
          fillers: new Set(rows.map((r) => r.filler).filter(Boolean)).size,
          medianLatencySeconds: latencies.length ? latencies[latencies.length >> 1] : null,
          statuses: [...rows.reduce((m, r) => m.set(r.status, (m.get(r.status) || 0) + 1), new Map()).entries()]
            .map(([s, n]) => ({ status: s, orders: n }))
            .sort((a, b) => b.orders - a.orders),
        }

        // The account header, when one address is in focus. The two role counts come from the
        // indexer in one extra request; the dollar figures come from the snapshot, so they are
        // the same dollars the dashboard shows rather than a second opinion.
        let account = null
        if (address) {
          const a = address.toLowerCase()
          const roles = await graphql({
            source: 'hyperbridge',
            url: URL,
            query: ROLES,
            variables: { address: a },
            timeoutMs: 20_000,
          })
          const mine = allTrades.filter((t) => t.account === a)
          const pricedMine = mine.filter((t) => t.usd !== null)
          // Field names say WHICH SIDE each figure is about. An address can be both a trader
          // and a market maker — one here has placed 3 orders and filled 418 — so a bare
          // `usd` on this object would be read as "what this address traded" and be wrong by
          // two orders of magnitude.
          account = {
            address: a,
            placed: roles.asTrader?.totalCount ?? null,
            filled: roles.asFiller?.totalCount ?? null,
            placedUsd: pricedMine.reduce((sum, t) => sum + t.usd, 0),
            // Not 0: the fill side is a count from the indexer and carries no amounts, so the
            // dollars it moved as a filler are unknown rather than nothing.
            filledUsd: null,
            placedUnpriced: mine.length - pricedMine.length,
            placedRefunded: mine.filter((t) => t.failed).length,
            placedFirst: mine.length ? mine.reduce((min, t) => (t.date < min ? t.date : min), mine[0].date) : null,
            placedLast: mine.length ? mine.reduce((max, t) => (t.date > max ? t.date : max), mine[0].date) : null,
            placedChains: [...mine.reduce((m, t) => m.set(t.venue, (m.get(t.venue) || 0) + 1), new Map()).entries()]
              .map(([name, orders]) => ({ name, orders }))
              .sort((a2, b2) => b2.orders - a2.orders),
            // The explorer link uses the chain this address most often places on; the address
            // itself is the same on all five.
            explorerUrl: explorerUrl(
              mine.length
                ? Object.keys(CHAIN_NAMES).find((k) => CHAIN_NAMES[k] === mine[mine.length - 1].venue)
                : 'EVM-8453',
              'address',
              a,
            ),
          }
        }

        const volume = volumeComparison(allTrades)
        const notes = notesFor({ check, volume, scope: 'orders' })
        notes.unshift(
          'The rows below are selected by the indexer, not filtered in the browser: address, chain, status and day all travel to it as a query. The count beside the filter is how many orders match it in total, which is usually more than one page.',
        )
        notes.push(
          'Addresses are stored two different ways by this indexer — a trader lowercase, a filler checksummed — so both sides are matched case-insensitively. An address may appear as both.',
        )
        notes.push(
          'A refunded order can still have been partially filled: the escrow refund and the partial-fill count are separate columns because they are separate events.',
        )
        if (account) {
          notes.push(
            `Every dollar figure in the account summary is the side this address PLACED. It has filled ${account.filled ?? 0} order(s) for other people; the indexer gives that as a count and no amounts, so the value it moved as a filler is left unknown rather than shown as zero.`,
          )
        }

        return {
          filter: { address: address ? address.toLowerCase() : null, role, chain, status, date, limit, offset },
          rows,
          shown,
          account,
          rateBoard: rateBoard(allTrades),
          facets: facetsFrom(allTrades),
          rates,
          totals: {
            // History-wide context, so a filtered page never reads as the whole venue.
            orders: snapshot.totalCount,
            volume,
          },
          meta: {
            venue: 'HyperFX',
            venueUrl: 'https://app.hyperfx.finance/history',
            source: 'hyperbridge',
            sourceLabel: 'Hyperbridge nexus indexer',
            sourceUrl: 'nexus.indexer.polytope.technology',
            decimalsCheck: check.registry,
            indexerHealth: check.health,
            snapshotAt: snapshot.fetchedAt,
            fetchedAt: new Date().toISOString(),
            notes,
          },
        }
      },
    },
  },
}
