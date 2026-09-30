import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserFamily, BrowsersView } from '../shared/bridge-types'

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
    status: (): Promise<BrowsersView> => ipcRenderer.invoke('browsers:status'),
    register: (id: string): Promise<BrowsersView> => ipcRenderer.invoke('browsers:register', id),
    unregister: (id: string): Promise<BrowsersView> => ipcRenderer.invoke('browsers:unregister', id),
    /** one the list doesn't know: a folder dialog, then connected; null if cancelled */
    add: (name: string, family: BrowserFamily): Promise<BrowsersView | null> => ipcRenderer.invoke('browsers:add', name, family),
    /** forget one added by hand, disconnecting it */
    remove: (id: string): Promise<BrowsersView> => ipcRenderer.invoke('browsers:remove', id)
  },
  wallet: {
    /** A file dialog for a PSBT; its path and bytes, or null if cancelled. */
    open: (): Promise<{ path: string; data: Uint8Array } | null> => ipcRenderer.invoke('wallet:open'),
    /** A save dialog starting at `defaultPath`; where it went, or null if cancelled. */
    save: (defaultPath: string, data: Uint8Array): Promise<string | null> => ipcRenderer.invoke('wallet:save', defaultPath, data)
  },
  ssh: {
    /** where maki desktop's SSH agent listens: SSH_AUTH_SOCK */
    socket: (): Promise<string> => ipcRenderer.invoke('ssh:socket')
  },
  apps: {
    /** A file dialog for a .maki bundle; its path and bytes, or null if cancelled. */
    open: (): Promise<{ path: string; data: Uint8Array } | null> => ipcRenderer.invoke('apps:open')
  },
  store: {
    /**
     * where the maki store is (MAKI_STORE: an address or a folder), its name for people, and
     * whether it's on GitHub and there's a token to read it (MAKI_STORE_TOKEN) while it's private
     */
    where: (): Promise<{ where: string; name: string; github: boolean; token: boolean }> =>
      ipcRenderer.invoke('store:where'),
    /** a file of the store's by its path in the store, or null if it has none */
    get: (path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('store:get', path),
    load: (): Promise<import('../shared/store').StoreMemory> => ipcRenderer.invoke('store:load'),
    save: (kept: import('../shared/store').StoreMemory): Promise<void> => ipcRenderer.invoke('store:save', kept)
  },
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  bitcoin: {
    /** Esplora (mempool.space): a path under the network's API; with a body, a broadcast */
    esplora: async (network: 'bitcoin' | 'test', path: string, body?: string): Promise<string> => {
      const r = (await ipcRenderer.invoke('btc:esplora', network, path, body)) as { text: string } | { error: string }
      if ('error' in r) throw new Error(r.error)
      return r.text
    },
    /** the accounts' descriptors maki shared, kept */
    load: (): Promise<string[]> => ipcRenderer.invoke('btc:load'),
    save: (descriptors: string[]): Promise<void> => ipcRenderer.invoke('btc:save', descriptors),
    /** an open dialog for a multisig wallet's file (a descriptor, or Coldcard's multisig file); its text, or null */
    openWallet: (): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke('btc:openWallet'),
    /** a save dialog for a text file (maki's multisig key, for Sparrow); where it went, or null */
    saveText: (name: string, text: string): Promise<string | null> => ipcRenderer.invoke('btc:saveText', name, text)
  },
  monero: {
    /** what maki desktop keeps of the Monero wallet (its view key, and its own wallet's state) */
    load: (): Promise<unknown> => ipcRenderer.invoke('xmr:load'),
    save: (state: unknown): Promise<void> => ipcRenderer.invoke('xmr:save', state),
    /** POST to a Monero node's path; the answer's bytes */
    node: (url: string, path: string, body: Uint8Array | string): Promise<Uint8Array> =>
      ipcRenderer.invoke('xmr:node', url, path, body),
    /** a file dialog for one of wallet2's files; its path and bytes, or null if cancelled */
    open: (title: string): Promise<{ path: string; data: Uint8Array } | null> => ipcRenderer.invoke('xmr:open', title),
    /** a save dialog; where it went, or null. A signed transaction's key images go beside it, as the Monero GUI looks for them. */
    saveFile: (title: string, defaultPath: string, data: Uint8Array, keyImages?: Uint8Array): Promise<string | null> =>
      ipcRenderer.invoke('xmr:saveFile', title, defaultPath, data, keyImages)
  },
  age: {
    /** whether age-plugin-maki is on the PATH, starting this app */
    status: (): Promise<import('../shared/age').AgePluginStatus> => ipcRenderer.invoke('age:status'),
    install: (): Promise<import('../shared/age').AgePluginStatus> => ipcRenderer.invoke('age:install'),
    /** a save dialog for the identity file; where it went, or null */
    save: (text: string): Promise<string | null> => ipcRenderer.invoke('age:save', text)
  },
  gpg: {
    /** whether maki-gpg is on the PATH, starting this app */
    status: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('gpg:status'),
    install: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('gpg:install'),
    /** a save dialog for maki's public key, armoured; where it went, or null */
    save: (text: string): Promise<string | null> => ipcRenderer.invoke('gpg:save', text)
  },
  contacts: {
    /** a save dialog for the people met, as vCards; where they went, or null */
    save: (text: string): Promise<string | null> => ipcRenderer.invoke('contacts:save', text)
  },
  sshKeygen: {
    /** whether maki-ssh-keygen is on the PATH, starting this app */
    status: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('sshKeygen:status'),
    install: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('sshKeygen:install')
  },
  nostr: {
    /** what maki desktop keeps of its NIP-46 bunker, or null */
    load: (): Promise<unknown> => ipcRenderer.invoke('nostr:load'),
    save: (kept: unknown): Promise<void> => ipcRenderer.invoke('nostr:save', kept)
  },
  sudo: {
    /** whether maki's sudo plugin is set up, and with whose key */
    status: (): Promise<import('../shared/sudo').SudoStatus> => ipcRenderer.invoke('sudo:status'),
    /** sets it up for this user, trusting maki's key (base64): asks for the admin password */
    on: (key: string, name: string | null): Promise<import('../shared/sudo').SudoStatus> => ipcRenderer.invoke('sudo:on', key, name),
    /** takes it away, for everyone: asks for the admin password */
    off: (): Promise<import('../shared/sudo').SudoStatus> => ipcRenderer.invoke('sudo:off')
  },
  minisign: {
    /** whether maki-minisign is on the PATH, starting this app */
    status: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('minisign:status'),
    install: (): Promise<import('../shared/commands').CommandStatus> => ipcRenderer.invoke('minisign:install'),
    /** a save dialog for minisign.pub; where it went, or null */
    save: (text: string): Promise<string | null> => ipcRenderer.invoke('minisign:save', text)
  },
  /** what the coins are worth in `currency` (CoinGecko), when the owner asks to see it */
  prices: async (currency: import('../shared/prices').Currency): Promise<import('../shared/prices').Prices> => {
    const r = (await ipcRenderer.invoke('prices:get', currency)) as { prices: Record<string, number> } | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r.prices
  },
  /** opens an https page in the browser */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  ethereum: {
    rpc: (url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> =>
      ipcRenderer.invoke('eth:rpc', url, method, params),
    load: (): Promise<import('../shared/ethereum').EthState> => ipcRenderer.invoke('eth:load'),
    save: (state: import('../shared/ethereum').EthState): Promise<void> => ipcRenderer.invoke('eth:save', state)
  },
  solana: {
    rpc: (url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> =>
      ipcRenderer.invoke('sol:rpc', url, method, params),
    load: (): Promise<import('../shared/solana').SolState> => ipcRenderer.invoke('sol:load'),
    save: (state: import('../shared/solana').SolState): Promise<void> => ipcRenderer.invoke('sol:save', state)
  },
  app: {
    /** maki desktop's version, as its package.json says */
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    /** open the notices of the code of others it carries (THIRD-PARTY-NOTICES.md) */
    notices: (): Promise<void> => ipcRenderer.invoke('app:notices')
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
