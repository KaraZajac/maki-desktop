/**
 * What every importer makes of an export, whatever the manager: entries as the export has them,
 * before anything is checked. `prepare.ts` turns them into the records maki takes (`../import.ts`),
 * and says what's left out and why.
 */

/** A file the owner chose: read a range at a time, so a big zip needn't be read whole. */
export interface ExportFile {
  /** its name, as the owner knows it (no folder) */
  name: string
  /** its size in bytes */
  size: number
  /** `length` bytes from `offset` (fewer only at the end of the file) */
  read(offset: number, length: number): Promise<Uint8Array>
}

/** A file already in memory, as an `ExportFile`. */
export function memoryFile(name: string, bytes: Uint8Array): ExportFile {
  return {
    name,
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length))
  }
}

/** The whole of a file. */
export async function readAll(file: ExportFile): Promise<Uint8Array> {
  return file.read(0, file.size)
}

/**
 * What an entry in a manager is. maki keeps logins, with their codes and passkeys; the rest of what
 * managers keep (cards, notes, identities...) it doesn't.
 */
export type EntryKind =
  | 'login'
  | 'card'
  | 'note'
  | 'identity'
  | 'ssh key'
  | 'wifi'
  | 'alias'
  | 'document'
  | 'bank account'
  | 'other'

/**
 * A code as an export has it: an otpauth:// URI, a bare base32 secret or a `steam://` one, as a
 * string; or already taken apart (KeePass's older fields, the Credential Exchange Format's).
 */
export type FoundCode =
  | string
  | {
      /** the secret, in base32 or as bytes */
      secret: string | Uint8Array
      /** "SHA1", "SHA256", "SHA512" (or another, which maki won't take) */
      algorithm?: string
      digits?: number
      period?: number
      issuer?: string
      account?: string
      /** a code of another kind than RFC 6238's: counter-based (HOTP), or Steam Guard's */
      kind?: 'totp' | 'hotp' | 'steam'
    }

/** A passkey's private key, as an export holds it. */
export type FoundKey =
  /** PKCS#8 DER, as WebCrypto exports it (Bitwarden's, the Credential Exchange Format's) */
  | { pkcs8: Uint8Array }
  /** PEM: PKCS#8 ("PRIVATE KEY") or SEC 1 ("EC PRIVATE KEY") (KeePassXC's) */
  | { pem: string }
  /** a JSON Web Key */
  | { jwk: Record<string, unknown> }
  /** a COSE_Key, CBOR, as authenticators keep them */
  | { cose: Uint8Array }
  /** a COSE_Key's parameters, by label, read from another serialization (Proton Pass's) */
  | { coseKey: Map<number, number | Uint8Array> }

/** A passkey (a WebAuthn credential) as an export has it. */
export interface FoundPasskey {
  /** the relying party's ID: the site it's for */
  rpId: string
  /** the credential ID's bytes, or null if the export doesn't have them readably */
  credentialId: Uint8Array | null
  /** the user handle (the site's ID for the account), or null */
  userHandle: Uint8Array | null
  userName: string
  displayName: string
  /** its private key, or null if the export doesn't carry it */
  key: FoundKey | null
  /** why this export can't give the passkey, when it's the export's doing (1Password's carries no keys) */
  unavailable?: string
  /** how many times it has signed, as the manager counted (0 for those that don't count) */
  counter?: number
}

/** An entry in the manager the export is from. */
export interface Entry {
  /** where it is in the file, for the owner to find it: "line 12", "item 4" */
  where: string
  /** its name in the manager ("GitHub (work)"); may be empty */
  title: string
  kind: EntryKind
  /** for 'other': what the manager calls it ("a software licence") */
  kindName?: string
  /** the web addresses (and app links) it's for, in the export's order */
  urls: string[]
  username: string
  password: string
  /** its codes (TOTP) */
  codes: FoundCode[]
  passkeys: FoundPasskey[]
  /** in the manager's trash: left out */
  trashed?: boolean
  /** why it's left out, when that's the export's doing (an archived item, a row written broken) */
  leftOut?: string
}

/** A new entry with nothing in it but where it is and what it is. */
export function entry(where: string, kind: EntryKind = 'login', title = ''): Entry {
  return { where, title, kind, urls: [], username: '', password: '', codes: [], passkeys: [] }
}

/** An export, read. */
export interface Parsed {
  /** the format it was read as */
  format: FormatId
  /** the manager it's from, as maki shows it ("Bitwarden"): 1 to 32 bytes */
  source: string
  entries: Entry[]
  /** what's worth saying about the file as a whole ("read as Windows-1252, as it isn’t UTF-8") */
  notes: string[]
}

/** The formats maki desktop reads. */
export type FormatId =
  | 'bitwarden-json'
  | 'bitwarden-csv'
  | 'proton-json'
  | 'proton-csv'
  | 'lastpass-csv'
  | '1password-1pux'
  | '1password-csv'
  | 'keepassxc-csv'
  | 'keepass-xml'
  | 'dashlane-csv'
  | 'chromium-csv'
  | 'firefox-csv'
  | 'apple-csv'
  | 'nordpass-csv'
  | 'enpass-json'
  | 'keeper-csv'
  | 'keeper-json'
  | 'cxf'
  | 'generic-csv'

/** A format, for the owner. */
export interface FormatInfo {
  id: FormatId
  /** the manager, as maki's screen names it ("Bitwarden"): at most 32 bytes */
  manager: string
  /** what it is ("Bitwarden’s JSON export") */
  label: string
}
