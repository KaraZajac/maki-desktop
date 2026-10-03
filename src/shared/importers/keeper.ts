/**
 * Keeper: Settings › Export, as JSON or CSV.
 *
 * The JSON: `{shared_folders, records}`, each record a `title`, `$type` (login, bankCard,
 * encryptedNotes...; none for an old "general" record), `login`, `password`, `login_url`,
 * `notes`, and `custom_fields`, keyed `$type:label:n` (`$oneTimeCode::1`), `$type`, or a plain
 * label. A code is a `$oneTimeCode` (or, from older exports, `TFC:Keeper`): an otpauth:// URI. A
 * passkey is a `$passkey`: its key a JWK, its credential ID and user handle (`userId`) base64url.
 *
 * The CSV has no header: Folder, Title, Login, Password, Website Address, Notes, Shared Folder,
 * then custom fields as name and value pairs (a code is the pair named `TFC:Keeper`). It carries
 * no passkeys. Without a header it can't be told by its columns alone: by its code fields, or the
 * owner's word.
 */
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind, type FoundPasskey } from './model'
import { arr, fromBase64Any, obj, str } from './text'

/** Keeper's record types, as maki sees them. */
const TYPES: Record<string, [EntryKind, string?]> = {
  login: ['login'],
  general: ['login'],
  bankCard: ['card'],
  bankAccount: ['bank account'],
  encryptedNotes: ['note'],
  sshKeys: ['ssh key'],
  address: ['identity'],
  contact: ['identity'],
  file: ['document'],
  photo: ['document'],
  passport: ['document'],
  driverLicense: ['document'],
  ssnCard: ['document'],
  birthCertificate: ['document'],
  healthInsurance: ['document'],
  wifiCredentials: ['wifi'],
  databaseCredentials: ['other', 'a database’s login'],
  serverCredentials: ['other', 'a server’s login'],
  softwareLicense: ['other', 'a software licence'],
  membership: ['other', 'a membership']
}

/** Whether a custom field's key (`$oneTimeCode::1`, `$oneTimeCode`, `TFC:Keeper`) is a code's. */
const isCode = (key: string): boolean => /^\$oneTimeCode(:|$)/.test(key) || key === 'TFC:Keeper'

/** A `$passkey` field's value. */
function keeperPasskey(p: Record<string, unknown>): FoundPasskey {
  const jwk = obj(p.privateKey)
  return {
    rpId: str(p.relyingParty),
    credentialId: fromBase64Any(str(p.credentialId)),
    userHandle: p.userId ? fromBase64Any(str(p.userId)) : null,
    userName: str(p.username),
    displayName: '',
    key: jwk && jwk.d ? { jwk } : null,
    counter: Number(p.signCount) || 0
  }
}

export const keeperJson: Format = {
  id: 'keeper-json',
  manager: 'Keeper',
  label: 'Keeper’s JSON export',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    return json && Array.isArray(json.records) && !('items' in json) ? 2 : 0
  },
  read(docs): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'json') continue
      arr(obj(doc.json)?.records).forEach((raw, i) => {
        const record = obj(raw) ?? {}
        const type = str(record.$type) || 'general'
        const [kind, kindName] = TYPES[type] ?? [
          'other',
          `a record of a kind maki desktop doesn’t know (${type})`
        ]
        const e = entry(`record ${i + 1}`, kind, str(record.title))
        if (kindName) e.kindName = kindName
        // a general record with nothing of a login's in it is something else
        if (type === 'general' && !record.password && !record.login && !record.login_url) {
          e.kind = 'other'
          e.kindName = 'a record with no login in it'
        }
        if (e.kind === 'login') {
          e.urls = [str(record.login_url)]
          e.username = str(record.login)
          e.password = str(record.password)
          for (const [key, value] of Object.entries(obj(record.custom_fields) ?? {})) {
            const values = Array.isArray(value) ? value : [value]
            if (isCode(key)) for (const v of values) if (str(v).trim()) e.codes.push(str(v))
            if (/^\$passkey(:|$)/.test(key))
              for (const v of values) if (obj(v)) e.passkeys.push(keeperPasskey(obj(v)!))
          }
        }
        entries.push(e)
      })
    }
    return entries
  }
}

/** Whether a row of a header-less CSV has Keeper's custom fields: a code's, or Commander's `$type`. */
function keeperRow(row: string[]): boolean {
  for (let i = 7; i + 1 < row.length; i += 2) if (isCode(row[i]) || row[i] === '$type') return true
  return false
}

export const keeperCsv: Format = {
  id: 'keeper-csv',
  manager: 'Keeper',
  label: 'Keeper’s CSV export (it has no header)',
  reads: 'csv',
  fits: (doc: Doc) => (doc.kind === 'csv' && doc.csv.rows.some(keeperRow) ? 2 : 0),
  read(docs, _options, out): Entry[] {
    out.notes.push('Keeper’s CSV export carries no passkeys: its JSON export does.')
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      doc.csv.rows.forEach((row, i) => {
        const e = entry(lineOf(doc.csv, i), 'login', row[1] ?? '')
        if (row.length < 6) {
          e.leftOut = 'it has fewer columns than Keeper writes'
          entries.push(e)
          return
        }
        const custom = new Map<string, string>()
        for (let c = 7; c + 1 < row.length; c += 2) custom.set(row[c], row[c + 1])
        const type = custom.get('$type')
        if (type && TYPES[type]?.[0] !== 'login') {
          const [kind, kindName] = TYPES[type] ?? [
            'other',
            `a record of a kind maki desktop doesn’t know (${type})`
          ]
          e.kind = kind
          if (kindName) e.kindName = kindName
        } else {
          e.username = row[2] ?? ''
          e.password = row[3] ?? ''
          e.urls = [row[4] ?? '']
          for (const [name, value] of custom) if (isCode(name) && value.trim()) e.codes.push(value)
        }
        entries.push(e)
      })
    }
    return entries
  }
}
