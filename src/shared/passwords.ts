/**
 * maki's Password Maker: passwords maki makes from the recovery phrase (BIP-85) and types or shows
 * itself. maki desktop says which is which (a site, its username, the password's number, length
 * and alphabet, and whether Enter follows it) and never sees a password: maki asks its owner
 * before each change.
 *
 * The app's messages (sdk/examples/passwords), numbers little-endian: `L` and the first wanted
 * (u16), answered `0`, the protocol's version, how many there are (u16) and the entries from the
 * first wanted that fit; `A` an entry with id 0, answered `0` and its id (u32); `R` an entry,
 * changed; `D` an id (u32), removed. Otherwise `1` no, `2` no answer, `4` not taken, `5` no room.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const PASSWORDS_APP = 'com.leviathan.maki.passwords'

/** The protocol's version the app's `L` answer says, which this reads. */
export const PASSWORDS_VERSION = 1

export type Alphabet = 'base64' | 'base85'

export interface PasswordEntry {
  /** the app's, 0 for one not added yet */
  id: number
  alphabet: Alphabet
  /** characters: 20 to 86 in base64, 10 to 80 in base85 */
  length: number
  /** BIP-85's index: any number below 2³¹ */
  number: number
  /** Enter pressed after the password */
  enter: boolean
  site: string
  /** printable ASCII, which maki types; may be empty */
  user: string
}

/** A site's most bytes (a page's heading on maki's review screen), a username's. */
export const SITE_BYTES = 32
export const USER_BYTES = 64
/** The most entries the app keeps. */
export const MOST_ENTRIES = 100
/** The lengths BIP-85 allows each alphabet. */
export const LENGTHS: Record<Alphabet, readonly [number, number]> = {
  base64: [20, 86],
  base85: [10, 80]
}
export const MAX_NUMBER = 2 ** 31 - 1
/** A Coldcard's Type Passwords: base64, 21 characters, then Enter. */
export const COLDCARD_LENGTH = 21

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Why the app wouldn't take `e`, in words; null if it would. */
export function entryProblem(e: Omit<PasswordEntry, 'id'>): string | null {
  const [least, most] = LENGTHS[e.alphabet] ?? [0, -1]
  if (!Number.isInteger(e.length) || e.length < least || e.length > most)
    return `A ${e.alphabet} password is ${least} to ${most} characters.`
  if (!Number.isInteger(e.number) || e.number < 0 || e.number > MAX_NUMBER)
    return `Its number is a whole number from 0 to ${MAX_NUMBER}.`
  if (e.site.trim() === '') return 'It needs a site: what maki lists it as.'
  if (utf8(e.site).length > SITE_BYTES) return `A site’s name fits in ${SITE_BYTES} bytes.`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(e.site)) return 'A site’s name is one line.'
  if (utf8(e.user).length > USER_BYTES) return `A username fits in ${USER_BYTES} characters.`
  if (!/^[\x20-\x7e]*$/.test(e.user))
    return 'maki types a username as a US keyboard would: letters, digits and symbols, no accents.'
  return null
}

/** `e` as the app's messages carry it. */
export function entryBytes(e: PasswordEntry): Uint8Array {
  const site = utf8(e.site)
  const user = utf8(e.user)
  const b = new Uint8Array(13 + site.length + user.length)
  const v = new DataView(b.buffer)
  v.setUint32(0, e.id, true)
  b[4] = e.alphabet === 'base64' ? 0 : 1
  b[5] = e.length
  v.setUint32(6, e.number, true)
  b[10] = e.enter ? 1 : 0
  b[11] = site.length
  b.set(site, 12)
  b[12 + site.length] = user.length
  b.set(user, 13 + site.length)
  return b
}

/** One entry from the front of `b`, and how many bytes it took; null for one the app wouldn't put. */
export function readEntry(b: Uint8Array): { entry: PasswordEntry; size: number } | null {
  if (b.length < 13) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const alphabet = b[4] === 0 ? 'base64' : b[4] === 1 ? 'base85' : null
  if (alphabet === null || b[10] > 1) return null
  const n = b[11]
  if (b.length < 13 + n) return null
  const m = b[12 + n]
  if (b.length < 13 + n + m) return null
  const decode = (x: Uint8Array): string | null => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(x)
    } catch {
      return null
    }
  }
  const site = decode(b.subarray(12, 12 + n))
  const user = decode(b.subarray(13 + n, 13 + n + m))
  if (site === null || user === null) return null
  const entry: PasswordEntry = {
    id: v.getUint32(0, true),
    alphabet,
    length: b[5],
    number: v.getUint32(6, true),
    enter: b[10] === 1,
    site,
    user
  }
  return entryProblem(entry) === null ? { entry, size: 13 + n + m } : null
}

/** `L`: the entries from `first`. */
export function listMessage(first: number): Uint8Array {
  return Uint8Array.of('L'.charCodeAt(0), first & 0xff, (first >> 8) & 0xff)
}

/** What `L`'s answer holds: how many there are in all, and those it carried; null if it isn't one. */
export function readList(answer: Uint8Array): { total: number; entries: PasswordEntry[] } | null {
  if (answer.length < 4 || answer[0] !== 0 || answer[1] !== PASSWORDS_VERSION) return null
  const total = answer[2] | (answer[3] << 8)
  const entries: PasswordEntry[] = []
  let at = 4
  while (at < answer.length) {
    const one = readEntry(answer.subarray(at))
    if (!one) return null
    entries.push(one.entry)
    at += one.size
  }
  return { total, entries }
}

/** `A`: a new entry. Null if the app wouldn't take it. */
export function addMessage(e: Omit<PasswordEntry, 'id'>): Uint8Array | null {
  if (entryProblem(e) !== null) return null
  return Uint8Array.of('A'.charCodeAt(0), ...entryBytes({ ...e, id: 0 }))
}

/** `R`: entry `e.id` changed to `e`. Null if the app wouldn't take it. */
export function changeMessage(e: PasswordEntry): Uint8Array | null {
  if (entryProblem(e) !== null || e.id === 0) return null
  return Uint8Array.of('R'.charCodeAt(0), ...entryBytes(e))
}

/** `D`: entry `id` removed. */
export function removeMessage(id: number): Uint8Array {
  const m = new Uint8Array(5)
  m[0] = 'D'.charCodeAt(0)
  new DataView(m.buffer).setUint32(1, id, true)
  return m
}

/** The id in `A`'s answer, if it added one. */
export function addedId(answer: Uint8Array): number | null {
  if (answer.length !== 5 || answer[0] !== 0) return null
  return new DataView(answer.buffer, answer.byteOffset).getUint32(1, true)
}

/** What an answer to `A`, `R` or `D` says, in words: null if it was done. */
export function passwordSays(answer: Uint8Array): string | null {
  switch (answer[0]) {
    case 0:
      return null
    case 1:
      return 'you said no on maki'
    case 2:
      return 'nobody answered on maki'
    case 5:
      return `maki’s Password Maker keeps ${MOST_ENTRIES} at most`
    default:
      return 'maki’s Password Maker didn’t take it'
  }
}

/** The number to suggest for a new entry: the lowest no entry has. */
export function freeNumber(entries: PasswordEntry[]): number {
  const used = new Set(entries.map((e) => e.number))
  let n = 0
  while (used.has(n)) n++
  return n
}
