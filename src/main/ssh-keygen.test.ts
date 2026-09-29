/**
 * maki-ssh-keygen: signing whole, against a stand-in for maki's SSH app, checked by ssh-keygen
 * itself; what isn't maki's left to ssh-keygen; then the whole way, git signing a commit through
 * maki desktop's socket and the link to the SSH app on the fake maki, and checking it.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SSH_APP } from '../shared/bridge-types'
import { Link } from '../shared/link'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { askOver, type AskApp } from './age-plugin'
import { forWindow, serveBridge } from './bridge'
import { keyBlob, makiKeys, runSshKeygen, signWhole } from './ssh-keygen'

const SSH_KEYGEN = (() => {
  for (const dir of (process.env.PATH ?? '').split(':'))
    if (dir && existsSync(join(dir, 'ssh-keygen'))) return join(dir, 'ssh-keygen')
  return null
})()
const GIT = (() => {
  for (const dir of (process.env.PATH ?? '').split(':'))
    if (dir && existsSync(join(dir, 'git'))) return join(dir, 'git')
  return null
})()

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const str = (b: Uint8Array): Buffer => Buffer.concat([u32(b.length), b])

/** A stand-in for maki's SSH app: an Ed25519 key here, answering as the app does. */
function standIn(): { ask: AskApp; blob: Buffer; line: string; asked: string[] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const blob = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(pub)])
  const asked: string[] = []
  let whole: Buffer[] = []
  const ask: AskApp = async (m) => {
    const b = Buffer.from(m)
    const kind = b[4]
    if (kind === 11)
      return {
        status: 'approved',
        answer: Buffer.concat([Buffer.from([12]), u32(1), str(blob), str(Buffer.from('maki'))])
      }
    if (kind !== 240) return { status: 'approved', answer: Buffer.from([5]) }
    const nsLen = b.readUInt32BE(5)
    const ns = b.subarray(9, 9 + nsLen)
    const total = b.readUInt32BE(9 + nsLen)
    const at = b.readUInt32BE(13 + nsLen)
    if (at === 0) whole = []
    whole.push(b.subarray(17 + nsLen))
    if (at + b.length - (17 + nsLen) < total)
      return { status: 'approved', answer: Buffer.from([6]) }
    const message = Buffer.concat(whole)
    asked.push(message.toString('utf8').split('\n\n')[1]?.split('\n')[0] ?? '')
    const data = Buffer.concat([
      Buffer.from('SSHSIG'),
      str(ns),
      str(Buffer.alloc(0)),
      str(Buffer.from('sha512')),
      str(createHash('sha512').update(message).digest())
    ])
    const sig = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(sign(null, data, privateKey))])
    return { status: 'approved', answer: Buffer.concat([Buffer.from([14]), str(sig)]) }
  }
  return { ask, blob, line: `ssh-ed25519 ${blob.toString('base64')} maki`, asked }
}

describe('maki-ssh-keygen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maki-keygen-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const run = async (
    args: string[],
    app: AskApp
  ): Promise<{ code: number; err: string; passed: string[][] }> => {
    let err = ''
    const passed: string[][] = []
    const code = await runSshKeygen(['--maki-ssh-keygen', ...args], {
      input: [],
      output: () => {},
      error: (l) => (err += `${l}\n`),
      ask: app,
      sshKeygen: async (a) => {
        passed.push(a)
        return 0
      }
    })
    return { code, err, passed }
  }

  it('reads keys as OpenSSH writes them, git’s literal ones too', () => {
    const app = standIn()
    expect(Buffer.from(keyBlob(app.line)!)).toEqual(app.blob)
    expect(Buffer.from(keyBlob(`key::${app.line}`)!)).toEqual(app.blob)
    expect(keyBlob('not a key')).toBeNull()
  })

  it.skipIf(!SSH_KEYGEN)(
    'signs a commit whole with maki’s key, as ssh-keygen -Y sign does',
    async () => {
      const app = standIn()
      const key = join(dir, 'key.pub')
      writeFileSync(key, `${app.line}\n`)
      const commit = join(dir, 'commit')
      const body = `tree ${'a'.repeat(40)}\nauthor Kara <kara@example.org> 1790000000 +0000\ncommitter Kara <kara@example.org> 1790000000 +0000\n\nFix the fee\n\n${'more '.repeat(2000)}`
      writeFileSync(commit, body)
      const r = await run(['-Y', 'sign', '-n', 'git', '-f', key, '-U', commit], app.ask)
      expect(r.code, r.err).toBe(0)
      expect(r.passed).toEqual([])
      expect(app.asked).toEqual(['Fix the fee'])
      // ssh-keygen itself takes it: this key's, for git, of this message
      const checked = execFileSync(
        SSH_KEYGEN!,
        ['-Y', 'check-novalidate', '-n', 'git', '-s', `${commit}.sig`],
        {
          input: body,
          encoding: 'utf8'
        }
      )
      expect(checked).toContain('Good "git" signature with ED25519 key')
      expect(() =>
        execFileSync(SSH_KEYGEN!, ['-Y', 'check-novalidate', '-n', 'git', '-s', `${commit}.sig`], {
          input: `${body}!`,
          stdio: 'pipe'
        })
      ).toThrow()
    }
  )

  it('leaves to ssh-keygen what isn’t signing with maki’s key', async () => {
    const app = standIn()
    const other = join(dir, 'other.pub')
    writeFileSync(other, `${standIn().line}\n`)
    const file = join(dir, 'f')
    writeFileSync(file, 'x')
    // another key; checking a signature; finding who signed
    for (const args of [
      ['-Y', 'sign', '-n', 'git', '-f', other, file],
      ['-Y', 'verify', '-f', 'allowed', '-I', 'kara', '-n', 'git', '-s', 'f.sig'],
      ['-Y', 'find-principals', '-f', 'allowed', '-s', 'f.sig']
    ]) {
      const r = await run(args, app.ask)
      expect(r.passed).toEqual([args])
    }
    expect(app.asked).toEqual([])
  })

  it('refuses when maki says no', async () => {
    const key = join(dir, 'k.pub')
    const app = standIn()
    writeFileSync(key, app.line)
    const no: AskApp = async (m) =>
      m[4] === 11
        ? app.ask(m)
        : { status: 'approved', answer: Uint8Array.of(m.length > 20 && m[4] === 240 ? 5 : 5) }
    const file = join(dir, 'g')
    writeFileSync(file, 'x')
    const r = await run(['-Y', 'sign', '-n', 'git', '-f', key, file], no)
    expect(r.code).toBe(255)
    expect(r.err).toContain('maki didn’t sign it')
    await expect(signWhole(no, app.blob, 'git', new Uint8Array(1))).rejects.toThrow()
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE || !SSH_KEYGEN || !GIT)(
  'git signing through maki-ssh-keygen, the link and the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let link: Link
    let server: Server
    const dir = mkdtempSync(join(tmpdir(), 'maki-git-'))
    const socket = join(dir, 'maki.sock')
    const git = (
      args: string[],
      cwd: string
    ): Promise<{ out: string; err: string; code: number }> =>
      new Promise((ok) =>
        execFile(
          GIT!,
          args,
          {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
          },
          (e, out, err) => ok({ out, err, code: e ? ((e as { code?: number }).code ?? 1) : 0 })
        )
      )

    beforeAll(async () => {
      fake = await startFake()
      link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'ssh.maki')))
      expect(await link.appInstall('SSH', bundle)).toMatchObject({ approval: 'approved' })
      server = await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), socket)
      // maki-ssh-keygen as git starts it: a script, running its code under node
      writeFileSync(
        join(dir, 'entry.ts'),
        `import { askOver } from ${JSON.stringify(resolve(__dirname, 'age-plugin'))}\n` +
          `import { runSshKeygen, sshKeygenOnPath } from ${JSON.stringify(resolve(__dirname, 'ssh-keygen'))}\n` +
          `runSshKeygen(['--maki-ssh-keygen', ...process.argv.slice(2)], { input: process.stdin, output: (b) => process.stdout.write(b), error: (l) => process.stderr.write(l + '\\n'), ask: askOver(${JSON.stringify(socket)}, ${JSON.stringify(SSH_APP)}), sshKeygen: sshKeygenOnPath }).then((c) => process.exit(c))\n`
      )
      await build({
        entryPoints: [join(dir, 'entry.ts')],
        outfile: join(dir, 'keygen.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      mkdirSync(join(dir, 'bin'))
      writeFileSync(
        join(dir, 'bin', 'maki-ssh-keygen'),
        `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'keygen.cjs')}' "$@"\n`
      )
      chmodSync(join(dir, 'bin', 'maki-ssh-keygen'), 0o755)
    })
    afterAll(() => {
      server?.close()
      link?.drop()
      fake?.proc.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it('signs a commit with maki’s key, which git checks', async () => {
      const [blob] = await makiKeys(askOver(socket, SSH_APP))
      const key = `ssh-ed25519 ${Buffer.from(blob).toString('base64')}`
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      writeFileSync(join(dir, 'allowed'), `kara@soulstone.org ${key}\n`)
      for (const args of [
        ['init', '-q'],
        ['config', 'user.name', 'Kara Zajac'],
        ['config', 'user.email', 'kara@soulstone.org'],
        ['config', 'gpg.format', 'ssh'],
        ['config', 'gpg.ssh.program', join(dir, 'bin', 'maki-ssh-keygen')],
        ['config', 'gpg.ssh.allowedSignersFile', join(dir, 'allowed')],
        ['config', 'user.signingkey', `key::${key} maki`]
      ])
        expect((await git(args, repo)).code).toBe(0)
      writeFileSync(join(repo, 'README'), 'maki\n')
      await git(['add', 'README'], repo)
      const committed = await git(['commit', '-q', '-S', '-m', 'Fix the fee’s rounding'], repo)
      expect(committed.code, committed.err).toBe(0)
      const verified = await git(['verify-commit', 'HEAD'], repo)
      expect(verified.code, verified.err).toBe(0)
      expect(verified.err).toContain('Good "git" signature for kara@soulstone.org')
      // and a tag
      expect((await git(['tag', '-s', 'v1.0', '-m', 'maki 1.0'], repo)).code).toBe(0)
      expect((await git(['verify-tag', 'v1.0'], repo)).err).toContain('Good "git" signature')
    })
  }
)
