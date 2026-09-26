/**
 * Talking to maki: one request at a time over any byte transport, and the time-sync dance.
 */

import {
  AnswerStatus,
  Deframer,
  encodeFrame,
  ErrorCode,
  FrameError,
  Kind,
  ProofStatus,
  Reader,
  TimeStateValue,
  Writer,
  type Packet
} from './protocol'

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
  private waiting: { resolve: (p: Packet) => void; reject: (e: Error) => void } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private transport: Transport) {
    transport.onData((bytes) => {
      for (const item of this.deframer.push(bytes)) {
        const waiter = this.waiting
        this.waiting = null
        if (!waiter) continue // nothing asked for this; the badge only ever replies
        if (item instanceof FrameError) waiter.reject(item)
        else waiter.resolve(item)
      }
    })
    transport.onClose(() => {
      this.waiting?.reject(new Error('maki disconnected'))
      this.waiting = null
    })
  }

  /** Send one request and wait for its reply; calls queue behind each other. */
  request(kind: number, body: Uint8Array = new Uint8Array(), timeoutMs = 5000): Promise<Packet> {
    const run = async (): Promise<Packet> => {
      const reply = new Promise<Packet>((resolve, reject) => {
        const waiter = {
          resolve: (p: Packet) => (clearTimeout(timer), resolve(p)),
          reject: (e: Error) => (clearTimeout(timer), reject(e))
        }
        const timer = setTimeout(() => {
          // a timer may only fail the request it was set for
          if (this.waiting === waiter) this.waiting = null
          reject(new Error(`no reply to 0x${kind.toString(16)} within ${timeoutMs} ms`))
        }, timeoutMs)
        this.waiting = waiter
      })
      await this.transport.send(encodeFrame(kind, body))
      const packet = await reply
      if (packet.kind === Kind.ERROR) {
        const r = new Reader(packet.body)
        throw new MakiError(r.u8(), r.str8())
      }
      if (packet.kind !== (kind | Kind.REPLY)) {
        throw new Error(`expected reply 0x${(kind | Kind.REPLY).toString(16)}, got 0x${packet.kind.toString(16)}`)
      }
      return packet
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
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

  async timeProof(tzOffsetS: number, answers: { id: number; response: Uint8Array }[]): Promise<ProofResult> {
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

  /** The host's own clock. Refused (false) once the badge holds a verified time. */
  async timeUnverified(utcMs: number, tzOffsetS: number): Promise<boolean> {
    const r = new Reader((await this.request(Kind.TIME_UNVERIFIED, new Writer().u64(utcMs).i32(tzOffsetS).finish())).body)
    const refused = r.u8()
    r.end()
    return refused === 0
  }
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
export async function syncTime(client: MakiClient, relay: Relay, tzOffsetS = localTzOffsetS()): Promise<SyncReport> {
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
