/**
 * maki desktop's SSH agent, with the real OpenSSH tools on one side and, on the other, the
 * fake maki running maki's own SSH app (the SDK's example, as maki runs it).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { APP_FIXTURES, APP_FIXTURES_THERE, FAKE_BUILT, startFake, TcpTransport } from '../shared/test-support'
import { serveAgent, SSH_APP } from './ssh-agent'

const OPENSSH = spawnSync('ssh-keygen', ['-?']).error === undefined && spawnSync('ssh-add', ['-h']).error === undefined

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

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE || !OPENSSH)("maki desktop's SSH agent, with OpenSSH", () => {
  let fake: { port: number; proc: ChildProcess }
  let transport: TcpTransport
  let server: Server
  let dir: string
  let sock: string
  // the tools see only this: a home of their own, and the agent
  const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: dir, SSH_AUTH_SOCK: sock })

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
    const sign = await run('ssh-keygen', ['-Y', 'sign', '-f', join(dir, 'key.pub'), '-n', 'git', join(dir, 'commit')], env())
    expect(sign.status, sign.stderr).toBe(0)
    const check = await run('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'git', '-s', join(dir, 'commit.sig')], env(), commit)
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toMatch(/Good "git" signature with ED25519 key SHA256:/)
    // not for another namespace
    const other = await run('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'file', '-s', join(dir, 'commit.sig')], env(), commit)
    expect(other.status).not.toBe(0)
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
})
