import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray
} from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, writeSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  fromBase64,
  toBase64,
  type BridgeRequest,
  type BridgeResult,
  type BrowserFamily
} from '../shared/bridge-types'
import { NETWORKS, type EthState } from '../shared/ethereum'
import { SOL_NETWORKS, type SolState } from '../shared/solana'
import { polite } from '../shared/polite'
import { CURRENCIES, pricesUrl, readPrices, type Currency, type Prices } from '../shared/prices'
import { backupInfo, latestBackup, saveBackup, showBackups } from './backups'
import {
  addCustomBrowser,
  browserStatus,
  pkexec,
  registerBrowser,
  removeCustomBrowser,
  unregisterBrowser,
  type Launch
} from './browsers'
import { sudoOff, sudoOn, sudoStatus } from './sudo'
import { browserSocketPath, extensionOnly, forWindow, serveBridge, socketPath } from './bridge'
import { getStartAtLogin, refreshStartAtLogin, setStartAtLogin } from './login'
import { agePluginStatus, askOver, installAgePlugin, runAgePlugin } from './age-plugin'
import { MINISIGN_COMMAND, runMinisign } from './minisign'
import { runSshKeygen, SSH_KEYGEN_COMMAND, sshKeygenOnPath } from './ssh-keygen'
import { GPG_COMMAND, gpgOnPath, runGpg } from './gpg'
import { OPENPGP_APP } from '../shared/openpgp'
import { installScript, scriptStatus } from './scripts'
import { MINISIGN_APP, parsePublicKey } from '../shared/minisign'
import { launchTrayApp, runNativeHost } from './native-host'
import { relay } from './roughtime'
import { agentSocketPath, serveAgent, SSH_APP } from './ssh-agent'
import { onGithub, storeName, storeSource, storeToken, storeWhere } from './store-source'

/**
 * maki's desktop app lives in the tray: the window can close, the link stays. The renderer owns
 * the link (Web Serial is a renderer API), so the window is hidden rather than destroyed.
 */

interface LinkReport {
  linked: boolean
  via: string | null
  timeState: number | null
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let devSocket: Socket | null = null
let link: LinkReport = { linked: false, via: null, timeState: null }

const startHidden = process.argv.includes('--hidden')
// MAKI_OFFSCREEN=1 renders without ever showing a window: scripts/screenshot.cjs, UI tests
const offscreen = process.env['MAKI_OFFSCREEN'] === '1'
// screenshots and UI tests keep their settings and backups out of the real app data, and leave
// nothing behind (MAKI_OFFSCREEN_KEEP=1 keeps them, to look at)
if (offscreen) {
  const scratch = join(tmpdir(), `maki-offscreen-${process.pid}`)
  app.setPath('userData', scratch)
  // Chromium writes the last of it as it shuts down, after this process's own exit handlers: a
  // watcher sweeps it up once the process is gone, crashed or not
  if (process.env['MAKI_OFFSCREEN_KEEP'] !== '1' && process.platform !== 'win32') {
    spawn(
      'sh',
      ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done; rm -rf "$0"`, scratch],
      {
        detached: true,
        stdio: 'ignore'
      }
    ).unref()
  }
}

const resource = (name: string): string => join(app.getAppPath(), 'resources', name)

/** How to start this app again: an AppImage runs from a temporary mount, so use the file itself. */
const launch = (): Launch => ({
  exe: process.env['APPIMAGE'] ?? process.execPath,
  appPath: app.isPackaged ? null : app.getAppPath()
})

/** Browser requests waiting on the window, which owns the link. */
const fromBrowser = new Map<
  number,
  (r: { ok: true; result: BridgeResult } | { ok: false; error: string }) => void
>()
let nextBrowserRequest = 1

async function askWindow(request: BridgeRequest): Promise<BridgeResult> {
  if (!win) throw new Error('maki desktop is starting')
  request = await forWindow(request)
  const key = nextBrowserRequest++
  return new Promise((resolve, reject) => {
    fromBrowser.set(key, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))))
    win!.webContents.send('browser:request', key, request)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    show: !offscreen && !startHidden,
    width: 1080,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    title: 'maki',
    icon: resource('icon.png'),
    backgroundColor: '#1e1e2e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      offscreen,
      // hidden windows get their timers throttled to once a minute, which would miss the
      // 10 s heartbeat and make maki think we've gone
      backgroundThrottling: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
}

function showWindow(): void {
  if (!win) createWindow()
  win!.show()
  win!.focus()
}

function trayStatus(): string {
  if (!link.linked) return 'Looking for maki…'
  const time =
    link.timeState === 2
      ? 'time verified'
      : link.timeState === 1
        ? 'time unverified'
        : 'time not set'
  return `maki linked · ${time}`
}

async function refreshTray(): Promise<void> {
  if (!tray) return
  tray.setImage(nativeImage.createFromPath(resource(link.linked ? 'tray-linked.png' : 'tray.png')))
  tray.setToolTip(trayStatus())
  const startAtLogin = await getStartAtLogin()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatus(), enabled: false },
      { type: 'separator' },
      { label: 'Show maki', click: showWindow },
      {
        label: 'Sync time now',
        enabled: link.linked,
        click: () => win?.webContents.send('tray:sync')
      },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: startAtLogin,
        click: async (item) => {
          await setStartAtLogin(item.checked)
          void refreshTray()
        }
      },
      { label: 'Quit maki', click: () => ((quitting = true), app.quit()) }
    ])
  )
}

/**
 * Web Serial in Electron has no browser picker: the renderer asks for maki's USB IDs and we
 * answer with the first match. Permission is granted only to our own window.
 */
function allowSerial(): void {
  const ours = (wc: Electron.WebContents | null): boolean => wc !== null && wc === win?.webContents
  session.defaultSession.on('select-serial-port', (event, ports, webContents, callback) => {
    event.preventDefault()
    callback(ours(webContents) && ports.length > 0 ? ports[0].portId : '')
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === 'serial' && ours(wc)
  )
  session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'serial')
}

function ipc(): void {
  ipcMain.handle('roughtime:relay', (_e, host: string, port: number, packet: Uint8Array) =>
    relay(host, port, packet)
  )
  ipcMain.on('link:report', (_e, report: LinkReport) => {
    link = report
    void refreshTray()
  })
  ipcMain.on(
    'browser:response',
    (
      _e,
      key: number,
      response: { ok: true; result: BridgeResult } | { ok: false; error: string }
    ) => {
      fromBrowser.get(key)?.(response)
      fromBrowser.delete(key)
    }
  )
  ipcMain.handle('backups:save', (_e, data: Uint8Array) => saveBackup(data))
  ipcMain.handle('backups:latest', () => latestBackup())
  ipcMain.handle('backups:info', () => backupInfo())
  ipcMain.handle('backups:show', () => showBackups())
  ipcMain.handle('browsers:status', () => browserStatus())
  ipcMain.handle('browsers:register', (_e, id: string) => registerBrowser(id, launch()))
  ipcMain.handle('browsers:unregister', (_e, id: string) => unregisterBrowser(id))
  // a browser the list doesn't know: the folder it reads helpers from, chosen here
  ipcMain.handle('browsers:add', async (_e, name: string, family: BrowserFamily) => {
    const r = await dialog.showOpenDialog(win!, {
      title: `${name}: its folder, or where it looks for browser helpers`,
      defaultPath: join(process.env['XDG_CONFIG_HOME'] || join(app.getPath('home'), '.config')),
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return addCustomBrowser({ name, family, dir: r.filePaths[0] }, launch())
  })
  ipcMain.handle('browsers:remove', (_e, id: string) => removeCustomBrowser(id))
  // sudo: maki's sudo plugin, set up (and taken away) as root, for this user
  const sudoPlugin = (): string =>
    app.isPackaged
      ? join(process.resourcesPath, 'maki_sudo.so')
      : join(app.getAppPath(), 'sudo/target/release/libmaki_sudo.so')
  ipcMain.handle('sudo:status', () => sudoStatus())
  ipcMain.handle('sudo:on', async (_e, key: unknown, name: unknown) => {
    if (typeof key !== 'string') throw new Error('no key from maki')
    const plugin = sudoPlugin()
    if (!existsSync(plugin))
      throw new Error(
        'this maki desktop was built without its sudo plugin: cargo build --release, in sudo/'
      )
    await sudoOn(plugin, key, typeof name === 'string' ? name : null, userInfo().username, pkexec)
    return sudoStatus()
  })
  ipcMain.handle('sudo:off', async () => {
    await sudoOff(pkexec)
    return sudoStatus()
  })
  // a multisig wallet for maki's Bitcoin app to add: its descriptor, or Sparrow's Coldcard export
  ipcMain.handle('btc:openWallet', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open a multisig wallet (its descriptor, or Sparrow’s Coldcard multisig export)',
      filters: [
        { name: 'Text', extensions: ['txt', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    if ((await stat(path)).size > 64 * 1024)
      throw new Error('that file is too big to be a multisig wallet')
    return { path, text: await readFile(path, 'utf8') }
  })
  // maki's multisig key, as the file Coldcard exports one in, for Sparrow
  ipcMain.handle('btc:saveText', async (_e, name: unknown, text: unknown) => {
    if (typeof name !== 'string' || typeof text !== 'string' || !/^[\w.-]{1,64}$/.test(name))
      throw new Error('not a file to save')
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(app.getPath('home'), name),
      title: 'Save maki’s multisig key'
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text)
    return r.filePath
  })
  ipcMain.handle('wallet:open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open a transaction to sign (PSBT)',
      filters: [
        { name: 'PSBT', extensions: ['psbt', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    // base64 of maki's largest PSBT (512 KiB) is under 700 KiB
    if ((await stat(path)).size > 1024 * 1024)
      throw new Error('that file is too big to be a PSBT maki takes')
    return { path, data: new Uint8Array(await readFile(path)) }
  })
  ipcMain.handle('ssh:socket', () => agentSocketPath())
  ipcMain.handle('apps:open', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a maki app to install',
      filters: [
        { name: 'maki apps', extensions: ['maki'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    if ((await stat(path)).size > 512 * 1024)
      throw new Error('that file is bigger than any app maki takes (512 KiB)')
    return { path, data: new Uint8Array(await readFile(path)) }
  })
  ipcMain.handle('wallet:save', async (_e, defaultPath: string, data: Uint8Array) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save the signed transaction',
      defaultPath,
      filters: [{ name: 'PSBT', extensions: ['psbt'] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, data)
    return r.filePath
  })
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  // a page in the browser, such as an app's source: https only
  ipcMain.handle('open:external', (_e, url: unknown) => {
    if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url)) return shell.openExternal(url)
  })

  // Ethereum: which sites are connected, and each site's network; and the networks' servers
  const ethFile = (): string => join(app.getPath('userData'), 'ethereum.json')
  const ethState = (v: unknown): EthState | null => {
    const o = v as EthState | null
    const strings = (r: unknown): boolean =>
      typeof r === 'object' && r !== null && Object.values(r).every((x) => typeof x === 'string')
    return o && strings(o.connected) && strings(o.chains)
      ? { connected: o.connected, chains: o.chains }
      : null
  }
  ipcMain.handle('eth:load', async () => {
    try {
      return (
        ethState(JSON.parse(await readFile(ethFile(), 'utf8'))) ?? { connected: {}, chains: {} }
      )
    } catch {
      return { connected: {}, chains: {} }
    }
  })
  ipcMain.handle('eth:save', async (_e, state: unknown) => {
    const s = ethState(state)
    if (s) await writeFile(ethFile(), JSON.stringify(s))
  })
  ipcMain.handle('eth:rpc', async (_e, url: string, method: string, params: unknown[]) => {
    // only the networks maki desktop knows: the renderer can't send this process anywhere else
    const network = NETWORKS.find((n) => n.rpc === url)
    if (!network) return { error: { code: 4901, message: 'unknown network' } }
    // its servers in turn: the next when one can't be reached, not when one answers "no";
    // MAKI_ETH_RPC (tests) is a server to use instead, for every network
    let unreachable = ''
    const servers = process.env['MAKI_ETH_RPC']
      ? [process.env['MAKI_ETH_RPC']]
      : [network.rpc, ...network.fallbacks]
    for (const server of servers) {
      try {
        const res = await fetch(server, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(20_000)
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as {
          result?: unknown
          error?: { code?: number; message?: string }
        }
        if (body.error)
          return {
            error: {
              code: body.error.code ?? -32603,
              message: body.error.message ?? 'the network refused it'
            }
          }
        return { result: body.result ?? null }
      } catch (e) {
        unreachable = (e as Error).message
      }
    }
    return { error: { code: -32603, message: `the network is unreachable: ${unreachable}` } }
  })
  // Solana: which sites are connected; and the networks' servers, as for Ethereum
  const solFile = (): string => join(app.getPath('userData'), 'solana.json')
  const solState = (v: unknown): SolState | null => {
    const c = (v as SolState | null)?.connected
    return typeof c === 'object' &&
      c !== null &&
      Object.values(c).every((x) => typeof x === 'string')
      ? { connected: c }
      : null
  }
  ipcMain.handle('sol:load', async () => {
    try {
      return solState(JSON.parse(await readFile(solFile(), 'utf8'))) ?? { connected: {} }
    } catch {
      return { connected: {} }
    }
  })
  ipcMain.handle('sol:save', async (_e, state: unknown) => {
    const s = solState(state)
    if (s) await writeFile(solFile(), JSON.stringify(s))
  })
  ipcMain.handle('sol:rpc', async (_e, url: string, method: string, params: unknown[]) => {
    // only the networks maki desktop knows; MAKI_SOL_RPC (tests) is a server to use instead
    const network = SOL_NETWORKS.find((n) => n.rpc === url)
    if (!network) return { error: { code: 4901, message: 'unknown network' } }
    let unreachable = ''
    const servers = process.env['MAKI_SOL_RPC']
      ? [process.env['MAKI_SOL_RPC']]
      : [network.rpc, ...network.fallbacks]
    for (const server of servers) {
      try {
        const res = await fetch(server, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(20_000)
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as {
          result?: unknown
          error?: { code?: number; message?: string }
        }
        if (body.error)
          return {
            error: {
              code: body.error.code ?? -32603,
              message: body.error.message ?? 'the network refused it'
            }
          }
        return { result: body.result ?? null }
      } catch (e) {
        unreachable = (e as Error).message
      }
    }
    return { error: { code: -32603, message: `the network is unreachable: ${unreachable}` } }
  })
  // Bitcoin: mempool.space's Esplora API, for the wallet (only these paths, and a broadcast), and
  // the accounts' descriptors maki shared, kept so the balance shows without asking maki again
  const ESPLORA = {
    bitcoin: 'https://mempool.space/api',
    test: 'https://mempool.space/testnet4/api'
  }
  const ESPLORA_PATH =
    /^\/(address\/[a-zA-Z0-9]{14,90}(\/utxo|\/txs)?|tx\/[0-9a-f]{64}\/hex|v1\/fees\/recommended)$/
  // a wallet's first look can be a hundred requests, and mempool.space turns away bursts (and
  // then stops answering for a while): two a second, and a long wait when it asks for one.
  // MAKI_ESPLORA (tests, your own server) is an Esplora API to use instead, for both networks.
  const ownEsplora = process.env['MAKI_ESPLORA']
  const esplora = polite(
    (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    ownEsplora ? { atOnce: 4 } : { atOnce: 2, perSecond: 2, wait: 5000 }
  )
  ipcMain.handle('btc:esplora', async (_e, network: unknown, path: unknown, body?: unknown) => {
    try {
      if (network !== 'bitcoin' && network !== 'test') throw new Error('which network?')
      const post = path === '/tx' && typeof body === 'string' && /^[0-9a-f]{20,800000}$/.test(body)
      if (!post && (typeof path !== 'string' || !ESPLORA_PATH.test(path)))
        throw new Error('not something the wallet asks')
      let res: Response
      try {
        res = await esplora(`${ownEsplora ?? ESPLORA[network]}${path}`, {
          method: post ? 'POST' : 'GET',
          body: post ? (body as string) : undefined,
          headers: post ? { 'content-type': 'text/plain' } : undefined
        })
      } catch {
        throw new Error('mempool.space can’t be reached')
      }
      const text = await res.text()
      if (res.status === 429)
        throw new Error(
          'mempool.space has had too many requests from this computer: try again in a minute'
        )
      // Esplora says what's wrong in a line of text (a broadcast it turns down, say); anything else, just the status
      if (!res.ok)
        throw new Error(
          /^[^<]{1,300}$/.test(text.trim())
            ? `mempool.space: ${text.trim()}`
            : `mempool.space answered ${res.status}`
        )
      return { text }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  // what the coins are worth, if the owner asks to see it: CoinGecko, the same question for
  // everyone (every coin and token maki knows), at most once a minute a currency
  const priced = new Map<Currency, { at: number; prices: Prices }>()
  ipcMain.handle('prices:get', async (_e, currency: unknown) => {
    try {
      if (!CURRENCIES.includes(currency as Currency)) throw new Error('which currency?')
      const c = currency as Currency
      const kept = priced.get(c)
      if (kept && Date.now() - kept.at < 60_000) return { prices: kept.prices }
      const res = await fetch(pricesUrl(c), { signal: AbortSignal.timeout(15_000) }).catch(() => {
        throw new Error('CoinGecko can’t be reached')
      })
      if (!res.ok)
        throw new Error(
          res.status === 429
            ? 'CoinGecko is busy: prices in a minute'
            : `CoinGecko answered ${res.status}`
        )
      const prices = readPrices(await res.json(), c)
      priced.set(c, { at: Date.now(), prices })
      return { prices }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // age: age-plugin-maki on the PATH, and an identity file for maki's key where the owner says
  ipcMain.handle('age:status', () => agePluginStatus(launch()))
  ipcMain.handle('age:install', () => installAgePlugin(launch()))
  ipcMain.handle('age:save', async (e, text: unknown) => {
    // only an identity file, as the window makes it from maki's recipient
    if (
      typeof text !== 'string' ||
      text.length > 1000 ||
      !/^AGE-PLUGIN-MAKI-1[0-9A-Z]+$/m.test(text)
    )
      return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      defaultPath: join(app.getPath('home'), 'maki-age.txt'),
      title: 'Save your age identity'
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text, { mode: 0o600 })
    return r.filePath
  })

  // contacts: the people met, as vCards, where the owner says
  ipcMain.handle('contacts:save', async (e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 1_000_000 || !text.startsWith('BEGIN:VCARD'))
      return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      defaultPath: join(app.getPath('home'), 'maki-contacts.vcf'),
      title: 'Save the people you met'
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text, { mode: 0o600 })
    return r.filePath
  })

  // OpenPGP: maki-gpg on the PATH, which gpg's users and git run, and maki's public key
  ipcMain.handle('gpg:status', () => scriptStatus(GPG_COMMAND, launch()))
  ipcMain.handle('gpg:install', () => installScript(GPG_COMMAND, launch()))
  ipcMain.handle('gpg:save', async (e, text: unknown) => {
    if (
      typeof text !== 'string' ||
      text.length > 100_000 ||
      !text.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    )
      return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      defaultPath: join(app.getPath('home'), 'maki-openpgp.asc'),
      title: 'Save your OpenPGP public key'
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text)
    return r.filePath
  })

  // git: maki-ssh-keygen on the PATH, which git runs to sign commits with maki's SSH app
  ipcMain.handle('sshKeygen:status', () => scriptStatus(SSH_KEYGEN_COMMAND, launch()))
  ipcMain.handle('sshKeygen:install', () => installScript(SSH_KEYGEN_COMMAND, launch()))

  // minisign: maki-minisign on the PATH, and maki's public key where the owner says
  ipcMain.handle('minisign:status', () => scriptStatus(MINISIGN_COMMAND, launch()))
  ipcMain.handle('minisign:install', () => installScript(MINISIGN_COMMAND, launch()))
  ipcMain.handle('minisign:save', async (e, text: unknown) => {
    // only a public key file, as the window makes it from maki's key
    if (typeof text !== 'string' || text.length > 200 || !parsePublicKey(text)) return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      defaultPath: join(app.getPath('home'), 'minisign.pub'),
      title: 'Save your minisign public key'
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text)
    return r.filePath
  })

  // Monero: the view key maki shared (for this computer to watch the wallet, and to read and write
  // the Monero GUI's files), and maki desktop's own wallet's state; readable by this user alone
  const xmrFile = (): string => join(app.getPath('userData'), 'monero.json')
  ipcMain.handle('xmr:load', async () => {
    try {
      return JSON.parse(await readFile(xmrFile(), 'utf8')) as unknown
    } catch {
      return null
    }
  })
  ipcMain.handle('xmr:save', async (_e, state: unknown) => {
    const text = JSON.stringify(state)
    if (typeof state !== 'object' || state === null || text.length > 64 * 1024 * 1024)
      throw new Error('not a Monero wallet state')
    await writeFile(xmrFile(), text, { mode: 0o600 })
  })
  // a Monero node, as maki desktop's wallet asks it (the page can't reach one itself): POST to
  // one of its paths, the answer's bytes; http for your own node, https or http for others
  ipcMain.handle('xmr:node', async (_e, url: unknown, path: unknown, body: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+\/?$/.test(url))
      throw new Error('not a node’s address')
    if (typeof path !== 'string' || !/^\/[a-z_./]+$/.test(path))
      throw new Error('not a node’s path')
    if (typeof body !== 'string' && !(body instanceof Uint8Array))
      throw new Error('nothing to send the node')
    const r = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      body,
      headers: typeof body === 'string' ? { 'Content-Type': 'application/json' } : {},
      signal: AbortSignal.timeout(120_000)
    })
    if (!r.ok) throw new Error(`the node said ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  })
  ipcMain.handle('xmr:open', async (_e, title: unknown) => {
    const r = await dialog.showOpenDialog(win!, {
      title: typeof title === 'string' ? title : 'Open a Monero file',
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    if ((await stat(path)).size > 64 * 1024 * 1024)
      throw new Error('that file is too big to be one of the Monero GUI’s')
    return { path, data: new Uint8Array(await readFile(path)) }
  })
  ipcMain.handle(
    'xmr:saveFile',
    async (_e, title: unknown, defaultPath: unknown, data: unknown, keyImages: unknown) => {
      if (!(data instanceof Uint8Array)) throw new Error('nothing to save')
      const r = await dialog.showSaveDialog(win!, {
        title: typeof title === 'string' ? title : 'Save',
        defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined
      })
      if (r.canceled || !r.filePath) return null
      await writeFile(r.filePath, data)
      // the Monero GUI imports a signed transaction's key images from beside it as it submits it
      if (keyImages instanceof Uint8Array) await writeFile(`${r.filePath}_keyImages`, keyImages)
      return r.filePath
    }
  )

  // NIP-46: the bunker's state (its own key, which only carries requests: the Nostr key is maki's)
  const nostrFile = (): string => join(app.getPath('userData'), 'nostr-bunker.json')
  ipcMain.handle('nostr:load', async () => {
    try {
      return JSON.parse(await readFile(nostrFile(), 'utf8')) as unknown
    } catch {
      return null
    }
  })
  ipcMain.handle('nostr:save', async (_e, kept: unknown) => {
    const text = JSON.stringify(kept)
    if (text.length > 256 * 1024) throw new Error('too much to keep')
    await writeFile(nostrFile(), text, { mode: 0o600 })
  })
  const btcFile = (): string => join(app.getPath('userData'), 'bitcoin.json')
  ipcMain.handle('btc:load', async () => {
    try {
      const kept = JSON.parse(await readFile(btcFile(), 'utf8')) as { descriptors?: unknown }
      return Array.isArray(kept.descriptors)
        ? kept.descriptors.filter((d): d is string => typeof d === 'string' && d.length < 300)
        : []
    } catch {
      return []
    }
  })
  ipcMain.handle('btc:save', async (_e, descriptors: unknown) => {
    const list = Array.isArray(descriptors)
      ? descriptors.filter((d): d is string => typeof d === 'string' && d.length < 300)
      : []
    await writeFile(btcFile(), JSON.stringify({ descriptors: list.slice(0, 8) }))
  })

  // the maki store: where it is, its files (only those), and what this side keeps of it between
  // runs (the newest root it took, and the newest index's version)
  const where = storeWhere()
  const token = storeToken()
  const store = storeSource(where, token)
  const storeFile = (): string => join(app.getPath('userData'), 'store.json')
  // whether it may need a token: the renderer says so if the store can't be read
  ipcMain.handle('store:where', () => ({
    where,
    name: storeName(where),
    github: onGithub(where),
    token: token !== null
  }))
  ipcMain.handle('store:get', (_e, path: unknown) =>
    store && typeof path === 'string' ? store.get(path) : null
  )
  ipcMain.handle('store:load', async () => {
    try {
      const kept = JSON.parse(await readFile(storeFile(), 'utf8')) as {
        root?: unknown
        indexVersion?: unknown
      }
      return {
        root: typeof kept.root === 'string' ? fromBase64(kept.root) : null,
        indexVersion: Number.isSafeInteger(kept.indexVersion) ? kept.indexVersion : 0
      }
    } catch {
      return { root: null, indexVersion: 0 }
    }
  })
  ipcMain.handle('store:save', async (_e, kept: { root: unknown; indexVersion: unknown }) => {
    const root = kept.root instanceof Uint8Array ? toBase64(kept.root) : null
    const indexVersion = Number.isSafeInteger(kept.indexVersion) ? kept.indexVersion : 0
    await writeFile(storeFile(), JSON.stringify({ root, indexVersion }))
  })
  ipcMain.handle('app:version', () => app.getVersion())
  // the notices beside the packaged app (electron-builder.yml), or the ones the build wrote
  ipcMain.handle('app:notices', async () => {
    const notices = app.isPackaged
      ? join(process.resourcesPath, 'THIRD-PARTY-NOTICES.md')
      : join(app.getAppPath(), 'out', 'THIRD-PARTY-NOTICES.md')
    const failed = await shell.openPath(notices)
    if (failed) throw new Error(failed)
  })
  ipcMain.handle('settings:startAtLogin', () => getStartAtLogin())
  ipcMain.handle('settings:setStartAtLogin', async (_e, on: boolean) => {
    await setStartAtLogin(on)
    void refreshTray()
    return getStartAtLogin()
  })

  // development transport: the fake maki (libs/maki-proto/examples/fake_maki.rs) over TCP
  ipcMain.handle('dev:open', (e, host: string, port: number) => {
    devSocket?.destroy()
    return new Promise<void>((resolve, reject) => {
      // MAKI_FAKE_PORT: a fake maki somewhere other than 7878 (tests start theirs on any free port)
      const socket = connect(Number(process.env['MAKI_FAKE_PORT']) || port, host)
      devSocket = socket
      socket.once('connect', () => resolve())
      socket.once('error', reject)
      socket.on('data', (d) => e.sender.send('dev:data', new Uint8Array(d)))
      socket.on('close', () => {
        if (devSocket === socket) devSocket = null
        if (!e.sender.isDestroyed()) e.sender.send('dev:close')
      })
    })
  })
  ipcMain.handle(
    'dev:send',
    (_e, bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) =>
        devSocket
          ? devSocket.write(bytes, (err) => (err ? reject(err) : resolve()))
          : reject(new Error('not connected'))
      )
  )
  ipcMain.handle('dev:close', () => devSocket?.destroy())
}

if (process.argv.includes('--age-plugin-maki')) {
  // started by age, through the age-plugin-maki script: the plugin, speaking age's protocol on
  // stdio and asking maki's Age app through the tray app. Only its stanzas reach stdout.
  console.log = console.info = console.debug = console.error
  app.dock?.hide()
  void runAgePlugin(process.argv, {
    input: process.stdin,
    output: process.stdout,
    error: (line) => process.stderr.write(`${line}\n`),
    ask: askOver(socketPath())
  }).then((code) => app.exit(code))
} else if (process.argv.includes(GPG_COMMAND.flag)) {
  // started by git or anyone, through maki-gpg on the PATH: signing and opening with maki's
  // OpenPGP app, or gpg's own work
  console.log = console.info = console.debug = console.error
  app.dock?.hide()
  void runGpg(process.argv, {
    input: process.stdin,
    output: (bytes) => process.stdout.write(bytes),
    status: (fd, line) => writeSync(fd, `${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    ask: askOver(socketPath(), OPENPGP_APP),
    gpg: gpgOnPath
  }).then((code) => app.exit(code))
} else if (process.argv.includes(SSH_KEYGEN_COMMAND.flag)) {
  // started by git, through maki-ssh-keygen on the PATH: signing with maki's SSH app, or
  // ssh-keygen's own work
  console.log = console.info = console.debug = console.error
  app.dock?.hide()
  void runSshKeygen(process.argv, {
    input: process.stdin,
    output: (bytes) => process.stdout.write(bytes),
    error: (line) => process.stderr.write(`${line}\n`),
    ask: askOver(socketPath(), SSH_APP),
    sshKeygen: sshKeygenOnPath
  }).then((code) => app.exit(code))
} else if (process.argv.includes(MINISIGN_COMMAND.flag)) {
  // started by maki-minisign on the PATH: minisign's commands, asking maki's Minisign app through
  // the tray app
  console.log = console.info = console.debug = console.error
  app.dock?.hide()
  void runMinisign(process.argv, {
    output: (text) => process.stdout.write(text),
    error: (line) => process.stderr.write(`${line}\n`),
    ask: askOver(socketPath(), MINISIGN_APP)
  }).then((code) => app.exit(code))
} else if (process.argv.includes('--native-host')) {
  // started by a browser for the maki extension: relay to the tray app, starting it if needed.
  // Before the single-instance lock, which the tray app holds. stdout carries only framed
  // messages to the browser, so anything logged goes to stderr.
  console.log = console.info = console.debug = console.error
  app.dock?.hide()
  void runNativeHost({
    socketPath: socketPath(),
    input: process.stdin,
    output: process.stdout,
    launchApp: () => launchTrayApp(launch())
  }).finally(() => app.exit(0))
} else if (!app.requestSingleInstanceLock()) {
  // one maki app per login: a second launch just brings the window forward
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    allowSerial()
    ipc()
    createWindow()
    refreshStartAtLogin().catch((e) =>
      console.error(`couldn't bring the login entry up to date: ${(e as Error).message}`)
    )
    serveBridge(askWindow).catch((e) =>
      console.error(`browser bridge unavailable: ${(e as Error).message}`)
    )
    // browsers in a Flatpak sandbox, through the one folder shared with them: the extension's
    // requests only (browsers.ts)
    const sandboxed = browserSocketPath()
    if (sandboxed) {
      serveBridge(extensionOnly(askWindow), sandboxed).catch((e) =>
        console.error(`sandboxed browsers' bridge unavailable: ${(e as Error).message}`)
      )
    }
    // ssh and git, through maki's SSH app
    serveAgent(async (message) => {
      const r = await askWindow({ id: 0, type: 'appMessage', app: SSH_APP, data: message })
      return r.type === 'appMessage' && r.status === 'approved' ? fromBase64(r.data) : null
    }).catch((e) => console.error(`SSH agent unavailable: ${(e as Error).message}`))
    if (!offscreen) {
      tray = new Tray(nativeImage.createFromPath(resource('tray.png')))
      tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()))
      void refreshTray()
    }
    app.on('activate', showWindow)
  })
  app.on('before-quit', () => (quitting = true))
  // the tray keeps the app alive with no windows open
  app.on('window-all-closed', () => {})
}
