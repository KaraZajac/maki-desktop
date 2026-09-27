/**
 * The browser path without the browser: native-messaging frames in, through the host, the bridge
 * socket and the link, to the firmware's real protocol logic in the fake maki, and back.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import { APP_FIXTURES, APP_FIXTURES_THERE, expectedTotp, FAKE_BUILT, SECRET_B32, startFake, TcpTransport } from '../shared/test-support'
import { forWindow, serveBridge } from './bridge'
import { readNativeMessages, runNativeHost, writeNativeMessage } from './native-host'

/** A browser's end of native messaging: send framed JSON, collect framed replies by id. */
function browser(): { input: PassThrough; output: PassThrough; send: (m: object) => void; reply: (id: number) => Promise<Record<string, unknown>> } {
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = new Map<number, Record<string, unknown>>()
  const waiters = new Map<number, (r: Record<string, unknown>) => void>()
  readNativeMessages(
    output,
    (json) => {
      const r = JSON.parse(json) as Record<string, unknown>
      const id = r.id as number
      const w = waiters.get(id)
      if (w) w(r)
      else replies.set(id, r)
    },
    () => {}
  )
  return {
    input,
    output,
    send: (m) => writeNativeMessage(input, JSON.stringify(m)),
    reply: (id) => (replies.has(id) ? Promise.resolve(replies.get(id)!) : new Promise((ok) => waiters.set(id, ok)))
  }
}

describe('native messaging framing', () => {
  it('round-trips messages split across chunks', async () => {
    const stream = new PassThrough()
    const got: string[] = []
    readNativeMessages(stream, (m) => got.push(m), () => {})
    const a = new PassThrough()
    writeNativeMessage(a, '{"a":1}')
    writeNativeMessage(a, '{"b":"ü"}')
    const bytes = a.read() as Buffer
    for (const byte of bytes) stream.write(Buffer.of(byte))
    await new Promise((r) => setImmediate(r))
    expect(got).toEqual(['{"a":1}', '{"b":"ü"}'])
  })

  it('tells the browser when the app is not there', async () => {
    const b = browser()
    const done = runNativeHost({ socketPath: join(tmpdir(), 'maki-nobody-home.sock'), input: b.input, output: b.output, retry: { attempts: 1, delayMs: 10 } })
    b.send({ id: 1, type: 'status' })
    expect(await b.reply(1)).toEqual({ id: 1, ok: false, error: 'maki desktop is not running' })
    b.input.end()
    await done
  })
})

describe.skipIf(!FAKE_BUILT)('browser to maki, through the host and the bridge', () => {
  let fake: { port: number; proc: ChildProcess }
  let server: Server
  let link: Link
  const sock = join(mkdtempSync(join(tmpdir(), 'maki-test-')), 'bridge.sock')

  beforeAll(async () => {
    fake = await startFake(['--clock-verified', '--totp', `example.com=${SECRET_B32}`])
    link = new Link(async () => {
      throw new Error('offline')
    })
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
    server = await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), sock)
  })
  afterAll(() => {
    link?.drop()
    server?.close()
    fake?.proc.kill()
  })

  it('saves and fills a login, gives a code, and reports status', async () => {
    const b = browser()
    const host = runNativeHost({ socketPath: sock, input: b.input, output: b.output })
    b.send({ id: 1, type: 'saveLogin', site: 'github.com', username: 'kara', password: 'correct horse' })
    expect(await b.reply(1)).toMatchObject({ ok: true, type: 'saveLogin', approval: 'approved' })

    b.send({ id: 2, type: 'getLogin', site: 'gist.github.com' })
    b.send({ id: 3, type: 'getTotp', site: 'example.com' })
    b.send({ id: 4, type: 'status' })
    expect(await b.reply(4)).toMatchObject({ ok: true, linked: true }) // not held up by the approvals
    expect(await b.reply(2)).toMatchObject({ ok: true, approval: 'approved', username: 'kara', password: 'correct horse' })
    const code = (await b.reply(3)).code as string
    const now = Math.floor(Date.now() / 1000)
    expect([expectedTotp(SECRET_B32, now - 1), expectedTotp(SECRET_B32, now)]).toContain(code)

    // the log names sites and outcomes, never secrets
    expect(link.log.join('\n')).not.toMatch(/correct horse|kara|\d{6}/)
    b.input.end()
    await host
  })

  it('keeps installing apps away from the extension', async () => {
    const b = browser()
    const host = runNativeHost({ socketPath: sock, input: b.input, output: b.output })
    b.send({ id: 7, type: 'install', path: join(APP_FIXTURES, 'dice.maki') })
    b.send({ id: 8, type: 'installBundle', data: [] })
    // nor apps' messages, which are for software on this computer
    b.send({ id: 9, type: 'appMessage', app: 'com.leviathan.maki.ssh', data: 'AAAAAQs=' })
    expect(await b.reply(7)).toEqual({ id: 7, ok: false, error: 'not for the extension' })
    expect(await b.reply(8)).toEqual({ id: 8, ok: false, error: 'not for the extension' })
    expect(await b.reply(9)).toEqual({ id: 9, ok: false, error: 'not for the extension' })
    b.input.end()
    await host
  })

  it.skipIf(!APP_FIXTURES_THERE)('installs an app for `maki install`, straight on the socket', async () => {
    const ask = async (request: object): Promise<Record<string, unknown>> => {
      const s = connect(sock)
      s.setEncoding('utf8')
      s.write(JSON.stringify(request) + '\n')
      const line = await new Promise<string>((ok) => {
        let got = ''
        s.on('data', (d: string) => {
          got += d
          if (got.includes('\n')) ok(got.slice(0, got.indexOf('\n')))
        })
      })
      s.end()
      return JSON.parse(line) as Record<string, unknown>
    }
    expect(await ask({ id: 1, type: 'install', path: join(APP_FIXTURES, 'dice.maki') })).toMatchObject({
      ok: true,
      type: 'install',
      name: 'Dice',
      approval: 'approved'
    })
    expect(await ask({ id: 2, type: 'install', path: 'dice.maki' })).toMatchObject({ ok: false, error: expect.stringContaining('full path') })
    expect(await ask({ id: 3, type: 'installBundle', data: [] })).toEqual({ id: 3, ok: false, error: 'malformed request' })
    expect((await link.appList()).apps.map((a) => a.id)).toContain('com.leviathan.maki.dice')

    // a message for an app, from software on this computer: SSH's list of keys
    expect(await ask({ id: 4, type: 'install', path: join(APP_FIXTURES, 'ssh.maki') })).toMatchObject({ ok: true, approval: 'approved' })
    const listed = await ask({ id: 5, type: 'appMessage', app: 'com.leviathan.maki.ssh', data: 'AAAAAQs=' })
    expect(listed).toMatchObject({ id: 5, ok: true, type: 'appMessage', status: 'approved' })
    expect(Buffer.from(listed.data as string, 'base64')[0]).toBe(12)
    // Dice can't be talked to; and what isn't a message
    expect(await ask({ id: 6, type: 'appMessage', app: 'com.leviathan.maki.dice', data: 'AA==' })).toMatchObject({ ok: true, status: 'refused', data: '' })
    for (const [id, bad] of [
      [7, { app: 'com.leviathan.maki.ssh', data: 'not base64!' }],
      [8, { app: 'SSH', data: 'AA==' }],
      [9, { app: 'com.leviathan.maki.ssh', data: Buffer.alloc(4097).toString('base64') }]
    ] as const) {
      expect(await ask({ id, type: 'appMessage', ...bad })).toEqual({ id, ok: false, error: 'malformed request' })
    }
  })

  it('rejects what it cannot parse, and sites maki would not show', async () => {
    const b = browser()
    const host = runNativeHost({ socketPath: sock, input: b.input, output: b.output })
    b.send({ id: 5, type: 'getLogin' })
    b.send({ id: 6, type: 'getLogin', site: 'GitHub.com' })
    expect(await b.reply(5)).toEqual({ id: 5, ok: false, error: 'malformed request' })
    expect(await b.reply(6)).toMatchObject({ ok: false, error: expect.stringContaining('bad argument') })
    b.input.end()
    await host
  })
})
