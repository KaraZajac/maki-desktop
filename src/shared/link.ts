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
  type AppSpace,
  type InstalledApp,
  type Relay,
  type Status,
  type SyncReport,
  type Transport,
  type WalletStatus
} from './client'
import { readBundle } from './bundle'
import { Ethereum, memoryStore, ProviderError, type EthState, type Rpc } from './ethereum'
import { EthWallet } from './eth-wallet'
import { Nostr } from './nostr'
import { BtcAccount, type ApprovalValue, type BtcAccountValue, type NetworkValue } from './protocol'
import {
  AccountApp,
  BitcoinApp,
  EthereumApp,
  BITCOINCASH_APP,
  DASH_APP,
  DIGIBYTE_APP,
  CARDANO_APP,
  CardanoApp,
  COSMOS_APP,
  CosmosApp,
  DOGECOIN_APP,
  KASPA_APP,
  KaspaApp,
  LITECOIN_APP,
  MoneroApp,
  SolanaApp,
  TON_APP,
  TonApp,
  ZCASH_APP,
  ZcashApp,
  type AppMessage,
  type MoneroNetworkValue,
  type MoneroOutput
} from './wallet-apps'
import type { BtcChain } from './btc-wallet'
import type { MultisigWallet } from './multisig'
import { memorySolStore, Solana, type SolRpc, type SolState } from './solana'
import { SolWallet } from './sol-wallet'
import type { Store, StoreApp } from './store'
import { ANOTHER_WALLET, type WalletId } from './wallets'

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

/**
 * Where what's kept for each of maki's wallets goes (the sites connected to its Ethereum and
 * Solana accounts): what's read is the wallet in use's; what's saved names the wallet it's for,
 * and is turned down (thrown) unless that's still the one in use. Files of each wallet's own, in
 * the app (main's wallet-files.ts); memory, in tests.
 */
export interface WalletStore<S> {
  load(): Promise<S>
  save(state: S, wallet: WalletId): Promise<void>
}

export type Via = 'USB' | 'fake maki'

export type LinkState =
  | { linked: false }
  | {
      linked: true
      via: Via
      hello: Hello
      status: Status & { at: number }
      /**
       * which wallet maki's wallet apps have, as maki last said; null if it hasn't said (firmware
       * from before passphrase wallets, whose apps have the phrase's own)
       */
      wallet: WalletStatus | null
    }

export class Link {
  state: LinkState = { linked: false }
  report: SyncReport | null = null
  syncing = false
  autoSync = true
  log: string[] = []
  /** How many times a badge's time to give maki for each answer (MakiClient's `slow`). */
  slow = 1
  /**
   * How many lines have been noted, ever: what to watch for news (a backup, a site connected),
   * where the log's length stops changing once it's full.
   */
  notes = 0
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

  /**
   * Which of maki's wallets what wallet apps share is kept and shown for (wallets.ts): a passphrase
   * wallet's fingerprint, or null for the recovery phrase's own; the phrase's own until maki has
   * said. maki says when it links and with each heartbeat.
   *
   * While maki is locked or away, the last wallet it had stays in use. Being locked says nothing of
   * which wallet maki will have next (a passphrase wallet closes as maki locks, and opens again as
   * its owner unlocks it, if they've set that up), and what's on screen, and what's still being
   * kept as maki goes (a Monero scan, a site's connection), is that wallet's. Falling back to the
   * phrase's own would show its accounts in the passphrase wallet's place, and keep what's under
   * way under the wrong wallet.
   */
  wallet: WalletId = null
  /**
   * Called the moment the wallet in use changes, before anything hears of it: the window tells
   * main here, so everything read after is the new wallet's.
   */
  onWallet: ((wallet: WalletId) => void) | null = null
  /** whether this link's maki says which wallet it has (firmware from before passphrase wallets doesn't) */
  private walletSays = false
  /** asks of which wallet sent, and the latest whose answer was taken: one that comes late is no news */
  private walletAsked = 0
  private walletTaken = 0
  /** when maki last said, by this computer's clock */
  private walletAt = 0
  /** whether the last ask went wrong, which is noted once until one goes right */
  private walletTrouble = false

  private client: MakiClient | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private resync: ReturnType<typeof setInterval> | null = null
  private backups_: ReturnType<typeof setInterval> | null = null
  private backupSoon: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  backingUp = false

  /** maki's wallets: apps from the maki store, which maki keeps the keys for */
  readonly bitcoin: BitcoinApp
  readonly litecoin: BitcoinApp
  readonly dogecoin: BitcoinApp
  readonly bitcoincash: BitcoinApp
  readonly dash: BitcoinApp
  readonly digibyte: BitcoinApp
  readonly ethereumApp: EthereumApp
  readonly monero: MoneroApp
  /** the Ethereum account, for sites through the browser extension */
  readonly ethereum: Ethereum
  /** the same account as a wallet in maki desktop: what it holds, and sending from it */
  readonly ethWallet: EthWallet
  /** Nostr for sites, through maki's Nostr app */
  readonly nostr: Nostr
  readonly solanaApp: SolanaApp
  /** maki's apps for chains of accounts (Tron, XRP, Stellar, ...), made as they're first asked for */
  private accountApps = new Map<string, AccountApp>()
  /** the Solana account, for sites through the browser extension */
  readonly solana: Solana
  /** the same account as a wallet in maki desktop */
  readonly solWallet: SolWallet

  constructor(
    private relay: Relay,
    private now: () => Date = () => new Date(),
    private backups: BackupStore | null = null,
    eth: { rpc: Rpc; store: WalletStore<EthState> } = {
      rpc: async () => Promise.reject(new ProviderError(4900, 'no network')),
      store: memoryStore()
    },
    sol: { rpc: SolRpc; store: WalletStore<SolState> } = {
      rpc: async () => Promise.reject(new ProviderError(4900, 'no network')),
      store: memorySolStore()
    }
  ) {
    const send = (app: string, message: Uint8Array, timeoutMs?: number) =>
      this.appMessage(app, message, timeoutMs)
    const wallets = this.walletSend
    this.bitcoin = new BitcoinApp(wallets)
    this.litecoin = new BitcoinApp(wallets, LITECOIN_APP, 'Litecoin')
    this.dogecoin = new BitcoinApp(wallets, DOGECOIN_APP, 'Dogecoin')
    this.bitcoincash = new BitcoinApp(wallets, BITCOINCASH_APP, 'Bitcoin Cash')
    this.dash = new BitcoinApp(wallets, DASH_APP, 'Dash')
    this.digibyte = new BitcoinApp(wallets, DIGIBYTE_APP, 'DigiByte')
    this.ethereumApp = new EthereumApp(wallets)
    this.monero = new MoneroApp(wallets)
    this.ethereum = new Ethereum(
      () => (this.state.linked ? this.ethereumApp : null),
      eth.rpc,
      this.byWallet(eth.store)
    )
    this.ethWallet = new EthWallet(this.ethereum, eth.rpc)
    this.nostr = new Nostr(send)
    this.solanaApp = new SolanaApp(wallets)
    this.solana = new Solana(
      () => (this.state.linked ? this.solanaApp : null),
      sol.rpc,
      this.byWallet(sol.store)
    )
    this.solWallet = new SolWallet(this.solana, sol.rpc)
  }

  /**
   * A message for one of maki's wallet apps, which answer for the wallet maki has open: it goes
   * only while that's still the wallet in use here, maki having been asked again first (unless it
   * said in the last second), so nothing meant for one wallet is asked of another, nor another's
   * answer kept as this one's. The heartbeat asks only every ten seconds; the owner may have opened
   * a passphrase wallet on maki since, or gone back to the phrase's own.
   */
  private walletSend: AppMessage = async (app, message, timeoutMs) => {
    const wallet = this.wallet
    if ((await this.walletNow(1000)) !== wallet) throw new Error(ANOTHER_WALLET)
    return this.appMessage(app, message, timeoutMs)
  }

  /**
   * `store` as the Ethereum and Solana objects use it: what's read is the wallet in use's, and
   * what's saved goes back named for the wallet it was read under (a site's connection finished
   * after maki opened another wallet isn't kept as the new one's: main turns it down).
   */
  private byWallet<S extends object>(
    store: WalletStore<S>
  ): { load(): Promise<S>; save(state: S): Promise<void> } {
    const readFor = new WeakMap<S, WalletId>()
    return {
      load: async () => {
        const wallet = this.wallet
        const state = await store.load()
        readFor.set(state, wallet)
        return state
      },
      save: (state) =>
        store.save(state, readFor.has(state) ? (readFor.get(state) as WalletId) : this.wallet)
    }
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
    this.notes++
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
    const client = new MakiClient(transport, this.slow)
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
    let wallet: WalletStatus | null | undefined
    try {
      const status = await client.status()
      // which wallet its wallet apps have, before anything is shown or kept for one
      this.walletSays = true
      this.walletTrouble = false
      wallet = await this.askWallet(client)
      // unplugged while it was asked: the link is gone already
      if (this.client !== client) return false
      this.state = {
        linked: true,
        via,
        hello,
        status: { ...status, at: Date.now() },
        wallet: wallet ?? null
      }
    } catch (e) {
      this.drop(`maki stopped answering: ${(e as Error).message}`)
      return false
    }
    this.note(`linked to ${hello.name} ${hello.version} over ${via}`)
    if (wallet !== undefined) this.takeWallet(wallet)
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
    // the link may have ended while the clock was synced (or another taken its place): its
    // timer would never be stopped, and the next link's would back up twice as often
    if (this.backups && this.client === client) {
      if (this.backups_) clearInterval(this.backups_)
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
        this.note(
          status === 'locked'
            ? 'no backup: maki is locked'
            : status === 'no phrase'
              ? 'no backup: maki has no recovery phrase yet'
              : `no backup: ${status}`
        )
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
      // and which wallet: the owner may have opened a passphrase wallet on maki since, or locked it
      const wallet = this.walletSays ? await this.askWallet(client) : undefined
      if (this.client === client && this.state.linked) {
        this.state = { ...this.state, status: { ...status, at: Date.now() } }
        if (wallet !== undefined) this.takeWallet(wallet)
        this.emit()
      }
    } catch (e) {
      if (this.client === client) this.drop(`maki stopped answering: ${(e as Error).message}`)
    }
  }

  /**
   * Asks maki which wallet its wallet apps have, now (if it's linked and says), and switches to it
   * if it's another: the wallet in use, after. An answer from the last `withinMs` will do instead.
   */
  async walletNow(withinMs = 0): Promise<WalletId> {
    const client = this.client
    if (client && this.state.linked && this.walletSays && Date.now() - this.walletAt >= withinMs) {
      const wallet = await this.askWallet(client)
      if (wallet !== undefined && this.client === client && this.state.linked) {
        this.takeWallet(wallet)
        this.emit()
      }
    }
    return this.wallet
  }

  /**
   * maki's answer to which wallet its wallet apps have: null from firmware that doesn't know the
   * question (it isn't asked again on this link), or undefined for no news (no answer that makes
   * sense, or a later ask's came first). Never throws: a heartbeat goes on without it.
   */
  private async askWallet(client: MakiClient): Promise<WalletStatus | null | undefined> {
    const ask = ++this.walletAsked
    try {
      const wallet = await client.walletStatus()
      if (this.client !== client || ask < this.walletTaken) return undefined
      if (wallet === null) this.walletSays = false
      this.walletTaken = ask
      this.walletAt = Date.now()
      this.walletTrouble = false
      return wallet
    } catch (e) {
      if (this.client === client && !this.walletTrouble) {
        this.walletTrouble = true
        this.note(`couldn’t tell which wallet maki has: ${(e as Error).message}`)
      }
      return undefined
    }
  }

  /**
   * What maki said of its wallet, taken in: kept in the link's state, and the wallet in use switched
   * if it's another (main first, through `onWallet`, then a line in the log, which everything hears).
   * None (maki locked, or without a phrase yet) leaves the last one in use, as `wallet` says why.
   */
  private takeWallet(said: WalletStatus | null): void {
    if (this.state.linked) this.state = { ...this.state, wallet: said }
    if (said?.kind === 'none') return
    const next: WalletId = said?.kind === 'passphrase' ? said.fingerprint : null
    if (next === this.wallet) return
    this.wallet = next
    this.onWallet?.(next)
    this.note(
      next === null
        ? 'maki’s wallet apps have the phrase’s own wallet again'
        : `maki’s wallet apps have passphrase wallet ${next}`
    )
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

  /** Ask maki to restart into update mode for new firmware (`label`); its owner decides on maki. */
  async updateMode(label: string): Promise<ApprovalValue> {
    const client = this.linkedClient()
    this.note(`asked maki to restart for ${label}: approve on maki`)
    const approval = await client.updateMode(label)
    this.note(
      approval === 'approved' ? 'maki is restarting into update mode' : `update mode: ${approval}`
    )
    return approval
  }

  /** maki's room for apps, and what the ones installed take of it. */
  async appSpace(): Promise<{ status: ApprovalValue; space: AppSpace | null }> {
    return this.linkedClient().appSpace()
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

  /**
   * The install under way: maki takes one bundle's pieces at a time, in order, and two at once
   * (Bitcoin added, then Ethereum, before the first was through) would cross and both fail.
   */
  private installing: Promise<unknown> = Promise.resolve()

  /** Install a .maki bundle, once the owner has gone through it on maki's screen. */
  appInstall(
    name: string,
    bundle: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string }> {
    const turn = this.installing.then(() => this.installNow(name, bundle))
    this.installing = turn.catch(() => {})
    return turn
  }

  private async installNow(
    name: string,
    bundle: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string }> {
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
  async appMessage(
    id: string,
    message: Uint8Array,
    timeoutMs?: number
  ): Promise<{ status: ApprovalValue; answer: Uint8Array }> {
    return this.linkedClient().appMessage(id, message, timeoutMs)
  }

  /** Remove an app and its data, once the owner says so on maki. */
  async appRemove(id: string, name: string): Promise<ApprovalValue> {
    const client = this.linkedClient()
    this.note(`removing ${name}: approve on maki`)
    const r = await client.appRemove(id)
    this.note(r === 'approved' ? `${name} removed` : `removing ${name}: ${r}`)
    return r
  }

  /** maki's app for a coin of Bitcoin's kind: its Bitcoin, Litecoin, Dogecoin or Bitcoin Cash app. */
  private btcApp(chain: BtcChain): BitcoinApp {
    return this[chain]
  }

  /** maki's app for a chain of accounts, by its ID: its messages (`AccountApp`). */
  accountApp(id: string, name: string, chains?: [string, string | null]): AccountApp {
    // one for each chain an app serves (Cosmos's serves several)
    const key = chains ? `${id}|${chains[0]}` : id
    let app = this.accountApps.get(key)
    if (!app) {
      const send = this.walletSend
      // Kaspa's app speaks the same messages with fields of its own
      app =
        id === KASPA_APP
          ? new KaspaApp(send, id, name)
          : id === CARDANO_APP
            ? new CardanoApp(send, id, name)
            : id === COSMOS_APP && chains
              ? new CosmosApp(send, id, name, chains)
              : id === TON_APP
                ? new TonApp(send, id, name, chains?.[0] === 'v5R1' ? 'v5R1' : 'v4R2')
                : id === ZCASH_APP
                  ? new ZcashApp(send, id, name)
                  : new AccountApp(send, id, name)
      this.accountApps.set(key, app)
    }
    return app
  }

  /** A Bitcoin (or Litecoin) account for wallet software, once the owner agrees on maki. */
  async btcAccount(
    network: NetworkValue,
    account: BtcAccountValue = BtcAccount.SEGWIT,
    chain: BtcChain = 'bitcoin'
  ): Promise<{ zpub: string; descriptor: string } | null> {
    this.linkedClient()
    const app = this.btcApp(chain)
    this.note(`sharing the ${app.name} account: approve on maki`)
    const r = await app.account(network, account)
    this.note(
      r.approval === 'approved'
        ? `${app.name} account shared`
        : `${app.name} account: ${Link.walletSays(r.approval, app.name)}`
    )
    return r.approval === 'approved' ? { zpub: r.zpub, descriptor: r.descriptor } : null
  }

  /** A wallet app's answer that isn't a yes, for the log. */
  static walletSays(approval: ApprovalValue, wallet: string): string {
    switch (approval) {
      case 'no match':
        return `maki's ${wallet} app isn't installed: add it from the maki store, in Apps`
      case 'unavailable':
        return `maki couldn't run its ${wallet} app: if another app is open on maki, go back to the home screen and try again`
      default:
        return approval
    }
  }

  /** Put an address on maki's screen; the owner says whether it matches this computer's. */
  async btcAddress(
    network: NetworkValue,
    change: boolean,
    index: number,
    account: BtcAccountValue = BtcAccount.SEGWIT,
    chain: BtcChain = 'bitcoin'
  ): Promise<{ approval: ApprovalValue; address: string }> {
    this.linkedClient()
    const app = this.btcApp(chain)
    const which = `${chain === 'bitcoin' ? '' : `${app.name} `}${account === BtcAccount.TAPROOT ? 'taproot ' : ''}${change ? 'change' : 'receive'} address #${index}`
    this.note(`${which} is on maki's screen: compare it`)
    const r = await app.address(network, change, index, account)
    this.note(
      r.approval === 'approved'
        ? `${which} matches maki's`
        : r.approval === 'denied'
          ? `${which} doesn't match maki's: don't use this computer's copy`
          : `${which}: ${Link.walletSays(r.approval, app.name)}`
    )
    return r
  }

  /**
   * Put a Monero address on maki's screen (account 0's `index`: 0 is the primary address); the
   * owner says whether it matches this computer's.
   */
  async moneroAddress(
    network: MoneroNetworkValue,
    index: number
  ): Promise<{ approval: ApprovalValue; address: string }> {
    this.linkedClient()
    const which = index === 0 ? 'Monero primary address' : `Monero subaddress #${index}`
    this.note(`${which} is on maki's screen: compare it`)
    const r = await this.monero.address(network, 0, index)
    this.note(
      r.approval === 'approved'
        ? `${which} matches maki's`
        : r.approval === 'denied'
          ? `${which} doesn't match maki's: don't use this computer's copy`
          : `${which}: ${Link.walletSays(r.approval, 'Monero')}`
    )
    return r
  }

  /** Let this computer watch the Monero wallet, once the owner says so on maki: its address and view key. */
  async moneroWatch(
    network: MoneroNetworkValue
  ): Promise<{ approval: ApprovalValue; address: string; viewKey: Uint8Array | null }> {
    this.linkedClient()
    this.note('watching the Monero wallet: approve on maki')
    const r = await this.monero.watch(network)
    this.note(
      r.approval === 'approved'
        ? 'this computer watches the Monero wallet'
        : `Monero: ${Link.walletSays(r.approval, 'Monero')}`
    )
    return r
  }

  /** Monero outputs' key images, with their proofs, from maki. */
  async moneroKeyImages(
    outputs: MoneroOutput[],
    progress?: (done: number) => void
  ): Promise<{
    approval: ApprovalValue
    reason: string
    images: { image: Uint8Array; proof: Uint8Array }[]
  }> {
    this.linkedClient()
    const r = await this.monero.keyImages(outputs, progress)
    this.note(
      r.approval === 'approved'
        ? `${r.images.length} Monero key images from maki`
        : r.approval === 'refused'
          ? `no Monero key images: ${r.reason}`
          : `Monero key images: ${Link.walletSays(r.approval, 'Monero')}`
    )
    return r
  }

  /** Have maki make and sign a Monero transaction, once the owner has gone through it on maki's screen. */
  async moneroSign(
    network: MoneroNetworkValue,
    request: Uint8Array
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    this.linkedClient()
    this.note('Monero transaction sent: go through it on maki')
    const r = await this.monero.sign(network, request)
    this.note(
      r.approval === 'approved'
        ? 'Monero transaction signed'
        : r.approval === 'refused'
          ? `maki won't sign it: ${r.reason}`
          : r.approval === 'denied'
            ? 'Monero transaction rejected on maki'
            : `Monero transaction: ${Link.walletSays(r.approval, 'Monero')}`
    )
    return r
  }

  /** maki's key for multisig wallets, once the owner agrees on maki. */
  async btcCosigner(network: NetworkValue): Promise<string | null> {
    this.linkedClient()
    this.note('sharing maki’s multisig key: approve on maki')
    const r = await this.bitcoin.cosigner(network)
    this.note(
      r.approval === 'approved'
        ? 'multisig key shared'
        : `multisig key: ${Link.walletSays(r.approval, 'Bitcoin')}`
    )
    return r.approval === 'approved' ? r.key : null
  }

  /** Add a multisig wallet on maki, once the owner has gone through its keys there. */
  async btcAddMultisig(
    network: NetworkValue,
    name: string,
    text: string
  ): Promise<{ approval: ApprovalValue; reason: string; id: string; name: string }> {
    this.linkedClient()
    this.note('multisig wallet sent: go through its keys on maki')
    const r = await this.bitcoin.addMultisig(network, name, text)
    this.note(
      r.approval === 'approved'
        ? `maki added ${r.name}: it signs for it now`
        : r.approval === 'refused'
          ? `maki won't add it: ${r.reason}`
          : r.approval === 'denied'
            ? 'not added, on maki'
            : `multisig: ${Link.walletSays(r.approval, 'Bitcoin')}`
    )
    return r
  }

  /** The multisig wallets maki has added. */
  async btcMultisigs(): Promise<MultisigWallet[]> {
    this.linkedClient()
    return (await this.bitcoin.multisigs()).wallets
  }

  /** A multisig wallet's address on maki's screen, to compare with this computer's. */
  async btcMultisigAddress(
    id: string,
    change: boolean,
    index: number
  ): Promise<{ approval: ApprovalValue; address: string }> {
    this.linkedClient()
    this.note('address on maki’s screen: compare it with your wallet software’s')
    return this.bitcoin.multisigAddress(id, change, index)
  }

  /** Have maki sign a PSBT, once the owner has gone through it on maki's screen. */
  async btcSign(
    network: NetworkValue,
    psbt: Uint8Array,
    chain: BtcChain = 'bitcoin'
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }> {
    this.linkedClient()
    const app = this.btcApp(chain)
    this.note(`${chain === 'bitcoin' ? '' : `${app.name} `}transaction sent: go through it on maki`)
    const r = await app.sign(network, psbt)
    this.note(
      r.approval === 'approved'
        ? 'transaction signed'
        : r.approval === 'refused'
          ? `maki won't sign it: ${r.reason}`
          : r.approval === 'denied'
            ? 'transaction rejected on maki'
            : `transaction: ${Link.walletSays(r.approval, app.name)}`
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
      return {
        type: 'status',
        linked: this.state.linked,
        timeState: this.state.linked ? this.state.status.timeState : null
      }
    }
    if (request.type === 'eth') return this.fromSite(request.site, request.method, request.params)
    if (request.type === 'sol')
      return this.fromSolSite(request.site, request.method, request.params)
    if (request.type === 'nostr') {
      // a page's promise rejects with the reason, as NIP-07 pages expect: nothing is thrown past here
      try {
        if (request.method === 'signEvent')
          this.note(`${request.site} asked to sign a Nostr event: see maki`)
        return {
          type: 'nostr',
          result: await this.nostr.request(request.site, request.method, request.params)
        }
      } catch (e) {
        return { type: 'nostr', error: { message: (e as Error).message } }
      }
    }
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
        this.note(
          request.evenWithPasskey
            ? `${request.site} asked for its password, though maki has a passkey for it: approve on maki`
            : `${request.site} asked for its login: approve on maki`
        )
        const r = await client.getLogin(request.site, request.evenWithPasskey === true)
        this.note(
          r.approval === 'passkey'
            ? `${request.site}: maki has a passkey for it, so its password wasn't offered`
            : `${request.site}: login ${r.approval}`
        )
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
          this.backupSoon = setTimeout(
            () => void this.backupNow({ quiet: true }),
            BACKUP_AFTER_SAVE_MS
          )
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
      // the sites connected are the wallet's maki has open: if that's another since the heartbeat,
      // this one is read as its
      if (asks) await this.walletNow()
      const result = await this.ethereum.request(site, method, params)
      if (asks)
        this.note(
          `${site}: ${method === 'eth_sendTransaction' ? `sent, ${String(result)}` : 'done'}`
        )
      return { type: 'eth', result }
    } catch (e) {
      const error =
        e instanceof ProviderError
          ? { code: e.code, message: e.message }
          : { code: -32603, message: (e as Error).message }
      if (asks) this.note(`${site}: ${error.message}`)
      return { type: 'eth', error }
    }
  }

  /** Solana requests that need the owner, and so a line in the log. */
  private static readonly SOL_ASKS: Record<string, string> = {
    connect: 'wants to connect to your Solana account',
    signTransaction: 'wants a Solana transaction signed',
    signAndSendTransaction: 'sent a Solana transaction',
    signMessage: 'wants a message signed'
  }

  /** A request from a site's Solana wallet (the extension's). Its errors go back to the page as they are. */
  private async fromSolSite(
    site: string,
    method: string,
    params: unknown[]
  ): Promise<BridgeResult> {
    const quiet =
      method === 'connect' && (params[0] as { silent?: unknown } | undefined)?.silent === true
    const asks = quiet ? undefined : Link.SOL_ASKS[method]
    if (asks) this.note(`${site} ${asks}: approve on maki`)
    try {
      // as for Ethereum: the connections read are the wallet's maki has open
      if (asks) await this.walletNow()
      const result = await this.solana.request(site, method, params)
      if (asks)
        this.note(
          `${site}: ${method === 'signAndSendTransaction' ? `sent, ${(result as { signature: string }).signature}` : 'done'}`
        )
      return { type: 'sol', result }
    } catch (e) {
      const error =
        e instanceof ProviderError
          ? { code: e.code, message: e.message }
          : { code: -32603, message: (e as Error).message }
      if (asks) this.note(`${site}: ${error.message}`)
      return { type: 'sol', error }
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
