/**
 * minisign's files (jedisct1.github.io/minisign), for the minisign key maki's Minisign app keeps:
 * the public key as `minisign.pub` has it and `minisign -P` takes it, and signatures as
 * `minisign -S` writes them, which minisign itself checks. And the app's messages over the link.
 *
 * A public key is "Ed", its 8-byte ID and the Ed25519 key; a signature "ED" (a signature of the
 * file's BLAKE2b-512 hash: minisign's prehashed kind), the key's ID and the signature, then a
 * trusted comment and a global signature, of the signature and the comment together.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const MINISIGN_APP = 'com.leviathan.maki.minisign'

/** What the Minisign app answers with first. */
export const MINISIGN_OK = 0
export const MINISIGN_DENIED = 1
export const MINISIGN_NO_ANSWER = 2
export const MINISIGN_LOCKED = 3
export const MINISIGN_BAD = 4

export interface MinisignKey {
  public: Uint8Array
  id: Uint8Array
}

export interface MinisignSignature {
  id: Uint8Array
  signature: Uint8Array
  trusted: string
  global: Uint8Array
}

const b64 = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

const unb64 = (s: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A key's ID as minisign prints it: its 8 bytes as a little-endian number, in hex. */
export function keyIdHex(id: Uint8Array): string {
  return [...id]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** The public key as one line of base64, as `minisign -P` takes it. */
export function publicKeyText(k: MinisignKey): string {
  return b64(concat(new TextEncoder().encode('Ed'), k.id, k.public))
}

/** The public key as `minisign.pub` has it. */
export function publicKeyFile(k: MinisignKey): string {
  return `untrusted comment: minisign public key ${keyIdHex(k.id)}\n${publicKeyText(k)}\n`
}

/** A public key from `minisign -P`'s text or a `minisign.pub` file; null if it isn't one. */
export function parsePublicKey(text: string): MinisignKey | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const line = lines.find((l) => !l.startsWith('untrusted comment:'))
  const b = line ? unb64(line) : null
  if (!b || b.length !== 42 || b[0] !== 0x45 || b[1] !== 0x64) return null
  return { id: b.slice(2, 10), public: b.slice(10) }
}

/** A signature file, as `minisign -S` writes it. */
export function signatureFile(s: MinisignSignature, untrusted = 'signature from maki'): string {
  const sig = concat(new TextEncoder().encode('ED'), s.id, s.signature)
  return `untrusted comment: ${untrusted}\n${b64(sig)}\ntrusted comment: ${s.trusted}\n${b64(s.global)}\n`
}

/** A signature file's parts, and whether it's prehashed ("ED") or legacy ("Ed"); null if it isn't one. */
export function parseSignature(
  text: string
): (MinisignSignature & { prehashed: boolean; untrusted: string }) | null {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  if (lines.length < 4) return null
  const [u, sigLine, t, globalLine] = lines
  if (!u.startsWith('untrusted comment: ') || !t.startsWith('trusted comment: ')) return null
  const sig = unb64(sigLine)
  const global = unb64(globalLine)
  if (!sig || sig.length !== 74 || !global || global.length !== 64) return null
  const kind = String.fromCharCode(sig[0], sig[1])
  if (kind !== 'ED' && kind !== 'Ed') return null
  return {
    prehashed: kind === 'ED',
    untrusted: u.slice('untrusted comment: '.length),
    id: sig.slice(2, 10),
    signature: sig.slice(10),
    trusted: t.slice('trusted comment: '.length),
    global
  }
}

/** The app's `S` message: a file's BLAKE2b-512 hash, its size and name, and a trusted comment of the signer's (empty for maki's own). */
export function signRequest(
  hash: Uint8Array,
  size: number,
  name: string,
  trusted = ''
): Uint8Array {
  const n = new TextEncoder().encode(name)
  const c = new TextEncoder().encode(trusted)
  const head = new Uint8Array(1 + 64 + 8 + 1)
  head[0] = 'S'.charCodeAt(0)
  head.set(hash, 1)
  new DataView(head.buffer).setBigUint64(65, BigInt(size), true)
  head[73] = n.length
  const len = new Uint8Array(2)
  new DataView(len.buffer).setUint16(0, c.length, true)
  return concat(head, n, len, c)
}

/** The app's answer to `S`, signed; null if it isn't. */
export function parseSignAnswer(a: Uint8Array): MinisignSignature | null {
  if (a.length < 75 + 64 || a[0] !== MINISIGN_OK) return null
  const n = a[73] | (a[74] << 8)
  if (a.length !== 75 + n + 64) return null
  return {
    id: a.slice(1, 9),
    signature: a.slice(9, 73),
    trusted: new TextDecoder().decode(a.subarray(75, 75 + n)),
    global: a.slice(75 + n)
  }
}

/** The app's answer to `P`, its public key; null if it isn't. */
export function parseKeyAnswer(a: Uint8Array): MinisignKey | null {
  if (a.length !== 41 || a[0] !== MINISIGN_OK) return null
  return { public: a.slice(1, 33), id: a.slice(33) }
}

/** Why the app didn't sign, in words. */
export function minisignSays(code: number | undefined): string {
  switch (code) {
    case MINISIGN_DENIED:
      return 'you said no on maki'
    case MINISIGN_NO_ANSWER:
      return 'nobody answered on maki'
    case MINISIGN_LOCKED:
      return 'maki is locked: enter its PIN'
    default:
      return 'maki’s Minisign app didn’t take it'
  }
}
