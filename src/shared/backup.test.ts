/**
 * Backups against the fake maki: what one maki hands out, another takes back, once the owner
 * says yes. The fake's backups aren't encrypted (the badge's are); to the desktop they're the
 * same opaque bytes, which is the point.
 */
import type { ChildProcess } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

describe.skipIf(!FAKE_BUILT)('backups', () => {
  const fakes: ChildProcess[] = []
  const client = async (args: string[] = []): Promise<[MakiClient, TcpTransport]> => {
    const fake = await startFake(args)
    fakes.push(fake.proc)
    const t = await TcpTransport.open(fake.port)
    return [new MakiClient(t), t]
  }
  afterAll(() => fakes.forEach((p) => p.kill()))

  it('moves logins from one maki to another, with the owner’s approval', async () => {
    const [a, ta] = await client()
    for (let i = 0; i < 40; i++) {
      // enough to take more than one piece
      expect(await a.saveLogin(`site${i}.example.com`, `user${i}`, 'x'.repeat(200))).toBe('approved')
    }
    const { status, data } = await a.backup()
    expect(status).toBe('approved')
    expect(data.length).toBeGreaterThan(4096)
    await ta.close()

    const [b, tb] = await client()
    expect((await b.getLogin('site7.example.com')).approval).toBe('no match')
    expect(await b.restore(data)).toEqual({ approval: 'approved', logins: 40, codes: 0, passkeys: 0 })
    expect(await b.getLogin('site7.example.com')).toMatchObject({ approval: 'approved', username: 'user7' })
    // nothing new the second time: nothing to ask about
    expect(await b.restore(data)).toEqual({ approval: 'approved', logins: 0, codes: 0, passkeys: 0 })
    await tb.close()
  }, 60_000)

  it('refuses what isn’t a backup of its own, and restores nothing the owner refuses', async () => {
    const [a, ta] = await client(['--deny'])
    expect(await a.restore(new TextEncoder().encode('not a backup'))).toMatchObject({ approval: 'not yours' })
    await ta.close()
  })
})

describe.skipIf(!FAKE_BUILT)('the link keeps backups', () => {
  it('backs up on linking, and restores to another maki', async () => {
    const { Link } = await import('./link')
    const kept: Uint8Array[] = []
    const store = { save: async (d: Uint8Array) => void kept.push(d), latest: async () => kept.at(-1) ?? null }
    const offline = async (): Promise<never> => {
      throw new Error('offline')
    }
    const a = await startFake(['--clock-verified'])
    const link = new Link(offline, undefined, store)
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(a.port), 'fake maki')).toBe(true)
    await link.fromBrowser({ id: 1, type: 'saveLogin', site: 'github.com', username: 'kara', password: 'pw' })
    expect(await link.backupNow()).toBe(true)
    expect(kept).toHaveLength(1)
    link.drop()
    a.proc.kill()

    const b = await startFake()
    const link2 = new Link(offline, undefined, store)
    link2.autoSync = false
    expect(await link2.attach(await TcpTransport.open(b.port), 'fake maki')).toBe(true)
    await link2.restoreLatest()
    expect(link2.log.join('\n')).toMatch(/restored 1 logins, 0 codes and 0 passkeys/)
    expect(link2.log.join('\n')).not.toMatch(/kara|pw\b/)
    link2.drop()
    b.proc.kill()
  }, 30_000)
})
