/**
 * Each manager's export, read from a sample written from its documented format (`samples/`), all
 * the way to the records maki gets: what each field becomes, and what's left out and why.
 */
import { describe, expect, it } from 'vitest'
import { encodeImport, type ImportRecord } from '../import'
import { readImport } from '../vault-stand-in'
import { memoryFile, openExport, type Opened } from './index'
import { prepare, type Prepared } from './prepare'
import { BITWARDEN_PASSKEY, bitwardenEncrypted, bitwardenSample } from './samples/bitwarden'
import { fromBase32 } from './otp'
import { LASTPASS_CSV } from './samples/lastpass'
import { KEEPASS_PASSKEY, KEEPASSXC_CSV, keepassXml } from './samples/keepass'
import { ONEPASSWORD_CSV, onePux } from './samples/onepassword'
import * as other from './samples/others'
import { PROTON_CSV, PROTON_PASSKEY, protonPgpZip, protonZip } from './samples/proton'
import { makeZip, testScalar } from './samples'

const enc = new TextEncoder()

/** Opens `files` (name, contents) as the window would. */
async function open(files: [string, string | Uint8Array][], options = {}): Promise<Opened> {
  return openExport(
    files.map(([name, data]) =>
      memoryFile(name, typeof data === 'string' ? enc.encode(data) : data)
    ),
    options
  )
}

/** Opens and prepares, expecting it read. */
async function read(
  files: [string, string | Uint8Array][],
  options = {}
): Promise<{ opened: Extract<Opened, { state: 'read' }>; prepared: Prepared }> {
  const opened = await open(files, options)
  if (opened.state !== 'read') throw new Error(`not read: ${JSON.stringify(opened)}`)
  return { opened, prepared: prepare(opened.parsed) }
}

/** The records of one kind. */
const of = <K extends ImportRecord['kind']>(
  p: Prepared,
  kind: K
): Extract<ImportRecord, { kind: K }>[] =>
  p.records.filter((r): r is Extract<ImportRecord, { kind: K }> => r.kind === kind)

/** What's left out, as "where: what: why" lines. */
const leftOut = (p: Prepared): string[] =>
  p.left.map((l) => `${l.where}${l.title ? ` ${l.title}` : ''}: ${l.what}: ${l.why}`)

describe('Bitwarden', () => {
  it('its JSON: logins, codes and passkeys, the rest left out with why', async () => {
    const { opened, prepared } = await read([
      ['bitwarden_export_20261002.json', bitwardenSample().json]
    ])
    expect(opened.format.id).toBe('bitwarden-json')
    expect(opened.sure).toBe(true)
    expect(prepared.source).toBe('Bitwarden')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'github.com',
        username: 'kara',
        password: 'correct horse battery staple',
        title: 'GitHub'
      },
      {
        kind: 'login',
        site: 'store.steampowered.com',
        username: 'kara_plays',
        password: 'w1nter-is-c0ming',
        title: 'Steam'
      },
      {
        kind: 'login',
        site: 'mastodon.social',
        username: 'kara@mastodon.social',
        password: 'tooting-along-42',
        title: 'Mastodon'
      }
    ])
    expect(of(prepared, 'code')).toEqual([
      {
        kind: 'code',
        issuer: 'GitHub',
        account: 'kara',
        secret: fromBase32('JBSWY3DPEHPK3PXP'),
        algorithm: 1,
        digits: 6,
        period: 30
      },
      {
        kind: 'code',
        issuer: 'Mastodon',
        account: 'kara@mastodon.social',
        secret: enc.encode('12345678901234567890'),
        algorithm: 1,
        digits: 6,
        period: 30
      }
    ])
    expect(of(prepared, 'passkey')).toEqual([
      {
        kind: 'passkey',
        rpId: 'github.com',
        credentialId: BITWARDEN_PASSKEY.credentialBytes,
        userHandle: BITWARDEN_PASSKEY.userHandle,
        userName: 'kara',
        displayName: 'Kara Zajac',
        privateKey: BITWARDEN_PASSKEY.scalar
      }
    ])
    expect(leftOut(prepared)).toEqual([
      'item 2 Steam: its code: a Steam Guard code, which isn’t RFC 6238’s',
      'item 4 Visa: a card: maki keeps logins, codes and passkeys',
      'item 5 Wi-Fi at home: a secure note: maki keeps logins, codes and passkeys',
      'item 6 Me: an identity: maki keeps logins, codes and passkeys'
    ])
    expect(
      prepared.rows.map((r) => [r.site, r.username, r.password, r.codes, r.passkeys, r.others])
    ).toEqual([
      ['github.com', 'kara', true, 1, 1, ['gist.github.com']],
      ['store.steampowered.com', 'kara_plays', true, 0, 0, []],
      [
        'mastodon.social',
        'kara@mastodon.social',
        true,
        1,
        0,
        ['androidapp://org.joinmastodon.android']
      ]
    ])
    // and maki reads what's sent as it was meant
    const back = readImport(encodeImport(prepared.source, prepared.records))
    expect(
      typeof back !== 'string' && [back.logins.length, back.codes.length, back.passkeys.length]
    ).toEqual([3, 2, 1])
  })

  it('its CSV: logins and codes, no passkeys (and it says so)', async () => {
    const { opened, prepared } = await read([['bitwarden_export.csv', bitwardenSample().csv]])
    expect(opened.format.id).toBe('bitwarden-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.title])).toEqual([
      ['github.com', 'kara', 'GitHub'],
      ['store.steampowered.com', 'kara_plays', 'Steam']
    ])
    expect(prepared.rows[0].others).toEqual(['gist.github.com'])
    expect(of(prepared, 'code').length).toBe(1)
    expect(leftOut(prepared)).toEqual([
      'line 3 Steam: its code: a Steam Guard code, which isn’t RFC 6238’s',
      'line 4 Wi-Fi at home: a secure note: maki keeps logins, codes and passkeys'
    ])
    expect(prepared.notes).toContain(
      'Bitwarden’s CSV export carries no passkeys: its .json export does.'
    )
  })

  it('refuses the account-restricted export, saying what to export instead', async () => {
    const opened = await open([
      [
        'bitwarden_encrypted_export.json',
        JSON.stringify({
          encrypted: true,
          encKeyValidation_DO_NOT_EDIT: '2.a|b|c',
          folders: [],
          items: []
        })
      ]
    ])
    expect(opened).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('account-restricted')
    })
  })
})

describe('Bitwarden, password protected', () => {
  const json = bitwardenSample().json
  it('opens with its password (PBKDF2), and asks again for a wrong one', async () => {
    const file = await bitwardenEncrypted(json, 'tr0ub4dor&3', { type: 0, iterations: 5000 })
    expect(await open([['bitwarden_encrypted_export.json', file]])).toMatchObject({
      state: 'password',
      wrong: false,
      format: { id: 'bitwarden-json' }
    })
    expect(await open([['x.json', file]], { password: 'wrong' })).toMatchObject({
      state: 'password',
      wrong: true
    })
    const { prepared } = await read([['x.json', file]], { password: 'tr0ub4dor&3' })
    expect([prepared.logins, prepared.codes, prepared.passkeys]).toEqual([3, 2, 1])
  })
  it('opens with its password (Argon2id)', async () => {
    const file = await bitwardenEncrypted(json, 'pw', {
      type: 1,
      iterations: 2,
      memory: 16,
      parallelism: 1
    })
    const progress: number[] = []
    const { prepared } = await read([['x.json', file]], {
      password: 'pw',
      progress: (n: number) => progress.push(n)
    })
    expect(of(prepared, 'passkey')[0].privateKey).toEqual(BITWARDEN_PASSKEY.scalar)
    expect(progress.length).toBeGreaterThan(0)
  })
  it('won’t derive a key past sane limits', async () => {
    const file = await bitwardenEncrypted(json, 'pw', { type: 0, iterations: 5000 })
    const greedy = JSON.stringify({ ...JSON.parse(file), kdfIterations: 50_000_000 })
    expect(await open([['x.json', greedy]], { password: 'pw' })).toMatchObject({ state: 'refused' })
  })
})

describe('Proton Pass', () => {
  it('its zip: logins (username, else email), codes, and passkeys out of its MessagePack', async () => {
    const { opened, prepared } = await read([
      ['Proton Pass_export_2026-10-02.zip', await protonZip()]
    ])
    expect(opened.format.id).toBe('proton-json')
    expect(prepared.source).toBe('Proton Pass')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'account.proton.me',
        username: 'kara@proton.me',
        password: 'lumo-lumo-lumo-9',
        title: 'Proton'
      },
      {
        kind: 'login',
        site: 'forum.example.org',
        username: 'kara_z',
        password: 'f0rum-pass',
        title: 'Forum'
      }
    ])
    expect(of(prepared, 'code')).toEqual([
      {
        kind: 'code',
        issuer: 'Proton',
        account: 'kara@proton.me',
        secret: enc.encode('12345678901234567890'),
        algorithm: 1,
        digits: 6,
        period: 30
      }
    ])
    expect(of(prepared, 'passkey')).toEqual([
      {
        kind: 'passkey',
        rpId: 'proton.me',
        credentialId: PROTON_PASSKEY.credentialId,
        userHandle: PROTON_PASSKEY.userHandle,
        userName: 'kara@proton.me',
        displayName: 'Kara',
        privateKey: PROTON_PASSKEY.scalar
      }
    ])
    // a "never" address isn't one the login is for
    expect(prepared.rows[1].others).toEqual([])
    expect(leftOut(prepared)).toEqual([
      'item 3 (Personal) newsletter alias: an email alias: maki keeps logins, codes and passkeys',
      'item 4 (Personal) Recovery codes: a secure note: maki keeps logins, codes and passkeys',
      'item 5 (Personal) Old bank: a login: it’s in the trash',
      'item 6 (Personal) Debit card: a card: maki keeps logins, codes and passkeys'
    ])
  })
  it('its CSV: no passkeys, and no trash, which it says', async () => {
    const { opened, prepared } = await read([['Proton Pass_export.csv', PROTON_CSV]])
    expect(opened.format.id).toBe('proton-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.title])).toEqual([
      ['account.proton.me', 'kara@proton.me', 'Proton'],
      ['forum.example.org', 'kara_z', 'Forum']
    ])
    expect(prepared.codes).toBe(1)
    expect(prepared.notes[0]).toMatch(/no passkeys/)
  })
  it('refuses its PGP-encrypted export, saying to export without', async () => {
    expect(await open([['Proton Pass_export.zip', await protonPgpZip()]])).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('export again without encryption')
    })
  })
})

describe('LastPass', () => {
  it('reads logins and codes, takes off its formula guard, and leaves broken rows out', async () => {
    const { opened, prepared } = await read([['lastpass_export.csv', LASTPASS_CSV]])
    expect(opened.format.id).toBe('lastpass-csv')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'github.com',
        username: 'kara',
        password: 'correct horse battery staple',
        title: 'GitHub'
      },
      {
        kind: 'login',
        site: 'example.com',
        username: 'kara@example.com',
        password: '-dash-first',
        title: 'Example'
      },
      {
        kind: 'login',
        site: 'shop.example.net',
        username: 'kz',
        password: 'salt&amp;pepper',
        title: 'Shop'
      }
    ])
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account])).toEqual([['GitHub', 'kara']])
    expect(leftOut(prepared)).toEqual([
      'line 4 Notes: a secure note: maki keeps logins, codes and passkeys',
      'line 6 Visa: a card: maki keeps logins, codes and passkeys',
      'line 16: a login: LastPass wrote a comma in it without quoting it, so its fields can’t be told apart: add it by hand'
    ])
    expect(prepared.notes[0]).toMatch(/&amp;/)
  })
})

describe('1Password', () => {
  it('its 1PUX: logins and password items, codes from their fields; no passkeys, which it says', async () => {
    const { opened, prepared } = await read([['1PasswordExport.1pux', await onePux()]])
    expect(opened.format.id).toBe('1password-1pux')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'gitlab.com',
        username: 'kara',
        password: 'tanuki-tanuki',
        title: 'GitLab'
      },
      {
        kind: 'login',
        site: '192.168.1.1',
        username: '',
        password: 'router-admin-pass',
        title: 'Router'
      }
    ])
    expect(prepared.rows[0].others).toEqual(['about.gitlab.com'])
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account])).toEqual([['GitLab', 'kara']])
    expect(leftOut(prepared)).toEqual([
      'item 3 (Personal) Old forum: a login: it’s archived in 1Password',
      'item 4 (Personal) Visa: a card: maki keeps logins, codes and passkeys',
      'item 5 (Personal) Safe: a secure note: maki keeps logins, codes and passkeys'
    ])
    expect(prepared.notes[0]).toMatch(/no passkeys/)
  })
  it('its CSV', async () => {
    const { opened, prepared } = await read([['1PasswordExport.csv', ONEPASSWORD_CSV]])
    expect(opened.format.id).toBe('1password-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['gitlab.com', 'kara', 'tanuki-tanuki', 'GitLab'],
      ['192.168.1.1', '', 'router-admin-pass', 'Router']
    ])
    // an otpauth URI with no label: the entry's names, then
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account])).toEqual([['GitLab', 'kara']])
    expect(leftOut(prepared)).toEqual(['line 4 Old forum: a login: it’s archived in 1Password'])
  })
})

describe('KeePassXC and KeePass', () => {
  it('KeePassXC’s CSV: its TOTP column, Steam’s left out, the recycle bin too', async () => {
    const { opened, prepared } = await read([['Passwords.csv', KEEPASSXC_CSV]])
    expect(opened.format.id).toBe('keepassxc-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['app.fastmail.com', 'kara@fastmail.com', 'mail-pass-1', 'Fastmail'],
      ['store.steampowered.com', 'kara_plays', 'steam-pass', 'Steam']
    ])
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account])).toEqual([
      ['Fastmail', 'kara@fastmail.com']
    ])
    expect(leftOut(prepared)).toEqual([
      'line 3 Steam: its code: a Steam Guard code, which isn’t RFC 6238’s',
      'line 4 Old: a login: it’s in the trash'
    ])
  })
  it('KeePass’s XML: every kind of code, KeePassXC’s passkeys, no history, no recycle bin', async () => {
    const { opened, prepared } = await read([['Passwords.xml', keepassXml()]])
    expect(opened.format.id).toBe('keepass-xml')
    expect(prepared.source).toBe('KeePassXC')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'codeberg.org',
        username: 'kara',
        password: 'forge & <fire>',
        title: 'Codeberg'
      },
      {
        kind: 'login',
        site: 'vpn.example.com',
        username: 'kzajac',
        password: 'tunnel-vision',
        title: 'VPN'
      },
      {
        kind: 'login',
        site: 'payroll.example.com',
        username: 'kzajac',
        password: 'pay-me',
        title: 'Payroll'
      }
    ])
    expect(prepared.rows[0].others).toEqual(['git.example.org'])
    expect(
      of(prepared, 'code').map((c) => [c.issuer, c.account, c.algorithm, c.digits, c.period])
    ).toEqual([
      ['Codeberg', 'kara', 1, 6, 30],
      ['VPN', 'kzajac', 1, 8, 30],
      ['Payroll', 'kzajac', 2, 6, 60]
    ])
    expect(of(prepared, 'passkey')).toEqual([
      {
        kind: 'passkey',
        rpId: 'webauthn.io',
        credentialId: KEEPASS_PASSKEY.credentialId,
        userHandle: KEEPASS_PASSKEY.userHandle,
        userName: 'kara',
        displayName: '',
        privateKey: KEEPASS_PASSKEY.scalar
      }
    ])
    expect(leftOut(prepared)).toEqual([
      'entry 3 (Root) Ed site (Passkey): its passkey for ed.example.com: an EdDSA (Ed25519) passkey, and maki’s passkeys are ES256 (P-256) alone',
      'entry 6 (Root/Recycle Bin) Deleted: a login: it’s in the trash'
    ])
  })
  it('refuses XML whose passwords are encrypted, as inside a database', async () => {
    const inner = keepassXml().replace(/ProtectInMemory="True"/g, 'Protected="True"')
    expect(await open([['x.xml', inner]])).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('isn’t an export')
    })
    expect(
      await open([['db.kdbx', Uint8Array.of(0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5)]])
    ).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('KeePass database')
    })
  })
})

describe('Dashlane', () => {
  it('its zip of CSVs: credentials, and the rest left out file by file', async () => {
    const { opened, prepared } = await read([['Dashlane Export.zip', await other.dashlaneZip()]])
    expect(opened.format.id).toBe('dashlane-csv')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'example.com',
        username: 'kara@example.com',
        password: 'ex-pass-1',
        title: 'Example'
      },
      {
        kind: 'login',
        site: 'mail.example',
        username: 'kz@mail.example',
        password: 'mail-pass-2',
        title: 'Mail'
      }
    ])
    expect(of(prepared, 'code')).toEqual([
      {
        kind: 'code',
        issuer: 'Example',
        account: 'kara@example.com',
        secret: fromBase32('JBSWY3DPEHPK3PXP'),
        algorithm: 1,
        digits: 6,
        period: 30
      }
    ])
    expect(leftOut(prepared)).toEqual([
      'securenotes.csv, line 2 Wi-Fi: a secure note: maki keeps logins, codes and passkeys',
      'payments.csv, line 2 Visa: a card: maki keeps logins, codes and passkeys',
      'personalInfo.csv, line 2 Ms: an identity: maki keeps logins, codes and passkeys'
    ])
  })
  it('its files chosen one by one, as its apps write them', async () => {
    const { prepared } = await read([
      [
        'credentials.csv',
        'username,username2,username3,title,password,note,url,category,otp\nkara,,,Example,pw,,https://example.com,,null\n'
      ],
      ['secureNotes.csv', 'title,note,category\nNote,text,\n']
    ])
    expect([prepared.logins, prepared.codes, prepared.left.length]).toEqual([1, 0, 1])
  })
  it('refuses its encrypted DASH file', async () => {
    expect(await open([['Vault-2026-10-02.dash', other.DASHLANE_DASH]])).toMatchObject({
      state: 'refused'
    })
  })
})

describe('the browsers', () => {
  it('Chrome’s CSV: an app’s login has no website', async () => {
    const { opened, prepared } = await read([['Chrome Passwords.csv', other.CHROME_CSV]])
    expect(opened.format.id).toBe('chromium-csv')
    expect(prepared.source).toBe('Chrome')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'github.com',
        username: 'kara',
        password: 'p,ss"word',
        title: 'github.com'
      },
      {
        kind: 'login',
        site: 'accounts.google.com',
        username: 'kara@gmail.com',
        password: 'g00gle!',
        title: 'accounts.google.com'
      }
    ])
    expect(prepared.left.map((l) => l.why)).toEqual([
      expect.stringMatching(/^no website, only android:\/\//)
    ])
  })
  it('Edge’s, named by its file; a browser’s, when the name doesn’t say', async () => {
    expect((await read([['Microsoft Edge Passwords.csv', other.EDGE_CSV]])).prepared.source).toBe(
      'Edge'
    )
    expect((await read([['passwords.csv', other.EDGE_CSV]])).prepared.source).toBe('a browser')
  })
  it('Firefox’s: its own sign-in left out', async () => {
    const { opened, prepared } = await read([['logins.csv', other.FIREFOX_CSV]])
    expect(opened.format.id).toBe('firefox-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password])).toEqual([
      ['addons.mozilla.org', 'kara', 'fox-pass'],
      ['nas.example.org', 'admin', 'hunter2']
    ])
    expect(prepared.left.map((l) => l.why)).toEqual([
      'it’s Firefox’s own sign-in to its account, not a website’s'
    ])
  })
  it('Apple Passwords’: codes from OTPAuth, labelled or not', async () => {
    const { opened, prepared } = await read([['Passwords.csv', other.APPLE_CSV]])
    expect(opened.format.id).toBe('apple-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['apple.com', 'kara@icloud.com', 'appl3-pass', 'apple.com (kara@icloud.com)'],
      ['example.com', 'alice@example.com', 's3cret', 'example.com (alice@example.com)'],
      ['news.example.org', 'bob', 'pa"ss', 'news.example.org (bob)']
    ])
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account, c.algorithm, c.digits])).toEqual([
      ['example.com', 'alice@example.com', 1, 6],
      ['news.example.org (bob)', 'bob', 2, 8]
    ])
  })
})

describe('NordPass, Enpass and Keeper', () => {
  it('NordPass’s CSV: its types, its folders not entries, its extra addresses', async () => {
    const { opened, prepared } = await read([['nordpass_2026-10-02.csv', other.NORDPASS_CSV]])
    expect(opened.format.id).toBe('nordpass-csv')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'example.org',
        username: 'kara',
        password: 'nord-pass-1',
        title: 'Example'
      }
    ])
    expect(prepared.rows[0].others).toEqual(['login.example.org'])
    expect(leftOut(prepared)).toEqual([
      'line 4 Visa: a card: maki keeps logins, codes and passkeys',
      'line 5 Notes: a secure note: maki keeps logins, codes and passkeys'
    ])
  })
  it('Enpass’s JSON: its fields by type, the deleted one passed over, the trashed item left out', async () => {
    const { opened, prepared } = await read([['enpass.json', other.enpassJson()]])
    expect(opened.format.id).toBe('enpass-json')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'example.com',
        username: 'kara@example.com',
        password: 'enpass-pass',
        title: 'Example'
      }
    ])
    expect(of(prepared, 'code')[0].secret).toEqual(fromBase32('JBSWY3DPEHPK3PXP'))
    expect(leftOut(prepared)).toEqual([
      'item 2 Visa: a card: maki keeps logins, codes and passkeys',
      'item 3 Home Wi-Fi: a Wi-Fi network: maki keeps logins, codes and passkeys',
      'item 4 Trashed: a login: it’s in the trash'
    ])
  })
  it('Keeper’s JSON: its passkey, its key a JWK', async () => {
    const { opened, prepared } = await read([['keeper.json', other.keeperJson()]])
    expect(opened.format.id).toBe('keeper-json')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['webauthn.io', 'kara', 'keeper-pass', 'webauthn.io'],
      ['192.168.0.1', 'admin', 'admin-pass', 'Old router']
    ])
    expect(of(prepared, 'passkey')).toEqual([
      {
        kind: 'passkey',
        rpId: 'webauthn.io',
        credentialId: other.KEEPER_PASSKEY.credentialId,
        userHandle: other.KEEPER_PASSKEY.userHandle,
        userName: 'kara',
        displayName: '',
        privateKey: other.KEEPER_PASSKEY.scalar
      }
    ])
    // Keeper counted its signatures: an import doesn't carry the count, which is said
    expect(prepared.notes.join(' ')).toMatch(/count/)
    expect(leftOut(prepared)).toEqual([
      'record 2 Visa: a card: maki keeps logins, codes and passkeys'
    ])
  })
  it('Keeper’s CSV, with no header: found by its code fields', async () => {
    const { opened, prepared } = await read([['keeper.csv', other.KEEPER_CSV]])
    expect(opened.format.id).toBe('keeper-csv')
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['github.com', 'kara', 'gh-keeper', 'GitHub'],
      ['bank.example.com', 'kz', 'bank-keeper', 'Bank']
    ])
    expect(prepared.codes).toBe(1)
  })
})

describe('the Credential Exchange Format', () => {
  it('reads basic-auth, totp and passkey credentials, named for its exporter', async () => {
    const { opened, prepared } = await read([['export.json', other.cxfJson()]])
    expect(opened.format.id).toBe('cxf')
    expect(prepared.source).toBe('Example Exporter')
    expect(of(prepared, 'login')).toEqual([
      {
        kind: 'login',
        site: 'example.com',
        username: 'kara',
        password: 'cxf-pass',
        title: 'Example'
      }
    ])
    expect(of(prepared, 'code').map((c) => [c.issuer, c.account, c.algorithm])).toEqual([
      ['Example', 'kara', 2]
    ])
    expect(of(prepared, 'passkey')[0]).toMatchObject({
      rpId: 'example.com',
      credentialId: other.CXF_PASSKEY.credentialId,
      userHandle: other.CXF_PASSKEY.userHandle,
      privateKey: other.CXF_PASSKEY.scalar
    })
    expect(leftOut(prepared)).toEqual([
      'item 2 Visa: a card: maki keeps logins, codes and passkeys',
      'item 3 Note: a secure note: maki keeps logins, codes and passkeys'
    ])
  })
  it('reads the 2024 draft’s bare account', async () => {
    const { prepared } = await read([['account.json', other.cxfDraftAccount()]])
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password])).toEqual([
      ['draft.example.com', 'kara', 'draft-pass']
    ])
  })
})

describe('any other CSV', () => {
  it('is read by its columns’ names, as a guess, saying which it used', async () => {
    const { opened, prepared } = await read([['mine.csv', other.GENERIC_CSV]])
    expect(opened.format.id).toBe('generic-csv')
    expect(opened.sure).toBe(false)
    expect(opened.csv?.used).toEqual({
      header: true,
      url: 1,
      username: 2,
      password: 3,
      title: 0,
      totp: 4
    })
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password, l.title])).toEqual([
      ['nas.example.org', 'admin', 'nas-pass', 'Home NAS'],
      ['forge.example.com', 'kara', 'forge-pass', 'Forge']
    ])
    // never a password's column shown, only what's safe to
    expect(opened.csv?.columns.map((c) => [c.name, c.looks])).toEqual([
      ['Service', null],
      ['Website', 'web addresses (nas.example.org…)'],
      ['Login', null],
      ['Password', null],
      ['2FA', null]
    ])
  })
  it('with no header, the owner says which manager, or which column is which', async () => {
    expect(await open([['mine.csv', other.HEADERLESS_CSV]])).toMatchObject({ state: 'choose' })
    const { prepared } = await read([['mine.csv', other.HEADERLESS_CSV]], {
      format: 'generic-csv',
      columns: { header: false, url: 0, username: 1, password: 2, title: -1, totp: -1 }
    })
    expect(of(prepared, 'login').map((l) => [l.site, l.username, l.password])).toEqual([
      ['a.example.com', 'ann', 'pass-a'],
      ['b.example.com', 'bob', 'pass-b']
    ])
  })
})

describe('what’s worth knowing before sending', () => {
  it('keeps the first of two logins for one site and username, saying which', async () => {
    const csv =
      'name,url,username,password\na,https://x.com,kara,one\nb,https://www.x.com/login,kara,two\nc,https://x.com,kara,one\n'
    const { prepared } = await read([['Chrome Passwords.csv', csv]])
    expect(prepared.logins).toBe(1)
    expect(leftOut(prepared)).toEqual([
      'line 3 b: a login: another password for the site and username of line 2, whose password maki keeps',
      'line 4 c: a login: the same login as line 2'
    ])
  })
  it('leaves files from two managers to be imported one at a time', async () => {
    expect(
      await open([
        ['Chrome Passwords.csv', other.CHROME_CSV],
        ['lastpass_export.csv', LASTPASS_CSV]
      ])
    ).toMatchObject({ state: 'refused', why: expect.stringContaining('different managers') })
  })
  it('a passkey’s key that’s been tampered with is left out, not sent', async () => {
    const bad = JSON.parse(other.keeperJson())
    bad.records[0].custom_fields['$passkey::1'].privateKey.d = 'AAAA'
    const { prepared } = await read([['keeper.json', JSON.stringify(bad)]])
    expect(prepared.passkeys).toBe(0)
    expect(prepared.left.map((l) => l.why)).toContain('a passkey whose key isn’t a valid P-256 key')
    expect(testScalar(1).length).toBe(32)
  })
})

describe('what isn’t an export', () => {
  it('leaves a zip’s attachments alone, even a CSV among them', async () => {
    const zip = await makeZip([
      { name: 'Proton Pass/data.json', data: '' },
      { name: 'Proton Pass/files/notes.csv', data: 'url,username,password\nhttps://x.com,a,b\n' }
    ])
    // data.json empty: nothing to read, and the attachment isn't taken for an export
    expect(await open([['export.zip', zip]])).toMatchObject({ state: 'refused' })
  })
  it('refuses what isn’t text, and a zip with a password', async () => {
    const png = Uint8Array.of(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...new Array(64).fill(0)
    )
    expect(await open([['photo.png', png]])).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('isn’t text')
    })
    const zip = await makeZip([{ name: 'data.json', data: '{}', stored: true }])
    zip[6] |= 1 // its local header says encrypted
    zip[zip.length - 22 - 46 - 'data.json'.length + 8] |= 1 // and its directory entry
    expect(await open([['locked.zip', zip]])).toMatchObject({
      state: 'refused',
      why: expect.stringContaining('with a password')
    })
  })
})

describe('one passkey an account', () => {
  it('keeps the first of two passkeys for one site and user, as maki does', async () => {
    const two = JSON.parse(other.keeperJson())
    const second = structuredClone(two.records[0])
    second.title = 'webauthn.io again'
    second.login = 'kara2'
    second.custom_fields['$passkey::1'].credentialId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    delete second.custom_fields['$oneTimeCode::1']
    two.records.push(second)
    const { prepared } = await read([['keeper.json', JSON.stringify(two)]])
    expect(prepared.passkeys).toBe(1)
    expect(prepared.left.map((l) => l.why)).toContain(
      'another passkey for the account of record 1’s, and maki keeps one passkey an account: that one'
    )
  })
  it('a passkey with no user handle isn’t one maki can keep', async () => {
    const one = JSON.parse(other.keeperJson())
    delete one.records[0].custom_fields['$passkey::1'].userId
    const { prepared } = await read([['keeper.json', JSON.stringify(one)]])
    expect(prepared.passkeys).toBe(0)
    expect(prepared.left.map((l) => l.why)).toContain(
      'it has no user handle, which a passkey has (a security key’s credential, perhaps)'
    )
  })
})

describe('columns by their names', () => {
  it('KeePass 2’s own CSV: its Account is the name, its Login Name the username', async () => {
    const { prepared } = await read([
      [
        'KeePass.csv',
        '"Account","Login Name","Password","Web Site","Comments"\n"Mail","kara","pw-1","https://mail.example.com",""\n'
      ]
    ])
    expect(of(prepared, 'login')).toEqual([
      { kind: 'login', site: 'mail.example.com', username: 'kara', password: 'pw-1', title: 'Mail' }
    ])
  })
  it('a column isn’t taken twice: Username isn’t the name too', async () => {
    const { opened } = await read([
      ['x.csv', 'Website,Username,Password\nhttps://a.example.com,ann,pw\n']
    ])
    expect(opened.csv?.used).toEqual({
      header: true,
      url: 0,
      username: 1,
      password: 2,
      title: -1,
      totp: -1
    })
  })
})
