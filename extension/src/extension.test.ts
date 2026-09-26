// @vitest-environment happy-dom
/**
 * The whole path but the browser: a page (happy-dom) with the content script, the background
 * script, native messaging to the host, the bridge socket, maki desktop's link, and the fake maki
 * running the firmware's protocol logic.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveBridge } from '../../src/main/bridge'
import { readNativeMessages, runNativeHost, writeNativeMessage } from '../../src/main/native-host'
import { Link } from '../../src/shared/link'
import { expectedTotp, FAKE_BUILT, SECRET_B32, startFake, TcpTransport } from '../../src/shared/test-support'

const PAGE = 'https://github.com/login'

describe.skipIf(!FAKE_BUILT)('the maki extension, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let server: Server
  let link: Link
  let host: Promise<void>
  const toHost = new PassThrough()
  const fromHost = new PassThrough()

  beforeAll(async () => {
    fake = await startFake(['--clock-verified', '--totp', `github.com=${SECRET_B32}`])
    link = new Link(async () => {
      throw new Error('offline')
    })
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
    const sock = join(mkdtempSync(join(tmpdir(), 'maki-ext-')), 'bridge.sock')
    server = await serveBridge((r) => link.fromBrowser(r), sock)
    host = runNativeHost({ socketPath: sock, input: toHost, output: fromHost })

    // the browser: connectNative is a pipe to the host; runtime messages go to the background
    // script, with the sender the browser would name
    let background: (msg: unknown, sender: object, respond: (r: unknown) => void) => boolean = () => false
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'maki',
        connectNative: () => ({
          postMessage: (m: unknown) => writeNativeMessage(toHost, JSON.stringify(m)),
          onMessage: { addListener: (f: (m: unknown) => void) => readNativeMessages(fromHost, (json) => f(JSON.parse(json)), () => {}) },
          onDisconnect: { addListener: () => {} }
        }),
        onMessage: { addListener: (f: typeof background) => (background = f) },
        sendMessage: (msg: unknown) => new Promise((respond) => background(msg, { id: 'maki', url: PAGE }, respond))
      }
    })
    await import('./background')
    await import('./content')
  })
  afterAll(async () => {
    toHost.end()
    await host
    link?.drop()
    server?.close()
    fake?.proc.kill()
  })

  const page = (html: string): void => {
    document.body.innerHTML = html
  }
  const $ = (sel: string): HTMLInputElement => document.querySelector<HTMLInputElement>(sel)!

  it('asks maki when you click into a login it has nothing for, and fills nothing', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"></form>')
    $('#p').focus()
    await vi.waitFor(() => expect(link.log.join('\n')).toMatch(/github\.com: login no match/))
    expect($('#u').value + $('#p').value).toBe('')
  })

  it('offers a login you type to maki when you submit it', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"><button>Sign in</button></form>')
    $('#u').value = 'kara@example.com'
    $('#p').value = 'correct horse'
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(link.log.join('\n')).toMatch(/github\.com: save approved/))
  })

  it('fills that login on the next visit, once approved on maki', async () => {
    page('<form><input type="email" id="u"><input type="password" id="p"></form>')
    $('#u').focus() // the username field asks too
    await vi.waitFor(() => expect($('#p').value).toBe('correct horse'))
    expect($('#u').value).toBe('kara@example.com')
  })

  it('fills a TOTP code, once approved on maki', async () => {
    page('<form><input type="text" name="app_otp" autocomplete="one-time-code" id="otp"></form>')
    $('#otp').focus()
    await vi.waitFor(() => expect($('#otp').value).toMatch(/^\d{6}$/))
    const now = Math.floor(Date.now() / 1000)
    expect([expectedTotp(SECRET_B32, now - 5), expectedTotp(SECRET_B32, now)]).toContain($('#otp').value)
  })

  it('keeps secrets out of maki desktop’s log', () => {
    expect(link.log.join('\n')).not.toMatch(/correct horse|kara@example\.com|\d{6}/)
  })
})
