/**
 * Nostr for sites (NIP-07's `window.nostr`), answered by maki's Nostr app (the SDK's example
 * `nostr`), which holds the key: the extension's requests come here, go to the app as messages
 * (the link permission), and the app asks its owner on maki before a site first sees the key and
 * before each event it signs. The app works out each event's id itself, from the fields it shows.
 */
import type { ApprovalValue } from './protocol'

/** maki's Nostr app. */
export const NOSTR_APP = 'com.leviathan.maki.nostr'

/** An event as a site hands it over to be signed (NIP-01), before its id, key and signature. */
export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface SignedEvent extends UnsignedEvent {
  id: string
  pubkey: string
  sig: string
}

/** What the app answers with first. */
const OK = 0
const NO = 1
const LOCKED = 3
/** The most a message to an app can hold. */
const MAX_MESSAGE = 4096

/** Talking to an app on maki: its answer, if maki has it and it answered. */
export type AppMessage = (
  app: string,
  message: Uint8Array
) => Promise<{ status: ApprovalValue; answer: Uint8Array }>

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Whether `s` has half of a UTF-16 surrogate pair on its own: UTF-8 can't say it, so maki couldn't hash it as the site does. */
const lonely = (s: string): boolean =>
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

/** `event` as the app takes it, or why it can't be. */
export function readEvent(
  event: unknown,
  now = (): number => Math.floor(Date.now() / 1000)
): UnsignedEvent {
  if (typeof event !== 'object' || event === null) throw new Error('signEvent takes an event')
  const e = event as Record<string, unknown>
  const kind = e.kind
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 65535)
    throw new Error('an event’s kind is a whole number up to 65535')
  const created_at = e.created_at === undefined ? now() : e.created_at
  if (
    typeof created_at !== 'number' ||
    !Number.isInteger(created_at) ||
    created_at < 0 ||
    created_at > 2 ** 53
  ) {
    throw new Error('an event’s created_at is a time in seconds')
  }
  const tags = e.tags === undefined ? [] : e.tags
  if (
    !Array.isArray(tags) ||
    !tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  ) {
    throw new Error('an event’s tags are lists of strings')
  }
  const content = e.content === undefined ? '' : e.content
  if (typeof content !== 'string') throw new Error('an event’s content is a string')
  if (lonely(content) || (tags as string[][]).some((t) => t.some(lonely)))
    throw new Error('the event has text that isn’t whole characters')
  return { kind, created_at, tags: tags as string[][], content }
}

export class Nostr {
  constructor(private app: AppMessage) {}

  private async ask(message: Uint8Array): Promise<Uint8Array> {
    if (message.length > MAX_MESSAGE)
      throw new Error('that’s too long for maki to sign (4 KB at most)')
    const r = await this.app(NOSTR_APP, message)
    if (r.status === 'no match')
      throw new Error(
        'maki’s Nostr app isn’t installed: add it from the maki store, in maki desktop'
      )
    if (r.status !== 'approved') throw new Error(`maki: ${r.status}`)
    const a = r.answer
    if (a[0] === NO) throw new Error('rejected on maki')
    if (a[0] === LOCKED) throw new Error('maki is locked: enter its PIN first')
    if (a[0] !== OK) throw new Error('maki’s Nostr app couldn’t read that')
    return a.subarray(1)
  }

  private static site(op: number, site: string): Uint8Array {
    const s = new TextEncoder().encode(site)
    if (s.length > 255) throw new Error('site name too long')
    return Uint8Array.of(op, s.length, ...s)
  }

  /** The key's x-only public key, hex, once the owner lets `site` see it on maki. */
  async publicKey(site: string): Promise<string> {
    const a = await this.ask(Nostr.site(1, site))
    if (a.length !== 32) throw new Error('maki’s Nostr app answered oddly')
    return hex(a)
  }

  /** `event`, signed on maki once the owner has seen it: its id (the app's own), key and signature. */
  async sign(site: string, event: UnsignedEvent): Promise<SignedEvent> {
    const enc = new TextEncoder()
    const tags = enc.encode(JSON.stringify(event.tags))
    const content = enc.encode(event.content)
    const head = new DataView(new ArrayBuffer(12))
    head.setBigUint64(0, BigInt(event.created_at))
    head.setUint32(8, event.kind)
    const len = (n: number): Uint8Array => {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setUint32(0, n)
      return b
    }
    const msg = Uint8Array.from([
      ...Nostr.site(2, site),
      ...new Uint8Array(head.buffer),
      ...len(tags.length),
      ...tags,
      ...len(content.length),
      ...content
    ])
    const a = await this.ask(msg)
    if (a.length !== 96) throw new Error('maki’s Nostr app answered oddly')
    const pubkey = await this.publicKey(site)
    return { ...event, id: hex(a.subarray(0, 32)), pubkey, sig: hex(a.subarray(32)) }
  }

  /** One NIP-07 call from `site`, as the extension passes it on. */
  async request(site: string, method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getPublicKey':
        return this.publicKey(site)
      case 'signEvent':
        return this.sign(site, readEvent(params[0]))
      case 'getRelays':
        return {}
      default:
        throw new Error(`maki doesn’t do ${method}`)
    }
  }
}
