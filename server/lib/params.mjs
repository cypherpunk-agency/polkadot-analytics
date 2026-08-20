// Parameter validation for the public API.
//
// Every value in here arrives from the open internet. Two things follow, and the second is the
// one that is easy to forget:
//
//   · REJECT what is out of range, rather than clamping silently. A page that asks for 5,000
//     days and gets 90 without being told is a page that draws a confident, wrong chart.
//   · NORMALISE what is accepted, because the normalised value is the CACHE KEY. If `days=7`
//     and `days=07` produce different keys, the cache silently halves its own hit rate and
//     doubles the load on an upstream we do not own.

import { decodeSs58 } from '../../src/core/codec/ss58.js'

export class ParamError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ParamError'
  }
}

/** @typedef {{ type:'int'|'string'|'bool'|'date'|'list'|'account', [k:string]: any }} Spec */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {Record<string, string>} raw    query-string values, all strings
 * @param {Record<string, Spec>} schema
 * @returns {Record<string, unknown>} normalised, with defaults filled in
 */
export function readParams(raw, schema) {
  const out = {}
  for (const [name, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(raw, name) && raw[name] !== ''
    if (!present) {
      if (spec.required) throw new ParamError(`\`${name}\` is required.`)
      if ('default' in spec) out[name] = spec.default
      continue
    }
    out[name] = coerce(name, raw[name], spec)
  }

  // An unknown parameter is a caller bug — usually a typo in a name that then silently does
  // nothing. Saying so costs nothing and saves an afternoon.
  // `hasOwnProperty`, not `in`: `in` walks the prototype chain, so `?__proto__=`, `?toString=`
  // and `?constructor=` were all "known" parameters of every schema and slipped through this
  // check silently. They were then dropped from `out` (which is built from the schema, so no
  // pollution and no key divergence) — but silently accepting a parameter that does nothing is
  // precisely what this loop exists to prevent.
  for (const name of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw new ParamError(`Unknown parameter \`${name}\`.`)
    }
  }
  return out
}

function coerce(name, value, spec) {
  switch (spec.type) {
    case 'int': {
      if (!/^-?\d+$/.test(value)) throw new ParamError(`\`${name}\` must be an integer.`)
      const n = Number(value)
      if (spec.min !== undefined && n < spec.min) throw new ParamError(`\`${name}\` must be at least ${spec.min}.`)
      if (spec.max !== undefined && n > spec.max) throw new ParamError(`\`${name}\` must be at most ${spec.max}.`)
      return n
    }
    case 'bool': {
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
      throw new ParamError(`\`${name}\` must be true or false.`)
    }
    case 'date': {
      if (!ISO_DATE.test(value)) throw new ParamError(`\`${name}\` must be a date as YYYY-MM-DD.`)
      if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ParamError(`\`${name}\` is not a real date.`)
      return value
    }
    case 'string': {
      if (spec.oneOf && !spec.oneOf.includes(value)) {
        throw new ParamError(`\`${name}\` must be one of: ${spec.oneOf.join(', ')}.`)
      }
      if (spec.pattern && !spec.pattern.test(value)) throw new ParamError(`\`${name}\` is not in the expected form.`)
      if (spec.maxLength && value.length > spec.maxLength) {
        throw new ParamError(`\`${name}\` is longer than ${spec.maxLength} characters.`)
      }
      return value
    }
    /**
     * A Substrate AccountId32, however the caller happens to spell it, normalised to lowercase
     * `0x…` hex — the public key, which is the only form two chains agree on.
     *
     * This belongs HERE rather than in the operation, and the reason is the note at the top of
     * this file: the normalised value is the cache key. `0x3BB8…`, `0x3bb8…`,
     * `7JwrmyK5iyj3sZPKWNvWJqNWLSot8nwxrpp4mviqpfhM3TCx` (Hydration, prefix 63) and
     * `12MJVUCgWedG2ru6SqW1X4cjcsoMgFHAyZuo1sCseoEdJxvk` (Polkadot, prefix 0) are ONE account.
     * Left un-normalised they are four cache entries and four identical fetches of somebody
     * else's database, and the operation that reads them has no way to know they were the same
     * question.
     *
     * A failed SS58 checksum is REJECTED rather than shrugged at. One mistyped character decodes
     * to a different, perfectly well-formed account, and the page that results is not an error —
     * it is a confident, empty page about an address that does not exist.
     */
    case 'account': {
      const text = String(value).trim()
      if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase()
      if (/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(text)) {
        const decoded = decodeSs58(text)
        if (decoded) return decoded.hex
        throw new ParamError(
          `\`${name}\` looks like an SS58 address but its checksum does not verify. One wrong ` +
            'character is a different account, so it is refused rather than looked up.',
        )
      }
      throw new ParamError(
        `\`${name}\` must be a 32-byte account: either \`0x\` + 64 hex characters, or an SS58 ` +
          'address (any network prefix — they are all the same public key).',
      )
    }
    case 'list': {
      const items = value.split(',').filter(Boolean)
      if (spec.maxItems && items.length > spec.maxItems) {
        throw new ParamError(`\`${name}\` accepts at most ${spec.maxItems} items.`)
      }
      for (const item of items) {
        if (spec.pattern && !spec.pattern.test(item)) throw new ParamError(`\`${name}\` contains an unexpected value.`)
      }
      return items
    }
    default:
      throw new ParamError(`\`${name}\` has no validator.`)
  }
}

/** Stable cache key: sorted, so `?a=1&b=2` and `?b=2&a=1` are one entry rather than two. */
export function cacheKey(sourceId, operation, params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
  return `${sourceId}/${operation}?${parts.join('&')}`
}
