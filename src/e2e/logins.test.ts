/**
 * Logins & passkeys, end to end: the real app, offscreen, linked to the fake maki. An export from
 * Bitwarden (its JSON, a login with a code and a passkey among a card and a secure note) is
 * chosen, read and shown before anything's sent, with what's left out and why; it's sent, the fake
 * maki asks and adds it, and says so over the link; then the export goes to the trash (the test's
 * own: its HOME's).
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/logins.test.ts
 *
 * It needs a fake maki that knows VAULT_STATUS and IMPORT_PUT; one from before says so and skips.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient, type VaultStatus } from '../shared/client'
import { bitwardenSample } from '../shared/importers/samples/bitwarden'
import { FAKE_BUILT, startFake, TcpTransport } from '../shared/test-support'
import { build, drive, E2E } from './drive'

describe.skipIf(!E2E || !FAKE_BUILT)('Logins & passkeys, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake()
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** What the fake maki's vault holds, as it answers the link; null if it doesn't know the question. */
  const holds = async (): Promise<VaultStatus | null> => {
    const t = await TcpTransport.open(fake.port)
    try {
      return await new MakiClient(t).vaultStatus()
    } finally {
      await t.close()
    }
  }

  it('reads a Bitwarden export, shows it, sends it, and offers it to the trash', async (ctx) => {
    if ((await holds()) === null) {
      console.warn('the fake maki doesn’t know VAULT_STATUS yet: skipped')
      ctx.skip()
    }
    const before = (await holds())!
    const exportFile = join(home, 'bitwarden_export.json')
    writeFileSync(exportFile, bitwardenSample().json)
    mkdirSync(join(home, '.local/share'), { recursive: true })

    const env = {
      MAKI_OFFSCREEN_OPEN: exportFile,
      // the trash is the test HOME's: gio's, with GLib's own files, never the desktop's
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_CURRENT_DESKTOP: 'GNOME',
      GIO_USE_VFS: 'local'
    }
    const choose = [
      ...['--click', 'Logins & passkeys', '--until', 'Choose an export'],
      ...['--click', 'Choose an export', '--until', 'Read as Bitwarden’s JSON export.']
    ]

    // before anything's sent: what maki will get, never a password or a secret; what's left out
    const preview = await drive(
      home,
      fake.port,
      [
        ...choose,
        ...['--until', 'For maki, from Bitwarden: 3 logins, 2 codes and 1 passkey.'],
        ...['--until', 'Left out, with why'],
        ...['--until', 'maki keeps logins, codes and passkeys'],
        ...['--until', 'A Steam Guard code, which isn’t RFC 6238’s']
      ],
      env
    )
    for (const site of [
      'github.com',
      'store.steampowered.com',
      'mastodon.social',
      'gist.github.com'
    ])
      expect(preview).toContain(site)
    for (const secret of [
      'correct horse battery staple',
      'w1nter-is-c0ming',
      'tooting-along-42',
      'JBSWY3DPEHPK3PXP'
    ])
      expect(preview).not.toContain(secret)
    // and nothing went
    expect((await holds())!.logins).toBe(before.logins)

    // sent: maki asks, and adds it; then the export to the trash
    await drive(
      home,
      fake.port,
      [
        ...choose,
        ...['--click', 'Send to maki', '--until', 'maki added 3 logins, 2 codes and 1 passkey.'],
        // imported passkeys aren't made from the phrase: a backup, then
        ...['--until', 'Make a backup now, and keep a copy of it off this computer.'],
        ...['--click', 'Move to the trash', '--until', 'Moved to the trash.']
      ],
      env
    )
    const after = (await holds())!
    expect(after.logins - before.logins).toBe(3)
    expect(after.codes - before.codes).toBe(2)
    expect(after.passkeys - before.passkeys).toBe(1)
    expect(after.imported - before.imported).toBe(1)
    expect(existsSync(exportFile)).toBe(false)
    expect(existsSync(join(home, '.local/share/Trash/files/bitwarden_export.json'))).toBe(true)

    // the page says what maki holds now
    const page = await drive(home, fake.port, [
      ...['--click', 'Logins & passkeys', '--until', 'PASSKEYS']
    ])
    expect(page).toMatch(/LOGINS\s+3\s/)
    expect(page).toMatch(/PASSKEYS\s+1\s+imported/)
  }, 360_000)
})
