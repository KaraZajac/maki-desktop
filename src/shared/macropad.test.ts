import { describe, expect, it } from 'vitest'
import { macropadReply, MAX_MESSAGE, MAX_NAME, reviewScript, scriptMessage } from './macropad'

const dec = new TextDecoder()

describe('the Macro Pad', () => {
  it('packs a script as name then body, and refuses what won’t fit', () => {
    const m = scriptMessage('Open run', 'GUI r\nSTRING cmd\nENTER')!
    expect(dec.decode(m)).toBe('Open run\nGUI r\nSTRING cmd\nENTER')
    // name is trimmed; a blank name, a too-long name, control characters, and an over-long body are refused
    expect(dec.decode(scriptMessage('  hi  ', 'STRING x')!)).toBe('hi\nSTRING x')
    expect(scriptMessage('', 'STRING x')).toBeNull()
    expect(scriptMessage('x'.repeat(MAX_NAME + 1), 'STRING x')).toBeNull()
    expect(scriptMessage('bad\tname', 'STRING x')).toBeNull()
    expect(scriptMessage('big', 'STRING ' + 'a'.repeat(MAX_MESSAGE))).toBeNull()
  })

  it('reads the app’s reply', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(macropadReply(enc('ok 1'))).toEqual({
      ok: true,
      text: 'Kept on maki — 1 script on the pad.'
    })
    expect(macropadReply(enc('ok 7'))).toEqual({
      ok: true,
      text: 'Kept on maki — 7 scripts on the pad.'
    })
    expect(macropadReply(enc('full')).ok).toBe(false)
  })

  it('counts keystroke lines and names what maki will skip', () => {
    const r = reviewScript('REM a comment\nSTRING hello\nGUI r\nENTER\nF5\na')
    expect(r).toEqual({ actions: 5, skipped: [] })
    // a lone modifier, and DuckyScript 3.0 commands maki doesn’t run, are named once
    const three = reviewScript('GUI\nVAR $x = 1\nSTRING hi\nMOUSE 10 10\nVAR $y = 2')
    expect(three.actions).toBe(1)
    expect(three.skipped).toEqual(['GUI on its own', 'VAR', 'MOUSE'])
  })
})
