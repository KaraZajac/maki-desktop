/**
 * maki's Macro Pad app: keystrokes maki types into the computer at the press of a button — text,
 * keys and DuckyScript. maki desktop hands it a script the owner wrote or loaded here; maki keeps
 * it, and types it only when the owner runs it on maki's own screen.
 *
 * We speak DuckyScript 1.0 (and STRINGLN from 2.0): the keystroke-injection commands. Not 3.0's
 * language (VAR, IF, WHILE, FUNCTION, RANDOM) or its hardware features (mouse, ATTACKMODE, LED);
 * a line maki can't act on is skipped, not an error.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const MACROPAD_APP = 'com.leviathan.maki.macropad'

/** A name's most characters, and a whole message's most bytes, as the app and the link take them. */
export const MAX_NAME = 24
export const MAX_MESSAGE = 4096

/** The app's message: the name on the first line, the DuckyScript after. Null if it won't fit. */
export function scriptMessage(name: string, body: string): Uint8Array | null {
  const trimmed = name.trim()
  const message = new TextEncoder().encode(`${trimmed}\n${body}`)
  const ok =
    trimmed !== '' &&
    [...trimmed].length <= MAX_NAME &&
    !/[\u0000-\u001f\u007f]/.test(trimmed) &&
    message.length <= MAX_MESSAGE
  return ok ? message : null
}

/** What the app said: whether it kept the script, and a line for the owner. */
export function macropadReply(answer: Uint8Array): { ok: boolean; text: string } {
  const said = new TextDecoder().decode(answer)
  const count = said.match(/^ok (\d+)$/)
  if (count) {
    const n = Number(count[1])
    return { ok: true, text: `Kept on maki — ${n} ${n === 1 ? 'script' : 'scripts'} on the pad.` }
  }
  if (said === 'full') return { ok: false, text: 'The pad is full — remove one on maki first.' }
  return { ok: false, text: `maki’s Macro Pad: ${said || 'no answer'}` }
}

/** The DuckyScript commands maki runs (1.0, plus STRINGLN). */
const KNOWN = new Set([
  'REM',
  'STRING',
  'STRINGLN',
  'DELAY',
  'DEFAULTDELAY',
  'DEFAULT_DELAY',
  'REPEAT',
  'ENTER',
  'RETURN',
  'TAB',
  'ESC',
  'ESCAPE',
  'SPACE',
  'BACKSPACE',
  'BKSP',
  'DELETE',
  'DEL',
  'INSERT',
  'INS',
  'HOME',
  'END',
  'PAGEUP',
  'PAGE_UP',
  'PAGEDOWN',
  'PAGE_DOWN',
  'UP',
  'UPARROW',
  'DOWN',
  'DOWNARROW',
  'LEFT',
  'LEFTARROW',
  'RIGHT',
  'RIGHTARROW',
  'CAPSLOCK',
  'PRINTSCREEN',
  'PRINTSCRN',
  'PRINT',
  'SCROLLLOCK',
  'PAUSE',
  'BREAK',
  // modifiers, which lead a chord
  'CTRL',
  'CONTROL',
  'ALT',
  'OPTION',
  'SHIFT',
  'GUI',
  'WINDOWS',
  'WIN',
  'COMMAND',
  'META',
  'SUPER'
])

const MODIFIERS = new Set([
  'CTRL',
  'CONTROL',
  'ALT',
  'OPTION',
  'SHIFT',
  'GUI',
  'WINDOWS',
  'WIN',
  'COMMAND',
  'META',
  'SUPER'
])

/** Whether a verb is an F-key (F1..F12). */
function isFKey(verb: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(verb)
}

/**
 * A read of a script before it's sent: how many lines maki will act on, and the ones it won't
 * (a 3.0 command, a lone modifier, an unknown key), each named once, so the owner knows a script
 * won't fully run before they rely on it.
 */
export function reviewScript(body: string): { actions: number; skipped: string[] } {
  let actions = 0
  const skipped = new Set<string>()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const verb = line.split(/[\s-]+/)[0].toUpperCase()
    if (verb === 'REM') continue
    if (KNOWN.has(verb) || isFKey(verb)) {
      // a line that's only modifiers (a lone GUI) maki can't press
      const tokens = line.split(/[\s-]+/).filter((t) => t !== '')
      if (tokens.every((t) => MODIFIERS.has(t.toUpperCase()))) {
        skipped.add(`${verb} on its own`)
      } else {
        actions += 1
      }
    } else if (/^[^\s]$/.test(verb)) {
      // a single-character key line
      actions += 1
    } else {
      skipped.add(verb)
    }
  }
  return { actions, skipped: [...skipped] }
}
