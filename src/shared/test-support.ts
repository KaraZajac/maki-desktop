/**
 * Helpers for tests that drive the firmware's real protocol logic through the fake maki
 * (libs/maki-proto/examples/fake_maki.rs in the firmware repo). Node only.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import type { Transport } from './client'

export const FAKE =
  process.env.MAKI_FAKE ?? resolve(__dirname, '../../../xous-core/target/debug/examples/fake_maki')
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

/** The name the tests' fake maki goes by (a badge picks a maki roll of its own). */
export const FAKE_NAME = 'uni'

/** Start a fake maki on a free port; resolves to that port. */
export async function startFake(
  args: string[] = []
): Promise<{ port: number; proc: ChildProcess }> {
  const proc = spawn(FAKE, ['127.0.0.1:0', '--name', FAKE_NAME, ...args])
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

/** The SDK's example apps, packed: libs/maki-wasm/tests/fixtures in the firmware repo. */
export const APP_FIXTURES = resolve(__dirname, '../../../xous-core/libs/maki-wasm/tests/fixtures')
export const APP_FIXTURES_THERE = existsSync(APP_FIXTURES)

/** The development maki store: libs/maki-store/dev-store in the firmware repo. */
export const DEV_STORE = resolve(__dirname, '../../../xous-core/libs/maki-store/dev-store')
export const DEV_STORE_THERE = existsSync(DEV_STORE)

/** The maki store as its repository publishes it (KaraZajac/maki-apps), cloned beside this one. */
export const MAKI_STORE = resolve(__dirname, '../../../apps/store')
export const MAKI_STORE_THERE = existsSync(MAKI_STORE)

/**
 * Macro Pad 1.0, which the maki store has, written into `dir` from the firmware's history (its
 * fixture when it came out, unstamped: the fake maki installs it as sideloaded): its path, or null
 * if the firmware's history isn't here. Version 2 lists its scripts; 1.0 only takes them.
 */
export function firstMacroPad(dir: string): string | null {
  try {
    const bundle = execFileSync(
      'git',
      [
        '-C',
        resolve(APP_FIXTURES, '../../../..'),
        'show',
        '35e43eb39:libs/maki-wasm/tests/fixtures/macropad.maki'
      ],
      { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const path = join(dir, 'macropad-1.0.maki')
    writeFileSync(path, bundle)
    return path
  } catch {
    return null
  }
}
