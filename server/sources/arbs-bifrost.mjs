// Bifrost — the liquid-staking chain that issues vDOT.
//
// This module exists for exactly one number: **the true vDOT redemption rate**, the DOT that
// one vDOT is currently worth. It is here rather than inside the Hydration module because it
// is a different upstream, and one module per upstream is the rule that keeps the registry an
// honest list of who we talk to.
//
// ── why an external anchor is the point, not a convenience ──────────────────────────────────
// Hydration's stableswap pool 690 (vDOT/aDOT) carries a peg fed by an on-chain oracle. That
// peg is a *claim about* the redemption rate. Whether the claim is currently true is not
// answerable from Hydration alone — you have to go and ask the issuing chain. A monitor that
// compares the two is a risk fact; a single reading of either is not.
//
// ── what this number IS, precisely, and it is not a storage read ────────────────────────────
// `dapi.bifrost.io/api/site` is Bifrost's own public REST aggregate. The rate here is its
// `tvm / totalIssuance` — the same arithmetic Bifrost's own front page does. It is NOT a
// decode of the `VtokenMinting::TokenPool` / `Tokens::TotalIssuance` storage items on the
// Bifrost chain, which is the authoritative source and which this repo has not verified: the
// `CurrencyId` encoding involved (`{"VToken2":0}`, and the footgun that `TokenPool` is keyed
// by the *vToken* id) is documented in second-hand notes and nowhere else here.
//
// So this is a third-party number, from the interested party, and every page that shows it
// says so. When it is unavailable the answer is `null` and the gap is "not measurable right
// now" — never zero, and never silently the on-chain peg, which would make the monitor agree
// with itself by construction.

import { callUpstream, UpstreamError } from '../lib/upstream.mjs'

const SITE = 'https://dapi.bifrost.io/api/site'

/**
 * The live vDOT block of Bifrost's public site aggregate.
 *
 * @returns {Promise<{apy:number|null, apyBase:number|null, apyReward:number|null,
 *   tvm:number|null, totalIssuance:number|null, rate:number|null, holders:number|null}>}
 */
export async function fetchVdot() {
  const body = await callUpstream({ source: 'bifrost-dapi', url: SITE, timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 })
  const block = body?.vDOT
  if (!block || typeof block !== 'object') {
    throw new UpstreamError('bifrost-dapi answered without a vDOT block.', { kind: 'decode', source: 'bifrost-dapi' })
  }

  const num = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  const tvm = num(block.tvm)
  const totalIssuance = num(block.totalIssuance)
  // `null` is not `0`: a missing or zero issuance means "we cannot compute a rate", which is a
  // different fact from "the rate is zero" and must not divide.
  const rate = tvm !== null && totalIssuance !== null && totalIssuance > 0 ? tvm / totalIssuance : null

  if (rate !== null && (rate < 1 || rate > 5)) {
    // A liquid-staking derivative accrues; its redemption rate starts at 1 and only rises, and
    // it has been rising for years at a few percent a year. A rate outside this band is not a
    // market move, it is a units change — and a units change here would silently rewrite the
    // oracle-gap chart rather than break it.
    throw new UpstreamError(
      `bifrost-dapi reports a vDOT redemption rate of ${rate}, outside the 1–5 DOT/vDOT band a liquid-staking derivative can occupy. Refusing to publish a gap computed against it.`,
      { kind: 'decode', source: 'bifrost-dapi' },
    )
  }

  return {
    apy: num(block.apy),
    apyBase: num(block.apyBase),
    apyReward: num(block.apyReward),
    tvm,
    totalIssuance,
    rate,
    holders: num(block.holders),
  }
}

export default {
  id: 'arbs-bifrost',
  label: 'Bifrost (vDOT issuer)',
  homepage: 'https://bifrost.io',
  transport: 'rest',
  doc: 'docs/platform/hydration.md',
  covers: ['Bifrost Polkadot (parachain 2030) — vDOT only'],

  operations: {
    vdot: {
      summary:
        'The vDOT liquid-staking block of Bifrost’s own public site aggregate: staking APY, DOT under management, vDOT issued, and the implied redemption rate.',
      // Fifteen minutes. The rate moves by a few basis points a day; this is a free anonymous
      // endpoint belonging to somebody else and there is no reason to poll it harder.
      ttlMs: 900_000,
      schema: {},
      async run() {
        const vdot = await fetchVdot()
        return {
          vdot,
          fetchedAt: new Date().toISOString(),
          notes: [
            'The redemption rate here is Bifrost’s own `tvm / totalIssuance`, read from its public site API. It is not a decode of the `VtokenMinting::TokenPool` and `Tokens::TotalIssuance` storage items on the Bifrost chain, which are the authoritative source — this repo has not verified the CurrencyId encoding those reads need.',
            'This is a third-party number published by the issuer of the asset it describes. It is the external anchor a Hydration-only reading cannot provide, and it is not independent of Bifrost.',
            vdot.rate === null
              ? 'The rate could not be computed from this response: one of `tvm` or `totalIssuance` was missing or zero. It is reported as unavailable rather than as zero.'
              : `Implied rate ${vdot.rate.toFixed(6)} DOT per vDOT, from ${vdot.tvm} DOT under management against ${vdot.totalIssuance} vDOT issued.`,
          ],
        }
      },
    },
  },
}
