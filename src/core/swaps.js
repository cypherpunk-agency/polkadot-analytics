// The canonical swap dataset, and the one aggregation over it.
//
// HyperFX (intent orders bridged across five EVM chains) and Hydration (an Omnipool on a
// Polkadot parachain) have nothing in common at the protocol level. They have everything in
// common at the reporting level: somebody sent one asset and received another, at a time, on a
// venue. Normalising both into the shape below is what lets ONE renderer draw both pages —
// see docs/architecture/middleware.md.
//
// Adding a third venue means writing a normaliser that emits Trades. It does not mean writing
// another dashboard.

/**
 * @typedef {object} Trade
 * @property {string} id           unique within the venue
 * @property {string} account      the address that placed it, lowercased
 * @property {number} timestamp    epoch seconds
 * @property {string} date         UTC day, YYYY-MM-DD
 * @property {string} venue        where it executed — a chain name, or a pool type
 * @property {string} [destination] where it landed, when that differs from venue
 * @property {string|null} tokenIn
 * @property {string|null} tokenOut
 * @property {number} amountIn     human units, already decimal-adjusted
 * @property {number|null} usd     value of the input leg, or null when unpriceable
 * @property {string} [status]
 * @property {boolean} [failed]
 */

/** Statuses that mean the trade actually completed. Venue-specific values map onto these. */
const SETTLED = new Set(['FILLED', 'REDEEMED', 'COMPLETED', 'EXECUTED'])

const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const dayOf = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10)

const routeName = (trade) => (trade.tokenIn || '?') + '→' + (trade.tokenOut || '?')

/** Venues ordered by volume, so the busiest takes the first colour and the legend reads top-down. */
function venuesByVolume(trades) {
  const totals = new Map()
  for (const t of trades) totals.set(t.venue, (totals.get(t.venue) || 0) + (t.usd || 0))
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([venue, usd]) => ({ venue, usd }))
}

/**
 * Every calendar day between the first and last trade, INCLUDING the empty ones. A gap in
 * trading is information; dropping empty days compresses it out of the chart and makes a dead
 * fortnight look like a busy one.
 */
function dailySeries(trades, venues) {
  const byDay = new Map()
  for (const t of trades) {
    const day = byDay.get(t.date) || { date: t.date, usd: 0, count: 0, byVenue: {} }
    day.usd += t.usd || 0
    day.count += 1
    day.byVenue[t.venue] = (day.byVenue[t.venue] || 0) + (t.usd || 0)
    byDay.set(t.date, day)
  }

  const days = []
  const last = trades[trades.length - 1].date
  for (let d = trades[0].date; d <= last; d = addDays(d, 1)) {
    const hit = byDay.get(d)
    days.push({
      date: d,
      usd: hit ? hit.usd : 0,
      count: hit ? hit.count : 0,
      stack: venues.map((v) => (hit ? hit.byVenue[v.venue] || 0 : 0)),
    })
  }
  return days
}

function routes(trades) {
  const byRoute = new Map()
  for (const t of trades) {
    const name = routeName(t)
    const hit = byRoute.get(name) || { route: name, usd: 0, count: 0 }
    hit.usd += t.usd || 0
    hit.count += 1
    byRoute.set(name, hit)
  }
  return [...byRoute.values()].sort((a, b) => b.usd - a.usd)
}

/**
 * An account is the address on the trade. That is NOT the same as a person: some of these route
 * a partner's flow, and on Hydration several are pallet accounts rather than anyone at all.
 * The pages say so; the arithmetic cannot know the difference.
 */
function accounts(trades) {
  const byAccount = new Map()
  for (const t of trades) {
    const a = byAccount.get(t.account) || {
      account: t.account,
      usd: 0,
      count: 0,
      failed: 0,
      first: t.date,
      last: t.date,
      byVenue: {},
      byRoute: {},
    }
    a.usd += t.usd || 0
    a.count += 1
    if (t.failed) a.failed += 1
    if (t.date < a.first) a.first = t.date
    if (t.date > a.last) a.last = t.date
    a.byVenue[t.venue] = (a.byVenue[t.venue] || 0) + (t.usd || 0)
    const route = routeName(t)
    a.byRoute[route] = (a.byRoute[route] || 0) + 1
    byAccount.set(t.account, a)
  }

  const rank = (obj, unit) =>
    Object.entries(obj)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([k, v]) => k + ' ' + (unit === 'usd' ? Math.round(v).toLocaleString('en-US') : v))
      .join(' / ')

  return [...byAccount.values()]
    .map((a) => ({ ...a, venues: rank(a.byVenue, 'usd'), routes: rank(a.byRoute, 'n') }))
    .sort((a, b) => b.usd - a.usd)
}

function median(values) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * @param {object} input
 * @param {Trade[]} input.trades
 * @param {Record<string, number>} [input.rates]
 * @param {object} [input.meta]   provenance shown in the page footer — source, window, caveats
 */
export function aggregate({ trades, rates = {}, meta = {} }) {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  if (!sorted.length) {
    return { empty: true, meta, rates, venues: [], days: [], routes: [], accounts: [], concentration: [], totals: null }
  }

  const venues = venuesByVolume(sorted)
  const days = dailySeries(sorted, venues)
  const accts = accounts(sorted)
  const total = sorted.reduce((s, t) => s + (t.usd || 0), 0)

  const activeDays = days.filter((d) => d.count > 0)
  const peak = days.reduce((a, b) => (b.usd > a.usd ? b : a))
  const settled = sorted.filter((t) => !t.failed && (t.status === undefined || SETTLED.has(t.status))).length
  const failedUsd = sorted.filter((t) => t.failed).reduce((s, t) => s + (t.usd || 0), 0)
  const unpriced = sorted.filter((t) => t.usd === null).length

  // Share of total volume held by the top n accounts, for the concentration curve.
  let running = 0
  const concentration = accts.map((a, i) => {
    running += a.usd
    return { rank: i + 1, share: total ? (running / total) * 100 : 0 }
  })
  const shareOfTop = (n) => (concentration[Math.min(n, concentration.length) - 1] || {}).share || 0

  return {
    empty: false,
    meta,
    rates,
    venues,
    days,
    routes: routes(sorted),
    accounts: accts,
    concentration,
    totals: {
      usd: total,
      trades: sorted.length,
      accounts: accts.length,
      spanDays: days.length,
      activeDays: activeDays.length,
      peak: { date: peak.date, usd: peak.usd, count: peak.count },
      settled,
      settledShare: (settled / sorted.length) * 100,
      failedUsd,
      // Stated, never hidden. An unpriced trade is counted in the trade count and excluded
      // from the dollar total, so the two numbers disagree by exactly this much.
      unpricedTrades: unpriced,
      medianActiveDay: median(activeDays.map((d) => d.usd)),
      medianAccount: median(accts.map((a) => a.usd)),
      accountsUnderHundred: accts.filter((a) => a.usd < 100).length,
      topFourShare: shareOfTop(4),
      topFourUsd: accts.slice(0, 4).reduce((s, a) => s + a.usd, 0),
      topTenShare: shareOfTop(10),
      first: days[0].date,
      last: days[days.length - 1].date,
    },
  }
}

/**
 * Aggregates carry every account and every day, which for Hydration is tens of thousands of
 * rows. The page never draws more than the head of those lists, so the server trims before the
 * payload crosses the wire — the alternative is shipping several megabytes to draw fifty rows.
 *
 * The totals are computed BEFORE the trim and are not touched by it, so "top 4 share" stays a
 * share of everything rather than a share of what survived.
 */
export function trimForWire(result, { accounts: maxAccounts = 250, routes: maxRoutes = 40 } = {}) {
  if (result.empty) return result
  return {
    ...result,
    accountsTotal: result.accounts.length,
    accounts: result.accounts.slice(0, maxAccounts),
    routesTotal: result.routes.length,
    routes: result.routes.slice(0, maxRoutes),
    // The concentration curve is a cumulative share over ranks; past the first few hundred it
    // is a flat line at ~100%. Keeping the head preserves the only part that has shape.
    concentration: result.concentration.slice(0, 400),
  }
}
