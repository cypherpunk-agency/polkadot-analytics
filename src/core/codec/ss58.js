// SS58 address encoding. 30 lines on top of blake2b + base58.
//
// The submitter of a store is a raw 32-byte AccountId sitting inside a signed extrinsic.
// Rendering that as hex would be technically correct and useless — nobody recognises their
// own account as hex. SS58 is the form that appears in the faucet, the wallet and the
// block explorer, so it is the only form worth showing.
//
// Prefix 42 is the generic Substrate prefix, which is what the Bulletin chain uses; a
// wrong prefix produces a valid-looking address that belongs to nobody.

import { blake2b } from './blake2b.js'
import { base58Encode, base58Decode } from './base.js'
import { concat, utf8, toHex } from './bytes.js'

const PREFIX_BYTES = utf8('SS58PRE')

/**
 * @param {Uint8Array} accountId 32 bytes
 * @param {number} networkPrefix 0..63 (single-byte form; the 2-byte form is unused here)
 * @returns {string|null}
 */
export function encodeSs58(accountId, networkPrefix = 42) {
  if (!accountId || accountId.length !== 32) return null
  if (networkPrefix > 63) return null // 2-byte prefixes exist but no chain we read uses one

  const payload = concat(Uint8Array.of(networkPrefix), accountId)
  // The checksum covers the prefix byte too, which is why it cannot be precomputed.
  const checksum = blake2b(concat(PREFIX_BYTES, payload), 64).slice(0, 2)
  return base58Encode(concat(payload, checksum))
}

/**
 * The inverse, and the reason it exists: **the same account is a different string on every
 * chain.** Prefix 0 on Polkadot, 2 on Kusama, 42 generic, 63 on Hydration — one 32-byte public
 * key, four addresses. Anything that joins two datasets on the DISPLAY string finds nothing and
 * renders as "this account has never done anything", which is a sentence a reader will believe.
 * So every join here is on the public key, and this is how a pasted address becomes one.
 *
 * The checksum is VERIFIED, not skipped. Without it a single mistyped character decodes to a
 * different, perfectly well-formed account — an empty page about somebody who does not exist.
 *
 * Only the single-byte prefix form (0..63) is decoded. Two-byte prefixes exist and no chain
 * this site reads uses one; returning `null` for them says so, where guessing would not.
 *
 * @param {string} address
 * @returns {{accountId: Uint8Array, hex: string, prefix: number}|null}
 *   null for: not base58, wrong length, a two-byte prefix, or a failed checksum.
 */
export function decodeSs58(address) {
  const bytes = base58Decode(String(address ?? '').trim())
  // 1 prefix byte + 32 account bytes + 2 checksum bytes. Nothing else is an AccountId32.
  if (!bytes || bytes.length !== 35) return null

  const prefix = bytes[0]
  // 0x40 and up is the two-byte form's marker, not a prefix value.
  if (prefix >= 64) return null

  const payload = bytes.subarray(0, 33)
  const checksum = blake2b(concat(PREFIX_BYTES, payload), 64)
  if (checksum[0] !== bytes[33] || checksum[1] !== bytes[34]) return null

  const accountId = bytes.slice(1, 33)
  return { accountId, hex: `0x${toHex(accountId)}`, prefix }
}

/** Middle-truncated, for tables. Never used where the full address must be copyable. */
export const shortAddress = (address, keep = 6) =>
  !address || address.length <= keep * 2 + 3 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`

/**
 * The round trip, checked at import — the same posture as `decodeAssetDetails` and the sovereign
 * derivation in topology.js, and for the same reason: every way this can be wrong is silent.
 * A broken checksum check accepts typos; a broken base58 decode returns a valid-looking account
 * that belongs to nobody; either produces a page that renders perfectly about the wrong address.
 *
 * The two fixtures are addresses this repository has already verified against a chain — the
 * sibling sovereign of para 2034 (docs/platform/xcm.md, read live 2026-08-19, holds 5,285,506.68
 * USDC on Asset Hub) and Acala's relay sovereign from the Polkalytics capture. The third is the
 * same 32 bytes under Hydration's display prefix, which is what this feature renders.
 */
const SS58_FIXTURES = [
  { prefix: 0, address: '13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6', hex: '0x7369626cf2070000000000000000000000000000000000000000000000000000' },
  { prefix: 0, address: '13YMK2eYoAvStnzReuxBjMrAvPXmmdsURwZvc62PrdXimbNy', hex: '0x70617261d0070000000000000000000000000000000000000000000000000000' },
  { prefix: 63, address: '7L53bUTBopuwFt3mKUfmkzgGLayYa1Yvn1hAg9v5UMrQzTfh', hex: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000' },
]

for (const fixture of SS58_FIXTURES) {
  const decoded = decodeSs58(fixture.address)
  if (!decoded || decoded.hex !== fixture.hex || decoded.prefix !== fixture.prefix) {
    throw new Error(
      `ss58: decodeSs58 no longer reproduces a verified account — ${fixture.address} decoded as ` +
        `${decoded ? `${decoded.hex} (prefix ${decoded.prefix})` : 'null'}, expected ${fixture.hex} ` +
        `(prefix ${fixture.prefix}). Every lookup keyed on a decoded address is wrong and empty.`,
    )
  }
  if (encodeSs58(decoded.accountId, fixture.prefix) !== fixture.address) {
    throw new Error(`ss58: the encode/decode round trip no longer closes for ${fixture.address}.`)
  }
  // A one-character typo must be REJECTED, not silently resolved to a different account.
  const typo = fixture.address.slice(0, -1) + (fixture.address.endsWith('a') ? 'b' : 'a')
  if (decodeSs58(typo) !== null) {
    throw new Error('ss58: the checksum check is not rejecting a mistyped address.')
  }
}
