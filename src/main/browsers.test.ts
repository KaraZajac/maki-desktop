import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserStatus } from '../shared/bridge-types'
import { extensionOnly, serveBridge } from './bridge'
import {
  addCustomBrowser,
  browserStatus,
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  launcherPath,
  refreshLauncher,
  registerBrowser,
  relayPath,
  removeCustomBrowser,
  unregisterBrowser,
  type AsAdmin,
  type Flatpak,
  type Registry
} from './browsers'

const saved = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME
}
let home: string
const launch = { exe: "/opt/it's maki/maki", appPath: null }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'maki-home-'))
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_DATA_HOME
})
afterEach(() => {
  Object.assign(process.env, saved)
  rmSync(home, { recursive: true, force: true })
})

/** Records what would run as root, and does nothing. */
function admin(): AsAdmin & { ran: string[][] } {
  const ran: string[][] = []
  return Object.assign(async (c: string[]) => void ran.push(c), { ran })
}

/**
 * Flatpak in a folder: installations, running sandboxes, and `flatpak override --user` keeping
 * each app's overrides in a key file, as flatpak does.
 */
function fakeFlatpak(): Flatpak & { ran: string[][] } {
  const root = join(home, 'flatpak-world')
  const ran: string[][] = []
  const overrides = join(root, 'overrides')
  return {
    ran,
    installations: [join(root, 'system'), join(root, 'user')],
    instances: join(root, 'instances'),
    proc: join(root, 'proc'),
    overrides,
    override: async (args) => {
      ran.push(args)
      const app = args.at(-1)!
      const file = join(overrides, app)
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const list = (key: string): string[] =>
        (new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '').split(';').filter(Boolean)
      const filesystems = list('filesystems')
      const persistent = new Set(list('persistent'))
      const path = (f: string): string => f.replace(/^!/, '').replace(/:.*$/, '')
      for (const a of args.slice(0, -1)) {
        const [flag, value] = a.split('=')
        if (flag === '--filesystem' || flag === '--nofilesystem') {
          const kept = filesystems.filter((f) => path(f) !== path(value))
          filesystems.splice(
            0,
            filesystems.length,
            ...kept,
            flag === '--filesystem' ? value : `!${value}`
          )
        } else if (flag === '--persist') persistent.add(value)
      }
      mkdirSync(overrides, { recursive: true })
      writeFileSync(
        file,
        `[Context]\nfilesystems=${filesystems.join(';')};\npersistent=${[...persistent].join(';')};\n`
      )
    }
  }
}

/** An app installed in the fake Flatpak, with its runtime, which has Python unless told not to. */
function installFlatpak(fp: Flatpak, app: string, { persistent = '', python = true } = {}): void {
  const runtime = 'org.freedesktop.Platform/x86_64/25.08'
  const meta = join(fp.installations[0], 'app', app, 'current', 'active')
  mkdirSync(meta, { recursive: true })
  writeFileSync(
    join(meta, 'metadata'),
    `[Application]\nname=${app}\nruntime=${runtime}\n\n[Context]\nshared=network;\npersistent=${persistent};\n`
  )
  const bin = join(fp.installations[0], 'runtime', runtime, 'active', 'files', 'bin')
  mkdirSync(bin, { recursive: true })
  if (python) writeFileSync(join(bin, 'python3'), '')
}

/**
 * A sandbox of the app, running with the permissions it started with. With `programs`, it says
 * which pid namespace it is, as bwrap does, and those run in it (in the fake /proc).
 */
function runFlatpak(fp: Flatpak, app: string, context: string, programs?: string[]): void {
  const dir = join(fp.instances, String(Math.floor(Math.random() * 1e9)))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'info'),
    `[Application]\nname=${app}\n\n[Instance]\ninstance-id=1\n\n[Context]\n${context}\n`
  )
  if (!programs) return
  const ns = 4026530000 + Math.floor(Math.random() * 1e5)
  writeFileSync(
    join(dir, 'bwrapinfo.json'),
    JSON.stringify({ 'child-pid': 1, 'pid-namespace': ns })
  )
  for (const exe of ['/usr/bin/bwrap', ...programs]) {
    const pid = join(fp.proc, String(Math.floor(Math.random() * 1e7)))
    mkdirSync(join(pid, 'ns'), { recursive: true })
    symlinkSync(`pid:[${ns}]`, join(pid, 'ns', 'pid'))
    symlinkSync(exe, join(pid, 'exe'))
  }
}

const row = (s: BrowserStatus[], id: string): BrowserStatus | undefined =>
  s.find((b) => b.id === id)
const plain = { shares: [], restart: false }

describe.skipIf(process.platform !== 'linux')('browser setup on Linux', () => {
  let fp: ReturnType<typeof fakeFlatpak>
  beforeEach(() => {
    fp = fakeFlatpak()
  })

  it('lists only installed browsers', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    expect(await browserStatus({ flatpak: fp })).toEqual({
      browsers: [
        {
          id: 'chrome',
          name: 'Chrome',
          family: 'chromium',
          kind: 'native',
          registered: false,
          system: false,
          ...plain
        }
      ],
      custom: true
    })
  })

  it('points Chrome at the launcher, for the maki extension only', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    const { browsers } = await registerBrowser('chrome', launch, { asAdmin: admin(), flatpak: fp })
    expect(row(browsers, 'chrome')?.registered).toBe(true)
    const m = JSON.parse(
      readFileSync(
        join(home, '.config/google-chrome/NativeMessagingHosts/com.leviathan.maki.json'),
        'utf8'
      )
    )
    expect(m).toMatchObject({
      name: 'com.leviathan.maki',
      type: 'stdio',
      path: launcherPath(),
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    })
  })

  it('writes a launcher that starts this app headless, whatever its path', async () => {
    mkdirSync(join(home, '.config', 'chromium'), { recursive: true })
    await registerBrowser('chromium', launch, { asAdmin: admin(), flatpak: fp })
    const script = readFileSync(launcherPath(), 'utf8')
    execFileSync('sh', ['-n', launcherPath()]) // parses
    expect(script).toContain(
      `exec '/opt/it'\\''s maki/maki' --ozone-platform=headless --native-host "$@"`
    )
  })

  it('brings the launcher up to date after an update, and says so until then', async () => {
    mkdirSync(join(home, '.config', 'chromium'), { recursive: true })
    const old = { exe: '/home/k/maki-0.1.1.AppImage', appPath: null }
    await registerBrowser('chromium', old, { asAdmin: admin(), flatpak: fp })
    const now = { exe: '/home/k/maki-0.1.2.AppImage', appPath: null }
    // the update replaced the AppImage the launcher starts: not connected, as it stands
    const before = await browserStatus({ flatpak: fp, launch: now })
    expect(row(before.browsers, 'chromium')?.registered).toBe(false)
    await refreshLauncher(now)
    expect(readFileSync(launcherPath(), 'utf8')).toContain(`exec '/home/k/maki-0.1.2.AppImage'`)
    const after = await browserStatus({ flatpak: fp, launch: now })
    expect(row(after.browsers, 'chromium')?.registered).toBe(true)
  })

  it('leaves a launcher it didn’t write alone', async () => {
    mkdirSync(dirname(launcherPath()), { recursive: true })
    writeFileSync(launcherPath(), '#!/bin/sh\nexec my-own-thing\n')
    await refreshLauncher(launch)
    expect(readFileSync(launcherPath(), 'utf8')).toBe('#!/bin/sh\nexec my-own-thing\n')
  })

  it('uses ~/.mozilla for a Firefox that already keeps its profiles there', async () => {
    mkdirSync(join(home, '.mozilla', 'firefox'), { recursive: true })
    const a = admin()
    const { browsers } = await registerBrowser('firefox', launch, { asAdmin: a, flatpak: fp })
    expect(row(browsers, 'firefox')).toMatchObject({ registered: true, system: false })
    const m = JSON.parse(
      readFileSync(join(home, '.mozilla/native-messaging-hosts/com.leviathan.maki.json'), 'utf8')
    )
    expect(m.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    expect(a.ran).toEqual([])
  })

  it('never creates ~/.mozilla for a Firefox using ~/.config/mozilla: that would hide its profile', async () => {
    mkdirSync(join(home, '.config', 'mozilla', 'firefox'), { recursive: true })
    expect(row((await browserStatus({ flatpak: fp })).browsers, 'firefox')).toMatchObject({
      registered: false,
      system: true
    })
    const a = admin()
    await registerBrowser('firefox', launch, { asAdmin: a, flatpak: fp })
    expect(existsSync(join(home, '.mozilla'))).toBe(false)
    expect(a.ran).toHaveLength(1)
    const [cmd, ...args] = a.ran[0]
    expect(cmd).toBe('/usr/bin/install')
    expect(args.at(-1)).toMatch(
      /^\/usr\/lib(64)?\/mozilla\/native-messaging-hosts\/com\.leviathan\.maki\.json$/
    )
    const staged = JSON.parse(readFileSync(args.at(-2)!, 'utf8'))
    expect(staged).toMatchObject({
      path: launcherPath(),
      allowed_extensions: [FIREFOX_EXTENSION_ID]
    })
  })

  it('says which browsers read the same registration, as Zen and Firefox do', async () => {
    mkdirSync(join(home, '.mozilla', 'firefox'), { recursive: true })
    mkdirSync(join(home, '.zen'), { recursive: true })
    const { browsers } = await registerBrowser('zen', launch, { asAdmin: admin(), flatpak: fp })
    expect(row(browsers, 'zen')).toMatchObject({ registered: true, shares: ['Firefox'] })
    expect(row(browsers, 'firefox')).toMatchObject({ registered: true, shares: ['Zen'] })
  })

  it('removes what it registered', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    await registerBrowser('chrome', launch, { asAdmin: admin(), flatpak: fp })
    const { browsers } = await unregisterBrowser('chrome', { asAdmin: admin(), flatpak: fp })
    expect(row(browsers, 'chrome')?.registered).toBe(false)
  })

  it('refuses a browser that is not installed', async () => {
    await expect(
      registerBrowser('vivaldi', launch, { asAdmin: admin(), flatpak: fp })
    ).rejects.toThrow("Vivaldi isn't installed")
  })

  describe('a browser in a Flatpak sandbox', () => {
    const ZEN = 'app.zen_browser.zen'

    it('is listed from the installation that has it', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen' })
      expect(row((await browserStatus({ flatpak: fp })).browsers, `flatpak:${ZEN}`)).toEqual({
        id: `flatpak:${ZEN}`,
        name: 'Zen',
        family: 'firefox',
        kind: 'flatpak',
        registered: false,
        system: false,
        ...plain
      })
    })

    it('gets a relay in its own folder, its manifest where it looks inside, and one shared folder', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen' })
      const a = admin()
      const { browsers } = await registerBrowser(`flatpak:${ZEN}`, launch, {
        asAdmin: a,
        flatpak: fp
      })
      expect(row(browsers, `flatpak:${ZEN}`)).toMatchObject({ registered: true, restart: false })
      // Zen reads ~/.mozilla/native-messaging-hosts inside, which its sandbox keeps only with --persist
      const m = JSON.parse(
        readFileSync(
          join(home, '.var/app', ZEN, '.mozilla/native-messaging-hosts/com.leviathan.maki.json'),
          'utf8'
        )
      )
      expect(m).toMatchObject({ path: relayPath(ZEN), allowed_extensions: [FIREFOX_EXTENSION_ID] })
      expect(relayPath(ZEN)).toBe(join(home, '.var/app', ZEN, 'maki', 'maki-native-host'))
      expect(statSync(relayPath(ZEN)).mode & 0o111).toBeTruthy()
      expect(fp.ran).toEqual([['--filesystem=xdg-run/maki:create', '--persist=.mozilla', ZEN]])
      // nothing outside the sandbox, and no password
      expect(existsSync(join(home, '.mozilla'))).toBe(false)
      expect(existsSync(launcherPath())).toBe(false)
      expect(a.ran).toEqual([])
    })

    it('asks nothing more of a Flatpak that keeps the folder already, as Firefox’s does', async () => {
      installFlatpak(fp, 'org.mozilla.firefox', { persistent: '.mozilla' })
      await registerBrowser('flatpak:org.mozilla.firefox', launch, {
        asAdmin: admin(),
        flatpak: fp
      })
      expect(fp.ran).toEqual([['--filesystem=xdg-run/maki:create', 'org.mozilla.firefox']])
    })

    it('puts a Chromium browser’s manifest in its config folder, which its sandbox sees', async () => {
      installFlatpak(fp, 'com.brave.Browser', { persistent: '.pki' })
      await registerBrowser('flatpak:com.brave.Browser', launch, { asAdmin: admin(), flatpak: fp })
      const m = JSON.parse(
        readFileSync(
          join(
            home,
            '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.leviathan.maki.json'
          ),
          'utf8'
        )
      )
      expect(m).toMatchObject({
        path: relayPath('com.brave.Browser'),
        allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
      })
      expect(fp.ran).toEqual([['--filesystem=xdg-run/maki:create', 'com.brave.Browser']])
    })

    it('asks for a restart while a sandbox from before is running, until there is none', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen' })
      runFlatpak(fp, ZEN, 'filesystems=xdg-download;\npersistent=.zen;')
      const { browsers } = await registerBrowser(`flatpak:${ZEN}`, launch, {
        asAdmin: admin(),
        flatpak: fp
      })
      expect(row(browsers, `flatpak:${ZEN}`)).toMatchObject({ registered: true, restart: true })
      rmSync(fp.instances, { recursive: true })
      runFlatpak(
        fp,
        ZEN,
        'filesystems=xdg-download;xdg-run/maki:create;\npersistent=.zen;.mozilla;'
      )
      expect(row((await browserStatus({ flatpak: fp })).browsers, `flatpak:${ZEN}`)).toMatchObject({
        restart: false
      })
    })

    it('takes a sandbox only a helper outlived the browser in for no reason to restart', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen' })
      const { browsers } = await registerBrowser(`flatpak:${ZEN}`, launch, {
        asAdmin: admin(),
        flatpak: fp
      })
      expect(row(browsers, `flatpak:${ZEN}`)).toMatchObject({ registered: true, restart: false })
      // an old Zen from before maki, gone but for the adb its about:debugging started
      const adb = '/home/kara/.var/app/app.zen_browser.zen/cache/zen/profile/adb/adb'
      runFlatpak(fp, ZEN, 'filesystems=xdg-download;\npersistent=.zen;', [adb])
      // and the Zen in use, which has what it needs
      runFlatpak(
        fp,
        ZEN,
        'filesystems=xdg-download;xdg-run/maki:create;\npersistent=.zen;.mozilla;',
        ['/app/zen/zen']
      )
      const status = async (): Promise<BrowserStatus | undefined> =>
        row((await browserStatus({ flatpak: fp })).browsers, `flatpak:${ZEN}`)
      expect(await status()).toMatchObject({ restart: false })
      // the old one running Zen itself is another matter
      runFlatpak(fp, ZEN, 'filesystems=xdg-download;\npersistent=.zen;', ['/app/zen/zen', adb])
      expect(await status()).toMatchObject({ restart: true })
    })

    it('refuses a Flatpak whose runtime has no Python for the relay', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen', python: false })
      await expect(
        registerBrowser(`flatpak:${ZEN}`, launch, { asAdmin: admin(), flatpak: fp })
      ).rejects.toThrow('has no Python')
      expect(fp.ran).toEqual([])
    })

    it('takes the relay, the manifest and the shared folder away again', async () => {
      installFlatpak(fp, ZEN, { persistent: '.zen' })
      await registerBrowser(`flatpak:${ZEN}`, launch, { asAdmin: admin(), flatpak: fp })
      const { browsers } = await unregisterBrowser(`flatpak:${ZEN}`, {
        asAdmin: admin(),
        flatpak: fp
      })
      expect(row(browsers, `flatpak:${ZEN}`)?.registered).toBe(false)
      expect(existsSync(dirname(relayPath(ZEN)))).toBe(false)
      expect(
        existsSync(
          join(home, '.var/app', ZEN, '.mozilla/native-messaging-hosts/com.leviathan.maki.json')
        )
      ).toBe(false)
      expect(fp.ran.at(-1)).toEqual(['--nofilesystem=xdg-run/maki', ZEN])
    })
  })

  describe('a browser added by hand', () => {
    it('is connected by its folder, the usual name added, and forgotten again', async () => {
      const view = await addCustomBrowser(
        { name: 'Cromite', family: 'chromium', dir: join(home, '.config', 'cromite') },
        launch,
        {
          asAdmin: admin(),
          flatpak: fp
        }
      )
      expect(view.browsers).toEqual([
        {
          id: 'custom:1',
          name: 'Cromite',
          family: 'chromium',
          kind: 'custom',
          registered: true,
          system: false,
          ...plain
        }
      ])
      const file = join(home, '.config/cromite/NativeMessagingHosts/com.leviathan.maki.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).allowed_origins).toEqual([
        `chrome-extension://${CHROME_EXTENSION_ID}/`
      ])
      expect(
        (await removeCustomBrowser('custom:1', { asAdmin: admin(), flatpak: fp })).browsers
      ).toEqual([])
      expect(existsSync(file)).toBe(false)
    })

    it('takes the folder it reads as it is, and a Firefox one gets its own kind of manifest', async () => {
      const dir = join(home, '.waterfox', 'native-messaging-hosts')
      await addCustomBrowser({ name: 'Waterfox', family: 'firefox', dir }, launch, {
        asAdmin: admin(),
        flatpak: fp
      })
      expect(
        JSON.parse(readFileSync(join(dir, 'com.leviathan.maki.json'), 'utf8')).allowed_extensions
      ).toEqual([FIREFOX_EXTENSION_ID])
    })

    it('in a Flatpak’s folder, gets the relay and the shared folder', async () => {
      installFlatpak(fp, 'net.waterfox.waterfox', { persistent: '.waterfox' })
      const dir = join(home, '.var/app/net.waterfox.waterfox/.waterfox')
      await addCustomBrowser({ name: 'Waterfox', family: 'firefox', dir }, launch, {
        asAdmin: admin(),
        flatpak: fp
      })
      const m = JSON.parse(
        readFileSync(join(dir, 'native-messaging-hosts', 'com.leviathan.maki.json'), 'utf8')
      )
      expect(m.path).toBe(relayPath('net.waterfox.waterfox'))
      expect(fp.ran).toEqual([['--filesystem=xdg-run/maki:create', 'net.waterfox.waterfox']])
    })

    it('is refused when the list has it already', async () => {
      await expect(
        addCustomBrowser(
          { name: 'My Thorium', family: 'chromium', dir: join(home, '.config', 'thorium') },
          launch,
          { asAdmin: admin(), flatpak: fp }
        )
      ).rejects.toThrow("that's where Thorium looks, which is on the list already")
    })

    it('needs a name', async () => {
      await expect(
        addCustomBrowser({ name: ' \n', family: 'chromium', dir: join(home, 'x') }, launch, {
          asAdmin: admin(),
          flatpak: fp
        })
      ).rejects.toThrow('give the browser a name')
    })
  })
})

describe.skipIf(process.platform !== 'linux')('the relay in a Flatpak sandbox', () => {
  let run: string
  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'maki-run-'))
  })
  afterEach(() => rmSync(run, { recursive: true, force: true }))

  /** Frames as a browser sends them, and the ones it gets back. */
  const frame = (o: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(o))
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length)
    return Buffer.concat([head, body])
  }
  function frames(buf: Buffer): unknown[] {
    const out: unknown[] = []
    for (let i = 0; i + 4 <= buf.length;) {
      const n = buf.readUInt32LE(i)
      out.push(JSON.parse(buf.subarray(i + 4, i + 4 + n).toString()))
      i += 4 + n
    }
    return out
  }

  /** Run the relay as a browser would, with these messages, until it has answered `answers`. */
  async function relay(messages: unknown[], answers: number): Promise<unknown[]> {
    const fp = fakeFlatpak()
    installFlatpak(fp, 'app.zen_browser.zen', { persistent: '.zen' })
    await registerBrowser('flatpak:app.zen_browser.zen', launch, { asAdmin: admin(), flatpak: fp })
    const child = spawn(relayPath('app.zen_browser.zen'), [], {
      env: { ...process.env, XDG_RUNTIME_DIR: run }
    })
    let out = Buffer.alloc(0)
    return new Promise((resolve, reject) => {
      const done = (): void => {
        child.kill()
        resolve(frames(out))
      }
      child.stdout.on('data', (d: Buffer) => {
        out = Buffer.concat([out, d])
        if (frames(out).length >= answers) done()
      })
      child.on('exit', () => done())
      child.on('error', reject)
      for (const m of messages) child.stdin.write(frame(m))
    })
  }

  it('relays the extension’s requests to maki desktop, and only those', async () => {
    const server = await serveBridge(
      extensionOnly(async (r) => {
        if (r.type !== 'status') throw new Error('unexpected')
        return { type: 'status', linked: true, timeState: 2 }
      }),
      join(run, 'maki', 'browser.sock')
    )
    try {
      const answers = await relay(
        [
          { id: 1, type: 'status' },
          { id: 2, type: 'install', path: '/tmp/x.maki' }
        ],
        2
      )
      expect(answers).toContainEqual({
        id: 1,
        ok: true,
        type: 'status',
        linked: true,
        timeState: 2
      })
      expect(answers).toContainEqual({ id: 2, ok: false, error: 'not for the extension' })
    } finally {
      server.close()
    }
  })

  it('says so when maki desktop is not running', async () => {
    expect(await relay([{ id: 7, type: 'status' }], 1)).toEqual([
      { id: 7, ok: false, error: 'maki desktop is not running' }
    ])
  })
})

describe('browser setup on Windows', () => {
  let restore: () => void
  beforeEach(() => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.LOCALAPPDATA = join(home, 'Local')
    process.env.APPDATA = join(home, 'Roaming')
    restore = () => {
      Object.defineProperty(process, 'platform', platform)
      delete process.env.LOCALAPPDATA
      delete process.env.APPDATA
    }
  })
  afterEach(() => restore())

  /** A registry in memory: key to default value. */
  function registry(): Registry & { keys: Map<string, string> } {
    const keys = new Map<string, string>()
    return {
      keys,
      get: async (k) => keys.get(k) ?? null,
      set: async (k, v) => void keys.set(k, v),
      remove: async (k) => void keys.delete(k)
    }
  }
  const win = { exe: 'C:\\Program Files\\maki 100%\\maki.exe', appPath: null }
  const CHROME_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.leviathan.maki'

  it('names the manifest in Chrome’s registry key, for the maki extension only', async () => {
    mkdirSync(join(home, 'Local', 'Google/Chrome', 'User Data'), { recursive: true })
    const reg = registry()
    expect(await browserStatus({ registry: reg })).toEqual({
      browsers: [
        {
          id: 'chrome',
          name: 'Chrome',
          family: 'chromium',
          kind: 'native',
          registered: false,
          system: false,
          ...plain
        }
      ],
      custom: false
    })
    const { browsers } = await registerBrowser('chrome', win, { asAdmin: admin(), registry: reg })
    expect(row(browsers, 'chrome')?.registered).toBe(true)
    const manifestPath = reg.keys.get(CHROME_KEY)!
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(m).toMatchObject({
      name: 'com.leviathan.maki',
      path: launcherPath(),
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    })
  })

  it('writes a batch file that starts this app as the host', async () => {
    mkdirSync(join(home, 'Local', 'Microsoft/Edge', 'User Data'), { recursive: true })
    await registerBrowser('edge', win, { asAdmin: admin(), registry: registry() })
    expect(launcherPath().endsWith('maki-native-host.cmd')).toBe(true)
    const script = readFileSync(launcherPath(), 'utf8')
    // cmd.exe's line endings; a percent sign doubled so it isn't expanded
    expect(script).toBe(
      '@echo off\r\nrem written by maki desktop: the browser starts this to reach the running app\r\n"C:\\Program Files\\maki 100%%\\maki.exe" --native-host %*\r\n'
    )
  })

  it('gives Firefox its own manifest and key', async () => {
    mkdirSync(join(home, 'Roaming', 'Mozilla', 'Firefox'), { recursive: true })
    const reg = registry()
    await registerBrowser('firefox', win, { asAdmin: admin(), registry: reg })
    const key = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.leviathan.maki'
    const m = JSON.parse(readFileSync(reg.keys.get(key)!, 'utf8'))
    expect(m.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    expect(m.allowed_origins).toBeUndefined()
  })

  it('counts only a key naming its own manifest, and removes the key it set', async () => {
    mkdirSync(join(home, 'Local', 'Google/Chrome', 'User Data'), { recursive: true })
    const reg = registry()
    reg.keys.set(CHROME_KEY, 'C:\\someone-else\\host.json')
    expect(row((await browserStatus({ registry: reg })).browsers, 'chrome')?.registered).toBe(false)
    await registerBrowser('chrome', win, { asAdmin: admin(), registry: reg })
    expect(
      row(
        (await unregisterBrowser('chrome', { asAdmin: admin(), registry: reg })).browsers,
        'chrome'
      )?.registered
    ).toBe(false)
    expect(reg.keys.has(CHROME_KEY)).toBe(false)
  })

  it('has Vivaldi share Chrome’s key, and says so', async () => {
    mkdirSync(join(home, 'Local', 'Google/Chrome', 'User Data'), { recursive: true })
    mkdirSync(join(home, 'Local', 'Vivaldi', 'User Data'), { recursive: true })
    const { browsers } = await browserStatus({ registry: registry() })
    expect(row(browsers, 'vivaldi')?.shares).toEqual(['Chrome'])
  })
})
