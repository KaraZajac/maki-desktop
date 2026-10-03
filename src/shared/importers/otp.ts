/**
 * Codes (TOTP, RFC 6238) as exports write them: otpauth:// URIs (Google Authenticator's key URI
 * format), bare base32 secrets, Bitwarden's `steam://`; read into what maki keeps, or why maki
 * can't make the code (a counter-based one, Steam Guard's, an algorithm or a length maki's codes
 * don't use).
 */
import type { FoundCode } from './model'
import { label } from './text'

/** A code as maki keeps it (`../import.ts`'s kind 2). */
export interface Totp {
  issuer: string
  account: string
  /** the key itself: 10 to 64 bytes */
  secret: Uint8Array
  /** 1 SHA-1, 2 SHA-256, 3 SHA-512 */
  algorithm: 1 | 2 | 3
  /** 6 to 8 */
  digits: number
  /** 15 to 300 seconds */
  period: number
}

/** The shortest and longest secret maki takes, in bytes: 80 bits, the shortest sites use, to 512. */
export const MIN_SECRET = 10
export const MAX_SECRET = 64

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Bytes from base32 as authenticators take it: either case, spaces, hyphens and padding ignored;
 * null if it isn't base32. Bits left over at the end are dropped, as authenticators drop them.
 */
export function fromBase32(s: string): Uint8Array | null {
  const clean = s
    .replace(/[\s-]+/g, '')
    .replace(/=+$/, '')
    .toUpperCase()
  if (clean === '' || !/^[A-Z2-7]+$/.test(clean)) return null
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8))
  let bits = 0
  let value = 0
  let at = 0
  for (const c of clean) {
    value = ((value << 5) | BASE32.indexOf(c)) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out
}

const ALGORITHMS: Record<string, 1 | 2 | 3> = { SHA1: 1, SHA256: 2, SHA512: 3 }

/**
 * A code from an export, with `fallback`'s issuer and account where the code doesn't name them
 * (a bare secret names neither: the entry's title and username, then): the code as maki keeps it,
 * or why maki can't make it.
 */
export function readCode(
  found: FoundCode,
  fallback: { issuer: string; account: string }
): { code: Totp } | { why: string } {
  let secret: Uint8Array | null = null
  let algorithm = 'SHA1'
  let digits = 6
  let period = 30
  let issuer = ''
  let account = ''
  if (typeof found === 'string') {
    const text = found.trim()
    if (/^steam:\/\//i.test(text)) return { why: 'a Steam Guard code, which isn’t RFC 6238’s' }
    if (/^otpauth-migration:/i.test(text))
      return { why: 'a Google Authenticator transfer, not a code: add its codes one at a time' }
    if (/^otpauth:/i.test(text)) {
      let uri: URL
      try {
        uri = new URL(text)
      } catch {
        return { why: 'a code whose otpauth address can’t be read' }
      }
      const type = uri.host.toLowerCase()
      const params = new Map<string, string>()
      for (const [k, v] of uri.searchParams) params.set(k.toLowerCase(), v)
      if (type === 'hotp')
        return { why: 'a counter-based code (HOTP), where maki’s are time-based (TOTP)' }
      if (type === 'steam' || (params.get('encoder') ?? '').toLowerCase() === 'steam')
        return { why: 'a Steam Guard code, which isn’t RFC 6238’s' }
      if (type !== 'totp') return { why: `a code of a kind maki doesn’t know (${type})` }
      secret = fromBase32(params.get('secret') ?? '')
      if (secret === null) return { why: 'a code with no secret, or one that isn’t base32' }
      if (params.has('algorithm')) algorithm = params.get('algorithm') ?? ''
      if (params.has('digits')) digits = Number(params.get('digits'))
      if (params.has('period')) period = Number(params.get('period'))
      // the label: "Issuer:account", or the account alone
      let name = uri.pathname.replace(/^\/+/, '')
      try {
        name = decodeURIComponent(name)
      } catch {
        // as it's written, then
      }
      const colon = name.indexOf(':')
      account = colon >= 0 ? name.slice(colon + 1) : name
      issuer = params.get('issuer') || (colon >= 0 ? name.slice(0, colon) : '')
    } else {
      secret = fromBase32(text)
      if (secret === null) return { why: 'a code whose secret isn’t base32' }
    }
  } else {
    if (found.kind === 'hotp')
      return { why: 'a counter-based code (HOTP), where maki’s are time-based (TOTP)' }
    if (found.kind === 'steam') return { why: 'a Steam Guard code, which isn’t RFC 6238’s' }
    secret = typeof found.secret === 'string' ? fromBase32(found.secret) : found.secret
    if (secret === null) return { why: 'a code whose secret isn’t base32' }
    if (found.algorithm !== undefined) algorithm = found.algorithm
    if (found.digits !== undefined) digits = found.digits
    if (found.period !== undefined) period = found.period
    issuer = found.issuer ?? ''
    account = found.account ?? ''
  }
  const algo = ALGORITHMS[algorithm.toUpperCase().replace(/[^A-Z0-9]/g, '')]
  if (algo === undefined)
    return {
      why: `a code made with ${algorithm || 'no algorithm'}, where maki’s use SHA-1, SHA-256 or SHA-512`
    }
  if (!Number.isInteger(digits)) return { why: 'a code whose number of digits can’t be read' }
  if (digits < 6 || digits > 8)
    return { why: `a code of ${digits} digits, where maki’s have 6 to 8` }
  if (!Number.isInteger(period)) return { why: 'a code whose period can’t be read' }
  if (period < 15 || period > 300)
    return {
      why: `a code that changes every ${period} seconds, where maki’s change every 15 to 300`
    }
  if (secret.length < MIN_SECRET)
    return {
      why: `a code whose secret is ${secret.length} bytes, shorter than the ${MIN_SECRET} maki takes`
    }
  if (secret.length > MAX_SECRET)
    return { why: `a code whose secret is longer than the ${MAX_SECRET} bytes maki takes` }
  issuer = label(issuer) || label(fallback.issuer)
  account = label(account) || label(fallback.account)
  return { code: { issuer, account, secret, algorithm: algo, digits, period } }
}
