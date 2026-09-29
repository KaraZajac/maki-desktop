/**
 * maki-gpg: gpg, with the OpenPGP key maki's OpenPGP app keeps, for git (`gpg.program`) and
 * anything else that runs gpg. What's signed goes to maki whole, in pieces, through the tray
 * app's socket and the link: the app hashes it, shows what it is (a commit's subject and
 * author) and makes the signature itself, once its owner says yes. A message sent to maki's key
 * is opened the same way: its session key goes to maki as the sender wrapped it, and maki
 * unwraps it once its owner says yes; this decrypts the rest. Anything else (checking
 * signatures, other keys, other messages) is gpg's own, with the same arguments.
 *
 *     maki-gpg --name "Kara Zajac <kara@example.org>"   name maki's key (maki asks)
 *     maki-gpg --armor --export                          maki's public key, for gpg --import
 *     maki-gpg --status-fd=2 -bsau KEY                   what git runs to sign
 *     maki-gpg --decrypt [FILE]                          a message sent to maki's key
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { armour, packets, PGP_MORE, PGP_OK, pgpSays, unarmour, userId } from '../shared/openpgp'
import type { AskApp } from './age-plugin'
import type { Command } from './scripts'

export const GPG_COMMAND: Command = {
  name: 'maki-gpg',
  flag: '--maki-gpg',
  why: 'gpg, with the OpenPGP key maki keeps'
}

const PIECE = 3900

export interface GpgIO {
  input: AsyncIterable<Buffer | string>
  output: (bytes: Uint8Array | string) => void
  /** a status line for gpg's --status-fd */
  status: (fd: number, line: string) => void
  error: (line: string) => void
  /** maki's OpenPGP app */
  ask: AskApp
  /** gpg itself, with these arguments (and this input, if it was read already): its exit code */
  gpg: (args: string[], input?: Uint8Array) => Promise<number>
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex').toUpperCase()

/** gpg's arguments, as far as maki-gpg reads them. */
interface Args {
  flags: Set<string>
  user?: string
  statusFd?: number
  output?: string
  name?: string
  rest: string[]
}

function parse(args: string[]): Args {
  const a: Args = { flags: new Set(), rest: [] }
  const takes: Record<string, keyof Args> = {
    '--local-user': 'user',
    '--default-key': 'user',
    '--output': 'output',
    '--name': 'name'
  }
  for (let i = 0; i < args.length; i++) {
    const x = args[i]
    if (x === '--') {
      a.rest.push(...args.slice(i + 1))
      break
    }
    const [opt, eq] = x.startsWith('--')
      ? (x.split(/=(.*)/s) as [string, string | undefined])
      : [x, undefined]
    if (opt === '--status-fd') a.statusFd = Number(eq ?? args[++i])
    else if (opt in takes) (a as unknown as Record<string, string>)[takes[opt]] = eq ?? args[++i]
    else if (opt.startsWith('--')) a.flags.add(opt)
    else if (/^-[a-zA-Z]+$/.test(opt)) {
      // short options combined, as git's -bsau KEY
      for (let j = 1; j < opt.length; j++) {
        const f = opt[j]
        if (f === 'u' || f === 'o') {
          const v = j === opt.length - 1 ? args[++i] : opt.slice(j + 1)
          if (f === 'u') a.user = v
          else a.output = v
          break
        }
        a.flags.add(`-${f}`)
      }
    } else a.rest.push(x)
  }
  return a
}

async function readAll(input: AsyncIterable<Buffer | string>): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const c of input) chunks.push(Buffer.from(c))
  return new Uint8Array(Buffer.concat(chunks))
}

async function app(ask: AskApp, message: Uint8Array): Promise<Uint8Array> {
  const r = await ask(message)
  if (r.status === 'no match')
    throw new Error(
      'maki’s OpenPGP app isn’t installed: add it from the maki store, in maki desktop'
    )
  if (r.status !== 'approved') throw new Error(`maki: ${r.status}`)
  return r.answer
}

/** maki's key: its fingerprint and its subkey's ID. */
export async function makiKey(ask: AskApp): Promise<{ fingerprint: string; subkeyId: Uint8Array }> {
  const a = await app(ask, Uint8Array.of('F'.charCodeAt(0)))
  if (a[0] !== PGP_OK || a.length !== 29) throw new Error(pgpSays(a[0]))
  return { fingerprint: hex(a.subarray(1, 21)), subkeyId: a.slice(21) }
}

/** Whether gpg's `-u KEY` names maki's key: its fingerprint, its ID, or its name or email. */
function isMaki(user: string | undefined, fingerprint: string, uid: string | null): boolean {
  if (!user) return true
  const u = user.replace(/^0x/i, '').replace(/\s/g, '').replace(/!$/, '').toUpperCase()
  if (/^[0-9A-F]{8,40}$/.test(u)) return fingerprint.endsWith(u)
  return !!uid && uid.toLowerCase().includes(user.replace(/^<|>$/g, '').toLowerCase())
}

/** Something signed whole by maki's key: a v4 signature packet. */
export async function signWhole(ask: AskApp, data: Uint8Array): Promise<Uint8Array> {
  const total = data.length
  for (let at = 0; at === 0 || at < total; at += PIECE) {
    const head = new Uint8Array(9)
    head[0] = 'S'.charCodeAt(0)
    new DataView(head.buffer).setUint32(1, total, true)
    new DataView(head.buffer).setUint32(5, at, true)
    const a = await app(ask, Buffer.concat([head, data.subarray(at, at + PIECE)]))
    if (at + PIECE < total) {
      if (a[0] !== PGP_MORE) throw new Error(pgpSays(a[0]))
      continue
    }
    if (a[0] !== PGP_OK) throw new Error(pgpSays(a[0]))
    return a.slice(1)
  }
  throw new Error('nothing to sign')
}

/** When a signature packet says it was made. */
function signedAt(sig: Uint8Array): number {
  const p = packets(sig)[0].body
  const n = (p[4] << 8) | p[5]
  let at = 6
  while (at < 6 + n) {
    let len = p[at++]
    if (len >= 192 && len < 255) len = ((len - 192) << 8) + p[at++] + 192
    if (p[at] === 2) return new DataView(p.buffer, p.byteOffset + at + 1).getUint32(0)
    at += len
  }
  return Math.floor(Date.now() / 1000)
}

/** A message's session key, unwrapped by maki: its algorithm and key; null if it isn't for maki's key. */
async function sessionKey(
  ask: AskApp,
  message: Uint8Array,
  subkeyId: Uint8Array
): Promise<Uint8Array | null> {
  for (const p of packets(message)) {
    if (p.tag !== 1 || p.body[0] !== 3 || p.body[9] !== 18) continue
    const id = p.body.subarray(1, 9)
    if (!Buffer.from(id).equals(Buffer.from(subkeyId)) && !id.every((b) => b === 0)) continue
    const a = await app(ask, Buffer.concat([Buffer.from('D'), p.body]))
    if (a[0] === PGP_OK) return a.slice(1)
    if (!id.every((b) => b === 0)) throw new Error(pgpSays(a[0]))
  }
  return null
}

const CIPHERS: Record<number, string> = { 7: 'aes-128-cfb', 8: 'aes-192-cfb', 9: 'aes-256-cfb' }

/** What an encrypted message says, with its session key: the literal data, and its name. */
export function decryptWith(
  message: Uint8Array,
  key: Uint8Array
): { name: string; data: Uint8Array } {
  const seipd = packets(message).find((p) => p.tag === 18)
  if (!seipd) throw new Error('a message without integrity protection, which maki-gpg won’t open')
  if (seipd.body[0] !== 1) throw new Error('a kind of encrypted message maki-gpg doesn’t read')
  const cipher = CIPHERS[key[0]]
  if (!cipher) throw new Error('a cipher maki-gpg doesn’t know')
  const d = createDecipheriv(cipher, key.subarray(1), Buffer.alloc(16))
  const plain = new Uint8Array(Buffer.concat([d.update(seipd.body.subarray(1)), d.final()]))
  // the random prefix's last two bytes, repeated; then the modification detection code
  if (plain[16] !== plain[14] || plain[17] !== plain[15])
    throw new Error('that key doesn’t open it')
  const mdc = plain.subarray(plain.length - 22)
  const hash = createHash('sha1')
    .update(plain.subarray(0, plain.length - 20))
    .digest()
  if (mdc[0] !== 0xd3 || mdc[1] !== 0x14 || !hash.equals(Buffer.from(mdc.subarray(2))))
    throw new Error('the message was changed')
  let inner = packets(plain.subarray(18, plain.length - 22))
  // compressed, then literal data
  for (;;) {
    const c = inner.find((p) => p.tag === 8)
    if (!c) break
    const algo = c.body[0]
    const raw = c.body.subarray(1)
    const data =
      algo === 0 ? raw : algo === 1 ? inflateRawSync(raw) : algo === 2 ? inflateSync(raw) : null
    if (!data) throw new Error('compressed in a way maki-gpg doesn’t read (BZip2)')
    inner = packets(new Uint8Array(data))
  }
  const lit = inner.find((p) => p.tag === 11)
  if (!lit) throw new Error('nothing in the message')
  const n = lit.body[1]
  return {
    name: new TextDecoder().decode(lit.body.subarray(2, 2 + n)),
    data: lit.body.subarray(2 + n + 4)
  }
}

export async function runGpg(argv: string[], io: GpgIO): Promise<number> {
  const at = argv.indexOf(GPG_COMMAND.flag)
  const args = at >= 0 ? argv.slice(at + 1) : argv
  const a = parse(args)
  try {
    if (a.name !== undefined) {
      const r = await app(io.ask, Buffer.concat([Buffer.from('U'), Buffer.from(a.name, 'utf8')]))
      if (r[0] !== PGP_OK) throw new Error(pgpSays(r[0]))
      io.error(`maki-gpg: maki's key is "${a.name}" now`)
      return 0
    }
    if (a.flags.has('--export')) {
      const key = await app(io.ask, Uint8Array.of('K'.charCodeAt(0)))
      if (key[0] !== PGP_OK) throw new Error(pgpSays(key[0]))
      const body = key.slice(1)
      const { fingerprint } = await makiKey(io.ask)
      // other keys asked for: gpg's own keyring's
      if (a.rest.length > 0 && !a.rest.every((r) => isMaki(r, fingerprint, userId(body))))
        return io.gpg(args)
      io.output(
        a.flags.has('-a') || a.flags.has('--armor') ? armour('PUBLIC KEY BLOCK', body) : body
      )
      return 0
    }
    const signing = a.flags.has('-b') || a.flags.has('--detach-sign')
    if (signing) {
      const { fingerprint } = await makiKey(io.ask)
      const key = await app(io.ask, Uint8Array.of('K'.charCodeAt(0)))
      const uid = key[0] === PGP_OK ? userId(key.slice(1)) : null
      if (!isMaki(a.user, fingerprint, uid)) return io.gpg(args)
      const data =
        a.rest.length > 0 ? new Uint8Array(await readFile(a.rest[0])) : await readAll(io.input)
      const sig = await signWhole(io.ask, data)
      const out = a.flags.has('-a') || a.flags.has('--armor') ? armour('SIGNATURE', sig) : sig
      if (a.output) await writeFile(a.output, out)
      else io.output(out)
      if (a.statusFd !== undefined) {
        io.status(a.statusFd, `[GNUPG:] KEY_CONSIDERED ${fingerprint} 2`)
        io.status(a.statusFd, '[GNUPG:] BEGIN_SIGNING H8')
        io.status(a.statusFd, `[GNUPG:] SIG_CREATED D 22 8 00 ${signedAt(sig)} ${fingerprint}`)
      }
      return 0
    }
    if (a.flags.has('-d') || a.flags.has('--decrypt')) {
      const raw =
        a.rest.length > 0 ? new Uint8Array(await readFile(a.rest[0])) : await readAll(io.input)
      const message = unarmour(raw)
      const { subkeyId } = await makiKey(io.ask).catch(() => ({
        subkeyId: new Uint8Array(8).fill(0xff)
      }))
      const key = message ? await sessionKey(io.ask, message, subkeyId) : null
      // not for maki's key: gpg's, as it came
      if (!message || !key)
        return io.gpg(
          args.filter((x) => !a.rest.includes(x)),
          raw
        )
      const { data } = decryptWith(message, key)
      if (a.output) await writeFile(a.output, data)
      else io.output(data)
      return 0
    }
    return io.gpg(args)
  } catch (e) {
    io.error(`maki-gpg: ${(e as Error).message}`)
    return 2
  }
}

/** gpg on the PATH, with these arguments (and this input, else this process's): its exit code. */
export function gpgOnPath(args: string[], input?: Uint8Array): Promise<number> {
  const exe = (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((dir) => join(dir, process.platform === 'win32' ? 'gpg.exe' : 'gpg'))
    .find((p) => existsSync(p))
  if (!exe) {
    process.stderr.write('maki-gpg: gpg isn’t on the PATH\n')
    return Promise.resolve(2)
  }
  return new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] })
    if (input) p.stdin!.end(Buffer.from(input))
    p.on('exit', (code) => resolve(code ?? 2))
    p.on('error', () => resolve(2))
  })
}
