/**
 * An export's entries made the records maki takes, with what the owner sees before anything is
 * sent: a row for each entry that brings something (its site, username, and whether it brings a
 * password, a code, a passkey: never the password itself), and what's left out, entry by entry,
 * with why.
 */
import { recordProblem, type ImportRecord } from '../import'
import { privateScalar } from './keys'
import type { Entry, EntryKind, Parsed } from './model'
import { readCode } from './otp'
import { rpIdOf, siteOf } from './site'
import { label } from './text'

/** An entry that brings something to maki, as the preview shows it. */
export interface PreviewRow {
  where: string
  title: string
  /** the login's site, or the passkey's when there's no login */
  site: string
  username: string
  /** whether it brings a password (a login) */
  password: boolean
  codes: number
  passkeys: number
  /** the other addresses the entry had, which the login won't cover (maki keeps one site a login) */
  others: string[]
  /** its records, by their place in `Prepared.records`: for leaving the row out */
  records: number[]
}

/** Something in the export that won't go to maki. */
export interface LeftOut {
  where: string
  title: string
  /** what it is: "a card", "its code", "its passkey for github.com" */
  what: string
  why: string
}

/** An export made ready for maki. */
export interface Prepared {
  source: string
  records: ImportRecord[]
  rows: PreviewRow[]
  left: LeftOut[]
  logins: number
  codes: number
  passkeys: number
  /** what's worth saying about the file as a whole */
  notes: string[]
}

/** What each kind of entry is called, for "left out" lines. */
const KINDS: Record<Exclude<EntryKind, 'login' | 'other'>, string> = {
  card: 'a card',
  note: 'a secure note',
  identity: 'an identity',
  'ssh key': 'an SSH key',
  wifi: 'a Wi-Fi network',
  alias: 'an email alias',
  document: 'a document',
  'bank account': 'a bank account'
}

/** Why the kinds of entry maki doesn't keep are left out. */
const NOT_KEPT = 'maki keeps logins, codes and passkeys'

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** What an entry is, for a "left out" line. */
function what(e: Entry): string {
  if (e.kind === 'login') return 'a login'
  if (e.kind === 'other') return e.kindName ?? 'an entry of another kind'
  return KINDS[e.kind]
}

/**
 * The records maki takes from `parsed`, and what the owner sees first. Each record is checked as
 * maki will check it; one that wouldn't pass is left out here, with why, rather than sent. A login
 * for a site and username seen earlier in the file, a code with a secret seen earlier, a passkey
 * with a credential ID seen earlier: the first is kept, as maki would keep it.
 */
export function prepare(parsed: Parsed): Prepared {
  const records: ImportRecord[] = []
  const rows: PreviewRow[] = []
  const left: LeftOut[] = []
  const logins = new Map<string, { where: string; password: string }>()
  const codes = new Map<string, string>()
  const passkeys = new Map<string, string>()
  // passkeys whose manager counted their signatures
  let counted = 0

  for (const e of parsed.entries) {
    const title = label(e.title)
    const out = (thing: string, why: string): void => {
      left.push({ where: e.where, title, what: thing, why })
    }
    if (e.leftOut) {
      out(what(e), e.leftOut)
      continue
    }
    if (e.trashed) {
      out(what(e), 'it’s in the trash')
      continue
    }
    if (e.kind !== 'login') {
      out(what(e), NOT_KEPT)
      continue
    }
    const row: PreviewRow = {
      where: e.where,
      title,
      site: '',
      username: '',
      password: false,
      codes: 0,
      passkeys: 0,
      others: [],
      records: []
    }
    const site = siteOf(e.urls)

    // the login: a site, a username, a password
    if (e.password !== '') {
      if ('why' in site) out('a login', site.why)
      else {
        const record: ImportRecord = {
          kind: 'login',
          site: site.site,
          username: e.username,
          password: e.password,
          title
        }
        const why = recordProblem(record)
        const key = `${site.site}\n${e.username}`
        const seen = logins.get(key)
        if (why) out('a login', why)
        else if (seen)
          out(
            'a login',
            seen.password === e.password
              ? `the same login as ${seen.where}`
              : `another password for the site and username of ${seen.where}, whose password maki keeps`
          )
        else {
          logins.set(key, { where: e.where, password: e.password })
          row.records.push(records.push(record) - 1)
          row.site = site.site
          row.username = e.username
          row.password = true
          row.others = site.others
        }
      }
    }

    // its codes, which maki keeps by themselves (a site asks for one, and the owner picks it once)
    for (const found of e.codes) {
      const got = readCode(found, {
        issuer: title || ('site' in site ? site.site : ''),
        account: e.username
      })
      if ('why' in got) {
        out('its code', got.why)
        continue
      }
      const c = got.code
      const record: ImportRecord = {
        kind: 'code',
        issuer: c.issuer || e.where,
        account: c.account,
        secret: c.secret,
        algorithm: c.algorithm,
        digits: c.digits,
        period: c.period
      }
      const why = recordProblem(record)
      const key = hex(c.secret)
      if (why) out('its code', why)
      else if (codes.has(key)) out('its code', `the same code as ${codes.get(key)}`)
      else {
        codes.set(key, e.where)
        row.records.push(records.push(record) - 1)
        row.codes++
      }
    }

    // its passkeys
    for (const p of e.passkeys) {
      const rpId = rpIdOf(p.rpId)
      const thing = `its passkey${rpId ? ` for ${rpId}` : ''}`
      if (p.unavailable) {
        out(thing, p.unavailable)
        continue
      }
      if (rpId === null) {
        out(
          thing,
          p.rpId.trim() ? `its site, “${p.rpId.trim()}”, isn’t a host` : 'it names no site'
        )
        continue
      }
      if (p.credentialId === null) {
        out(thing, 'its credential ID isn’t in the file')
        continue
      }
      if (p.userHandle === null || p.userHandle.length === 0) {
        out(
          thing,
          'it has no user handle, which a passkey has (a security key’s credential, perhaps)'
        )
        continue
      }
      if (p.key === null) {
        out(thing, 'its private key isn’t in the file')
        continue
      }
      const key = privateScalar(p.key)
      if ('why' in key) {
        out(thing, key.why)
        continue
      }
      const record: ImportRecord = {
        kind: 'passkey',
        rpId,
        credentialId: p.credentialId,
        userHandle: p.userHandle,
        userName: label(p.userName),
        displayName: label(p.displayName),
        privateKey: key.scalar
      }
      const why = recordProblem(record)
      const id = hex(p.credentialId)
      const account = `${rpId}\n${hex(p.userHandle)}`
      if (why) out(thing, why)
      else if (passkeys.has(id)) out(thing, `the same passkey as ${passkeys.get(id)}`)
      else if (passkeys.has(account))
        out(
          thing,
          `another passkey for the account of ${passkeys.get(account)}’s, and maki keeps one passkey an account: that one`
        )
      else {
        passkeys.set(id, e.where)
        passkeys.set(account, e.where)
        row.records.push(records.push(record) - 1)
        row.passkeys++
        if ((p.counter ?? 0) > 0) counted++
        if (row.site === '') {
          row.site = rpId
          row.username = record.userName
        }
      }
    }

    if (row.password || row.codes > 0 || row.passkeys > 0) {
      if (row.site === '' && 'site' in site) row.site = site.site
      if (row.username === '') row.username = e.username
      rows.push(row)
    } else if (e.password === '' && e.codes.length === 0 && e.passkeys.length === 0) {
      out(
        'a login',
        e.username !== '' || e.urls.length > 0 ? 'it has no password' : 'there’s nothing in it'
      )
    }
  }

  const notes = [...parsed.notes]
  if (counted > 0)
    notes.push(
      `${parsed.source} counted the signatures of ${counted === 1 ? 'one of these passkeys' : `${counted} of these passkeys`}, and an import doesn’t carry that count: a site that checks it could turn ${counted === 1 ? 'it' : 'them'} down. If one does, sign in another way and make a new passkey there.`
    )
  return {
    source: parsed.source,
    records,
    rows,
    left,
    logins: records.filter((r) => r.kind === 'login').length,
    codes: records.filter((r) => r.kind === 'code').length,
    passkeys: records.filter((r) => r.kind === 'passkey').length,
    notes
  }
}

/** Wipes what can be wiped of a prepared import: its codes' secrets and its passkeys' keys. */
export function wipe(prepared: Prepared): void {
  for (const r of prepared.records) {
    if (r.kind === 'code') r.secret.fill(0)
    if (r.kind === 'passkey') r.privateKey.fill(0)
  }
  prepared.records.length = 0
}

/**
 * Wipes what can be wiped of what an export was read into: its passkeys' keys and its codes'
 * secrets, where they're bytes (strings can't be: they go when nothing holds them).
 */
export function wipeParsed(parsed: Parsed): void {
  for (const e of parsed.entries) {
    for (const c of e.codes)
      if (typeof c !== 'string' && c.secret instanceof Uint8Array) c.secret.fill(0)
    for (const p of e.passkeys) {
      const k = p.key
      if (!k) continue
      if ('pkcs8' in k) k.pkcs8.fill(0)
      else if ('cose' in k) k.cose.fill(0)
      else if ('coseKey' in k)
        for (const v of k.coseKey.values()) if (v instanceof Uint8Array) v.fill(0)
    }
  }
}
