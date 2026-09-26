/**
 * The desktop end of the link: one maki at a time, kept alive with a heartbeat, its clock kept
 * right. Browser-free, so it runs in the renderer and in tests alike; USB discovery lives in the
 * renderer (usb.ts) and hands transports in through `attach`.
 */

import { MakiClient, syncTime, type Hello, type Relay, type Status, type SyncReport, type Transport } from './client'

/** maki drops the link after 25 s of silence (PROTOCOL.md, "Link"). */
export const HEARTBEAT_MS = 10_000
/** A device gets this long to answer HELLO before we decide it isn't maki. */
export const PROBE_TIMEOUT_MS = 2_000
/** The RTC drifts; resync this often while linked. */
export const RESYNC_MS = 6 * 60 * 60 * 1000

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

  private client: MakiClient | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private resync: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()

  constructor(
    private relay: Relay,
    private now: () => Date = () => new Date()
  ) {}

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
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
    this.resync = setInterval(() => void this.syncNow(), RESYNC_MS)
    if (this.autoSync) await this.syncNow()
    return true
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

  /** Close the link, if there is one. */
  drop(reason?: string): void {
    const client = this.client
    this.client = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.resync) clearInterval(this.resync)
    this.heartbeat = this.resync = null
    const wasLinked = this.state.linked
    this.state = { linked: false }
    void client?.close().catch(() => {})
    if (wasLinked && reason) this.note(reason)
    else this.emit()
  }
}
