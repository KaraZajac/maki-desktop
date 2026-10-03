/**
 * The FIDO Alliance's Credential Exchange Format (CXF 1.0), as JSON: what managers hand one
 * another through the Credential Exchange Protocol, for the owner who has it as a file. The whole
 * export (`version`, `exporterRpId`, `exporterDisplayName`, `timestamp`, `accounts`) or a single
 * account (`id`, `username`, `email`, `collections`, `items`). Each item has its addresses in
 * `scope.urls` and its `credentials`: `basic-auth` (a username and a password, each an
 * EditableField, `{fieldType, value}`), `passkey` (its key PKCS#8, its IDs base64url), `totp`
 * (a base32 secret and its settings), and kinds maki doesn't keep (credit-card, note, wifi...).
 * The 2024 working draft's shapes (an item `type`, `urls` in basic-auth, `userName`) are read too.
 */
import type { Doc, Format } from './format'
import { entry, type Entry, type EntryKind } from './model'
import { arr, cutTo, fromBase64Any, label, obj, str } from './text'

/** The kinds of credential that make an item something other than a login. */
const OTHERS: Record<string, [EntryKind, string?]> = {
  'credit-card': ['card'],
  note: ['note'],
  'identity-document': ['document'],
  passport: ['document'],
  'drivers-license': ['document'],
  address: ['identity'],
  'person-name': ['identity'],
  'ssh-key': ['ssh key'],
  wifi: ['wifi'],
  'api-key': ['other', 'an API key'],
  file: ['document'],
  'custom-fields': ['other', 'a set of custom fields'],
  'generated-password': ['other', 'a generated password with no site']
}

/** An EditableField's value (or, in the 2024 draft, the string itself). */
const field = (v: unknown): string => (typeof v === 'string' ? v : str(obj(v)?.value))

/** The accounts in a CXF document: the header's, or the one account it is. */
function accounts(json: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(json.accounts)) return arr(json.accounts).map((a) => obj(a) ?? {})
  return Array.isArray(json.items) ? [json] : []
}

export const cxf: Format = {
  id: 'cxf',
  manager: 'a Credential Exchange file',
  label: 'the Credential Exchange Format (CXF, JSON)',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    if (!json) return 0
    if ('exporterRpId' in json || 'exporterDisplayName' in json || 'exporter' in json) return 2
    // a bare account: items with credentials
    const item = obj(arr(accounts(json)[0]?.items)[0])
    return item && Array.isArray(item.credentials) && 'collections' in (accounts(json)[0] ?? {})
      ? 2
      : 0
  },
  read(docs, _options, out): Entry[] {
    const entries: Entry[] = []
    let n = 0
    for (const doc of docs) {
      if (doc.kind !== 'json') continue
      const json = obj(doc.json) ?? {}
      const exporter = label(
        str(json.exporterDisplayName) || str(json.exporterRpId) || str(json.exporter)
      )
      if (exporter) out.source = cutTo(exporter, 32).trim()
      for (const account of accounts(json)) {
        for (const raw of arr(account.items)) {
          n++
          const item = obj(raw) ?? {}
          const e = entry(`item ${n}`, 'login', str(item.title))
          e.urls = arr(obj(item.scope)?.urls).map(str)
          let other: [EntryKind, string?] | null = null
          for (const c of arr(item.credentials)) {
            const credential = obj(c) ?? {}
            const type = str(credential.type)
            if (type === 'basic-auth') {
              e.username ||= field(credential.username)
              e.password ||= field(credential.password)
              e.urls.push(...arr(credential.urls).map(str))
            } else if (type === 'passkey') {
              const key = fromBase64Any(str(credential.key))
              e.passkeys.push({
                rpId: str(credential.rpId),
                credentialId: fromBase64Any(str(credential.credentialId)),
                userHandle: credential.userHandle
                  ? fromBase64Any(str(credential.userHandle))
                  : null,
                userName: str(credential.username) || str(credential.userName),
                displayName: str(credential.userDisplayName),
                key: key ? { pkcs8: key } : null
              })
            } else if (type === 'totp') {
              e.codes.push({
                secret: str(credential.secret),
                period: credential.period === undefined ? 30 : Number(credential.period),
                digits: credential.digits === undefined ? 6 : Number(credential.digits),
                algorithm: str(credential.algorithm) || 'sha1',
                issuer: str(credential.issuer),
                account: field(credential.username)
              })
            } else if (OTHERS[type]) other ??= OTHERS[type]
          }
          // an item with nothing of a login's: what its credentials are; the 2024 draft's type
          const draftType = str(item.type)
          if (!e.password && e.passkeys.length === 0 && e.codes.length === 0) {
            const [kind, kindName] =
              other ??
              (draftType === 'document'
                ? ['document']
                : draftType === 'identity'
                  ? ['identity']
                  : ['login'])
            e.kind = kind
            if (kindName) e.kindName = kindName
          }
          entries.push(e)
        }
      }
    }
    return entries
  }
}
