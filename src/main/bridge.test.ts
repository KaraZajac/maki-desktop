/**
 * The browser path without the browser: native-messaging frames in, through the host, the bridge
 * socket and the link, to the firmware's real protocol logic in the fake maki, and back.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import { expectedTotp, FAKE_BUILT, SECRET_B32, startFake, TcpTransport } from '../shared/test-support'
import { serveBridge } from './bridge'
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
    fake = await startFake(['--totp', `example.com=${SECRET_B32}`])
    link = new Link(async () => {
      throw new Error('offline')
    })
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
    server = await serveBridge((r) => link.fromBrowser(r), sock)
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
