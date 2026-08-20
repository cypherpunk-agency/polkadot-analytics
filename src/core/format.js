// Presentation-only. No chain knowledge, no I/O, no DOM.
//
// House rule inherited from plaza: numbers a reader might compare are TABULAR and
// right-aligned in CSS; numbers a reader might quote are exact. Nothing here rounds a value
// the user could act on without saying so.

/** Binary units, because the chain's own size fields are byte counts, not disk marketing. */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MiB`
  return `${(n / 1073741824).toFixed(2)} GiB`
}

export const formatCount = (n) => Number(n).toLocaleString('en-US')

/**
 * A duration, coarsened as it gets longer — nobody needs seconds on a 12-day countdown, and
 * showing them implies a precision the block-time estimate does not have.
 */
export function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const s = Math.floor(abs / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d >= 2) return `${d}d ${h % 24}h`
  if (h >= 1) return `${h}h ${m % 60}m`
  if (m >= 1) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** "3m ago" / "in 4h 12m". Direction is part of the string so a caller cannot drop it. */
export function formatRelative(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '—'
  const delta = at - now
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`
}

const pad = (n) => String(n).padStart(2, '0')

/** UTC always. A chain has one timeline and it is not the reader's timezone. */
export function formatUtc(at, { seconds = true } = {}) {
  if (!Number.isFinite(at)) return '—'
  const d = new Date(at)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`
  return `${date} ${time}Z`
}

/** The UTC day an instant falls in, as `YYYY-MM-DD` — the bucket key for per-day aggregates. */
export const utcDay = (at) => new Date(at).toISOString().slice(0, 10)

/** Middle-truncate. Only ever for display; the full value is always available to copy. */
export const short = (text, keep = 8) =>
  !text || text.length <= keep * 2 + 1 ? String(text ?? '') : `${text.slice(0, keep)}…${text.slice(-keep)}`

/** plaza's bracketed-metadata convention. */
export const bracket = (text) => `[ ${text} ]`

/**
 * A hex dump, `xxd` layout: offset, 16 bytes, ASCII gutter. The fallback preview for bytes we
 * refused to classify — showing something honest beats guessing a MIME type.
 */
export function hexDump(bytes, limit = 512) {
  const view = bytes.subarray(0, limit)
  const lines = []
  for (let offset = 0; offset < view.length; offset += 16) {
    const row = view.subarray(offset, offset + 16)
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i += 1) {
      hex += i < row.length ? `${row[i].toString(16).padStart(2, '0')} ` : '   '
      if (i === 7) hex += ' '
      if (i < row.length) ascii += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.'
    }
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`)
  }
  if (bytes.length > limit) lines.push(`… ${formatCount(bytes.length - limit)} more bytes`)
  return lines.join('\n')
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * Money and magnitudes. Added for this repo; everything above came from bulletin-explorer.
 *
 * Two figures for the same number, on purpose. `money` is for a chart axis or a legend, where
 * the reader wants the magnitude and the exact digits would be noise. `money2` is for a
 * headline, where the exact digits ARE the point and rounding $612,442 to "$612k" throws away
 * the thing somebody came to read.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

/** $1.2M / $34.5k / $912 — magnitude at a glance. */
export function money(value) {
  const n = Number(value) || 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`
  return `${sign}$${abs.toFixed(2)}`
}

/** $612,442 — every digit, for a headline. */
export function money2(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`
}

/**
 * 1.2M / 34.5k / 912 — the same idea without a currency, for counts and token amounts.
 *
 * Below ten, an INTEGER keeps no decimals and a fraction keeps two. Both halves of that matter.
 * This function is used for trade counts as much as for token amounts, and "3.00 trades" is not
 * a rounding preference, it is a wrong sentence — it reads as a measured quantity when the thing
 * counted is discrete. The fractional branch stays because 5.61 WBTC is not 6 WBTC, and coarsening
 * it the way `money()` coarsens dollars would throw away digits that are the whole point.
 */
export function compact(value) {
  const n = Number(value) || 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`
  if (abs >= 10) return `${sign}${abs.toFixed(0)}`
  if (abs === 0) return '0'
  if (Number.isInteger(abs)) return `${sign}${abs}`
  return `${sign}${abs.toFixed(2)}`
}

/**
 * A quantity of a token, in the token's own units. Adaptive rather than compacted, and that is
 * the difference that matters: `compact()` renders 193,300 cNGN as "193.3k", which hides the
 * rate the reader came to check, and 5.61 WBTC and 6 WBTC are not the same holding. Precision
 * follows magnitude — two decimals above a thousand, eight below one — so a dust balance is
 * still a number rather than a rounded-away zero.
 *
 * `null`/`undefined` render as an em dash and never as `0`: an amount we could not state and an
 * amount of nothing are different facts.
 */
export function tokenAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export const percent = (value, digits = 0) => `${(Number(value) || 0).toFixed(digits)}%`

/** 2026-08-19 -> 19 Aug. Chart labels and tooltips; the full date stays in the table. */
export function fmtDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** An address, shortened, with the middle removed rather than the end — the tail disambiguates. */
export const shortAddr = (value, head = 6, tail = 4) => {
  const text = String(value ?? '')
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
