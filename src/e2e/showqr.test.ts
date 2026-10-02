/**
 * Show QR, end to end: the real app, offscreen, linked to the fake maki running maki's Show QR
 * app. On the Connections page a text too long for maki's screen is turned down before it's sent,
 * with why; a link goes, and maki's app says it's what it's showing.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { shownText, SHOWQR_APP } from '../shared/showqr'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive, E2E } from './drive'

const FIELD = 'A link, a Wi-Fi network, an address, a few words'

describe.skipIf(!E2E || !FAKE_BUILT || !APP_FIXTURES_THERE)('Show QR, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'showqr.maki')])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('turns down what maki’s screen can’t show, with why, and shows a link on maki', async () => {
    const link = 'https://maki.netslum.io/docs/showqr'
    const said = await drive(home, fake.port, [
      ...['--click', 'Show QR', '--until', 'it keeps the last five'],
      ...['--fill', `${FIELD}=${'a'.repeat(300)}`, '--until', '300 bytes, where it holds 192'],
      ...['--fill', `${FIELD}=${link}`, '--until', 'a version 3 QR code, 3 pixels a module'],
      ...['--click', 'show qr › Show on maki', '--until', 'On maki now, in Show QR']
    ])
    expect(said).toContain('On maki now, in Show QR')
    // what maki's app is showing
    const t = await TcpTransport.open(fake.port)
    try {
      const r = await new MakiClient(t).appMessage(SHOWQR_APP, Uint8Array.of(0x3f))
      expect(shownText(r.answer)).toBe(link)
    } finally {
      await t.close()
    }
  }, 240_000)
})
