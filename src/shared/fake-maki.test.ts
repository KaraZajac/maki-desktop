/**
 * The TypeScript client against the real device logic: the Rust fake maki, over TCP.
 * With MAKI_LIVE=1 it also syncs through the real UDP relay to the real Roughtime servers.
 */
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { relay } from '../main/roughtime'
import { MakiClient, MakiError, syncTime } from './client'
import { TimeState } from './protocol'
import { expectedTotp, FAKE_BUILT, SECRET_B32, startFake, TcpTransport } from './test-support'

describe.skipIf(!FAKE_BUILT)('against the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  const client = async (): Promise<[MakiClient, TcpTransport]> => {
    const t = await TcpTransport.open(fake.port)
    return [new MakiClient(t), t]
  }

  beforeAll(async () => {
    fake = await startFake(['--totp', `example.com=${SECRET_B32}`])
  })
  afterAll(() => fake?.proc.kill())

  it('introduces itself and starts with no clock', async () => {
    const [c, t] = await client()
    expect(await c.hello()).toEqual({ protocol: 2, name: 'maki', version: '0.2.0-fake' })
    expect((await c.status()).timeState).toBe(TimeState.UNSET)
    await t.close()
  })

  it('surfaces protocol errors as MakiError', async () => {
    const [c, t] = await client()
    await expect(c.timeProof(0, [])).rejects.toBeInstanceOf(MakiError)
    await expect(c.getLogin('GitHub.com')).rejects.toThrow('bad argument')
    await t.close()
  })

  it('takes this computer’s clock, marked unverified', async () => {
    const [c, t] = await client()
    expect(await c.timeUnverified(Date.now(), -18000)).toBe(true)
    const s = await c.status()
    expect(s.timeState).toBe(TimeState.UNVERIFIED)
    expect(Math.abs(s.utcMs - Date.now())).toBeLessThan(2000)
    expect(s.tzOffsetS).toBe(-18000)
    await t.close()
  })

  it('keeps a login it is given, and hands it back for the same site and its subdomains', async () => {
    const [c, t] = await client()
    expect(await c.getLogin('github.com')).toEqual({ approval: 'no match', username: '', password: '' })
    expect(await c.saveLogin('github.com', 'kara', 'correct horse')).toBe('approved')
    expect(await c.getLogin('github.com')).toEqual({ approval: 'approved', username: 'kara', password: 'correct horse' })
    expect((await c.getLogin('gist.github.com')).username).toBe('kara')
    expect((await c.getLogin('evilgithub.com')).approval).toBe('no match')
    await t.close()
  })

  it('gives the right TOTP code', async () => {
    const [c, t] = await client()
    const before = Math.floor(Date.now() / 1000)
    const { approval, code, validForS } = await c.getTotp('example.com')
    const after = Math.floor(Date.now() / 1000)
    expect(approval).toBe('approved')
    expect([expectedTotp(SECRET_B32, before), expectedTotp(SECRET_B32, after)]).toContain(code)
    expect(validForS).toBeGreaterThan(0)
    expect(validForS).toBeLessThanOrEqual(30)
    await t.close()
  })

  it('keeps answering heartbeats while the owner is deciding', async () => {
    const [c, t] = await client()
    await c.saveLogin('example.org', 'kara', 'pw')
    const pending = c.getLogin('example.org') // the fake "reads the screen" for 300 ms
    const started = Date.now()
    const statuses = await Promise.all([c.status(), c.status(), c.status()])
    expect(Date.now() - started).toBeLessThan(250) // not stuck behind the approval
    expect(statuses).toHaveLength(3)
    expect((await pending).approval).toBe('approved')
    await t.close()
  })

  it.skipIf(process.env.MAKI_LIVE !== '1')('syncs verified time through the real Roughtime servers', async () => {
    const [c, t] = await client()
    const report = await syncTime(c, relay, 3600)
    expect(report.verified).toBe(true)
    expect(report.servers.filter((s) => s.result === 'verified').length).toBeGreaterThanOrEqual(2)
    expect(Math.abs(report.utcMs - Date.now())).toBeLessThan(10_000)
    expect((await c.status()).timeState).toBe(TimeState.VERIFIED)
    expect(await c.timeUnverified(Date.now() + 3_600_000, 0)).toBe(false)
    await t.close()
  })
})

describe.skipIf(!FAKE_BUILT)('when the owner says no', () => {
  let fake: { port: number; proc: ChildProcess }
  beforeAll(async () => {
    fake = await startFake(['--deny', '--totp', `example.com=${SECRET_B32}`])
  })
  afterAll(() => fake?.proc.kill())

  it('hands over nothing', async () => {
    const t = await TcpTransport.open(fake.port)
    const c = new MakiClient(t)
    expect(await c.saveLogin('github.com', 'kara', 'pw')).toBe('denied')
    expect(await c.getTotp('example.com')).toEqual({ approval: 'denied', code: '', validForS: 0 })
    await t.close()
  })
})
