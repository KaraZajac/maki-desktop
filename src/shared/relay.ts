/**
 * A Nostr relay, over a WebSocket (NIP-01): one subscription, kept open (it reconnects, waiting
 * longer each time), events published, and NIP-42's AUTH answered when a relay asks.
 */
import type { SignedEvent } from './nostr'

/** What a relay's socket needs to be: a browser's WebSocket, or `ws`'s. */
export interface RelaySocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type OpenSocket = (url: string) => RelaySocket

export const openWebSocket: OpenSocket = (url) => new WebSocket(url) as unknown as RelaySocket

export type RelayState = 'connecting' | 'open' | 'closed'

/** A relay address maki desktop takes: wss://, or ws:// to this computer (a relay of your own, or a test's). */
export function relayUrl(text: string): string | null {
  try {
    const u = new URL(text.trim())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) return null
    return u.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

export class Relay {
  state: RelayState = 'closed'
  private socket: RelaySocket | null = null
  private stopped = true
  private wait = 1000
  private retry: ReturnType<typeof setTimeout> | null = null
  private okWaiters = new Map<string, (ok: boolean) => void>()

  constructor(
    readonly url: string,
    private filter: Record<string, unknown>,
    private onEvent: (e: unknown, relay: Relay) => void,
    /** a signed NIP-42 AUTH event for a challenge, if the relay asks */
    private auth: (challenge: string, relay: string) => SignedEvent,
    private open: OpenSocket = openWebSocket,
    private onState: () => void = () => {}
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.socket?.close()
    this.socket = null
    this.set('closed')
    for (const w of this.okWaiters.values()) w(false)
    this.okWaiters.clear()
  }

  private set(s: RelayState): void {
    this.state = s
    this.onState()
  }

  private connect(): void {
    if (this.stopped) return
    this.set('connecting')
    let s: RelaySocket
    try {
      s = this.open(this.url)
    } catch {
      this.again()
      return
    }
    this.socket = s
    s.onopen = () => {
      this.wait = 1000
      this.set('open')
      this.send(['REQ', 'maki', this.filter])
    }
    s.onmessage = (m) => this.message(m.data)
    s.onerror = () => {}
    s.onclose = () => {
      if (this.socket === s) {
        this.socket = null
        this.again()
      }
    }
  }

  private again(): void {
    this.set('closed')
    if (this.stopped) return
    this.retry = setTimeout(() => this.connect(), this.wait)
    this.wait = Math.min(this.wait * 2, 60_000)
  }

  private send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private message(data: unknown): void {
    if (typeof data !== 'string' || data.length > 256 * 1024) return
    let m: unknown
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(m)) return
    const [kind, a, b] = m as unknown[]
    if (kind === 'EVENT' && a === 'maki') this.onEvent(b, this)
    else if (kind === 'OK' && typeof a === 'string') {
      this.okWaiters.get(a)?.(b === true)
      this.okWaiters.delete(a)
    } else if (kind === 'AUTH' && typeof a === 'string' && a.length <= 256) {
      this.send(['AUTH', this.auth(a, this.url)])
    }
  }

  /** Publishes an event: whether the relay said OK within `timeoutMs`. */
  publish(e: SignedEvent, timeoutMs = 10_000): Promise<boolean> {
    if (!this.send(['EVENT', e])) return Promise.resolve(false)
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.okWaiters.delete(e.id)
        resolve(false)
      }, timeoutMs)
      this.okWaiters.set(e.id, (ok) => {
        clearTimeout(t)
        resolve(ok)
      })
    })
  }
}
