// The chart kit. Hand-rolled inline SVG, four forms, shared by every page.
//
// No charting library. The production CSP forbids external scripts, and a 3 MB plotting bundle
// to draw a stacked bar chart would dominate the page weight of a site whose whole point is a
// few hundred numbers. More importantly, the forms here are chosen rather than configured:
// four marks that fit the four questions this site asks, and no dual-axis chart, ever.
//
// Rules these follow, from docs/architecture/design-system.md:
//   · categorical colour is assigned in fixed slot order, never cycled; slot 9+ is grey
//   · bars are linear from zero and rounded only on the data end
//   · stacked segments carry a 1px surface-coloured stroke so adjacent hues stay separable
//   · every chart has a legend with values, and a table view exists on the page
//   · one y-axis

import { svg, el } from './dom.js'
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
