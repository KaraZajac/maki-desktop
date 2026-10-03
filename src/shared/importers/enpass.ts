/**
 * Enpass 6: File › Export, as `.json`: `{folders, items}`, each item with a `category` (login,
 * password, creditcard, identity, note, finance, license, travel, computer, misc), a
 * `template_type`, `trashed` and `archived` (0 or 1), and `fields`: each a `type` (username,
 * email, password, url, totp, `.Android#` for an app...), a `value`, and `deleted`. A code is a
 * `totp` field holding the secret as it was typed (or, perhaps, an otpauth:// URI). Passkeys stay
 * in Enpass: its exports don't carry them.
 */
import type { Doc, Format } from './format'
import { entry, type Entry, type EntryKind } from './model'
import { arr, obj, str } from './text'

/** Enpass's categories (and a few templates within them) as maki sees them. */
function kindOf(category: string, template: string): [EntryKind, string?] {
  if (category === 'login' || category === 'password') return ['login']
  if (category === 'creditcard') return ['card']
  if (category === 'identity') return ['identity']
  if (category === 'note') return ['note']
  if (template === 'computer.wifi') return ['wifi']
  if (template === 'finance.bankaccount') return ['bank account']
  if (category === 'travel') return ['document']
  if (category === 'license') return ['other', 'a licence']
  if (category === 'finance') return ['other', 'a financial item']
  if (category === 'computer') return ['other', 'a computer’s details']
  return ['other', `an item of another kind (${category || 'none'})`]
}

export const enpass: Format = {
  id: 'enpass-json',
  manager: 'Enpass',
  label: 'Enpass’s JSON export',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    const first = obj(arr(json?.items)[0])
    return first && 'template_type' in first && 'category' in first ? 2 : 0
  },
  read(docs, _options, out): Entry[] {
    out.notes.push('Enpass’s export carries no passkeys: they stay in Enpass.')
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'json') continue
      arr(obj(doc.json)?.items).forEach((raw, i) => {
        const item = obj(raw) ?? {}
        const [kind, kindName] = kindOf(str(item.category), str(item.template_type))
        const e = entry(`item ${i + 1}`, kind, str(item.title))
        if (kindName) e.kindName = kindName
        if (Number(item.trashed) === 1) e.trashed = true
        else if (Number(item.archived) === 1) e.leftOut = 'it’s archived in Enpass'
        if (kind === 'login') {
          let email = ''
          for (const f of arr(item.fields)) {
            const field = obj(f) ?? {}
            if (Number(field.deleted) === 1) continue
            const value = str(field.value)
            if (value === '') continue
            switch (str(field.type)) {
              case 'username':
                if (!e.username) e.username = value
                break
              case 'email':
                if (!email) email = value
                break
              case 'password':
                if (!e.password) e.password = value
                break
              case 'url':
                e.urls.push(value)
                break
              case 'totp':
                e.codes.push(value)
                break
            }
          }
          if (!e.username) e.username = email
        }
        entries.push(e)
      })
    }
    return entries
  }
}
