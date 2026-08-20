// Valuing a trade in dollars when nobody tells you the price.
//
// Both venues we read have the same gap: the indexer knows the token amounts on each leg of a
// swap, and either does not price them at all or prices only the assets it happens to
// recognise. Reading a missing price as zero is the worst available option, because it produces
// a total that is quietly LOW and looks perfectly plausible.
//
// So the rates come out of the order book itself. Any swap with a dollar-pegged leg states what
// the other leg was worth at that moment. Take the median of those observations — one
// fat-fingered order then cannot move the total — and sweep repeatedly, because an asset that
// only ever traded against another derived asset needs the earlier pass to finish first.

/** Anything pegged to the dollar is worth a dollar. Everything else has to be derived. */
export const USD_PEGGED = new Set(['USDC', 'USDT', 'USDT1', 'USDT2', 'DAI', 'USDC1', 'USDC2', 'AUSD', 'HOLLAR'])

/**
 * @param {Array<{ inSymbol: string, inAmount: number, outSymbol: string, outAmount: number }>} legs
 * @param {object} [options]
 * @param {number} [options.passes] how many times to sweep; each pass reaches one hop further
 * @returns {{ rates: Record<string, number>, derived: string[], observations: Record<string, number> }}
 */
export function deriveRates(legs, { passes = 5 } = {}) {
  const rates = {}
  for (const symbol of USD_PEGGED) rates[symbol] = 1

  const usable = legs.filter(
    (leg) => leg.inSymbol && leg.outSymbol && leg.inAmount > 0 && leg.outAmount > 0,
  )

  const derived = []
  const observations = {}

  for (let pass = 0; pass < passes; pass += 1) {
    /** @type {Record<string, number[]>} */
    const seen = {}
    for (const leg of usable) {
      // One side priced, the other not: that is exactly one new price, stated by the trade.
      if (rates[leg.inSymbol] && !rates[leg.outSymbol]) {
        ;(seen[leg.outSymbol] ||= []).push((leg.inAmount * rates[leg.inSymbol]) / leg.outAmount)
      } else if (rates[leg.outSymbol] && !rates[leg.inSymbol]) {
        ;(seen[leg.inSymbol] ||= []).push((leg.outAmount * rates[leg.outSymbol]) / leg.inAmount)
      }
    }

    const found = Object.entries(seen)
    if (!found.length) break // nothing new is reachable; another pass would be identical

    for (const [symbol, list] of found) {
      list.sort((a, b) => a - b)
      rates[symbol] = list[list.length >> 1]
      observations[symbol] = list.length
      derived.push(symbol)
    }
  }

  return { rates, derived, observations }
}

/**
 * Value one side of a trade.
 *
 * Volume is the INPUT leg — what the trader actually sent. Summing both legs doubles it;
 * summing the output credits a swap at whatever came back out, which on a bad fill is not
 * what was traded.
 *
 * Returns `null`, not `0`, when the asset has no rate. A caller that cannot tell "worth nothing"
 * from "we do not know" will report the second as the first.
 */
export function valueUsd(symbol, amount, rates) {
  const rate = rates[symbol]
  return rate === undefined ? null : amount * rate
}
