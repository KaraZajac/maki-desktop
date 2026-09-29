/**
 * OpenPGP (RFC 4880) as far as maki's OpenPGP app needs it on the computer: ASCII armour, and
 * reading packets (their headers old and new, and the partial lengths gpg streams with). And the
 * app's messages over the link.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const OPENPGP_APP = 'com.leviathan.maki.openpgp'

/** What the app answers with first. */
export const PGP_OK = 0
export const PGP_DENIED = 1
export const PGP_NO_ANSWER = 2
export const PGP_LOCKED = 3
export const PGP_BAD = 4
export const PGP_NO_NAME = 5
export const PGP_MORE = 6

/** Why the app didn't, in words. */
export function pgpSays(code: number | undefined): string {
  switch (code) {
    case PGP_DENIED:
      return 'you said no on maki'
    case PGP_NO_ANSWER:
      return 'nobody answered on maki'
    case PGP_LOCKED:
      return 'maki is locked: enter its PIN'
    case PGP_NO_NAME:
      return 'maki’s OpenPGP key has no name yet: give it one in maki desktop (or maki-gpg --name "Name <email>")'
    default:
      return 'maki’s OpenPGP app didn’t take it'
  }
}

const b64 = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

/** CRC-24, as armour checks it (RFC 4880 6.1). */
export function crc24(data: Uint8Array): number {
  let crc = 0xb704ce
  for (const b of data) {
    crc ^= b << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if (crc & 0x1000000) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}

/** `data` in ASCII armour: `kind` is "SIGNATURE", "PUBLIC KEY BLOCK", "MESSAGE". */
export function armour(kind: string, data: Uint8Array): string {
  const body = b64(data)
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')
  const c = crc24(data)
  const sum = b64(Uint8Array.of(c >> 16, (c >> 8) & 0xff, c & 0xff))
  return `-----BEGIN PGP ${kind}-----\n\n${body}\n=${sum}\n-----END PGP ${kind}-----\n`
}

/** What's in armour, if `text` is armoured; null if it's armour that doesn't check out. */
export function unarmour(bytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64)))
  if (!text.includes('-----BEGIN PGP ')) return bytes
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP '))
  let at = begin + 1
  // headers, to a blank line
  while (at < lines.length && lines[at].trim() !== '') at++
  const body: string[] = []
  let sum: string | null = null
  for (at++; at < lines.length && !lines[at].startsWith('-----END PGP '); at++) {
    const l = lines[at].trim()
    if (l.startsWith('=') && l.length === 5) sum = l.slice(1)
    else body.push(l)
  }
  let data: Uint8Array
  try {
    data = Uint8Array.from(atob(body.join('')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (sum !== null) {
    const c = crc24(data)
    if (b64(Uint8Array.of(c >> 16, (c >> 8) & 0xff, c & 0xff)) !== sum) return null
  }
  return data
}

export interface Packet {
  tag: number
  body: Uint8Array
}

/** Packets, one after another; throws if they're cut short. */
export function packets(data: Uint8Array): Packet[] {
  const out: Packet[] = []
  let at = 0
  const need = (n: number): void => {
    if (at + n > data.length) throw new Error('an OpenPGP packet cut short')
  }
  while (at < data.length) {
    need(1)
    const head = data[at++]
    if (!(head & 0x80)) throw new Error('not OpenPGP')
    if (head & 0x40) {
      // the new format: a length, or partial lengths until a whole one
      const tag = head & 0x3f
      const parts: Uint8Array[] = []
      for (;;) {
        need(1)
        const b = data[at++]
        let len: number
        let partial = false
        if (b < 192) len = b
        else if (b < 224) {
          need(1)
          len = ((b - 192) << 8) + data[at++] + 192
        } else if (b === 255) {
          need(4)
          len = new DataView(data.buffer, data.byteOffset + at).getUint32(0)
          at += 4
        } else {
          len = 1 << (b & 0x1f)
          partial = true
        }
        need(len)
        parts.push(data.subarray(at, at + len))
        at += len
        if (!partial) break
      }
      const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of parts) {
        body.set(p, o)
        o += p.length
      }
      out.push({ tag, body })
    } else {
      // the old format: a length of 1, 2 or 4 bytes, or to the end
      const tag = (head >> 2) & 0x0f
      const kind = head & 3
      let len: number
      if (kind === 3) len = data.length - at
      else {
        const n = [1, 2, 4][kind]
        need(n)
        len = 0
        for (let i = 0; i < n; i++) len = len * 256 + data[at + i]
        at += n
      }
      need(len)
      out.push({ tag, body: data.subarray(at, at + len) })
      at += len
    }
  }
  return out
}

/** A v4 key's fingerprint and ID are the app's to give; this finds a key packet's fingerprint in the public key it exports: the first key packet's body. */
export function primaryKeyBody(key: Uint8Array): Uint8Array | null {
  return packets(key).find((p) => p.tag === 6)?.body ?? null
}

/** The user ID in an exported key. */
export function userId(key: Uint8Array): string | null {
  const p = packets(key).find((x) => x.tag === 13)
  return p ? new TextDecoder().decode(p.body) : null
}
