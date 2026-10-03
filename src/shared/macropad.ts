/**
 * maki's Macro Pad app: keystrokes maki types into the computer at the press of a button — text,
 * keys and DuckyScript. maki desktop hands it a script the owner wrote or loaded here; maki asks
 * them before it keeps one, replaces one or removes one, and types a script only when they run it
 * on maki's own screen.
 *
 * We speak DuckyScript 1.0 (and STRINGLN from 2.0): the keystroke-injection commands. Not 3.0's
 * language (VAR, IF, WHILE, FUNCTION, RANDOM) or its hardware features (mouse, ATTACKMODE, LED);
 * a line maki can't act on is skipped, not an error. A script can also be text, which maki types as
 * it is: printable ASCII, a line break pressing Enter and a tab Tab.
 *
 * The app's messages (sdk/examples/macropad), from version 2 of the app (its label 1.1), numbers
 * little-endian, each after the messages' version (2) and a letter: `L`, answered `0`, the version,
 * how many scripts and the most (a byte each), the room used and the room (u32 each), then each
 * script's ID and kind (a byte each), when it came and when it was last replaced (u64 seconds each),
 * its size (u16) and its name (a byte's length, then UTF-8); `G` and an ID, answered `0` and the
 * script's text; `P`, the ID it replaces (0 for a new one), its kind, its name (a byte's length,
 * then UTF-8) and its text, answered `0` and its ID; `D` and an ID, answered `0`. Otherwise `1` no,
 * `2` no answer, `4` not taken and `5` no room (each with why, in English), `7` no such script, `8`
 * another has that name, `9` another version. Version 1 of the app (1.0) takes only a script whose
 * first line is its name (`scriptMessage`), and keeps it without asking.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const MACROPAD_APP = 'com.leviathan.maki.macropad'

/** A name's most characters, and a whole message's most bytes, as the app and the link take them. */
export const MAX_NAME = 24
export const MAX_MESSAGE = 4096

/** The app's version (in its manifest) from which it lists its scripts, gives them back and removes them. */
export const LISTS_FROM = 2
/** The version of its messages, which each starts with. */
export const PAD_VERSION = 2
/** The most scripts it keeps, a script's most bytes, and the room they share (names and texts). */
export const MAX_SCRIPTS = 12
export const MAX_SCRIPT = 3900
export const PAD_ROOM = 16 * 1024

/** What a script is: DuckyScript, or text maki types as it is. */
export type ScriptKind = 'ducky' | 'text'
export const KIND_NAME: Record<ScriptKind, string> = { ducky: 'DuckyScript', text: 'text' }

/** A script as the app lists it. */
export interface PadScript {
  /** the app's, to name it by */
  id: number
  kind: ScriptKind
  /** when it came to maki, and when it was last replaced: seconds since 1970, 0 if maki didn't know */
  added: number
  changed: number
  /** its text's bytes */
  size: number
  name: string
}

/** What `L` answers: the scripts, and the room they take. */
export interface Pad {
  most: number
  used: number
  room: number
  scripts: PadScript[]
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const L = 'L'.charCodeAt(0)
const G = 'G'.charCodeAt(0)
const P = 'P'.charCodeAt(0)
const D = 'D'.charCodeAt(0)

/** Whether a version of the app lists its scripts (from 2; 1.0 takes them only). */
export function lists(version: number): boolean {
  return version >= LISTS_FROM
}

/** Line endings as maki keeps them: a line feed each, whatever the file had. */
export function lineFeeds(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** What a script takes of the pad's room: its name and text, and a u16 length before each. */
export function cost(name: string, body: string): number {
  return 4 + utf8(name).length + utf8(body).length
}

/** `L`: the scripts. */
export function listMessage(): Uint8Array {
  return Uint8Array.of(PAD_VERSION, L)
}

/** `L`'s answer; null if it isn't one. */
export function readPad(answer: Uint8Array): Pad | null {
  if (answer.length < 12 || answer[0] !== 0 || answer[1] !== PAD_VERSION) return null
  const v = new DataView(answer.buffer, answer.byteOffset, answer.byteLength)
  const count = answer[2]
  const scripts: PadScript[] = []
  let at = 12
  for (let i = 0; i < count; i++) {
    if (at + 21 > answer.length) return null
    const kind = answer[at + 1] === 0 ? 'ducky' : answer[at + 1] === 1 ? 'text' : null
    const n = answer[at + 20]
    if (kind === null || at + 21 + n > answer.length) return null
    let name: string
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(answer.subarray(at + 21, at + 21 + n))
    } catch {
      return null
    }
    scripts.push({
      id: answer[at],
      kind,
      added: Number(v.getBigUint64(at + 2, true)),
      changed: Number(v.getBigUint64(at + 10, true)),
      size: v.getUint16(at + 18, true),
      name
    })
    at += 21 + n
  }
  if (at !== answer.length) return null
  return { most: answer[3], used: v.getUint32(4, true), room: v.getUint32(8, true), scripts }
}

/** `G`: script `id`'s text. */
export function getMessage(id: number): Uint8Array {
  return Uint8Array.of(PAD_VERSION, G, id)
}

/** The text in `G`'s answer; null if it isn't one. */
export function readText(answer: Uint8Array): string | null {
  if (answer[0] !== 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(answer.subarray(1))
  } catch {
    return null
  }
}

/** `D`: script `id` removed, once the owner says yes. */
export function removeMessage(id: number): Uint8Array {
  return Uint8Array.of(PAD_VERSION, D, id)
}

/** What maki types of a text, and what it can't. */
export interface TextReview {
  characters: number
  /** line breaks, each an Enter, and tabs, each a Tab */
  enters: number
  tabs: number
  /** the characters maki can't type, each once */
  untypable: string[]
}

/** A read of a text before it's sent: what maki types (printable ASCII, line breaks and tabs). */
export function reviewText(text: string): TextReview {
  const untypable = new Set<string>()
  let enters = 0
  let tabs = 0
  for (const c of text) {
    if (c === '\n') enters++
    else if (c === '\t') tabs++
    else if (!/^[\x20-\x7e]$/.test(c)) untypable.add(c)
  }
  return { characters: [...text].length, enters, tabs, untypable: [...untypable] }
}

/**
 * Why the app wouldn't take this script, in words; null if it would. `pad` (what maki has) adds its
 * own reasons: another script of that name, no room for another, or not room enough; `id` is the
 * script it replaces (0 for a new one).
 */
export function scriptProblem(
  kind: ScriptKind,
  name: string,
  body: string,
  pad: Pad | null = null,
  id = 0
): string | null {
  const n = name.trim()
  if (n === '') return 'It needs a name: what maki lists it as.'
  if ([...n].length > MAX_NAME) return `A name is ${MAX_NAME} characters at most.`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) return 'A name is one line.'
  const text = lineFeeds(body)
  const size = utf8(text).length
  if (size > MAX_SCRIPT)
    return `A script is ${MAX_SCRIPT.toLocaleString('en-US')} bytes at most, and this one is ${size.toLocaleString('en-US')}.`
  if (kind === 'text') {
    const { untypable } = reviewText(text)
    if (untypable.length > 0)
      return `maki types a text’s letters, digits and symbols as a US keyboard has them, line breaks and tabs: not ${untypable
        .slice(0, 8)
        .map((c) => (/\s/.test(c) ? `U+${c.codePointAt(0)!.toString(16).toUpperCase()}` : c))
        .join(' ')}${untypable.length > 8 ? ' …' : ''}. Make it DuckyScript, or leave those out.`
  }
  if (pad) {
    const other = pad.scripts.find((s) => s.name === n && s.id !== id)
    if (other) return `maki has a script called “${n}”: give this one another name.`
    const old = pad.scripts.find((s) => s.id === id)
    if (!old && pad.scripts.length >= pad.most)
      return `maki keeps ${pad.most} scripts: remove one first.`
    const free = pad.room - pad.used + (old ? 4 + utf8(old.name).length + old.size : 0)
    const need = cost(n, text)
    if (need > free)
      return `It takes ${need.toLocaleString('en-US')} bytes of maki’s room for scripts, and ${free.toLocaleString('en-US')} are free.`
  }
  return null
}

/**
 * `P`: a script kept, new (`id` 0) or in place of script `id`, once the owner says yes. Its name
 * trimmed and its line endings line feeds, as maki keeps them. Null if the app wouldn't take it.
 */
export function putMessage(
  id: number,
  kind: ScriptKind,
  name: string,
  body: string
): Uint8Array | null {
  if (scriptProblem(kind, name, body) !== null) return null
  const n = utf8(name.trim())
  const text = utf8(lineFeeds(body))
  const m = new Uint8Array(5 + n.length + text.length)
  m.set([PAD_VERSION, P, id, kind === 'ducky' ? 0 : 1, n.length])
  m.set(n, 5)
  m.set(text, 5 + n.length)
  return m
}

/** The script's ID in `P`'s answer, if it was kept. */
export function keptId(answer: Uint8Array): number | null {
  return answer.length === 2 && answer[0] === 0 ? answer[1] : null
}

/** What the app's answer to `P` or `D` says, in words: null if it was done. */
export function padSays(answer: Uint8Array): string | null {
  // the app's own words, with this window's apostrophes
  const why = new TextDecoder().decode(answer.subarray(1)).replace(/'/g, '’')
  switch (answer[0]) {
    case 0:
      return null
    case 1:
      return 'you said no on maki'
    case 2:
      return 'nobody answered on maki'
    case 4:
      return why ? `maki’s Macro Pad didn’t take it: ${why}` : 'maki’s Macro Pad didn’t take it'
    case 5:
      return why || 'there’s no room for it on maki'
    case 7:
      return 'that script isn’t on maki any more'
    case 8:
      return 'maki has another script with that name'
    case 9:
      return 'maki’s Macro Pad speaks a newer version of these messages: update maki desktop'
    default:
      return 'maki’s Macro Pad didn’t take it'
  }
}

/** Why maki didn't pass a message to the app, in words. */
export function linkSays(status: string): string {
  switch (status) {
    case 'no match':
      return 'maki’s Macro Pad isn’t installed'
    case 'unavailable':
      return 'another app is open on maki: go back to its home screen, or open Macro Pad there'
    case 'locked':
      return 'maki is locked: put its PIN in on maki'
    default:
      return `maki’s Macro Pad: ${status}`
  }
}

/**
 * Version 1 of the app's message (Macro Pad 1.0): the name on the first line, the DuckyScript
 * after. Null if it won't fit.
 */
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

/** What version 1 of the app said: whether it kept the script, and a line for the owner. */
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

/** Lines maki acts on that press nothing: they wait. */
const WAITS = new Set(['DELAY', 'DEFAULTDELAY', 'DEFAULT_DELAY'])

/**
 * A read of a script before it's sent: how many of its lines press keys (a wait doesn't), and the
 * lines maki won't act on (a 3.0 command, a lone modifier, an unknown key), each named once, so the
 * owner knows a script won't fully run before they rely on it.
 */
export function reviewScript(body: string): { actions: number; skipped: string[] } {
  let actions = 0
  const skipped = new Set<string>()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const verb = line.split(/[\s-]+/)[0].toUpperCase()
    if (verb === 'REM' || WAITS.has(verb)) continue
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

/**
 * What maki will make of a script, in a line: how many keystroke lines (DuckyScript) or characters
 * (a text) it types, and as a warning, what it skips or can't type; null for nothing to warn of.
 */
export function scriptSays(kind: ScriptKind, body: string): { says: string; warn: string | null } {
  const count = (n: number, one: string, many = `${one}s`): string =>
    `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
  if (kind === 'ducky') {
    const { actions, skipped } = reviewScript(lineFeeds(body))
    return {
      says: count(actions, 'keystroke line'),
      warn: skipped.length > 0 ? `maki skips ${skipped.join(', ')}` : null
    }
  }
  const t = reviewText(lineFeeds(body))
  const presses = [
    t.enters > 0 ? count(t.enters, 'Enter') : null,
    t.tabs > 0 ? count(t.tabs, 'Tab') : null
  ].filter((p) => p !== null)
  return {
    says: `${count(t.characters, 'character')}${presses.length > 0 ? `, ${presses.join(' and ')} among them` : ''}`,
    warn: t.untypable.length > 0 ? `maki can’t type ${t.untypable.slice(0, 8).join(' ')}` : null
  }
}
