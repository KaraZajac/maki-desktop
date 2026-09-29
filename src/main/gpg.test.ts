/**
 * maki-gpg with GnuPG itself on the other side: maki's key exported and imported, what it signs
 * checked by gpg --verify, messages gpg encrypted to it opened, and git signing a commit through
 * it and checking it through gpg. Through maki desktop's socket and the link, to the OpenPGP app
 * on the fake maki.
 */
import { execFile, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import { crc24, OPENPGP_APP, packets, unarmour } from '../shared/openpgp'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { askOver } from './age-plugin'
import { forWindow, serveBridge } from './bridge'
import { runGpg } from './gpg'

const GPG = spawnSync('gpg', ['--version']).error === undefined
const GIT = spawnSync('git', ['--version']).error === undefined

describe('OpenPGP’s armour and packets', () => {
  it('checks armour with CRC-24, as RFC 4880 has it', () => {
    // the CRC of nothing is its initial value
    expect(crc24(new Uint8Array())).toBe(0xb704ce)
    const text = '-----BEGIN PGP MESSAGE-----\n\nAAECAw==\n=S0ch\n-----END PGP MESSAGE-----\n'
    expect(unarmour(new TextEncoder().encode(text))).toBeNull()
  })

  it('reads packets old and new, and partial lengths', () => {
    // an old-format literal packet of 3 bytes; a new-format one in partial lengths (2, then 1)
    expect(packets(Uint8Array.of(0xac, 3, 1, 2, 3)).map((p) => [p.tag, [...p.body]])).toEqual([
      [11, [1, 2, 3]]
    ])
    expect(packets(Uint8Array.of(0xcb, 0xe1, 7, 8, 1, 9)).map((p) => [p.tag, [...p.body]])).toEqual(
      [[11, [7, 8, 9]]]
    )
    expect(() => packets(Uint8Array.of(0xcb, 5, 1))).toThrow('cut short')
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE || !GPG)(
  'maki-gpg with gpg, the link and the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let link: Link
    let server: Server
    const dir = mkdtempSync(join(tmpdir(), 'maki-gpg-'))
    const home = join(dir, 'gnupg')
    const socket = join(dir, 'maki.sock')
    const env = {
      ...process.env,
      GNUPGHOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
    const tool = (
      cmd: string,
      args: string[],
      input?: string | Uint8Array,
      cwd?: string
    ): Promise<{ out: string; err: string; code: number }> =>
      new Promise((ok) => {
        const p = execFile(cmd, args, { env, cwd, encoding: 'utf8' }, (e, out, err) =>
          ok({ out, err, code: e ? ((e as { code?: number }).code ?? 1) : 0 })
        )
        p.stdin!.end(input === undefined ? '' : Buffer.from(input))
      })
    /** maki-gpg, in this process: what it wrote, its status lines, and what it returned. */
    const makiGpg = async (
      args: string[],
      input: string | Uint8Array = ''
    ): Promise<{ out: Buffer; status: string; err: string; code: number }> => {
      const out: Buffer[] = []
      let status = ''
      let err = ''
      const code = await runGpg(['--maki-gpg', ...args], {
        input: (async function* () {
          yield Buffer.from(input)
        })(),
        output: (b) => out.push(Buffer.from(b)),
        status: (_fd, line) => (status += `${line}\n`),
        error: (l) => (err += `${l}\n`),
        ask: askOver(socket, OPENPGP_APP),
        gpg: async (a, i) => (await tool('gpg', a, i)).code
      })
      return { out: Buffer.concat(out), status, err, code }
    }
    let fingerprint = ''

    beforeAll(async () => {
      mkdirSync(home, { mode: 0o700 })
      fake = await startFake(['--clock-verified'])
      link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'openpgp.maki')))
      expect(await link.appInstall('OpenPGP', bundle)).toMatchObject({ approval: 'approved' })
      server = await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), socket)
    })
    afterAll(async () => {
      server?.close()
      link?.drop()
      fake?.proc.kill()
      await tool('gpgconf', ['--kill', 'all'])
      rmSync(dir, { recursive: true, force: true })
    })

    it('names maki’s key, which gpg imports as its own name’s', async () => {
      expect((await makiGpg(['--export'])).err).toContain('no name yet')
      const named = await makiGpg(['--name', 'Kara Zajac <kara@example.org>'])
      expect(named.code, named.err).toBe(0)
      const key = await makiGpg(['--armor', '--export'])
      expect(key.code, key.err).toBe(0)
      expect(key.out.toString()).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----\n/)
      const imported = await tool('gpg', ['--batch', '--import'], key.out)
      expect(imported.code, imported.err).toBe(0)
      const listed = await tool('gpg', [
        '--batch',
        '--with-colons',
        '--list-keys',
        'kara@example.org'
      ])
      fingerprint = listed.out
        .split('\n')
        .find((l) => l.startsWith('fpr:'))!
        .split(':')[9]
      expect(listed.out).toContain('uid:-::::')
      expect(listed.out).toContain('Kara Zajac <kara@example.org>')
      // an ed25519 key that signs and certifies, and a cv25519 subkey that encrypts
      expect(listed.out).toMatch(/^pub:.*:22:.*:scESC:.*ed25519/m)
      expect(listed.out).toMatch(/^sub:.*:18:.*:e:.*cv25519/m)
      await tool('gpg', ['--batch', '--import-ownertrust'], `${fingerprint}:6:\n`)
    })

    it('signs what it’s given whole, which gpg verifies', async () => {
      const data = 'maki signs this, whole\n'.repeat(500)
      const signed = await makiGpg(['--status-fd=2', '-bsau', fingerprint], data)
      expect(signed.code, signed.err).toBe(0)
      // git looks for this line after another
      expect(signed.status).toContain(`\n[GNUPG:] SIG_CREATED D 22 8 00 `)
      writeFileSync(join(dir, 'data'), data)
      writeFileSync(join(dir, 'data.asc'), signed.out)
      const verified = await tool('gpg', [
        '--batch',
        '--verify',
        join(dir, 'data.asc'),
        join(dir, 'data')
      ])
      expect(verified.code, verified.err).toBe(0)
      expect(verified.err).toContain('Good signature from "Kara Zajac <kara@example.org>"')
      writeFileSync(join(dir, 'data'), `${data}!`)
      expect(
        (await tool('gpg', ['--batch', '--verify', join(dir, 'data.asc'), join(dir, 'data')])).code
      ).not.toBe(0)
      // another key isn't maki's: gpg's own, which has no secret for it here
      expect(
        (await makiGpg(['--status-fd=2', '-bsau', 'someone@example.org'], data)).code
      ).not.toBe(0)
    })

    it('opens messages gpg encrypted to maki’s key', async () => {
      for (const [message, armoured] of [
        ['a secret, sent to maki\n', true],
        ['another, in binary\n', false],
        ['a long one, streamed\n'.repeat(20_000), true]
      ] as const) {
        const encrypted = await new Promise<Buffer>((ok) => {
          const args = [
            '--batch',
            '--trust-model',
            'always',
            '--encrypt',
            '-r',
            'kara@example.org',
            ...(armoured ? ['--armor'] : [])
          ]
          const p = execFile('gpg', args, { env, encoding: 'buffer' }, (_e, out) => ok(out))
          p.stdin!.end(message)
        })
        expect(encrypted.length).toBeGreaterThan(0)
        const opened = await makiGpg(['--decrypt'], encrypted)
        expect(opened.code, opened.err).toBe(0)
        expect(opened.out.toString()).toBe(message)
      }
    })

    it.skipIf(!GIT)('signs a git commit, which git checks with gpg', async () => {
      writeFileSync(
        join(dir, 'entry.ts'),
        `import { writeSync } from 'node:fs'\n` +
          `import { askOver } from ${JSON.stringify(resolve(__dirname, 'age-plugin'))}\n` +
          `import { runGpg, gpgOnPath } from ${JSON.stringify(resolve(__dirname, 'gpg'))}\n` +
          `runGpg(['--maki-gpg', ...process.argv.slice(2)], { input: process.stdin, output: (b) => process.stdout.write(b), status: (fd, l) => writeSync(fd, l + '\\n'), error: (l) => process.stderr.write(l + '\\n'), ask: askOver(${JSON.stringify(socket)}, ${JSON.stringify(OPENPGP_APP)}), gpg: gpgOnPath }).then((c) => process.exit(c))\n`
      )
      await build({
        entryPoints: [join(dir, 'entry.ts')],
        outfile: join(dir, 'gpg.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      mkdirSync(join(dir, 'bin'))
      writeFileSync(
        join(dir, 'bin', 'maki-gpg'),
        `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'gpg.cjs')}' "$@"\n`
      )
      chmodSync(join(dir, 'bin', 'maki-gpg'), 0o755)
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      for (const args of [
        ['init', '-q'],
        ['config', 'user.name', 'Kara Zajac'],
        ['config', 'user.email', 'kara@example.org'],
        ['config', 'gpg.program', join(dir, 'bin', 'maki-gpg')],
        ['config', 'user.signingkey', fingerprint]
      ])
        expect((await tool('git', args, undefined, repo)).code).toBe(0)
      writeFileSync(join(repo, 'README'), 'maki\n')
      await tool('git', ['add', 'README'], undefined, repo)
      const committed = await tool(
        'git',
        ['commit', '-q', '-S', '-m', 'Sign with OpenPGP on maki'],
        undefined,
        repo
      )
      expect(committed.code, committed.err).toBe(0)
      const verified = await tool('git', ['verify-commit', 'HEAD'], undefined, repo)
      expect(verified.code, verified.err).toBe(0)
      expect(verified.err).toContain('Good signature from "Kara Zajac <kara@example.org>"')
    })
  }
)
