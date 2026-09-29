/**
 * maki-ssh-keygen: what git runs to sign with SSH (`gpg.ssh.program`), in ssh-keygen's place. A
 * commit or tag to be signed with maki's SSH key goes to maki's SSH app whole, in pieces, through
 * the tray app's socket and the link: the app hashes it as the pieces come, shows the owner what
 * it is from the same bytes (a commit's subject and author, a tag's name) and signs it as
 * `ssh-keygen -Y sign` would; this writes the signature as ssh-keygen does. Anything else (other
 * keys, checking signatures, which git also asks ssh-keygen for) is ssh-keygen's own.
 *
 *     git config --global gpg.format ssh
 *     git config --global gpg.ssh.program maki-ssh-keygen
 *     git config --global user.signingkey "key::ssh-ed25519 AAAA… maki"
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { AskApp } from './age-plugin'
import type { Command } from './scripts'

export const SSH_KEYGEN_COMMAND: Command = {
  name: 'maki-ssh-keygen',
  flag: '--maki-ssh-keygen',
  why: 'git runs this to sign commits with maki'
}

// the agent protocol's message numbers, and the SSH app's own for something signed whole
const SUCCESS = 6
const REQUEST_IDENTITIES = 11
const IDENTITIES_ANSWER = 12
const SIGN_RESPONSE = 14
const SIGN_WHOLE = 240
/** What goes in a message: the app reads up to 4096 bytes. */
const PIECE = 3900

export interface KeygenIO {
  input: AsyncIterable<Buffer | string>
  output: (bytes: Uint8Array | string) => void
  error: (line: string) => void
  /** maki's SSH app */
  ask: AskApp
  /** ssh-keygen itself, with these arguments: its exit code */
  sshKeygen: (args: string[]) => Promise<number>
}

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}

const string = (b: Uint8Array): Uint8Array => Buffer.concat([u32(b.length), b])

/** Strings from an SSH message, from `at`. */
function strings(b: Uint8Array, at: number, n: number): Uint8Array[] | null {
  const out: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    if (at + 4 > b.length) return null
    const len = new DataView(b.buffer, b.byteOffset + at).getUint32(0)
    if (at + 4 + len > b.length) return null
    out.push(b.slice(at + 4, at + 4 + len))
    at += 4 + len
  }
  return out
}

/** A public key's blob from an OpenSSH public key line ("ssh-ed25519 AAAA… comment"); null if it isn't one. */
export function keyBlob(text: string): Uint8Array | null {
  const line = text.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))
  const [kind, data] = (line ?? '')
    .trim()
    .replace(/^key::/, '')
    .split(/\s+/)
  if (!kind || !data) return null
  const blob = new Uint8Array(Buffer.from(data, 'base64'))
  const inner = strings(blob, 0, 1)
  return inner && Buffer.from(inner[0]).toString() === kind ? blob : null
}

/** The SSH keys maki's SSH app offers (as `ssh-add -L` lists them). */
export async function makiKeys(ask: AskApp): Promise<Uint8Array[]> {
  const r = await ask(Buffer.concat([u32(0), Uint8Array.of(REQUEST_IDENTITIES)]))
  if (r.status === 'no match')
    throw new Error('maki’s SSH app isn’t installed: add it from the maki store, in maki desktop')
  const a = r.answer
  if (r.status !== 'approved' || a[0] !== IDENTITIES_ANSWER || a.length < 5) return []
  const n = new DataView(a.buffer, a.byteOffset + 1).getUint32(0)
  const list = strings(a, 5, 2 * n)
  return list ? list.filter((_, i) => i % 2 === 0) : []
}

/** ssh-keygen's armour, around SSHSIG's blob (PROTOCOL.sshsig). */
export function armour(blob: Uint8Array): string {
  const b64 = Buffer.from(blob).toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 70) lines.push(b64.slice(i, i + 70))
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----\n`
}

/**
 * `message` signed whole by maki's SSH app, in `namespace`, with the key `key` (its blob): the
 * armoured signature, or why not.
 */
export async function signWhole(
  ask: AskApp,
  key: Uint8Array,
  namespace: string,
  message: Uint8Array
): Promise<string> {
  const ns = new TextEncoder().encode(namespace)
  let answer: Uint8Array | null = null
  for (let at = 0; at === 0 || at < message.length; at += PIECE) {
    const piece = message.subarray(at, at + PIECE)
    const r = await ask(
      Buffer.concat([
        u32(0),
        Uint8Array.of(SIGN_WHOLE),
        string(ns),
        u32(message.length),
        u32(at),
        piece
      ])
    )
    if (r.status === 'no match')
      throw new Error('maki’s SSH app isn’t installed: add it from the maki store, in maki desktop')
    if (r.status !== 'approved') throw new Error(`maki: ${r.status}`)
    const last = at + PIECE >= message.length
    if (!last) {
      if (r.answer[0] !== SUCCESS) throw new Error('maki’s SSH app didn’t take it')
      continue
    }
    answer = r.answer
  }
  if (!answer || answer[0] !== SIGN_RESPONSE)
    throw new Error('maki didn’t sign it: you said no, or nobody answered on maki')
  const sig = strings(answer, 1, 1)
  if (!sig) throw new Error('maki’s SSH app answered something else')
  const blob = Buffer.concat([
    new TextEncoder().encode('SSHSIG'),
    u32(1),
    string(key),
    string(ns),
    string(new Uint8Array()),
    string(new TextEncoder().encode('sha512')),
    string(sig[0])
  ])
  return armour(blob)
}

/** ssh-keygen's arguments, as far as `-Y sign` needs them; null for anything else. */
function signing(args: string[]): { namespace: string; keyFile: string; files: string[] } | null {
  let op = ''
  let namespace = ''
  let keyFile = ''
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-Y') op = args[++i] ?? ''
    else if (a === '-n') namespace = args[++i] ?? ''
    else if (a === '-f') keyFile = args[++i] ?? ''
    else if (a === '-U' || a === '-q') continue
    // options it doesn't take (another hash, say): ssh-keygen's to do
    else if (a.startsWith('-')) return null
    else files.push(a)
  }
  return op === 'sign' && namespace && keyFile ? { namespace, keyFile, files } : null
}

export async function runSshKeygen(argv: string[], io: KeygenIO): Promise<number> {
  const at = argv.indexOf(SSH_KEYGEN_COMMAND.flag)
  const args = at >= 0 ? argv.slice(at + 1) : argv
  const s = signing(args)
  if (!s) return io.sshKeygen(args)
  try {
    const key = keyBlob(await readFile(s.keyFile, 'utf8'))
    const makis = key ? await makiKeys(io.ask).catch(() => []) : []
    // not maki's key (or maki desktop isn't running): ssh-keygen signs with it, as it would
    if (!key || !makis.some((k) => Buffer.compare(Buffer.from(k), Buffer.from(key)) === 0))
      return io.sshKeygen(args)
    if (s.files.length === 0) {
      const chunks: Buffer[] = []
      for await (const c of io.input) chunks.push(Buffer.from(c))
      io.output(await signWhole(io.ask, key, s.namespace, new Uint8Array(Buffer.concat(chunks))))
      return 0
    }
    for (const file of s.files) {
      io.error(`Signing file ${file}`)
      const signature = await signWhole(
        io.ask,
        key,
        s.namespace,
        new Uint8Array(await readFile(file))
      )
      await writeFile(`${file}.sig`, signature)
      io.error(`Write signature to ${file}.sig`)
    }
    return 0
  } catch (e) {
    io.error(`maki-ssh-keygen: ${(e as Error).message}`)
    return 255
  }
}

/** ssh-keygen on the PATH, run with these arguments and this process's stdio: its exit code. */
export function sshKeygenOnPath(args: string[]): Promise<number> {
  const exe = (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((dir) => join(dir, process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'))
    .find((p) => existsSync(p))
  if (!exe) {
    process.stderr.write('maki-ssh-keygen: ssh-keygen isn’t on the PATH\n')
    return Promise.resolve(255)
  }
  return new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: 'inherit' })
    p.on('exit', (code) => resolve(code ?? 255))
    p.on('error', () => resolve(255))
  })
}
