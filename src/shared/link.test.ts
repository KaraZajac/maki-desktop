import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Transport } from './client'
import { Link, PROBE_TIMEOUT_MS } from './link'
import { TimeState } from './protocol'

const FAKE = process.env.MAKI_FAKE ?? resolve(__dirname, '../../../xous-core/target/debug/examples/fake_maki')

/** A device that never answers: what a stock DC34 badge looks like to the probe. */
class Silent implements Transport {
  closed = false
  sent = 0
  private closeListeners: (() => void)[] = []
  async send(): Promise<void> {
    this.sent++
  }
  onData(): void {}
  onClose(l: () => void): void {
    this.closeListeners.push(l)
  }
  async close(): Promise<void> {
    this.closed = true
    this.closeListeners.forEach((l) => l())
  }
}

class Tcp implements Transport {
  private constructor(readonly socket: Socket) {}
  static open(port: number): Promise<Tcp> {
    return new Promise((ok, fail) => {
      const s = connect(port, '127.0.0.1', () => ok(new Tcp(s)))
      s.once('error', fail)
    })
  }
  send(b: Uint8Array): Promise<void> {
    return new Promise((ok, fail) => this.socket.write(b, (e) => (e ? fail(e) : ok())))
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

const noRelay = async (): Promise<Uint8Array> => {
  throw new Error('offline')
}

describe('probing', () => {
  it('leaves a device that does not answer alone, promptly', async () => {
    const link = new Link(noRelay)
    const device = new Silent()
    const started = Date.now()
    expect(await link.attach(device, 'USB', { probe: true })).toBe(false)
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 500)
    expect(device.closed).toBe(true)
    expect(device.sent).toBe(1) // one HELLO, nothing else
    expect(link.state.linked).toBe(false)
    expect(link.busy).toBe(false)
  })
})

describe.skipIf(!existsSync(FAKE))('linking to the fake maki', () => {
  let fake: ChildProcess
  let port = 0

  beforeAll(async () => {
    fake = spawn(FAKE, ['127.0.0.1:0'])
    port = await new Promise<number>((ok, fail) => {
      fake.stdout!.on('data', (d: Buffer) => {
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(d.toString())
        if (m) ok(Number(m[1]))
      })
      fake.once('exit', () => fail(new Error('fake maki exited')))
    })
  })
  afterAll(() => fake?.kill())

  it('links, syncs the clock, and notices an unplug', async () => {
    const link = new Link(noRelay) // Roughtime "offline": falls back to this computer's clock
    const t = await Tcp.open(port)
    expect(await link.attach(t, 'fake maki', { probe: true })).toBe(true)
    expect(link.state.linked && link.state.hello.name).toBe('maki')
    expect(link.report?.verified).toBe(false)
    expect(link.state.linked && link.state.status.timeState).toBe(TimeState.UNVERIFIED)

    // a second device while linked is turned away
    const other = new Silent()
    expect(await link.attach(other, 'USB', { probe: true })).toBe(false)
    expect(other.closed && other.sent === 0).toBe(true)

    const dropped = new Promise<void>((ok) => link.subscribe(() => !link.state.linked && ok()))
    t.socket.destroy() // unplug
    await dropped
    expect(link.log[0]).toMatch(/disconnected/)
  })
})
