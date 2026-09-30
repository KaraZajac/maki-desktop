/**
 * NIP-46: maki desktop's bunker, with nostr-tools' own client (BunkerSigner) as the app, over a
 * relay of the test's own (ws). First with a stand-in for maki's Nostr app, for the bunker's rules;
 * then the whole way: the link, and the Nostr app on the fake maki, which asks and signs.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, nip04, verifyEvent } from 'nostr-tools'
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'nostr-tools/nip46'
import { SimplePool } from 'nostr-tools/pool'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket as Ws, WebSocketServer } from 'ws'
import { Link } from './link'
import {
  Bunker,
  KIND,
  newState,
  parseNostrConnect,
  readState,
  siteFor,
  type NostrSigner
} from './nip46'
import type { SignedEvent, UnsignedEvent } from './nostr'
import { signEvent } from './nostr-events'
import type { OpenSocket, RelaySocket } from './relay'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

type Filter = {
  kinds?: number[]
  authors?: string[]
  '#p'?: string[]
  since?: number
  limit?: number
}

/** A relay of the test's own: it keeps what it's sent, and passes each event to whoever asked for it. */
async function relay(): Promise<{
  url: string
  events: SignedEvent[]
  listening: (pubkey: string) => Promise<void>
  close: () => void
}> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(wss, 'listening')
  const events: SignedEvent[] = []
  const subs = new Map<Ws, Map<string, Filter[]>>()
  const matches = (f: Filter, e: SignedEvent): boolean =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))) &&
    (!f.since || e.created_at >= f.since)
  wss.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as unknown[]
      if (m[0] === 'REQ') {
        const [, id, ...filters] = m as [string, string, ...Filter[]]
        subs.get(ws)!.set(id, filters)
        for (const e of events)
          if (filters.some((f) => f.limit !== 0 && matches(f, e)))
            ws.send(JSON.stringify(['EVENT', id, e]))
        ws.send(JSON.stringify(['EOSE', id]))
      } else if (m[0] === 'EVENT') {
        const e = m[1] as SignedEvent
        events.push(e)
        ws.send(JSON.stringify(['OK', e.id, true, '']))
        for (const [c, s] of subs)
          for (const [id, filters] of s)
            if (filters.some((f) => matches(f, e))) c.send(JSON.stringify(['EVENT', id, e]))
      } else if (m[0] === 'CLOSE') subs.get(ws)?.delete(m[1] as string)
    })
    ws.on('close', () => subs.delete(ws))
  })
  const port = (wss.address() as { port: number }).port
  /** once someone's asked for events to `pubkey` */
  const listening = async (pubkey: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (
        [...subs.values()].some((s) =>
          [...s.values()].some((fs) => fs.some((f) => f['#p']?.includes(pubkey)))
        )
      )
        return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`no one listens for ${pubkey}`)
  }
  return { url: `ws://127.0.0.1:${port}`, events, listening, close: () => wss.close() }
}

/** maki's Nostr app, stood in for: a key, and the sites its owner has let see it (or not). */
function standIn(say = true): NostrSigner & { asked: string[]; secret: Uint8Array } {
  const secret = generateSecretKey()
  const allowed = new Set<string>()
  const asked: string[] = []
  return {
    secret,
    asked,
    async publicKey(site) {
      if (!allowed.has(site)) {
        asked.push(site)
        if (!say) throw new Error('rejected on maki')
        allowed.add(site)
      }
      return getPublicKey(secret)
    },
    async sign(site, e: UnsignedEvent) {
      if (!allowed.has(site)) throw new Error('not allowed')
      asked.push(`sign ${e.kind}`)
      return signEvent(secret, e)
    }
  }
}

const open: OpenSocket = (url) => new Ws(url) as unknown as RelaySocket
const stop: (() => void)[] = []
afterEach(() => {
  while (stop.length) stop.pop()!()
})

async function bunkerOn(url: string, signer: NostrSigner): Promise<Bunker> {
  const b = new Bunker(newState([url]), signer, () => {}, open)
  b.start()
  stop.push(() => b.stop())
  for (let i = 0; i < 50 && b.relays[0]?.state !== 'open'; i++)
    await new Promise((r) => setTimeout(r, 50))
  expect(b.relays[0].state).toBe('open')
  return b
}

function app(): { pool: SimplePool; secret: Uint8Array } {
  const pool = new SimplePool()
  stop.push(() => pool.destroy())
  return { pool, secret: generateSecretKey() }
}

describe('the bunker', () => {
  it('reads links, and keeps its state', () => {
    const c = parseNostrConnect(
      `nostrconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=s3&name=Coracle`
    )
    expect(c).toEqual({
      pubkey: 'a'.repeat(64),
      relays: ['wss://relay.example'],
      secret: 's3',
      name: 'Coracle',
      url: ''
    })
    expect(
      parseNostrConnect(`nostrconnect://${'a'.repeat(64)}?relay=http%3A%2F%2Fx&secret=s`)
    ).toBeNull()
    expect(parseNostrConnect(`nostrconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Fx`)).toBeNull()
    expect(siteFor('', 'https://coracle.social/app', 'b'.repeat(64))).toBe('remote coracle.social')
    expect(siteFor('', '', 'b'.repeat(64))).toBe('remote bbbbbbbb')
    const s = newState(['wss://relay.example'])
    expect(readState(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(readState({ ...s, secret: 'nope' })).toBeNull()
  })

  it('lets an app with its link connect, once maki’s owner says so, and signs for it on maki', async () => {
    const r = await relay()
    stop.push(r.close)
    const maki = standIn()
    const bunker = await bunkerOn(r.url, maki)
    const { pool, secret } = app()
    const bp = (await parseBunkerInput(bunker.uri()))!
    expect(bp).toMatchObject({ pubkey: bunker.pubkey, relays: [r.url] })
    const signer = BunkerSigner.fromBunker(secret, bp, { pool })
    await signer.connect({ name: 'Coracle', url: 'https://coracle.social' })
    expect(maki.asked).toEqual(['remote Coracle'])
    expect(bunker.clients.map((c) => [c.name, c.site])).toEqual([['Coracle', 'remote Coracle']])
    expect(await signer.getPublicKey()).toBe(getPublicKey(maki.secret))
    await signer.ping()
    const now = Math.floor(Date.now() / 1000)
    const event = await signer.signEvent({
      kind: 1,
      created_at: now,
      tags: [['t', 'maki']],
      content: 'hello from maki'
    })
    expect(verifyEvent(event)).toBe(true)
    expect(event).toMatchObject({ pubkey: getPublicKey(maki.secret), content: 'hello from maki' })
    await expect(signer.nip44Encrypt(getPublicKey(secret), 'hi')).rejects.toMatch(/doesn’t encrypt/)
    // everything on the relay between them is encrypted: none of it says the note
    expect(
      r.events.filter((e) => e.kind === KIND).some((e) => e.content.includes('hello from maki'))
    ).toBe(false)

    // the link was good for one app: another with it isn't let in, and maki isn't asked
    const other = app()
    const theirs = BunkerSigner.fromBunker(other.secret, bp, { pool: other.pool })
    await expect(theirs.connect({ name: 'Snoop' })).rejects.toMatch(/not a secret/)
    expect(maki.asked).toEqual(['remote Coracle', 'sign 1'])
    // removed, the app is let in no more
    bunker.revoke(getPublicKey(secret))
    await expect(
      signer.signEvent({ kind: 1, created_at: now, tags: [], content: 'again' })
    ).rejects.toMatch(/connect first/)
  })

  it('doesn’t let an app in when maki’s owner says no', async () => {
    const r = await relay()
    stop.push(r.close)
    const bunker = await bunkerOn(r.url, standIn(false))
    const { pool, secret } = app()
    const signer = BunkerSigner.fromBunker(secret, (await parseBunkerInput(bunker.uri()))!, {
      pool
    })
    await expect(signer.connect({ name: 'Coracle' })).rejects.toMatch(/rejected on maki/)
    expect(bunker.clients).toEqual([])
  })

  it('connects to an app by its own link (nostrconnect://)', async () => {
    const r = await relay()
    stop.push(r.close)
    const maki = standIn()
    const bunker = await bunkerOn(r.url, maki)
    const { pool, secret } = app()
    const uri = createNostrConnectURI({
      clientPubkey: getPublicKey(secret),
      relays: [r.url],
      secret: 'c0ffee',
      name: 'Nostrudel'
    })
    const waiting = BunkerSigner.fromURI(secret, uri, { pool }, 10_000)
    // the owner pastes the app's link once the app is waiting: it listens for new events alone
    await r.listening(getPublicKey(secret))
    const client = await bunker.connect(uri)
    expect(client).toMatchObject({ name: 'Nostrudel', site: 'remote Nostrudel', relays: [r.url] })
    const signer = await waiting
    expect(signer.bp.pubkey).toBe(bunker.pubkey)
    expect(await signer.getPublicKey()).toBe(getPublicKey(maki.secret))
    const e = await signer.signEvent({
      kind: 7,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: '+'
    })
    expect(verifyEvent(e)).toBe(true)
  })

  it('answers an older app in NIP-04, as it asked', async () => {
    const r = await relay()
    stop.push(r.close)
    const bunker = await bunkerOn(r.url, standIn())
    const secret = generateSecretKey()
    const ws = new Ws(r.url)
    await once(ws, 'open')
    stop.push(() => ws.close())
    const answers: string[] = []
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m[0] === 'EVENT' && m[2].pubkey === bunker.pubkey)
        answers.push(nip04.decrypt(secret, bunker.pubkey, m[2].content))
    })
    ws.send(JSON.stringify(['REQ', 'a', { kinds: [KIND], '#p': [getPublicKey(secret)] }]))
    const secretOf = new URL(bunker.uri()).searchParams.get('secret')!
    const request = JSON.stringify({
      id: 'r1',
      method: 'connect',
      params: [bunker.pubkey, secretOf]
    })
    const e = finalizeEvent(
      {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', bunker.pubkey]],
        content: nip04.encrypt(secret, bunker.pubkey, request)
      },
      secret
    )
    ws.send(JSON.stringify(['EVENT', e]))
    for (let i = 0; i < 50 && answers.length === 0; i++)
      await new Promise((res) => setTimeout(res, 50))
    expect(JSON.parse(answers[0])).toEqual({ id: 'r1', result: 'ack' })
    // the same request again (a relay's echo, or a replay) isn't answered twice; an old one not at all
    ws.send(JSON.stringify(['EVENT', e]))
    const old = finalizeEvent(
      { ...e, created_at: e.created_at - 3600, tags: [['p', bunker.pubkey]] },
      secret
    )
    ws.send(JSON.stringify(['EVENT', old]))
    await new Promise((res) => setTimeout(res, 300))
    expect(answers.length).toBe(1)
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'the bunker, the link and maki’s Nostr app on the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    afterAll(() => fake?.proc.kill())

    it('signs an app’s event with maki’s Nostr key, once the owner lets the app see it', async () => {
      fake = await startFake(['--app', join(APP_FIXTURES, 'nostr.maki')])
      const said: string[] = []
      fake.proc.stdout!.on('data', (d: Buffer) => said.push(d.toString()))
      const link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      stop.push(() => link.drop())
      const r = await relay()
      stop.push(r.close)
      const bunker = await bunkerOn(r.url, link.nostr)
      const { pool, secret } = app()
      const signer = BunkerSigner.fromBunker(secret, (await parseBunkerInput(bunker.uri()))!, {
        pool
      })
      await signer.connect({ name: 'Coracle' })
      expect(said.join('')).toMatch(/Let it see your Nostr key\? remote Coracle as npub1/)
      // the BIP39 test phrase's Nostr key (maki's Nostr app's), as NIP-07 sites get it
      const key = await signer.getPublicKey()
      expect(key).toBe(await link.nostr.publicKey('remote Coracle'))
      const event = await signer.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'signed on maki'
      })
      expect(verifyEvent(event)).toBe(true)
      expect(event.pubkey).toBe(key)
      expect(schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(key))).toBe(
        true
      )
      expect(bytesToHex(hexToBytes(event.id))).toBe(event.id)
    })
  }
)
