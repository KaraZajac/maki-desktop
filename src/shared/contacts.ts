/**
 * maki's Contacts app: your card, which maki signs and shows as a QR code to swap at the con, and
 * the people you met, from their cards (a maki's, whose signature maki checked, or a phone's).
 * maki desktop sets your card and saves the people as vCards, each once maki's owner says yes.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const CONTACTS_APP = 'com.leviathan.maki.contacts'

/** A card's name's and line's most bytes, and the most lines. */
export const CARD_NAME = 32
export const CARD_LINE = 48
export const CARD_LINES = 3

export interface Person {
  name: string
  lines: string[]
  /** whether their card was signed (by their maki), and its key, in hex */
  signed: boolean
  key: string | null
  /** when you met, in seconds since 1970; 0 if maki didn't know the time */
  met: number
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const control = /[\u0000-\u001f\u007f]/

/** The app's `C` message: your card from now on. Null if the app wouldn't take it. */
export function cardMessage(name: string, lines: string[]): Uint8Array | null {
  const kept = lines.map((l) => l.trim()).filter((l) => l !== '')
  const ok =
    name.trim() !== '' &&
    bytes(name).length <= CARD_NAME &&
    !control.test(name) &&
    kept.length <= CARD_LINES &&
    kept.every((l) => bytes(l).length <= CARD_LINE && !control.test(l))
  if (!ok) return null
  const parts: number[] = ['C'.charCodeAt(0), 1, bytes(name).length, ...bytes(name), kept.length]
  for (const l of kept) parts.push(bytes(l).length, ...bytes(l))
  return Uint8Array.from(parts)
}

/** The people in the app's answer to `P`; null if it isn't one. */
export function readPeople(a: Uint8Array): Person[] | null {
  if (a[0] !== 0) return null
  const people: Person[] = []
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength)
  let at = 1
  const text = (n: number): string => {
    const s = new TextDecoder().decode(a.subarray(at, at + n))
    at += n
    return s
  }
  while (at < a.length) {
    if (at + 11 > a.length) return null
    const signed = a[at] === 1
    const met = Number(view.getBigUint64(at + 1, true))
    const len = view.getUint16(at + 9, true)
    at += 11
    const end = at + len
    if (end > a.length || a[at] !== 1) return null
    at += 1
    const name = text(a[at++])
    const lines: string[] = []
    for (let n = a[at++]; n > 0; n--) lines.push(text(a[at++]))
    if (at !== end) return null
    let key: string | null = null
    if (signed) {
      if (at + 32 > a.length) return null
      key = [...a.subarray(at, at + 32)].map((b) => b.toString(16).padStart(2, '0')).join('')
      at += 32
    }
    people.push({ name, lines, signed, key, met })
  }
  return people
}

/** vCard's escaping for a value. */
const esc = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;')

/** The people as vCards (3.0), their lines as an email, a phone number, a site, or a note. */
export function vcards(people: Person[]): string {
  return people
    .map((p) => {
      const out = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(p.name)}`, `N:;${esc(p.name)};;;`]
      const notes: string[] = []
      for (const l of p.lines) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l)) out.push(`EMAIL:${esc(l)}`)
        else if (/^\+?[\d\s().-]{6,}$/.test(l)) out.push(`TEL:${esc(l)}`)
        else if (/^https?:\/\//.test(l) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(l))
          out.push(`URL:${esc(l)}`)
        else notes.push(l)
      }
      const met = p.met > 0 ? `Met ${new Date(p.met * 1000).toISOString().slice(0, 10)}` : 'Met'
      const how = p.signed
        ? `, their card signed by their maki (key ${p.key!.slice(0, 16)})`
        : ', from a phone’s card'
      notes.push(`${met}${how}. Saved from maki.`)
      out.push(`NOTE:${esc(notes.join('\n'))}`)
      if (p.key) out.push(`X-MAKI-KEY:${p.key}`)
      out.push('END:VCARD')
      return out.join('\r\n') + '\r\n'
    })
    .join('')
}

/** What the app's answer says, in words: null if it did what was asked. */
export function contactsSays(answer: Uint8Array): string | null {
  switch (answer[0]) {
    case 0:
      return null
    case 1:
      return 'you said no on maki'
    case 2:
      return 'nobody answered on maki'
    case 3:
      return 'maki is locked: enter its PIN'
    default:
      return 'maki’s Contacts app didn’t take it'
  }
}
