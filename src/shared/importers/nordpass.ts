/**
 * NordPass: Settings › Export items, a CSV: `name, url, additional_urls, username, password,
 * note, cardholdername, cardnumber, cvc, pin, expirydate, zipcode, folder, full_name,
 * phone_number, email, address1, address2, city, country, state, type, custom_fields` (older
 * exports without some of these). `type` says what a row is: `password` (a login), `note`,
 * `credit_card`, `identity`, `document`, or a `folder` (not an entry). `additional_urls` is a JSON
 * array. No codes and no passkeys: NordPass exports neither.
 */
import { columnsOf, hasColumns, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind } from './model'
import { arr, str } from './text'

const HEADER = ['name', 'url', 'username', 'password', 'note', 'cardholdername', 'cardnumber']

const TYPES: Record<string, EntryKind> = {
  password: 'login',
  note: 'note',
  credit_card: 'card',
  identity: 'identity',
  document: 'document'
}

export const nordpass: Format = {
  id: 'nordpass-csv',
  manager: 'NordPass',
  label: 'NordPass’s CSV export',
  reads: 'csv',
  fits: (doc: Doc) =>
    doc.kind === 'csv' && doc.csv.rows.length > 0 && hasColumns(doc.csv.rows[0], HEADER) ? 2 : 0,
  read(docs, _options, out): Entry[] {
    out.notes.push('NordPass’s export carries no codes and no passkeys.')
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const typed = columnsOf(doc.csv.rows[0]).has('type')
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const type = get(row, 'type').trim()
        if (type === 'folder') return
        // the oldest exports have no type: a row with a card number is a card, one with a password a login
        const kind: EntryKind = typed
          ? (TYPES[type] ?? 'other')
          : get(row, 'cardnumber')
            ? 'card'
            : 'login'
        const e = entry(lineOf(doc.csv, i + 1), kind, get(row, 'name'))
        if (kind === 'other') e.kindName = `a ${type || 'nameless'} item`
        if (kind === 'login') {
          let more: string[] = []
          try {
            more = arr(JSON.parse(get(row, 'additional_urls') || '[]')).map(str)
          } catch {
            // not JSON: the one address
          }
          e.urls = [get(row, 'url'), ...more]
          e.username = get(row, 'username') || get(row, 'email')
          e.password = get(row, 'password')
          // NordPass's import template has a totp column; an export may one day
          if (get(row, 'totp').trim()) e.codes.push(get(row, 'totp'))
        }
        entries.push(e)
      })
    }
    return entries
  }
}
