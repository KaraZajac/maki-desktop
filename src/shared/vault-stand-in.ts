/**
 * A stand-in for maki's side of VAULT_STATUS and IMPORT_PUT, for tests (no Node or DOM imports):
 * it reads an import as PROTOCOL.md says maki does, written from the specification alone (not
 * from `import.ts`'s encoder, so the one checks the other), checks every record, asks a pretend
 * owner, and adds what it hasn't. Enough of the rest of the link (HELLO, STATUS) for a `Link` to
 * attach to it.
 */
import type { Transport } from './client'
import { Deframer, encodeFrame, Kind, Writer } from './protocol'

/** What the pretend owner says to an import: 0 approved, 1 denied, 3 timed out. */
export type Answer = 0 | 1 | 3

/** An import as the stand-in read it. */
export interface ReadImport {
  source: string
  logins: { site: string; username: string; password: string; title: string }[]
  codes: {
    issuer: string
    account: string
    secret: Uint8Array
    algorithm: number
    digits: number
    period: number
  }[]
  passkeys: {
    rpId: string
    credentialId: Uint8Array
    userHandle: Uint8Array
    userName: string
    displayName: string
    privateKey: Uint8Array
  }[]
}

/** site.rs's `valid`. */
function validSite(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 253 &&
    /^[a-z0-9.-]+$/.test(s) &&
    !s.startsWith('.') &&
    !s.endsWith('.') &&
    !s.includes('..')
  )
}

const control = /[\u0000-\u001f\u007f-\u009f]/

/** Reads an import, the pieces joined, as the specification has it: the import, or why it's refused. */
export function readImport(data: Uint8Array): ReadImport | string {
  let at = 0
  const need = (n: number): number => {
    if (at + n > data.length) throw new Error('the import ends early')
    at += n
    return at - n
  }
  const u8 = (): number => data[need(1)]
  const u16 = (): number => {
    const i = need(2)
    return data[i] | (data[i + 1] << 8)
  }
  const u32 = (): number => {
    const i = need(4)
    return (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0
  }
  const str8 = (): string => {
    const n = u8()
    const i = need(n)
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(i, i + n))
  }
  const bytes16 = (): Uint8Array => {
    const n = u16()
    const i = need(n)
    return data.slice(i, i + n)
  }
  try {
    const magic = need(8)
    if (new TextDecoder().decode(data.subarray(magic, magic + 8)) !== 'MAKIIMP1')
      return 'not an import'
    const source = str8()
    if (source.length === 0 || new TextEncoder().encode(source).length > 32)
      return 'a source of 1 to 32 bytes'
    const count = u32()
    if (count === 0) return 'no records'
    const out: ReadImport = { source, logins: [], codes: [], passkeys: [] }
    for (let n = 1; n <= count; n++) {
      const kind = u8()
      if (kind === 1) {
        const site = str8()
        const username = str8()
        const password = str8()
        const title = str8()
        if (!validSite(site)) return `record ${n}: a site that isn't a host`
        if (password.length === 0) return `record ${n}: no password`
        if (control.test(password)) return `record ${n}: a password with a control character`
        if (control.test(username)) return `record ${n}: a username with a control character`
        if (control.test(title)) return `record ${n}: a title with a control character`
        out.logins.push({ site, username, password, title })
      } else if (kind === 2) {
        const issuer = str8()
        const account = str8()
        const secret = bytes16()
        const algorithm = u8()
        const digits = u8()
        const period = u16()
        if (issuer === '' && account === '') return `record ${n}: neither issuer nor account`
        if (secret.length < 10 || secret.length > 64)
          return `record ${n}: a secret of ${secret.length} bytes`
        if (algorithm < 1 || algorithm > 3) return `record ${n}: algorithm ${algorithm}`
        if (digits < 6 || digits > 8) return `record ${n}: ${digits} digits`
        if (period < 15 || period > 300) return `record ${n}: a period of ${period}`
        out.codes.push({ issuer, account, secret, algorithm, digits, period })
      } else if (kind === 3) {
        const rpId = str8()
        const credentialId = bytes16()
        const userHandle = bytes16()
        const userName = str8()
        const displayName = str8()
        const privateKey = bytes16()
        if (!validSite(rpId)) return `record ${n}: a relying party that isn't a host`
        if (credentialId.length < 16 || credentialId.length > 255)
          return `record ${n}: a credential ID of ${credentialId.length} bytes`
        if (userHandle.length < 1 || userHandle.length > 64)
          return `record ${n}: a user handle of ${userHandle.length} bytes`
        if (privateKey.length !== 32) return `record ${n}: a key of ${privateKey.length} bytes`
        out.passkeys.push({ rpId, credentialId, userHandle, userName, displayName, privateKey })
      } else return `record ${n}: kind ${kind}`
    }
    if (at !== data.length) return 'trailing bytes'
    return out
  } catch (e) {
    return (e as Error).message
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** maki's vault, as far as imports go, behind a `Transport`. */
export class VaultStandIn implements Transport {
  /** what it holds: logins by site and username, codes by secret, passkeys by credential ID */
  logins = new Map<string, string>()
  codes = new Set<string>()
  passkeys = new Set<string>()
  imported = 0
  /** 0 with the counts, 6 locked, 8 no phrase */
  status = 0
  /** what the pretend owner says */
  answer: Answer = 0
  /** firmware from before imports: both messages answered ERROR unknown kind */
  old = false
  /** the imports it was asked about, as it read them */
  asked: ReadImport[] = []
  private deframer = new Deframer()
  private listeners: ((b: Uint8Array) => void)[] = []
  private closers: (() => void)[] = []
  private incoming: { total: number; parts: Uint8Array[]; have: number } | null = null

  onData(l: (b: Uint8Array) => void): void {
    this.listeners.push(l)
  }
  onClose(l: () => void): void {
    this.closers.push(l)
  }
  async close(): Promise<void> {
    this.closers.forEach((l) => l())
  }

  async send(bytes: Uint8Array): Promise<void> {
    for (const p of this.deframer.push(bytes)) {
      if (p instanceof Error) continue
      const reply = (kind: number, body: Uint8Array): void => {
        const frame = encodeFrame(kind, p.id, body)
        setTimeout(() => this.listeners.forEach((l) => l(frame)), 1)
      }
      const error = (code: number, detail: string): void =>
        reply(Kind.ERROR, new Writer().u8(code).str8(detail).finish())
      switch (p.kind) {
        case Kind.HELLO:
          reply(Kind.HELLO | Kind.REPLY, new Writer().u8(3).str8('uni').str8('stand-in').finish())
          break
        case Kind.STATUS:
          reply(Kind.STATUS | Kind.REPLY, new Writer().u8(2).u64(Date.now()).i32(0).finish())
          break
        case Kind.VAULT_STATUS: {
          if (this.old) return error(2, 'unknown message kind')
          const counted = this.status === 0
          reply(
            Kind.VAULT_STATUS | Kind.REPLY,
            new Writer()
              .u8(this.status)
              .u32(counted ? this.logins.size : 0)
              .u32(counted ? this.codes.size : 0)
              .u32(counted ? this.passkeys.size : 0)
              .u32(counted ? this.imported : 0)
              .finish()
          )
          break
        }
        case Kind.IMPORT_PUT: {
          if (this.old) return error(2, 'unknown message kind')
          const body = p.body
          const total = (body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] << 24)) >>> 0
          const offset = (body[4] | (body[5] << 8) | (body[6] << 16) | (body[7] << 24)) >>> 0
          const n = body[8] | (body[9] << 8)
          const piece = body.slice(10, 10 + n)
          if (body.length !== 10 + n || n > 4096 || total > 512 * 1024)
            return error(5, 'bad argument')
          if (offset === 0) this.incoming = { total, parts: [], have: 0 }
          const into = this.incoming
          if (!into || into.total !== total || into.have !== offset) return error(5, 'out of order')
          into.parts.push(piece)
          into.have += piece.length
          const answer = (
            done: number,
            approval: number,
            counts = [0, 0, 0, 0],
            reason = ''
          ): void => {
            const w = new Writer().u8(done).u8(approval)
            counts.forEach((c) => w.u16(c))
            reply(Kind.IMPORT_PUT | Kind.REPLY, w.str8(reason).finish())
          }
          if (into.have < total) return answer(0, 0)
          this.incoming = null
          const whole = new Uint8Array(total)
          let at = 0
          for (const part of into.parts) (whole.set(part, at), (at += part.length))
          if (this.status !== 0) return answer(1, this.status)
          const read = readImport(whole)
          if (typeof read === 'string') return answer(1, 9, undefined, read)
          this.asked.push(read)
          if (this.answer !== 0) return answer(1, this.answer)
          let [logins, codes, passkeys, skipped] = [0, 0, 0, 0]
          for (const l of read.logins) {
            const key = `${l.site}\n${l.username}`
            if (this.logins.has(key)) skipped++
            else (this.logins.set(key, l.password), logins++)
          }
          for (const c of read.codes) {
            if (this.codes.has(hex(c.secret))) skipped++
            else (this.codes.add(hex(c.secret)), codes++)
          }
          for (const k of read.passkeys) {
            if (this.passkeys.has(hex(k.credentialId))) skipped++
            else (this.passkeys.add(hex(k.credentialId)), passkeys++, this.imported++)
          }
          answer(1, 0, [logins, codes, passkeys, skipped])
          break
        }
        default:
          error(2, 'unknown message kind')
      }
    }
  }
}
