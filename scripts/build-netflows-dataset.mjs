// Derive `src/data/netflows.json` from the raw Polkalytics parachain-netflows CSVs.
//
// The 2023 study (https://github.com/Polkalytics/parachain-netflows) shipped 45 MB of raw
// balance-change rows and 12 MB of pre-rendered plotly HTML. Neither can live in this repo:
// the CSVs are too big to commit for an archived chart, and the plotly output relies on
// inline <script> blocks that our CSP forbids. So we re-derive a small, committed dataset
// and draw the chart ourselves.
//
// The source is READ-ONLY. This script never writes outside src/data/.
//
//   node scripts/build-netflows-dataset.mjs [path-to-parachain-netflows]

import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_FILE = join(REPO, 'src', 'data', 'netflows.json')

const DEFAULT_SOURCE = 'D:/Code/web3/parachain-netflows'
const SOURCE_REPO = 'https://github.com/Polkalytics/parachain-netflows'
const SOURCE_REPORT = 'Polkadot Parachain Netflows until March 2023 — Polkalytics, Tommi Enenkel'

// Rendered verbatim on the public page. Every number below was verified against the raw CSVs
// with a computation independent of this script; keep it that way if you edit them.
const CAVEATS = {
  resampling:
    "Each day's value is the last balance observed at or before the end of that UTC day, so a spike that rose and reversed inside a single day leaves no trace in the daily series. The loss is uneven, and for some chains it is severe: Polkadot's Bifrost line tops out at 87,651.29 DOT against a true peak of 194,647.15, understating its high by 54.97%, and Acala loses 10.26% the same way, while Interlay and Equilibrium lose nothing at all. Every chain carries its own `clipped` fraction — check it before reading a line's height as the most that chain ever held.",
  coverage:
    "The captures do not stop where the report does — polkadot.csv runs to 2023-04-08, eight days past the report's March 2023 window, and kusama.csv ends 2023-03-12 — so each chain's `last` value is its balance at the end of the available data rather than the closing figure quoted in the report.",
  filter:
    'Parachains are included on the same basis as the original study: the balance at the final observation must exceed 10,000 DOT on Polkadot or 1,000 KSM on Kusama. The threshold is on the last balance, not the peak, so a parachain that once held a large amount and later emptied out is deliberately absent.',
}

const REPORT_DISCREPANCIES = [
  {
    claim: 'Moonriver "reached a peak of 160k KSM in November 2022".',
    data: "Moonriver's highest observed balance is 155,701.12 KSM, reached on 2022-11-20.",
    note: 'The month is right and the gap is under 3%, so the figure was most likely read off the chart rather than computed from the data.',
  },
  {
    claim: 'The Polkadot section names seven parachains and puts "Bifrost and Equilibrium" in the 100k DOT range.',
    data: 'Eight Polkadot parachains clear the 10,000 DOT threshold. The eighth is HydraDX, which peaked at 120,801.22 DOT and ends the period on 107,979.72 DOT — more than either Bifrost (68,268.53 DOT) or Equilibrium (35,719.68 DOT), the two that sentence does name — yet it appears nowhere in the report.',
    note: "This filter reproduces the study's own code exactly, so it reads as an omission in the prose rather than a difference in the underlying data.",
  },
  {
    claim: 'The report is titled and framed as covering balances until March 2023.',
    data: 'polkadot.csv contains 2,605 rows dated after 2023-03-31 and runs through 2023-04-08.',
    note: 'The CSVs are dated 24 April 2023, so the raw data was evidently re-pulled after the report was written; values quoted for March can differ from this dataset, as with Astar at 146,669.96 DOT on 2023-03-31 against 130,202.91 DOT on 2023-04-08.',
  },
]

// Mirrors main.py exactly. The min-balance thresholds are not arbitrary rounding: they are
// the filter the published charts used ("at least 10_000 DOT / 1_000 KSM at the time of the
// last snapshot"), so reproducing them is what makes our chart the same chart.
const NETWORKS = [
  { key: 'polkadot', token: 'DOT', decimals: 10, minBalance: 10000n },
  { key: 'kusama', token: 'KSM', decimals: 12, minBalance: 1000n },
]

const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' → whole UTC days since epoch. Parsed by hand because `new Date(str)` on a
 *  bare date is UTC-midnight but on a datetime is local — and every timestamp here is UTC. */
const toEpochDay = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS

const fromEpochDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10)

/** Planck (BigInt, because 3.5m DOT is 3.5e16 and overflows Number.MAX_SAFE_INTEGER) →
 *  whole tokens rounded half-up to 2 decimals. 2dp on a million-token balance is noise-level
 *  precision and roughly halves the file. */
const toTokens = (planck, unit) => Number((planck * 200n + unit) / (unit * 2n)) / 100

const readLabels = async (file) => {
  const text = await readFile(file, 'utf8')
  const labels = new Map()
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const comma = line.indexOf(',')
    labels.set(line.slice(comma + 1).trim(), line.slice(0, comma).trim())
  }
  return labels
}

/**
 * One streaming pass over a values CSV.
 *
 * Rows are NOT sorted (polkadot.csv opens with descending block numbers), so we cannot assume
 * arrival order and instead keep, per address per UTC day, the row with the highest block —
 * i.e. the end-of-day balance.
 */
const scanValues = async (file, unit) => {
  const accounts = new Map()
  let rows = 0

  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  let header = true
  for await (const line of lines) {
    if (header) {
      header = false
      if (!line.startsWith('address,block_number,balance,timestamp')) throw new Error(`unexpected header in ${file}: ${line}`)
      continue
    }
    if (!line) continue

    // Hand-split rather than a CSV parser: no field in these files is ever quoted or contains
    // a comma, and this runs 450k times.
    const a = line.indexOf(',')
    const b = line.indexOf(',', a + 1)
    const c = line.indexOf(',', b + 1)
    const address = line.slice(0, a)
    const block = +line.slice(a + 1, b)
    const planck = BigInt(line.slice(b + 1, c))
    const day = line.slice(c + 1, c + 11) // 'YYYY-MM-DD' — kusama rows carry milliseconds, polkadot ones do not
    rows++

    let acct = accounts.get(address)
    if (!acct) {
      acct = { address, byDay: new Map(), firstDay: day, lastDay: day, lastBlock: block, lastPlanck: planck, peakPlanck: planck, observations: 0 }
      accounts.set(address, acct)
    }
    acct.observations++
    if (day < acct.firstDay) acct.firstDay = day
    if (block > acct.lastBlock) {
      acct.lastBlock = block
      acct.lastPlanck = planck
      acct.lastDay = day
    }
    if (planck > acct.peakPlanck) acct.peakPlanck = planck

    const held = acct.byDay.get(day)
    if (!held || block > held.block) acct.byDay.set(day, { block, planck })
  }

  return { accounts, rows, unit }
}

const buildNetwork = async (net, sourceDir) => {
  const unit = 10n ** BigInt(net.decimals)
  const [labels, scan] = await Promise.all([
    readLabels(join(sourceDir, 'data', 'in', `${net.key}_labels.csv`)),
    scanValues(join(sourceDir, 'data', 'in', `${net.key}.csv`), unit),
  ])

  // main.py's filter: the balance at the LAST snapshot, strictly above the threshold. Note it
  // is the *last* balance, not the peak — a parachain that held a lot and then emptied out is
  // deliberately absent from the published chart, and so it is absent here.
  const kept = [...scan.accounts.values()].filter((a) => a.lastPlanck > net.minBalance * unit)

  const days = []
  let lo = Infinity
  let hi = -Infinity
  for (const a of kept) {
    lo = Math.min(lo, toEpochDay(a.firstDay))
    hi = Math.max(hi, toEpochDay(a.lastDay))
  }
  for (let d = lo; d <= hi; d++) days.push(fromEpochDay(d))

  const chains = kept.map((a) => {
    const series = []
    let carried = null
    for (const day of days) {
      const observed = a.byDay.get(day)
      if (observed) carried = toTokens(observed.planck, unit)
      // Carry forward, never interpolate: these are balances (a step function), not samples of
      // a continuous quantity. A week with no extrinsic is a week at the same balance, and
      // drawing a slope across it would invent flows that never happened.
      //
      // Before the account's first observation `carried` is still null, and null it stays:
      // "the parachain did not exist yet" and "the parachain held 0 DOT" are different facts,
      // and a 0 would draw a flat line along the axis for months of pre-history.
      series.push(carried)
    }
    const peak = toTokens(a.peakPlanck, unit)
    const dailyPeak = Math.max(...series.filter((v) => v !== null))
    return {
      name: labels.get(a.address) ?? a.address,
      address: a.address,
      // Three peak-related numbers, because they answer different questions and none of them
      // substitutes for the others:
      //   peak      — highest balance over ALL observations. This is the true peak and the one
      //               the report's narrative quotes, so it is what a reader wants to be told.
      //   dailyPeak — highest value in `series`. Anything drawn against the daily series (an
      //               annotation, a bar, a y-axis bound) must use this one, or it will sit above
      //               the very line it annotates whenever a spike reversed inside a single day.
      //   clipped   — how much of the true peak the daily series hides, as a fraction of `peak`.
      //               Surfaced per series because the loss is wildly uneven: Polkadot Bifrost
      //               hides 55% of its peak, Interlay and Equilibrium hide none. A reader
      //               otherwise has no way to tell an understated line from a faithful one.
      // peak >= dailyPeak always, so `clipped` is always in [0, 1].
      peak,
      dailyPeak,
      // 4dp is ~0.01 percentage points — finer than the underlying 2dp balances justify, and it
      // keeps float noise like 0.5496800000000001 out of a committed file.
      clipped: peak > 0 ? Math.round(((peak - dailyPeak) / peak) * 1e4) / 1e4 : 0,
      last: toTokens(a.lastPlanck, unit),
      series,
    }
  })

  // Ranked by the true peak, matching the `peak` field a reader sees next to the name.
  chains.sort((x, y) => y.peak - x.peak)

  // Kept out of the committed file — only the sanity report below consumes it.
  const qa = new Map(chains.map((c) => [c.name, { labelled: labels.has(c.address) }]))

  return {
    rows: scan.rows,
    accountsSeen: scan.accounts.size,
    qa,
    network: {
      token: net.token,
      decimals: net.decimals,
      first: days[0],
      last: days[days.length - 1],
      chains,
      days,
    },
  }
}

/** JSON.stringify(…, 2) would put one number per line and inflate `series` ~8x. Keep objects
 *  readable in diffs, keep primitive arrays on one line. */
const pretty = (value, indent = '') => {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value)
    const inner = `${indent}  `
    return `[\n${value.map((v) => inner + pretty(v, inner)).join(',\n')}\n${indent}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) return '{}'
    const inner = `${indent}  `
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${pretty(value[k], inner)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

const main = async () => {
  const sourceDir = resolve(process.argv[2] ?? DEFAULT_SOURCE)
  console.log(`source: ${sourceDir}`)

  const built = {}
  for (const net of NETWORKS) {
    const t0 = Date.now()
    built[net.key] = await buildNetwork(net, sourceDir)
    const b = built[net.key]
    const unlabelled = [...b.qa].filter(([, q]) => !q.labelled).map(([name]) => name)
    console.log(
      `${net.key.padEnd(8)} read ${b.rows} rows / ${b.accountsSeen} accounts → ` +
        `${b.network.chains.length} chains above ${net.minBalance} ${net.token}, ` +
        `${b.network.days.length} days (${b.network.first} … ${b.network.last}) in ${Date.now() - t0}ms`,
    )
    if (unlabelled.length) console.warn(`  WARNING ${net.key}: ${unlabelled.length} kept address(es) have no label: ${unlabelled.join(', ')}`)
  }

  const dataset = {
    generated: new Date().toISOString().slice(0, 10),
    source: {
      repo: SOURCE_REPO,
      report: SOURCE_REPORT,
      rows: { polkadot: built.polkadot.rows, kusama: built.kusama.rows },
      caveats: CAVEATS,
    },
    reportDiscrepancies: REPORT_DISCREPANCIES,
    networks: Object.fromEntries(Object.entries(built).map(([key, b]) => [key, b.network])),
  }

  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, `${pretty(dataset)}\n`, 'utf8')
  const { size } = await stat(OUT_FILE)
  console.log(`\nwrote ${OUT_FILE} — ${(size / 1024).toFixed(1)} KB`)

  // Read back from disk rather than trusting the in-memory object: this catches a serializer
  // bug (the hand-rolled `pretty` above) that would otherwise ship silently.
  const back = JSON.parse(await readFile(OUT_FILE, 'utf8'))
  console.log('\n=== sanity ===')
  for (const [key, net] of Object.entries(back.networks)) {
    console.log(`\n${key}  ${net.token}  chains=${net.chains.length}  days=${net.days.length}  ${net.first} … ${net.last}`)
    if (net.days.length !== new Set(net.days).size) console.error('  ERROR: duplicate days')
    console.log('  rank  chain                 peak (full-res)   peak (daily)  clipped           last  nulls  1st day')
    for (const [i, c] of net.chains.slice(0, 5).entries()) {
      const nulls = c.series.filter((v) => v === null).length
      if (c.series.length !== net.days.length) console.error(`  ERROR: ${c.name} series length ${c.series.length} != ${net.days.length} days`)
      if (c.series[c.series.length - 1] !== c.last) console.error(`  ERROR: ${c.name} last ${c.last} != final series value ${c.series[c.series.length - 1]}`)
      // Read back from the file, so this also proves the derived fields survived serialization.
      if (c.dailyPeak !== Math.max(...c.series.filter((v) => v !== null))) console.error(`  ERROR: ${c.name} dailyPeak != max(series)`)
      if (c.peak < c.dailyPeak) console.error(`  ERROR: ${c.name} peak ${c.peak} < dailyPeak ${c.dailyPeak}`)
      // Tolerance is the 4dp rounding applied above, nothing looser — this must catch a
      // `clipped` that drifted from the two fields it claims to summarise.
      const expected = c.peak > 0 ? (c.peak - c.dailyPeak) / c.peak : 0
      if (Math.abs(c.clipped - expected) > 5e-5) console.error(`  ERROR: ${c.name} clipped ${c.clipped} != (peak-dailyPeak)/peak ${expected}`)
      if (c.clipped < 0 || c.clipped > 1) console.error(`  ERROR: ${c.name} clipped ${c.clipped} outside [0,1]`)
      console.log(
        `  ${String(i + 1).padStart(4)}  ${c.name.padEnd(20)} ${String(c.peak).padStart(14)} ${String(c.dailyPeak).padStart(14)} ${`${(c.clipped * 100).toFixed(2)}%`.padStart(8)} ${String(c.last).padStart(14)} ${String(nulls).padStart(6)}  ${net.days[nulls]}`,
      )
    }
  }
}

await main()
