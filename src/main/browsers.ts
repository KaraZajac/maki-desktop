import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserStatus } from '../shared/bridge-types'

/**
 * Registering the native messaging host with installed browsers, so the maki extension can reach
 * this app. Linux and macOS read a JSON manifest from per-browser folders; Windows reads a
 * registry key per browser whose default value is the manifest's path.
 *
 * Firefox on Linux is the awkward one. It reads a user's manifests only from
 * ~/.mozilla/native-messaging-hosts, but since Firefox 147 a new install keeps its profiles in
 * ~/.config/mozilla, and switches back to ~/.mozilla (and so to a fresh, empty profile) as soon
 * as that folder exists. For that layout the manifest goes in the system folder instead, which
 * takes an admin password once; ~/.mozilla is never created here.
 */

export const HOST_NAME = 'com.leviathan.maki'
/** Pinned by the "key" in extension/manifest.chrome.json. */
export const CHROME_EXTENSION_ID = 'mjopengkegeglmalfedmanmplofncmdh'
export const FIREFOX_EXTENSION_ID = 'maki@leviathan'

interface Browser {
  name: string
  /** the browser's own folder: if it's missing, the browser isn't installed */
  config: string
  /** the folder the manifest goes in */
  hosts: string
  firefox?: boolean
  /** a system folder: writing there asks for an admin password */
  system?: boolean
  /** Windows: the HKCU key whose default value names the manifest */
  regKey?: string
}

/** The Windows registry, as much of it as this needs: a key's default value. */
export interface Registry {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/** reg.exe, which every Windows has. */
export const regExe: Registry = {
  get: (key) =>
    new Promise((resolve) =>
      execFile('reg', ['query', key, '/ve'], (e, out) => {
        // "    (Default)    REG_SZ    C:\path\to\manifest.json"
        const m = e ? null : /REG_SZ\s+(.+?)\s*$/m.exec(String(out))
        resolve(m ? m[1] : null)
      })
    ),
  set: (key, value) =>
    new Promise((resolve, reject) =>
      execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], (e) => (e ? reject(e) : resolve()))
    ),
  remove: (key) => new Promise((resolve) => execFile('reg', ['delete', key, '/f'], () => resolve()))
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

async function browsers(): Promise<Browser[]> {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
    const roaming = process.env['APPDATA'] || join(home, 'AppData', 'Roaming')
    // the manifests themselves: one for the Chromium family, one for Firefox
    const hosts = join(roaming, 'maki', 'native-messaging')
    const chromium = (name: string, dir: string, key: string): Browser => ({
      name,
      config: join(local, dir, 'User Data'),
      hosts: join(hosts, 'chromium'),
      regKey: `HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`
    })
    return [
      chromium('Chrome', 'Google/Chrome', 'Google\\Chrome'),
      chromium('Chromium', 'Chromium', 'Chromium'),
      chromium('Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware\\Brave-Browser'),
      chromium('Edge', 'Microsoft/Edge', 'Microsoft\\Edge'),
      // Vivaldi looks where Chrome does
      chromium('Vivaldi', 'Vivaldi', 'Google\\Chrome'),
      {
        name: 'Firefox',
        config: join(roaming, 'Mozilla', 'Firefox'),
        hosts: join(hosts, 'firefox'),
        firefox: true,
        regKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`
      }
    ]
  }
  if (process.platform === 'darwin') {
    const s = join(home, 'Library', 'Application Support')
    const chromium = (name: string, dir: string): Browser => ({ name, config: join(s, dir), hosts: join(s, dir, 'NativeMessagingHosts') })
    return [
      chromium('Chrome', 'Google/Chrome'),
      chromium('Chromium', 'Chromium'),
      chromium('Brave', 'BraveSoftware/Brave-Browser'),
      chromium('Edge', 'Microsoft Edge'),
      chromium('Vivaldi', 'Vivaldi'),
      { name: 'Firefox', config: join(s, 'Firefox'), hosts: join(s, 'Mozilla', 'NativeMessagingHosts'), firefox: true }
    ]
  }
  const c = process.env['XDG_CONFIG_HOME'] || join(home, '.config')
  const chromium = (name: string, dir: string): Browser => ({ name, config: join(c, dir), hosts: join(c, dir, 'NativeMessagingHosts') })
  const legacy = join(home, '.mozilla')
  const firefox: Browser = (await exists(legacy))
    ? { name: 'Firefox', config: legacy, hosts: join(legacy, 'native-messaging-hosts'), firefox: true }
    : {
        name: 'Firefox',
        config: join(c, 'mozilla', 'firefox'),
        // where Firefox looks: /usr/lib64 on distributions that have it (Fedora, openSUSE)
        hosts: join((await exists('/usr/lib64/mozilla')) ? '/usr/lib64/mozilla' : '/usr/lib/mozilla', 'native-messaging-hosts'),
        firefox: true,
        system: true
      }
  return [
    chromium('Chrome', 'google-chrome'),
    chromium('Chromium', 'chromium'),
    chromium('Brave', 'BraveSoftware/Brave-Browser'),
    chromium('Edge', 'microsoft-edge'),
    chromium('Vivaldi', 'vivaldi'),
    firefox
  ]
}

/** How this app is started: the executable, and the app folder when running unpackaged. */
export interface Launch {
  exe: string
  appPath: string | null
}

/** Where the manifests point: a small script, since a browser runs one executable with no arguments. */
export function launcherPath(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'maki', 'maki-native-host.cmd')
  }
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'maki')
      : join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'maki')
  return join(base, 'maki-native-host')
}

function launcherScript({ exe, appPath }: Launch): string {
  if (process.platform === 'win32') {
    // a batch file: browsers on Windows start hosts through cmd.exe. Paths can't hold a
    // double quote there; a percent sign is doubled so cmd doesn't expand it.
    const q = (s: string): string => `"${s.replace(/%/g, '%%')}"`
    const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
    return `@echo off\r\nrem written by maki desktop: the browser starts this to reach the running app\r\n${target} --native-host %*\r\n`
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
  // headless: the host is a stdio relay, and must start without a display
  return `#!/bin/sh\n# written by maki desktop: the browser starts this to reach the running app\nexec ${target} --ozone-platform=headless --native-host "$@"\n`
}

function manifest(b: Browser): string {
  return (
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'maki desktop: the link between your browser and maki',
        path: launcherPath(),
        type: 'stdio',
        ...(b.firefox ? { allowed_extensions: [FIREFOX_EXTENSION_ID] } : { allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] })
      },
      null,
      2
    ) + '\n'
  )
}

/** Runs a command as root, asking for the admin password (pkexec); rejects if refused. */
export type AsAdmin = (command: string[]) => Promise<void>

export const pkexec: AsAdmin = (command) =>
  new Promise((resolve, reject) =>
    execFile('pkexec', command, (e) => (e ? reject(new Error(e.code === 126 ? 'admin approval was refused' : e.message)) : resolve()))
  )

const hostFile = (b: Browser): string => join(b.hosts, `${HOST_NAME}.json`)

async function registered(b: Browser, registry: Registry): Promise<boolean> {
  // on Windows, the browser finds the manifest through its key: it must name ours
  if (b.regKey && (await registry.get(b.regKey)) !== hostFile(b)) return false
  // a system-wide manifest may be another user's: only one pointing at our launcher counts
  const text = await readFile(hostFile(b), 'utf8').catch(() => null)
  if (text === null) return false
  try {
    return (JSON.parse(text) as { path?: unknown }).path === launcherPath()
  } catch {
    return false
  }
}

export async function browserStatus(registry: Registry = regExe): Promise<BrowserStatus[]> {
  const out: BrowserStatus[] = []
  for (const b of await browsers()) {
    if (await exists(b.config)) out.push({ name: b.name, registered: await registered(b, registry), system: !!b.system })
  }
  return out
}

/** Register with one installed browser, by name. */
export async function registerBrowser(
  name: string,
  launch: Launch,
  asAdmin: AsAdmin = pkexec,
  registry: Registry = regExe
): Promise<BrowserStatus[]> {
  const b = (await browsers()).find((x) => x.name === name)
  if (!b || !(await exists(b.config))) throw new Error(`${name} isn't installed`)
  const launcher = launcherPath()
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, launcherScript(launch))
  await chmod(launcher, 0o755)
  if (b.system) {
    const staged = join(dirname(launcher), `${HOST_NAME}.${b.name.toLowerCase()}.json`)
    await writeFile(staged, manifest(b))
    await asAdmin(['/usr/bin/install', '-D', '-m', '0644', staged, hostFile(b)])
  } else {
    await mkdir(b.hosts, { recursive: true })
    await writeFile(hostFile(b), manifest(b))
  }
  if (b.regKey) await registry.set(b.regKey, hostFile(b))
  return browserStatus(registry)
}

export async function unregisterBrowser(name: string, asAdmin: AsAdmin = pkexec, registry: Registry = regExe): Promise<BrowserStatus[]> {
  const b = (await browsers()).find((x) => x.name === name)
  if (b && (await registered(b, registry))) {
    if (b.regKey) {
      // the key only: the manifest file may serve the browser's siblings (Vivaldi shares Chrome's)
      await registry.remove(b.regKey)
    } else if (b.system) await asAdmin(['/usr/bin/rm', '-f', hostFile(b)])
    else await rm(hostFile(b), { force: true })
  }
  return browserStatus(registry)
}
