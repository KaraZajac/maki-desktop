/**
 * LastPass: Advanced Options › Export, from the browser extension, `lastpass_export.csv`:
 * `url,username,password,totp,extra,name,grouping,fav` (older exports without `totp`, which holds
 * a bare base32 secret when it holds anything). A secure note is a row whose url is `http://sn`;
 * a note of a kind (a card, an address, a bank account...) says so in its first line,
 * `NoteType:Credit Card`. Passkeys stay in LastPass: its export has no place for them.
 *
 * LastPass's exporters have quirks, met here: one puts a space before a value that starts with
 * `=`, `+` or `-` (so a spreadsheet won't take it for a formula), taken off again; another writes
 * rows without quoting, so a comma in a field shifts the rest: such a row has more fields than the
 * header, and is left out rather than read wrong.
 */
import { columnsOf, hasColumns, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind } from './model'

const HEADER = ['url', 'username', 'password', 'extra', 'name', 'grouping', 'fav']

/** LastPass's kinds of note, by what its `NoteType:` line says. */
const NOTES: [RegExp, EntryKind, string?][] = [
  [/^credit card/i, 'card'],
  [/^bank account/i, 'bank account'],
  [/^address/i, 'identity'],
  [
    /^(passport|driver'?s license|social security|insurance|health insurance|membership)/i,
    'document'
  ],
  [/^ssh key/i, 'ssh key'],
  [/^wi-?fi/i, 'wifi'],
  [
    /^(database|server|email account|instant messenger|software license)/i,
    'other',
    'a note of login details'
  ]
]

/** A value as it was before the exporter's formula guard put a space before it. */
function unguarded(value: string): string {
  return /^ [=+-]/.test(value) && !/^ [=+-]?\d+(\.\d+)?$/.test(value) ? value.slice(1) : value
}

export const lastpass: Format = {
  id: 'lastpass-csv',
  manager: 'LastPass',
  label: 'LastPass’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const at = columnsOf(doc.csv.rows[0])
    return hasColumns(doc.csv.rows[0], HEADER) && at.size <= 9 ? 2 : 0
  },
  read(docs, _options, out): Entry[] {
    const entries: Entry[] = []
    let escaped = 0
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const header = doc.csv.rows[0]
      const raw = rowReader(header)
      const get = (row: string[], name: string): string => unguarded(raw(row, name))
      doc.csv.rows.slice(1).forEach((row, i) => {
        const e = entry(lineOf(doc.csv, i + 1), 'login', get(row, 'name'))
        const url = get(row, 'url').trim()
        if (row.length > header.length) {
          // a field with a comma in it, unquoted: what's after it can't be told apart
          e.leftOut =
            'LastPass wrote a comma in it without quoting it, so its fields can’t be told apart: add it by hand'
        } else if (url.toLowerCase() === 'http://sn') {
          const type = /^NoteType:(.*)$/m.exec(get(row, 'extra'))?.[1].trim() ?? ''
          const known = NOTES.find(([re]) => re.test(type))
          e.kind = known ? known[1] : 'note'
          if (known?.[2]) e.kindName = known[2]
        } else {
          e.urls = [url]
          e.username = get(row, 'username')
          e.password = get(row, 'password')
          const totp = get(row, 'totp').trim()
          if (totp) e.codes.push(totp)
          if (/&(amp|lt|gt);/.test(e.password)) escaped++
        }
        entries.push(e)
      })
    }
    if (escaped > 0)
      out.notes.push(
        `${escaped === 1 ? 'A password has' : `${escaped} passwords have`} “&amp;”, “&lt;” or “&gt;” in ${escaped === 1 ? 'it' : 'them'}, which some LastPass exports wrote in place of “&”, “<” and “>”. They’re sent as they are: if one doesn’t work, that’s why.`
      )
    return entries
  }
}
