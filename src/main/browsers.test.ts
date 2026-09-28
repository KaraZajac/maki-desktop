import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserStatus,
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  launcherPath,
  registerBrowser,
  unregisterBrowser,
  type AsAdmin,
  type Registry
} from './browsers'

const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
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

describe.skipIf(process.platform !== 'linux')('browser setup on Linux', () => {
  it('lists only installed browsers', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    expect(await browserStatus()).toEqual([{ name: 'Chrome', registered: false, system: false }])
  })

  it('points Chrome at the launcher, for the maki extension only', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    const status = await registerBrowser('Chrome', launch, admin())
    expect(status).toEqual([{ name: 'Chrome', registered: true, system: false }])
    const m = JSON.parse(readFileSync(join(home, '.config/google-chrome/NativeMessagingHosts/com.leviathan.maki.json'), 'utf8'))
    expect(m).toMatchObject({ name: 'com.leviathan.maki', type: 'stdio', path: launcherPath(), allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] })
  })

  it('writes a launcher that starts this app headless, whatever its path', async () => {
    mkdirSync(join(home, '.config', 'chromium'), { recursive: true })
    await registerBrowser('Chromium', launch, admin())
    const script = readFileSync(launcherPath(), 'utf8')
    execFileSync('sh', ['-n', launcherPath()]) // parses
    expect(script).toContain(`exec '/opt/it'\\''s maki/maki' --ozone-platform=headless --native-host "$@"`)
  })

  it('uses ~/.mozilla for a Firefox that already keeps its profiles there', async () => {
    mkdirSync(join(home, '.mozilla', 'firefox'), { recursive: true })
    const a = admin()
    expect(await registerBrowser('Firefox', launch, a)).toEqual([{ name: 'Firefox', registered: true, system: false }])
    const m = JSON.parse(readFileSync(join(home, '.mozilla/native-messaging-hosts/com.leviathan.maki.json'), 'utf8'))
    expect(m.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    expect(a.ran).toEqual([])
  })

  it('never creates ~/.mozilla for a Firefox using ~/.config/mozilla: that would hide its profile', async () => {
    mkdirSync(join(home, '.config', 'mozilla', 'firefox'), { recursive: true })
    expect(await browserStatus()).toEqual([{ name: 'Firefox', registered: false, system: true }])
    const a = admin()
    await registerBrowser('Firefox', launch, a)
    expect(existsSync(join(home, '.mozilla'))).toBe(false)
    expect(a.ran).toHaveLength(1)
    const [cmd, ...args] = a.ran[0]
    expect(cmd).toBe('/usr/bin/install')
    expect(args.at(-1)).toMatch(/^\/usr\/lib(64)?\/mozilla\/native-messaging-hosts\/com\.leviathan\.maki\.json$/)
    const staged = JSON.parse(readFileSync(args.at(-2)!, 'utf8'))
    expect(staged).toMatchObject({ path: launcherPath(), allowed_extensions: [FIREFOX_EXTENSION_ID] })
  })

  it('removes what it registered', async () => {
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    await registerBrowser('Chrome', launch, admin())
    expect(await unregisterBrowser('Chrome', admin())).toEqual([{ name: 'Chrome', registered: false, system: false }])
  })

  it('refuses a browser that is not installed', async () => {
    await expect(registerBrowser('Vivaldi', launch, admin())).rejects.toThrow("Vivaldi isn't installed")
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
    expect(await browserStatus(reg)).toEqual([{ name: 'Chrome', registered: false, system: false }])
    expect(await registerBrowser('Chrome', win, admin(), reg)).toEqual([{ name: 'Chrome', registered: true, system: false }])
    const manifestPath = reg.keys.get(CHROME_KEY)!
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(m).toMatchObject({ name: 'com.leviathan.maki', path: launcherPath(), allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] })
  })

  it('writes a batch file that starts this app as the host', async () => {
    mkdirSync(join(home, 'Local', 'Microsoft/Edge', 'User Data'), { recursive: true })
    await registerBrowser('Edge', win, admin(), registry())
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
    await registerBrowser('Firefox', win, admin(), reg)
    const key = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.leviathan.maki'
    const m = JSON.parse(readFileSync(reg.keys.get(key)!, 'utf8'))
    expect(m.allowed_extensions).toEqual([FIREFOX_EXTENSION_ID])
    expect(m.allowed_origins).toBeUndefined()
  })

  it('counts only a key naming its own manifest, and removes the key it set', async () => {
    mkdirSync(join(home, 'Local', 'Google/Chrome', 'User Data'), { recursive: true })
    const reg = registry()
    reg.keys.set(CHROME_KEY, 'C:\\someone-else\\host.json')
    expect(await browserStatus(reg)).toEqual([{ name: 'Chrome', registered: false, system: false }])
    await registerBrowser('Chrome', win, admin(), reg)
    expect(await unregisterBrowser('Chrome', admin(), reg)).toEqual([{ name: 'Chrome', registered: false, system: false }])
    expect(reg.keys.has(CHROME_KEY)).toBe(false)
  })
})
