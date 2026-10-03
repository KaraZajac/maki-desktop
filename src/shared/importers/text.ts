/**
 * Text and bytes as exports hold them: files in UTF-8 or UTF-16 (or, from older software,
 * Windows-1252), binary values in base64, base64url or hex. No Node or DOM imports: this runs in
 * the window and in tests.
 */

const utf8 = new TextEncoder()

/**
 * A file's text: UTF-16 by its byte-order mark, else UTF-8 (its mark, if any, dropped), else
 * Windows-1252, which is what a file that isn't UTF-8 most likely is (one saved by Excel on
 * Windows), and which the owner is told of.
 */
export function decodeText(bytes: Uint8Array): {
  text: string
  encoding: 'UTF-8' | 'UTF-16' | 'Windows-1252'
} {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }
  }
}

/** How many bytes `s` takes in UTF-8, as maki counts a `str8`'s length. */
export function utf8Length(s: string): number {
  return utf8.encode(s).length
}

/**
 * Whether `s` has a control character (Unicode's Cc: U+0000 to U+001F and U+007F to U+009F), which
 * maki won't keep in a record: it keeps them as lines of text, and its owner reads them on screen.
 */
export function hasControl(s: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(s)
}

/**
 * A label (a title, an issuer, a name) as maki can keep it: each run of control characters (a
 * line break, a tab) made a space, trimmed, and cut to at most `max` bytes of UTF-8 on a
 * character's edge.
 */
export function label(s: string, max = 255): string {
  const out = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return utf8Length(out) <= max ? out : cutTo(out, max).trimEnd()
}

/** `s` cut to at most `max` bytes of UTF-8, on a character's edge. */
export function cutTo(s: string, max: number): string {
  let bytes = 0
  let cut = ''
  for (const c of s) {
    const n = utf8Length(c)
    if (bytes + n > max) break
    bytes += n
    cut += c
  }
  return cut
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Bytes from base64 or base64url (either alphabet, with or without padding, whitespace ignored),
 * or null if it isn't: exports write keys and credential IDs in one or the other.
 */
export function fromBase64Any(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let at = 0
  for (const c of clean) {
    value = (value << 6) | B64.indexOf(c)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out
}

/** Bytes from hex (either case), or null if it isn't. */
export function fromHexAny(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, '')
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Bytes as base64url without padding, as WebAuthn writes them. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_')
}

/** Text from bytes that should be UTF-8, or null if they aren't. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** `n` and a word, in the plural unless there's one: "1 login", "3 logins". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A value from a parsed JSON file as a string: numbers and booleans as written, anything else empty. */
export function str(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : ''
}

/** A value from a parsed JSON file as a plain object, or null if it isn't one. */
export function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** A value from a parsed JSON file as an array (empty if it isn't one). */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
