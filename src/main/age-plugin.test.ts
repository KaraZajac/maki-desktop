/**
 * age-plugin-maki: its stanzas, its identities, and both state machines against a stand-in for
 * maki's Age app; then, with the real age (on the PATH, or MAKI_AGE), the whole way: the plugin
 * run as age runs it, through maki desktop's socket and the link, to the Age app on the fake maki.
 */
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import {
  askOver,
  identityOf,
  publicOfIdentity,
  recipientOf,
  runAgePlugin,
  stanza,
  StanzaReader,
  unb64,
  wrap,
  type AskApp
} from './age-plugin'
import { forWindow, serveBridge } from './bridge'

const AGE =
  process.env.MAKI_AGE ??
  (() => {
    for (const dir of (process.env.PATH ?? '').split(':'))
      if (dir && existsSync(join(dir, 'age'))) return join(dir, 'age')
    return null
  })()

/** A stand-in for maki's Age app: an X25519 key here, answering as the app does. */
function standIn(say: 'yes' | 'no' = 'yes'): { ask: AskApp; public: Uint8Array; asked: string[] } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  const asked: string[] = []
  const unwrap = (share: Uint8Array, body: Uint8Array): Uint8Array | null => {
    try {
      const peer = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), share]),
        format: 'der',
        type: 'spki'
      })
      const shared = diffieHellman({ privateKey, publicKey: peer })
      const key = Buffer.from(
        hkdfSync('sha256', shared, Buffer.concat([share, pub]), 'age-encryption.org/v1/X25519', 32)
      )
      const d = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 })
      d.setAuthTag(body.subarray(16))
      return new Uint8Array(Buffer.concat([d.update(body.subarray(0, 16)), d.final()]))
    } catch {
      return null
    }
  }
  const ask: AskApp = async (m) => {
    const answer = (bytes: number[]): { status: string; answer: Uint8Array } => ({
      status: 'approved',
      answer: Uint8Array.from(bytes)
    })
    if (m[0] === 1) return answer([0, ...pub])
    if (m[0] === 2) {
      for (let i = 0; i < m[1]; i++) {
        const at = 2 + i * 64
        if (unwrap(m.subarray(at, at + 32), m.subarray(at + 32, at + 64))) return answer([0, i])
      }
      return answer([4])
    }
    const key = unwrap(m.subarray(1, 33), m.subarray(33, 65))
    if (!key) return answer([4])
    asked.push(Buffer.from(m.subarray(66)).toString())
    return say === 'yes' ? answer([0, ...key]) : answer([1])
  }
  return { ask, public: pub, asked }
}

/** Runs a state machine as age would: what age sends first, then an "ok" for each command. */
async function drive(
  machine: string,
  phase1: string,
  ask: AskApp
): Promise<{ stanzas: { tag: string; args: string[]; body: Uint8Array }[]; code: number }> {
  const input = new PassThrough()
  const output = new PassThrough()
  const reader = new StanzaReader(output)
  const stanzas: { tag: string; args: string[]; body: Uint8Array }[] = []
  const done = runAgePlugin([`--age-plugin=${machine}`], { input, output, error: () => {}, ask })
  input.write(phase1)
  for (;;) {
    const s = await reader.next()
    stanzas.push(s)
    if (s.tag === 'done') break
    input.write(stanza('ok'))
  }
  return { stanzas, code: await done }
}

describe('age-plugin-maki', () => {
  it('writes stanzas as age does: base64 bodies in lines of 64, the last one shorter', async () => {
    expect(stanza('done')).toBe('-> done\n\n')
    const long = stanza('file-key', ['0'], new Uint8Array(48))
    expect(long.split('\n').map((l) => l.length)).toEqual([13, 64, 0, 0])
    const input = new PassThrough()
    const reader = new StanzaReader(input)
    input.write(
      stanza('recipient-stanza', ['0', 'X25519', 'abc'], new Uint8Array(32).fill(7)) + long
    )
    expect(await reader.next()).toEqual({
      tag: 'recipient-stanza',
      args: ['0', 'X25519', 'abc'],
      body: new Uint8Array(32).fill(7)
    })
    expect((await reader.next()).body).toEqual(new Uint8Array(48))
    // canonical, unpadded base64 only
    expect(unb64('AAA')).toEqual(new Uint8Array(2))
    for (const bad of ['AAA=', 'AAB', 'A', '!!!!']) expect(unb64(bad)).toBeNull()
  })

  it('gives up when maki desktop goes away before maki answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maki-ask-'))
    const path = join(dir, 'gone.sock')
    // takes the request, then quits without an answer
    const server = createServer((c) => c.once('data', () => c.destroy()))
    await new Promise<void>((ok) => server.listen(path, ok))
    try {
      await expect(askOver(path)(new Uint8Array([1]))).rejects.toThrow('went away')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names maki’s key in an identity, and its recipient is an ordinary one', () => {
    const key = new Uint8Array(32).fill(1)
    const identity = identityOf(key)
    expect(identity).toMatch(/^AGE-PLUGIN-MAKI-1[0-9A-Z]+$/)
    expect(publicOfIdentity(identity)).toEqual(key)
    expect(publicOfIdentity(identity.toLowerCase())).toEqual(key)
    expect(publicOfIdentity('AGE-PLUGIN-YUBIKEY-1QQQQ')).toBeNull()
    expect(recipientOf(key)).toMatch(/^age1[0-9a-z]{58}$/)
  })

  it('unwraps the file key of the stanza that is maki’s, once maki says yes', async () => {
    const maki = standIn()
    const fileKey = randomBytes(16)
    const theirs = wrap(fileKey, standIn().public)
    const ours = wrap(fileKey, maki.public)
    const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/=+$/, '')
    const phase1 =
      stanza('add-identity', [identityOf(maki.public)]) +
      stanza('recipient-stanza', ['0', 'X25519', b64(theirs.share)], theirs.body) +
      stanza('recipient-stanza', ['0', 'X25519', b64(ours.share)], ours.body) +
      stanza('recipient-stanza', ['0', 'scrypt', 'salt', '18'], new Uint8Array(32)) +
      stanza('grease-me', ['x']) +
      stanza('done')
    const { stanzas, code } = await drive('identity-v1', phase1, maki.ask)
    expect(code).toBe(0)
    expect(stanzas.map((s) => s.tag)).toEqual(['msg', 'file-key', 'done'])
    expect(stanzas[1]).toMatchObject({ args: ['0'], body: new Uint8Array(fileKey) })
    expect(maki.asked).toHaveLength(1)

    // maki says no: age hears why, and gets no file key
    const no = standIn('no')
    const again = wrap(fileKey, no.public)
    const said = await drive(
      'identity-v1',
      stanza('add-identity', [identityOf(no.public)]) +
        stanza('recipient-stanza', ['0', 'X25519', b64(again.share)], again.body) +
        stanza('done'),
      no.ask
    )
    expect(said.stanzas.map((s) => s.tag)).toEqual(['msg', 'error', 'done'])
    expect(Buffer.from(said.stanzas[1].body).toString()).toBe('you said no on maki')

    // a file for someone else: nothing, and nobody's asked
    const other = await drive(
      'identity-v1',
      stanza('add-identity', [identityOf(maki.public)]) +
        stanza('recipient-stanza', ['0', 'X25519', b64(theirs.share)], theirs.body) +
        stanza('done'),
      maki.ask
    )
    expect(other.stanzas.map((s) => s.tag)).toEqual(['done'])
    // a stanza that isn't one: an error for it, before anything is tried
    const broken = await drive(
      'identity-v1',
      stanza('add-identity', [identityOf(maki.public)]) +
        stanza('recipient-stanza', ['0', 'X25519', 'AAA'], ours.body) +
        stanza('done'),
      maki.ask
    )
    expect(broken.stanzas.map((s) => [s.tag, ...s.args])).toEqual([
      ['error', 'stanza', '0', '0'],
      ['done']
    ])
  })

  it('wraps a file key to the identity’s key, as age’s own X25519 recipient would', async () => {
    const maki = standIn()
    const fileKey = randomBytes(16)
    const { stanzas } = await drive(
      'recipient-v1',
      stanza('add-identity', [identityOf(maki.public)]) +
        stanza('wrap-file-key', [], fileKey) +
        stanza('extension-labels') +
        stanza('done'),
      maki.ask
    )
    expect(stanzas.map((s) => [s.tag, s.args[0], s.args[1]])).toEqual([
      ['recipient-stanza', '0', 'X25519'],
      ['done', undefined, undefined]
    ])
    // the stand-in unwraps it: it's for maki's key
    const s = stanzas[0]
    const r = await maki.ask(
      Uint8Array.from([3, ...unb64(s.args[2])!, ...s.body, 3, ...Buffer.from('age')])
    )
    expect(r.answer.subarray(1)).toEqual(new Uint8Array(fileKey))
  })
})

describe.skipIf(!AGE || !FAKE_BUILT || !APP_FIXTURES_THERE)(
  'age-plugin-maki with age, the link and the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let link: Link
    let server: Server
    const dir = mkdtempSync(join(tmpdir(), 'maki-age-'))
    const bin = join(dir, 'bin')
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir }
    const run = (
      cmd: string,
      args: string[],
      input?: string
    ): Promise<{ out: string; err: string; code: number }> =>
      new Promise((ok) => {
        const p = execFile(cmd, args, { env, encoding: 'utf8' }, (e, out, err) =>
          ok({ out, err, code: e ? ((e as { code?: number }).code ?? 1) : 0 })
        )
        if (input !== undefined) p.stdin!.end(input)
      })

    beforeAll(async () => {
      fake = await startFake()
      link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'age.maki')))
      expect(await link.appInstall('Age', bundle)).toMatchObject({ approval: 'approved' })
      server = await serveBridge(
        async (r) => link.fromBrowser(await forWindow(r)),
        join(dir, `maki-${userInfo().uid}.sock`)
      )
      // the plugin as age starts it: a script on the PATH, running the plugin's code under node
      writeFileSync(
        join(dir, 'entry.ts'),
        `import { askOver, runAgePlugin } from ${JSON.stringify(resolve(__dirname, 'age-plugin'))}\n` +
          `import { socketPath } from ${JSON.stringify(resolve(__dirname, 'bridge'))}\n` +
          `runAgePlugin(process.argv, { input: process.stdin, output: process.stdout, error: (l) => process.stderr.write(l + '\\n'), ask: askOver(socketPath()) }).then((c) => process.exit(c))\n`
      )
      await build({
        entryPoints: [join(dir, 'entry.ts')],
        outfile: join(dir, 'plugin.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'age-plugin-maki'),
        `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'plugin.cjs')}' "$@"\n`
      )
      chmodSync(join(bin, 'age-plugin-maki'), 0o755)
    })
    afterAll(() => {
      server?.close()
      link?.drop()
      fake?.proc.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it('decrypts what age encrypted to maki’s recipient, and nothing that isn’t maki’s', async () => {
      const made = await run(join(bin, 'age-plugin-maki'), [])
      expect(made.code, made.err).toBe(0)
      const recipient = /# recipient: (age1[0-9a-z]+)/.exec(made.out)![1]
      expect((await run(join(bin, 'age-plugin-maki'), ['--recipient'])).out.trim()).toBe(recipient)
      writeFileSync(join(dir, 'maki.txt'), made.out)
      writeFileSync(join(dir, 'plain.txt'), 'a secret for maki\n')

      // encrypted with age as it is, to the recipient
      expect(
        (await run(AGE!, ['-r', recipient, '-o', join(dir, 'one.age'), join(dir, 'plain.txt')]))
          .code
      ).toBe(0)
      const one = await run(AGE!, ['-d', '-i', join(dir, 'maki.txt'), join(dir, 'one.age')])
      expect(one.err).toContain('maki: look at its screen')
      expect(one.out).toBe('a secret for maki\n')

      // encrypted to the identity (the plugin wraps it), and to someone else as well
      const keygen = join(AGE!, '..', 'age-keygen')
      const someone = existsSync(keygen) ? (await run(keygen, [])).out : null
      const other = someone ? /# public key: (age1[0-9a-z]+)/.exec(someone)![1] : null
      const two = [
        '-e',
        '-i',
        join(dir, 'maki.txt'),
        ...(other ? ['-r', other] : []),
        '-o',
        join(dir, 'two.age'),
        join(dir, 'plain.txt')
      ]
      expect((await run(AGE!, two)).code).toBe(0)
      expect((await run(AGE!, ['-d', '-i', join(dir, 'maki.txt'), join(dir, 'two.age')])).out).toBe(
        'a secret for maki\n'
      )

      // someone else's file: age hears nothing from maki, and says no identity matched
      if (other && someone) {
        expect(
          (await run(AGE!, ['-r', other, '-o', join(dir, 'three.age'), join(dir, 'plain.txt')]))
            .code
        ).toBe(0)
        const three = await run(AGE!, ['-d', '-i', join(dir, 'maki.txt'), join(dir, 'three.age')])
        expect(three.code).not.toBe(0)
        expect(three.err).toMatch(/no identity matched/)
        expect(three.err).not.toContain('look at its screen')
      }
    })
  }
)
