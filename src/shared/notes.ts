/**
 * maki's Notes app: secrets read on maki, never on the computer again. maki desktop hands it a
 * note the owner typed here (maki asks them first) and forgets it; it can ask for the notes'
 * titles, never for what one says.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const NOTES_APP = 'com.leviathan.maki.notes'

/** A title's most characters, and a note's most bytes, as the app takes them. */
export const NOTE_TITLE = 40
export const NOTE_TEXT = 8000

/** Why the app wouldn't take this note, in words; null if it would. */
export function noteProblem(title: string, text: string): string | null {
  const t = title.trim()
  if (t === '') return 'It needs a title: what maki lists it as.'
  if ([...t].length > NOTE_TITLE) return `A title is ${NOTE_TITLE} characters at most.`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return 'A title is one line.'
  const size = new TextEncoder().encode(text).length
  if (size > NOTE_TEXT)
    return `A note is ${NOTE_TEXT.toLocaleString('en-US')} bytes at most, and this one is ${size.toLocaleString('en-US')}.`
  return null
}

/** The app's `A` message: a note to keep, its title trimmed. Null if the app wouldn't take it. */
export function noteMessage(title: string, text: string): Uint8Array | null {
  if (noteProblem(title, text) !== null) return null
  const t = new TextEncoder().encode(title.trim())
  const x = new TextEncoder().encode(text)
  const m = new Uint8Array(2 + t.length + x.length)
  m[0] = 'A'.charCodeAt(0)
  m[1] = t.length
  m.set(t, 2)
  m.set(x, 2 + t.length)
  return m
}

/** The titles in the app's answer to `L`; null if it isn't one. */
export function noteTitles(answer: Uint8Array): string[] | null {
  if (answer[0] !== 0) return null
  return new TextDecoder()
    .decode(answer.subarray(1))
    .split('\n')
    .filter((t) => t !== '')
}

/** What the app's answer to `A` says, in words: null if it kept the note. */
export function noteSays(answer: Uint8Array): string | null {
  switch (answer[0]) {
    case 0:
      return null
    case 1:
      return 'you said no on maki'
    case 2:
      return 'nobody answered on maki'
    case 5:
      return 'maki’s Notes app has no room for it'
    default:
      return 'maki’s Notes app didn’t take it'
  }
}
