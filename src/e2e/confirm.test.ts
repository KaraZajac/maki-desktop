/**
 * maki-confirm, end to end: the real app, offscreen, linked to the fake maki running maki's
 * Confirm app (the test phrase's key). The Connections page shows Confirm's key as maki does and
 * tests it, a yes checked against that key; and maki-confirm itself, started as the script maki
 * desktop installs starts it, asks through the running app's socket, goes ahead on a yes signed
 * with the key it printed, and not on one checked against another maki's key.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { CONFIRM_APP, keyHex, keyLine, keyOf } from '../shared/confirm'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, DESKTOP, drive, E2E } from './drive'

const ELECTRON = join(DESKTOP, 'node_modules/electron/dist/electron')

describe.skipIf(!E2E || !FAKE_BUILT || !APP_FIXTURES_THERE)('maki-confirm, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let key: Uint8Array
  const homes: string[] = []
  const home = (): string => {
    const h = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
    homes.push(h)
    return h
  }

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'confirm.maki')])
    // Confirm's key on this maki, as the page should show it
    const t = await TcpTransport.open(fake.port)
    key = keyOf((await new MakiClient(t).appMessage(CONFIRM_APP, Uint8Array.of(0x50))).answer)!
    await t.close()
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    for (const h of homes) rmSync(h, { recursive: true, force: true })
  })

  it('shows Confirm’s key as maki does, and tests it: a yes signed with that key', async () => {
    const said = await drive(home(), fake.port, [
      ...['--click', 'sudo & Confirm', '--until', keyHex(key)[3]],
      ...['--click', 'confirm › Test it', '--until', 'maki said yes, signed with the key above']
    ])
    for (const line of keyHex(key)) expect(said).toContain(line)
    expect(said).toContain(keyLine(key, 'uni').trim())
    expect(said).toContain('maki said yes, signed with the key above')
  }, 240_000)

  it('runs maki-confirm as scripts run it: a yes goes ahead with maki’s key, not another’s', async () => {
    const h = home()
    // the app, linked and left running while maki-confirm asks it
    const running = drive(h, fake.port, [
      ...['--click', 'sudo & Confirm', '--until', keyHex(key)[3], '--wait', '45000']
    ])
    /** maki-confirm, as the script maki desktop puts on the PATH starts it. */
    const confirm = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((done) =>
        execFile(
          ELECTRON,
          [
            join(DESKTOP, 'out/main/index.js'),
            '--ozone-platform=headless',
            '--maki-confirm',
            ...args
          ],
          { env: { ...process.env, HOME: h, XDG_RUNTIME_DIR: h }, timeout: 60_000 },
          (e, out, err) => done({ code: e ? Number(e.code) : 0, out, err })
        )
      )
    // once maki desktop is up and linked: until then it says maki isn't
    let printed = { code: -1, out: '', err: '' }
    for (let tries = 0; tries < 40 && printed.code !== 0; tries++) {
      if (existsSync(join(h, `maki-${process.getuid?.() ?? 0}.sock`)))
        printed = await confirm(['--public-key'])
      if (printed.code !== 0) await new Promise((r) => setTimeout(r, 1000))
    }
    expect(printed.code, printed.err).toBe(0)
    expect(printed.out).toBe(keyLine(key, 'maki'))
    expect(printed.err).toContain(keyHex(key)[0])
    const mine = join(h, 'maki-confirm.pub')
    writeFileSync(mine, printed.out)
    const yes = await confirm(['Deploy to production?', '--detail', 'web-1, web-2', '--key', mine])
    expect(yes.code, yes.err).toBe(0)
    expect(yes.err).toMatch(/you said yes on maki, signed with the key in/)
    // another maki's key: maki's yes isn't one it checks
    const theirs = join(h, 'theirs.pub')
    writeFileSync(theirs, keyLine(ed25519.getPublicKey(ed25519.utils.randomSecretKey()), 'other'))
    const other = await confirm(['Deploy to production?', '--key', theirs])
    expect(other.code, other.err).toBe(5)
    await running
  }, 240_000)
})
