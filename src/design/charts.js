// The chart kit. Hand-rolled, shared by every page. Mostly inline SVG; the ranked forms are
// DOM, because a list of rows wants to be a list of rows.
//
// No charting library. The production CSP forbids external scripts, and a 3 MB plotting bundle
// to draw a stacked bar chart would dominate the page weight of a site whose whole point is a
// few hundred numbers. More importantly, the forms here are chosen rather than configured:
// marks that fit the questions this site asks, and no dual-axis chart, ever. A new form needs
// an argument in docs/architecture/design-system.md, not just a use for it.
//
// Rules these follow, from docs/architecture/design-system.md:
//   · categorical colour is assigned in fixed slot order, never cycled; slot 9+ is grey
//   · bars are linear from zero and rounded only on the data end
//   · stacked segments carry a 1px surface-coloured stroke so adjacent hues stay separable
//   · a segmented bar states its total independently and SHOWS the shortfall when it disagrees
//   · every chart has a legend with values, and a table view exists on the page
//   · one y-axis

import { svg, el, append } from './dom.js'
import { money, compact } from '../core/format.js'

const SLOTS = 8

/**
 * Colour for series `i`. Past the eighth series everything is the same grey — a ninth hue
 * would be either indistinguishable from an existing one or outside the validated set, and a
 * repeated colour reads as a repeated thing.
 */
export const seriesColor = (i) => (i < SLOTS ? `var(--series-${i + 1})` : 'var(--series-rest)')

const VIEW = { w: 1000, h: 260 }
const PAD = { top: 12, right: 8, bottom: 22, left: 46 }

const plotBox = (view = VIEW) => ({
  x: PAD.left,
  y: PAD.top,
  w: view.w - PAD.left - PAD.right,
  h: view.h - PAD.top - PAD.bottom,
})

/** A "nice" axis maximum: 1, 2 or 5 times a power of ten, so gridline labels are readable. */
function niceMax(value) {
  if (!(value > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const scaled = value / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * magnitude
}

function axis(root, box, max, { format = compact, lines = 4 } = {}) {
  for (let i = 0; i <= lines; i += 1) {
    const value = (max / lines) * i
    const y = box.y + box.h - (value / max) * box.h
    root.append(
      svg('line.grid-line', { x1: box.x, x2: box.x + box.w, y1: y, y2: y }),
      svg('text.axis-text', { x: box.x - 6, y: y + 3, 'text-anchor': 'end', text: format(value) }),
    )
  }
  root.append(svg('line.axis-line', { x1: box.x, x2: box.x + box.w, y1: box.y + box.h, y2: box.y + box.h }))
}

/** Date labels only where they fit — roughly eight across, always including the last day. */
function dateTicks(root, box, days, step) {
  const every = Math.max(1, Math.ceil(days.length / 8))
  days.forEach((day, i) => {
    if (i % every !== 0 && i !== days.length - 1) return
    root.append(
      svg('text.axis-text', {
        x: box.x + i * step + step / 2,
        y: box.y + box.h + 14,
        'text-anchor': 'middle',
        text: day.date.slice(5),
      }),
    )
  })
}

/**
 * Tooltips are built as DOM, never as an HTML string.
 *
 * Two reasons, and both are load-bearing. The swatches need a per-series colour, and under
 * `style-src 'self'` an inline `style=` attribute in an HTML string is silently dropped — the
 * swatch would render as an invisible box. And the labels are chain data (token symbols,
 * addresses); building them as nodes means there is no string concatenation for anything to be
 * injected into in the first place.
 */
function tooltip(host) {
  const tip = el('div.tip')
  host.append(tip)
  const show = (content, xFraction) => {
    tip.replaceChildren(content)
    tip.dataset.open = '1'
    const width = host.clientWidth
    // Flip the tooltip to the left of the cursor once it would otherwise run off the right
    // edge. Clamping instead would park it under the pointer and cover the mark it describes.
    const left = xFraction * width
    tip.style.left = `${Math.max(0, Math.min(left + 12, width - tip.offsetWidth - 4))}px`
    tip.style.top = '8px'
  }
  const hide = () => {
    tip.dataset.open = '0'
  }
  host.addEventListener('pointerleave', hide)
  host.addEventListener('blur', hide, true)
  return { show, hide }
}

/** `<div class="t-d">date</div><div class="t-v">value</div>` plus an optional value table. */
function tipContent(heading, value, rows = []) {
  const frag = document.createDocumentFragment()
  frag.append(el('div.t-d', { text: heading }))
  if (value !== null && value !== undefined) frag.append(el('div.t-v', { text: value }))
  if (rows.length) {
    const table = el('table')
    for (const row of rows) {
      table.append(
        el(
          'tr',
          null,
          el(
            'td',
            null,
            row.color ? el('span.swatch', { style: `display:inline-block;background:${row.color}` }) : null,
            document.createTextNode(row.label),
          ),
          el('td.n', { text: row.value }),
        ),
      )
    }
    frag.append(table)
  }
  return frag
}

/* ------------------------------------------------------------------------ stacked bars ---- */

/**
 * Daily volume, stacked by series. The default chart of this site.
 *
 * Empty days are drawn as empty, never dropped: a gap in activity is information, and
 * compressing it out makes a dead fortnight look like a busy one.
 *
 * @param {HTMLElement} host
 * @param {{days: Array<{date:string,usd:number,count:number,stack:number[]}>, series: Array<{label:string}>, format?: (n:number)=>string}} data
 */
export function stackedBars(host, { days, series, format = money, colors = null }) {
  host.replaceChildren()
  if (!days?.length) return

  // Categorical hues by default. `colors` exists for the one case where the segments are not
  // categories but STATES — delivered / unresolved / failed — where the reserved status palette
  // is the honest choice and an arbitrary blue-orange-aqua would be actively misleading. The
  // legend carries the word in either case, so colour never has to carry it alone.
  const colorAt = (i) => colors?.[i] ?? seriesColor(i)

  const box = plotBox()
  const max = niceMax(Math.max(...days.map((d) => d.usd)))
  const step = box.w / days.length
  // A 2px gap between columns at 1000 units wide, floored so very long windows still show
  // separate bars rather than a solid block.
  const barWidth = Math.max(1, step - Math.min(2, step * 0.25))

  const root = svg('svg', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'img', 'aria-label': 'Daily volume, stacked by series' })
  axis(root, box, max, { format })
  dateTicks(root, box, days, step)

  days.forEach((day, i) => {
    let y = box.y + box.h
    day.stack.forEach((value, s) => {
      if (!(value > 0)) return
      const height = (value / max) * box.h
      y -= height
      root.append(
        svg('rect.stack-seg', {
          x: box.x + i * step + (step - barWidth) / 2,
          y,
          width: barWidth,
          height,
          fill: colorAt(s),
        }),
      )
    })
  })

  const hover = svg('rect', {
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    fill: 'transparent',
    style: 'cursor:crosshair',
  })
  const cross = svg('line.crosshair', { x1: 0, x2: 0, y1: box.y, y2: box.y + box.h, opacity: 0 })
  root.append(hover, cross)
  host.append(root)

  const tip = tooltip(host)
  hover.addEventListener('pointermove', (event) => {
    const bounds = root.getBoundingClientRect()
    const local = ((event.clientX - bounds.left) / bounds.width) * VIEW.w
    const index = Math.max(0, Math.min(days.length - 1, Math.floor((local - box.x) / step)))
    const day = days[index]
    const x = box.x + index * step + step / 2
    cross.setAttribute('x1', x)
    cross.setAttribute('x2', x)
    cross.setAttribute('opacity', 1)

    const rows = day.stack
      .map((value, s) => ({ value, label: ` ${series[s]?.label ?? ''}`, color: colorAt(s) }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((row) => ({ ...row, value: format(row.value) }))

    tip.show(
      tipContent(day.date, format(day.usd), [{ label: 'Count', value: compact(day.count) }, ...rows]),
      x / VIEW.w,
    )
  })
  hover.addEventListener('pointerleave', () => cross.setAttribute('opacity', 0))
}

/* --------------------------------------------------------------- segmented rank rows ---- */

/**
 * One horizontal bar per item, split into segments that are supposed to **sum to that item's
 * total** — and checked, not trusted.
 *
 * WHY A FIFTH FORM, since the kit is deliberately closed. The other four answer "how did this
 * change" or "what flowed where". This one answers a question none of them can: *where does a
 * known quantity currently sit?* Asset Hub's supply of a bridged token is an exact number, and
 * every parachain's sovereign holding is a slice of that same number — so the slices must add
 * back up to it. Drawn this way the arithmetic is the picture: if the segments do not fill the
 * bar, something is unaccounted for and you can see it. A grouped bar or a pie would both hide
 * exactly that.
 *
 * THE RECONCILIATION IS THE POINT, and it is why this takes `total` separately rather than
 * summing the segments and calling that the total. Summing would make every row reconcile by
 * construction and the check would be worthless. Instead:
 *
 *   · segments short of the total  → the shortfall is drawn, hatched, and labelled. That is
 *     usually real (value held by the chain itself rather than by any of its counterparties),
 *     so the caller should pass it as a named series and see this go away. When it does not go
 *     away, that is the finding.
 *   · segments over the total      → the row is marked `data-over`, because that cannot be
 *     drawn honestly at all. Two sources disagree and the page must say so rather than clip a
 *     bar and look fine.
 *
 * ⚠️ SCALING IS A UNIT DECISION AND GETTING IT WRONG RENDERS PERFECTLY. Linear from zero,
 * always — but denominated one of two ways, and the wrong one is silent:
 *
 *   · `scale: 'shared'` (default) denominates every bar by the largest total, so bar lengths
 *     are comparable BETWEEN rows. This is only honest when the rows share a unit. Drawn from
 *     raw token amounts it is a lie: 4,210 WETH against 88,400,000 USDC puts WETH at 0.005% of
 *     the track — a real holding worth more than ten million dollars renders as a 1px sliver
 *     next to a stablecoin. Compare rows in USD, or do not compare them.
 *   · `scale: 'row'` denominates each bar by its own total, so every bar fills its track and
 *     only the COMPOSITION is encoded. This is the honest mode for mixed units, and for the
 *     assets that could not be priced at all. Magnitude is not lost — it stays in the amount
 *     column — it is just not in the bar.
 *
 * The returned tally carries `faint`: rows under 2% of the track under shared scaling. A page
 * that gets a high `faint` count is being told its units are not comparable.
 *
 * Sub-pixel segments are floored to 1px rather than rounded away, so a small-but-real holding
 * is never invisible — which means the very smallest segments are deliberately NOT to scale.
 * The alternative is that a genuine balance draws as nothing and reads as zero, and on this
 * site `null` is not `0` and neither is "small".
 *
 * COLOUR FOLLOWS THE SERIES, NOT THE RANK. `series` is a fixed, caller-supplied order and the
 * slot index comes from it, so filtering the rows never repaints the survivors. Slot 9+ is grey
 * for the reason it always is here: a repeated hue reads as a repeated thing.
 *
 * No hover tooltip: this is a list that can be a hundred rows long, and the shared tooltip pins
 * to the top of its host, which would put the description a screen away from the row it
 * describes. Each row carries a `title` and the page carries a table — same information, and it
 * survives both the keyboard and a printout.
 *
 * @param {HTMLElement} host
 * @param {object} data
 * @param {Array<{label:string, sublabel?:string, total:number, segments:number[], note?:string, format?:(n:number)=>string}>} data.rows
 *        A row may carry its own `format`. Under `scale: 'row'` the rows are by definition not
 *        in one unit, so one formatter for all of them is the wrong default — a token count and
 *        an 18-decimal raw integer do not read the same way.
 * @param {Array<{label:string}>} data.series          fixed order; `segments[i]` belongs to `series[i]`
 * @param {(n:number)=>string} [data.format]
 * @param {string} [data.residualLabel]                 what an unfilled remainder means here
 * @param {'shared'|'row'} [data.scale]                 see the scaling warning above
 * @returns {{reconciled:number, short:number, over:number, faint:number}} counts, for the data notes
 */
export function segmentedRows(host, { rows, series, format = money, residualLabel = 'unaccounted', scale = 'shared' }) {
  host.replaceChildren()
  if (!rows?.length) return { reconciled: 0, short: 0, over: 0, faint: 0 }

  const sharedMax = Math.max(...rows.map((row) => Math.max(row.total ?? 0, sum(row.segments))), 1)
  const tally = { reconciled: 0, short: 0, over: 0, faint: 0 }

  // A relative tolerance, not an absolute one. These are token amounts spanning eighteen orders
  // of magnitude — an absolute epsilon that is sane for BTC calls every USDC row broken.
  const reconciles = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

  const list = el('div.rows')
  for (const row of rows) {
    const total = row.total ?? 0
    const accounted = sum(row.segments)
    const residual = total - accounted
    const state = reconciles(accounted, total) ? 'reconciled' : residual > 0 ? 'short' : 'over'
    tally[state]++

    const parts = row.segments
      .map((value, i) => ({ value, label: series[i]?.label ?? `series ${i + 1}`, color: seriesColor(i) }))
      .filter((part) => part.value > 0)

    // `row` scaling denominates each bar by its own total, so every bar fills its track and only
    // the COMPOSITION is encoded. `shared` denominates every bar by the largest total, so bar
    // lengths are comparable between rows — which is only true if the rows share a unit.
    const denom = scale === 'row' ? Math.max(total, accounted, Number.MIN_VALUE) : sharedMax
    // Counted under BOTH modes, deliberately. `faint` answers "would these rows be comparable
    // if I denominated them together?" — which is exactly the question you have when you chose
    // `row` because you suspected they were not. Only counting it under `shared` made the
    // diagnostic unavailable in the one mode that needs it.
    if (total / sharedMax < 0.02) tally.faint++

    const track = el('div.track.segmented')
    for (const part of parts) {
      append(track, el('div.seg', { style: `width:${(part.value / denom) * 100}%;background:${part.color}` }))
    }
    // Drawn, never quietly omitted. An unfilled bar is the whole reason this form exists.
    if (state === 'short') {
      append(track, el('div.seg', { class: 'residual', style: `width:${(residual / denom) * 100}%` }))
    }

    const fmt = row.format ?? format
    const lines = [
      `${row.label}${row.sublabel ? ` · ${row.sublabel}` : ''}`,
      `total ${fmt(total)}`,
      ...parts.sort((a, b) => b.value - a.value).map((part) => `${part.label}: ${fmt(part.value)}`),
    ]
    if (state === 'short') lines.push(`${residualLabel}: ${fmt(residual)}`)
    if (state === 'over') lines.push(`⚠ segments exceed the total by ${fmt(-residual)} — sources disagree`)
    if (row.note) lines.push(row.note)

    append(
      list,
      el(
        'div.row.seg-row',
        { tabindex: '0', title: lines.join('\n'), data: { state } },
        el('div.name', { text: row.label }),
        el('div.sub', { text: row.sublabel ?? '' }),
        track,
        el('div.amt', { text: fmt(total) }),
      ),
    )
  }

  append(host, list)
  return tally
}

const sum = (values) => (values ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)

/**
 * The legend for `segmentedRows`, carrying a value and not just a name — the same relief every
 * chart here owes the three light-mode hues that sit under 3:1 contrast.
 *
 * ⚠️ `values[i]` is whatever is TRUE ACROSS ALL ROWS for series `i`. Under `scale: 'shared'`
 * that is a sum, because the rows share a unit. Under `scale: 'row'` a sum is meaningless — it
 * would add BTC to memecoins — so pass a **count** (how many rows that series appears in) and a
 * count formatter. Summing anyway produces a large, confident, meaningless number.
 */
export function segmentedLegend(series, values, format = money) {
  const items = series.map((entry, i) =>
    el(
      'li',
      null,
      el('span.swatch', { style: `background:${seriesColor(i)}` }),
      document.createTextNode(entry.label),
      el('span.amt', { text: format(values?.[i] ?? 0) }),
    ),
  )
  return el('ul.legend', null, ...items)
}

/* ------------------------------------------------------------------------------- line ---- */

/**
 * A single line over an ordered index — cumulative totals, concentration curves.
 * One y-axis. There is deliberately no two-series variant with a second scale.
 */
export function lineChart(host, { points, labelOf, format = money, area = true, color = 'var(--series-1)' }) {
  host.replaceChildren()
  if (!points?.length) return

  const box = plotBox()
  const max = niceMax(Math.max(...points))
  const step = points.length > 1 ? box.w / (points.length - 1) : 0
  const at = (i) => ({ x: box.x + i * step, y: box.y + box.h - (points[i] / max) * box.h })

  const root = svg('svg', { viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'img', 'aria-label': 'Cumulative series' })
  axis(root, box, max, { format })

  const path = points.map((_, i) => `${i ? 'L' : 'M'}${at(i).x.toFixed(1)},${at(i).y.toFixed(1)}`).join('')
  if (area) {
    root.append(
      svg('path.area-mark', {
        d: `${path}L${at(points.length - 1).x},${box.y + box.h}L${box.x},${box.y + box.h}Z`,
        fill: color,
      }),
    )
  }
  root.append(svg('path.line-mark', { d: path, stroke: color }))

  const hover = svg('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'transparent', style: 'cursor:crosshair' })
  const cross = svg('line.crosshair', { x1: 0, x2: 0, y1: box.y, y2: box.y + box.h, opacity: 0 })
  const dot = svg('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 })
  root.append(hover, cross, dot)
  host.append(root)

  const tip = tooltip(host)
  hover.addEventListener('pointermove', (event) => {
    const bounds = root.getBoundingClientRect()
    const local = ((event.clientX - bounds.left) / bounds.width) * VIEW.w
    const index = Math.max(0, Math.min(points.length - 1, Math.round((local - box.x) / (step || 1))))
    const p = at(index)
    for (const [node, attrs] of [
      [cross, { x1: p.x, x2: p.x, opacity: 1 }],
      [dot, { cx: p.x, cy: p.y, opacity: 1 }],
    ]) {
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    }
    tip.show(tipContent(labelOf(index), format(points[index])), p.x / VIEW.w)
  })
  hover.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', 0)
    dot.setAttribute('opacity', 0)
  })
}

/* ------------------------------------------------------------------------ multi-series ---- */

/**
 * Several lines on one shared scale — used by the netflows archive, where a dozen parachains
 * are compared against each other in the same token. Shared scale is the point: that is what
 * makes "Moonbeam holds more than everyone else combined" visible.
 *
 * `null` in a series means "no data yet", and the line breaks rather than being drawn to zero.
 */
export function multiLine(host, { days, series, format = compact, height = 340 }) {
  host.replaceChildren()
  if (!series?.length) return

  const view = { w: 1000, h: height }
  const box = plotBox(view)
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.filter((v) => v !== null))))
  const step = days.length > 1 ? box.w / (days.length - 1) : 0

  const root = svg('svg', { viewBox: `0 0 ${view.w} ${view.h}`, role: 'img', 'aria-label': 'Balances over time by chain' })
  axis(root, box, max, { format, lines: 5 })

  const every = Math.max(1, Math.ceil(days.length / 10))
  days.forEach((day, i) => {
    if (i % every !== 0 && i !== days.length - 1) return
    root.append(
      svg('text.axis-text', { x: box.x + i * step, y: box.y + box.h + 14, 'text-anchor': 'middle', text: day.slice(0, 7) }),
    )
  })

  series.forEach((s, index) => {
    let d = ''
    let penDown = false
    s.values.forEach((value, i) => {
      if (value === null) {
        penDown = false
        return
      }
      const x = box.x + i * step
      const y = box.y + box.h - (value / max) * box.h
      d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      penDown = true
    })
    root.append(svg('path.line-mark', { d, stroke: seriesColor(index), 'data-series': s.label }))
  })

  const hover = svg('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'transparent', style: 'cursor:crosshair' })
  const cross = svg('line.crosshair', { x1: 0, x2: 0, y1: box.y, y2: box.y + box.h, opacity: 0 })
  root.append(hover, cross)
  host.append(root)

  const tip = tooltip(host)
  hover.addEventListener('pointermove', (event) => {
    const bounds = root.getBoundingClientRect()
    const local = ((event.clientX - bounds.left) / bounds.width) * view.w
    const index = Math.max(0, Math.min(days.length - 1, Math.round((local - box.x) / (step || 1))))
    const x = box.x + index * step
    cross.setAttribute('x1', x)
    cross.setAttribute('x2', x)
    cross.setAttribute('opacity', 1)

    const rows = series
      .map((s, i) => ({ label: ` ${s.label}`, raw: s.values[index], color: seriesColor(i) }))
      .filter((row) => row.raw !== null && row.raw !== undefined)
      .sort((a, b) => b.raw - a.raw)
      .slice(0, 10)
      .map((row) => ({ label: row.label, color: row.color, value: format(row.raw) }))

    tip.show(tipContent(days[index], null, rows), x / view.w)
  })
  hover.addEventListener('pointerleave', () => cross.setAttribute('opacity', 0))
}

/* ==========================================================================================
 *  The two XCM forms: an origin × destination matrix, and a corridor graph.
 *
 *  Both were added for the same question — "which chains talk to each other, and how much" —
 *  and both refuse the chart that question usually gets. A Sankey is wrong here because the
 *  graph is CYCLIC: Asset Hub sends to Hydration and Hydration sends back to Asset Hub, and a
 *  Sankey cannot draw that without either double-counting the pair or silently dropping one
 *  direction. A matrix is the honest default for a directed n×n relation, and a node/edge
 *  graph is the honest second view when the topology itself is the point.
 *
 *  Encoding rules these follow, from docs/architecture/design-system.md:
 *   · sequential is ONE HUE light→dark (`--seq-100` … `--seq-700`). Never a rainbow, and no
 *     hue is invented here — these five steps are the validated sequential ramp.
 *   · the band edges are printed in the legend. Colour never carries a magnitude alone.
 *   · `null` is not `0`. A pair never observed is drawn as an outline, a pair observed at zero
 *     is drawn in the lightest band. Collapsing them would turn "we have no rows for this
 *     corridor" into "this corridor moved nothing", which is a different claim entirely.
 *   · a 2px spacer between marks, the same gap the stacked bars leave between columns, so two
 *     adjacent cells of the same band do not read as one wide cell.
 *   · a table view exists for both, because colour and stroke width are the two encodings
 *     hardest to read a number off.
 * ========================================================================================== */

/** The sequential ramp, light to dark. Five steps: enough to rank, few enough to tell apart. */
const SEQ = ['var(--seq-100)', 'var(--seq-250)', 'var(--seq-400)', 'var(--seq-550)', 'var(--seq-700)']

/**
 * Band edges, linear from zero over a nice maximum.
 *
 * Linear is the default for the same reason bars are linear from zero: a rank-based or log
 * banding makes a corridor carrying 2% of the traffic look comparable to one carrying 60%.
 * The cost is real and is stated rather than designed around — on a heavily skewed matrix
 * almost every cell lands in the first band, which IS what the data says. A caller that has a
 * defensible reason to band differently passes explicit `bands`, and because the legend prints
 * the edges, the different banding is on the page rather than hidden in the code.
 */
function linearBands(max, count = SEQ.length) {
  const top = niceMax(max)
  return Array.from({ length: count }, (_, i) => (top / count) * (i + 1))
}

/** Index into the ramp for a value, given ascending band edges. */
const bandOf = (value, bands) => {
  const at = bands.findIndex((edge) => value <= edge)
  return at === -1 ? bands.length - 1 : at
}

/** A `.legend` carrying the band edges — the relief for a colour-only magnitude encoding. */
function bandLegend(bands, format) {
  const list = el('ul.legend')
  bands.forEach((edge, i) => {
    const from = i === 0 ? 0 : bands[i - 1]
    list.append(
      el(
        'li',
        null,
        el('span.swatch', { style: `background:${SEQ[i]}` }),
        el('span', { text: `${format(from)} – ${format(edge)}` }),
      ),
    )
  })
  list.append(el('li', null, el('span.swatch.swatch-empty'), el('span', { text: 'never observed' })))
  return list
}

/** `[{key,label}]` from either that, or bare strings. */
const asNodes = (list) =>
  (list ?? []).map((item) =>
    typeof item === 'string' ? { key: item, label: item } : { key: item.key, label: item.label ?? String(item.key) },
  )

/** A composite map key. `\u001f` (unit separator) cannot occur in a chain identifier, and a
 *  separator that CAN occur silently merges two different pairs into one cell. */
const pairKey = (row, col) => `${row}\u001f${col}`

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/* --------------------------------------------------------------- origin × destination ---- */

/**
 * An n×n directed matrix — origin down the side, destination across the top.
 *
 * The right first chart for cross-chain flow, and the reason is structural rather than
 * aesthetic: the relation is directed and cyclic, every pair has two independent values, and a
 * matrix is the only form that shows both of them next to each other. Reading down a column
 * gives everything arriving at a chain; reading across a row gives everything it sent.
 *
 * @param {HTMLElement} host
 * @param {object} data
 * @param {Array<{key:string,label?:string}|string>} data.rows      origins, in a fixed order
 * @param {Array<{key:string,label?:string}|string>} data.cols      destinations, in a fixed order
 * @param {Array<{row:string,col:string,value:number|null,count?:number}>} data.cells
 *        Sparse: a pair with no entry was never observed and is drawn as an outline. A pair
 *        that was observed at zero must be present with `value: 0`.
 * @param {(n:number)=>string} [data.format]
 * @param {number[]} [data.bands]   ascending upper edges; defaults to linear from zero
 * @param {string} [data.unit]      what the value counts, for the tooltip ("messages", "USD")
 */
export function matrix(host, { rows, cols, cells, format = compact, bands = null, unit = 'value' }) {
  host.replaceChildren()
  const rowList = asNodes(rows)
  const colList = asNodes(cols)
  if (!rowList.length || !colList.length) return

  const byPair = new Map()
  const rowTotals = new Map()
  const colTotals = new Map()
  for (const cell of cells ?? []) {
    byPair.set(pairKey(cell.row, cell.col), cell)
    if (typeof cell.value === 'number') {
      rowTotals.set(cell.row, (rowTotals.get(cell.row) ?? 0) + cell.value)
      colTotals.set(cell.col, (colTotals.get(cell.col) ?? 0) + cell.value)
    }
  }

  const values = (cells ?? []).map((cell) => cell.value).filter((value) => typeof value === 'number')
  const edges = bands ?? linearBands(values.length ? Math.max(...values) : 1)

  // Geometry. Width is fixed at 1000 units and the cell size follows from the column count, so
  // a 6-chain matrix and a 26-chain matrix both fill the same frame; the height follows from
  // the cell size, so cells stay square and a wide-but-short matrix cannot squash them.
  const GUT = { left: 132, top: 96, right: 8, bottom: 8 }
  const step = (1000 - GUT.left - GUT.right) / colList.length
  const size = Math.max(1, step - 2) // the 2px spacer, same rule as the stacked columns
  const view = { w: 1000, h: GUT.top + rowList.length * step + GUT.bottom }

  const root = svg('svg', {
    viewBox: `0 0 ${view.w} ${view.h}`,
    role: 'img',
    'aria-label': `Origin by destination matrix, ${rowList.length} origins by ${colList.length} destinations`,
  })

  // Column labels, rotated so a long chain name does not force a 26-column matrix to shrink
  // its cells. `transform` is an SVG attribute, not CSS, so it is untouched by `style-src`.
  colList.forEach((col, i) => {
    const x = GUT.left + i * step + step / 2
    const y = GUT.top - 6
    root.append(
      svg('text.matrix-label', {
        x,
        y,
        transform: `rotate(-45 ${x.toFixed(1)} ${y.toFixed(1)})`,
        'text-anchor': 'start',
        text: clip(col.label, 16),
      }),
    )
  })

  rowList.forEach((row, r) => {
    root.append(
      svg('text.matrix-label', {
        x: GUT.left - 8,
        y: GUT.top + r * step + step / 2 + 3,
        'text-anchor': 'end',
        text: clip(row.label, 18),
      }),
    )
    colList.forEach((col, c) => {
      const cell = byPair.get(pairKey(row.key, col.key))
      const x = GUT.left + c * step + 1
      const y = GUT.top + r * step + 1
      if (!cell || typeof cell.value !== 'number') {
        // Never observed. An outline, not the lightest fill — `null` is not `0`.
        root.append(svg('rect.matrix-empty', { x, y, width: size, height: size }))
        return
      }
      root.append(
        svg('rect.matrix-cell', { x, y, width: size, height: size, fill: SEQ[bandOf(cell.value, edges)] }),
      )
    })
  })

  const hover = svg('rect', {
    x: GUT.left,
    y: GUT.top,
    width: colList.length * step,
    height: rowList.length * step,
    fill: 'transparent',
    style: 'cursor:crosshair',
  })
  const marker = svg('rect.matrix-hi', { x: 0, y: 0, width: step, height: step, opacity: 0 })
  root.append(hover, marker)
  host.append(root, bandLegend(edges, format))

  const tip = tooltip(host)
  hover.addEventListener('pointermove', (event) => {
    const bounds = root.getBoundingClientRect()
    const localX = ((event.clientX - bounds.left) / bounds.width) * view.w
    const localY = ((event.clientY - bounds.top) / bounds.height) * view.h
    const c = Math.max(0, Math.min(colList.length - 1, Math.floor((localX - GUT.left) / step)))
    const r = Math.max(0, Math.min(rowList.length - 1, Math.floor((localY - GUT.top) / step)))
    const row = rowList[r]
    const col = colList[c]
    const cell = byPair.get(pairKey(row.key, col.key))

    marker.setAttribute('x', GUT.left + c * step)
    marker.setAttribute('y', GUT.top + r * step)
    marker.setAttribute('opacity', 1)

    const detail = [
      { label: `From ${row.label}, total`, value: format(rowTotals.get(row.key) ?? 0) },
      { label: `To ${col.label}, total`, value: format(colTotals.get(col.key) ?? 0) },
    ]
    if (cell?.count !== undefined) detail.unshift({ label: 'Count', value: compact(cell.count) })

    tip.show(
      tipContent(
        `${row.label} → ${col.label}`,
        typeof cell?.value === 'number' ? `${format(cell.value)} ${unit}` : 'never observed',
        detail,
      ),
      (GUT.left + c * step) / view.w,
    )
  })
  hover.addEventListener('pointerleave', () => marker.setAttribute('opacity', 0))
}

/**
 * The matrix as a table: one row per observed pair, biggest first. The accessibility fallback,
 * and the better view for anyone who wants the number rather than the shape.
 */
export function matrixTable(host, { cells, rows, cols, format = compact, unit = 'Value', countLabel = 'Count', open = false }) {
  host.replaceChildren()
  const labelOf = new Map([...asNodes(rows), ...asNodes(cols)].map((node) => [node.key, node.label]))
  const observed = (cells ?? []).filter((cell) => typeof cell.value === 'number').sort((a, b) => b.value - a.value)

  const body = el('tbody')
  for (const cell of observed) {
    body.append(
      el(
        'tr',
        null,
        el('td', { text: labelOf.get(cell.row) ?? cell.row }),
        el('td', { text: labelOf.get(cell.col) ?? cell.col }),
        el('td.num', { text: format(cell.value) }),
        el('td.num', { text: cell.count === undefined ? '—' : compact(cell.count) }),
      ),
    )
  }

  host.append(
    el(
      'details.data-table',
      open ? { open: true } : null,
      el('summary', { text: `Table — ${observed.length} observed pairs` }),
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
              el('th', { text: 'Origin' }),
              el('th', { text: 'Destination' }),
              el('th.num', { text: unit }),
              el('th.num', { text: countLabel }),
            ),
          ),
          body,
        ),
      ),
    ),
  )
}

/* ------------------------------------------------------------------------- flow graph ---- */

/**
 * A hairline is still a corridor. Edge width is linear in value from a 0.6-unit floor, and the
 * floor is stated rather than hidden: without it the smallest corridors round to invisible and
 * the graph quietly claims they do not exist. The colour band carries the magnitude for
 * anything the width is too thin to express, and the table carries the number.
 */
const EDGE_MIN_WIDTH = 0.6
const EDGE_MAX_WIDTH = 12
const NODE_RADIUS = 7

/**
 * A node/edge graph of who talks to whom, laid out on a circle.
 *
 * Two decisions worth knowing before reading it:
 *
 * **The layout is deterministic, not force-directed.** Nodes sit on a circle in the order the
 * caller supplies, so the same data draws the same picture every time and two screenshots are
 * comparable. A force simulation would produce a prettier graph and a different one on every
 * load, and "the cluster moved" would be an artefact rather than a fact.
 *
 * **Node size carries nothing.** Radius is fixed. A circle's area is the one encoding people
 * reliably misread, and the node's total is one hover or one table row away. What the marks
 * encode is exactly two things: WHO is connected (an edge exists) and HOW MUCH (its width and
 * band). Node colour encodes `group` — a kind, not a rank — in fixed slot order, so filtering
 * the graph never repaints the survivors.
 *
 * @param {HTMLElement} host
 * @param {object} data
 * @param {Array<{id:string,label?:string,group?:string}>} data.nodes  fixed order = fixed layout
 * @param {Array<{from:string,to:string,value:number,count?:number}>} data.edges
 * @param {Array<{key:string,label:string}>} [data.groups]  slot order for node colour; without
 *        it every node is the chromaless grey, because an unlabelled colour is decoration
 * @param {(n:number)=>string} [data.format]
 * @param {number[]} [data.bands]
 * @param {string} [data.unit]
 */
export function flowGraph(host, { nodes, edges, groups = null, format = compact, bands = null, unit = 'value' }) {
  host.replaceChildren()
  const nodeList = (nodes ?? []).map((node) => ({ id: node.id, label: node.label ?? node.id, group: node.group ?? null }))
  if (!nodeList.length) return

  const view = { w: 1000, h: 560 }
  const centre = { x: view.w / 2, y: view.h / 2 }
  const radius = Math.min(view.w, view.h) / 2 - 110

  const at = new Map()
  nodeList.forEach((node, i) => {
    // Start at the top and go clockwise, so "first in the list" is where a reader looks first.
    const angle = (i / nodeList.length) * Math.PI * 2 - Math.PI / 2
    at.set(node.id, { x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius, angle })
  })

  const drawable = (edges ?? []).filter((edge) => at.has(edge.from) && at.has(edge.to) && Number.isFinite(edge.value))
  const maxValue = drawable.length ? Math.max(...drawable.map((edge) => edge.value)) : 1
  const edgeBands = bands ?? linearBands(maxValue)

  const groupSlot = new Map((groups ?? []).map((group, i) => [group.key, seriesColor(i)]))
  const nodeColour = (node) => (node.group !== null && groupSlot.has(node.group) ? groupSlot.get(node.group) : 'var(--series-rest)')

  const root = svg('svg', {
    viewBox: `0 0 ${view.w} ${view.h}`,
    role: 'img',
    'aria-label': `Corridor graph, ${nodeList.length} chains and ${drawable.length} corridors`,
  })

  // Declared here and mounted after the plot, so the tooltip host is the LAST child of `host`
  // — same order as every other form. The handlers below only read it when an event fires, by
  // which time it exists.
  /** @type {ReturnType<typeof tooltip>} */
  let tip
  const labelOf = new Map(nodeList.map((node) => [node.id, node.label]))

  // Edges first, so a node mark is never hidden under a thick corridor. Sorted thinnest-first
  // so a heavy corridor is not buried under a dozen hairlines.
  const edgeLayer = svg('g')
  const hitLayer = svg('g')
  for (const edge of [...drawable].sort((a, b) => a.value - b.value)) {
    const from = at.get(edge.from)
    const to = at.get(edge.to)
    const width = EDGE_MIN_WIDTH + (edge.value / maxValue) * (EDGE_MAX_WIDTH - EDGE_MIN_WIDTH)
    const colour = SEQ[bandOf(edge.value, edgeBands)]

    let path
    if (edge.from === edge.to) {
      // A self-corridor: a chain sending to itself. Rare and real (a local execution recorded
      // on both sides), and drawn as a small loop outside the ring rather than dropped.
      const out = {
        x: centre.x + Math.cos(from.angle) * (radius + 26),
        y: centre.y + Math.sin(from.angle) * (radius + 26),
      }
      path = `M${from.x.toFixed(1)},${from.y.toFixed(1)}A14,14 0 1 1 ${out.x.toFixed(1)},${out.y.toFixed(1)}`
    } else {
      // Bowed toward the centre. The bow is what keeps A→B and B→A as two visible arcs rather
      // than one line drawn twice, which on a cyclic graph is most of the pairs.
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
      const control = { x: centre.x + (mid.x - centre.x) * 0.35, y: centre.y + (mid.y - centre.y) * 0.35 }
      path = `M${from.x.toFixed(1)},${from.y.toFixed(1)}Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`
    }

    const mark = svg('path.flow-edge', { d: path, stroke: colour, 'stroke-width': width.toFixed(2) })
    edgeLayer.append(mark)

    // A separate, wide, transparent path for pointing at. A 0.6-unit line is unhittable, and
    // widening the visible mark to make it hittable would overstate the corridor.
    const hit = svg('path.flow-edge-hit', { d: path, 'stroke-width': Math.max(10, width + 8) })
    const show = (event) => {
      mark.dataset.on = '1'
      const bounds = root.getBoundingClientRect()
      const fraction = bounds.width ? (event.clientX - bounds.left) / bounds.width : 0.5
      tip.show(
        tipContent(
          `${labelOf.get(edge.from)} → ${labelOf.get(edge.to)}`,
          `${format(edge.value)} ${unit}`,
          edge.count === undefined ? [] : [{ label: 'Count', value: compact(edge.count) }],
        ),
        Math.max(0, Math.min(1, fraction)),
      )
    }
    hit.addEventListener('pointerenter', show)
    hit.addEventListener('pointermove', show)
    hit.addEventListener('pointerleave', () => {
      mark.dataset.on = '0'
    })
    hitLayer.append(hit)
  }

  const nodeLayer = svg('g')
  for (const node of nodeList) {
    const point = at.get(node.id)
    const outbound = drawable.filter((edge) => edge.from === node.id).reduce((sum, edge) => sum + edge.value, 0)
    const inbound = drawable.filter((edge) => edge.to === node.id).reduce((sum, edge) => sum + edge.value, 0)

    const dot = svg('circle.flow-node', {
      cx: point.x.toFixed(1),
      cy: point.y.toFixed(1),
      r: NODE_RADIUS,
      fill: nodeColour(node),
    })
    // Label pushed outward along the same ray, flipping its anchor on the left half so text
    // never runs back across the graph.
    const outward = {
      x: centre.x + Math.cos(point.angle) * (radius + 20),
      y: centre.y + Math.sin(point.angle) * (radius + 20),
    }
    const label = svg('text.flow-label', {
      x: outward.x.toFixed(1),
      y: (outward.y + 3).toFixed(1),
      'text-anchor': Math.cos(point.angle) < -0.2 ? 'end' : Math.cos(point.angle) > 0.2 ? 'start' : 'middle',
      text: clip(node.label, 18),
    })

    const show = (event) => {
      dot.dataset.on = '1'
      const bounds = root.getBoundingClientRect()
      const fraction = bounds.width ? (event.clientX - bounds.left) / bounds.width : 0.5
      tip.show(
        tipContent(node.label, null, [
          { label: 'Sent', value: `${format(outbound)} ${unit}` },
          { label: 'Received', value: `${format(inbound)} ${unit}` },
        ]),
        Math.max(0, Math.min(1, fraction)),
      )
    }
    dot.addEventListener('pointerenter', show)
    dot.addEventListener('pointerleave', () => {
      dot.dataset.on = '0'
    })
    nodeLayer.append(dot, label)
  }

  root.append(edgeLayer, nodeLayer, hitLayer)
  host.append(root)
  tip = tooltip(host)

  if (groups?.length) {
    const legend = el('ul.legend')
    for (const [i, group] of groups.entries()) {
      const count = nodeList.filter((node) => node.group === group.key).length
      legend.append(
        el(
          'li',
          null,
          el('span.swatch', { style: `background:${seriesColor(i)}` }),
          el('span', { text: group.label }),
          el('span.amt', { text: String(count) }),
        ),
      )
    }
    host.append(legend)
  }
  host.append(bandLegend(edgeBands, format))
}

/** The corridors as a table, heaviest first — the fallback view, and the one with the numbers. */
export function flowTable(host, { nodes, edges, format = compact, unit = 'Value', countLabel = 'Count', open = false }) {
  host.replaceChildren()
  const labelOf = new Map((nodes ?? []).map((node) => [node.id, node.label ?? node.id]))
  const sorted = (edges ?? []).filter((edge) => Number.isFinite(edge.value)).sort((a, b) => b.value - a.value)

  const body = el('tbody')
  for (const edge of sorted) {
    body.append(
      el(
        'tr',
        null,
        el('td', { text: labelOf.get(edge.from) ?? edge.from }),
        el('td', { text: labelOf.get(edge.to) ?? edge.to }),
        el('td.num', { text: format(edge.value) }),
        el('td.num', { text: edge.count === undefined ? '—' : compact(edge.count) }),
      ),
    )
  }

  host.append(
    el(
      'details.data-table',
      open ? { open: true } : null,
      el('summary', { text: `Table — ${sorted.length} corridors` }),
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
              el('th', { text: 'From' }),
              el('th', { text: 'To' }),
              el('th.num', { text: unit }),
              el('th.num', { text: countLabel }),
            ),
          ),
          body,
        ),
      ),
    ),
  )
}
