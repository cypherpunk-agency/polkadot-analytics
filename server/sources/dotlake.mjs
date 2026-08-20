// Parity's Dotlake API — https://api.data.parity.io (the backend behind https://data.parity.io).
//
// The broadest Polkadot-wide source we read: XCM message flow, per-chain daily activity, DeFi
// TVL, stablecoin holdings, coretime, contracts and OpenGov, all pre-aggregated.
//
// ── why it is safe to depend on anonymously ─────────────────────────────────────────────────
// Its OpenAPI document declares `security: [{}, {BearerAuth: []}]`. The empty first alternative
// is the important half: authentication is OPTIONAL, and every endpoint below was verified to
// answer an anonymous request. There is no key to hold, which is the point — see
// docs/decisions/0003-no-secrets.md.
//
// ── the honesty note that has to travel with the numbers ────────────────────────────────────
// `total_value_usd` on the XCM endpoints is frequently 0 even when messages moved real value:
// Dotlake prices only the assets it can resolve. So the XCM page leads with MESSAGE COUNTS,
// which are exact, and treats USD as a floor rather than a total. A page that led with the USD
// figure would be reporting a confident zero.

import { callUpstream } from '../lib/upstream.mjs'

const BASE = 'https://api.data.parity.io'

const RELAY = { type: 'string', oneOf: ['polkadot', 'kusama'], default: 'polkadot' }
const WINDOW_HOURS = { type: 'int', min: 1, max: 720, default: 24 }

/** A read-only GET against a path this file names. The client never supplies a path. */
function rest(path, schema, { ttlMs = 300_000, summary = '' } = {}) {
  return {
    summary,
    ttlMs,
    schema,
    async run(params) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        query.set(key, Array.isArray(value) ? value.join(',') : String(value))
      }
      const suffix = query.size ? `?${query}` : ''
      return callUpstream({ source: 'dotlake', url: `${BASE}${path}${suffix}`, timeoutMs: 45_000 })
    },
  }
}

export default {
  id: 'dotlake',
  label: 'Dotlake (Parity)',
  homepage: 'https://data.parity.io',
  transport: 'rest',
  doc: 'docs/platform/data-sources.md#dotlake',
  covers: ['Polkadot', 'Kusama', 'system chains', 'parachains'],

  operations: {
    /* ------------------------------------------------------------------------- XCM ---- */

    'xcm-summary': rest('/api/xcm-summary', { relay_chain: RELAY, window_hours: WINDOW_HOURS }, {
      ttlMs: 120_000,
      summary: 'Message count, success rate and latency percentiles over a recent window.',
    }),

    'xcm-daily-stats': rest(
      '/api/xcm-daily-stats',
      {
        relay_chain: RELAY,
        origin_chain: { type: 'string', maxLength: 40 },
        dest_chain: { type: 'string', maxLength: 40 },
        start_date: { type: 'date' },
        end_date: { type: 'date' },
        group_by_route: { type: 'bool', default: false },
      },
      { ttlMs: 600_000, summary: 'Daily XCM message counts, optionally split by route.' },
    ),

    'xcm-top-routes': rest(
      '/api/xcm-top-routes',
      {
        relay_chain: RELAY,
        window_hours: WINDOW_HOURS,
        limit: { type: 'int', min: 1, max: 100, default: 20 },
        // Dotlake's own parameter description recommends this: an unmatched message is one
        // whose arrival was never observed, so counting it as a completed route overstates
        // every destination. We default it ON and say so on the page.
        matched_only: { type: 'bool', default: true },
      },
      { ttlMs: 300_000, summary: 'Busiest origin→destination pairs in the window.' },
    ),

    /* -------------------------------------------------------------- chain activity ---- */

    'daily-summary': rest(
      '/api/daily-summary',
      {
        relay_chain: RELAY,
        chain: { type: 'string', maxLength: 40 },
        start_date: { type: 'date', required: true },
        end_date: { type: 'date', required: true },
      },
      { ttlMs: 900_000, summary: 'Per-chain daily activity: blocks, extrinsics, accounts, fees.' },
    ),

    'daily-tps': rest('/api/daily-tps', {
      relay_chain: RELAY,
      chain: { type: 'string', maxLength: 40 },
      start_date: { type: 'date' },
      end_date: { type: 'date' },
    }, { ttlMs: 900_000, summary: 'Daily transactions per second.' }),

    /* ------------------------------------------------------- Asset Hub / stablecoins ---- */

    'daily-usdc': rest('/api/daily-usdc', { start_date: { type: 'date' }, end_date: { type: 'date' } }, {
      ttlMs: 900_000,
      summary: 'USDC held per chain, daily. Most of it lives on Asset Hub.',
    }),

    'daily-usdt': rest('/api/daily-usdt', { start_date: { type: 'date' }, end_date: { type: 'date' } }, {
      ttlMs: 900_000,
      summary: 'USDt held per chain, daily.',
    }),

    'defi-tvl': rest('/api/defi-tvl', { start_date: { type: 'date' }, end_date: { type: 'date' } }, {
      ttlMs: 900_000,
      summary: 'Daily DeFi TVL by parachain.',
    }),

    /* ------------------------------------------------------------------- coretime ---- */

    'coretime-utilization': rest('/api/coretime-utilization', {
      relay_chain: RELAY,
      start_date: { type: 'date' },
      end_date: { type: 'date' },
    }, { ttlMs: 900_000, summary: 'Daily relay-chain core utilization.' }),

    'coretime-sale-metrics': rest('/api/coretime-sale-metrics', { relay_chain: RELAY }, {
      ttlMs: 900_000,
      summary: 'Aggregated metrics per coretime sale cycle.',
    }),

    /* ------------------------------------------------------------ smart contracts ---- */

    'contracts-deployed-heatmap': rest('/api/contracts-deployed-heatmap', {
      start_date: { type: 'date' },
      end_date: { type: 'date' },
    }, { ttlMs: 900_000, summary: 'Contract deployments over time.' }),

    'contract-calls-heatmap': rest('/api/contract-calls-heatmap', {
      start_date: { type: 'date' },
      end_date: { type: 'date' },
    }, { ttlMs: 900_000, summary: 'Contract calls over time.' }),

    /* ------------------------------------------------------------------- OpenGov ---- */

    'monthly-opengov-participation': rest('/api/monthly-opengov-participation', { relay_chain: RELAY }, {
      ttlMs: 3_600_000,
      summary: 'Monthly voter counts by voter type.',
    }),

    'monthly-treasury-balances': rest('/api/monthly-treasury-balances', { relay_chain: RELAY }, {
      ttlMs: 3_600_000,
      summary: 'Monthly treasury balances.',
    }),

    'monthly-percent-staked': rest('/api/monthly-percent-staked', { relay_chain: RELAY }, {
      ttlMs: 3_600_000,
      summary: 'Total staked and percentage of issuance staked, monthly.',
    }),
  },
}

