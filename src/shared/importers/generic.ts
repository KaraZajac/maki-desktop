/**
 * Any other CSV of logins: its columns found from its header where they're named the usual way
 * (url, username, password, title, totp...), or chosen by the owner where they aren't, or where
 * there's no header at all.
 */
import { headerKey, type Csv } from './csv'
import { lineOf, type Columns, type Format } from './format'
import { entry, type Entry } from './model'

/** What each column is called, by `headerKey`, the likeliest first. */
const NAMES: Record<Exclude<keyof Columns, 'header'>, string[]> = {
  url: [
    'url',
    'uri',
    'loginuri',
    'website',
    'websiteaddress',
    'site',
    'address',
    'link',
    'domain',
    'host',
    'hostname',
    'origin',
    'urls'
  ],
  username: [
    'username',
    'loginusername',
    'user',
    'login',
    'email',
    'emailaddress',
    'userid',
    'loginname'
  ],
  password: ['password', 'loginpassword', 'pass', 'passwd', 'pwd', 'secret'],
  title: ['title', 'name', 'entry', 'label', 'accountname', 'account', 'item', 'service'],
  totp: [
    'totp',
    'logintotp',
    'otp',
    'otpauth',
    'otpsecret',
    'otpurl',
    '2fa',
    'mfa',
    'onetimepassword',
    'authenticator',
    'twofactor',
    'totpsecret'
  ]
}

/** The columns a header names the usual way; `header` false when its first row names none of them. */
export function guessColumns(csv: Csv): Columns {
  const first = csv.rows[0]?.map(headerKey) ?? []
  const taken = new Set<number>()
  // a column's place, by its name (exactly, then a name with one of them in it, "Password (old)"),
  // among those not taken already
  const find = (names: string[]): number => {
    const free = (i: number): boolean => i >= 0 && !taken.has(i)
    let at = -1
    for (const n of names) {
      at = first.findIndex((k, i) => free(i) && k === n)
      if (at >= 0) break
    }
    if (at < 0)
      for (const n of names) {
        at = first.findIndex((k, i) => free(i) && k.length > n.length && k.includes(n))
        if (at >= 0) break
      }
    if (at >= 0) taken.add(at)
    return at
  }
  // the most telling first: a password column, then the site's, the username's, the name's
  const password = find(NAMES.password)
  const url = find(NAMES.url)
  const username = find(NAMES.username)
  const totp = find(NAMES.totp)
  const title = find(NAMES.title)
  const guess = { url, username, password, title, totp }
  const named = Object.values(guess).filter((i) => i >= 0).length
  // a first row that names a password column and another is a header
  if (guess.password >= 0 && named >= 2) return { header: true, ...guess }
  return { header: false, url: -1, username: -1, password: -1, title: -1, totp: -1 }
}

/** The entries in a CSV, by `columns`. */
export function readColumns(csv: Csv, columns: Columns): Entry[] {
  const at = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? '') : '')
  const entries: Entry[] = []
  csv.rows.forEach((row, i) => {
    if (i === 0 && columns.header) return
    const e = entry(lineOf(csv, i), 'login', at(row, columns.title))
    e.urls = [at(row, columns.url)]
    e.username = at(row, columns.username)
    e.password = at(row, columns.password)
    const code = at(row, columns.totp).trim()
    if (code !== '') e.codes.push(code)
    entries.push(e)
  })
  return entries
}

export const generic: Format = {
  id: 'generic-csv',
  manager: 'a CSV file',
  label: 'a CSV of logins, its columns said here',
  reads: 'csv',
  // never by itself: it's the owner's choice, for a CSV nothing else fits
  fits: () => 0,
  read(docs, options): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      entries.push(...readColumns(doc.csv, options.columns ?? guessColumns(doc.csv)))
    }
    return entries
  }
}
