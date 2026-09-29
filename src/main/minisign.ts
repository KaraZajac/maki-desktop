/**
 * maki-minisign: minisign (jedisct1.github.io/minisign) with the key maki's Minisign app keeps.
 * It hashes each file as minisign does (BLAKE2b-512, minisign's prehashed signatures) and asks
 * the app, through the tray app's socket and the link; maki asks its owner, with the file's name
 * and size, then signs the hash and a trusted comment that says when maki signed it, by its own
 * clock. The signature files are minisign's own: `minisign -V` checks them, as this does.
 *
 *     maki-minisign -S -m FILE… [-x SIGFILE] [-t COMMENT] [-c COMMENT]    sign
 *     maki-minisign -R [-p PUBKEY_FILE]                                   the public key
 *     maki-minisign -V -m FILE [-x SIGFILE] [-p PUBKEY_FILE | -P KEY] [-q | -Q]
 *
 * As minisign, flags combine (`-Sm file`), and `-p` and `-P` default to maki's own key.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  type MinisignKey,
  minisignSays,
  parseKeyAnswer,
  parsePublicKey,
  parseSignAnswer,
  parseSignature,
  publicKeyFile,
  signatureFile,
  signRequest
} from '../shared/minisign'
import type { AskApp } from './age-plugin'
import type { Command } from './scripts'

export const MINISIGN_COMMAND: Command = {
  name: 'maki-minisign',
  flag: '--maki-minisign',
  why: 'minisign, with the key maki keeps'
}

export interface MinisignIO {
  /** what goes to stdout */
  output: (text: string) => void
  /** a line to stderr */
  error: (line: string) => void
  /** maki's Minisign app */
  ask: AskApp
}

const USAGE = `maki-minisign: minisign, with the key maki's Minisign app keeps

  maki-minisign -S -m FILE… [-x SIGFILE] [-t COMMENT] [-c COMMENT]   sign, once you say so on maki
  maki-minisign -R [-p PUBKEY_FILE]                                  maki's public key
  maki-minisign -V -m FILE [-x SIGFILE] [-p PUBKEY_FILE | -P KEY] [-q | -Q]   check a signature

  -m  the file(s)            -x  the signature (FILE.minisig)
  -t  the trusted comment    -c  the untrusted comment
  -p  a public key file      -P  a public key, as minisign -P takes it (else maki's)
  -q  quiet                  -Q  only the trusted comment
`

/** Flags as minisign takes them: combined (`-Sm`), and the ones that take a value. */
function parse(args: string[]): { flags: Set<string>; values: Map<string, string[]> } | string {
  const takes = new Set(['m', 'x', 'p', 'P', 't', 'c'])
  const flags = new Set<string>()
  const values = new Map<string, string[]>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!/^-[A-Za-z]+$/.test(a)) {
      // the files after -m, as minisign takes several
      if (flags.has('m')) {
        values.get('m')!.push(a)
        continue
      }
      return `what is ${a}?`
    }
    const letters = a.slice(1)
    for (let j = 0; j < letters.length; j++) {
      const f = letters[j]
      flags.add(f)
      if (!takes.has(f)) continue
      const v = j === letters.length - 1 ? args[++i] : undefined
      if (v === undefined) return `-${f} needs something after it`
      values.set(f, [...(values.get(f) ?? []), v])
      break
    }
  }
  return { flags, values }
}

/** A file's BLAKE2b-512 hash and size, read as a stream. */
export async function hashFile(path: string): Promise<{ hash: Uint8Array; size: number }> {
  const size = (await stat(path)).size
  const h = createHash('blake2b512')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return { hash: new Uint8Array(h.digest()), size }
}

async function makiKey(ask: AskApp): Promise<MinisignKey> {
  const r = await ask(Uint8Array.of('P'.charCodeAt(0)))
  if (r.status === 'no match')
    throw new Error(
      'maki’s Minisign app isn’t installed: add it from the maki store, in maki desktop'
    )
  const key = r.status === 'approved' ? parseKeyAnswer(r.answer) : null
  if (!key) throw new Error(minisignSays(r.answer[0]))
  return key
}

/** Whether `signature` is `key`'s, of this file: the hash, then the trusted comment. */
export async function check(
  path: string,
  signatureText: string,
  key: MinisignKey
): Promise<{ ok: true; trusted: string } | { ok: false; why: string }> {
  const s = parseSignature(signatureText)
  if (!s) return { ok: false, why: 'that isn’t a minisign signature' }
  if (Buffer.compare(Buffer.from(s.id), Buffer.from(key.id)) !== 0)
    return { ok: false, why: 'signed with another key' }
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.public]),
    format: 'der',
    type: 'spki'
  })
  const message = s.prehashed ? (await hashFile(path)).hash : await readFile(path)
  if (!verify(null, message, pub, s.signature))
    return { ok: false, why: 'the signature doesn’t match the file' }
  const both = Buffer.concat([s.signature, Buffer.from(s.trusted, 'utf8')])
  if (!verify(null, both, pub, s.global))
    return { ok: false, why: 'the trusted comment was changed' }
  return { ok: true, trusted: s.trusted }
}

export async function runMinisign(argv: string[], io: MinisignIO): Promise<number> {
  const at = argv.indexOf(MINISIGN_COMMAND.flag)
  const p = parse(at >= 0 ? argv.slice(at + 1) : argv)
  if (typeof p === 'string') {
    io.error(`maki-minisign: ${p}`)
    io.error(USAGE)
    return 2
  }
  const { flags, values } = p
  const one = (f: string): string | undefined => values.get(f)?.[0]
  try {
    if (flags.has('S')) {
      const files = values.get('m') ?? []
      if (files.length === 0) throw new Error('which file? -m FILE')
      if (files.length > 1 && one('x'))
        throw new Error('-x names one signature: sign one file with it')
      for (const file of files) {
        const { hash, size } = await hashFile(file)
        const r = await io.ask(signRequest(hash, size, basename(file), one('t') ?? ''))
        if (r.status === 'no match')
          throw new Error(
            'maki’s Minisign app isn’t installed: add it from the maki store, in maki desktop'
          )
        const s = r.status === 'approved' ? parseSignAnswer(r.answer) : null
        if (!s) throw new Error(`${file}: ${minisignSays(r.answer[0])}`)
        const out = one('x') ?? `${file}.minisig`
        await writeFile(out, signatureFile(s, one('c')))
        io.error(`${file}: signed, ${out}`)
      }
      return 0
    }
    if (flags.has('R')) {
      const text = publicKeyFile(await makiKey(io.ask))
      const out = one('p')
      if (out) {
        await writeFile(out, text)
        io.error(`maki's public key: ${out}`)
      } else io.output(text)
      return 0
    }
    if (flags.has('V')) {
      const file = one('m')
      if (!file) throw new Error('which file? -m FILE')
      const given = one('P') ?? (one('p') ? await readFile(one('p')!, 'utf8') : null)
      const key = given !== null ? parsePublicKey(given) : await makiKey(io.ask)
      if (!key) throw new Error('that isn’t a minisign public key')
      const r = await check(file, await readFile(one('x') ?? `${file}.minisig`, 'utf8'), key)
      if (!r.ok) {
        io.error(`Signature verification failed: ${r.why}`)
        return 1
      }
      if (flags.has('Q')) io.output(`${r.trusted}\n`)
      else if (!flags.has('q'))
        io.output(`Signature and comment signature verified\nTrusted comment: ${r.trusted}\n`)
      return 0
    }
    io.output(USAGE)
    return flags.has('h') ? 0 : 2
  } catch (e) {
    io.error(`maki-minisign: ${(e as Error).message}`)
    return 1
  }
}
