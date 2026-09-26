/**
 * The extension in real browsers, headless, against the fake maki: Chromium (Playwright's build)
 * and Firefox, each in a throwaway profile, with a throwaway HOME for Firefox, so nothing touches
 * the browsers you actually use. The browser starts the real maki desktop executable as its native
 * messaging host; the bridge and link run here. Opt in:
 *
 *   MAKI_BROWSERS=1 npx vitest run extension/src/real-browsers.test.ts
 *
 * MAKI_CHROMIUM and MAKI_FIREFOX point at other browser binaries.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID, HOST_NAME } from '../../src/main/browsers'
import { serveBridge } from '../../src/main/bridge'
import { Link } from '../../src/shared/link'
import { expectedTotp, FAKE_BUILT, SECRET_B32, startFake, TcpTransport } from '../../src/shared/test-support'

const DESKTOP = resolve(__dirname, '../..')
const ELECTRON = join(DESKTOP, 'node_modules/electron/dist/electron')

function chromium(): string | null {
  if (process.env.MAKI_CHROMIUM) return process.env.MAKI_CHROMIUM
  const cache = join(homedir(), '.cache/ms-playwright')
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort() : []
  const bin = builds.length ? join(cache, builds[builds.length - 1], 'chrome-linux64/chrome') : ''
  return existsSync(bin) ? bin : null
}
function firefox(): string | null {
  if (process.env.MAKI_FIREFOX) return process.env.MAKI_FIREFOX
  try {
    return execFileSync('sh', ['-c', 'command -v firefox'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** The test page: types and submits a login, then lets the extension fill it and a code. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>maki test login</title><body><script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = (what, data = {}) => fetch('/report', { method: 'POST', body: JSON.stringify({ what, ...data }) })
const focus = (el) => { el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) }
async function until(ok, what) {
  for (const t = Date.now(); !(await ok()); await sleep(100)) if (Date.now() - t > 20000) throw new Error(what)
}
async function run() {
  document.body.innerHTML = '<form id="f1"><input type="email" id="u1"><input type="password" id="p1"><button>Sign in</button></form>'
  const f1 = document.getElementById('f1')
  f1.addEventListener('submit', (e) => e.preventDefault())
  document.getElementById('u1').value = 'kara@example.com'
  document.getElementById('p1').value = 'correct horse'
  f1.requestSubmit()
  await until(async () => (await (await fetch('/saved')).json()).saved, 'maki never kept the login')

  document.body.innerHTML = '<form><input type="email" id="u2"><input type="password" id="p2"></form>'
  focus(document.getElementById('p2'))
  await until(() => document.getElementById('p2').value, 'no login filled')
  const login = { username: document.getElementById('u2').value, password: document.getElementById('p2').value }

  document.body.innerHTML = '<form><input type="text" name="app_otp" autocomplete="one-time-code" id="otp"></form>'
  focus(document.getElementById('otp'))
  await until(() => document.getElementById('otp').value, 'no code filled')
  await report('done', { ...login, code: document.getElementById('otp').value })
}
addEventListener('load', () => setTimeout(() => run().catch((e) => report('failed', { error: String(e) })), 1000))
</script>`

describe.skipIf(!process.env.MAKI_BROWSERS || !FAKE_BUILT || process.platform !== 'linux')('the extension in real browsers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maki-b-'))
  let fake: { port: number; proc: ChildProcess }
  let link: Link
  let bridge: Server
  let http: HttpServer
  let origin: string
  let reports: ((r: Record<string, string>) => void)[] = []
  const browsers: ChildProcess[] = []
  // the host the browsers start: the real app, in native-host mode
  const launcher = join(dir, 'maki-native-host')

  beforeAll(async () => {
    execFileSync('npm', ['run', '-s', 'build'], { cwd: DESKTOP, stdio: 'ignore' })
    execFileSync('npm', ['run', '-s', 'build:extension'], { cwd: DESKTOP, stdio: 'ignore' })
    fake = await startFake(['--totp', `localhost=${SECRET_B32}`])
    link = new Link(async () => {
      throw new Error('offline')
    })
    link.autoSync = false
    expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
    // where the host looks for the app: $XDG_RUNTIME_DIR, which the browsers pass on
    bridge = await serveBridge((r) => link.fromBrowser(r), join(dir, `maki-${userInfo().uid}.sock`))
    writeFileSync(launcher, `#!/bin/sh\nexec '${ELECTRON}' '${DESKTOP}' --ozone-platform=headless --native-host "$@"\n`)
    chmodSync(launcher, 0o755)
    http = createServer((req, res) => {
      if (req.url === '/saved') {
        res.end(JSON.stringify({ saved: link.log.some((l) => l.includes('localhost: save approved')) }))
      } else if (req.url === '/report') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          reports.forEach((r) => r(JSON.parse(body)))
          res.end()
        })
      } else {
        res.setHeader('content-type', 'text/html')
        res.end(PAGE)
      }
    })
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok))
    origin = `http://localhost:${(http.address() as AddressInfo).port}`
  }, 120_000)

  afterAll(() => {
    browsers.forEach((b) => b.kill())
    http?.close()
    bridge?.close()
    link?.drop()
    fake?.proc.kill()
  })

  const nextReport = (): Promise<Record<string, string>> =>
    new Promise((ok) => {
      reports = [ok]
    })

  async function check(result: Promise<Record<string, string>>): Promise<void> {
    const r = await result
    expect(r.what, r.error).toBe('done')
    expect(r).toMatchObject({ username: 'kara@example.com', password: 'correct horse' })
    const now = Math.floor(Date.now() / 1000)
    expect([expectedTotp(SECRET_B32, now - 10), expectedTotp(SECRET_B32, now)]).toContain(r.code)
  }

  it.skipIf(!chromium())('Chromium', async () => {
    const profile = join(dir, 'chromium')
    mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true })
    const manifest = { name: HOST_NAME, description: 'maki test', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] }
    writeFileSync(join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`), JSON.stringify(manifest))
    const ext = join(DESKTOP, 'extension/dist/chrome')
    const result = nextReport()
    const b = spawn(
      chromium()!,
      ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, origin + '/'],
      { env: { ...process.env, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' }
    )
    browsers.push(b)
    await check(result)
  }, 60_000)

  it.skipIf(!firefox())('Firefox', async () => {
    // Firefox reads user manifests from $HOME/.mozilla: a throwaway HOME keeps yours untouched
    const home = join(dir, 'home')
    const profile = join(dir, 'firefox')
    mkdirSync(join(home, '.mozilla/native-messaging-hosts'), { recursive: true })
    mkdirSync(profile, { recursive: true })
    const manifest = { name: HOST_NAME, description: 'maki test', path: launcher, type: 'stdio', allowed_extensions: [FIREFOX_EXTENSION_ID] }
    writeFileSync(join(home, '.mozilla/native-messaging-hosts', `${HOST_NAME}.json`), JSON.stringify(manifest))
    writeFileSync(
      join(profile, 'user.js'),
      ['browser.shell.checkDefaultBrowser', 'datareporting.policy.dataSubmissionEnabled', 'app.update.enabled']
        .map((p) => `user_pref("${p}", false);`)
        .concat(['user_pref("browser.startup.homepage_override.mstone", "ignore");', 'user_pref("extensions.originControls.grantByDefault", true);'])
        .join('\n')
    )
    const port = await new Promise<number>((ok) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => ok(p))
      })
    })
    const b = spawn(firefox()!, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port), 'about:blank'], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: dir, MOZ_LEGACY_HOME: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    browsers.push(b)
    let stderr = ''
    await new Promise<void>((ok, fail) => {
      b.stderr!.on('data', (d) => {
        stderr += d
        if (stderr.includes('WebDriver BiDi listening')) ok()
      })
      b.once('exit', () => fail(new Error(`firefox exited: ${stderr}`)))
    })

    // WebDriver BiDi: install the extension temporarily, then open the page
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
    await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
    let nextId = 1
    const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: string; message?: string }) => void>()
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      waiting.get(m.id)?.(m)
    }
    const bidi = (method: string, params: object): Promise<Record<string, unknown>> =>
      new Promise((ok, fail) => {
        const id = nextId++
        waiting.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error} ${m.message}`)) : ok(m.result!)))
        ws.send(JSON.stringify({ id, method, params }))
      })
    await bidi('session.new', { capabilities: {} })
    await bidi('webExtension.install', { extensionData: { type: 'path', path: join(DESKTOP, 'extension/dist/firefox') } })
    const tree = (await bidi('browsingContext.getTree', {})) as { contexts: { context: string }[] }
    const result = nextReport()
    await bidi('browsingContext.navigate', { context: tree.contexts[0].context, url: origin + '/', wait: 'none' })
    await check(result)
    ws.close()
  }, 60_000)
})
