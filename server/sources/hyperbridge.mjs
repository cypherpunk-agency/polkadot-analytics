// The Hyperbridge nexus indexer — the source behind the HyperFX volume dashboard.
//
// HyperFX (https://app.hyperfx.finance) has no volume API of its own; its history page fetches
// every intent order from this indexer and totals them in the browser. We read the same thing,
// server-side, once per TTL, instead of once per visitor.
//
// ⚠️ THE NUMBER HERE IS NOT THE NUMBER ON THEIR HOMEPAGE, and that is deliberate. HyperFX's
// headline "TOTAL VOLUME" derives from cumulative protocol dust collected × 2,000. This source
// sums the actual orders. The two disagree; the page says so rather than quietly picking one.

import { graphql } from '../lib/upstream.mjs'
import { deriveRates } from '../../src/core/pricing.js'
import { aggregate, trimForWire, dayOf } from '../../src/core/swaps.js'

const URL = 'https://nexus.indexer.polytope.technology/'
const PAGE = 200

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
      sourceChain
      destChain
      blockTimestamp
      inputAssets { nodes { token amount } }
      outputAssets { nodes { token amount } }
    }
  }
}`

export const CHAIN_NAMES = {
  'EVM-1': 'Ethereum',
  'EVM-56': 'BNB Chain',
  'EVM-137': 'Polygon',
  'EVM-8453': 'Base',
  'EVM-42161': 'Arbitrum',
}

// Token addresses and decimals, lifted from HyperFX's own chain config. The indexer sends
// addresses as 32-byte words, so we key on the low 40 hex characters.
//
// ⚠️ DECIMALS ARE PER CHAIN, NOT PER SYMBOL. USDC and USDT are 18 decimals on BNB Chain and 6
// everywhere else. Keying this table by symbol would be a silent factor-of-a-trillion on every
// BNB order — a wrong total that renders perfectly.
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

function describe(chain, token) {
  const hit = (TOKENS[chain] || {})[keyOf(token)]
  return hit ? { symbol: hit[0], decimals: hit[1] } : { symbol: null, decimals: null }
}

function units(asset, chain) {
  const { symbol, decimals } = describe(chain, asset.token)
  if (!symbol) return null
  // Four early ZARP orders were placed with 6-decimal amounts before the token's real 18
  // decimals were wired up; they all refunded. Read the magnitude instead of trusting the
  // config, or those four land twelve orders of magnitude off and dominate the chart.
  const raw = String(asset.amount)
  const dec = symbol === 'ZARP' && raw.length < 12 ? 6 : decimals
  return { symbol, amount: Number(raw) / 10 ** dec }
}

/**
 * A token this table does not know prices at zero, and the only symptom is a total that comes
 * out quietly low. Name the address instead, so the fix is obvious the next time HyperFX adds a
 * chain or a stablecoin. This travels to the browser and onto the page — see the DATA NOTES
 * section of /hyperfx/.
 */
function unpricedTokens(nodes) {
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
  return { nodes, totalCount: first.totalCount }
}

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
        const { nodes, totalCount } = await fetchAllOrders()

        // Rates come from the orders themselves: the indexer leaves cNGN — the token nearly
        // every order touches — at zero. See src/core/pricing.js for why this is a median over
        // observations rather than a single quote.
        const legs = []
        for (const order of nodes) {
          const ins = order.inputAssets.nodes.map((a) => units(a, order.sourceChain)).filter(Boolean)
          const outs = order.outputAssets.nodes.map((a) => units(a, order.destChain)).filter(Boolean)
          if (ins.length !== 1 || outs.length !== 1) continue
          legs.push({
            inSymbol: ins[0].symbol,
            inAmount: ins[0].amount,
            outSymbol: outs[0].symbol,
            outAmount: outs[0].amount,
          })
        }
        const { rates } = deriveRates(legs)

        const trades = nodes.map((order) => {
          const inAsset = order.inputAssets.nodes[0]
          const outAsset = order.outputAssets.nodes[0]
          const timestamp = Number(order.blockTimestamp)

          // Value the input leg only. Summing both legs doubles the total.
          let usd = 0
          let priced = false
          for (const asset of order.inputAssets.nodes) {
            const u = units(asset, order.sourceChain)
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
            venue: CHAIN_NAMES[order.sourceChain] || order.sourceChain,
            destination: CHAIN_NAMES[order.destChain] || order.destChain,
            tokenIn: inAsset ? describe(order.sourceChain, inAsset.token).symbol : null,
            tokenOut: outAsset ? describe(order.destChain, outAsset.token).symbol : null,
            amountIn: inAsset ? units(inAsset, order.sourceChain)?.amount ?? 0 : 0,
            usd: priced ? usd : null,
            status: order.status,
            failed: order.status === 'REFUNDED',
            referrer: referrer(order.referrer),
          }
        })

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
            unpricedTokens: unpricedTokens(nodes),
            fetchedAt: new Date().toISOString(),
            notes: [
              'Each order is valued on its INPUT leg — what the trader actually sent. Summing both legs would double the total.',
              'Refunded orders are included in the volume figure and flagged separately; a refunded order was still a real attempt to move that much money.',
              'HyperFX’s own headline total is derived from cumulative protocol dust × 2,000, not from these orders. This page sums the orders.',
            ],
          },
        })

        return trimForWire(result)
      },
    },
  },
}
