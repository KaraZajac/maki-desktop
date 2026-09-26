import { contextBridge, ipcRenderer } from 'electron'

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
