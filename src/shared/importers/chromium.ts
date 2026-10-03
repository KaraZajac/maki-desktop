/**
 * Chrome's passwords, and those of the browsers made from Chromium (Edge, Brave, Opera, Vivaldi):
 * Settings › Passwords (Google Password Manager) › Export passwords, a CSV of `name,url,username,
 * password` and, since 2023, `note`. Passkeys stay in the browser's (or Google's) own store: the
 * export doesn't carry them.
 */
import { columnsOf, headerKey, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry } from './model'

const HEADER = ['name', 'url', 'username', 'password']

/** Which Chromium browser made the file, from its name ("Brave Passwords.csv"), if it says. */
const BROWSERS: [RegExp, string][] = [
  [/edge/i, 'Edge'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/chromium/i, 'Chromium'],
  [/chrome|google/i, 'Chrome']
]

export const chromium: Format = {
  id: 'chromium-csv',
  manager: 'Chrome',
  label: 'Chrome’s or another Chromium browser’s passwords (CSV)',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const keys = doc.csv.rows[0].map(headerKey)
    const at = columnsOf(doc.csv.rows[0])
    if (!HEADER.every((h) => at.has(h))) return 0
    // its own header exactly: these four, and the note (Chrome's, since 2023)
    return keys.every((k) => HEADER.includes(k) || k === 'note') ? 2 : 0
  },
  read(docs, _options, out): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const browser = BROWSERS.find(([name]) => name.test(doc.name))
      if (browser) out.source = browser[1]
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const e = entry(lineOf(doc.csv, i + 1), 'login', get(row, 'name'))
        e.urls = [get(row, 'url')]
        e.username = get(row, 'username')
        e.password = get(row, 'password')
        entries.push(e)
      })
    }
    if (!out.source) out.source = 'a browser'
    return entries
  }
}
