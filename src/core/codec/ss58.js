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
import { base58Encode } from './base.js'
import { concat, utf8 } from './bytes.js'

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

/** Middle-truncated, for tables. Never used where the full address must be copyable. */
export const shortAddress = (address, keep = 6) =>
  !address || address.length <= keep * 2 + 3 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`
