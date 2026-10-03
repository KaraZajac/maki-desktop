/**
 * Bitwarden: Tools › Export vault, as `.json` (its items whole: logins with their URIs, TOTP and
 * passkeys), `.json` with a password of its own ("password protected": the same JSON, encrypted
 * with a key from that password), or `.csv` (logins and secure notes, without passkeys). The
 * other encrypted export ("account restricted") opens only in Bitwarden with the same account,
 * so it's refused, saying which to make instead.
 *
 * A login's passkeys are `login.fido2Credentials`: the key PKCS#8, base64url (`keyValue`); the
 * credential ID a GUID (its 16 bytes, as written) or `b64.` and the ID in base64url; the user
 * handle base64url.
 */
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { argon2idAsync } from '@noble/hashes/argon2.js'
import { expand } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hasColumns, rowReader } from './csv'
import { lineOf, NeedsPassword, Refused, type Doc, type Format, type ReadOptions } from './format'
import { entry, type Entry, type FoundPasskey } from './model'
import { arr, fromBase64Any, fromHexAny, obj, str } from './text'

/** Bitwarden's item types (6 to 8 since 2026). */
const TYPES: Record<number, Entry['kind']> = {
  1: 'login',
  2: 'note',
  3: 'card',
  4: 'identity',
  5: 'ssh key',
  6: 'bank account',
  7: 'document',
  8: 'document'
}

/** A credential ID as Bitwarden keeps it: a GUID's 16 bytes, or `b64.` and base64url. */
export function credentialId(text: string): Uint8Array | null {
  if (text.startsWith('b64.')) return fromBase64Any(text.slice(4))
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text))
    return fromHexAny(text.replace(/-/g, ''))
  return null
}

/** A login's passkeys, from `fido2Credentials`. */
function passkeys(login: Record<string, unknown>): FoundPasskey[] {
  return arr(login.fido2Credentials).flatMap((c): FoundPasskey[] => {
    const p = obj(c)
    if (!p) return []
    // the key itself says what it is: `keyAlgorithm` and `keyCurve` say ECDSA and P-256 even of
    // an Ed25519 key that came to Bitwarden from elsewhere
    const key = fromBase64Any(str(p.keyValue))
    return [
      {
        rpId: str(p.rpId),
        credentialId: credentialId(str(p.credentialId)),
        userHandle: p.userHandle ? fromBase64Any(str(p.userHandle)) : null,
        userName: str(p.userName),
        displayName: str(p.userDisplayName),
        key: key ? { pkcs8: key } : null,
        counter: Number(str(p.counter)) || 0
      }
    ]
  })
}

/** The entries of Bitwarden's JSON export (its items). */
function readItems(json: Record<string, unknown>): Entry[] {
  return arr(json.items).map((raw, i) => {
    const item = obj(raw) ?? {}
    const type = Number(item.type)
    const e = entry(`item ${i + 1}`, TYPES[type] ?? 'other', str(item.name))
    if (e.kind === 'other')
      e.kindName = `an item of a kind maki desktop doesn’t know (type ${str(item.type) || '?'})`
    if (item.deletedDate) e.trashed = true
    else if (item.archivedDate) e.leftOut = 'it’s archived in Bitwarden'
    const login = obj(item.login)
    if (e.kind === 'login' && login) {
      e.urls = arr(login.uris).map((u) => str(obj(u)?.uri))
      e.username = str(login.username)
      e.password = str(login.password)
      if (str(login.totp).trim()) e.codes.push(str(login.totp))
      e.passkeys = passkeys(login)
    }
    return e
  })
}

/** An EncString of type 2 (AES-256-CBC, HMAC-SHA256): "2.iv|data|mac", each base64. */
async function decryptEncString(
  text: string,
  encKey: Uint8Array,
  macKey: Uint8Array
): Promise<Uint8Array | null> {
  const m = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(text.trim())
  if (!m)
    throw new Refused(
      'Bitwarden’s export is encrypted in a way maki desktop doesn’t know. Export it as .json without a password.'
    )
  const iv = fromBase64Any(m[1])
  const data = fromBase64Any(m[2])
  const mac = fromBase64Any(m[3])
  if (!iv || !data || !mac || iv.length !== 16) throw new Refused('Bitwarden’s export is damaged.')
  const want = hmac(sha256, macKey, new Uint8Array([...iv, ...data]))
  // a wrong password gives a wrong MAC key: no match
  if (want.length !== mac.length || want.some((b, i) => b !== mac[i])) return null
  const key = await crypto.subtle.importKey(
    'raw',
    encKey as Uint8Array<ArrayBuffer>,
    'AES-CBC',
    false,
    ['decrypt']
  )
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> },
      key,
      data as Uint8Array<ArrayBuffer>
    )
  )
}

/** The most an export's key derivation is let ask for: Bitwarden's own limits, and some. */
const LIMITS = {
  pbkdf2: 5_000_000,
  argon2Memory: 1024,
  argon2Iterations: 10,
  argon2Parallelism: 16
}

/**
 * The JSON inside a password-protected export: its key derived from the password (PBKDF2-SHA256
 * or Argon2id, with the export's salt and settings), stretched into an encryption key and a MAC
 * key (HKDF-Expand, "enc" and "mac"), then its data decrypted.
 */
async function decryptExport(
  json: Record<string, unknown>,
  options: ReadOptions
): Promise<Record<string, unknown>> {
  if (!options.password) throw new NeedsPassword(false)
  const password = new TextEncoder().encode(options.password)
  const salt = new TextEncoder().encode(str(json.salt))
  const kdf = Number(json.kdfType)
  const iterations = Number(json.kdfIterations)
  let master: Uint8Array
  if (kdf === 0) {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > LIMITS.pbkdf2)
      throw new Refused('Bitwarden’s export asks for a key derivation maki desktop won’t do.')
    master = await pbkdf2Async(sha256, password, salt, { c: iterations, dkLen: 32, asyncTick: 20 })
    options.progress?.(1)
  } else if (kdf === 1) {
    const memory = Number(json.kdfMemory)
    const parallelism = Number(json.kdfParallelism)
    if (
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > LIMITS.argon2Iterations ||
      !Number.isInteger(memory) ||
      memory < 1 ||
      memory > LIMITS.argon2Memory ||
      !Number.isInteger(parallelism) ||
      parallelism < 1 ||
      parallelism > LIMITS.argon2Parallelism
    )
      throw new Refused('Bitwarden’s export asks for a key derivation maki desktop won’t do.')
    // Argon2id's salt is the salt's SHA-256; its memory is in MiB
    master = await argon2idAsync(password, sha256(salt), {
      t: iterations,
      m: memory * 1024,
      p: parallelism,
      dkLen: 32,
      maxmem: (memory + 1) * 1024 * 1024 * 2,
      asyncTick: 20,
      onProgress: options.progress
    })
  } else throw new Refused('Bitwarden’s export uses a key derivation maki desktop doesn’t know.')
  password.fill(0)
  const encKey = expand(sha256, master, new TextEncoder().encode('enc'), 32)
  const macKey = expand(sha256, master, new TextEncoder().encode('mac'), 32)
  master.fill(0)
  try {
    // the validation string first: a wrong password shows there
    const check = await decryptEncString(str(json.encKeyValidation_DO_NOT_EDIT), encKey, macKey)
    if (check === null) throw new NeedsPassword(true)
    const data = await decryptEncString(str(json.data), encKey, macKey)
    if (data === null) throw new NeedsPassword(true)
    const text = new TextDecoder().decode(data)
    data.fill(0)
    try {
      return obj(JSON.parse(text)) ?? {}
    } catch {
      throw new Refused('Bitwarden’s export opened, but what’s inside isn’t JSON.')
    }
  } finally {
    encKey.fill(0)
    macKey.fill(0)
  }
}

export const bitwardenJson: Format = {
  id: 'bitwarden-json',
  manager: 'Bitwarden',
  label: 'Bitwarden’s JSON export',
  reads: 'json',
  fits(doc: Doc): number {
    if (doc.kind !== 'json') return 0
    const json = obj(doc.json)
    if (!json || typeof json.encrypted !== 'boolean') return 0
    return Array.isArray(json.items) || json.encrypted === true ? 2 : 0
  },
  async read(docs, options): Promise<Entry[]> {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'json') continue
      let json = obj(doc.json) ?? {}
      if (json.encrypted === true) {
        if (json.passwordProtected !== true)
          throw new Refused(
            'This is Bitwarden’s account-restricted export, which only Bitwarden opens, with the same account. Export again as .json, or as .json with a password of its own (“Password protected”).'
          )
        json = await decryptExport(json, options)
      }
      entries.push(...readItems(json))
    }
    return entries
  }
}

const CSV_HEADER = ['type', 'name', 'login_uri', 'login_username', 'login_password']

export const bitwardenCsv: Format = {
  id: 'bitwarden-csv',
  manager: 'Bitwarden',
  label: 'Bitwarden’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    return hasColumns(doc.csv.rows[0], CSV_HEADER) && hasColumns(doc.csv.rows[0], ['login_totp'])
      ? 2
      : 0
  },
  read(docs, _options, out): Entry[] {
    const entries: Entry[] = []
    for (const doc of docs) {
      if (doc.kind !== 'csv') continue
      const get = rowReader(doc.csv.rows[0])
      doc.csv.rows.slice(1).forEach((row, i) => {
        const type = get(row, 'type').trim().toLowerCase()
        const e = entry(
          lineOf(doc.csv, i + 1),
          type === 'login'
            ? 'login'
            : type === 'note'
              ? 'note'
              : type === 'card'
                ? 'card'
                : type === 'identity'
                  ? 'identity'
                  : 'other',
          get(row, 'name')
        )
        if (e.kind === 'other') e.kindName = `a ${type || 'nameless'} item`
        if (get(row, 'archivedDate').trim()) e.leftOut = 'it’s archived in Bitwarden'
        // several URIs, separated by commas (a comma in one cuts it short, but not its host)
        e.urls = get(row, 'login_uri').split(/,|\r?\n/)
        e.username = get(row, 'login_username')
        e.password = get(row, 'login_password')
        if (get(row, 'login_totp').trim()) e.codes.push(get(row, 'login_totp'))
        entries.push(e)
      })
    }
    out.notes.push('Bitwarden’s CSV export carries no passkeys: its .json export does.')
    return entries
  }
}
