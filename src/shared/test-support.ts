/**
 * Helpers for tests that drive the firmware's real protocol logic through the fake maki
 * (libs/maki-proto/examples/fake_maki.rs in the firmware repo). Node only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import type { Transport } from './client'

export const FAKE = process.env.MAKI_FAKE ?? resolve(__dirname, '../../../xous-core/target/debug/examples/fake_maki')
export const SECRET_B32 = 'JBSWY3DPEHPK3PXP' // "Hello!\xde\xad\xbe\xef", the usual RFC example

export class TcpTransport implements Transport {
  private constructor(private socket: Socket) {}
  static open(port: number): Promise<TcpTransport> {
    return new Promise((ok, fail) => {
      const s = connect(port, '127.0.0.1', () => ok(new TcpTransport(s)))
      s.once('error', fail)
    })
  }
  send(bytes: Uint8Array): Promise<void> {
    return new Promise((ok, fail) => this.socket.write(bytes, (e) => (e ? fail(e) : ok())))
  }
  onData(l: (b: Uint8Array) => void): void {
    this.socket.on('data', (d) => l(new Uint8Array(d)))
  }
  onClose(l: () => void): void {
    this.socket.on('close', l)
  }
  async close(): Promise<void> {
    this.socket.destroy()
  }
}

/** Start a fake maki on a free port; resolves to that port. */
export async function startFake(args: string[] = []): Promise<{ port: number; proc: ChildProcess }> {
  const proc = spawn(FAKE, ['127.0.0.1:0', ...args])
  const port = await new Promise<number>((ok, fail) => {
    proc.stdout!.on('data', (d: Buffer) => {
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(d.toString())
      if (m) ok(Number(m[1]))
    })
    proc.once('exit', () => fail(new Error('fake maki exited')))
  })
  return { port, proc }
}

/** RFC 6238, computed independently of maki. */
export function expectedTotp(secretB32: string, unixS: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secretB32) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(unixS / 30)))
  const h = createHmac('sha1', key).update(counter).digest()
  const o = h[19] & 0x0f
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

export const FAKE_BUILT = existsSync(FAKE)

