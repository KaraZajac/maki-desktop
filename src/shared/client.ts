/**
 * Talking to maki: one request at a time over any byte transport, and the time-sync dance.
 */

import {
  Approval,
  type ApprovalValue,
  AnswerStatus,
  APP_PIECE,
  Deframer,
  encodeFrame,
  ErrorCode,
  FrameError,
  Kind,
  ProofStatus,
  Reader,
  TimeStateValue,
  BACKUP_PIECE,
  MAX_APP_MESSAGE,
  MAX_STORE_RECORD,
  STORE_PIECE,
  Writer,
  type Packet
} from './protocol'
import { IMPORT_PIECE, MAX_IMPORT, type ImportResult } from './import'

/** A duplex byte pipe: Web Serial in the app, TCP to the fake maki in development and tests. */
export interface Transport {
  send(bytes: Uint8Array): Promise<void>
  onData(listener: (bytes: Uint8Array) => void): void
  onClose(listener: () => void): void
  close(): Promise<void>
}

/** Relay one Roughtime request to a server and return its answer. */
export type Relay = (host: string, port: number, packet: Uint8Array) => Promise<Uint8Array>

export class MakiError extends Error {
  constructor(
    readonly code: number,
    detail: string
  ) {
    super(`${ErrorCode[code] ?? `error ${code}`}: ${detail}`)
  }
}

export interface Hello {
  protocol: number
  name: string
  version: string
}

export interface Status {
  timeState: TimeStateValue
  /** 0 when the badge's clock is unset */
  utcMs: number
  tzOffsetS: number
}

/**
 * Which wallet maki's wallet apps have (WALLET_STATUS): none while maki is locked or has no
 * recovery phrase yet; the phrase's own ('standard'); or a passphrase wallet, one its owner opened
 * on maki with a BIP39 passphrase typed there (the passphrase never crosses the link). With a
 * wallet, its master key's fingerprint as wallets write it: eight lowercase hex digits, `73c5da0a`.
 */
export type WalletStatus =
  { kind: 'none'; fingerprint: null } | { kind: 'standard' | 'passphrase'; fingerprint: string }

/**
 * What maki's vault holds (VAULT_STATUS): its logins, codes (TOTP) and passkeys (resident FIDO
 * credentials), and of the passkeys, how many were imported (given to maki, not made on it).
 * 'approved' with the counts; 'locked' or 'no phrase' with none.
 */
export interface VaultStatus {
  status: ApprovalValue
  logins: number
  codes: number
  passkeys: number
  imported: number
}

export interface Challenge {
  id: number
  host: string
  port: number
  request: Uint8Array
}

export interface ProofResult {
  status: number
  verified: number
  utcMs: number
  answers: { id: number; status: (typeof AnswerStatus)[number] }[]
}

export class MakiClient {
  private deframer = new Deframer()
  private waiting = new Map<number, { resolve: (p: Packet) => void; reject: (e: Error) => void }>()
  private nextId = 1

  /**
   * `slow`: how many times longer than a badge's to wait for each answer, for a maki that's
   * slower (one in an emulator, which runs a tenth as fast when it's busy).
   */
  constructor(
    private transport: Transport,
    private slow = 1
  ) {
    transport.onData((bytes) => {
      for (const item of this.deframer.push(bytes)) {
        if (item instanceof FrameError) continue // unattributable; its request will time out
        const waiter = this.waiting.get(item.id)
        if (!waiter) continue // a reply to a request we gave up on
        this.waiting.delete(item.id)
        waiter.resolve(item)
      }
    })
    transport.onClose(() => {
      for (const w of this.waiting.values()) w.reject(new Error('maki disconnected'))
      this.waiting.clear()
    })
  }

  /** Send one request and wait for its reply. Requests may overlap; replies find them by id. */
  async request(
    kind: number,
    body: Uint8Array = new Uint8Array(),
    timeoutMs = 5000
  ): Promise<Packet> {
    const id = this.nextId
    this.nextId = this.nextId === 0xffff ? 1 : this.nextId + 1
    timeoutMs *= this.slow
    const reply = new Promise<Packet>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`no reply to 0x${kind.toString(16)} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiting.set(id, {
        resolve: (p) => (clearTimeout(timer), resolve(p)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
    })
    try {
      await this.transport.send(encodeFrame(kind, id, body))
    } catch (e) {
      // nothing went out, so no reply comes: stop waiting for one, quietly (it would have been
      // rejected later, with nobody listening)
      this.waiting.get(id)?.reject(e as Error)
      this.waiting.delete(id)
      reply.catch(() => {})
      throw e
    }
    const packet = await reply
    if (packet.kind === Kind.ERROR) {
      const r = new Reader(packet.body)
      throw new MakiError(r.u8(), r.str8())
    }
    if (packet.kind !== (kind | Kind.REPLY)) {
      throw new Error(
        `expected reply 0x${(kind | Kind.REPLY).toString(16)}, got 0x${packet.kind.toString(16)}`
      )
    }
    return packet
  }

  close(): Promise<void> {
    return this.transport.close()
  }

  /** `timeoutMs` short when probing a device that may not be maki at all. */
  async hello(timeoutMs = 5000): Promise<Hello> {
    const r = new Reader((await this.request(Kind.HELLO, new Uint8Array(), timeoutMs)).body)
    const hello = { protocol: r.u8(), name: r.str8(), version: r.str8() }
    r.end()
    return hello
  }

  async status(): Promise<Status> {
    const r = new Reader((await this.request(Kind.STATUS)).body)
    const status = { timeState: r.u8() as TimeStateValue, utcMs: r.u64(), tzOffsetS: r.i32() }
    r.end()
    return status
  }

  /**
   * Which wallet maki's wallet apps have; null from firmware that doesn't know the question (from
   * before passphrase wallets: its wallet apps have only the phrase's own wallet, and it doesn't
   * say which). An answer that isn't exactly as PROTOCOL.md has it is refused: a kind it doesn't
   * name, a fingerprint with no wallet, a byte too many or too few.
   */
  async walletStatus(): Promise<WalletStatus | null> {
    let body: Uint8Array
    try {
      body = (await this.request(Kind.WALLET_STATUS)).body
    } catch (e) {
      if (e instanceof MakiError && ErrorCode[e.code] === 'unknown kind') return null
      throw e
    }
    const r = new Reader(body)
    const kind = r.u8()
    const fingerprint = r.u32()
    r.end()
    if (kind === 0) {
      if (fingerprint !== 0)
        throw new Error('maki said its wallet apps have no wallet, and gave a fingerprint')
      return { kind: 'none', fingerprint: null }
    }
    if (kind !== 1 && kind !== 2)
      throw new Error(
        `maki said its wallet apps have a kind of wallet maki desktop doesn’t know (${kind})`
      )
    return {
      kind: kind === 1 ? 'standard' : 'passphrase',
      fingerprint: fingerprint.toString(16).padStart(8, '0')
    }
  }

  async timeChallenge(): Promise<Challenge[]> {
    const r = new Reader((await this.request(Kind.TIME_CHALLENGE)).body)
    const count = r.u8()
    const challenges: Challenge[] = []
    for (let i = 0; i < count; i++) {
      challenges.push({ id: r.u8(), host: r.str8(), port: r.u16(), request: r.bytes16() })
    }
    r.end()
    return challenges
  }

  async timeProof(
    tzOffsetS: number,
    answers: { id: number; response: Uint8Array }[]
  ): Promise<ProofResult> {
    const w = new Writer().i32(tzOffsetS).u8(answers.length)
    for (const a of answers) w.u8(a.id).bytes16(a.response)
    // verifying three Ed25519 chains takes the badge a moment
    const r = new Reader((await this.request(Kind.TIME_PROOF, w.finish(), 15_000)).body)
    const result: ProofResult = { status: r.u8(), verified: r.u8(), utcMs: r.u64(), answers: [] }
    const count = r.u8()
    for (let i = 0; i < count; i++) {
      result.answers.push({ id: r.u8(), status: AnswerStatus[r.u8()] ?? 'invalid' })
    }
    r.end()
    return result
  }

  /** How long a request waits for the owner to press a button on maki. */
  static readonly APPROVAL_TIMEOUT_MS = 90_000
  /** How long an install waits: maki gives the owner five minutes to go through an app. */
  static readonly INSTALL_TIMEOUT_MS = 330_000
  /**
   * How long an import's last piece waits: maki checks every record, asks its owner (a minute,
   * with a second page when there are passkeys), then writes each new record into its encrypted
   * database, which for a big import takes the badge a while more.
   */
  static readonly IMPORT_TIMEOUT_MS = 300_000

  /**
   * Ask maki for the login saved for `site`; the owner approves on maki's screen. A site maki
   * holds a passkey for is answered 'passkey', unless `evenWithPasskey`. Only maki answers that,
   * so the flag goes only to a maki that takes it.
   */
  async getLogin(
    site: string,
    evenWithPasskey = false
  ): Promise<{ approval: ApprovalValue; username: string; password: string }> {
    const body = new Writer().str8(site)
    if (evenWithPasskey) body.u8(1)
    const r = new Reader(
      (await this.request(Kind.GET_LOGIN, body.finish(), MakiClient.APPROVAL_TIMEOUT_MS)).body
    )
    const out = {
      approval: Approval[r.u8()] ?? 'unavailable',
      username: r.str8(),
      password: r.str8()
    }
    r.end()
    return out
  }

  /**
   * Ask maki to restart into its boot stage's update mode, where new firmware goes on its USB
   * drive, for `label` (the release, which maki shows its owner): 'approved' once they've said
   * yes on maki, which then restarts.
   */
  async updateMode(label: string): Promise<ApprovalValue> {
    const r = new Reader(
      (
        await this.request(
          Kind.UPDATE_MODE,
          new Writer().str8(label).finish(),
          MakiClient.APPROVAL_TIMEOUT_MS
        )
      ).body
    )
    const approval = Approval[r.u8()] ?? 'unavailable'
    r.end()
    return approval
  }

  /** Ask maki for the current code for `site`. */
  async getTotp(
    site: string
  ): Promise<{ approval: ApprovalValue; code: string; validForS: number }> {
    const r = new Reader(
      (
        await this.request(
          Kind.GET_TOTP,
          new Writer().str8(site).finish(),
          MakiClient.APPROVAL_TIMEOUT_MS
        )
      ).body
    )
    const out = { approval: Approval[r.u8()] ?? 'unavailable', code: r.str8(), validForS: r.u8() }
    r.end()
    return out
  }

  /** Offer maki a login to keep; the owner approves on maki's screen. */
  async saveLogin(site: string, username: string, password: string): Promise<ApprovalValue> {
    const body = new Writer().str8(site).str8(username).str8(password).finish()
    const r = new Reader(
      (await this.request(Kind.SAVE_LOGIN, body, MakiClient.APPROVAL_TIMEOUT_MS)).body
    )
    const approval = Approval[r.u8()] ?? 'unavailable'
    r.end()
    return approval
  }

  /**
   * maki's backup, piece by piece: its logins and codes, encrypted with a key only its recovery
   * phrase gives. Anything but 'approved' (locked, no phrase yet) comes back with no data.
   */
  async backup(): Promise<{ status: ApprovalValue; data: Uint8Array }> {
    const parts: Uint8Array[] = []
    let offset = 0
    let total = 0
    do {
      // the first piece seals a fresh backup, which takes maki a moment
      const r = new Reader(
        (await this.request(Kind.BACKUP_GET, new Writer().u32(offset).finish(), 20_000)).body
      )
      const status = Approval[r.u8()] ?? 'unavailable'
      total = r.u32()
      const at = r.u32()
      const piece = r.bytes16()
      r.end()
      if (status !== 'approved') return { status, data: new Uint8Array() }
      if (at !== offset || (piece.length === 0 && offset < total))
        return { status: 'unavailable', data: new Uint8Array() }
      parts.push(piece)
      offset += piece.length
    } while (offset < total)
    const data = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      data.set(p, at)
      at += p.length
    }
    return { status: 'approved', data }
  }

  /** Send a backup back to maki; the owner approves the restore on maki's screen. Passkeys are
   * matched by credential ID; maki keeps what it has. */
  async restore(
    blob: Uint8Array
  ): Promise<{ approval: ApprovalValue; logins: number; codes: number; passkeys: number }> {
    for (let offset = 0; offset < blob.length || offset === 0;) {
      const piece = blob.subarray(offset, offset + BACKUP_PIECE)
      const last = offset + piece.length >= blob.length
      const body = new Writer().u32(blob.length).u32(offset).bytes16(piece).finish()
      const r = new Reader(
        (await this.request(Kind.BACKUP_PUT, body, last ? MakiClient.APPROVAL_TIMEOUT_MS : 10_000))
          .body
      )
      const done = r.u8() === 1
      const approval = Approval[r.u8()] ?? 'unavailable'
      const logins = r.u16()
      const codes = r.u16()
      const passkeys = r.u16()
      r.end()
      if (done) return { approval, logins, codes, passkeys }
      offset += piece.length
      if (blob.length === 0) break
    }
    return { approval: 'unavailable', logins: 0, codes: 0, passkeys: 0 }
  }

  /**
   * What maki's vault holds; null from firmware from before imports, which doesn't know the
   * question (the host says nothing of the counts then). Nothing is asked of the owner.
   */
  async vaultStatus(): Promise<VaultStatus | null> {
    let body: Uint8Array
    try {
      body = (await this.request(Kind.VAULT_STATUS)).body
    } catch (e) {
      if (e instanceof MakiError && ErrorCode[e.code] === 'unknown kind') return null
      throw e
    }
    const r = new Reader(body)
    const status = Approval[r.u8()] ?? 'unavailable'
    const counts = { logins: r.u32(), codes: r.u32(), passkeys: r.u32(), imported: r.u32() }
    r.end()
    return status === 'approved'
      ? { status, ...counts }
      : { status, logins: 0, codes: 0, passkeys: 0, imported: 0 }
  }

  /**
   * An import from another password manager (`import.ts`'s bytes), sent in pieces; maki reads the
   * whole, checks every record and asks its owner once. `progress` hears how many bytes have gone
   * as each piece goes: all of them means maki has the import and is asking. Its answer: what it
   * added and what it already had, or why nothing was ('refused' with maki's reason). Firmware
   * from before imports refuses the first piece (a MakiError, 'unknown kind').
   */
  async importPut(
    data: Uint8Array,
    progress?: (sent: number, total: number) => void
  ): Promise<ImportResult> {
    if (data.length === 0 || data.length > MAX_IMPORT)
      throw new Error(`an import is 1 byte to ${MAX_IMPORT / 1024} KiB`)
    for (let offset = 0; offset < data.length;) {
      const piece = data.subarray(offset, offset + IMPORT_PIECE)
      const last = offset + piece.length >= data.length
      const body = new Writer().u32(data.length).u32(offset).bytes16(piece).finish()
      progress?.(offset + piece.length, data.length)
      const r = new Reader(
        (await this.request(Kind.IMPORT_PUT, body, last ? MakiClient.IMPORT_TIMEOUT_MS : 10_000))
          .body
      )
      body.fill(0)
      const done = r.u8() === 1
      const approval = Approval[r.u8()] ?? 'unavailable'
      const result = {
        approval,
        logins: r.u16(),
        codes: r.u16(),
        passkeys: r.u16(),
        skipped: r.u16(),
        reason: r.str8()
      }
      r.end()
      if (done) return result
      offset += piece.length
    }
    // every piece taken, and maki never said it was done
    return { approval: 'unavailable', logins: 0, codes: 0, passkeys: 0, skipped: 0, reason: '' }
  }

  /** The apps installed on maki, in order of ID; 'locked' (and none) until its PIN is in. */
  async appList(): Promise<{ status: ApprovalValue; apps: InstalledApp[] }> {
    const apps: InstalledApp[] = []
    for (let index = 0; ; index++) {
      const r = new Reader(
        (await this.request(Kind.APP_LIST, new Writer().u32(index).finish())).body
      )
      const status = Approval[r.u8()] ?? 'unavailable'
      const count = r.u32()
      const present = r.u8() === 1
      if (status !== 'approved' || !present) {
        r.end()
        return { status, apps: status === 'approved' ? apps : [] }
      }
      const app: InstalledApp = {
        id: r.str8(),
        name: r.str8(),
        version: r.u32(),
        label: r.str8(),
        developer: r.bytes16(),
        fromStore: r.u8() === 1,
        backup: r.u8() === 1,
        used: r.u32(),
        icon: iconWords(r.bytes16()),
        bundle: r.u32(),
        storage: r.u32()
      }
      r.end()
      apps.push(app)
      if (index + 1 >= count) return { status, apps }
    }
  }

  /**
   * maki's room for apps, and what the ones installed take of it: their bundles, and the storage
   * each asks for. 'locked' (and nothing) until its PIN is in.
   */
  async appSpace(): Promise<{ status: ApprovalValue; space: AppSpace | null }> {
    const r = new Reader((await this.request(Kind.APP_SPACE)).body)
    const status = Approval[r.u8()] ?? 'unavailable'
    const space: AppSpace = { apps: r.u32(), maxApps: r.u32(), space: r.u32(), taken: r.u32() }
    r.end()
    return { status, space: status === 'approved' ? space : null }
  }

  /**
   * Install a .maki bundle: maki checks it, shows the owner what it is and what it may do, and
   * installs it if they say so. Refused ones come back with maki's reason.
   */
  async appInstall(bundle: Uint8Array): Promise<{ approval: ApprovalValue; reason: string }> {
    for (let offset = 0; offset < bundle.length;) {
      const piece = bundle.subarray(offset, offset + APP_PIECE)
      const last = offset + piece.length >= bundle.length
      const body = new Writer().u32(bundle.length).u32(offset).bytes16(piece).finish()
      const r = new Reader(
        (await this.request(Kind.APP_INSTALL, body, last ? MakiClient.INSTALL_TIMEOUT_MS : 10_000))
          .body
      )
      const done = r.u8() === 1
      const approval = Approval[r.u8()] ?? 'unavailable'
      const reason = r.str8()
      r.end()
      if (done) return { approval, reason }
      offset += piece.length
    }
    return { approval: 'unavailable', reason: '' }
  }

  /** Remove an app and its data, once the owner says so on maki ('no match' if there's no such app). */
  async appRemove(id: string): Promise<ApprovalValue> {
    const r = new Reader(
      (
        await this.request(
          Kind.APP_REMOVE,
          new Writer().str8(id).finish(),
          MakiClient.APPROVAL_TIMEOUT_MS
        )
      ).body
    )
    const approval = Approval[r.u8()] ?? 'unavailable'
    r.end()
    return approval
  }

  /**
   * A message for the app with this ID (it needs the link permission), and its answer: 'approved'
   * with the app's answer, or why there's none ('denied': the app didn't answer; 'no match': no
   * such app; 'unavailable': another app is open on maki; 'refused': no link permission). The app
   * may ask the owner first, so this can take as long as they do: `timeoutMs` for one that shows
   * them a transaction (the wallets, in wallet-apps.ts).
   */
  async appMessage(
    id: string,
    message: Uint8Array,
    timeoutMs = MakiClient.APPROVAL_TIMEOUT_MS
  ): Promise<{ status: ApprovalValue; answer: Uint8Array }> {
    if (message.length > MAX_APP_MESSAGE)
      throw new Error(`messages to apps are at most ${MAX_APP_MESSAGE} bytes`)
    const body = new Writer().str8(id).bytes16(message).finish()
    const r = new Reader((await this.request(Kind.APP_MESSAGE, body, timeoutMs)).body)
    const status = Approval[r.u8()] ?? 'unavailable'
    const answer = r.bytes16()
    r.end()
    return { status, answer }
  }

  /**
   * Hands maki a maki store record (a newer root, a revocation list), which it checks against
   * the root it trusts and keeps without asking anyone; or, with nothing, asks what it has.
   * 'approved': taken (or nothing sent); 'refused' with maki's reason; 'locked'; 'unavailable'.
   */
  async storeUpdate(record: Uint8Array = new Uint8Array()): Promise<StoreUpdate> {
    if (record.length > MAX_STORE_RECORD)
      throw new Error(`store records are at most ${MAX_STORE_RECORD / 1024} KiB`)
    for (let offset = 0; ;) {
      const piece = record.subarray(offset, offset + STORE_PIECE)
      const body = new Writer().u32(record.length).u32(offset).bytes16(piece).finish()
      const r = new Reader((await this.request(Kind.STORE_UPDATE, body, 10_000)).body)
      const done = r.u8() === 1
      const status = Approval[r.u8()] ?? 'unavailable'
      const state = { root: r.u32(), revocations: r.u32(), revocationsExpires: r.u64() }
      const reason = r.str8()
      r.end()
      if (done || record.length === 0) return { status, reason, state }
      offset += piece.length
      if (offset >= record.length) return { status: 'unavailable', reason: '', state }
    }
  }

  /** The host's own clock. Refused (false) once the badge holds a verified time. */
  async timeUnverified(utcMs: number, tzOffsetS: number): Promise<boolean> {
    const r = new Reader(
      (await this.request(Kind.TIME_UNVERIFIED, new Writer().u64(utcMs).i32(tzOffsetS).finish()))
        .body
    )
    const refused = r.u8()
    r.end()
    return refused === 0
  }
}

/** An app installed on maki. */
export interface InstalledApp {
  id: string
  name: string
  version: number
  label: string
  /** the developer's Ed25519 public key */
  developer: Uint8Array
  /** reviewed and stamped by the maki store; otherwise sideloaded */
  fromStore: boolean
  /** whether its data goes in maki's backup: the owner's choice */
  backup: boolean
  /** bytes of storage it uses */
  used: number
  /** 64x64 in maki_icons form, or null */
  icon: Uint32Array | null
  /** bytes its bundle takes on maki */
  bundle: number
  /** bytes of storage its manifest asks for, which maki keeps for it whether it's used or not */
  storage: number
}

/**
 * maki's room for apps: at most `maxApps` of them, their bundles and the storage each asks for
 * within `space` bytes of its encrypted database, which they share with its logins, codes and
 * passkeys. `taken` is what the `apps` installed take.
 */
export interface AppSpace {
  apps: number
  maxApps: number
  space: number
  taken: number
}

/** What maki said to a store record, and what it has of the store now. */
export interface StoreUpdate {
  status: ApprovalValue
  /** why maki refused it, in its own words */
  reason: string
  /** the version of the root maki trusts, and of its revocation list and when that goes stale
   * (unix seconds; 0 for none), unless it's locked */
  state: { root: number; revocations: number; revocationsExpires: number }
}

function iconWords(raw: Uint8Array): Uint32Array | null {
  if (raw.length !== 512) return null
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  return Uint32Array.from({ length: 128 }, (_, i) => view.getUint32(i * 4, true))
}

/** Seconds east of UTC, as the badge wants it. */
export function localTzOffsetS(date = new Date()): number {
  return -date.getTimezoneOffset() * 60
}

export interface SyncReport {
  /** true when the badge verified the time itself */
  verified: boolean
  /** true when the badge's clock changed, verified or not */
  set: boolean
  utcMs: number
  servers: { host: string; result: string }[]
}

/**
 * Set the badge's clock: signed Roughtime answers if enough servers reply, otherwise this
 * computer's clock, which the badge marks as unverified (and refuses over a verified one).
 */
export async function syncTime(
  client: MakiClient,
  relay: Relay,
  tzOffsetS = localTzOffsetS()
): Promise<SyncReport> {
  const challenges = await client.timeChallenge()
  const settled = await Promise.allSettled(challenges.map((c) => relay(c.host, c.port, c.request)))
  const answers = challenges.flatMap((c, i) => {
    const s = settled[i]
    return s.status === 'fulfilled' ? [{ id: c.id, response: s.value }] : []
  })
  const servers = challenges.map((c, i) => ({
    host: c.host,
    result: settled[i].status === 'fulfilled' ? '' : 'unreachable'
  }))

  if (answers.length > 0) {
    const proof = await client.timeProof(tzOffsetS, answers)
    for (const a of proof.answers) {
      const s = servers[challenges.findIndex((c) => c.id === a.id)]
      if (s) s.result = a.status
    }
    if (proof.status === ProofStatus.SET) {
      return { verified: true, set: true, utcMs: proof.utcMs, servers }
    }
  }
  const now = Date.now()
  const accepted = await client.timeUnverified(now, tzOffsetS)
  return { verified: false, set: accepted, utcMs: now, servers }
}
