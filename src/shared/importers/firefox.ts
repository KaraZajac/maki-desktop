/**
 * Firefox's passwords: about:logins › ⋯ › Export Passwords, a CSV whose columns are `url,
 * username, password, httpRealm, formActionOrigin, guid, timeCreated, timeLastUsed,
 * timePasswordChanged`. It has no names for the logins, no codes and no passkeys (Firefox keeps
 * none of its own).
 */
import { columnsOf, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry } from './model'

const HEADER = ['url', 'username', 'password', 'httprealm', 'formactionorigin', 'guid']

export const firefox: Format = {
  id: 'firefox-csv',
  manager: 'Firefox',
  label: 'Firefox’s passwords (CSV)',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const at = columnsOf(doc.csv.rows[0])
    return HEADER.every((h) => at.has(h)) ? 2 : 0
  },
  read(docs): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const e = entry(lineOf(doc.csv, i + 1))
        // the page the login is for; where its form sends it, if that's all there is
        e.urls = [get(row, 'url') || get(row, 'formActionOrigin')]
        e.username = get(row, 'username')
        e.password = get(row, 'password')
        // Firefox's own sign-in, which its export takes with the rest
        if (/^chrome:\/\/FirefoxAccounts/i.test(get(row, 'url')))
          e.leftOut = 'it’s Firefox’s own sign-in to its account, not a website’s'
        entries.push(e)
      })
    }
    return entries
  }
}
