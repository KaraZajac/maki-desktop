import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient, MakiError } from './client'
import {
  encodeImport,
  IMPORT_PIECE,
  importSays,
  importSource,
  MAX_IMPORT,
  recordProblem,
  sourceProblem,
  splitImport,
  type ImportRecord
} from './import'
import { memoryFile, openExport } from './importers'
import { prepare } from './importers/prepare'
import { bitwardenSample } from './importers/samples/bitwarden'
import { Link } from './link'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'
import { readImport, VaultStandIn } from './vault-stand-in'

const login = (
  site: string,
  username = 'kara',
  password = 'hunter2',
  title = ''
): ImportRecord => ({
  kind: 'login',
  site,
  username,
  password,
  title
})
const code = (fill = 7, issuer = 'GitHub', account = 'kara'): ImportRecord => ({
  kind: 'code',
  issuer,
  account,
  secret: new Uint8Array(20).fill(fill),
  algorithm: 1,
  digits: 6,
  period: 30
})
const passkey = (fill = 9, rpId = 'github.com'): ImportRecord => ({
  kind: 'passkey',
  rpId,
  credentialId: new Uint8Array(16).fill(fill),
  userHandle: Uint8Array.of(1, 2, 3),
  userName: 'kara',
  displayName: 'Kara Zajac',
  privateKey: new Uint8Array(32).fill(5)
})

describe('an import’s bytes', () => {
  it('are what the specification says, read back by a reader written from it', () => {
    const bytes = encodeImport('Bitwarden', [
      login('github.com', 'kara', 'pässwörd', 'GitHub (work)'),
      code(),
      passkey()
    ])
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('MAKIIMP1')
    expect(bytes[8]).toBe(9) // the source's length
    expect(Array.from(bytes.subarray(18, 22))).toEqual([3, 0, 0, 0]) // three records
    expect(bytes[22]).toBe(1) // a login first
    const read = readImport(bytes)
    expect(read).toEqual({
      source: 'Bitwarden',
      logins: [
        { site: 'github.com', username: 'kara', password: 'pässwörd', title: 'GitHub (work)' }
      ],
      codes: [
        {
          issuer: 'GitHub',
          account: 'kara',
          secret: new Uint8Array(20).fill(7),
          algorithm: 1,
          digits: 6,
          period: 30
        }
      ],
      passkeys: [
        {
          rpId: 'github.com',
          credentialId: new Uint8Array(16).fill(9),
          userHandle: Uint8Array.of(1, 2, 3),
          userName: 'kara',
          displayName: 'Kara Zajac',
          privateKey: new Uint8Array(32).fill(5)
        }
      ]
    })
    expect(importSource(bytes)).toBe('Bitwarden')
  })

  it('a code’s fields, byte by byte', () => {
    const bytes = encodeImport('x', [
      {
        kind: 'code',
        issuer: 'A',
        account: '',
        secret: new Uint8Array(10).fill(0xab),
        algorithm: 3,
        digits: 8,
        period: 60
      }
    ])
    // magic, source "x", count 1, then: kind 2, "A", "", secret (10), SHA-512, 8 digits, 60 s
    expect(Array.from(bytes.subarray(14))).toEqual([
      2,
      1,
      0x41,
      0,
      10,
      0,
      ...new Array(10).fill(0xab),
      3,
      8,
      60,
      0
    ])
  })

  it('aren’t made of a record maki won’t take, which is named', () => {
    expect(() => encodeImport('Bitwarden', [login('github.com'), login('GitHub.com')])).toThrow(
      'record 2: a login whose site isn’t a host'
    )
    expect(() => encodeImport('Bitwarden', [])).toThrow('at least one record')
    expect(() => encodeImport('', [login('a.com')])).toThrow('says what it’s from')
  })

  it('checks each record as maki does', () => {
    expect(recordProblem(login('github.com'))).toBeNull()
    expect(recordProblem(login('192.168.1.1'))).toBeNull()
    expect(recordProblem(login('xn--bcher-kva.de'))).toBeNull()
    expect(recordProblem(login('github.com', 'kara', ''))).toBe('a login with no password')
    expect(recordProblem(login('github.com', 'kara', 'a\tb'))).toBe(
      'a password with a control character'
    )
    expect(recordProblem(login('github.com', 'ka\nra'))).toBe('a username with a control character')
    expect(recordProblem(login('github.com', 'kara', 'x', 'a\u0085b'))).toBe(
      'a title with a control character'
    )
    expect(recordProblem(login('github.com', 'kara', 'é'.repeat(128)))).toBe(
      'a password longer than 255 bytes'
    )
    expect(recordProblem(login('.github.com'))).toBe('a login whose site isn’t a host')
    expect(recordProblem(login('github..com'))).toBe('a login whose site isn’t a host')
    expect(recordProblem(login('a'.repeat(254)))).toBe('a login whose site isn’t a host')
    expect(recordProblem(code(1, '', ''))).toBe('a code with neither an issuer nor an account')
    expect(
      recordProblem({
        ...(code() as Extract<ImportRecord, { kind: 'code' }>),
        secret: new Uint8Array(9)
      })
    ).toBe('a code whose secret isn’t 10 to 64 bytes')
    expect(
      recordProblem({ ...(code() as Extract<ImportRecord, { kind: 'code' }>), digits: 5 })
    ).toBe('a code of other than 6 to 8 digits')
    expect(
      recordProblem({ ...(code() as Extract<ImportRecord, { kind: 'code' }>), period: 10 })
    ).toBe('a code whose period isn’t 15 to 300 seconds')
    const pk = passkey() as Extract<ImportRecord, { kind: 'passkey' }>
    expect(recordProblem({ ...pk, credentialId: new Uint8Array(15) })).toBe(
      'a passkey whose credential ID isn’t 16 to 255 bytes'
    )
    expect(recordProblem({ ...pk, userHandle: new Uint8Array(65) })).toBe(
      'a passkey whose user handle isn’t 1 to 64 bytes'
    )
    expect(recordProblem({ ...pk, privateKey: new Uint8Array(31) })).toBe(
      'a passkey whose key isn’t 32 bytes'
    )
    expect(sourceProblem('x'.repeat(33))).toMatch(/more than 32 bytes/)
  })

  it('are split into imports maki takes at once when there are thousands', () => {
    // by count: 2000 records at most
    const many = Array.from({ length: 4500 }, (_, i) =>
      login(`site${i}.example.com`, `user${i}`, 'p'.repeat(20))
    )
    const parts = splitImport('LastPass', many)
    expect(parts.map((p) => p.length)).toEqual([2000, 2000, 500])
    expect(parts.flat()).toEqual(many)
    // by size: 512 KiB at most
    const big = Array.from({ length: 1900 }, (_, i) =>
      login(`site${i}.example.com`, 'u'.repeat(200), 'p'.repeat(200))
    )
    const bySize = splitImport('LastPass', big)
    expect(bySize.length).toBe(2)
    for (const part of bySize)
      expect(encodeImport('LastPass', part).length).toBeLessThanOrEqual(MAX_IMPORT)
    expect(splitImport('LastPass', many.slice(0, 10))).toEqual([many.slice(0, 10)])
    expect(() => encodeImport('LastPass', many.slice(0, 2001))).toThrow('at most 2000 records')
  })
})

describe('what maki said, for the owner', () => {
  const r = {
    approval: 'approved' as const,
    logins: 0,
    codes: 0,
    passkeys: 0,
    skipped: 0,
    reason: ''
  }
  it('says what was added, and what maki already had', () => {
    expect(importSays({ ...r, logins: 312, codes: 40, passkeys: 5 })).toBe(
      'maki added 312 logins, 40 codes and 5 passkeys.'
    )
    expect(importSays({ ...r, logins: 1, skipped: 3 })).toBe(
      'maki added 1 login, and left the 3 it already had as they were.'
    )
    expect(importSays({ ...r, skipped: 2 })).toBe('maki already had all 2: nothing changed.')
    // its database full part of the way: what it added, and why the rest wasn't (maki's words)
    const full = 'its database is full, and the rest wasn’t added'
    expect(importSays({ ...r, logins: 474, codes: 123, reason: full })).toBe(
      'maki added 474 logins and 123 codes, then stopped: its database is full, and the rest wasn’t added.'
    )
    expect(importSays({ ...r, reason: full })).toBe(
      'maki added nothing: its database is full, and the rest wasn’t added.'
    )
    expect(importSays({ ...r, approval: 'denied' })).toBe(
      'Nothing was imported: it was turned down on maki.'
    )
    expect(
      importSays({
        ...r,
        approval: 'refused',
        reason: 'record 12: a password with a control character'
      })
    ).toBe(
      'maki won’t take it: record 12: a password with a control character. Nothing was imported.'
    )
  })
})

describe('the link’s messages, against a stand-in for maki', () => {
  it('asks what the vault holds, and says nothing of it for older firmware', async () => {
    const maki = new VaultStandIn()
    const client = new MakiClient(maki)
    expect(await client.vaultStatus()).toEqual({
      status: 'approved',
      logins: 0,
      codes: 0,
      passkeys: 0,
      imported: 0
    })
    maki.status = 6
    expect((await client.vaultStatus())?.status).toBe('locked')
    maki.old = true
    expect(await client.vaultStatus()).toBeNull()
    await expect(client.importPut(encodeImport('x', [login('a.com')]))).rejects.toBeInstanceOf(
      MakiError
    )
  })

  it('sends an import in pieces, maki asks once, and adds what it hasn’t', async () => {
    const maki = new VaultStandIn()
    const client = new MakiClient(maki)
    const records = [
      ...Array.from({ length: 300 }, (_, i) =>
        login(`site${i}.example.com`, 'kara', `password number ${i}`)
      ),
      code(),
      passkey()
    ]
    const bytes = encodeImport('Bitwarden', records)
    expect(bytes.length).toBeGreaterThan(2 * IMPORT_PIECE)
    const progress: number[] = []
    const r = await client.importPut(bytes, (sent) => progress.push(sent))
    expect(r).toEqual({
      approval: 'approved',
      logins: 300,
      codes: 1,
      passkeys: 1,
      skipped: 0,
      reason: ''
    })
    expect(maki.asked.length).toBe(1)
    expect(progress[progress.length - 1]).toBe(bytes.length)
    expect(progress.length).toBe(Math.ceil(bytes.length / IMPORT_PIECE))
    expect(await client.vaultStatus()).toEqual({
      status: 'approved',
      logins: 300,
      codes: 1,
      passkeys: 1,
      imported: 1
    })

    // again: maki has it all, and keeps what it has
    const again = await client.importPut(
      encodeImport('Bitwarden', [login('site0.example.com', 'kara', 'other'), passkey()])
    )
    expect(again).toEqual({
      approval: 'approved',
      logins: 0,
      codes: 0,
      passkeys: 0,
      skipped: 2,
      reason: ''
    })
  })

  it('hears no, nobody, and maki’s refusal', async () => {
    const maki = new VaultStandIn()
    const client = new MakiClient(maki)
    maki.answer = 1
    expect((await client.importPut(encodeImport('x', [login('a.com')]))).approval).toBe('denied')
    maki.answer = 3
    expect((await client.importPut(encodeImport('x', [login('a.com')]))).approval).toBe('timed out')
    maki.answer = 0
    maki.status = 8
    expect((await client.importPut(encodeImport('x', [login('a.com')]))).approval).toBe('no phrase')
    maki.status = 0
    // bytes this side wouldn't make: maki's check has the last word
    const bad = encodeImport('x', [login('a.com', 'kara', 'ok')])
    bad[bad.length - 3] = 0x09 // the password’s "o" made a tab
    const r = await client.importPut(bad)
    expect(r.approval).toBe('refused')
    expect(r.reason).toBe('record 1: a password with a control character')
    expect(maki.logins.size).toBe(0)
  })

  it('logs what it’s from and what came of it, never what’s in it', async () => {
    const maki = new VaultStandIn()
    const saved: Uint8Array[] = []
    const link = new Link(async () => new Uint8Array(), undefined, {
      save: async (d) => void saved.push(d),
      latest: async () => null
    })
    link.autoSync = false
    expect(await link.attach(maki, 'fake maki')).toBe(true)
    expect(await link.vaultStatus()).toEqual({
      status: 'approved',
      logins: 0,
      codes: 0,
      passkeys: 0,
      imported: 0
    })
    const r = await link.importPut(
      encodeImport('Proton Pass', [login('github.com', 'kara', 'sw0rdfish'), passkey()])
    )
    expect(r.approval).toBe('approved')
    const log = link.log.join('\n')
    expect(log).toContain('an import from Proton Pass: say yes on maki')
    expect(log).toContain('import from Proton Pass: maki added 1 login and 1 passkey.')
    expect(log).not.toContain('sw0rdfish')
    expect(log).not.toContain('kara')
    link.drop()
  })
})

describe.skipIf(!FAKE_BUILT)('against the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  beforeAll(async () => {
    fake = await startFake()
  })
  afterAll(() => fake?.proc.kill())

  it('takes an export, read and prepared here, and counts what it added', async (ctx) => {
    const t = await TcpTransport.open(fake.port)
    try {
      const client = new MakiClient(t)
      const before = await client.vaultStatus()
      // a fake from before imports: nothing to test against
      if (before === null) return ctx.skip()
      expect(before.status).toBe('approved')
      const opened = await openExport([
        memoryFile('bitwarden.json', new TextEncoder().encode(bitwardenSample().json))
      ])
      if (opened.state !== 'read') throw new Error(opened.state)
      const prepared = prepare(opened.parsed)
      const r = await client.importPut(encodeImport(prepared.source, prepared.records))
      expect(r).toEqual({
        approval: 'approved',
        logins: 3,
        codes: 2,
        passkeys: 1,
        skipped: 0,
        reason: ''
      })
      expect(await client.vaultStatus()).toEqual({
        status: 'approved',
        logins: before.logins + 3,
        codes: before.codes + 2,
        passkeys: before.passkeys + 1,
        imported: before.imported + 1
      })
      // again: it has it all, and keeps what it has
      const again = await client.importPut(encodeImport(prepared.source, prepared.records))
      expect(again).toMatchObject({
        approval: 'approved',
        logins: 0,
        codes: 0,
        passkeys: 0,
        skipped: 6
      })
      // bytes this side wouldn't make: refused, naming the record
      const bad = encodeImport('x', [login('a.com', 'kara', 'ok')])
      bad[bad.length - 3] = 0x09
      const refused = await client.importPut(bad)
      expect(refused.approval).toBe('refused')
      expect(refused.reason).toMatch(/^record 1: a password with a control character/)
    } finally {
      await t.close()
    }
  })
})
