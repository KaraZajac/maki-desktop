/**
 * maki-minisign: minisign's files, as minisign writes and reads them; the commands against a
 * stand-in for maki's Minisign app; then the whole way, through maki desktop's socket and the
 * link, to the Minisign app on the fake maki.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import {
  keyIdHex,
  MINISIGN_APP,
  parsePublicKey,
  parseSignature,
  publicKeyFile,
  publicKeyText,
  signatureFile,
  signRequest
} from '../shared/minisign'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { askOver, type AskApp } from './age-plugin'
import { forWindow, serveBridge } from './bridge'
import { hashFile, runMinisign } from './minisign'

/** A stand-in for maki's Minisign app: an Ed25519 key here, answering as the app does. */
function standIn(say: 'yes' | 'no' = 'yes'): { ask: AskApp; public: Uint8Array; id: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  const id = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
  const ask: AskApp = async (m) => {
    if (m[0] === 'P'.charCodeAt(0))
      return { status: 'approved', answer: Uint8Array.from([0, ...pub, ...id]) }
    if (say === 'no') return { status: 'approved', answer: Uint8Array.of(1) }
    const hash = m.subarray(1, 65)
    const n = m[73]
    const name = Buffer.from(m.subarray(74, 74 + n)).toString('utf8')
    const c = m[74 + n] | (m[75 + n] << 8)
    const theirs = Buffer.from(m.subarray(76 + n, 76 + n + c)).toString('utf8')
    const trusted = theirs || `timestamp:1790000000\tfile:${name}\thashed`
    const signature = sign(null, hash, privateKey as KeyObject)
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey)
    const len = Buffer.alloc(2)
    len.writeUInt16LE(Buffer.byteLength(trusted))
    return {
      status: 'approved',
      answer: new Uint8Array(
        Buffer.concat([Buffer.from([0]), id, signature, len, Buffer.from(trusted), global])
      )
    }
  }
  return { ask, public: pub, id }
}

/** The commands' output, and what they returned. */
async function minisign(
  args: string[],
  ask: AskApp
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runMinisign(['--maki-minisign', ...args], {
    output: (t) => (out += t),
    error: (l) => (err += `${l}\n`),
    ask
  })
  return { code, out, err }
}

describe('maki-minisign', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maki-minisign-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes and reads minisign’s files as minisign does', () => {
    const key = {
      public: new Uint8Array(32).fill(0xab),
      id: Uint8Array.from([0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe])
    }
    // an ID prints as a little-endian number
    expect(keyIdHex(key.id)).toBe('FEDCBA9876543210')
    const file = publicKeyFile(key)
    expect(file.split('\n')[0]).toBe('untrusted comment: minisign public key FEDCBA9876543210')
    expect(publicKeyText(key).startsWith('RWQ')).toBe(true)
    expect(parsePublicKey(file)).toEqual(key)
    expect(parsePublicKey(publicKeyText(key))).toEqual(key)
    expect(parsePublicKey('not a key')).toBeNull()
    const sig = {
      id: key.id,
      signature: new Uint8Array(64).fill(1),
      trusted: 'timestamp:1\tfile:a\thashed',
      global: new Uint8Array(64).fill(2)
    }
    const text = signatureFile(sig)
    expect(text.split('\n')[2]).toBe('trusted comment: timestamp:1\tfile:a\thashed')
    expect(parseSignature(text)).toMatchObject({
      ...sig,
      prehashed: true,
      untrusted: 'signature from maki'
    })
    // the app's request: the hash, the size, the name, and the signer's comment
    const m = signRequest(new Uint8Array(64).fill(9), 1234, 'a.txt', 'hi')
    expect(m.length).toBe(1 + 64 + 8 + 1 + 5 + 2 + 2)
    expect([m[0], m[65], m[66], m[73]]).toEqual(['S'.charCodeAt(0), 1234 & 0xff, 1234 >> 8, 5])
  })

  it('signs a file through the app, checks it, and catches a changed file or comment', async () => {
    const app = standIn()
    const file = join(dir, 'release.tar.gz')
    writeFileSync(file, 'the release\n'.repeat(1000))
    const signed = await minisign(['-Sm', file], app.ask)
    expect(signed.code, signed.err).toBe(0)
    const s = parseSignature(readFileSync(`${file}.minisig`, 'utf8'))!
    expect(s.trusted).toBe('timestamp:1790000000\tfile:release.tar.gz\thashed')
    // checked with maki's key, asked of the app, or with the key given
    const checked = await minisign(['-Vm', file], app.ask)
    expect(checked.code, checked.err).toBe(0)
    expect(checked.out).toBe(
      `Signature and comment signature verified\nTrusted comment: ${s.trusted}\n`
    )
    const pub = publicKeyText({ public: app.public, id: app.id })
    expect((await minisign(['-V', '-m', file, '-P', pub, '-Q'], app.ask)).out).toBe(
      `${s.trusted}\n`
    )
    // the public key, as minisign.pub
    const key = await minisign(['-R'], app.ask)
    expect(parsePublicKey(key.out)).toEqual({ public: app.public, id: app.id })
    // a changed file, or comment, isn't what was signed
    writeFileSync(file, 'the release, changed\n')
    expect((await minisign(['-Vm', file], app.ask)).err).toContain('doesn’t match the file')
    writeFileSync(file, 'the release\n'.repeat(1000))
    writeFileSync(
      `${file}.minisig`,
      signatureFile({ ...s, trusted: 'timestamp:1\tfile:other\thashed' })
    )
    expect((await minisign(['-Vm', file], app.ask)).err).toContain('trusted comment was changed')
    // a comment of the signer's, and a signature where it's asked for
    const own = await minisign(
      ['-S', '-m', file, '-t', 'release 1.0', '-x', join(dir, 'r.sig')],
      app.ask
    )
    expect(own.code, own.err).toBe(0)
    expect(parseSignature(readFileSync(join(dir, 'r.sig'), 'utf8'))!.trusted).toBe('release 1.0')
  })

  it('says why when maki doesn’t sign, and writes nothing', async () => {
    const file = join(dir, 'other.bin')
    writeFileSync(file, 'x')
    const r = await minisign(['-Sm', file], standIn('no').ask)
    expect(r.code).toBe(1)
    expect(r.err).toContain('you said no on maki')
    expect(() => readFileSync(`${file}.minisig`)).toThrow()
    expect((await minisign(['-S'], standIn().ask)).err).toContain('which file?')
  })

  it('hashes a file as minisign does: BLAKE2b-512', async () => {
    const file = join(dir, 'abc')
    writeFileSync(file, 'abc')
    const { hash, size } = await hashFile(file)
    expect(size).toBe(3)
    // RFC 7693's example: BLAKE2b-512("abc")
    expect(Buffer.from(hash).toString('hex')).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
    )
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'maki-minisign with the link and the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let link: Link
    let server: Server
    const dir = mkdtempSync(join(tmpdir(), 'maki-minisign-'))
    const socket = join(dir, 'maki.sock')

    beforeAll(async () => {
      fake = await startFake(['--clock-verified'])
      link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'minisign.maki')))
      expect(await link.appInstall('Minisign', bundle)).toMatchObject({ approval: 'approved' })
      server = await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), socket)
    })
    afterAll(() => {
      server?.close()
      link?.drop()
      fake?.proc.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it('signs with the key maki keeps, which minisign checks, and dates it by maki’s clock', async () => {
      const ask = askOver(socket, MINISIGN_APP)
      const file = join(dir, 'maki-0.2.0.tar.gz')
      writeFileSync(file, Buffer.alloc(100_000, 7))
      const signed = await minisign(['-Sm', file], ask)
      expect(signed.code, signed.err).toBe(0)
      const s = parseSignature(readFileSync(`${file}.minisig`, 'utf8'))!
      expect(s.trusted).toMatch(/^timestamp:\d{10}\tfile:maki-0\.2\.0\.tar\.gz\thashed$/)
      const checked = await minisign(['-Vm', file], ask)
      expect(checked.code, checked.err).toBe(0)
      // the same key every time: the public key file names its ID
      const key = parsePublicKey((await minisign(['-R'], ask)).out)!
      expect(s.id).toEqual(key.id)
    })
  }
)
