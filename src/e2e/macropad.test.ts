/**
 * The Macro Pad page, end to end: the real app, offscreen, linked to the fake maki running maki's
 * Macro Pad (sdk/examples/macropad). With version 2 (1.1), it writes a script and sends it, opens
 * it, changes it and saves it, adds a text, and removes the first, pressing what a person would,
 * while the app itself, asked over the link, says what it keeps. With Macro Pad 1.0 (from the
 * firmware's history), the page says to update it, and still sends a script the way 1.0 takes one.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/macropad.test.ts
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { getMessage, listMessage, MACROPAD_APP, readPad, readText } from '../shared/macropad'
import {
  APP_FIXTURES,
  FAKE_BUILT,
  firstMacroPad,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive as driveApp, E2E } from './drive'

/** The page's fields, by their placeholders. */
const NAME = 'Open a terminal'
const SCRIPT = 'A command a line: GUI r, then DELAY 300, then STRING notepad, then ENTER'
const TEXT = 'What maki types, as it is: a line break presses Enter, a tab Tab'

describe.skipIf(!E2E || !FAKE_BUILT)('the Macro Pad page, end to end', () => {
  const fakes: ChildProcess[] = []
  let port = 0
  let home = ''

  beforeAll(async () => {
    build()
    const fake = await startFake(['--app', join(APP_FIXTURES, 'macropad.maki')])
    fakes.push(fake.proc)
    port = fake.port
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fakes.forEach((p) => p.kill())
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** What maki's Macro Pad keeps, as it answers the link: each script's name, kind and text. */
  const kept = async (on = port): Promise<[string, string, string | null][]> => {
    const t = await TcpTransport.open(on)
    try {
      const c = new MakiClient(t)
      const pad = readPad((await c.appMessage(MACROPAD_APP, listMessage())).answer)!
      const out: [string, string, string | null][] = []
      for (const s of pad.scripts)
        out.push([
          s.name,
          s.kind,
          readText((await c.appMessage(MACROPAD_APP, getMessage(s.id))).answer)
        ])
      return out
    } finally {
      await t.close()
    }
  }

  it('sends a script, opens and changes it, adds a text, and removes the first', async () => {
    const sent = await driveApp(home, port, [
      ...['--click', 'Macro Pad', '--until', 'No scripts on maki yet'],
      ...['--fill', `${NAME}=Open a terminal`],
      ...['--fill', `${SCRIPT}=GUI r\nDELAY 300\nSTRING cmd\nENTER`],
      ...['--click', 'Send to maki', '--until', 'Open a terminal is on maki now.']
    ])
    // listed, with what maki makes of it, and open to change
    expect(sent).toMatch(/1 of 12 scripts/)
    expect(sent).toMatch(/3 keystroke lines · 32 B/)
    expect(sent).toMatch(/A SCRIPT ON MAKI/)
    expect(await kept()).toEqual([
      ['Open a terminal', 'ducky', 'GUI r\nDELAY 300\nSTRING cmd\nENTER']
    ])

    // opened again, changed, saved: and what maki will skip said first
    const changed = await driveApp(home, port, [
      ...['--click', 'Macro Pad', '--until', 'Open a terminal'],
      ...['--click', 'Open Open a terminal', '--until', 'A SCRIPT ON MAKI'],
      ...['--fill', `${SCRIPT}=GUI r\nDELAY 500\nSTRINGLN powershell\nVAR $x = 1`],
      ...['--click', 'Save on maki', '--until', 'Open a terminal changed on maki.']
    ])
    expect(changed).toMatch(/2 keystroke lines · maki skips VAR/)
    expect(await kept()).toEqual([
      ['Open a terminal', 'ducky', 'GUI r\nDELAY 500\nSTRINGLN powershell\nVAR $x = 1']
    ])

    // a text, typed as it is; then the first removed
    const after = await driveApp(home, port, [
      ...['--click', 'Macro Pad', '--until', 'Open a terminal'],
      ...['--fill', `${NAME}=Signature`],
      ...['--click', 'Text as it is'],
      ...['--fill', `${TEXT}=Kara\n\t.leviathan`],
      ...['--click', 'Send to maki', '--until', 'Signature is on maki now.'],
      ...['--click', 'Remove Open a terminal', '--until', 'Open a terminal removed from maki.']
    ])
    expect(after).toMatch(/16 characters, 1 Enter and 1 Tab among them/)
    expect(after).toMatch(/1 of 12 scripts/)
    expect(await kept()).toEqual([['Signature', 'text', 'Kara\n\t.leviathan']])
  }, 600_000)

  it('with Macro Pad 1.0, says to update it, and still sends a script', async (t) => {
    const first = firstMacroPad(home)
    if (!first) return t.skip()
    const fake = await startFake(['--app', first])
    fakes.push(fake.proc)
    const said = await driveApp(home, fake.port, [
      ...['--click', 'Macro Pad', '--until', 'version 1.0'],
      ...['--fill', `${NAME}=Open a terminal`],
      ...['--fill', `${SCRIPT}=GUI r\nSTRING cmd\nENTER`],
      ...['--click', 'Send to maki', '--until', 'Kept on maki — 1 script on the pad.']
    ])
    expect(said).toMatch(/Update it to 1\.1 on Apps to see the scripts maki keeps/)
    // nothing of version 2's was sent to it: 1.0 would have kept it as a script
    expect(said).not.toMatch(/of 12 scripts/)
  }, 300_000)
})
