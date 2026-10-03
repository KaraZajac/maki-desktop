/**
 * Apple's passwords, from the Passwords app (macOS 15 and later: File › Export All Passwords) or
 * Safari before it (File › Export › Passwords): a CSV whose columns are `Title, URL, Username,
 * Password, Notes, OTPAuth`, the last an otpauth:// URI for an entry with a code. Passkeys aren't
 * in it: Apple hands them over only through the Credential Exchange, between apps.
 */
import { columnsOf, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry } from './model'

const HEADER = ['title', 'url', 'username', 'password', 'notes', 'otpauth']
/** Safari's before 2022: the first four alone */
const OLDER = ['title', 'url', 'username', 'password']

export const apple: Format = {
  id: 'apple-csv',
  manager: 'Apple Passwords',
  label: 'Apple Passwords’ or Safari’s passwords (CSV)',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const at = columnsOf(doc.csv.rows[0])
    if (HEADER.every((h) => at.has(h))) return 2
    return at.size === OLDER.length && OLDER.every((h) => at.has(h)) ? 2 : 0
  },
  read(docs): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const e = entry(lineOf(doc.csv, i + 1), 'login', get(row, 'title'))
        e.urls = [get(row, 'url')]
        e.username = get(row, 'username')
        e.password = get(row, 'password')
        const code = get(row, 'otpauth').trim()
        if (code !== '') e.codes.push(code)
        entries.push(e)
      })
    }
    return entries
  }
}
