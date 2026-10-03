/**
 * Proton Pass: Settings › Export, from its web app, browser extension or desktop app. The zip
 * (`Proton Pass/data.json`: every vault the owner has, and their items, passkeys and all), or a
 * CSV (no passkeys). The PGP-encrypted export (`data.pgp`) is refused, saying to export without.
 *
 * A login's content: `itemUsername` and `itemEmail` (one `username`, holding the email, before
 * 1.18), `password`, `urls` (and `autofillUrls` with their modes), `totpUri`, and `passkeys`. A
 * passkey's `content` is the passkey as Proton's Rust core keeps it, MessagePack (rmp-serde):
 * `{c, v}` around `{key, cid, rid, uhd, cnt}`, the key a COSE key whose parameters are pairs of
 * `{t: "int", c: label}` and `{t: "bytes", c: [...]}`: `-4` is the private scalar.
 */
import { columnsOf, hasColumns, rowReader } from './csv'
import { lineOf, Refused, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind, type FoundPasskey } from './model'
import { msgpackBytes, readMsgpack, type Msgpack } from './msgpack'
import { arr, fromBase64Any, obj, str } from './text'

/** Proton's item types. */
const TYPES: Record<string, [EntryKind, string?]> = {
  login: ['login'],
  note: ['note'],
  alias: ['alias'],
  creditCard: ['card'],
  identity: ['identity'],
  sshKey: ['ssh key'],
  wifi: ['wifi'],
  custom: ['other', 'a custom item']
}

/** An item's kind, by its type's name. */
function kindOf(type: string): [EntryKind, string?] {
  return TYPES[type] ?? ['other', `an item of a kind maki desktop doesn’t know (${type || 'none'})`]
}

/** A value of the passkey's MessagePack, as a plain object. */
const m = (v: Msgpack | undefined): { [key: string]: Msgpack } | null =>
  v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : null

/** An `{inner: [16 bytes]}` integer (an i128, little-endian), or a plain one. */
function int(v: Msgpack | undefined): number | null {
  if (typeof v === 'number') return v
  const inner = msgpackBytes(m(v)?.inner)
  if (!inner || inner.length !== 16) return null
  let n = 0
  for (let i = 7; i >= 0; i--) n = n * 256 + inner[i]
  return inner[15] & 0x80 ? n - 2 ** 64 : n
}

/** A passkey of Proton's export. */
export function protonPasskey(raw: Record<string, unknown>): FoundPasskey {
  const outer = {
    rpId: str(raw.rpId) || str(raw.domain),
    credentialId: fromBase64Any(str(raw.credentialId)) ?? fromBase64Any(str(raw.keyId)),
    userHandle: fromBase64Any(str(raw.userHandle)) ?? fromBase64Any(str(raw.userId)),
    userName: str(raw.userName),
    displayName: str(raw.userDisplayName)
  }
  const found: FoundPasskey = { ...outer, key: null }
  const content = fromBase64Any(str(raw.content))
  if (!content) return found
  try {
    const wrapper = m(readMsgpack(content))
    const inner = m(readMsgpack(msgpackBytes(wrapper?.c) ?? new Uint8Array()))
    if (!inner) return found
    found.rpId = (typeof inner.rid === 'string' && inner.rid) || outer.rpId
    found.credentialId = msgpackBytes(inner.cid) ?? outer.credentialId
    found.userHandle = msgpackBytes(inner.uhd) ?? outer.userHandle
    if (!found.userName && typeof inner.un === 'string') found.userName = inner.un
    if (!found.displayName && typeof inner.udn === 'string') found.displayName = inner.udn
    found.counter = typeof inner.cnt === 'number' ? inner.cnt : 0
    const key = m(inner.key)
    const kty = m(key?.kty)?.c
    const params = new Map<number, number | Uint8Array>([
      [1, kty === 'EC2' ? 2 : kty === 'OKP' ? 1 : 0]
    ])
    for (const pair of Array.isArray(key?.par) ? key.par : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const label = int(m(pair[0])?.c)
      const value = m(pair[1])
      if (label === null || !value) continue
      const bytes = value.t === 'bytes' ? msgpackBytes(value.c) : null
      const n = value.t === 'int' ? int(value.c) : null
      if (bytes) params.set(label, bytes)
      else if (n !== null) params.set(label, n)
    }
    found.key = { coseKey: params }
  } catch {
    // its content can't be read: no key, said so
  }
  return found
}

/** The entries of Proton's data.json. */
function readData(json: Record<string, unknown>): Entry[] {
  if (json.encrypted === true)
    throw new Refused(
      'This Proton Pass export is encrypted. Export again with encryption off (Settings › Export), import it, then move the file to the trash.'
    )
  const entries: Entry[] = []
  let n = 0
  for (const v of Object.values(obj(json.vaults) ?? {})) {
    const vault = obj(v) ?? {}
    for (const raw of arr(vault.items)) {
      n++
      const item = obj(raw) ?? {}
      const data = obj(item.data) ?? {}
      const [kind, kindName] = kindOf(str(data.type))
      const e = entry(
        str(vault.name) ? `item ${n} (${str(vault.name)})` : `item ${n}`,
        kind,
        str(obj(data.metadata)?.name)
      )
      if (kindName) e.kindName = kindName
      if (Number(item.state) === 2) e.trashed = true
      const content = obj(data.content) ?? {}
      if (kind === 'login') {
        e.username = str(content.itemUsername) || str(content.itemEmail) || str(content.username)
        e.password = str(content.password)
        // its addresses: the default ones, then any others it fills at (not those it never does)
        const autofill = arr(content.autofillUrls)
          .map((u) => obj(u))
          .filter((u) => u && Number(u.mode) !== 2)
          .map((u) => str(u?.url))
        const urls = [...arr(content.urls).map(str), ...autofill]
        e.urls = urls.filter((u, i) => u !== '' && urls.indexOf(u) === i)
        if (str(content.totpUri).trim()) e.codes.push(str(content.totpUri))
        for (const f of arr(data.extraFields)) {
          const field = obj(f)
          const totp = str(obj(field?.data)?.totpUri).trim()
          if (str(field?.type) === 'totp' && totp) e.codes.push(totp)
        }
        e.passkeys = arr(content.passkeys).map((p) => protonPasskey(obj(p) ?? {}))
      }
      entries.push(e)
    }
  }
  return entries
}

export const protonJson: Format = {
  id: 'proton-json',
  manager: 'Proton Pass',
  label: 'Proton Pass’s export (its zip)',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    return json && obj(json.vaults) && ('userId' in json || 'version' in json) ? 2 : 0
  },
  read: (docs) => docs.flatMap((d) => (d.kind === 'json' ? readData(obj(d.json) ?? {}) : []))
}

const CSV_HEADER = ['type', 'name', 'url', 'username', 'password', 'note', 'totp', 'createtime']

export const protonCsv: Format = {
  id: 'proton-csv',
  manager: 'Proton Pass',
  label: 'Proton Pass’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    return hasColumns(doc.csv.rows[0], CSV_HEADER) && columnsOf(doc.csv.rows[0]).has('modifytime')
      ? 2
      : 0
  },
  read(docs, _options, out): Entry[] {
    out.notes.push(
      'Proton Pass’s CSV export carries no passkeys (its zip does), and doesn’t say which items are in its trash: they’re read like the rest.'
    )
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const [kind, kindName] = kindOf(get(row, 'type').trim())
        const e = entry(lineOf(doc.csv, i + 1), kind, get(row, 'name'))
        if (kindName) e.kindName = kindName
        if (kind === 'login') {
          // the default addresses, separated by ", "; then the others, JSON (since 2026)
          let autofill: string[] = []
          try {
            autofill = arr(JSON.parse(get(row, 'autofillUrls') || '[]'))
              .map((u) => obj(u))
              .filter((u) => u && Number(u.mode) !== 2)
              .map((u) => str(u?.url))
          } catch {
            // not JSON: the default addresses alone
          }
          e.urls = [...get(row, 'url').split(/,\s*/), ...autofill]
          // older exports had the email in `username`, before there was an `email`
          e.username = get(row, 'username') || get(row, 'email')
          e.password = get(row, 'password')
          if (get(row, 'totp').trim()) e.codes.push(get(row, 'totp'))
        }
        entries.push(e)
      })
    }
    return entries
  }
}
