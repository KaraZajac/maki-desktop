import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storeSource } from '../main/store-source'
import type { Transport } from './client'
import {
  DEV_STORE,
  DEV_STORE_THERE,
  FAKE_BUILT,
  FAKE_NAME,
  startFake,
  TcpTransport as Tcp
} from './test-support'
import { Link, PROBE_TIMEOUT_MS } from './link'
import { TimeState } from './protocol'
import { Store } from './store'

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

describe.skipIf(!FAKE_BUILT)('linking to the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  let port = 0

  beforeAll(async () => {
    fake = await startFake()
    port = fake.port
  })
  afterAll(() => fake?.proc.kill())

  it('links, syncs the clock, and notices an unplug', async () => {
    const link = new Link(noRelay) // Roughtime "offline": falls back to this computer's clock
    const t = await Tcp.open(port)
    expect(await link.attach(t, 'fake maki', { probe: true })).toBe(true)
    expect(link.state.linked && link.state.hello.name).toBe(FAKE_NAME)
    expect(link.report?.verified).toBe(false)
    expect(link.state.linked && link.state.status.timeState).toBe(TimeState.UNVERIFIED)

    // a second device while linked is turned away
    const other = new Silent()
    expect(await link.attach(other, 'USB', { probe: true })).toBe(false)
    expect(other.closed && other.sent === 0).toBe(true)

    const dropped = new Promise<void>((ok) => link.subscribe(() => !link.state.linked && ok()))
    await t.close() // unplug
    await dropped
    expect(link.log[0]).toMatch(/disconnected/)
  })
})

describe.skipIf(!FAKE_BUILT || !DEV_STORE_THERE)('the maki store, through the link', () => {
  let fake: { port: number; proc: ChildProcess }

  beforeAll(async () => {
    fake = await startFake(['--clock-verified'])
  })
  afterAll(() => fake?.proc.kill())

  it('hands maki the store’s newest root before installing from the store, if it hasn’t yet', async () => {
    const link = new Link(noRelay)
    link.autoSync = false // nothing handed over as it links
    link.store = new Store(storeSource(DEV_STORE))
    await link.storeCheck()
    expect(await link.attach(await Tcp.open(fake.port), 'fake maki')).toBe(true)
    const dice = link.store.index!.apps.find((a) => a.name === 'Dice')!
    // stamped by root 2's catalogue key: maki needs root 2 first, and gets it
    expect(await link.storeInstall(dice)).toEqual({ approval: 'approved', reason: '' })
    expect(link.log.some((l) => l.includes("maki took the store's root 2"))).toBe(true)
    const { apps } = await link.appList()
    expect(apps.map((a) => [a.name, a.fromStore])).toEqual([['Dice', true]])
  })
})
