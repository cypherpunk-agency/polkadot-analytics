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

const DAY_MS = 86_400_000

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
export const dayMs = (day) => Date.parse(`${day}T00:00:00Z`)

/**
 * Planck (a decimal string, exact) to whole tokens. `null` stays `null`.
 *
 * `decimals` is an ARGUMENT and not a module constant, and that is the one thing in this file
 * that is worth a paragraph. DOT is 10 decimals and KSM is 12 — both chains of each network say
 * so in `system_properties`, and the server asserts it on every read — so a divisor baked in
 * here is a factor of 100 on every Kusama figure on the page, in the direction that makes the
 * numbers bigger and no less plausible. Karura's 2022 peak is 169,884 KSM; with the DOT divisor
 * it draws as 17.0 M, with a correctly shaped line, a correctly shaped axis and a correct
 * ranking.
 */
export const units = (raw, decimals) => {
  if (raw === null || raw === undefined) return null
  if (!Number.isInteger(decimals)) throw new Error(`units: decimals must be an integer, got ${decimals}`)
  return Number(BigInt(raw)) / 10 ** decimals
}

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
 * @param {number} args.decimals                              10 for DOT, 12 for KSM — required
 */
export function buildSeries({ months, tail, firstDay, decimals }) {
  if (!Number.isInteger(decimals)) {
    throw new Error(`buildSeries: decimals must be an integer, got ${decimals}. DOT is 10 and KSM is 12; a wrong one is a factor of 100 that renders perfectly.`)
  }
  const amount = (raw) => units(raw, decimals)
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
  let dustMax = 0
  let dustFloor = null
  let listedMax = 0

  days.forEach((date, i) => {
    const day = byDate.get(date)
    if (!day) {
      relayLeg.push(null)
      assetHubLeg.push(null)
      totalLine.push(null)
      return
    }
    relayLeg.push(amount(day.totals.relay))
    assetHubLeg.push(amount(day.totals.assetHub))
    totalLine.push(amount(day.totals.total))
    dustDaysMax = Math.max(dustDaysMax, day.dust?.chains ?? 0)
    dustMax = Math.max(dustMax, (amount(day.dust?.relay ?? '0') ?? 0) + (amount(day.dust?.assetHub ?? '0') ?? 0))
    // The floor the SERVER actually used, read back out of the day rather than restated here.
    // It is a fixed planck amount, so it is 1 DOT and 0.01 KSM, and a page constant would be
    // wrong on one of the two networks while looking right on both.
    if (day.dust?.floor !== undefined && dustFloor === null) dustFloor = amount(day.dust.floor)
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
      const relay = relayRaw === null ? 0 : amount(relayRaw)
      const assetHub = ahRaw === null ? 0 : amount(ahRaw)
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
    coverage: { ...coverage, days: days.length, present, missing: days.length - present, dustDaysMax, dustMax, dustFloor, listedMax },
    first: days[0] ?? null,
    firstPresent,
    last,
    latest: last ? byDate.get(last) : null,
  }
}

/**
 * How much absolute error the archive's own storage can produce, in whole tokens.
 *
 * `src/data/netflows.json` stores every balance rounded half-up to TWO decimal places, on both
 * networks, so any single value can be out by up to half of the last place. That is the entire
 * explanation for most of the disagreement below, and it has to be measured in ABSOLUTE terms:
 * a relative verdict is dominated by the smallest balance in the overlap, and the two networks'
 * smallest balances are three orders of magnitude apart. Polkadot's is 1.23 DOT, where 0.005
 * rounds to a 0.25% deviation; Kusama's is 0.03 KSM, where the SAME 0.005 rounds to 7.3%. Two
 * readings that agree to the planck therefore score as "agrees" on one network and "disagrees on
 * a third of the chain-days" on the other, and the number that moved was the denominator.
 */
export const ARCHIVE_QUANTUM = 0.005

/**
 * The archive, checked against the re-derived series day by day.
 *
 * This is the reason the 2023 file is still compiled into the page. Two independent readings of
 * the same past — one taken in 2023 by different code, one taken now from the chain — either
 * agree or they do not, and the answer belongs on the page either way.
 *
 * TWO measures come out of it, and the page needs both. `deviation` is relative, with the
 * ARCHIVE as the denominator, and it is what a reader wants to see on a row. `gap` is the
 * absolute difference in whole tokens, and it is what the VERDICT is taken on, because it is the
 * only one of the two that the archive's rounding bounds — see `ARCHIVE_QUANTUM` above.
 *
 * A chain-day where the archive is `null` (that chain had not appeared yet) is skipped rather
 * than scored: it is not a disagreement, it is one of the two readings declining to say anything.
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
      rows.push({ date: network.days[i], name: chain.name, archived, value: relay, assetHub, deviation, gap: Math.abs(relay - archived) })
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
    const byGap = [...list].sort((a, b) => b.gap - a.gap)
    return {
      pairs: list.length,
      median: sorted[Math.floor(sorted.length / 2)].deviation,
      // Relative, and reported rather than judged on: 0.01% is roughly what two-decimal
      // rounding produces on a mid-sized balance, but on a 0.03-token one it produces 7%.
      over: list.filter((row) => row.deviation > 0.0001).length,
      max: sorted[sorted.length - 1].deviation,
      // Absolute, and what the verdict is taken on. `beyondQuantum` is the count of chain-days
      // whose difference is LARGER than the archive's own two-decimal storage can explain —
      // i.e. the ones that are a real disagreement between two readings rather than an artefact
      // of the file's precision.
      maxGap: byGap[0].gap,
      beyondQuantum: list.filter((row) => row.gap > ARCHIVE_QUANTUM).length,
      worstGap: byGap.slice(0, 5),
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
