/**
 * KeePassXC and KeePass: KeePassXC's CSV export (Database › Export › CSV File), and KeePass 2's
 * XML (KeePass: File › Export › KeePass XML (2.x); KeePassXC: `keepassxc-cli export -f xml`),
 * which keeps every attribute, KeePassXC's passkeys among them (`KPEX_PASSKEY_*`: the relying
 * party, the credential ID and user handle in base64url, the key as PEM). Codes: KeePassXC's `otp`
 * attribute (an otpauth:// URI), its older `TOTP Seed` and `TOTP Settings`, and KeePass's own
 * `TimeOtp-*` fields. The recycle bin's entries and the entries' history are left out.
 */
import { columnsOf, hasColumns, rowReader } from './csv'
import { lineOf, Refused, type Doc, type Format } from './format'
import { entry, type Entry, type FoundCode } from './model'
import { fromBase64Any, fromHexAny } from './text'
import { child, children, type XmlElement } from './xml'

/** A code from KeePass's fields, whichever way it keeps one; null if it has none. */
export function keepassCode(get: (key: string) => string | undefined): FoundCode | null {
  const otp = get('otp')?.trim()
  // an otpauth:// URI, or KeeOtp's own "key=…&size=6&step=30&otpHashMode=SHA256"
  if (otp && /^otpauth:/i.test(otp)) return otp
  if (otp && /(^|&)key=/.test(otp)) {
    const p = new URLSearchParams(otp)
    return {
      secret: p.get('key') ?? '',
      digits: Number(p.get('size') ?? 6),
      period: Number(p.get('step') ?? 30),
      algorithm: p.get('otpHashMode') ?? 'SHA1',
      kind: p.get('type')?.toLowerCase() === 'hotp' ? 'hotp' : 'totp'
    }
  }
  if (otp) return otp
  // KeePassXC's older fields: a base32 seed, and "period;digits" (or "period;S" for Steam's)
  const seed = get('TOTP Seed')?.trim()
  if (seed) {
    const settings = (get('TOTP Settings') ?? '30;6').split(';')
    if (settings[1] === 'S') return { secret: seed, kind: 'steam' }
    return { secret: seed, period: Number(settings[0] || 30), digits: Number(settings[1] || 6) }
  }
  // KeePass 2.47's own: the secret in one of four encodings, and its settings
  const algorithm = (get('TimeOtp-Algorithm') ?? 'HMAC-SHA-1')
    .replace(/^HMAC-/i, '')
    .replace(/-/g, '')
  const length = get('TimeOtp-Length')
  const period = get('TimeOtp-Period')
  const settings = {
    algorithm,
    digits: length ? Number(length) : 6,
    period: period ? Number(period) : 30
  }
  const base32 = get('TimeOtp-Secret-Base32')?.trim()
  if (base32) return { secret: base32, ...settings }
  const hex = get('TimeOtp-Secret-Hex')?.trim()
  const b64 = get('TimeOtp-Secret-Base64')?.trim()
  const utf8 = get('TimeOtp-Secret')
  const bytes = hex
    ? fromHexAny(hex)
    : b64
      ? fromBase64Any(b64)
      : utf8
        ? new TextEncoder().encode(utf8)
        : null
  return bytes ? { secret: bytes, ...settings } : null
}

const CSV_HEADER = ['group', 'title', 'username', 'password', 'url', 'notes']

export const keepassxcCsv: Format = {
  id: 'keepassxc-csv',
  manager: 'KeePassXC',
  label: 'KeePassXC’s CSV export',
  reads: 'csv',
  fits(doc: Doc): number {
    if (doc.kind !== 'csv' || doc.csv.rows.length === 0) return 0
    const header = doc.csv.rows[0]
    if (!hasColumns(header, CSV_HEADER)) return 0
    // its own header: those, its TOTP and dates; KeePass's own CSV looks much the same
    return columnsOf(header).has('lastmodified') || columnsOf(header).has('totp') ? 2 : 1
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
        const code = get(row, 'totp').trim()
        if (code !== '') e.codes.push(code)
        // the recycle bin, by its name (KeePassXC names it so, in English)
        if (/(^|\/)recycle bin$/i.test(get(row, 'group').trim())) e.trashed = true
        entries.push(e)
      })
    }
    return entries
  }
}

/** An entry's strings, by key: KeePass keeps everything as Key/Value pairs. */
function strings(e: XmlElement): { values: Map<string, string>; encrypted: boolean } {
  const values = new Map<string, string>()
  let encrypted = false
  for (const s of children(e, 'String')) {
    const key = child(s, 'Key')?.text ?? ''
    const value = child(s, 'Value')
    // a value encrypted with the database's inner stream: an XML taken from a database, not an export
    if (value?.attrs.Protected?.toLowerCase() === 'true') encrypted = true
    values.set(key, value?.text ?? '')
  }
  return { values, encrypted }
}

export const keepassXml: Format = {
  id: 'keepass-xml',
  manager: 'KeePass',
  label: 'KeePass’s XML export (KeePass 2, or KeePassXC)',
  reads: 'xml',
  fits: (doc: Doc) => (doc.kind === 'xml' && doc.xml.name === 'KeePassFile' ? 2 : 0),
  read(docs, _options, out): Entry[] {
    const entries: Entry[] = []
    let n = 0
    for (const doc of docs) {
      if (doc.kind !== 'xml') continue
      const meta = child(doc.xml, 'Meta')
      const generator = child(meta ?? doc.xml, 'Generator')?.text ?? ''
      if (/keepassxc/i.test(generator)) out.source = 'KeePassXC'
      const recycleBin = child(meta ?? doc.xml, 'RecycleBinUUID')?.text.trim() ?? ''
      const root = child(doc.xml, 'Root')
      if (!root) continue
      let encrypted = false
      const walk = (group: XmlElement, trashed: boolean, path: string): void => {
        const uuid = child(group, 'UUID')?.text.trim() ?? ''
        const inBin =
          trashed ||
          (recycleBin !== '' && uuid === recycleBin && recycleBin !== 'AAAAAAAAAAAAAAAAAAAAAA==')
        const name = child(group, 'Name')?.text ?? ''
        const here = path ? `${path}/${name}` : name
        for (const x of children(group, 'Entry')) {
          n++
          const { values, encrypted: hidden } = strings(x)
          if (hidden) encrypted = true
          const get = (key: string): string | undefined => values.get(key)
          const e = entry(`entry ${n}`, 'login', get('Title') ?? '')
          if (here) e.where = `entry ${n} (${here})`
          // KeePass2Android's extra addresses, after the entry's own
          e.urls = [
            get('URL') ?? '',
            ...[...values.keys()]
              .filter((k) => k.startsWith('KP2A_URL'))
              .map((k) => values.get(k) ?? '')
          ]
          e.username = get('UserName') ?? ''
          e.password = get('Password') ?? ''
          const code = keepassCode(get)
          if (code) e.codes.push(code)
          const rp = get('KPEX_PASSKEY_RELYING_PARTY')
          if (rp !== undefined) {
            const handle = get('KPEX_PASSKEY_USER_HANDLE')
            const pem = get('KPEX_PASSKEY_PRIVATE_KEY_PEM')
            // StrongBox's credential ID, which KeePassXC takes over its own when both are there
            const id = get('KPEX_PASSKEY_GENERATED_USER_ID') ?? get('KPEX_PASSKEY_CREDENTIAL_ID')
            e.passkeys.push({
              rpId: rp,
              credentialId: id ? fromBase64Any(id) : null,
              userHandle: handle ? fromBase64Any(handle) : null,
              userName: get('KPXC_PASSKEY_USERNAME') ?? get('KPEX_PASSKEY_USERNAME') ?? '',
              displayName: '',
              key: pem ? { pem } : null
            })
          }
          if (inBin) e.trashed = true
          entries.push(e)
        }
        for (const g of children(group, 'Group')) walk(g, inBin, here)
      }
      for (const g of children(root, 'Group')) walk(g, false, '')
      if (encrypted)
        throw new Refused(
          'This XML has its passwords encrypted, as inside a KeePass database: it isn’t an export. In KeePass: File › Export › KeePass XML (2.x); in KeePassXC, keepassxc-cli export -f xml.'
        )
    }
    return entries
  }
}
