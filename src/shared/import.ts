/**
 * Imports for maki: logins, codes and passkeys from another password manager, as maki's link
 * takes them (IMPORT_PUT, `libs/maki-proto/PROTOCOL.md`): the records, each checked here as maki
 * checks it, so what's sent is only what maki will take, and what it won't is said with why; then
 * the bytes. maki has the last word: it checks every record again, and refuses the whole import
 * (naming the record) if one doesn't pass.
 *
 * No Node or DOM imports here: this runs in the window and in tests.
 */
import type { ApprovalValue } from './protocol'
import { hasControl, utf8Length } from './importers/text'
import { validHost } from './importers/site'

/** What an import starts with. */
export const IMPORT_MAGIC = 'MAKIIMP1'
/** Pieces of an import are at most this big. */
export const IMPORT_PIECE = 4096
/** The biggest import maki takes at once. */
export const MAX_IMPORT = 512 * 1024
/** The longest a source's name may be, in bytes. */
export const MAX_SOURCE = 32
/** The most records one import holds: maki reads them all into its memory before it asks. */
export const MAX_RECORDS = 2000

/** A login: a site, a username (may be empty) and a password, and the entry's name in the manager. */
export interface LoginRecord {
  kind: 'login'
  site: string
  username: string
  password: string
  title: string
}

/** A code (TOTP, RFC 6238). */
export interface CodeRecord {
  kind: 'code'
  issuer: string
  account: string
  /** the key itself: 10 to 64 bytes */
  secret: Uint8Array
  /** 1 SHA-1, 2 SHA-256, 3 SHA-512 */
  algorithm: 1 | 2 | 3
  digits: number
  period: number
}

/** A passkey: a WebAuthn resident credential, ES256. */
export interface PasskeyRecord {
  kind: 'passkey'
  rpId: string
  credentialId: Uint8Array
  userHandle: Uint8Array
  userName: string
  displayName: string
  /** the P-256 private scalar, 32 bytes */
  privateKey: Uint8Array
}

export type ImportRecord = LoginRecord | CodeRecord | PasskeyRecord

const KIND = { login: 1, code: 2, passkey: 3 } as const

/** Why maki won't take `source` as the name of what an import is from; null if it will. */
export function sourceProblem(source: string): string | null {
  const n = utf8Length(source)
  if (n === 0) return 'an import says what it’s from'
  if (n > MAX_SOURCE) return `the name of what it’s from is more than ${MAX_SOURCE} bytes`
  if (hasControl(source)) return 'the name of what it’s from has a control character'
  return null
}

/** A string field's problem, if it has one: too long for a `str8`, or with a control character. */
function textProblem(value: string, what: string, controls = true): string | null {
  if (utf8Length(value) > 255) return `${what} longer than 255 bytes`
  if (controls && hasControl(value)) return `${what} with a control character`
  return null
}

/**
 * Why maki won't take `record`, in maki's words ("a password with a control character"); null if
 * it will. The checks are PROTOCOL.md's, record by record.
 */
export function recordProblem(record: ImportRecord): string | null {
  switch (record.kind) {
    case 'login': {
      if (!validHost(record.site)) return 'a login whose site isn’t a host'
      const password = utf8Length(record.password)
      if (password === 0) return 'a login with no password'
      if (password > 255) return 'a password longer than 255 bytes'
      return (
        textProblem(record.password, 'a password') ??
        textProblem(record.username, 'a username') ??
        textProblem(record.title, 'a title')
      )
    }
    case 'code': {
      if (record.issuer === '' && record.account === '')
        return 'a code with neither an issuer nor an account'
      const problem =
        textProblem(record.issuer, 'an issuer') ?? textProblem(record.account, 'an account')
      if (problem) return problem
      if (record.secret.length < 10 || record.secret.length > 64)
        return 'a code whose secret isn’t 10 to 64 bytes'
      if (![1, 2, 3].includes(record.algorithm)) return 'a code of an algorithm maki doesn’t know'
      if (!Number.isInteger(record.digits) || record.digits < 6 || record.digits > 8)
        return 'a code of other than 6 to 8 digits'
      if (!Number.isInteger(record.period) || record.period < 15 || record.period > 300)
        return 'a code whose period isn’t 15 to 300 seconds'
      return null
    }
    case 'passkey': {
      if (!validHost(record.rpId)) return 'a passkey whose relying party isn’t a host'
      if (record.credentialId.length < 16 || record.credentialId.length > 255)
        return 'a passkey whose credential ID isn’t 16 to 255 bytes'
      if (record.userHandle.length < 1 || record.userHandle.length > 64)
        return 'a passkey whose user handle isn’t 1 to 64 bytes'
      if (record.privateKey.length !== 32) return 'a passkey whose key isn’t 32 bytes'
      return (
        textProblem(record.userName, 'a user name') ??
        textProblem(record.displayName, 'a display name')
      )
    }
  }
}

/** Little-endian integers, `str8` and `bytes16`, into a buffer that grows. */
class Bytes {
  private buf = new Uint8Array(1024)
  length = 0

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf.fill(0)
    this.buf = next
  }
  u8(v: number): this {
    this.room(1)
    this.buf[this.length++] = v
    return this
  }
  u16(v: number): this {
    this.room(2)
    this.buf[this.length++] = v & 0xff
    this.buf[this.length++] = (v >> 8) & 0xff
    return this
  }
  u32(v: number): this {
    this.room(4)
    for (let i = 0; i < 4; i++) this.buf[this.length++] = (v >>> (8 * i)) & 0xff
    return this
  }
  raw(b: Uint8Array): this {
    this.room(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
    return this
  }
  str8(s: string): this {
    const b = new TextEncoder().encode(s)
    if (b.length > 255) throw new Error('a string longer than 255 bytes')
    return this.u8(b.length).raw(b)
  }
  bytes16(b: Uint8Array): this {
    if (b.length > 0xffff) throw new Error('bytes longer than 65535')
    return this.u16(b.length).raw(b)
  }
  /** What's been written, copied out; this buffer is wiped. */
  finish(): Uint8Array {
    const out = this.buf.slice(0, this.length)
    this.buf.fill(0)
    return out
  }
}

/** One record's bytes, its kind first. */
function recordBytes(record: ImportRecord, w: Bytes): void {
  w.u8(KIND[record.kind])
  switch (record.kind) {
    case 'login':
      w.str8(record.site).str8(record.username).str8(record.password).str8(record.title)
      break
    case 'code':
      w.str8(record.issuer)
        .str8(record.account)
        .bytes16(record.secret)
        .u8(record.algorithm)
        .u8(record.digits)
        .u16(record.period)
      break
    case 'passkey':
      w.str8(record.rpId)
        .bytes16(record.credentialId)
        .bytes16(record.userHandle)
        .str8(record.userName)
        .str8(record.displayName)
        .bytes16(record.privateKey)
      break
  }
}

/** How many bytes a record takes in an import. */
export function recordSize(record: ImportRecord): number {
  const s = (v: string): number => 1 + utf8Length(v)
  switch (record.kind) {
    case 'login':
      return 1 + s(record.site) + s(record.username) + s(record.password) + s(record.title)
    case 'code':
      return 1 + s(record.issuer) + s(record.account) + 2 + record.secret.length + 4
    case 'passkey':
      return (
        1 +
        s(record.rpId) +
        2 +
        record.credentialId.length +
        2 +
        record.userHandle.length +
        s(record.userName) +
        s(record.displayName) +
        2 +
        record.privateKey.length
      )
  }
}

/** An import's bytes before its records: the magic, the source, the count. */
function headerSize(source: string): number {
  return IMPORT_MAGIC.length + 1 + utf8Length(source) + 4
}

/**
 * An import as maki reads it (the pieces joined): "MAKIIMP1", the source, the count, the records.
 * Throws, naming it, on a record maki won't take, or if it's more than maki takes at once.
 */
export function encodeImport(source: string, records: ImportRecord[]): Uint8Array {
  const problem = sourceProblem(source)
  if (problem) throw new Error(problem)
  if (records.length === 0) throw new Error('an import has at least one record')
  if (records.length > MAX_RECORDS) throw new Error(`an import has at most ${MAX_RECORDS} records`)
  const w = new Bytes()
  w.raw(new TextEncoder().encode(IMPORT_MAGIC)).str8(source).u32(records.length)
  records.forEach((record, i) => {
    const why = recordProblem(record)
    if (why) throw new Error(`record ${i + 1}: ${why}`)
    recordBytes(record, w)
  })
  if (w.length > MAX_IMPORT) {
    w.finish().fill(0)
    throw new Error(`an import is at most ${MAX_IMPORT / 1024} KiB`)
  }
  return w.finish()
}

/**
 * The records in imports maki takes at once (at most `MAX_IMPORT` bytes and `MAX_RECORDS`
 * records each), in order: one, unless there are thousands. Each is asked about on maki by itself.
 */
export function splitImport(source: string, records: ImportRecord[]): ImportRecord[][] {
  const parts: ImportRecord[][] = []
  let part: ImportRecord[] = []
  let size = headerSize(source)
  for (const record of records) {
    const n = recordSize(record)
    if (part.length > 0 && (size + n > MAX_IMPORT || part.length >= MAX_RECORDS)) {
      parts.push(part)
      part = []
      size = headerSize(source)
    }
    part.push(record)
    size += n
  }
  if (part.length > 0) parts.push(part)
  return parts
}

/** The name of what an import is from, read back from its bytes (for the log); null if it can't be. */
export function importSource(data: Uint8Array): string | null {
  if (data.length < IMPORT_MAGIC.length + 1) return null
  if (new TextDecoder().decode(data.subarray(0, IMPORT_MAGIC.length)) !== IMPORT_MAGIC) return null
  const n = data[IMPORT_MAGIC.length]
  const at = IMPORT_MAGIC.length + 1
  if (at + n > data.length) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(at, at + n))
  } catch {
    return null
  }
}

/** What maki said to an import. */
export interface ImportResult {
  /** 'approved', or why not: 'denied', 'timed out', 'locked', 'no phrase', 'refused' */
  approval: ApprovalValue
  /** what it added, when approved */
  logins: number
  codes: number
  passkeys: number
  /** how many records it already had, when approved */
  skipped: number
  /**
   * why it wouldn't take it, when refused; when approved, why it added less than it was given (its
   * database full), or empty: maki's own words
   */
  reason: string
}

/** What maki said to an import, for the owner: a sentence. */
export function importSays(r: ImportResult): string {
  switch (r.approval) {
    case 'approved': {
      const added = [
        r.logins > 0 ? plural(r.logins, 'login') : null,
        r.codes > 0 ? plural(r.codes, 'code') : null,
        r.passkeys > 0 ? plural(r.passkeys, 'passkey') : null
      ].filter((s): s is string => s !== null)
      // maki stopped part of the way (its database full): what it added, then why the rest wasn't
      const short = r.reason ? `, then stopped: ${r.reason}` : ''
      if (added.length === 0)
        return r.reason
          ? `maki added nothing: ${r.reason}.`
          : r.skipped > 0
            ? `maki already had ${r.skipped === 1 ? 'it' : `all ${r.skipped}`}: nothing changed.`
            : 'maki added nothing.'
      return `maki added ${list(added)}${r.skipped > 0 ? `, and left the ${r.skipped} it already had as ${r.skipped === 1 ? 'it was' : 'they were'}` : ''}${short}.`
    }
    case 'denied':
      return 'Nothing was imported: it was turned down on maki.'
    case 'timed out':
      return 'Nothing was imported: nobody answered maki’s question in time.'
    case 'locked':
      return 'Nothing was imported: maki is locked. Enter its PIN on maki, then send it again.'
    case 'no phrase':
      return 'Nothing was imported: maki has no recovery phrase yet. Set one up on maki first.'
    case 'refused':
      return `maki won’t take it: ${r.reason || 'it didn’t say why'}. Nothing was imported.`
    case 'unavailable':
      return 'Nothing was imported: maki’s vault is busy. Try again in a moment.'
    default:
      return `Nothing was imported: maki said “${r.approval}”.`
  }
}

/** "1 login", "3 logins". */
function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** "a", "a and b", "a, b and c". */
export function list(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
