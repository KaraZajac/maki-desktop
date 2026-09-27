import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserStatus } from '../shared/bridge-types'

const api = {
  relay: (host: string, port: number, packet: Uint8Array): Promise<Uint8Array> =>
    ipcRenderer.invoke('roughtime:relay', host, port, packet),
  reportLink: (report: { linked: boolean; via: string | null; timeState: number | null }): void =>
    ipcRenderer.send('link:report', report),
  onTraySync: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('tray:sync', handler)
    return () => ipcRenderer.removeListener('tray:sync', handler)
  },
  /** The main process forwards browser-extension requests here; the window owns the link. */
  onBrowserRequest: (
    handler: (request: import('../shared/bridge-types').BridgeRequest) => Promise<import('../shared/bridge-types').BridgeResult>
  ): (() => void) => {
    const listener = (_e: unknown, key: number, request: import('../shared/bridge-types').BridgeRequest): void => {
      handler(request).then(
        (result) => ipcRenderer.send('browser:response', key, { ok: true, result }),
        (e: Error) => ipcRenderer.send('browser:response', key, { ok: false, error: e.message })
      )
    }
    ipcRenderer.on('browser:request', listener)
    return () => ipcRenderer.removeListener('browser:request', listener)
  },
  backups: {
    save: (data: Uint8Array): Promise<void> => ipcRenderer.invoke('backups:save', data),
    latest: (): Promise<Uint8Array | null> => ipcRenderer.invoke('backups:latest'),
    info: (): Promise<{ at: number; bytes: number } | null> => ipcRenderer.invoke('backups:info'),
    show: (): Promise<void> => ipcRenderer.invoke('backups:show')
  },
  browsers: {
    status: (): Promise<BrowserStatus[]> => ipcRenderer.invoke('browsers:status'),
    register: (name: string): Promise<BrowserStatus[]> => ipcRenderer.invoke('browsers:register', name),
    unregister: (name: string): Promise<BrowserStatus[]> => ipcRenderer.invoke('browsers:unregister', name)
  },
  wallet: {
    /** A file dialog for a PSBT; its path and bytes, or null if cancelled. */
    open: (): Promise<{ path: string; data: Uint8Array } | null> => ipcRenderer.invoke('wallet:open'),
    /** A save dialog starting at `defaultPath`; where it went, or null if cancelled. */
    save: (defaultPath: string, data: Uint8Array): Promise<string | null> => ipcRenderer.invoke('wallet:save', defaultPath, data)
  },
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  ethereum: {
    rpc: (url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> =>
      ipcRenderer.invoke('eth:rpc', url, method, params),
    load: (): Promise<import('../shared/ethereum').EthState> => ipcRenderer.invoke('eth:load'),
    save: (state: import('../shared/ethereum').EthState): Promise<void> => ipcRenderer.invoke('eth:save', state)
  },
  settings: {
    startAtLogin: (): Promise<boolean> => ipcRenderer.invoke('settings:startAtLogin'),
    setStartAtLogin: (on: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setStartAtLogin', on)
  },
  dev: {
    open: (host: string, port: number): Promise<void> => ipcRenderer.invoke('dev:open', host, port),
    send: (bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('dev:send', bytes),
    close: (): Promise<void> => ipcRenderer.invoke('dev:close'),
    onData: (listener: (bytes: Uint8Array) => void): void => {
      ipcRenderer.removeAllListeners('dev:data')
      ipcRenderer.on('dev:data', (_e, bytes: Uint8Array) => listener(bytes))
    },
    onClose: (listener: () => void): void => {
      ipcRenderer.removeAllListeners('dev:close')
      ipcRenderer.on('dev:close', () => listener())
    }
  }
}

export type MakiApi = typeof api

contextBridge.exposeInMainWorld('maki', api)
