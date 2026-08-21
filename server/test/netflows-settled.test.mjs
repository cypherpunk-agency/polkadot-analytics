// `netflowsMonthIsSettled` — the predicate that decides whether a netflows month may become a job.
//
// It is the most dangerous line in `server/sources/asset-hub.mjs`, and it had no test. A store
// job that reaches `done` frees nothing: `serveFromStore` answers *complete* for that identity
// forever and never enqueues another one. So a predicate that is wrong in the PERMISSIVE
// direction — saying yes to a month that is not finished, or to one whose chains cannot answer —
// does not fail. It freezes a partial or wrong answer permanently, with a full coverage bar.
//
// Two things it must refuse that are easy to get wrong now that there are two networks:
//
//   · A MONTH BEFORE THAT NETWORK'S FLOOR. The floors differ because each network's Asset Hub
//     has a different clockless prefix — Polkadot's clock starts 2021-12-18, Kusama's
//     2021-06-03 — so 2021-07 is answerable on Kusama and not on Polkadot. A single shared floor
//     would either lock Kusama out of five readable months or let Polkadot mint a job for a month
//     whose Asset Hub leg returns `null`, which is indistinguishable from an empty account.
//   · A MISSING OR UNKNOWN NETWORK. The params are the store identity, so a predicate that
//     defaulted an absent `network` would file Kusama days under Polkadot's identity.

import test from 'node:test'
import assert from 'node:assert/strict'

import { netflowsMonthIsSettled } from '../sources/asset-hub.mjs'

/** Well past any settle delay, so these tests are about the FLOOR rather than about the clock. */
const NOW = Date.parse('2026-08-21T08:00:00Z')

test('each network is refused below its own floor and allowed at it', () => {
  // Polkadot: Asset Hub sets no `Timestamp::Now` before #305,204 = 2021-12-18, so 2022-01 is the
  // first whole month. Kusama: #66,687 = 2021-06-03, so 2021-07 is.
  assert.equal(netflowsMonthIsSettled({ month: '2021-12', network: 'polkadot' }, NOW), false)
  assert.equal(netflowsMonthIsSettled({ month: '2022-01', network: 'polkadot' }, NOW), true)

  assert.equal(netflowsMonthIsSettled({ month: '2021-06', network: 'kusama' }, NOW), false)
  assert.equal(netflowsMonthIsSettled({ month: '2021-07', network: 'kusama' }, NOW), true)

  // The floors are genuinely different, which is the whole reason the predicate reads the
  // network: this month is answerable on one chain pair and not on the other.
  assert.equal(netflowsMonthIsSettled({ month: '2021-08', network: 'kusama' }, NOW), true)
  assert.equal(netflowsMonthIsSettled({ month: '2021-08', network: 'polkadot' }, NOW), false)
})

test('a month that has not ended is never immutable, on either network', () => {
  for (const network of ['polkadot', 'kusama']) {
    assert.equal(netflowsMonthIsSettled({ month: '2026-08', network }, NOW), false)
    assert.equal(netflowsMonthIsSettled({ month: '2026-07', network }, NOW), true)
    // The settle delay is real: one minute after the month ends is still not settled.
    assert.equal(netflowsMonthIsSettled({ month: '2026-07', network }, Date.parse('2026-08-01T00:01:00Z')), false)
    assert.equal(netflowsMonthIsSettled({ month: '2026-07', network }, Date.parse('2026-08-01T01:00:01Z')), true)
  }
})

test('a missing or unknown network is refused rather than defaulted', () => {
  // Defaulting here would file one network's days under the other's store identity — with
  // correct-looking numbers, a full coverage bar and nothing anywhere reporting it.
  assert.equal(netflowsMonthIsSettled({ month: '2022-01' }, NOW), false)
  assert.equal(netflowsMonthIsSettled({ month: '2022-01', network: null }, NOW), false)
  assert.equal(netflowsMonthIsSettled({ month: '2022-01', network: 'westend' }, NOW), false)
  assert.equal(netflowsMonthIsSettled({ month: '2022-01', network: 'Polkadot' }, NOW), false)
})

test('anything that is not a well-formed month is refused', () => {
  for (const month of [undefined, null, '', 'nope', '2022-1', '2022-13', '2022-00', '2022-01-01', 202201]) {
    assert.equal(netflowsMonthIsSettled({ month, network: 'polkadot' }, NOW), false, `month ${String(month)}`)
  }
  assert.equal(netflowsMonthIsSettled(undefined, NOW), false)
  assert.equal(netflowsMonthIsSettled(null, NOW), false)
})
