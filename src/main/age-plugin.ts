/**
 * age-plugin-maki: age's plugin (c2sp.org/age-plugin) for the age key maki holds, in maki's Age
 * app. The key's public half is an ordinary age recipient (`age1…`), so anyone encrypts to it with
 * age as it is; an identity file names the plugin (`AGE-PLUGIN-MAKI-1…`, the key's public half
 * inside), and decrypting with it starts this, which asks the Age app (through the running tray
 * app's socket) which of a file's X25519 stanzas is maki's, then for its file key, which maki asks
 * its owner about first. Encrypting to the identity (`age -e -i`) needs only its public half: it's
 * done here, as age does it.
 *
 *     age-plugin-maki               an identity file for the maki linked now, on stdout
 *     age-plugin-maki --recipient   its recipient
 *
 * age starts it with `--age-plugin=identity-v1` or `recipient-v1`. Nothing but the protocol's
 * stanzas may reach stdout then.
 */
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  AGE_APP,
  identityFile,
  identityOf,
  publicOfIdentity,
  recipientOf,
  type AgePluginStatus
} from '../shared/age'

/** What the Age app answers with first. */
const OK = 0
const NO = 1
const LOCKED = 3
const NOT_MINE = 4
const INFO = 'age-encryption.org/v1/X25519'

// ---- stanzas, as age's header has them: "-> tag args…", then the body in base64 lines ----

export interface Stanza {
  tag: string
  args: string[]
  body: Uint8Array
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64').replace(/=+$/, '')

/** Canonical unpadded base64, or null: age refuses anything else. */
export function unb64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return null
  const bytes = Buffer.from(s, 'base64')
  return b64(bytes) === s ? new Uint8Array(bytes) : null
}

export function stanza(
  tag: string,
  args: string[] = [],
  body: Uint8Array = new Uint8Array()
): string {
  const text = b64(body)
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 64) lines.push(text.slice(i, i + 64))
  // the last line is shorter than 64: empty, if it would be exactly 64
  if (text.length % 64 === 0) lines.push('')
  return `-> ${[tag, ...args].join(' ')}\n${lines.join('\n')}\n`
}

/** Stanzas from a stream, one at a time. */
export class StanzaReader {
  private lines: string[] = []
  private partial = ''
  private waiters: (() => void)[] = []
  private ended = false

  constructor(input: Readable) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      const all = (this.partial + chunk).split('\n')
      this.partial = all.pop()!
      this.lines.push(...all)
      this.waiters.splice(0).forEach((w) => w())
    })
    input.on('end', () => {
      this.ended = true
      this.waiters.splice(0).forEach((w) => w())
    })
  }

  private async line(): Promise<string> {
    while (this.lines.length === 0) {
      if (this.ended) throw new Error('age went away')
      await new Promise<void>((r) => this.waiters.push(r))
    }
    return this.lines.shift()!
  }

  async next(): Promise<Stanza> {
    const head = await this.line()
    if (!head.startsWith('-> ')) throw new Error(`not a stanza: ${head.slice(0, 40)}`)
    const [tag, ...args] = head.slice(3).split(' ')
    let text = ''
    for (;;) {
      const l = await this.line()
      text += l
      if (l.length < 64) break
    }
    const body = unb64(text)
    if (!body) throw new Error('a stanza whose body isn’t canonical base64')
    return { tag, args, body }
  }
}

// ---- identities and recipients: src/shared/age.ts ----

export { AGE_APP, identityFile, identityOf, publicOfIdentity, recipientOf }

const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const x25519Public = (raw: Uint8Array): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' })

/** A file key wrapped for `recipient` as age's X25519 stanza is: its share, and its body. */
export function wrap(
  fileKey: Uint8Array,
  recipient: Uint8Array
): { share: Uint8Array; body: Uint8Array } {
  const eph = generateKeyPairSync('x25519')
  const share = new Uint8Array(eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipient) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([share, recipient]), INFO, 32))
  const cipher = createCipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 })
  const body = Buffer.concat([cipher.update(fileKey), cipher.final(), cipher.getAuthTag()])
  return { share, body: new Uint8Array(body) }
}

// ---- maki's Age app, through the tray app's socket ----

export type AskApp = (data: Uint8Array) => Promise<{ status: string; answer: Uint8Array }>

/** A message for the Age app, through maki desktop's socket at `path`. */
export function askOver(path: string): AskApp {
  return (data) =>
    new Promise((resolve, reject) => {
      const s = connect(path)
      s.setEncoding('utf8')
      let got = ''
      s.once('error', () =>
        reject(new Error('maki desktop isn’t running: start it, with maki plugged in'))
      )
      s.on('data', (chunk: string) => {
        got += chunk
        const nl = got.indexOf('\n')
        if (nl < 0) return
        s.end()
        try {
          const r = JSON.parse(got.slice(0, nl)) as {
            ok: boolean
            error?: string
            status?: string
            data?: string
          }
          if (!r.ok)
            return reject(
              new Error(
                r.error === 'maki is not linked'
                  ? 'maki isn’t linked: plug it in'
                  : (r.error ?? 'maki desktop said no')
              )
            )
          resolve({
            status: r.status ?? '',
            answer: new Uint8Array(Buffer.from(r.data ?? '', 'base64'))
          })
        } catch (e) {
          reject(e as Error)
        }
      })
      s.write(
        JSON.stringify({
          id: 1,
          type: 'appMessage',
          app: AGE_APP,
          data: Buffer.from(data).toString('base64')
        }) + '\n'
      )
    })
}

/** The Age app's answer, its first byte checked: the rest, or why not. */
async function age(ask: AskApp, data: Uint8Array): Promise<{ code: number; rest: Uint8Array }> {
  const r = await ask(data)
  if (r.status === 'no match')
    throw new Error('maki’s Age app isn’t installed: add it from the maki store, in maki desktop')
  if (r.status !== 'approved') throw new Error(`maki: ${r.status}`)
  if (r.answer[0] === LOCKED) throw new Error('maki is locked: enter its PIN first')
  return { code: r.answer[0], rest: r.answer.subarray(1) }
}

/** The recipient maki's Age app has now. */
export async function makiRecipient(ask: AskApp): Promise<Uint8Array> {
  const { code, rest } = await age(ask, Uint8Array.of(1))
  if (code !== OK || rest.length !== 32) throw new Error('maki’s Age app answered oddly')
  return rest
}

/** Which program started this, for maki to say: the age client, as the system names it. */
function program(): string {
  try {
    const name = readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim()
    return /^[A-Za-z0-9._+-]{1,24}$/.test(name) ? name : 'age'
  } catch {
    return 'age'
  }
}

// ---- the state machines ----

export interface PluginIo {
  input: Readable
  output: Writable
  /** where to explain, when not speaking the protocol */
  error: (line: string) => void
  ask: AskApp
}

/** The plugin, as `argv` asks: its exit code. */
export async function runAgePlugin(argv: string[], io: PluginIo): Promise<number> {
  const machine = argv.find((a) => a.startsWith('--age-plugin='))?.slice('--age-plugin='.length)
  try {
    if (machine === 'identity-v1') return await unwrapping(io)
    if (machine === 'recipient-v1') return await wrapping(io)
    if (machine !== undefined) {
      io.error(`age-plugin-maki: no state machine ${machine}`)
      return 1
    }
    const recipient = await makiRecipient(io.ask)
    if (argv.includes('--recipient')) {
      io.output.write(`${recipientOf(recipient)}\n`)
    } else {
      io.output.write(identityFile(recipient))
    }
    return 0
  } catch (e) {
    io.error(`age-plugin-maki: ${(e as Error).message}`)
    return 1
  }
}

/** Sends a phase-2 command and reads age's answer. */
async function command(io: PluginIo, reader: StanzaReader, text: string): Promise<Stanza> {
  io.output.write(text)
  return reader.next()
}

async function unwrapping(io: PluginIo): Promise<number> {
  const reader = new StanzaReader(io.input)
  const identities: string[] = []
  const files = new Map<number, { index: number; stanza: Stanza }[]>()
  // phase 1: what age has
  for (;;) {
    const s = await reader.next()
    if (s.tag === 'done') break
    if (s.tag === 'add-identity') identities.push(s.args[0] ?? '')
    if (s.tag === 'recipient-stanza') {
      const file = Number(s.args[0])
      const list = files.get(file) ?? []
      list.push({
        index: list.length,
        stanza: { tag: s.args[1] ?? '', args: s.args.slice(2), body: s.body }
      })
      files.set(file, list)
    }
  }
  // phase 2: ours
  const keys = identities.map(publicOfIdentity)
  const bad = keys.findIndex((k) => k === null)
  if (bad >= 0) {
    await command(
      io,
      reader,
      stanza('error', ['identity', String(bad)], Buffer.from('not an identity of maki’s'))
    )
  } else if (identities.length > 0) {
    for (const [file, list] of files) {
      const x25519 = list.filter((s) => s.stanza.tag === 'X25519')
      if (x25519.length === 0) continue
      // structurally wrong: an error for that one, and nothing unwrapped for its file
      const wrong = x25519.find(
        (s) =>
          s.stanza.args.length !== 1 ||
          unb64(s.stanza.args[0])?.length !== 32 ||
          s.stanza.body.length !== 32
      )
      if (wrong) {
        await command(
          io,
          reader,
          stanza(
            'error',
            ['stanza', String(file), String(wrong.index)],
            Buffer.from('an X25519 stanza that isn’t one')
          )
        )
        continue
      }
      try {
        const pairs = x25519
          .slice(0, 60)
          .map((s) => Buffer.concat([unb64(s.stanza.args[0])!, s.stanza.body]))
        const found = await age(io.ask, Uint8Array.from([2, pairs.length, ...Buffer.concat(pairs)]))
        if (found.code !== OK) continue // none of them is maki's
        await command(
          io,
          reader,
          stanza(
            'msg',
            [],
            Buffer.from('maki: look at its screen, and say whether to decrypt this file')
          )
        )
        const name = Buffer.from(program())
        const got = await age(
          io.ask,
          Uint8Array.from([3, ...pairs[found.rest[0]], name.length, ...name])
        )
        if (got.code === OK && got.rest.length === 16) {
          await command(io, reader, stanza('file-key', [String(file)], got.rest))
        } else if (got.code === NO) {
          await command(
            io,
            reader,
            stanza('error', ['identity', '0'], Buffer.from('you said no on maki'))
          )
        } else if (got.code !== NOT_MINE) {
          throw new Error('maki’s Age app answered oddly')
        }
      } catch (e) {
        await command(
          io,
          reader,
          stanza('error', ['identity', '0'], Buffer.from((e as Error).message))
        )
        break
      }
    }
  }
  io.output.write(stanza('done'))
  return 0
}

async function wrapping(io: PluginIo): Promise<number> {
  const reader = new StanzaReader(io.input)
  const recipients: string[] = []
  const identities: string[] = []
  const fileKeys: Uint8Array[] = []
  for (;;) {
    const s = await reader.next()
    if (s.tag === 'done') break
    if (s.tag === 'add-recipient') recipients.push(s.args[0] ?? '')
    if (s.tag === 'add-identity') identities.push(s.args[0] ?? '')
    if (s.tag === 'wrap-file-key') fileKeys.push(s.body)
  }
  // maki's key has no recipient of the plugin's own: its recipient is age's own X25519 one
  if (recipients.length > 0) {
    await command(
      io,
      reader,
      stanza(
        'error',
        ['recipient', '0'],
        Buffer.from('maki’s recipient is an ordinary age1… one: give age that')
      )
    )
  } else {
    const keys = identities.map(publicOfIdentity)
    const bad = keys.findIndex((k) => k === null)
    if (bad >= 0) {
      await command(
        io,
        reader,
        stanza('error', ['identity', String(bad)], Buffer.from('not an identity of maki’s'))
      )
    } else {
      for (const [file, fileKey] of fileKeys.entries()) {
        for (const key of keys) {
          const { share, body } = wrap(fileKey, key!)
          await command(
            io,
            reader,
            stanza('recipient-stanza', [String(file), 'X25519', b64(share)], body)
          )
        }
      }
    }
  }
  io.output.write(stanza('done'))
  return 0
}

// ---- installing it: a script on the PATH, as age looks for plugins, running this app ----

/** Where age finds it: ~/.local/bin (on Windows, a .cmd in maki's folder, which PATH needs). */
export function agePluginPath(): string {
  if (process.platform === 'win32') {
    return join(
      process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'),
      'maki',
      'age-plugin-maki.cmd'
    )
  }
  return join(homedir(), '.local', 'bin', 'age-plugin-maki')
}

export function agePluginScript({ exe, appPath }: { exe: string; appPath: string | null }): string {
  if (process.platform === 'win32') {
    const q = (s: string): string => `"${s.replace(/%/g, '%%')}"`
    const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
    return `@echo off\r\nrem written by maki desktop: age starts this to decrypt with maki\r\n${target} --age-plugin-maki %*\r\n`
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const target = appPath ? `${q(exe)} ${q(appPath)}` : q(exe)
  return `#!/bin/sh\n# written by maki desktop: age starts this to decrypt with maki\nexec ${target} --ozone-platform=headless --age-plugin-maki "$@"\n`
}

export async function agePluginStatus(launch: {
  exe: string
  appPath: string | null
}): Promise<AgePluginStatus> {
  const path = agePluginPath()
  const installed = await readFile(path, 'utf8').then(
    (text) => text === agePluginScript(launch),
    () => false
  )
  const folders = (process.env['PATH'] ?? '').split(delimiter)
  return { installed, path, onPath: folders.includes(dirname(path)) }
}

export async function installAgePlugin(launch: {
  exe: string
  appPath: string | null
}): Promise<AgePluginStatus> {
  const path = agePluginPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, agePluginScript(launch))
  await chmod(path, 0o755)
  return agePluginStatus(launch)
}
