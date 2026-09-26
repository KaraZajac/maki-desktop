import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, Tray } from 'electron'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import type { BridgeRequest, BridgeResult } from '../shared/bridge-types'
import { browserStatus, registerBrowser, unregisterBrowser, type Launch } from './browsers'
import { serveBridge, socketPath } from './bridge'
import { getStartAtLogin, setStartAtLogin } from './login'
import { launchTrayApp, runNativeHost } from './native-host'
import { relay } from './roughtime'

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

const resource = (name: string): string => join(app.getAppPath(), 'resources', name)

/** How to start this app again: an AppImage runs from a temporary mount, so use the file itself. */
const launch = (): Launch => ({ exe: process.env['APPIMAGE'] ?? process.execPath, appPath: app.isPackaged ? null : app.getAppPath() })

/** Browser requests waiting on the window, which owns the link. */
const fromBrowser = new Map<number, (r: { ok: true; result: BridgeResult } | { ok: false; error: string }) => void>()
let nextBrowserRequest = 1

function askWindow(request: BridgeRequest): Promise<BridgeResult> {
  if (!win) return Promise.reject(new Error('maki desktop is starting'))
  const key = nextBrowserRequest++
  return new Promise((resolve, reject) => {
    fromBrowser.set(key, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))))
    win!.webContents.send('browser:request', key, request)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    show: !offscreen && !startHidden,
    width: 480,
    height: 700,
    minWidth: 400,
    minHeight: 560,
    title: 'maki',
    icon: resource('icon.png'),
    backgroundColor: '#0b0b0f',
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
  const time = link.timeState === 2 ? 'time verified' : link.timeState === 1 ? 'time unverified' : 'time not set'
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
      { label: 'Sync time now', enabled: link.linked, click: () => win?.webContents.send('tray:sync') },
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
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'serial' && ours(wc))
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
  ipcMain.on('browser:response', (_e, key: number, response: { ok: true; result: BridgeResult } | { ok: false; error: string }) => {
    fromBrowser.get(key)?.(response)
    fromBrowser.delete(key)
  })
  ipcMain.handle('browsers:status', () => browserStatus())
  ipcMain.handle('browsers:register', (_e, name: string) => registerBrowser(name, launch()))
  ipcMain.handle('browsers:unregister', (_e, name: string) => unregisterBrowser(name))
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
      const socket = connect(port, host)
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
        devSocket ? devSocket.write(bytes, (err) => (err ? reject(err) : resolve())) : reject(new Error('not connected'))
      )
  )
  ipcMain.handle('dev:close', () => devSocket?.destroy())
}

if (process.argv.includes('--native-host')) {
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
    serveBridge(askWindow).catch((e) => console.error(`browser bridge unavailable: ${(e as Error).message}`))
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
