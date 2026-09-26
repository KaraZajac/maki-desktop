/**
 * The TypeScript client against the real device logic: the Rust fake maki, over TCP.
 * With MAKI_LIVE=1 it also syncs through the real UDP relay to the real Roughtime servers.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relay } from '../main/roughtime'
import { MakiClient, MakiError, syncTime, type Transport } from './client'
import { TimeState } from './protocol'

const FAKE = process.env.MAKI_FAKE ?? resolve(__dirname, '../../../xous-core/target/debug/examples/fake_maki')

class TcpTransport implements Transport {
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

describe.skipIf(!existsSync(FAKE))('against the fake maki', () => {
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

  it('introduces itself and starts with no clock', async () => {
    const t = await TcpTransport.open(port)
    const client = new MakiClient(t)
    expect(await client.hello()).toEqual({ protocol: 1, name: 'maki', version: '0.1.0-fake' })
    expect((await client.status()).timeState).toBe(TimeState.UNSET)
    await t.close()
  })

  it('surfaces protocol errors as MakiError', async () => {
    const t = await TcpTransport.open(port)
    const client = new MakiClient(t)
    await expect(client.timeProof(0, [])).rejects.toBeInstanceOf(MakiError)
    await t.close()
  })

  it('takes this computer’s clock, marked unverified', async () => {
    const t = await TcpTransport.open(port)
    const client = new MakiClient(t)
    expect(await client.timeUnverified(Date.now(), -18000)).toBe(true)
    const s = await client.status()
    expect(s.timeState).toBe(TimeState.UNVERIFIED)
    expect(Math.abs(s.utcMs - Date.now())).toBeLessThan(2000)
    expect(s.tzOffsetS).toBe(-18000)
    await t.close()
  })

  it.skipIf(process.env.MAKI_LIVE !== '1')('syncs verified time through the real Roughtime servers', async () => {
    const t = await TcpTransport.open(port)
    const client = new MakiClient(t)
    const report = await syncTime(client, relay, 3600)
    expect(report.verified).toBe(true)
    expect(report.servers.filter((s) => s.result === 'verified').length).toBeGreaterThanOrEqual(2)
    expect(Math.abs(report.utcMs - Date.now())).toBeLessThan(10_000)
    const s = await client.status()
    expect(s.timeState).toBe(TimeState.VERIFIED)
    // and now the host's word is refused
    expect(await client.timeUnverified(Date.now() + 3_600_000, 0)).toBe(false)
    await t.close()
  })
})
