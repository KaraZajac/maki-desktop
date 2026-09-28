/**
 * The desktop end of the link: one maki at a time, kept alive with a heartbeat, its clock kept
 * right. Browser-free, so it runs in the renderer and in tests alike; USB discovery lives in the
 * renderer (usb.ts) and hands transports in through `attach`.
 */

import { type BridgeRequest, type BridgeResult, toBase64 } from './bridge-types'
import {
  MakiClient,
  syncTime,
  type Hello,
  type InstalledApp,
  type Relay,
  type Status,
  type SyncReport,
  type Transport
} from './client'
import { readBundle } from './bundle'
import { Ethereum, memoryStore, ProviderError, type EthStore, type Rpc } from './ethereum'
import type { ApprovalValue, NetworkValue } from './protocol'
import type { Store, StoreApp } from './store'

/** maki drops the link after 25 s of silence (PROTOCOL.md, "Link"). */
export const HEARTBEAT_MS = 10_000
/** A device gets this long to answer HELLO before we decide it isn't maki. */
export const PROBE_TIMEOUT_MS = 2_000
/** The RTC drifts; resync this often while linked. */
export const RESYNC_MS = 6 * 60 * 60 * 1000
/** Back up this often while linked, and soon after a login is saved. */
export const BACKUP_EVERY_MS = 60 * 60 * 1000
export const BACKUP_AFTER_SAVE_MS = 5_000

/**
 * Where backups go: files in the app's folder, in the app; memory, in tests. They're encrypted
 * with a key only maki's recovery phrase gives, so this side never sees what's in them.
 */
export interface BackupStore {
  save(data: Uint8Array): Promise<void>
  latest(): Promise<Uint8Array | null>
}

export type Via = 'USB' | 'fake maki'

export type LinkState =
  | { linked: false }
  | { linked: true; via: Via; hello: Hello; status: Status & { at: number } }

export class Link {
  state: LinkState = { linked: false }
  report: SyncReport | null = null
  syncing = false
  autoSync = true
  log: string[] = []
  /** Called after an app is installed from outside the window (`maki install`). */
  appsChanged: (() => void) | null = null
  /**
   * The maki store, when this side knows where it is (`where`): its apps to show, and its newest
   * root and revocation list for maki, handed over on each link.
   */
  store: Store | null = null
  storeWhere: string | null = null
  /** whether this link's maki has what the store has (it can't take anything while locked) */
  private storeHanded = false
  private storeBusy = false

  private client: MakiClient | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private resync: ReturnType<typeof setInterval> | null = null
  private backups_: ReturnType<typeof setInterval> | null = null
  private backupSoon: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  backingUp = false

  /** the Ethereum account, for sites through the browser extension */
  readonly ethereum: Ethereum

  constructor(
    private relay: Relay,
    private now: () => Date = () => new Date(),
    private backups: BackupStore | null = null,
    eth: { rpc: Rpc; store: EthStore } = { rpc: async () => Promise.reject(new ProviderError(4900, 'no network')), store: memoryStore() }
  ) {
    this.ethereum = new Ethereum(() => (this.state.linked ? this.client : null), eth.rpc, eth.store)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  note(line: string): void {
    this.log = [`${this.now().toLocaleTimeString()}  ${line}`, ...this.log].slice(0, 100)
    this.emit()
  }

  get busy(): boolean {
    return this.client !== null
  }

  /**
   * Try `transport` as maki. With `probe`, a device that doesn't answer HELLO promptly is closed
   * and reported as not maki (a stock DC34 badge shares the USB IDs). Returns whether it linked.
   */
  async attach(transport: Transport, via: Via, { probe = false } = {}): Promise<boolean> {
    if (this.client) {
      await transport.close()
      return false
    }
    const client = new MakiClient(transport)
    this.client = client
    let hello: Hello
    try {
      hello = await client.hello(probe ? PROBE_TIMEOUT_MS : 5000)
    } catch (e) {
      this.client = null
      await transport.close().catch(() => {})
      if (!probe) this.note(`no answer from maki: ${(e as Error).message}`)
      return false
    }
    transport.onClose(() => {
      if (this.client === client) this.drop('maki disconnected')
    })
    try {
      const status = await client.status()
      this.state = { linked: true, via, hello, status: { ...status, at: Date.now() } }
    } catch (e) {
      this.drop(`maki stopped answering: ${(e as Error).message}`)
      return false
    }
    this.note(`linked to ${hello.name} ${hello.version} over ${via}`)
    this.storeHanded = false
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
    this.resync = setInterval(() => {
      void this.syncNow().then(() => this.storeNow())
    }, RESYNC_MS)
    if (this.autoSync) {
      await this.syncNow()
      // after the clock: maki takes the catalogue key's records only with verified time
      void this.storeNow()
    }
    if (this.backups) {
      this.backups_ = setInterval(() => void this.backupNow({ quiet: true }), BACKUP_EVERY_MS)
      if (this.autoSync) void this.backupNow({ quiet: true })
    }
    return true
  }

  /**
   * Fetch maki's backup and keep it. Quiet: a maki that's locked, or has no recovery phrase
   * yet, isn't worth a line in the log every hour.
   */
  async backupNow({ quiet = false } = {}): Promise<boolean> {
    const client = this.client
    if (!client || !this.backups || this.backingUp || !this.state.linked) return false
    this.backingUp = true
    this.emit()
    try {
      const { status, data } = await client.backup()
      if (status === 'approved') {
        await this.backups.save(data)
        this.note(`backed up (${Math.max(1, Math.round(data.length / 1024))} KB, encrypted)`)
        return true
      }
      if (!quiet || !(status === 'locked' || status === 'no phrase')) {
        this.note(status === 'locked' ? 'no backup: maki is locked' : status === 'no phrase' ? 'no backup: maki has no recovery phrase yet' : `no backup: ${status}`)
      }
      return false
    } catch (e) {
      this.note(`backup failed: ${(e as Error).message}`)
      return false
    } finally {
      this.backingUp = false
      this.emit()
    }
  }

  /** Send the latest backup to maki; the owner approves on maki's screen. */
  async restoreLatest(): Promise<void> {
    const client = this.client
    if (!client || !this.backups || !this.state.linked) return
    const blob = await this.backups.latest()
    if (!blob) return this.note('no backup on this computer to restore')
    this.note('restoring a backup: approve on maki')
    try {
      const r = await client.restore(blob)
      this.note(
        r.approval === 'approved'
          ? r.logins + r.codes + r.passkeys === 0
            ? 'maki already has everything in the backup'
            : `restored ${r.logins} logins, ${r.codes} codes and ${r.passkeys} passkeys`
          : r.approval === 'not yours'
            ? 'that backup is from another recovery phrase'
            : `restore: ${r.approval}`
      )
    } catch (e) {
      this.note(`restore failed: ${(e as Error).message}`)
    }
  }

  private async beat(): Promise<void> {
    const client = this.client
    if (!client || !this.state.linked) return
    try {
      const status = await client.status()
      if (this.client === client && this.state.linked) {
        this.state = { ...this.state, status: { ...status, at: Date.now() } }
        this.emit()
      }
    } catch (e) {
      if (this.client === client) this.drop(`maki stopped answering: ${(e as Error).message}`)
    }
  }

  async syncNow(): Promise<SyncReport | null> {
    const client = this.client
    if (!client || this.syncing) return null
    this.syncing = true
    this.emit()
    try {
      const report = await syncTime(client, this.relay)
      this.report = report
      this.note(
        report.verified
          ? `time verified by ${report.servers.filter((s) => s.result === 'verified').length} servers`
          : report.set
            ? 'Roughtime unreachable: set from this computer (unverified)'
            : 'Roughtime unreachable, and maki already holds a verified time'
      )
      await this.beat()
      return report
    } catch (e) {
      this.note(`time sync failed: ${(e as Error).message}`)
      return null
    } finally {
      this.syncing = false
      this.emit()
    }
  }

  /** The apps installed on maki. */
  async appList(): Promise<{ status: ApprovalValue; apps: InstalledApp[] }> {
    const r = await this.linkedClient().appList()
    // unlocked since the link came up: now maki can take the store's records
    if (r.status === 'approved' && !this.storeHanded) void this.storeNow()
    return r
  }

  /** Checks the maki store again, whether or not maki is linked: for the list of its apps. */
  async storeCheck(): Promise<void> {
    if (!this.store) return
    await this.store.refresh().catch(() => {})
    this.emit()
  }

  /**
   * Checks the maki store if it's been a while, and hands maki the roots and revocation list it
   * hasn't taken; maki checks each itself. Quiet unless something changed or went wrong.
   */
  async storeNow(): Promise<void> {
    const store = this.store
    const client = this.client
    if (!store || !client || !this.state.linked || this.storeBusy) return
    this.storeBusy = true
    try {
      if (store.stale || !store.root) await store.refresh()
      const r = await store.push(client)
      for (const line of r.notes) this.note(line)
      this.storeHanded = !r.locked
    } catch (e) {
      this.note(`maki store: ${(e as Error).message}`)
    } finally {
      this.storeBusy = false
    }
    this.emit()
  }

  /** Installs an app from the store: its stamped bundle, checked against the index, then maki's own checks and the owner. */
  async storeInstall(app: StoreApp): Promise<{ approval: ApprovalValue; reason: string }> {
    if (!this.store) throw new Error('maki desktop has no store to install from')
    const bundle = await this.store.bundle(app)
    // maki checks the stamp against the newest root it has: hand it the store's first
    if (!this.storeHanded) await this.storeNow()
    return this.appInstall(app.name, bundle.bytes)
  }

  /** Install a .maki bundle, once the owner has gone through it on maki's screen. */
  async appInstall(name: string, bundle: Uint8Array): Promise<{ approval: ApprovalValue; reason: string }> {
    const client = this.linkedClient()
    this.note(`${name}: go through it on maki to install`)
    const r = await client.appInstall(bundle)
    this.note(
      r.approval === 'approved'
        ? `${name} installed`
        : r.approval === 'refused'
          ? `maki won't install ${name}: ${r.reason}`
          : `${name}: ${r.approval}`
    )
    return r
  }

  /**
   * A message for an app on maki with the link permission, and its answer. Not logged: what an
   * app and the software talking to it say is theirs.
   */
  async appMessage(id: string, message: Uint8Array): Promise<{ status: ApprovalValue; answer: Uint8Array }> {
    return this.linkedClient().appMessage(id, message)
  }

  /** Remove an app and its data, once the owner says so on maki. */
  async appRemove(id: string, name: string): Promise<ApprovalValue> {
    const client = this.linkedClient()
    this.note(`removing ${name}: approve on maki`)
    const r = await client.appRemove(id)
    this.note(r === 'approved' ? `${name} removed` : `removing ${name}: ${r}`)
    return r
  }

  /** The Bitcoin account for wallet software, once the owner agrees on maki. */
  async btcAccount(network: NetworkValue): Promise<{ zpub: string; descriptor: string } | null> {
    const client = this.linkedClient()
    this.note('sharing the Bitcoin account: approve on maki')
    const r = await client.btcAccount(network)
    this.note(r.approval === 'approved' ? 'Bitcoin account shared' : `Bitcoin account: ${r.approval}`)
    return r.approval === 'approved' ? { zpub: r.zpub, descriptor: r.descriptor } : null
  }

  /** Put an address on maki's screen; the owner says whether it matches this computer's. */
  async btcAddress(network: NetworkValue, change: boolean, index: number): Promise<{ approval: ApprovalValue; address: string }> {
    const client = this.linkedClient()
    const which = `${change ? 'change' : 'receive'} address #${index}`
    this.note(`${which} is on maki's screen: compare it`)
    const r = await client.btcAddress(network, change, index)
    this.note(
      r.approval === 'approved'
        ? `${which} matches maki's`
        : r.approval === 'denied'
          ? `${which} doesn't match maki's: don't use this computer's copy`
          : `${which}: ${r.approval}`
    )
    return r
  }

  /** Have maki sign a PSBT, once the owner has gone through it on maki's screen. */
  async btcSign(
    network: NetworkValue,
    psbt: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    const client = this.linkedClient()
    this.note('transaction sent: go through it on maki')
    const r = await client.btcSign(network, psbt)
    this.note(
      r.approval === 'approved'
        ? 'transaction signed'
        : r.approval === 'refused'
          ? `maki won't sign it: ${r.reason}`
          : r.approval === 'denied'
            ? 'transaction rejected on maki'
            : `transaction: ${r.approval}`
    )
    return r
  }

  private linkedClient(): MakiClient {
    if (!this.client || !this.state.linked) throw new Error('maki is not linked')
    return this.client
  }

  /**
   * A request from the browser extension. Logs the site and the outcome, never a secret.
   * Anything that needs maki fails fast when maki isn't linked.
   */
  async fromBrowser(request: BridgeRequest): Promise<BridgeResult> {
    if (request.type === 'status') {
      return { type: 'status', linked: this.state.linked, timeState: this.state.linked ? this.state.status.timeState : null }
    }
    if (request.type === 'eth') return this.fromSite(request.site, request.method, request.params)
    if (request.type === 'installBundle') {
      const name = readBundle(request.data).manifest.name
      const r = await this.appInstall(name, request.data)
      this.appsChanged?.()
      return { type: 'install', name, ...r }
    }
    if (request.type === 'install') throw new Error('malformed request')
    if (request.type === 'appMessage') {
      const r = await this.appMessage(request.app, request.data)
      return { type: 'appMessage', status: r.status, data: toBase64(r.answer) }
    }
    const client = this.client
    if (!client || !this.state.linked) throw new Error('maki is not linked')
    switch (request.type) {
      case 'getLogin': {
        this.note(`${request.site} asked for its login: approve on maki`)
        const r = await client.getLogin(request.site)
        this.note(`${request.site}: login ${r.approval}`)
        return { type: 'getLogin', ...r }
      }
      case 'getTotp': {
        this.note(`${request.site} asked for a code: approve on maki`)
        const r = await client.getTotp(request.site)
        this.note(`${request.site}: code ${r.approval}`)
        return { type: 'getTotp', ...r }
      }
      case 'saveLogin': {
        this.note(`${request.site} offered a login to keep: approve on maki`)
        const approval = await client.saveLogin(request.site, request.username, request.password)
        this.note(`${request.site}: save ${approval}`)
        if (approval === 'approved' && this.backups) {
          if (this.backupSoon) clearTimeout(this.backupSoon)
          this.backupSoon = setTimeout(() => void this.backupNow({ quiet: true }), BACKUP_AFTER_SAVE_MS)
        }
        return { type: 'saveLogin', approval }
      }
    }
  }

  /** Ethereum methods that need the owner, and so a line in the log; reads don't. */
  private static readonly ETH_ASKS: Record<string, string> = {
    eth_requestAccounts: 'wants to connect to your Ethereum account',
    wallet_requestPermissions: 'wants to connect to your Ethereum account',
    personal_sign: 'wants a message signed',
    eth_signTypedData_v4: 'wants typed data signed',
    eth_sendTransaction: 'sent a transaction'
  }

  /** An EIP-1193 request from a site. Its errors go back to the page as they are. */
  private async fromSite(site: string, method: string, params: unknown[]): Promise<BridgeResult> {
    const asks = Link.ETH_ASKS[method]
    if (asks) this.note(`${site} ${asks}: approve on maki`)
    try {
      const result = await this.ethereum.request(site, method, params)
      if (asks) this.note(`${site}: ${method === 'eth_sendTransaction' ? `sent, ${String(result)}` : 'done'}`)
      return { type: 'eth', result }
    } catch (e) {
      const error = e instanceof ProviderError ? { code: e.code, message: e.message } : { code: -32603, message: (e as Error).message }
      if (asks) this.note(`${site}: ${error.message}`)
      return { type: 'eth', error }
    }
  }

  /** Close the link, if there is one. */
  drop(reason?: string): void {
    const client = this.client
    this.client = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.resync) clearInterval(this.resync)
    if (this.backups_) clearInterval(this.backups_)
    if (this.backupSoon) clearTimeout(this.backupSoon)
    this.heartbeat = this.resync = this.backups_ = this.backupSoon = null
    const wasLinked = this.state.linked
    this.state = { linked: false }
    void client?.close().catch(() => {})
    if (wasLinked && reason) this.note(reason)
    else this.emit()
  }
}
