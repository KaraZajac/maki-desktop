/**
 * maki desktop's SSH agent, with the real OpenSSH tools on one side and, on the other, the
 * fake maki running maki's own SSH app (the SDK's example, as maki runs it).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { serveAgent, SSH_APP } from './ssh-agent'

const OPENSSH =
  spawnSync('ssh-keygen', ['-?']).error === undefined &&
  spawnSync('ssh-add', ['-h']).error === undefined
const GIT = spawnSync('git', ['--version']).error === undefined
/** sshd, to sign in to: it must be run by its absolute path */
const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p))

/** A free port on this computer. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

/**
 * A tool run to the end, without blocking: the agent answering it runs in this same process.
 */
function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    p.on('error', reject)
    p.on('close', (status) => resolve({ status, stdout, stderr }))
    p.stdin.end(input ?? '')
  })
}

/** A raw agent request on its own connection: the answer's bytes. */
function ask(sock: string, request: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const s = connect(sock, () => {
      const framed = Buffer.alloc(4 + request.length)
      framed.writeUInt32BE(request.length)
      framed.set(request, 4)
      s.write(framed)
    })
    let got = Buffer.alloc(0)
    s.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d])
      if (got.length >= 4 && got.length >= 4 + got.readUInt32BE(0)) {
        s.destroy()
        resolve(new Uint8Array(got.subarray(4, 4 + got.readUInt32BE(0))))
      }
    })
    s.on('error', reject)
  })
}

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE || !OPENSSH)(
  "maki desktop's SSH agent, with OpenSSH",
  () => {
    let fake: { port: number; proc: ChildProcess }
    let transport: TcpTransport
    let server: Server
    let dir: string
    let sock: string
    // the tools see only this: a home of their own, and the agent
    const env = (): NodeJS.ProcessEnv => ({
      PATH: process.env.PATH,
      HOME: dir,
      SSH_AUTH_SOCK: sock
    })

    beforeAll(async () => {
      fake = await startFake()
      transport = await TcpTransport.open(fake.port)
      const client = new MakiClient(transport)
      const ssh = new Uint8Array(readFileSync(join(APP_FIXTURES, 'ssh.maki')))
      expect(await client.appInstall(ssh)).toEqual({ approval: 'approved', reason: '' })
      dir = mkdtempSync(join(tmpdir(), 'maki-ssh-'))
      sock = join(dir, 'agent.sock')
      server = await serveAgent(async (message) => {
        const r = await client.appMessage(SSH_APP, message)
        return r.status === 'approved' ? r.answer : null
      }, sock)
    })
    afterAll(async () => {
      server?.close()
      await transport?.close()
      fake?.proc.kill()
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it("lists maki's key to ssh-add", async () => {
      const r = await run('ssh-add', ['-L'], env())
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* maki\n$/)
    })

    it('signs for git with ssh-keygen, which checks the signature', async () => {
      const key = (await run('ssh-add', ['-L'], env())).stdout
      writeFileSync(join(dir, 'key.pub'), key)
      const commit = 'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nsigned by maki\n'
      writeFileSync(join(dir, 'commit'), commit)
      // with a public key, ssh-keygen has the agent sign
      const sign = await run(
        'ssh-keygen',
        ['-Y', 'sign', '-f', join(dir, 'key.pub'), '-n', 'git', join(dir, 'commit')],
        env()
      )
      expect(sign.status, sign.stderr).toBe(0)
      const check = await run(
        'ssh-keygen',
        ['-Y', 'check-novalidate', '-n', 'git', '-s', join(dir, 'commit.sig')],
        env(),
        commit
      )
      expect(check.status, check.stderr).toBe(0)
      expect(check.stdout).toMatch(/Good "git" signature with ED25519 key SHA256:/)
      // not for another namespace
      const other = await run(
        'ssh-keygen',
        ['-Y', 'check-novalidate', '-n', 'file', '-s', join(dir, 'commit.sig')],
        env(),
        commit
      )
      expect(other.status).not.toBe(0)
    })

    it.skipIf(!GIT)('signs a git commit, which git verifies', async () => {
      const key = (await run('ssh-add', ['-L'], env())).stdout.trim()
      const repo = join(dir, 'repo')
      writeFileSync(join(dir, 'allowed_signers'), `maki@example.com namespaces="git" ${key}\n`)
      // git with no settings but these: nothing of the computer's own
      const gitEnv = {
        ...env(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
        GIT_AUTHOR_NAME: 'maki',
        GIT_AUTHOR_EMAIL: 'maki@example.com',
        GIT_COMMITTER_NAME: 'maki',
        GIT_COMMITTER_EMAIL: 'maki@example.com'
      }
      const git = (...args: string[]): ReturnType<typeof run> =>
        run('git', ['-C', repo, ...args], gitEnv)
      expect((await run('git', ['init', '-q', repo], gitEnv)).status).toBe(0)
      for (const [k, v] of [
        ['gpg.format', 'ssh'],
        ['user.signingkey', `key::${key}`],
        ['gpg.ssh.allowedSignersFile', join(dir, 'allowed_signers')]
      ]) {
        expect((await git('config', k, v)).status).toBe(0)
      }
      const commit = await git('commit', '-q', '-S', '--allow-empty', '-m', 'signed on maki')
      expect(commit.status, commit.stderr).toBe(0)
      const verify = await git('verify-commit', 'HEAD')
      expect(verify.status, verify.stderr).toBe(0)
      expect(verify.stderr).toMatch(
        /Good "git" signature for maki@example.com with ED25519 key SHA256:/
      )
    })

    it.skipIf(!SSHD)('signs in over ssh, with the key on maki', async () => {
      // an sshd of this test's own, run as this user: it takes only this user, with maki's key
      const key = (await run('ssh-add', ['-L'], env())).stdout
      writeFileSync(join(dir, 'authorized_keys'), key)
      // maki's key named outright: ssh finds ~/.ssh from the user database, not HOME, and without
      // an identity of its own to offer it would reach for the computer's keys
      writeFileSync(join(dir, 'maki.pub'), key)
      const hostKey = await run(
        'ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_key')],
        env()
      )
      expect(hostKey.status, hostKey.stderr).toBe(0)
      const port = await freePort()
      const config = [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${join(dir, 'host_key')}`,
        `PidFile ${join(dir, 'sshd.pid')}`,
        `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
        'StrictModes no',
        'UsePAM no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'LogLevel ERROR'
      ]
      writeFileSync(join(dir, 'sshd_config'), config.join('\n') + '\n')
      const sshd = spawn(SSHD!, ['-D', '-e', '-f', join(dir, 'sshd_config')], { env: env() })
      let sshdSaid = ''
      sshd.stderr.on('data', (d: Buffer) => (sshdSaid += d.toString()))
      try {
        // until it listens
        for (let i = 0; i < 50; i++) {
          const up = await new Promise<boolean>((resolve) => {
            const s = connect(port, '127.0.0.1', () => (s.destroy(), resolve(true)))
            s.on('error', () => resolve(false))
          })
          if (up) break
          await new Promise((r) => setTimeout(r, 100))
        }
        const options = [
          ['BatchMode', 'yes'],
          ['StrictHostKeyChecking', 'accept-new'],
          ['UserKnownHostsFile', join(dir, 'known_hosts')],
          ['GlobalKnownHostsFile', '/dev/null'],
          ['IdentityAgent', sock],
          ['IdentityFile', join(dir, 'maki.pub')],
          ['IdentitiesOnly', 'yes'],
          ['PreferredAuthentications', 'publickey']
        ].flatMap(([k, v]) => ['-o', `${k}=${v}`])
        const target = `${userInfo().username}@127.0.0.1`
        const login = await run(
          'ssh',
          ['-F', '/dev/null', '-p', String(port), ...options, target, 'echo signed in with maki'],
          env()
        )
        expect(login.status, `${login.stderr}\n${sshdSaid}`).toBe(0)
        expect(login.stdout).toBe('signed in with maki\n')
      } finally {
        sshd.kill()
      }
    })

    it('fails what the app refuses, and anything when maki is away', async () => {
      // adding a key: an agent that holds its keys on maki doesn't
      expect(Array.from(await ask(sock, new Uint8Array([17])))).toEqual([5])
      const away = join(dir, 'away.sock')
      const s = await serveAgent(async () => {
        throw new Error('maki is not linked')
      }, away)
      expect(Array.from(await ask(away, new Uint8Array([11])))).toEqual([5])
      s.close()
    })
  }
)

/** An sshd of a test's own, run as this user, with `config` added: its port, and how to stop it. */
async function startSshd(
  dir: string,
  env: NodeJS.ProcessEnv,
  config: string[]
): Promise<{ port: number; stop: () => void; said: () => string }> {
  const hostKey = await run(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_key')],
    env
  )
  expect(hostKey.status, hostKey.stderr).toBe(0)
  const port = await freePort()
  const all = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${join(dir, 'host_key')}`,
    `PidFile ${join(dir, 'sshd.pid')}`,
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'LogLevel ERROR',
    ...config
  ]
  writeFileSync(join(dir, 'sshd_config'), all.join('\n') + '\n')
  const sshd = spawn(SSHD!, ['-D', '-e', '-f', join(dir, 'sshd_config')], { env })
  let said = ''
  sshd.stderr.on('data', (d: Buffer) => (said += d.toString()))
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1', () => (s.destroy(), resolve(true)))
      s.on('error', () => resolve(false))
    })
    if (up) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return { port, stop: () => sshd.kill(), said: () => said }
}

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE || !OPENSSH)(
  "maki's SSH app as a certificate authority, with OpenSSH",
  () => {
    let fake: { port: number; proc: ChildProcess }
    let transport: TcpTransport
    let server: Server
    let dir: string
    let sock: string
    const env = (): NodeJS.ProcessEnv => ({
      PATH: process.env.PATH,
      HOME: dir,
      SSH_AUTH_SOCK: sock
    })

    beforeAll(async () => {
      // the CA key turned on in the app's menu, as its owner would have
      fake = await startFake(['--storage', `${SSH_APP}:ca=01000000`])
      transport = await TcpTransport.open(fake.port)
      const client = new MakiClient(transport)
      const ssh = new Uint8Array(readFileSync(join(APP_FIXTURES, 'ssh.maki')))
      expect(await client.appInstall(ssh)).toEqual({ approval: 'approved', reason: '' })
      dir = mkdtempSync(join(tmpdir(), 'maki-ca-'))
      sock = join(dir, 'agent.sock')
      server = await serveAgent(async (message) => {
        const r = await client.appMessage(SSH_APP, message)
        return r.status === 'approved' ? r.answer : null
      }, sock)
    })
    afterAll(async () => {
      server?.close()
      await transport?.close()
      fake?.proc.kill()
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('offers its key beside maki’s, and signs the certificates ssh-keygen makes', async () => {
      const listed = (await run('ssh-add', ['-L'], env())).stdout.trim().split('\n')
      expect(listed.map((l) => l.split(' ').slice(2).join(' '))).toEqual(['maki', 'maki CA'])
      writeFileSync(join(dir, 'ca.pub'), `${listed[1]}\n`)
      // someone's own key, and a certificate for it from maki's CA, for this user
      const user = await run(
        'ssh-keygen',
        ['-q', '-t', 'ed25519', '-N', '', '-C', 'laptop', '-f', join(dir, 'user')],
        env()
      )
      expect(user.status, user.stderr).toBe(0)
      const me = userInfo().username
      const signed = await run(
        'ssh-keygen',
        [
          '-s',
          join(dir, 'ca.pub'),
          '-U',
          '-I',
          'kara-laptop',
          '-n',
          `${me},root`,
          '-V',
          '+52w',
          join(dir, 'user.pub')
        ],
        env()
      )
      expect(signed.status, signed.stderr).toBe(0)
      const shown = await run('ssh-keygen', ['-L', '-f', join(dir, 'user-cert.pub')], env())
      expect(shown.stdout).toContain('ssh-ed25519-cert-v01@openssh.com user certificate')
      expect(shown.stdout).toContain('Key ID: "kara-laptop"')
      expect(shown.stdout).toMatch(new RegExp(`Principals: \\n\\s+${me}\\n\\s+root`))
      const caPrint = (
        await run('ssh-keygen', ['-l', '-f', join(dir, 'ca.pub')], env())
      ).stdout.split(' ')[1]
      expect(shown.stdout).toContain(`Signing CA: ED25519 ${caPrint}`)
      // and maki's own key doesn't sign certificates
      writeFileSync(join(dir, 'maki.pub'), `${listed[0]}\n`)
      const refused = await run(
        'ssh-keygen',
        ['-s', join(dir, 'maki.pub'), '-U', '-I', 'x', '-n', me, join(dir, 'user.pub')],
        env()
      )
      expect(refused.status).not.toBe(0)
    })

    it.skipIf(!SSHD)('signs in with a certificate from maki’s CA, which sshd trusts', async () => {
      // a server that trusts maki's CA, and no one's keys of their own
      const sshd = await startSshd(dir, env(), [
        `TrustedUserCAKeys ${join(dir, 'ca.pub')}`,
        'AuthorizedKeysFile none'
      ])
      try {
        const options = [
          ['BatchMode', 'yes'],
          ['StrictHostKeyChecking', 'accept-new'],
          ['UserKnownHostsFile', join(dir, 'known_hosts')],
          ['GlobalKnownHostsFile', '/dev/null'],
          ['IdentityAgent', 'none'],
          ['IdentityFile', join(dir, 'user')],
          ['CertificateFile', join(dir, 'user-cert.pub')],
          ['IdentitiesOnly', 'yes'],
          ['PreferredAuthentications', 'publickey']
        ].flatMap(([k, v]) => ['-o', `${k}=${v}`])
        const target = `${userInfo().username}@127.0.0.1`
        const login = await run(
          'ssh',
          [
            '-F',
            '/dev/null',
            '-p',
            String(sshd.port),
            ...options,
            target,
            'echo certified by maki'
          ],
          env()
        )
        expect(login.status, `${login.stderr}\n${sshd.said()}`).toBe(0)
        expect(login.stdout).toBe('certified by maki\n')
      } finally {
        sshd.stop()
      }
    })
  }
)
