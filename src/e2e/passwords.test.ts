/**
 * The Password Maker card, end to end: the real app, offscreen, linked to the fake maki running
 * maki's Password Maker (sdk/examples/passwords). It adds an entry and removes it, pressing what a
 * person would; the app itself, asked over the link, says what it keeps.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/passwords.test.ts
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { listMessage, PASSWORDS_APP, readList, type PasswordEntry } from '../shared/passwords'
import { APP_FIXTURES, FAKE_BUILT, startFake, TcpTransport } from '../shared/test-support'
import { build, drive as driveApp, E2E } from './drive'

describe.skipIf(!E2E || !FAKE_BUILT)('the Password Maker card, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'passwords.maki')])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** What maki's Password Maker keeps, as it answers the link. */
  const kept = async (): Promise<PasswordEntry[]> => {
    const t = await TcpTransport.open(fake.port)
    try {
      const r = await new MakiClient(t).appMessage(PASSWORDS_APP, listMessage(0))
      return readList(r.answer)!.entries
    } finally {
      await t.close()
    }
  }

  it('adds a site’s password on maki, then removes it', async () => {
    const said = await driveApp(home, fake.port, [
      ...['--click', 'Connections', '--until', 'None on maki yet'],
      ...['--fill', 'github.com=github.com', '--fill', 'you@example.com=kara'],
      ...['--click', 'Add to maki', '--until', 'github.com added on maki.']
    ])
    expect(said).toMatch(/kara · number 0 · 21 base64 · Enter/)
    expect(await kept()).toEqual([
      {
        id: 1,
        alphabet: 'base64',
        length: 21,
        number: 0,
        enter: true,
        site: 'github.com',
        user: 'kara'
      }
    ])

    // the next suggests the next number; then the first goes
    const after = await driveApp(home, fake.port, [
      ...['--click', 'Connections', '--until', 'github.com'],
      ...['--click', 'Remove github.com', '--until', 'github.com removed from maki.']
    ])
    expect(after).toMatch(/None on maki yet/)
    expect(await kept()).toEqual([])
  }, 360_000)
})
