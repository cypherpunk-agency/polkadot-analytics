// The transfer graph's silent-failure guards, asserted.
//
// Nothing here touches the network. What it covers is the set of things that, when they break,
// produce a page that renders perfectly and says "this account never transferred anything" —
// which is the only failure mode of this module worth writing a test for.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import source, { TRANSFER_EVENTS, BUCKET_SIZE, __test } from '../sources/transfers.mjs'

const { decodeLines, assetKeyOf, normalise, decodeAssetMetadata, localMetadataKey } = __test

const collector = () => {
  const strings = new Map()
  return {
    intern: (s) => (strings.get(s) ?? (strings.set(s, s), s)),
    counts: new Map(),
  }
}

const A = '6d6f646c6461702f627566661c73746167696e67000000000000000000000000'
const B = 'a6573771943017106a9d9401673f6e04c3753fe251a22993f29727f415301567'

test('the event names are exactly the ones the archive is asked for', () => {
  // The archive accepts an event name that does not exist and answers 200 with zero rows, so a
  // typo here is a page that says "no transfers" rather than a page that fails. Pinning the
  // names in a test is the only thing that turns that into a visible change.
  assert.deepEqual(TRANSFER_EVENTS.assetHub, [
    'Balances.Transfer',
    'Assets.Transferred',
    'ForeignAssets.Transferred',
    'PoolAssets.Transferred',
  ])
  assert.deepEqual(TRANSFER_EVENTS.relay, ['Balances.Transfer'])
})

test('positional event arguments THROW rather than folding to an empty graph', () => {
  // The pre-2022 runtimes encode event args as arrays. `args.from` on one of those is
  // `undefined`, `undefined` matches no account, and the result is a confident empty page.
  const lines = [
    {
      header: { number: 8_000_000, timestamp: 1_600_000_000_000 },
      events: [{ name: 'Balances.Transfer', args: [`0x${A}`, `0x${B}`, '1000'] }],
    },
  ]
  assert.throws(() => decodeLines(lines, collector()), /POSITIONAL/)
})

test('a named-object transfer decodes to one edge, with the amount kept as a string', () => {
  const ctx = collector()
  const edges = decodeLines(
    [
      {
        header: { number: 19_710_013, timestamp: 1_787_289_576_000 },
        events: [{ name: 'Balances.Transfer', args: { from: `0x${A}`, to: `0x${B}`, amount: '6886503' } }],
      },
    ],
    ctx,
  )
  assert.equal(edges.length, 1)
  assert.equal(edges[0].from, A)
  assert.equal(edges[0].to, B)
  // A string, never a Number: DOT is 10 decimals and a whale's transfer overflows a double.
  assert.equal(edges[0].amount, '6886503')
  assert.equal(typeof edges[0].amount, 'string')
  assert.equal(edges[0].asset, 'native')
  assert.equal(ctx.counts.get('Balances.Transfer'), 1)
})

test('every event name is counted even when its rows fall outside the window', () => {
  // The counts are what makes a silently-non-matching event name visible on the page, so they
  // must be taken before the timestamp filter, not after.
  const ctx = { ...collector(), cutoffAt: 2_000_000_000_000 }
  const edges = decodeLines(
    [
      {
        header: { number: 1, timestamp: 1_000_000_000_000 },
        events: [{ name: 'Assets.Transferred', args: { assetId: 1984, from: `0x${A}`, to: `0x${B}`, amount: '1' } }],
      },
    ],
    ctx,
  )
  assert.equal(edges.length, 0, 'the row is outside the window')
  assert.equal(ctx.counts.get('Assets.Transferred'), 1, 'but the chain-wide count still saw it')
})

test('asset keys separate the two pallets and never collapse a foreign location onto an id', () => {
  assert.equal(assetKeyOf('Balances.Transfer', {}), 'native')
  assert.equal(assetKeyOf('Assets.Transferred', { assetId: 1984 }), 'assets:1984')
  assert.equal(assetKeyOf('PoolAssets.Transferred', { assetId: 1984 }), 'pool:1984')
  // Asset Hub has two different USDCs — a local one and an Ethereum-issued foreign one. They
  // must never share a key, or the page adds them together under one symbol.
  const foreign = assetKeyOf('ForeignAssets.Transferred', {
    assetId: { parents: 2, interior: { __kind: 'X1', value: [{ __kind: 'GlobalConsensus', value: { __kind: 'Kusama' } }] } },
  })
  assert.notEqual(foreign, 'assets:1984')
  assert.match(foreign, /^foreign:/)
})

test('an account that is not 32 bytes is refused rather than half-matched', () => {
  assert.equal(normalise(`0x${A}`), A)
  assert.equal(normalise(A.toUpperCase()), A)
  assert.equal(normalise('0xdeadbeef'), null)
  assert.equal(normalise(undefined), null)
  assert.equal(normalise({ id: 1 }), null)
})

test('AssetMetadata must consume its input exactly', () => {
  // deposit(u128) ++ name ++ symbol ++ decimals(u8) ++ is_frozen(bool). Anything left over means
  // the layout moved, and every amount scaled with it is wrong by a factor of ten to the
  // something — which renders perfectly. It throws.
  const deposit = '00'.repeat(16) // u128, little-endian
  const name = `104e616d65` //  compact(4) ++ "Name"
  const symbol = `0453` //        compact(1) ++ "S"
  const good = `0x${deposit}${name}${symbol}0600` // ++ decimals=6 ++ is_frozen=false
  assert.throws(() => decodeAssetMetadata(`${good}ff`), /left over/)
  const decoded = decodeAssetMetadata(good)
  assert.equal(decoded.name, 'Name')
  assert.equal(decoded.symbol, 'S')
  assert.equal(decoded.decimals, 6)
  assert.equal(decoded.isFrozen, false)
})

test('the Assets::Metadata key is computed, not hardcoded', () => {
  // A hardcoded prefix is right until a runtime upgrade moves it, and then reads as "this map is
  // empty" rather than as an error. Two different ids must not produce the same key, and the key
  // must be the full 32-byte pallet prefix plus a blake2_128Concat of the u32.
  const k1337 = localMetadataKey(1337)
  const k1984 = localMetadataKey(1984)
  assert.notEqual(k1337, k1984)
  assert.equal(k1337.slice(0, 66), k1984.slice(0, 66), 'same pallet+item prefix')
  // 0x + 32 hex (twox128 ×2) + 32 hex (blake2_128) + 8 hex (the u32 itself)
  assert.equal(k1337.length, 2 + 64 + 32 + 8)
  assert.ok(k1337.endsWith('39050000'), `u32le(1337) little-endian tail, got ${k1337.slice(-8)}`)
})

test('the operation is registered with an account param and a bounded window', () => {
  const op = source.operations['account-graph']
  assert.equal(source.id, 'transfers')
  // `account`, not `string`: readParams normalises hex-or-SS58-any-prefix to the public key, and
  // that normalised value is the cache key. Four spellings of one account must be one entry.
  assert.equal(op.schema.account.type, 'account')
  assert.equal(op.schema.account.required, true)
  assert.equal(op.schema.days.min, 1)
  assert.equal(op.schema.days.max, 7)
  assert.ok(op.ttlMs > 0)
  // A job of the same name would SHADOW this operation on the same URL and answer 200 with an
  // envelope the page cannot draw. There is no job here, and this asserts it stays that way.
  assert.equal(source.jobs?.['account-graph'], undefined)
})

test('the bucket size stays under the archive’s truncation point', () => {
  // The stream silently truncates — measured cuts at 25,699 and 26,749 blocks with HTTP 200 and
  // no header saying so. Buckets are fetched with a continuation loop regardless, but keeping
  // the bucket under the observed cut means the common case is one request.
  assert.ok(BUCKET_SIZE <= 25_000, `bucket of ${BUCKET_SIZE} is at or past the observed truncation point`)
})
