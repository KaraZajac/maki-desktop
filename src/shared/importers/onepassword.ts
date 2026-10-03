/**
 * 1Password: File › Export, as 1PUX (a zip: `export.data`, the accounts' vaults and items in
 * JSON, with `export.attributes` and `files/` beside it) or as CSV (Title, Url, Username,
 * Password, OTPAuth, Favorite, Archived, Tags, Notes: logins and passwords only).
 *
 * In 1PUX an item's category says what it is (001 a login, 005 a password...); its username and
 * password are the login fields designated so, its addresses `overview.url` and `overview.urls`,
 * and its codes the section fields whose value is a `totp` (an otpauth:// URI or a bare secret).
 * Neither export carries passkeys: 1Password hands them over only through the Credential
 * Exchange, from its phone apps, never in a file.
 */
import { columnsOf, hasColumns, rowReader } from './csv'
import { lineOf, type Doc, type Format } from './format'
import { entry, type Entry, type EntryKind } from './model'
import { arr, obj, str } from './text'

/** 1Password's categories, by `categoryUuid`: what each is, for maki. */
const CATEGORIES: Record<string, [EntryKind, string?]> = {
  '001': ['login'],
  '002': ['card'],
  '003': ['note'],
  '004': ['identity'],
  '005': ['login'],
  '006': ['document'],
  '100': ['other', 'a software licence'],
  '101': ['bank account'],
  '102': ['other', 'a database'],
  '103': ['document'],
  '104': ['document'],
  '105': ['other', 'a membership'],
  '106': ['document'],
  '107': ['other', 'a reward programme'],
  '108': ['document'],
  '109': ['wifi'],
  '110': ['other', 'a server'],
  '111': ['other', 'an email account'],
  '112': ['other', 'an API credential'],
  '113': ['document'],
  '114': ['ssh key'],
  '115': ['other', 'a crypto wallet']
}

const NO_PASSKEYS =
  '1Password’s exports carry no passkeys: they stay in 1Password (its phone apps hand them to other apps through the Credential Exchange).'

/** The entries in 1PUX's `export.data`. */
function readExportData(json: Record<string, unknown>): Entry[] {
  const entries: Entry[] = []
  let n = 0
  for (const account of arr(json.accounts)) {
    for (const v of arr(obj(account)?.vaults)) {
      const vault = obj(v) ?? {}
      const vaultName = str(obj(vault.attrs)?.name)
      for (const raw of arr(vault.items)) {
        n++
        const item = obj(raw) ?? {}
        const overview = obj(item.overview) ?? {}
        const details = obj(item.details) ?? {}
        const category = CATEGORIES[str(item.categoryUuid)] ?? [
          'other',
          `an item of a kind maki desktop doesn’t know (category ${str(item.categoryUuid) || '?'})`
        ]
        const e = entry(
          vaultName ? `item ${n} (${vaultName})` : `item ${n}`,
          category[0],
          str(overview.title)
        )
        if (category[1]) e.kindName = category[1]
        if (item.trashed === true || str(item.state) === 'trashed') e.trashed = true
        else if (str(item.state) === 'archived') e.leftOut = 'it’s archived in 1Password'
        if (e.kind === 'login') {
          const urls = [str(overview.url), ...arr(overview.urls).map((u) => str(obj(u)?.url))]
          e.urls = urls.filter((u, i) => u !== '' && urls.indexOf(u) === i)
          for (const f of arr(details.loginFields)) {
            const field = obj(f) ?? {}
            const designation = str(field.designation)
            if (designation === 'username' && e.username === '') e.username = str(field.value)
            if (designation === 'password' && e.password === '') e.password = str(field.value)
          }
          if (e.password === '') e.password = str(details.password)
          for (const s of arr(details.sections))
            for (const f of arr(obj(s)?.fields)) {
              const totp = str(obj(obj(f)?.value)?.totp).trim()
              if (totp) e.codes.push(totp)
            }
          // an early 1PUX (1Password 8.10.9 to 8.10.11) named a login's passkey, never its key
          const passkey = obj(details.passkey)
          if (passkey)
            e.passkeys.push({
              rpId: str(passkey.rpId),
              credentialId: null,
              userHandle: null,
              userName: e.username,
              displayName: '',
              key: null,
              unavailable: 'its key isn’t in 1Password’s export'
            })
        }
        entries.push(e)
      }
    }
  }
  return entries
}

export const onePux: Format = {
  id: '1password-1pux',
  manager: '1Password',
  label: '1Password’s 1PUX export',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    const first = obj(arr(json?.accounts)[0])
    return first && Array.isArray(first.vaults) ? 2 : 0
  },
  read(docs, _options, out): Entry[] {
    out.notes.push(NO_PASSKEYS)
    return docs.flatMap((d) => (d.kind === 'json' ? readExportData(obj(d.json) ?? {}) : []))
  }
}

const CSV_HEADER = ['title', 'url', 'username', 'password', 'otpauth']

export const onePasswordCsv: Format = {
  id: '1password-csv',
  manager: '1Password',
  label: '1Password’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const header = doc.csv.rows[0]
    // Apple's CSV has these too, with Notes but no Archived
    return hasColumns(header, CSV_HEADER) && columnsOf(header).has('archived') ? 2 : 0
  },
  read(docs, _options, out): Entry[] {
    out.notes.push(NO_PASSKEYS)
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
        if (code) e.codes.push(code)
        if (get(row, 'archived').trim().toLowerCase() === 'true')
          e.leftOut = 'it’s archived in 1Password'
        entries.push(e)
      })
    }
    return entries
  }
}
