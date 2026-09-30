/**
 * NIP-46, remote signing: maki desktop as the "bunker" that Nostr apps (Coracle, Nostrudel,
 * Amethyst, …) sign through, over relays, with the key maki's Nostr app keeps. Apps send requests
 * as kind 24133 events, encrypted to the bunker's key (NIP-44, or NIP-04 from older ones); the
 * bunker answers the same way. The bunker's own key only carries those messages, and maki desktop
 * keeps it: the owner's key never leaves maki, and every event is shown on maki before it's
 * signed there, as a site's is (./nostr.ts).
 *
 * An app connects with the bunker's link (`bunker://…`, whose secret is good for one app) or by
 * the owner pasting the app's (`nostrconnect://…`); either way maki asks its owner first whether
 * to let it see the key, naming the app. After that it may ask for the public key and signatures;
 * maki can't encrypt or decrypt with the key yet, and says so.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { conversationKey, decrypt, encrypt, isNip04, nip04Decrypt, nip04Encrypt } from './nip44'
import { readEvent, type SignedEvent, type UnsignedEvent } from './nostr'
import { publicKeyOf, signEvent, verifyEvent } from './nostr-events'
import { openWebSocket, Relay, relayUrl, type OpenSocket, type RelayState } from './relay'

export const KIND = 24133
export const DEFAULT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io']

/** An app that has connected, and the owner let see the key. */
export interface BunkerClient {
  /** the app's own key for talking to the bunker */
  pubkey: string
  name: string
  /** how maki's Nostr app knows it, as it knows a site */
  site: string
  /** where it listens, if it said (nostrconnect://); else the bunker's */
  relays: string[]
  since: number
}

export interface BunkerState {
  /** the bunker's key, hex */
  secret: string
  relays: string[]
  clients: BunkerClient[]
  /** the next bunker:// link's secret, good for one app */
  pending: string
}

/** What maki's Nostr app does for a site: the key, once the owner lets it see it; signatures. */
export interface NostrSigner {
  publicKey(site: string): Promise<string>
  sign(site: string, event: UnsignedEvent): Promise<SignedEvent>
}

export function newState(relays: string[] = DEFAULT_RELAYS): BunkerState {
  return {
    secret: bytesToHex(secp256k1.utils.randomSecretKey()),
    relays,
    clients: [],
    pending: bytesToHex(randomBytes(16))
  }
}

/** A state as kept, or null if it isn't one. */
export function readState(v: unknown): BunkerState | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (
    typeof s.secret !== 'string' ||
    !/^[0-9a-f]{64}$/.test(s.secret) ||
    typeof s.pending !== 'string'
  )
    return null
  const relays = Array.isArray(s.relays)
    ? s.relays
        .map((r) => (typeof r === 'string' ? relayUrl(r) : null))
        .filter((r): r is string => !!r)
    : []
  const clients = Array.isArray(s.clients)
    ? s.clients.filter(
        (c): c is BunkerClient =>
          typeof c === 'object' &&
          c !== null &&
          typeof c.pubkey === 'string' &&
          /^[0-9a-f]{64}$/.test(c.pubkey) &&
          typeof c.name === 'string' &&
          typeof c.site === 'string' &&
          Array.isArray(c.relays) &&
          typeof c.since === 'number'
      )
    : []
  return { secret: s.secret, relays, clients, pending: s.pending }
}

/** The bunker's link, for an app to connect with. */
export function bunkerUri(state: BunkerState): string {
  const q = state.relays.map((r) => `relay=${encodeURIComponent(r)}`)
  q.push(`secret=${state.pending}`)
  return `bunker://${publicKeyOf(hexToBytes(state.secret))}?${q.join('&')}`
}

/** An app's link to connect with it (`nostrconnect://`, NIP-46's client-initiated way). */
export interface NostrConnect {
  pubkey: string
  relays: string[]
  secret: string
  name: string
  url: string
}

export function parseNostrConnect(text: string): NostrConnect | null {
  let u: URL
  try {
    u = new URL(text.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'nostrconnect:') return null
  const pubkey = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase()
  const relays = u.searchParams
    .getAll('relay')
    .map(relayUrl)
    .filter((r): r is string => !!r)
  const secret = u.searchParams.get('secret') ?? ''
  if (!/^[0-9a-f]{64}$/.test(pubkey) || relays.length === 0 || !secret || secret.length > 128)
    return null
  return {
    pubkey,
    relays,
    secret,
    name: u.searchParams.get('name') ?? '',
    url: u.searchParams.get('url') ?? ''
  }
}

/** How maki's Nostr app names an app: "remote", and the app's own name (or its key's start). */
export function siteFor(name: string, url: string, pubkey: string): string {
  let label = name
  if (!label && url) {
    try {
      label = new URL(url).hostname
    } catch {
      /* not a URL */
    }
  }
  label = label
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 40)
  return `remote ${label || pubkey.slice(0, 8)}`
}

/** A request, as an app sends it. */
interface Request {
  id: string
  method: string
  params: string[]
}

function readRequest(text: string): Request | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (
    typeof r.id !== 'string' ||
    r.id.length > 128 ||
    typeof r.method !== 'string' ||
    r.method.length > 64
  )
    return null
  const params = Array.isArray(r.params)
    ? r.params.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    : []
  return { id: r.id, method: r.method, params }
}

/** How far an event's time may be from ours: an old request isn't answered. */
const SKEW_S = 300

export class Bunker {
  readonly pubkey: string
  private key: Uint8Array
  private relayList = new Map<string, Relay>()
  private seen = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private running = false

  constructor(
    private state: BunkerState,
    private signer: NostrSigner,
    private save: (state: BunkerState) => void,
    private open: OpenSocket = openWebSocket,
    private note: (line: string) => void = () => {},
    private now: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.key = hexToBytes(state.secret)
    this.pubkey = publicKeyOf(this.key)
  }

  get clients(): BunkerClient[] {
    return this.state.clients
  }
  /** What it keeps, as it is now. */
  snapshot(): BunkerState {
    return this.state
  }
  get relays(): { url: string; state: RelayState }[] {
    return [...this.relayList.values()].map((r) => ({ url: r.url, state: r.state }))
  }
  uri(): string {
    return bunkerUri(this.state)
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f)
    return () => this.listeners.delete(f)
  }
  private changed(): void {
    this.listeners.forEach((f) => f())
  }
  private keep(): void {
    this.save(this.state)
    this.changed()
  }

  /** Every relay it's on: its own, and the apps' that said where they listen. */
  private wanted(): string[] {
    return [...new Set([...this.state.relays, ...this.state.clients.flatMap((c) => c.relays)])]
  }

  start(): void {
    this.running = true
    this.sync()
  }

  stop(): void {
    this.running = false
    this.relayList.forEach((r) => r.stop())
    this.relayList.clear()
    this.changed()
  }

  /** The relays it should be on, opened, and those it shouldn't be, closed. */
  private sync(): void {
    if (!this.running) return
    const want = new Set(this.wanted())
    for (const [url, r] of this.relayList) {
      if (!want.has(url)) {
        r.stop()
        this.relayList.delete(url)
      }
    }
    for (const url of want) {
      if (this.relayList.has(url)) continue
      const filter = { kinds: [KIND], '#p': [this.pubkey], since: this.now() - 60 }
      const auth = (challenge: string, relay: string): SignedEvent =>
        signEvent(this.key, {
          kind: 22242,
          created_at: this.now(),
          tags: [
            ['relay', relay],
            ['challenge', challenge]
          ],
          content: ''
        })
      const r = new Relay(
        url,
        filter,
        (e, from) => this.heard(e, from),
        auth,
        this.open,
        () => this.changed()
      )
      this.relayList.set(url, r)
      r.start()
    }
    this.changed()
  }

  setRelays(urls: string[]): void {
    const relays = [...new Set(urls.map(relayUrl).filter((r): r is string => !!r))]
    if (relays.length === 0) throw new Error('a relay is a wss:// address')
    this.state = { ...this.state, relays }
    this.keep()
    this.sync()
  }

  /** A new link: the old one's secret no longer lets an app connect. */
  newLink(): void {
    this.state = { ...this.state, pending: bytesToHex(randomBytes(16)) }
    this.keep()
  }

  revoke(pubkey: string): void {
    this.state = { ...this.state, clients: this.state.clients.filter((c) => c.pubkey !== pubkey) }
    this.keep()
    this.sync()
  }

  private client(pubkey: string): BunkerClient | undefined {
    return this.state.clients.find((c) => c.pubkey === pubkey)
  }

  private allow(c: BunkerClient): void {
    this.state = {
      ...this.state,
      clients: [...this.state.clients.filter((x) => x.pubkey !== c.pubkey), c]
    }
    this.keep()
    this.sync()
  }

  /** An event a relay passed on: a request for the bunker, answered in turn. */
  private heard(e: unknown, from: Relay): void {
    if (!verifyEvent(e) || e.kind !== KIND || e.pubkey === this.pubkey) return
    if (!e.tags.some((t) => t[0] === 'p' && t[1] === this.pubkey)) return
    if (Math.abs(e.created_at - this.now()) > SKEW_S || this.seen.has(e.id)) return
    this.seen.add(e.id)
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500))
    this.queue = this.queue.then(() => this.answer(e, from)).catch(() => {})
  }

  private async answer(e: SignedEvent, from: Relay): Promise<void> {
    const old = isNip04(e.content)
    let text: string
    try {
      text = old
        ? nip04Decrypt(e.content, this.key, e.pubkey)
        : decrypt(e.content, conversationKey(this.key, e.pubkey))
    } catch {
      return
    }
    const request = readRequest(text)
    if (!request) return
    let reply: { result?: string; error?: string }
    try {
      reply = { result: await this.handle(e.pubkey, request) }
    } catch (err) {
      reply = { error: (err as Error).message || 'failed' }
    }
    const body = JSON.stringify({ id: request.id, ...reply })
    const content = old
      ? nip04Encrypt(body, this.key, e.pubkey)
      : encrypt(body, conversationKey(this.key, e.pubkey))
    await this.send(e.pubkey, content, [from.url])
  }

  /** An answer to an app: to the relay its request came by, and every relay it listens on. */
  private async send(to: string, content: string, also: string[] = []): Promise<void> {
    const event = signEvent(this.key, {
      kind: KIND,
      created_at: this.now(),
      tags: [['p', to]],
      content
    })
    const c = this.client(to)
    const urls = new Set([...also, ...(c?.relays.length ? c.relays : this.state.relays)])
    await Promise.all(
      [...urls].map((u) => this.relayList.get(u)?.publish(event) ?? Promise.resolve(false))
    )
  }

  private async handle(from: string, r: Request): Promise<string> {
    const c = this.client(from)
    switch (r.method) {
      case 'connect': {
        if (r.params[0] && r.params[0] !== this.pubkey) throw new Error('that isn’t this bunker')
        if (c) return 'ack'
        if (!this.state.pending || r.params[1] !== this.state.pending)
          throw new Error('not a secret this bunker gave out: ask maki desktop for a new link')
        // its name, if it said (nostr-tools says it after the permissions)
        let meta: { name?: unknown; url?: unknown } = {}
        try {
          meta = JSON.parse(r.params[3] ?? '{}') ?? {}
        } catch {
          /* no name */
        }
        const name = typeof meta.name === 'string' ? meta.name : ''
        const url = typeof meta.url === 'string' ? meta.url : ''
        const client = {
          pubkey: from,
          name: name || url || from.slice(0, 8),
          site: siteFor(name, url, from),
          relays: [],
          since: this.now()
        }
        this.note(`${client.name} would like to use your Nostr key: look at maki`)
        await this.signer.publicKey(client.site)
        this.state = { ...this.state, pending: bytesToHex(randomBytes(16)) }
        this.allow(client)
        this.note(`${client.name} connected to maki’s Nostr key`)
        return 'ack'
      }
      case 'ping':
        if (!c) throw new Error('connect first')
        return 'pong'
      case 'get_public_key':
        if (!c) throw new Error('connect first')
        return this.signer.publicKey(c.site)
      case 'sign_event': {
        if (!c) throw new Error('connect first')
        let event: unknown
        try {
          event = JSON.parse(r.params[0] ?? '')
        } catch {
          throw new Error('sign_event takes an event, as JSON')
        }
        this.note(`${c.name} asks maki to sign an event: look at maki`)
        return JSON.stringify(await this.signer.sign(c.site, readEvent(event, this.now)))
      }
      case 'switch_relays':
        if (!c) throw new Error('connect first')
        return JSON.stringify(c.relays.length ? c.relays : this.state.relays)
      case 'logout':
        if (c) this.revoke(from)
        return 'ack'
      case 'nip04_encrypt':
      case 'nip04_decrypt':
      case 'nip44_encrypt':
      case 'nip44_decrypt':
        throw new Error('maki’s Nostr key signs; it doesn’t encrypt or decrypt messages yet')
      default:
        throw new Error(`no method ${r.method.slice(0, 32)}`)
    }
  }

  /**
   * An app's own link (`nostrconnect://`): once the owner lets it see the key on maki, the
   * bunker says so to it, with the secret its link had, on the relays it listens on.
   */
  async connect(text: string): Promise<BunkerClient> {
    const c = parseNostrConnect(text)
    if (!c) throw new Error('that isn’t a nostrconnect:// link with relays and a secret')
    const client: BunkerClient = {
      pubkey: c.pubkey,
      name: c.name || c.url || c.pubkey.slice(0, 8),
      site: siteFor(c.name, c.url, c.pubkey),
      relays: c.relays,
      since: this.now()
    }
    this.note(`letting ${client.name} use your Nostr key: look at maki`)
    await this.signer.publicKey(client.site)
    this.allow(client)
    // the relays open as they're asked for; wait a moment for the app's
    for (let i = 0; i < 50 && !c.relays.some((u) => this.relayList.get(u)?.state === 'open'); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const body = JSON.stringify({ id: bytesToHex(randomBytes(8)), result: c.secret })
    await this.send(c.pubkey, encrypt(body, conversationKey(this.key, c.pubkey)), c.relays)
    this.note(`${client.name} connected to maki’s Nostr key`)
    return client
  }
}
