/**
 * Nostr through maki's Nostr app on the fake maki (maki's own app host): the key it shows sites,
 * worked out here apart from maki's code from the test phrase, and events it signs, their ids
 * checked against what every Nostr client computes (JSON.stringify, then SHA-256) for content
 * JSON has to escape, and their signatures with noble's BIP340.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { ChildProcess } from 'node:child_process'
import { hkdfSync, pbkdf2Sync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readBundle } from './bundle'
import { MakiClient } from './client'
import { Nostr, NOSTR_APP, readEvent } from './nostr'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

describe('events as sites hand them over', () => {
  it('takes what NIP-01 says an event is, and fills in the time', () => {
    expect(readEvent({ kind: 1, content: 'gm' }, () => 1_790_000_000)).toEqual({
      kind: 1,
      created_at: 1_790_000_000,
      tags: [],
      content: 'gm'
    })
    for (const bad of [
      null,
      { kind: -1 },
      { kind: 1.5 },
      { kind: 70000 },
      { kind: 1, tags: [[1]] },
      { kind: 1, content: 7 },
      { kind: 1, content: 'half \ud83c' }
    ]) {
      expect(() => readEvent(bad)).toThrow()
    }
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('Nostr, through maki’s Nostr app', () => {
  let fake: { port: number; proc: ChildProcess }
  let transport: TcpTransport
  let nostr: Nostr
  const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'nostr.maki')))

  beforeAll(async () => {
    fake = await startFake()
    transport = await TcpTransport.open(fake.port)
    const client = new MakiClient(transport)
    nostr = new Nostr((app, message) => client.appMessage(app, message))
    // not installed yet: the site hears why
    await expect(nostr.publicKey('example.com')).rejects.toThrow('isn’t installed')
    expect(await client.appInstall(bundle)).toEqual({ approval: 'approved', reason: '' })
  })
  afterAll(async () => {
    await transport?.close()
    fake?.proc.kill()
  })

  it('gives a site the key maki holds for the app, from the phrase, once maki says so', async () => {
    // the app's secret for "nostr": from the test phrase's seed, the app's ID and its developer
    const seed = pbkdf2Sync(
      Array(11).fill('abandon').concat('about').join(' '),
      'mnemonic',
      2048,
      64,
      'sha512'
    )
    const id = Buffer.from(NOSTR_APP)
    const developer = Buffer.from(readBundle(bundle).developer)
    const info = Buffer.concat([
      Buffer.from('app v1'),
      Buffer.from([id.length]),
      id,
      developer,
      Buffer.from([5]),
      Buffer.from('nostr')
    ])
    const secret = new Uint8Array(hkdfSync('sha256', seed, 'maki', info, 32))
    // tagged, as BIP340 tags its hashes, apart from the same label's Ed25519 key
    const tag = sha256(new TextEncoder().encode('maki/bip340'))
    const scalar = sha256(Uint8Array.from([...tag, ...tag, ...secret]))
    const key = await nostr.publicKey('example.com')
    expect(key).toBe(hex(schnorr.getPublicKey(scalar)))
    expect(await nostr.request('example.com', 'getRelays', [])).toEqual({})
    await expect(nostr.request('example.com', 'nip04.encrypt', [])).rejects.toThrow('doesn’t do')
  })

  it('signs events as every client hashes them, whatever JSON has to escape in them', async () => {
    const key = await nostr.publicKey('example.com')
    for (const content of [
      'gm',
      '',
      'said "maki"\n\ttab\\back\r\u0008\u000c and \u0001\u001f',
      'é 🍣 日本  '
    ]) {
      const event = {
        kind: 1,
        created_at: 1_790_000_000,
        tags: [
          ['t', 'maki'],
          ['p', key, 'wss://relay.example', 'a "quoted" name']
        ],
        content
      }
      const signed = await nostr.sign('example.com', event)
      expect(signed).toMatchObject({ ...event, pubkey: key })
      const id = hex(
        sha256(
          new TextEncoder().encode(
            JSON.stringify([0, key, event.created_at, event.kind, event.tags, event.content])
          )
        )
      )
      expect(signed.id).toBe(id)
      const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))
      expect(schnorr.verify(bytes(signed.sig), bytes(signed.id), bytes(key))).toBe(true)
    }
  })

  it('says when an event is too long for maki', async () => {
    await expect(
      nostr.sign('example.com', { kind: 1, created_at: 1, tags: [], content: 'x'.repeat(5000) })
    ).rejects.toThrow('too long')
  })
})
