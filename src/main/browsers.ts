import { app } from 'electron'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Registering the native messaging host with installed browsers, so the maki extension can reach
 * this app. Linux and macOS read a JSON manifest from per-browser folders; Windows uses the
 * registry, which isn't done yet.
 */

export const HOST_NAME = 'com.leviathan.maki'
/** Pinned by the "key" in extension/manifest.json. */
export const CHROME_EXTENSION_ID = 'mjopengkegeglmalfedmanmplofncmdh'
export const FIREFOX_EXTENSION_ID = 'maki@leviathan'

interface Browser {
  name: string
  /** the browser's own config folder: if it's missing, the browser isn't installed */
  config: string
  hosts: string
  firefox?: boolean
}

function browsers(): Browser[] {
  const home = homedir()
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
  const c = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
  const chromium = (name: string, dir: string): Browser => ({ name, config: join(c, dir), hosts: join(c, dir, 'NativeMessagingHosts') })
  return [
    chromium('Chrome', 'google-chrome'),
    chromium('Chromium', 'chromium'),
    chromium('Brave', 'BraveSoftware/Brave-Browser'),
    chromium('Edge', 'microsoft-edge'),
    chromium('Vivaldi', 'vivaldi'),
    { name: 'Firefox', config: join(home, '.mozilla'), hosts: join(home, '.mozilla', 'native-messaging-hosts'), firefox: true }
  ]
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** Browsers wants a manifest pointing at one executable, with no arguments: a small launcher script. */
function launcherPath(): string {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'maki') : join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'maki')
  return join(base, 'maki-native-host')
}

function launcherScript(): string {
  // an AppImage runs from a temporary mount; APPIMAGE is the file the user actually has
  const exe = process.env['APPIMAGE'] ?? process.execPath
  const target = app.isPackaged ? `"${exe}"` : `"${exe}" "${app.getAppPath()}"`
  return `#!/bin/sh\n# written by maki desktop: the browser starts this to reach the running app\nexec ${target} --native-host "$@"\n`
}

export interface BrowserStatus {
  name: string
  registered: boolean
}

export async function browserStatus(): Promise<BrowserStatus[]> {
  const out: BrowserStatus[] = []
  for (const b of browsers()) {
    if (await exists(b.config)) out.push({ name: b.name, registered: await exists(join(b.hosts, `${HOST_NAME}.json`)) })
  }
  return out
}

/** Register with every installed browser. Unsupported on Windows for now. */
export async function registerBrowsers(): Promise<BrowserStatus[]> {
  if (process.platform === 'win32') throw new Error('browser integration on Windows is not built yet')
  const launcher = launcherPath()
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, launcherScript())
  await chmod(launcher, 0o755)
  for (const b of browsers()) {
    if (!(await exists(b.config))) continue
    const manifest = {
      name: HOST_NAME,
      description: 'maki desktop: the link between your browser and maki',
      path: launcher,
      type: 'stdio',
      ...(b.firefox ? { allowed_extensions: [FIREFOX_EXTENSION_ID] } : { allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`] })
    }
    await mkdir(b.hosts, { recursive: true })
    await writeFile(join(b.hosts, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n')
  }
  return browserStatus()
}

export async function unregisterBrowsers(): Promise<BrowserStatus[]> {
  for (const b of browsers()) await rm(join(b.hosts, `${HOST_NAME}.json`), { force: true })
  await rm(launcherPath(), { force: true })
  return browserStatus()
}
