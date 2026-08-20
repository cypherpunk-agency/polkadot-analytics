// What is stored on the Polkadot Bulletin chain.
//
// Bulletin is content-addressed storage with an expiry: you pay to store bytes and the chain
// drops the index entry after a fixed number of blocks. So the interesting questions are not
// "how much is stored" but "what shape is it, who is re-uploading the same bytes to buy another
// lease, and how long has any of it got left".
//
// Two honesty constraints shape the layout, both inherited from the explorer this came from:
//
//   · EXPIRY IS DENOMINATED IN BLOCKS, which is exact. The figure in days is a projection off a
//     measured block rate and is only as good as that rate — so blocks lead and days follow.
//   · PER-DAY BUCKETS ARE ONLY AS GOOD AS THE CLOCK. Two blocks are timed exactly and the rest
//     are interpolated, so an object stored near midnight can land in the neighbouring day. The
//     totals come from exact counts and do not have that problem, and are stated separately.

import '../../design/app.css'
import { renderPage } from '../../design/page.js'
import { read } from '../../core/client.js'
import { pageByKey } from '../../sources/pages.js'
import { append, clear, el, notice, statRow, statTile } from '../../design/dom.js'
import { seriesColor, stackedBars } from '../../design/charts.js'
import { compact, formatBytes, formatCount, percent } from '../../core/format.js'

function render(host, data) {
  clear(host)

  if (data.empty) {
    append(host, notice('warning', 'The index is empty', 'The chain answered, and has nothing stored in the retained window.'))
    return
  }

  const { chain, totals, days, codecs, hashes, shapes, buckets, notes: sourceNotes } = data
  const duplicateShare = totals.totalBytes ? totals.duplicateBytes / totals.totalBytes : 0

  append(
    host,
    statRow([
      statTile('Objects', formatCount(totals.count), `across ${formatCount(chain.blockKeyCount)} blocks that stored something`, { hero: true }),
      statTile('Total stored', formatBytes(totals.totalBytes), `mean ${formatBytes(totals.meanBytes)}`),
      statTile(
        'Retention',
        `${formatCount(chain.retentionBlocks)} blocks`,
        `≈ ${chain.retentionDays.toFixed(1)} days at the measured rate · ${retentionProvenance(chain.retention)}`,
      ),
      statTile('Head', `block ${formatCount(chain.headBlock)}`, `oldest indexed: ${formatCount(chain.oldestBlock)}`),
    ]),

    leaseCard(chain, totals, duplicateShare),
    perDayCard(days),
    breakdownCard('Content shape', shapes, 'What each object IS, read from the index row alone — codec, exact size, and the hashing algorithm as a producer fingerprint. This covers every row and costs nothing extra.', totals.count, true),
    breakdownCard('Codec', codecs, 'How the bytes are framed. Raw blocks and dag-pb manifests are the two that matter here.', totals.count),
    breakdownCard('Hash algorithm', hashes, 'A fingerprint of the tool that uploaded it: sha2-256 is IPFS-native tooling, blake2b is the SDK’s own store().', totals.count),
    sizeCard(buckets, totals.count),
    notesSection(chain, sourceNotes),
  )
}

/**
 * Four words on the retention tile saying where its number came from.
 *
 * The tile is the one place the retention figure is read at a glance, and a live reading and an
 * inherited literal render identically without this. The long version is in the data notes; this
 * is the marker that sends a reader there.
 */
function retentionProvenance(retention) {
  if (!retention) return 'provenance not recorded'
  if (retention.source !== 'chain') return 'inherited literal, not read'
  return retention.stale || retention.unreachable ? 'read from chain state earlier' : 'read live from chain state'
}

/* ------------------------------------------------------------------------- the leases ---- */

/**
 * The structural fact that makes every other number on this page mean something: nobody has
 * ever renewed anything, so the duplicate share is not waste — it is people re-uploading
 * identical bytes because that is the only way to buy another lease.
 */
function leaseCard(chain, totals, duplicateShare) {
  const card = el(
    'section.card',
    null,
    el('header', null, el('h2', { text: 'Leases, and the workaround' })),
    statRow([
      statTile('Distinct content', formatCount(totals.distinctContent), `from ${formatCount(totals.count)} index entries`),
      statTile('Re-stored bytes', formatBytes(totals.duplicateBytes), `${percent(duplicateShare * 100, 1)} of everything here`),
      statTile('Stored twice or more', formatCount(totals.repeatedContent), `most-repeated: ×${formatCount(totals.maxCopies)}`),
      statTile('Renewals, ever', formatCount(totals.renewals), totals.renewals ? 'kind = Renew' : 'every entry is kind = Store'),
    ]),
  )

  append(
    card,
    totals.renewals
      ? notice(
          'info',
          `${formatCount(totals.renewals)} entries are renewals`,
          'This is new. Until now every entry on this chain has been a Store. A Renew is how stored data becomes permanent, counted against the runtime’s MaxPermanentStorageSize — the expiry projections on this page do not yet account for it.',
        )
      : notice(
          'info',
          'No lease on this chain has ever been renewed',
          `Checked live against all ${formatCount(totals.count)} entries in the window: \`kind\` is the pallet's Store/Renew discriminant, and every single entry is Store. Not one Renew has ever been submitted.`,
          `That is what makes the retention figure real rather than theoretical. Renewal is the mechanism by which stored data becomes permanent, and nobody has used it — so every byte here is on a one-way clock. The re-stored figure above is the visible workaround: people re-upload identical bytes to buy another ${formatCount(chain.retentionBlocks)} blocks.`,
        ),
  )
  return card
}

/* ---------------------------------------------------------------------------- per day ---- */

function perDayCard(days) {
  const card = el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Objects stored per day' }),
      el('p.note', {
        text: 'Bucketed by interpolated timestamp: only two blocks in the window are timed exactly, so an object stored near midnight may fall in the adjacent day. The totals elsewhere on this page come from exact counts and are not affected.',
      }),
    ),
  )

  const series = [{ label: 'objects' }]
  const rows = days.map((day) => ({ date: day.day, count: day.count, usd: day.count, stack: [day.count], bytes: day.bytes }))
  const plot = el('div.plot')
  append(card, plot, dayTable(days))
  queueMicrotask(() => stackedBars(plot, { days: rows, series, format: compact }))
  return card
}

function dayTable(days) {
  const body = el('tbody')
  for (const day of [...days].reverse()) {
    append(
      body,
      el('tr', null, el('td', { text: day.day }), el('td.num', { text: formatCount(day.count) }), el('td.num', { text: formatBytes(day.bytes) })),
    )
  }
  return el(
    'details.data-table',
    null,
    el('summary', { text: `Daily figures — ${days.length} UTC days` }),
    el(
      'div.tablewrap.scroll-y',
      null,
      el(
        'table.data',
        null,
        el('thead', null, el('tr', null, el('th', { text: 'UTC day' }), el('th.num', { text: 'Objects' }), el('th.num', { text: 'Bytes' }))),
        body,
      ),
    ),
  )
}

/* ------------------------------------------------------------------------ breakdowns ---- */

/**
 * @param {boolean} [withPrecision] shape rules are a mix of structural facts and producer
 *   fingerprints; the column separates the two rather than presenting a guess as a fact.
 */
function breakdownCard(title, rows, note, total, withPrecision = false) {
  const max = Math.max(...rows.map((row) => row.count), 1)
  const list = el('div.rows')
  rows.forEach((row, i) => {
    const share = total ? (row.count / total) * 100 : 0
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: row.label }),
        el('div.track', null, el('div.fill', { style: `width:${Math.max(0.5, (row.count / max) * 100)}%;background:${seriesColor(i)}` })),
        el(
          'div.amt',
          null,
          document.createTextNode(formatCount(row.count)),
          el('span.cnt', {
            text:
              ` · ${percent(share, 1)} · ${formatBytes(row.bytes)}` +
              (withPrecision && row.precision !== null && row.precision !== undefined
                ? row.certain
                  ? ' · fact'
                  : ` · ~${percent(row.precision * 100, 1)} right`
                : ''),
          }),
        ),
      ),
    )
  })

  return el('section.card', null, el('header', null, el('h2', { text: title }), el('p.note', { text: note })), list)
}

function sizeCard(buckets, total) {
  const max = Math.max(...buckets.map((b) => b.count), 1)
  const list = el('div.rows')
  buckets.forEach((bucket) => {
    append(
      list,
      el(
        'div.row',
        null,
        el('div.name', { text: bucket.label }),
        el('div.track', null, el('div.fill', { style: `width:${Math.max(0.5, (bucket.count / max) * 100)}%` })),
        el(
          'div.amt',
          null,
          document.createTextNode(formatCount(bucket.count)),
          el('span.cnt', { text: ` · ${percent(total ? (bucket.count / total) * 100 : 0, 1)} · ${formatBytes(bucket.bytes)}` }),
        ),
      ),
    )
  })

  return el(
    'section.card',
    null,
    el(
      'header',
      null,
      el('h2', { text: 'Size histogram' }),
      el('p.note', { text: 'Powers of two, because the population spans 60-byte messages and megabyte bundle chunks in the same list. A linear histogram would be one bar and a long empty tail.' }),
    ),
    list,
  )
}

/* ------------------------------------------------------------------------------ notes ---- */

function notesSection(chain, sourceNotes) {
  const drift = ((chain.blockMs - chain.nominalBlockMs) / chain.nominalBlockMs) * 100
  return el(
    'section.meta',
    null,
    el('h2', { text: 'Data notes' }),
    el('p', {
      text: `Read from the Bulletin devnet RPC. Measured block rate is ${(chain.blockMs / 1000).toFixed(3)}s against the pallet's nominal ${(chain.nominalBlockMs / 1000).toFixed(3)}s — a drift of ${percent(drift, 1)}, which is why the retention figure in days is derived rather than assumed.`,
    }),
    // Prominent, not buried in the list, for the one case where the page is showing a number
    // nobody on this load confirmed. The list entry below carries the full explanation.
    chain.retention?.source === 'fallback'
      ? notice(
          'warning',
          'The retention period was not read from the chain on this load',
          `${chain.retention.reason}. The ${formatCount(chain.retentionBlocks)}-block figure above, and every day figure derived from it, is the value this repo inherited rather than one it measured.`,
        )
      : null,
    el('ul', null, ...(sourceNotes ?? []).map((note) => el('li', { text: note }))),
    el('p', {
      text: 'Storage keys here are computed from the pallet and item names, never hardcoded — the transaction-index prefix and the RetentionPeriod key alike. A hardcoded prefix stays right until a runtime upgrade moves it, and then reads as "this map is empty" rather than as an error.',
    }),
    el(
      'p',
      null,
      document.createTextNode('The full interactive explorer — object bodies, link graphs, the live tail — lives in the '),
      el('a', { href: 'https://github.com/cypherpunk-agency/polkadot-analytics/blob/main/docs/platform/bulletin.md', text: 'yolodot repo' }),
      document.createTextNode('. What is here is the analytics half, which is the part that is safe to publish at a public URL: it costs about forty cached RPC calls per ten minutes rather than several thousand per visitor.'),
    ),
  )
}

renderPage({
  page: pageByKey('bulletin'),
  intro:
    'Bulletin is content-addressed storage with a lease. You pay to put bytes on it and the chain forgets them after a fixed number of blocks unless somebody renews. This is what is on it right now, what shape those bytes are, and what everyone is doing about the expiry.',
  load: () => read('bulletin', 'index'),
  render,
})
