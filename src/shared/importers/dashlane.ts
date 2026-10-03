/**
 * Dashlane: Settings › Export data › CSV. The web app writes a zip of CSV files, the iOS, macOS
 * and Android apps a folder of them: `credentials.csv` (the logins), `securenotes.csv`,
 * `payments.csv`, `ids.csv`, `personalInfo.csv` and, from Apple's apps, `wifi.csv`. A login's
 * username is `username` (Dashlane's web app puts the email, the login and the secondary login in
 * `username`, `username2` and `username3`, the first that's set first); its code `otpUrl` (an
 * otpauth:// URI), `otp` from its apps, or `otpSecret` in older exports. Android's app names the
 * columns `user_name`... and may write `null` for a code it hasn't. Passkeys aren't in it:
 * Dashlane hands them over only through the Credential Exchange, between apps.
 *
 * Its encrypted export (a `.dash` file, "Dashlane Secured Export") opens only in Dashlane.
 */
import { columnsOf, headerKey, rowReader, type Csv } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind } from './model'

/** Which of Dashlane's files a CSV is, by its header. */
function which(csv: Csv): 'credentials' | EntryKind | null {
  if (csv.rows.length === 0) return null
  const at = columnsOf(csv.rows[0])
  const has = (...names: string[]): boolean => names.every((n) => at.has(headerKey(n)))
  if (
    (has('username', 'username2', 'username3') || has('user_name', 'user_name_2')) &&
    has('title', 'password', 'url')
  )
    return 'credentials'
  if (has('ssid', 'passphrase')) return 'wifi'
  if (
    has('cc_number') ||
    has('ccnumber') ||
    (has('type', 'account_name', 'account_holder') && has('code'))
  )
    return 'card'
  if (has('type', 'number', 'name', 'place_of_issue') || has('type', 'number', 'placeofissue'))
    return 'document'
  if (has('type', 'first_name', 'last_name') || has('type', 'firstname', 'lastname'))
    return 'identity'
  if (has('title', 'note') && at.size <= 3) return 'note'
  return null
}

export const dashlane: Format = {
  id: 'dashlane-csv',
  manager: 'Dashlane',
  label: 'Dashlane’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv') return 0
    const kind = which(doc.csv)
    if (kind === 'credentials') return 2
    // its other files, by their names as well as their columns
    return kind !== null && /^(securenotes|payments|ids|personalinfo|wifi)\.csv$/i.test(doc.name)
      ? 2
      : 0
  },
  read(docs, _options, out): Entry[] {
    out.notes.push(
      'Dashlane’s export carries no passkeys: they stay in Dashlane (its apps hand them to other apps through the Credential Exchange).'
    )
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const kind = which(doc.csv)
      const get = rowReader(doc.csv.rows[0])
      const value = (row: string[], ...names: string[]): string => {
        for (const n of names) {
          const v = get(row, n)
          if (v !== '' && v !== 'null') return v
        }
        return ''
      }
      const several = docs.length > 1
      doc.csv.rows.slice(1).forEach((row, i) => {
        const where = several ? `${doc.name}, ${lineOf(doc.csv, i + 1)}` : lineOf(doc.csv, i + 1)
        if (kind !== 'credentials') {
          const e = entry(
            where,
            kind ?? 'other',
            value(row, 'title', 'name', 'item_name', 'ssid', 'account_name')
          )
          if (kind === null) e.kindName = 'an item of a kind maki desktop doesn’t know'
          entries.push(e)
          return
        }
        const e = entry(where, 'login', value(row, 'title'))
        e.urls = [value(row, 'url')]
        e.username = value(row, 'username', 'user_name')
        e.password = get(row, 'password')
        const code = value(row, 'otpUrl', 'otp', 'otpSecret').trim()
        if (code) e.codes.push(code)
        entries.push(e)
      })
    }
    return entries
  }
}
