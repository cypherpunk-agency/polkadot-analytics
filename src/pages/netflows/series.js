// The netflows series, as arithmetic — no DOM, no fetch, no design system.
//
// Everything on `/netflows/` that could be WRONG rather than merely ugly lives here: stitching
// fifty-odd stored months and one live tail into one continuous day axis, deciding what a
// missing day means, and comparing the result against the 2023 archive. Splitting it out of
// `main.js` is what makes those testable without a browser — see
// `server/test/netflows-series.test.mjs`, which runs them against fixtures and against the
// shapes the API actually returns.
//
// Two rules run through all of it, and both are from CLAUDE.md:
//
//   · `null` is not `0`. A day nobody has fetched is a gap; a chain below the server's dust
//     floor is a zero. Collapsing them would turn "we do not have this yet" into "there was
//     nothing here", which is the one mistake this page exists to avoid.
//   · Empty days are drawn, not dropped. The axis spans the whole series, not the part that
//     happens to be present, so a half-filled store reads as half-filled rather than as short.

const PLANCK = 1e10
const DAY_MS = 86_400_000

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
export const dayMs = (day) => Date.parse(`${day}T00:00:00Z`)

/** Planck (a decimal string, exact) to whole DOT. `null` stays `null`. */
export const dot = (raw) => (raw === null || raw === undefined ? null : Number(BigInt(raw)) / PLANCK)

/** Every month from `first` to `last` inclusive, as `YYYY-MM`. */
export function monthsBetween(first, last) {
  const months = []
  let [year, index] = first.split('-').map(Number)
  for (;;) {
    const month = `${year}-${String(index).padStart(2, '0')}`
    if (month > last) break
    months.push(month)
    index += 1
    if (index > 12) {
      index = 1
      year += 1
    }
  }
  return months
}

/**
 * One continuous daily series out of stored months and one live tail.
 *
 * The day axis runs from `firstDay` to the newest day anything returned — NOT from the first day
 * that happens to be present. A store that has filled six months of fifty-five must draw as six
 * months inside a four-year span, because "we do not have this yet" and "there was nothing here"
 * are different facts and only the first is temporary.
 *
 * @param {object} args
 * @param {Array<{month: string, body: object}>} args.months  store envelopes, one per month
 * @param {object|null} args.tail                             the live `sovereign-dot-recent` payload
 * @param {string} args.firstDay                              ISO date the axis starts at
 */
export function buildSeries({ months, tail, firstDay }) {
  const byDate = new Map()
  const coverage = { complete: 0, partial: 0, jobs: [], months: months.length }

  for (const { body } of months) {
    if (body?.coverage?.complete) coverage.complete += 1
    else coverage.partial += 1
    if (body?.job) coverage.jobs.push(body.job)
    for (const fact of body?.data ?? []) {
      if (fact?.payload?.date) byDate.set(fact.payload.date, fact.payload)
    }
  }
  for (const day of tail?.days ?? []) byDate.set(day.date, day)

  const dates = [...byDate.keys()].sort()
  const last = dates[dates.length - 1] ?? null
  const days = []
  if (last) for (let at = dayMs(firstDay); at <= dayMs(last); at += DAY_MS) days.push(isoDay(at))

  // Per-chain totals, plus the two legs summed across every chain — the migration, in two lines.
  const byPara = new Map()
  const relayLeg = []
  const assetHubLeg = []
  const totalLine = []
  let dustDaysMax = 0
  let dustDotMax = 0
  let listedMax = 0

  days.forEach((date, i) => {
    const day = byDate.get(date)
    if (!day) {
      relayLeg.push(null)
      assetHubLeg.push(null)
      totalLine.push(null)
      return
    }
    relayLeg.push(dot(day.totals.relay))
    assetHubLeg.push(dot(day.totals.assetHub))
    totalLine.push(dot(day.totals.total))
    dustDaysMax = Math.max(dustDaysMax, day.dust?.chains ?? 0)
    dustDotMax = Math.max(dustDotMax, (dot(day.dust?.relay ?? '0') ?? 0) + (dot(day.dust?.assetHub ?? '0') ?? 0))
    listedMax = Math.max(listedMax, day.chains?.length ?? 0)
    for (const [paraId, relayRaw, ahRaw] of day.chains ?? []) {
      let entry = byPara.get(paraId)
      if (!entry) {
        entry = {
          paraId,
          values: new Array(days.length).fill(null),
          // The two legs are kept apart per chain as well as in the totals, because the 2023
          // archive measured the RELAY leg alone and comparing against the sum would score the
          // Asset Hub leg as a disagreement. See `crossCheck` below.
          relayValues: new Array(days.length).fill(null),
          assetHubValues: new Array(days.length).fill(null),
          firstIndex: i,
        }
        byPara.set(paraId, entry)
      }
      const relay = relayRaw === null ? 0 : dot(relayRaw)
      const assetHub = ahRaw === null ? 0 : dot(ahRaw)
      entry.relayValues[i] = relay
      entry.assetHubValues[i] = assetHub
      entry.values[i] = relay + assetHub
    }
  })

  // A chain that has appeared and is then absent from a day we DO hold is below the server's
  // dust floor (or has no account at all) — which is zero at this scale, not a gap. Before its
  // first appearance it is genuinely absent, and its line does not start.
  for (const entry of byPara.values()) {
    for (let i = entry.firstIndex; i < days.length; i += 1) {
      if (entry.values[i] !== null || !byDate.has(days[i])) continue
      entry.values[i] = 0
      entry.relayValues[i] = 0
      entry.assetHubValues[i] = 0
    }
    const seen = entry.values.filter((v) => v !== null)
    entry.peak = seen.length ? Math.max(...seen) : 0
    entry.peakOn = days[entry.values.indexOf(entry.peak)] ?? null
    entry.last = null
    entry.lastOn = null
    for (let i = days.length - 1; i >= 0; i -= 1) {
      if (entry.values[i] !== null) {
        entry.last = entry.values[i]
        entry.lastOn = days[i]
        break
      }
    }
  }

  const chains = [...byPara.values()].sort((a, b) => b.peak - a.peak)
  const present = days.filter((day) => byDate.has(day)).length
  const firstPresent = days.find((day) => byDate.has(day)) ?? null

  return {
    days,
    byDate,
    chains,
    legs: { relay: relayLeg, assetHub: assetHubLeg, total: totalLine },
    coverage: { ...coverage, days: days.length, present, missing: days.length - present, dustDaysMax, dustDotMax, listedMax },
    first: days[0] ?? null,
    firstPresent,
    last,
    latest: last ? byDate.get(last) : null,
  }
}

/**
 * The archive, checked against the re-derived series day by day.
 *
 * This is the reason the 2023 file is still compiled into the page. Two independent readings of
 * the same past — one taken in 2023 by different code, one taken now from the chain — either
 * agree or they do not, and the answer belongs on the page either way.
 *
 * Deviation is relative and the ARCHIVE is the denominator. A chain-day where the archive is
 * `null` (that chain had not appeared yet) is skipped rather than scored: it is not a
 * disagreement, it is one of the two readings declining to say anything.
 *
 * @param {ReturnType<typeof buildSeries>} series
 * @param {object} network             the archive's network block from netflows.json
 * @param {(name: string) => number|null} paraIdOf  archive chain name → para id
 */
export function crossCheck(series, network, paraIdOf) {
  const rows = []
  let assetHubPairs = 0
  let assetHubMaxShare = 0
  for (const chain of network.chains) {
    const paraId = paraIdOf(chain.name)
    if (paraId === null || paraId === undefined) continue
    const mine = series.chains.find((c) => c.paraId === paraId)
    if (!mine) continue
    for (let i = 0; i < network.days.length; i += 1) {
      const archived = chain.series[i]
      if (archived === null || archived === undefined) continue
      const index = series.days.indexOf(network.days[i])
      if (index < 0) continue
      const relay = mine.relayValues[index]
      if (relay === null || relay === undefined) continue
      const assetHub = mine.assetHubValues[index] ?? 0
      if (assetHub > 0) {
        assetHubPairs += 1
        const share = assetHub / (relay + assetHub)
        if (share > assetHubMaxShare) assetHubMaxShare = share
      }
      const deviation = archived === 0 ? (relay === 0 ? 0 : 1) : Math.abs(relay - archived) / archived
      rows.push({ date: network.days[i], name: chain.name, archived, value: relay, assetHub, deviation })
    }
  }
  if (!rows.length) return null

  // The archive's LAST day is not a whole day. Its own coverage caveat says the captures run
  // eight days past the report's window, and the final row is the last observation in the CSV
  // rather than that day's close — so it is scored separately instead of being averaged into a
  // verdict about the other 430.
  const finalDay = network.last
  const body = rows.filter((row) => row.date !== finalDay)
  const tail = rows.filter((row) => row.date === finalDay)

  const summarise = (list) => {
    if (!list.length) return null
    const sorted = [...list].sort((a, b) => a.deviation - b.deviation)
    return {
      pairs: list.length,
      median: sorted[Math.floor(sorted.length / 2)].deviation,
      // 0.01% is the ceiling the archive's own two-decimal rounding can produce on the smallest
      // balance it records. Anything past it is a real difference between the two readings.
      over: list.filter((row) => row.deviation > 0.0001).length,
      max: sorted[sorted.length - 1].deviation,
      worst: [...list].sort((a, b) => b.deviation - a.deviation).slice(0, 5),
    }
  }

  const dates = [...new Set(rows.map((row) => row.date))].sort()
  return {
    pairs: rows.length,
    days: dates.length,
    chains: new Set(rows.map((row) => row.name)).size,
    from: dates[0],
    to: dates[dates.length - 1],
    finalDay,
    body: summarise(body),
    tail: summarise(tail),
    // What the 2023 study could not have seen: the `sibl` leg on Asset Hub did not hold a
    // parachain's DOT reserve then, but it was not empty either, and this series adds it.
    assetHub: { pairs: assetHubPairs, maxShare: assetHubMaxShare },
  }
}
