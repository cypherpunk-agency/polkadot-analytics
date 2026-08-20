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
// `total_value_usd` on the XCM endpoints is neither a total nor a floor. It is wrong in BOTH
// directions at once:
//
//   · too low — Dotlake prices only the assets it can resolve and reports everything else as
//     exactly `0.0`, which is indistinguishable from a message that genuinely moved nothing;
//   · too high — some rows carry an 18-decimal amount labelled with 6 or 12 decimals, and one
//     such row is worth more than every honest row in the window put together. Summed over two
//     years the field reaches $39.9 quadrillion.
//
// An aggregate endpoint has already added those together and cannot be un-added. So the value
// figures on `/xcm/` come from `xcm-value` below, which reads the ROWS, applies a stated
// exclusion rule to each one, and reports what it threw away — see the block above it.
//
// The message COUNTS are exact and stay the lead.

import { callUpstream } from '../lib/upstream.mjs'
import { liveness } from '../../src/core/liveness.js'

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

/* ==========================================================================================
 *  XCM value, computed from the row-level records rather than from an aggregate
 * ==========================================================================================
 *
 * `/api/xcm-transfers` returns one row per message, and each row carries `asset_symbol`,
 * `asset_decimals`, `raw_amount`, `value`, `asset_price` and `value_usd`. Verified on
 * 2026-08-20 across four windows spanning 2024–2026: `value === raw_amount / 10**decimals`
 * and `value_usd === value * asset_price`, exactly, in every row. So the arithmetic Dotlake
 * does is right; what is sometimes wrong is `asset_decimals` itself, and an internally
 * consistent row built on a wrong exponent cannot be caught by re-deriving either field.
 *
 * The exemplar, read live: one BNC row on 2024-06-07 with `asset_decimals: 12` and
 * `raw_amount: 996492194613435313700` — 21 digits, where the other twenty BNC rows in the same
 * week have 13 to 17. It is booked as 996,492,194 BNC = **$328,514,204**, against $8.86M for
 * every other priced row in that week put together. Label it 18 decimals and it is $328. That
 * single row is what makes a two-year sum reach the quadrillions.
 *
 * It is not a one-off. The same read over 2025-11-01…07 found thirteen rows over the ceiling
 * summing to **$108.6 billion**, two of them USDC at $44.2B and $42.2B on one corridor, against
 * $25.6M of believable value in the same four days.
 *
 * Three rules, applied per row, in this order. Each is reported separately and the excluded
 * rows are returned so the page can NAME them — an exclusion nobody can see is just a
 * different silent error.
 *
 *   1. `decimals-disagree` — the row's `asset_decimals` is not the value the rest of this
 *      symbol's rows in this window carry. One symbol, two exponents: at most one is right.
 *   2. `magnitude-outlier` — a DETACHED CLUSTER at the top of the symbol's magnitude
 *      distribution. See `outlierCut` below; the rule is a gap, not a distance from the median,
 *      and the difference is not academic — the median form threw out a genuine $1.05M USDT
 *      transfer that sat at the top of a continuous 5-to-13-digit distribution, understating a
 *      week by 13%. A gap rule leaves it in and still removes the $328M BNC row.
 *   3. `over-ceiling` — the row is worth more than CEILING_USD. The backstop for the cases
 *      rules 1 and 2 structurally cannot see: a symbol whose rows are ALL corrupt, or too few
 *      rows to compare against at all.
 *
 * Rules 1 and 2 need a population to compare against, so they only apply to a symbol with at
 * least OUTLIER_MIN_SUPPORT rows in the window. Below that, only the ceiling is left.
 *
 * The ceiling is a judgement and is stated as one. The largest single message in any window we
 * have read and believe is $1.05M; $25M is more than an order of magnitude above that, so it
 * does not touch the honest record — and if it ever does, the excluded row is on the page with
 * its value on it rather than deleted.
 */

const XCM_ROW_PAGE = 500 // Dotlake's own documented maximum
const XCM_PAGE_BUDGET = 20 // 10,000 rows per request; a partial read says so rather than lying
const CEILING_USD = 25_000_000
const OUTLIER_DECADES = 4
const OUTLIER_MIN_SUPPORT = 5
const OUTLIER_MAX_SHARE = 0.2
const EXCLUDED_SAMPLE = 40

/** Digit count of a decimal amount, as a STRING. `Number()` on a 21-digit integer already lost. */
const digitsOf = (raw) => String(raw ?? '').replace(/^[-+]?0*/, '').replace(/\..*$/, '').length

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by)

/**
 * The digit length at which a symbol's amounts stop being believable, or `Infinity`.
 *
 * Walk the distinct digit lengths from the top down until a gap of `decades` or more appears.
 * If the rows above that gap are a small minority of the symbol's rows, they are a detached
 * cluster and every one of them is an outlier; if they are the bulk of the rows, the gap is
 * the *shape of the asset* and the odd rows are the ones below it, which cannot inflate a
 * total and are left alone.
 *
 * Worked, on rows read live on 2026-08-20:
 *   BNC  2024-06  13,15,16,17,21  → gap 17→21, 1 row of 21 above  → cut at 21  ($328M removed)
 *   ACA  2025-03  11,14,15,16,20,21 → gap 16→20, 2 of 12 above    → cut at 20  ($8.6M removed)
 *   INTR 2024-06  7,12,13,14      → gap 7→12, 24 of 25 above      → no cut (the 7 is the odd one)
 *   USDT 2024-06  5,6,7,…,12,13   → no gap ≥ 4                    → no cut (the $1.05M stays)
 */
function outlierCut(histogram) {
  const entries = [...histogram].sort((a, b) => a[0] - b[0])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (total < OUTLIER_MIN_SUPPORT) return Infinity
  let above = 0
  for (let i = entries.length - 1; i > 0; i -= 1) {
    above += entries[i][1]
    if (entries[i][0] - entries[i - 1][0] >= OUTLIER_DECADES) {
      return above <= total * OUTLIER_MAX_SHARE ? entries[i][0] : Infinity
    }
  }
  return Infinity
}

/** The most frequent key in a `Map<key, count>`; ties break toward the smaller key. */
function modeOf(histogram) {
  let best = null
  let bestCount = -1
  for (const [value, n] of [...histogram].sort((a, b) => a[0] - b[0])) {
    if (n > bestCount) {
      best = value
      bestCount = n
    }
  }
  return best
}

/** Every UTC day from `from` to `to` inclusive. Empty days are DRAWN, so they must exist. */
function daySpan(from, to) {
  const out = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end && out.length < 800) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

const pairKey = (from, to) => `${from}${to}`

/**
 * Read up to `XCM_PAGE_BUDGET` pages of rows, newest first, and hand each page to `onPage`.
 * Rows are not accumulated here: the aggregate is a few hundred numbers and the rows are
 * megabytes, and this runs on a 256 MB container.
 */
async function readRows(query, onPage) {
  let read = 0
  let pages = 0
  for (; pages < XCM_PAGE_BUDGET; pages += 1) {
    const search = new URLSearchParams(query)
    search.set('limit', String(XCM_ROW_PAGE))
    search.set('offset', String(pages * XCM_ROW_PAGE))
    const page = await callUpstream({
      source: 'dotlake',
      url: `${BASE}/api/xcm-transfers?${search}`,
      timeoutMs: 45_000,
    })
    if (!Array.isArray(page)) break
    onPage(page)
    read += page.length
    if (page.length < XCM_ROW_PAGE) return { read, pages: pages + 1, complete: true }
  }
  return { read, pages, complete: false }
}

/**
 * The finished aggregate. Everything the `/xcm/` page draws its value, matrix and corridor
 * graph from, including the counts it needs to state what was left out.
 */
async function xcmValue({ relay_chain, start_date, end_date }) {
  const query = { relay_chain, start_date, end_date }

  const count = await callUpstream({
    source: 'dotlake',
    url: `${BASE}/api/xcm-transfers-count?${new URLSearchParams(query)}`,
    timeoutMs: 45_000,
  })
  const matching = Number(count?.count ?? 0)

  /* pass 1 — stream the pages, count everything, keep only the value-bearing rows ---------- */

  const messagesByDay = new Map()
  const corridors = new Map()
  const chains = new Map() // dotlake chain name -> { sent, received, paraIds: Map }
  const digitsBySymbol = new Map()
  const decimalsBySymbol = new Map()
  const xcmTypes = new Map()
  const outcomes = new Map()
  const matchStatus = new Map()
  const candidates = []
  let noAsset = 0
  let unpriced = 0
  let firstAt = null
  let lastAt = null

  const seeChain = (name, paraId, direction) => {
    const key = name || '(unnamed)'
    const entry = chains.get(key) ?? { sent: 0, received: 0, paraIds: new Map() }
    entry[direction] += 1
    if (paraId !== null && paraId !== undefined && paraId !== '') bump(entry.paraIds, String(paraId))
    chains.set(key, entry)
    return key
  }

  const coverage = await readRows(query, (page) => {
    for (const row of page) {
      const date = String(row.date ?? row.origin_timestamp ?? '').slice(0, 10)
      if (date) bump(messagesByDay, date)

      const at = Date.parse(`${row.origin_timestamp ?? ''}Z`)
      if (Number.isFinite(at)) {
        if (firstAt === null || at < firstAt) firstAt = at
        if (lastAt === null || at > lastAt) lastAt = at
      }

      const from = seeChain(row.origin_chain, row.origin_para_id, 'sent')
      const to = seeChain(row.dest_chain, row.dest_para_id, 'received')
      const corridor = corridors.get(pairKey(from, to)) ?? { from, to, messages: 0, usd: 0, priced: 0 }
      corridor.messages += 1
      corridors.set(pairKey(from, to), corridor)

      bump(xcmTypes, row.xcm_type ?? 'unrecorded')
      bump(outcomes, row.outcome ?? 'unrecorded')
      bump(matchStatus, row.match_status ?? 'unrecorded')

      const symbol = row.asset_symbol
      if (!symbol || row.raw_amount === null || row.raw_amount === undefined) {
        noAsset += 1
        continue
      }

      const decimals = Number(row.asset_decimals)
      if (!digitsBySymbol.has(symbol)) digitsBySymbol.set(symbol, new Map())
      if (!decimalsBySymbol.has(symbol)) decimalsBySymbol.set(symbol, new Map())
      bump(digitsBySymbol.get(symbol), digitsOf(row.raw_amount))
      if (Number.isFinite(decimals)) bump(decimalsBySymbol.get(symbol), decimals)

      // `null` price is "we could not value this", and it is NOT zero. It never enters a sum.
      if (row.asset_price === null || row.value_usd === null || row.value_usd === undefined) {
        unpriced += 1
        continue
      }

      candidates.push({
        date,
        symbol,
        decimals: Number.isFinite(decimals) ? decimals : null,
        digits: digitsOf(row.raw_amount),
        rawAmount: String(row.raw_amount),
        value: Number(row.value),
        usd: Number(row.value_usd),
        from,
        to,
      })
    }
  })

  /* pass 2 — decide, per row, whether the exponent it was booked with can be believed ------ */

  const profile = new Map()
  for (const [symbol, histogram] of digitsBySymbol) {
    const support = [...histogram.values()].reduce((a, b) => a + b, 0)
    profile.set(symbol, {
      support,
      cutDigits: outlierCut(histogram),
      modalDecimals: modeOf(decimalsBySymbol.get(symbol) ?? new Map()),
      declaredDecimals: [...(decimalsBySymbol.get(symbol) ?? new Map()).keys()].sort((a, b) => a - b),
    })
  }

  const usdByDay = new Map()
  const pricedByDay = new Map()
  const assetsByDay = new Map()
  const assets = new Map()
  const excluded = []
  const excludedByReason = new Map()
  let includedUsd = 0
  let excludedUsd = 0

  for (const row of candidates) {
    const stats = profile.get(row.symbol)
    const comparable = stats && stats.support >= OUTLIER_MIN_SUPPORT

    let reason = null
    if (comparable && row.decimals !== null && stats.modalDecimals !== null && row.decimals !== stats.modalDecimals) {
      reason = 'decimals-disagree'
    } else if (stats && row.digits >= stats.cutDigits) {
      reason = 'magnitude-outlier'
    } else if (row.usd > CEILING_USD) {
      reason = 'over-ceiling'
    }

    const asset = assets.get(row.symbol) ?? {
      symbol: row.symbol,
      decimals: stats?.modalDecimals ?? row.decimals,
      // More than one exponent for one symbol in one window: at most one of them is right,
      // and the page says which symbols are in that state rather than averaging over it.
      declaredDecimals: stats?.declaredDecimals ?? [],
      messages: 0,
      usd: 0,
      excluded: 0,
    }
    asset.messages += 1
    assets.set(row.symbol, asset)

    if (reason) {
      excludedUsd += row.usd
      asset.excluded += 1
      bump(excludedByReason, reason)
      excluded.push({
        ...row,
        reason,
        cutDigits: stats && Number.isFinite(stats.cutDigits) ? stats.cutDigits : null,
        modalDecimals: stats?.modalDecimals ?? null,
        peers: stats?.support ?? null,
      })
      continue
    }

    includedUsd += row.usd
    asset.usd += row.usd
    bump(usdByDay, row.date, row.usd)
    bump(pricedByDay, row.date)
    if (!assetsByDay.has(row.date)) assetsByDay.set(row.date, new Map())
    bump(assetsByDay.get(row.date), row.symbol, row.usd)
    const corridor = corridors.get(pairKey(row.from, row.to))
    if (corridor) {
      corridor.usd += row.usd
      corridor.priced += 1
    }
  }

  /* the covered window, which is not the requested one when the budget ran out ------------- */

  const observedDays = [...messagesByDay.keys()].sort()
  const coveredFrom = observedDays[0] ?? start_date
  const coveredTo = observedDays.at(-1) ?? end_date

  // Empty days inside the COVERED range are drawn; days outside it are not invented. A day we
  // never read is not a day with no value, and filling it with a zero would say it was.
  const daily = daySpan(coveredFrom, coveredTo).map((date) => ({
    date,
    messages: messagesByDay.get(date) ?? 0,
    priced: pricedByDay.get(date) ?? 0,
    usd: usdByDay.get(date) ?? 0,
    byAsset: Object.fromEntries(assetsByDay.get(date) ?? []),
  }))

  const chainList = [...chains]
    .map(([name, entry]) => {
      const ranked = [...entry.paraIds].sort((a, b) => b[1] - a[1])
      const [paraToken, agreeing] = ranked[0] ?? [null, 0]
      const total = ranked.reduce((sum, [, n]) => sum + n, 0)
      return {
        name,
        // The relay chain arrives with the literal string `relay` in the para id field, not a
        // number. `Number('relay')` is NaN, which serialises to `null` through JSON and then
        // reads on the page as "no para id recorded" — a different fact. Keep the token.
        paraToken,
        paraId: paraToken !== null && /^\d+$/.test(paraToken) ? Number(paraToken) : null,
        sent: entry.sent,
        received: entry.received,
        messages: entry.sent + entry.received,
        // Dotlake's own `origin_para_id`/`dest_para_id` disagrees with its own chain name on a
        // small minority of rows — para 1000 arrives labelled `polkadot-bridgehub`, para 2034
        // labelled `astar`. The NAME is the field that holds up, so it is the key here and the
        // disagreement is counted rather than resolved.
        paraIdConflicts: total - agreeing,
        paraIdRows: total,
      }
    })
    .sort((a, b) => b.messages - a.messages)

  return {
    window: { relay_chain, start_date, end_date },
    coverage: {
      matching,
      read: coverage.read,
      pages: coverage.pages,
      complete: coverage.complete && coverage.read >= Math.min(matching, XCM_PAGE_BUDGET * XCM_ROW_PAGE),
      budget: XCM_PAGE_BUDGET * XCM_ROW_PAGE,
      coveredFrom,
      coveredTo,
      firstAt,
      lastAt,
    },
    liveness: liveness({
      source: 'dotlake',
      label: 'Dotlake (Parity)',
      headAt: lastAt,
      head: lastAt === null ? null : new Date(lastAt).toISOString(),
      covers: { from: coveredFrom, to: coveredTo },
      // Dotlake is a batch warehouse over many chains, not a head-follower. Six hours behind is
      // ordinary; a day behind is not, and the 7-day hole of July 2026 must not read as `live`.
      staleAfterMs: 6 * 60 * 60_000,
      frozenAfterMs: 48 * 60 * 60_000,
    }),
    rules: {
      ceilingUsd: CEILING_USD,
      outlierDecades: OUTLIER_DECADES,
      outlierMinSupport: OUTLIER_MIN_SUPPORT,
      outlierMaxShare: OUTLIER_MAX_SHARE,
      reasons: Object.fromEntries(excludedByReason),
    },
    totals: {
      messages: coverage.read,
      noAsset,
      unpriced,
      valued: candidates.length,
      included: candidates.length - excluded.length,
      excluded: excluded.length,
      includedUsd,
      excludedUsd,
    },
    daily,
    assets: [...assets.values()].sort((a, b) => b.usd - a.usd),
    chains: chainList,
    corridors: [...corridors.values()].sort((a, b) => b.messages - a.messages),
    excluded: excluded.sort((a, b) => b.usd - a.usd).slice(0, EXCLUDED_SAMPLE),
    xcmTypes: Object.fromEntries(xcmTypes),
    outcomes: Object.fromEntries(outcomes),
    matchStatus: Object.fromEntries(matchStatus),
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

    // The only XCM operation that reads ROWS. Everything else on this source is somebody
    // else's aggregate; this one is our arithmetic, which is what makes it possible to say
    // which rows were left out and why. See the block above `xcmValue`.
    'xcm-value': {
      summary:
        'Value moved, computed row by row with a stated exclusion rule, plus the origin×destination matrix and the corridor graph.',
      ttlMs: 900_000,
      schema: {
        relay_chain: RELAY,
        start_date: { type: 'date', required: true },
        end_date: { type: 'date', required: true },
      },
      run: xcmValue,
    },

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

