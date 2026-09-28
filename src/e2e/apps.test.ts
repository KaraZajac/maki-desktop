/**
 * The Apps page, end to end: the real app, offscreen, linked to the fake maki, the maki store as
 * its repository publishes it. It installs an app from the store and removes it, pressing what a
 * person would; the fake maki, running maki's own install and store checks, says what it has.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import {
  FAKE_BUILT,
  MAKI_STORE,
  MAKI_STORE_THERE,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive, E2E } from './drive'

const PASSPHRASE = 'com.leviathan.maki.passphrase'

describe.skipIf(!E2E || !FAKE_BUILT || !MAKI_STORE_THERE)('the Apps page, end to end', () => {
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

  /** What the fake maki has installed. */
  const installed = async (): Promise<string[]> => {
    const t = await TcpTransport.open(fake.port)
    try {
      return (await new MakiClient(t).appList()).apps.map((a) => a.id)
    } finally {
      await t.close()
    }
  }

  it('installs an app from the maki store, and removes it', async () => {
    const env = { MAKI_STORE }
    // the store's grid, one of its apps, and maki's yes
    const said = await drive(
      home,
      fake.port,
      [
        ...[
          '--click',
          'Apps',
          '--until',
          'Passphrase',
          '--click',
          'Passphrase',
          '--until',
          'Install on maki'
        ],
        ...['--click', 'Install on maki', '--until', PASSPHRASE]
      ],
      env
    )
    // on maki's list, from the store, taking room in the chart
    expect(said).toContain(PASSPHRASE)
    expect(said).toMatch(/MAKI STORE/)
    expect(said).toMatch(/1 app\b/)
    expect(await installed()).toEqual([PASSPHRASE])

    await drive(
      home,
      fake.port,
      ['--click', 'Apps', '--until', PASSPHRASE, '--click', 'Remove', '--gone', PASSPHRASE],
      env
    )
    expect(await installed()).toEqual([])
  }, 360_000)
})
