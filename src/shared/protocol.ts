/**
 * maki's serial protocol, host side. The badge side and the specification live in the firmware
 * repo: libs/maki-proto (PROTOCOL.md). Keep the two in step.
 *
 * No Node or DOM imports here: this module runs in the renderer, in the main process and in tests.
 */

export const PROTOCOL_VERSION = 3
export const MAX_FRAME = 8192

export const Kind = {
  HELLO: 0x01,
  STATUS: 0x02,
  TIME_CHALLENGE: 0x03,
  TIME_PROOF: 0x04,
  TIME_UNVERIFIED: 0x05,
  /** answered only after the owner approves on maki */
  GET_LOGIN: 0x10,
  GET_TOTP: 0x11,
  SAVE_LOGIN: 0x12,
  /** a piece of maki's backup, encrypted with a key from the recovery phrase */
  BACKUP_GET: 0x20,
  /** a piece of a backup to restore; the last is answered once the owner decides */
  BACKUP_PUT: 0x21,
  /** the apps installed on maki, one per request */
  APP_LIST: 0x50,
  /** a piece of a .maki bundle to install; the last is answered once the owner decides */
  APP_INSTALL: 0x51,
  /** an app to remove, answered once the owner decides */
  APP_REMOVE: 0x52,
  /** a message for an app with the link permission, answered with the app's answer */
  APP_MESSAGE: 0x53,
  /** a piece of a maki store record (a root, a revocation list), which maki checks and keeps */
  STORE_UPDATE: 0x54,
  /** how much of maki's room for apps is taken, and how many more apps it has room for */
  APP_SPACE: 0x55,
  REPLY: 0x80,
  ERROR: 0x7f
} as const

export const TimeState = { UNSET: 0, UNVERIFIED: 1, VERIFIED: 2 } as const
export type TimeStateValue = (typeof TimeState)[keyof typeof TimeState]

export const ProofStatus = { SET: 0, TOO_FEW_VERIFIED: 1, DISAGREE: 2 } as const
export const AnswerStatus = ['verified', 'unknown server', 'duplicate', 'invalid', 'too imprecise'] as const
export const ErrorCode = ['', 'malformed', 'unknown kind', 'no challenge', 'challenge expired', 'bad argument'] as const
export const Approval = [
  'approved',
  'denied',
  'no match',
  'timed out',
  'unavailable',
  'clock not verified',
  'locked',
  'not yours',
  'no phrase',
  'refused'
] as const
/** Pieces of a backup are at most this big. */
export const BACKUP_PIECE = 4096
/** Pieces of a .maki bundle. */
export const APP_PIECE = 4096
/** The biggest bundle maki takes. */
export const MAX_APP = 512 * 1024
/** The biggest message to or from an app. */
export const MAX_APP_MESSAGE = 4096
/** Pieces of a maki store record. */
export const STORE_PIECE = 4096
/** The biggest store record maki takes. */
export const MAX_STORE_RECORD = 64 * 1024
/** Bitcoin itself, or the test networks (testnet and signet share keys and addresses), for the Bitcoin app (wallet-apps.ts). */
export const Network = { BITCOIN: 0, TESTNET: 1 } as const
export type NetworkValue = (typeof Network)[keyof typeof Network]
/** The Bitcoin app's accounts: native SegWit (BIP84) and taproot (BIP86). */
export const BtcAccount = { SEGWIT: 0, TAPROOT: 1 } as const
export type BtcAccountValue = (typeof BtcAccount)[keyof typeof BtcAccount]
export type ApprovalValue = (typeof Approval)[number]

export interface Packet {
  kind: number
  /** chosen by the host, echoed in the reply */
  id: number
  body: Uint8Array
}

/** CRC-32/ISO-HDLC, zlib's. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function cobsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [0]
  let codeAt = 0
  let code = 1
  for (const b of data) {
    if (b === 0) {
      out[codeAt] = code
      codeAt = out.length
      out.push(0)
      code = 1
    } else {
      out.push(b)
      code++
      if (code === 0xff) {
        out[codeAt] = code
        codeAt = out.length
        out.push(0)
        code = 1
      }
    }
  }
  out[codeAt] = code
  return Uint8Array.from(out)
}

export function cobsDecode(data: Uint8Array): Uint8Array | null {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const code = data[i]
    if (code === 0) return null
    const end = i + code
    if (end > data.length) return null
    for (let j = i + 1; j < end; j++) {
      if (data[j] === 0) return null
      out.push(data[j])
    }
    i = end
    if (code < 0xff && i < data.length) out.push(0)
  }
  return Uint8Array.from(out)
}

/** One packet on the wire, delimiter included. */
export function encodeFrame(kind: number, id: number, body: Uint8Array): Uint8Array {
  const raw = new Uint8Array(body.length + 8)
  raw[0] = PROTOCOL_VERSION
  raw[1] = kind
  raw[2] = id & 0xff
  raw[3] = (id >> 8) & 0xff
  raw.set(body, 4)
  new DataView(raw.buffer).setUint32(raw.length - 4, crc32(raw.subarray(0, raw.length - 4)), true)
  const encoded = cobsEncode(raw)
  const out = new Uint8Array(encoded.length + 1)
  out.set(encoded)
  return out
}

export class FrameError extends Error {}

/** One frame, without its delimiter. */
export function decodeFrame(frame: Uint8Array): Packet {
  const raw = cobsDecode(frame)
  if (!raw) throw new FrameError('bad COBS encoding')
  if (raw.length < 8) throw new FrameError('frame too short')
  if (raw.length > MAX_FRAME) throw new FrameError('frame too long')
  const data = raw.subarray(0, raw.length - 4)
  if (new DataView(raw.buffer, raw.byteOffset).getUint32(raw.length - 4, true) !== crc32(data)) {
    throw new FrameError('CRC mismatch')
  }
  if (data[0] !== PROTOCOL_VERSION) throw new FrameError(`protocol version ${data[0]}`)
  return { kind: data[1], id: data[2] | (data[3] << 8), body: data.slice(4) }
}

/** Splits a byte stream into packets at zero delimiters, however the bytes arrive. */
export class Deframer {
  private buf: number[] = []
  private overflow = false

  push(bytes: Uint8Array): (Packet | FrameError)[] {
    const out: (Packet | FrameError)[] = []
    for (const b of bytes) {
      if (b === 0) {
        if (this.overflow) out.push(new FrameError('frame too long'))
        else if (this.buf.length > 0) {
          try {
            out.push(decodeFrame(Uint8Array.from(this.buf)))
          } catch (e) {
            out.push(e instanceof FrameError ? e : new FrameError(String(e)))
          }
        }
        this.buf = []
        this.overflow = false
      } else if (this.buf.length < MAX_FRAME + MAX_FRAME / 254 + 8) {
        this.buf.push(b)
      } else {
        this.overflow = true
      }
    }
    return out
  }
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Little-endian integers, `str8` (u8 length + UTF-8) and `bytes16` (u16 length + bytes). */
export class Writer {
  private parts: number[] = []

  private raw(n: number, write: (view: DataView) => void): this {
    const b = new Uint8Array(n)
    write(new DataView(b.buffer))
    this.parts.push(...b)
    return this
  }

  u8(v: number): this {
    return this.raw(1, (d) => d.setUint8(0, v))
  }
  u16(v: number): this {
    return this.raw(2, (d) => d.setUint16(0, v, true))
  }
  u32(v: number): this {
    return this.raw(4, (d) => d.setUint32(0, v, true))
  }
  i32(v: number): this {
    return this.raw(4, (d) => d.setInt32(0, v, true))
  }
  u64(v: number): this {
    return this.raw(8, (d) => d.setBigUint64(0, BigInt(v), true))
  }
  str8(s: string): this {
    const b = utf8.encode(s).subarray(0, 255)
    this.parts.push(b.length, ...b)
    return this
  }
  bytes16(b: Uint8Array): this {
    this.u16(b.length)
    this.parts.push(...b)
    return this
  }
  /** bytes as they are, with no length */
  bytes(b: Uint8Array): this {
    this.parts.push(...b)
    return this
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

export class Truncated extends Error {}

export class Reader {
  private pos = 0
  private view: DataView

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  private need(n: number): number {
    if (this.pos + n > this.data.length) throw new Truncated('message ends early')
    const at = this.pos
    this.pos += n
    return at
  }

  /** How far it has read. */
  get offset(): number {
    return this.pos
  }
  /** `n` bytes as they are. */
  fixed(n: number): Uint8Array {
    const at = this.need(n)
    return this.data.slice(at, at + n)
  }

  u8(): number {
    return this.view.getUint8(this.need(1))
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true)
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true)
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true)
  }
  u64(): number {
    return Number(this.view.getBigUint64(this.need(8), true))
  }
  str8(): string {
    const n = this.u8()
    const at = this.need(n)
    return fromUtf8.decode(this.data.subarray(at, at + n))
  }
  bytes16(): Uint8Array {
    const n = this.u16()
    const at = this.need(n)
    return this.data.slice(at, at + n)
  }
  end(): void {
    if (this.pos !== this.data.length) throw new Truncated('trailing bytes')
  }
}
