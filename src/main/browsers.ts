import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { BrowserFamily, BrowserStatus, BrowsersView } from '../shared/bridge-types'
import { BROWSER_SOCKET } from './bridge'

/**
 * Registering the native messaging host with installed browsers, so the maki extension can reach
 * this app. Linux and macOS read a JSON manifest from per-browser folders; Windows reads a
 * registry key per browser whose default value is the manifest's path.
 *
 * Firefox on Linux is the awkward one, with the browsers made from it (Zen, Floorp; LibreWolf
 * once its profiles are in ~/.config). It reads a user's manifests only from
 * ~/.mozilla/native-messaging-hosts (Mozilla's bug 2005167), but since Firefox 147 a new install
 * keeps its profiles in ~/.config/mozilla, and switches back to ~/.mozilla (and so to a fresh,
 * empty profile) as soon as that folder exists. For that layout the manifest goes in the system
 * folder instead, which takes an admin password once; ~/.mozilla is never created here.
 *
 * A browser installed as a Flatpak runs in a sandbox that sees neither those folders nor this
 * app, and can't start anything outside it. For one of those, the manifest goes where the browser
 * looks inside its sandbox and names a small relay, written into the app's own folder (Python,
 * which the Flatpak runtimes have). The relay reaches this app through one folder,
 * $XDG_RUNTIME_DIR/maki, which a user override shares with that browser alone, where this app
 * answers the extension's requests and nothing else (bridge.ts, BROWSER_SOCKET).
 */

export const HOST_NAME = 'com.leviathan.maki'
/** Pinned by the "key" in extension/manifest.chrome.json. */
export const CHROME_EXTENSION_ID = 'mjopengkegeglmalfedmanmplofncmdh'
export const FIREFOX_EXTENSION_ID = 'maki@leviathan'

interface Target {
  /** the folder the manifest goes in */
  dir: string
  /** a system folder: writing there asks for an admin password */
  system?: boolean
}

interface Browser {
  id: string
  name: string
  family: BrowserFamily
  kind: BrowserStatus['kind']
  /** it's installed if any of these exists (one added by hand always is) */
  detect: string[]
  /** where the manifest goes: in each, for the browser finds the first */
  targets: Target[]
  /** the Flatpak it runs in: its app ID */
  sandbox?: string
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
      execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], (e) =>
        e ? reject(e) : resolve()
      )
    ),
  remove: (key) => new Promise((resolve) => execFile('reg', ['delete', key, '/f'], () => resolve()))
}

/** Runs a command as root, asking for the admin password (pkexec); rejects if refused. */
export type AsAdmin = (command: string[]) => Promise<void>

export const pkexec: AsAdmin = (command) =>
  new Promise((resolve, reject) =>
    execFile('pkexec', command, (e) =>
      e ? reject(new Error(e.code === 126 ? 'admin approval was refused' : e.message)) : resolve()
    )
  )

/** Flatpak, as much of it as this needs. */
export interface Flatpak {
  /** its installations: the system's, then this user's */
  installations: string[]
  /** where the running sandboxes describe themselves: each one's permissions, as it started */
  instances: string
  /** where the computer's processes are listed: /proc */
  proc: string
  /** this user's overrides, a file per app */
  overrides: string
  /** `flatpak override --user ARGS…` */
  override: (args: string[]) => Promise<void>
}

const dataHome = (): string => process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
const configHome = (): string => process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')

export function flatpak(): Flatpak {
  const run = process.env['XDG_RUNTIME_DIR'] || `/run/user/${process.getuid?.() ?? 0}`
  return {
    installations: ['/var/lib/flatpak', join(dataHome(), 'flatpak')],
    instances: join(run, '.flatpak'),
    proc: '/proc',
    overrides: join(dataHome(), 'flatpak', 'overrides'),
    override: (args) =>
      new Promise((resolve, reject) =>
        execFile('flatpak', ['override', '--user', ...args], (e, _out, err) =>
          e ? reject(new Error(String(err).trim() || e.message)) : resolve()
        )
      )
  }
}

/** What reaches outside this app, replaced in tests. */
export interface Env {
  asAdmin: AsAdmin
  registry: Registry
  flatpak: Flatpak
  /** how this app is started: given, a browser counts as connected only if the launcher starts it */
  launch?: Launch
}

const env = (given: Partial<Env>): Env => ({
  asAdmin: pkexec,
  registry: regExe,
  flatpak: flatpak(),
  ...given
})

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

/** Browsers installed as Flatpaks: the app, and where it reads manifests, under its own folder. */
const FLATPAKS: [app: string, name: string, family: BrowserFamily, folders: string[]][] = [
  ['com.google.Chrome', 'Chrome', 'chromium', ['config/google-chrome/NativeMessagingHosts']],
  [
    'com.google.ChromeDev',
    'Chrome Dev',
    'chromium',
    ['config/google-chrome-unstable/NativeMessagingHosts']
  ],
  ['org.chromium.Chromium', 'Chromium', 'chromium', ['config/chromium/NativeMessagingHosts']],
  [
    'io.github.ungoogled_software.ungoogled_chromium',
    'Ungoogled Chromium',
    'chromium',
    ['config/chromium/NativeMessagingHosts']
  ],
  [
    'com.brave.Browser',
    'Brave',
    'chromium',
    ['config/BraveSoftware/Brave-Browser/NativeMessagingHosts']
  ],
  ['com.microsoft.Edge', 'Edge', 'chromium', ['config/microsoft-edge/NativeMessagingHosts']],
  ['com.vivaldi.Vivaldi', 'Vivaldi', 'chromium', ['config/vivaldi/NativeMessagingHosts']],
  ['com.opera.Opera', 'Opera', 'chromium', ['config/opera/NativeMessagingHosts']],
  // in its sandbox, each reads ~/.mozilla/native-messaging-hosts, as Firefox does
  ['org.mozilla.firefox', 'Firefox', 'firefox', ['.mozilla/native-messaging-hosts']],
  ['app.zen_browser.zen', 'Zen', 'firefox', ['.mozilla/native-messaging-hosts']],
  ['one.ablaze.floorp', 'Floorp', 'firefox', ['.mozilla/native-messaging-hosts']],
  // its own folder while its profiles are there, Firefox's once they're in ~/.config
  [
    'io.gitlab.librewolf-community',
    'LibreWolf',
    'firefox',
    ['.librewolf/native-messaging-hosts', '.mozilla/native-messaging-hosts']
  ]
]

/** A browser added by hand: the folder it reads manifests from. */
interface Custom {
  id: string
  name: string
  family: BrowserFamily
  dir: string
}

const customsFile = (): string => join(dirname(launcherPath()), 'browsers.json')

async function customs(): Promise<Custom[]> {
  const text = await readFile(customsFile(), 'utf8').catch(() => null)
  if (text === null) return []
  try {
    const list: unknown = JSON.parse(text)
    return Array.isArray(list)
      ? list.filter(
          (c): c is Custom =>
            typeof c?.id === 'string' &&
            typeof c.name === 'string' &&
            (c.family === 'chromium' || c.family === 'firefox') &&
            typeof c.dir === 'string' &&
            isAbsolute(c.dir)
        )
      : []
  } catch {
    return []
  }
}

async function saveCustoms(list: Custom[]): Promise<void> {
  await mkdir(dirname(customsFile()), { recursive: true })
  await writeFile(customsFile(), JSON.stringify(list, null, 2) + '\n')
}

/** The Flatpak a folder belongs to, if it's inside one's own folder (~/.var/app/ID/…). */
function sandboxOf(dir: string): string | null {
  const r = relative(join(homedir(), '.var', 'app'), dir)
  if (!r || r.startsWith('..') || isAbsolute(r)) return null
  const app = r.split(sep)[0]
  return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/.test(app) ? app : null
}

async function browsers(fp: Flatpak): Promise<Browser[]> {
  const home = homedir()
  const added = (await customs()).map((c): Browser => {
    const app = sandboxOf(c.dir)
    return {
      id: c.id,
      name: c.name,
      family: c.family,
      kind: 'custom',
      detect: [],
      targets: [{ dir: c.dir }],
      ...(app ? { sandbox: app } : {})
    }
  })
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
    const roaming = process.env['APPDATA'] || join(home, 'AppData', 'Roaming')
    // the manifests themselves: one for the Chromium family, one for Firefox
    const hosts = join(roaming, 'maki', 'native-messaging')
    const chromium = (id: string, name: string, dir: string, key: string): Browser => ({
      id,
      name,
      family: 'chromium',
      kind: 'native',
      detect: [join(local, dir, 'User Data')],
      targets: [{ dir: join(hosts, 'chromium') }],
      regKey: `HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`
    })
    return [
      chromium('chrome', 'Chrome', 'Google/Chrome', 'Google\\Chrome'),
      chromium('chromium', 'Chromium', 'Chromium', 'Chromium'),
      chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware\\Brave-Browser'),
      chromium('edge', 'Edge', 'Microsoft/Edge', 'Microsoft\\Edge'),
      // Vivaldi looks where Chrome does
      chromium('vivaldi', 'Vivaldi', 'Vivaldi', 'Google\\Chrome'),
      {
        id: 'firefox',
        name: 'Firefox',
        family: 'firefox',
        kind: 'native',
        detect: [join(roaming, 'Mozilla', 'Firefox')],
        targets: [{ dir: join(hosts, 'firefox') }],
        regKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`
      }
    ]
  }
  if (process.platform === 'darwin') {
    const s = join(home, 'Library', 'Application Support')
    const chromium = (id: string, name: string, dir: string): Browser => ({
      id,
      name,
      family: 'chromium',
      kind: 'native',
      detect: [join(s, dir)],
      targets: [{ dir: join(s, dir, 'NativeMessagingHosts') }]
    })
    const mozilla = { dir: join(s, 'Mozilla', 'NativeMessagingHosts') }
    return [
      chromium('chrome', 'Chrome', 'Google/Chrome'),
      chromium('chromium', 'Chromium', 'Chromium'),
      chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser'),
      chromium('edge', 'Edge', 'Microsoft Edge'),
      chromium('vivaldi', 'Vivaldi', 'Vivaldi'),
      {
        id: 'firefox',
        name: 'Firefox',
        family: 'firefox',
        kind: 'native',
        detect: [join(s, 'Firefox')],
        targets: [mozilla]
      },
      {
        id: 'zen',
        name: 'Zen',
        family: 'firefox',
        kind: 'native',
        detect: [join(s, 'zen')],
        targets: [mozilla]
      },
      ...added
    ]
  }
  const c = configHome()
  const chromium = (id: string, name: string, dir: string): Browser => ({
    id,
    name,
    family: 'chromium',
    kind: 'native',
    detect: [join(c, dir)],
    targets: [{ dir: join(c, dir, 'NativeMessagingHosts') }]
  })
  // Firefox's folder, which the browsers made from it read too: see above
  const legacy = join(home, '.mozilla')
  const mozilla: Target = (await exists(legacy))
    ? { dir: join(legacy, 'native-messaging-hosts') }
    : {
        // where Firefox looks: /usr/lib64 on distributions that have it (Fedora, openSUSE)
        dir: join(
          (await exists('/usr/lib64/mozilla')) ? '/usr/lib64/mozilla' : '/usr/lib/mozilla',
          'native-messaging-hosts'
        ),
        system: true
      }
  const firefox = (
    id: string,
    name: string,
    dirs: string[],
    targets: Target[] = [mozilla]
  ): Browser => ({
    id,
    name,
    family: 'firefox',
    kind: 'native',
    detect: dirs,
    targets
  })
  const librewolf = join(home, '.librewolf')
  const flatpaks = FLATPAKS.map(([app, name, family, folders]): Browser => ({
    id: `flatpak:${app}`,
    name,
    family,
    kind: 'flatpak',
    detect: fp.installations.map((i) => join(i, 'app', app)),
    targets: folders.map((f) => ({ dir: join(home, '.var', 'app', app, ...f.split('/')) })),
    sandbox: app
  }))
  return [
    chromium('chrome', 'Chrome', 'google-chrome'),
    chromium('chrome-beta', 'Chrome Beta', 'google-chrome-beta'),
    chromium('chrome-dev', 'Chrome Dev', 'google-chrome-unstable'),
    chromium('chromium', 'Chromium', 'chromium'),
    chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser'),
    chromium('brave-beta', 'Brave Beta', 'BraveSoftware/Brave-Browser-Beta'),
    chromium('brave-nightly', 'Brave Nightly', 'BraveSoftware/Brave-Browser-Nightly'),
    chromium('edge', 'Edge', 'microsoft-edge'),
    chromium('edge-beta', 'Edge Beta', 'microsoft-edge-beta'),
    chromium('edge-dev', 'Edge Dev', 'microsoft-edge-dev'),
    chromium('vivaldi', 'Vivaldi', 'vivaldi'),
    chromium('vivaldi-snapshot', 'Vivaldi Snapshot', 'vivaldi-snapshot'),
    chromium('opera', 'Opera', 'opera'),
    chromium('thorium', 'Thorium', 'thorium'),
    firefox('firefox', 'Firefox', [join(legacy, 'firefox'), join(c, 'mozilla', 'firefox')]),
    firefox('zen', 'Zen', [join(home, '.zen'), join(c, 'zen')]),
    firefox('floorp', 'Floorp', [join(home, '.floorp'), join(c, 'floorp')]),
    firefox(
      'librewolf',
      'LibreWolf',
      [librewolf, join(c, 'librewolf')],
      // its own folder while its profiles are there; once they're in ~/.config, Firefox's, or
      // its own system folder while there's no ~/.mozilla
      (await exists(librewolf))
        ? [{ dir: join(librewolf, 'native-messaging-hosts') }]
        : mozilla.system
          ? [{ dir: '/usr/lib/librewolf/native-messaging-hosts', system: true }]
          : [mozilla]
    ),
    ...flatpaks,
    ...added
  ]
}

async function installed(b: Browser): Promise<boolean> {
  if (b.kind === 'custom') return true
  for (const d of b.detect) if (await exists(d)) return true
  return false
}

/** How this app is started: the executable, and the app folder when running unpackaged. */
export interface Launch {
  exe: string
  appPath: string | null
}

/** Where the manifests point: a small script, since a browser runs one executable with no arguments. */
export function launcherPath(): string {
  if (process.platform === 'win32') {
    return join(
      process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'),
      'maki',
      'maki-native-host.cmd'
    )
  }
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'maki')
      : join(dataHome(), 'maki')
  return join(base, 'maki-native-host')
}

/** A sandboxed browser's relay: in the app's own folder, which the sandbox sees at the same path. */
export function relayPath(app: string): string {
  return join(homedir(), '.var', 'app', app, 'maki', 'maki-native-host')
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

/**
 * At start: the browsers' launcher, if it starts another file (an AppImage an update replaced,
 * or one since moved), is written again for this one. Only if maki desktop wrote it.
 */
export async function refreshLauncher(launch: Launch): Promise<void> {
  const path = launcherPath()
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null || text === launcherScript(launch) || !text.includes('written by maki desktop'))
    return
  await writeFile(path, launcherScript(launch))
  await chmod(path, 0o755)
}

/**
 * The relay a sandboxed browser starts: what native-host.ts does, but it can't start this app
 * from in there, so it tells the extension when the app isn't running. Browser side: stdio, each
 * message a 4-byte little-endian length then UTF-8 JSON; this app's side: a JSON object a line.
 */
export function relayScript(name: string): string {
  return `#!/usr/bin/env python3
# Written by maki desktop. ${name.replace(/[^\x20-\x7e]/g, '?')} starts this in its Flatpak sandbox when the maki
# extension connects, and it relays to maki desktop through the one folder maki desktop shares
# with the sandbox. It can't start maki desktop from in here: maki desktop has to be running.
import json, os, socket, struct, sys, threading, time

PATH = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid(), ${BROWSER_SOCKET.map((p) => JSON.stringify(p)).join(', ')})
MAX = 64 * 1024  # nothing the extension sends is longer
out, lock, pending, queued, app = sys.stdout.buffer, threading.Lock(), set(), [], [None]


def to_browser(body):
    with lock:
        out.write(struct.pack("<I", len(body)) + body)
        out.flush()


def fail_all(error):
    for i in sorted(pending):
        to_browser(json.dumps({"id": i, "ok": False, "error": error}).encode())
    pending.clear()


def id_of(text):
    try:
        i = json.loads(text).get("id")
    except (ValueError, AttributeError):
        return None
    return i if type(i) is int else None


def from_browser():
    read = sys.stdin.buffer.read
    while True:
        head = read(4)
        if len(head) < 4:
            break
        (n,) = struct.unpack("<I", head)
        body = read(n) if n <= MAX else b""
        if len(body) < n or n > MAX:
            break
        i = id_of(body)
        if i is not None:
            pending.add(i)
        line = body.replace(b"\\n", b" ") + b"\\n"
        with lock:
            if app[0] is None:
                queued.append(line)
                continue
        app[0].sendall(line)
    os._exit(0)  # the browser closed the port


threading.Thread(target=from_browser, daemon=True).start()
conn = None
for _ in range(8):  # two seconds, for a maki desktop that's just starting
    try:
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(PATH)
        break
    except OSError:
        conn.close()
        conn = None
        time.sleep(0.25)
if conn is None:
    time.sleep(0.1)  # what the browser sent with connecting
    fail_all("maki desktop is not running")
    os._exit(0)
with lock:
    app[0] = conn
    for line in queued:
        conn.sendall(line)
    queued.clear()
for raw in conn.makefile("rb"):
    line = raw.rstrip(b"\\n")
    i = id_of(line)
    if i is None:
        continue
    pending.discard(i)
    to_browser(line)
fail_all("maki desktop went away")
os._exit(0)
`
}

function manifest(b: Browser): string {
  return (
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'maki desktop: the link between your browser and maki',
        path: b.sandbox ? relayPath(b.sandbox) : launcherPath(),
        type: 'stdio',
        ...(b.family === 'firefox'
          ? { allowed_extensions: [FIREFOX_EXTENSION_ID] }
          : { allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] })
      },
      null,
      2
    ) + '\n'
  )
}

const hostFile = (t: Target): string => join(t.dir, `${HOST_NAME}.json`)

/** A manifest there that points where this browser's should: one in a system folder may be another user's. */
async function ours(t: Target, b: Browser): Promise<boolean> {
  const text = await readFile(hostFile(t), 'utf8').catch(() => null)
  if (text === null) return false
  try {
    return (
      (JSON.parse(text) as { path?: unknown }).path ===
      (b.sandbox ? relayPath(b.sandbox) : launcherPath())
    )
  } catch {
    return false
  }
}

// ── the Flatpak sandbox ──────────────────────────────────────────────────────────────────────

type Keyfile = Map<string, Map<string, string>>

/** A GLib key file, as Flatpak writes metadata, overrides and instance info. */
function keyfile(text: string): Keyfile {
  const out: Keyfile = new Map()
  let section = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) out.set(head[1], (section = out.get(head[1]) ?? new Map()))
    else if (line && !line.startsWith('#') && line.includes('=')) {
      section.set(line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim())
    }
  }
  return out
}

const readKeyfile = (path: string): Promise<Keyfile | null> =>
  readFile(path, 'utf8').then(keyfile, () => null)

const entries = (k: Keyfile | null, key: string): string[] =>
  (k?.get('Context')?.get(key) ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

/** The folder this app shares with a sandboxed browser: xdg-run/maki. */
const SHARED = `xdg-run/${BROWSER_SOCKET[0]}`

const shares = (filesystems: string[]): boolean =>
  filesystems.some((f) => f === SHARED || f.startsWith(`${SHARED}:`))

async function appMetadata(fp: Flatpak, app: string): Promise<Keyfile | null> {
  for (const i of fp.installations) {
    const k = await readKeyfile(join(i, 'app', app, 'current', 'active', 'metadata'))
    if (k) return k
  }
  return null
}

/**
 * The folders the sandbox must keep in its home for the browser to find its manifest: a
 * manifest in ~/.var/app/ID/.mozilla is at ~/.mozilla inside only if the app keeps (persists)
 * .mozilla; config/ is its XDG_CONFIG_HOME either way.
 */
async function persistsNeeded(fp: Flatpak, b: Browser): Promise<string[]> {
  const root = join(homedir(), '.var', 'app', b.sandbox!)
  const kept = new Set(entries(await appMetadata(fp, b.sandbox!), 'persistent'))
  const need = new Set<string>()
  for (const t of b.targets) {
    const first = relative(root, t.dir).split(sep)[0]
    if (first.startsWith('.') && first !== '..' && !kept.has(first)) need.add(first)
  }
  return [...need]
}

/** Whether a context (an override, or a running sandbox's) gives the browser what it needs. */
function grants(k: Keyfile | null, persists: string[]): boolean {
  const kept = new Set(entries(k, 'persistent'))
  return shares(entries(k, 'filesystems')) && persists.every((p) => kept.has(p))
}

/**
 * Whether the browser itself runs in a sandbox, not only something it left behind: Flatpak keeps
 * a sandbox while any process in it lives, and a helper can outlive the browser (about:debugging
 * starts adb, which stays). The browser is a program of the app's own, under /app.
 */
async function browserIn(fp: Flatpak, instance: string): Promise<boolean> {
  let ns: string
  try {
    const info = JSON.parse(await readFile(join(fp.instances, instance, 'bwrapinfo.json'), 'utf8'))
    if (typeof info['pid-namespace'] !== 'number') return true
    ns = `pid:[${info['pid-namespace']}]`
  } catch {
    return true // nothing says what runs there: take it for the browser
  }
  for (const pid of await readdir(fp.proc).catch(() => [] as string[])) {
    if (
      !/^\d+$/.test(pid) ||
      (await readlink(join(fp.proc, pid, 'ns', 'pid')).catch(() => '')) !== ns
    )
      continue
    const exe = await readlink(join(fp.proc, pid, 'exe')).catch(() => '')
    if (exe.startsWith('/app/')) return true
  }
  return false
}

/** A sandbox of this browser that started before it had what it needs: it takes it once restarted. */
async function runningWithout(fp: Flatpak, b: Browser): Promise<boolean> {
  const persists = await persistsNeeded(fp, b)
  for (const n of await readdir(fp.instances).catch(() => [] as string[])) {
    const k = await readKeyfile(join(fp.instances, n, 'info'))
    if (k?.get('Application')?.get('name') !== b.sandbox || grants(k, persists)) continue
    if (await browserIn(fp, n)) return true
  }
  return false
}

/** The relay is Python: refuse a browser whose runtime hasn't it, rather than connect it to nothing. */
async function checkPython(fp: Flatpak, b: Browser): Promise<void> {
  const runtime = (await appMetadata(fp, b.sandbox!))?.get('Application')?.get('runtime')
  if (!runtime) return // one added by hand, from a Flatpak this can't read: the relay will say
  for (const i of fp.installations) {
    const files = join(i, 'runtime', runtime, 'active', 'files')
    if (await exists(files)) {
      if (await exists(join(files, 'bin', 'python3'))) return
      throw new Error(
        `${b.name}'s Flatpak runtime (${runtime}) has no Python, which maki's relay needs in its sandbox`
      )
    }
  }
}

// ── connecting and disconnecting ─────────────────────────────────────────────────────────────

async function registered(b: Browser, e: Env): Promise<boolean> {
  // on Windows, the browser finds the manifest through its key: it must name ours
  if (b.regKey && (await e.registry.get(b.regKey)) !== hostFile(b.targets[0])) return false
  for (const t of b.targets) if (!(await ours(t, b))) return false
  // the launcher must start this app: one naming an AppImage an update replaced starts nothing
  if (!b.sandbox && e.launch) {
    const text = await readFile(launcherPath(), 'utf8').catch(() => null)
    if (text !== launcherScript(e.launch)) return false
  }
  if (b.sandbox) {
    if (!(await exists(relayPath(b.sandbox)))) return false
    return grants(
      await readKeyfile(join(e.flatpak.overrides, b.sandbox)),
      await persistsNeeded(e.flatpak, b)
    )
  }
  return true
}

/** What a browser's registration is, to tell which browsers share one. */
const registration = (b: Browser): string[] => (b.regKey ? [b.regKey] : b.targets.map(hostFile))

export async function browserStatus(given: Partial<Env> = {}): Promise<BrowsersView> {
  const e = env(given)
  const present: Browser[] = []
  for (const b of await browsers(e.flatpak)) if (await installed(b)) present.push(b)
  const out: BrowserStatus[] = []
  for (const b of present) {
    const mine = new Set(registration(b))
    const isRegistered = await registered(b, e)
    out.push({
      id: b.id,
      name: b.name,
      family: b.family,
      kind: b.kind,
      registered: isRegistered,
      system: b.targets.some((t) => t.system),
      shares: present
        .filter((o) => o !== b && registration(o).some((r) => mine.has(r)))
        .map((o) => o.name),
      restart: isRegistered && !!b.sandbox && (await runningWithout(e.flatpak, b))
    })
  }
  return { browsers: out, custom: process.platform !== 'win32' }
}

/** Connect one installed browser, by its ID. */
export async function registerBrowser(
  id: string,
  launch: Launch,
  given: Partial<Env> = {}
): Promise<BrowsersView> {
  const e = env(given)
  const b = (await browsers(e.flatpak)).find((x) => x.id === id)
  if (!b || !(await installed(b))) throw new Error(`${b?.name ?? id} isn't installed`)
  if (b.sandbox) {
    await checkPython(e.flatpak, b)
    const relay = relayPath(b.sandbox)
    await mkdir(dirname(relay), { recursive: true })
    await writeFile(relay, relayScript(b.name))
    await chmod(relay, 0o755)
  } else {
    const launcher = launcherPath()
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(launcher, launcherScript(launch))
    await chmod(launcher, 0o755)
  }
  for (const t of b.targets) {
    if (t.system) {
      if (await ours(t, b)) continue // another browser that reads it connected already
      const staged = join(
        dirname(launcherPath()),
        `${HOST_NAME}.${b.id.replace(/[^A-Za-z0-9.-]/g, '-')}.json`
      )
      await mkdir(dirname(staged), { recursive: true })
      await writeFile(staged, manifest(b))
      await e.asAdmin(['/usr/bin/install', '-D', '-m', '0644', staged, hostFile(t)])
    } else {
      await mkdir(t.dir, { recursive: true })
      await writeFile(hostFile(t), manifest(b))
    }
  }
  if (b.regKey) await e.registry.set(b.regKey, hostFile(b.targets[0]))
  if (b.sandbox) {
    const persists = await persistsNeeded(e.flatpak, b)
    await e.flatpak.override([
      `--filesystem=${SHARED}:create`,
      ...persists.map((p) => `--persist=${p}`),
      b.sandbox
    ])
  }
  return browserStatus(given)
}

export async function unregisterBrowser(
  id: string,
  given: Partial<Env> = {}
): Promise<BrowsersView> {
  const e = env(given)
  const b = (await browsers(e.flatpak)).find((x) => x.id === id)
  if (b?.regKey) {
    // the key only: the manifest file may serve the browser's siblings (Vivaldi shares Chrome's)
    if ((await e.registry.get(b.regKey)) === hostFile(b.targets[0]))
      await e.registry.remove(b.regKey)
  } else if (b) {
    for (const t of b.targets) {
      if (!(await ours(t, b))) continue
      if (t.system) await e.asAdmin(['/usr/bin/rm', '-f', hostFile(t)])
      else await rm(hostFile(t), { force: true })
    }
  }
  if (b?.sandbox) {
    await rm(dirname(relayPath(b.sandbox)), { recursive: true, force: true })
    // the folder this app shared, taken back; a kept ~/.mozilla stays, empty and harmless
    await e.flatpak.override([`--nofilesystem=${SHARED}`, b.sandbox]).catch(() => undefined)
  }
  return browserStatus(given)
}

/**
 * Add a browser the list doesn't know, by the folder it reads helpers from (or its own folder,
 * which the usual name is added to), and connect it. One in a Flatpak's folder gets the relay.
 */
export async function addCustomBrowser(
  input: { name: string; family: BrowserFamily; dir: string },
  launch: Launch,
  given: Partial<Env> = {}
): Promise<BrowsersView> {
  if (process.platform === 'win32')
    throw new Error(
      'on Windows, browsers find maki desktop through the registry: only the listed ones'
    )
  const name = input.name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)
  if (!name) throw new Error('give the browser a name')
  if (input.family !== 'chromium' && input.family !== 'firefox')
    throw new Error('say which extension it takes')
  if (!isAbsolute(input.dir)) throw new Error('choose the browser’s folder')
  const leaves = ['NativeMessagingHosts', 'native-messaging-hosts']
  const leaf =
    input.family === 'firefox' && process.platform === 'linux'
      ? 'native-messaging-hosts'
      : 'NativeMessagingHosts'
  const dir = leaves.includes(basename(input.dir)) ? input.dir : join(input.dir, leaf)
  const known = (await browsers(env(given).flatpak)).find((b) =>
    b.targets.some((t) => t.dir === dir)
  )
  if (known)
    throw new Error(
      `that's where ${known.name} looks, which is on the list already: connect it there`
    )
  const list = await customs()
  const next = list.reduce((n, c) => Math.max(n, Number(c.id.split(':')[1]) || 0), 0) + 1
  const added: Custom = { id: `custom:${next}`, name, family: input.family, dir }
  await saveCustoms([...list, added])
  try {
    return await registerBrowser(added.id, launch, given)
  } catch (err) {
    await saveCustoms(list)
    throw err
  }
}

/** Disconnect one added by hand, and forget it. */
export async function removeCustomBrowser(
  id: string,
  given: Partial<Env> = {}
): Promise<BrowsersView> {
  if (!id.startsWith('custom:')) throw new Error('only a browser added by hand can be removed')
  await unregisterBrowser(id, given)
  await saveCustoms((await customs()).filter((c) => c.id !== id))
  return browserStatus(given)
}
