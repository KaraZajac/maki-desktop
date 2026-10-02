/**
 * maki's Confirm app, as maki-confirm (src/main/confirm.ts) and the Connections page ask it: a
 * request to go ahead, as the app reads one, its answer, and checking a yes against maki's key.
 * The app shows a request whole on maki and asks its owner; a yes is a signature, with a key of
 * the app's own from maki's recovery phrase, of the request (a fresh nonce of the caller's, and
 * everything maki showed) behind the app's own words. Whoever keeps the key checks the signature,
 * so nothing on the computer can say yes for maki, nor use one yes for another request.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { fromBase64, toBase64 } from './bridge-types'

export const CONFIRM_APP = 'com.leviathan.maki.confirm'
/** What a yes is a signature of: this, then the request. */
export const SIGNED = new TextEncoder().encode('maki confirm approval\0')
/** A key file's lines: this, the key in base64, and a name for it. */
export const KEY_KIND = 'maki-confirm-ed25519'

/**
 * The most of each part maki shows, in bytes as it shows them (`shownLength`): the app turns down
 * a request with more rather than cut it.
 */
export const QUESTION = 64
export const DETAIL = 1024
export const NAME = 64
export const CWD = 512
export const PROGRAM = 512
/**
 * The seconds a request may give maki's owner to answer: the app takes 10 to 300, but maki
 * desktop waits 90 for an app's answer (MakiClient's), so asking for more would leave the caller
 * without one; and how long, unless it says.
 */
export const SOONEST_S = 10
export const LATEST_S = 80
export const DEFAULT_S = 60

/** The app's answers' first byte. */
const OK = 0
const DENIED = 1
const NO_ANSWER = 2
const LOCKED = 3
const BAD = 4

export interface ConfirmRequest {
  /** what's asked ("Deploy to production?") */
  question: string
  /** more about it, in lines; may be empty */
  detail: string
  user: string
  /** the computer's name */
  host: string
  /** where it was asked from; may be empty */
  cwd: string
  /** the program that asked: its command line, a word each, as the system has them */
  program: Uint8Array[]
  /** seconds the owner has to answer */
  timeout: number
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const printable = (c: number): boolean => c >= 0x20 && c <= 0x7e

/**
 * How many bytes maki shows for `b`: printable ASCII as it is (a backslash doubled), anything else
 * as `\xNN`, so nothing hides or looks like something it isn't; new lines kept, if `lines`.
 */
export function shownLength(b: Uint8Array, lines = false): number {
  let n = 0
  for (const c of b) n += c === 0x5c ? 2 : (lines && c === 0x0a) || printable(c) ? 1 : 4
  return n
}

/** How many bytes maki shows for a word of a command line, quoted as a shell takes it back. */
export function wordLength(b: Uint8Array): number {
  const bare = (c: number): boolean =>
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    '_@%+=:,./-'.includes(String.fromCharCode(c))
  if (b.length > 0 && b.every(bare)) return b.length
  if (b.every(printable)) return 2 + b.reduce((n, c) => n + (c === 0x27 ? 4 : 1), 0)
  let n = 3
  for (const c of b) n += [0x5c, 0x27, 0x0a, 0x09, 0x0d].includes(c) ? 2 : printable(c) ? 1 : 4
  return n
}

/**
 * As much of a command line as maki shows whole: its first words, while they fit (a space between
 * each), and how many more it has, which maki says were left out.
 */
export function programFit(words: Uint8Array[]): { words: Uint8Array[]; more: number } {
  const kept: Uint8Array[] = []
  let used = 0
  for (const w of words) {
    const n = (kept.length > 0 ? 1 : 0) + wordLength(w)
    if (kept.length === 255 || used + n > PROGRAM || w.length > 0xffff) break
    kept.push(w)
    used += n
  }
  return { words: kept, more: Math.min(255, words.length - kept.length) }
}

/** Why the app would turn the request down, in words; null if it would show it. */
export function confirmProblem(r: ConfirmRequest): string | null {
  const q = utf8(r.question)
  if (!/[^ ]/.test(r.question)) return 'what’s the question? It’s empty'
  if (q.length > 255 || shownLength(q) > QUESTION)
    return `the question is too long for maki’s screen: ${QUESTION} characters at most (each byte beyond plain ASCII shows as four, \\xNN)`
  const d = utf8(r.detail)
  if (d.length > 0xffff || shownLength(d, true) > DETAIL)
    return `the details are too long for maki to show whole: ${DETAIL} characters at most`
  const user = utf8(r.user)
  const host = utf8(r.host)
  if (user.length === 0 || host.length === 0)
    return 'who asked, and on which computer, can’t be empty'
  if (
    user.length > 255 ||
    shownLength(user) > NAME ||
    host.length > 255 ||
    shownLength(host) > NAME
  )
    return `the user’s or the computer’s name is longer than maki shows (${NAME} characters)`
  const cwd = utf8(r.cwd)
  if (cwd.length > 0xffff || shownLength(cwd) > CWD)
    return `the directory is longer than maki shows (${CWD} characters): ask from another`
  if (!Number.isInteger(r.timeout) || r.timeout < SOONEST_S || r.timeout > LATEST_S)
    return `the time to answer is ${SOONEST_S} to ${LATEST_S} seconds`
  return null
}

/**
 * The request as the app reads it, everything after the `C` (and what a yes signs, after
 * `SIGNED`): the nonce, then the request's parts (sdk/examples/confirm, `Request`). Check it with
 * `confirmProblem` first.
 */
export function confirmBody(r: ConfirmRequest, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== 32) throw new Error('a nonce is 32 bytes')
  const parts: Uint8Array[] = [nonce, Uint8Array.of(r.timeout & 0xff, r.timeout >> 8)]
  const s8 = (b: Uint8Array): void => void parts.push(Uint8Array.of(b.length), b)
  const s16 = (b: Uint8Array): void =>
    void parts.push(Uint8Array.of(b.length & 0xff, b.length >> 8), b)
  s8(utf8(r.question))
  s16(utf8(r.detail))
  s8(utf8(r.user))
  s8(utf8(r.host))
  s16(utf8(r.cwd))
  const program = programFit(r.program)
  parts.push(Uint8Array.of(program.words.length))
  for (const w of program.words) s16(w)
  parts.push(Uint8Array.of(program.more))
  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The app's `C` message: the request to show its owner. */
export function confirmMessage(body: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x43), body])
}

export type ConfirmAnswer =
  | { said: 'yes'; signature: Uint8Array }
  | { said: 'no' | 'no answer' | 'locked' | 'refused' | 'odd' }

/** What the app answered a `C` with. */
export function confirmAnswer(answer: Uint8Array): ConfirmAnswer {
  if (answer.length === 65 && answer[0] === OK) return { said: 'yes', signature: answer.slice(1) }
  if (answer.length !== 1) return { said: 'odd' }
  switch (answer[0]) {
    case DENIED:
      return { said: 'no' }
    case NO_ANSWER:
      return { said: 'no answer' }
    case LOCKED:
      return { said: 'locked' }
    case BAD:
      return { said: 'refused' }
    default:
      return { said: 'odd' }
  }
}

/** Whether `signature` is `key`'s yes to the request `body`: Ed25519, as RFC 8032 checks it. */
export function verifyYes(key: Uint8Array, body: Uint8Array, signature: Uint8Array): boolean {
  if (key.length !== 32 || signature.length !== 64) return false
  try {
    return ed25519.verify(signature, concat([SIGNED, body]), key, { zip215: false })
  } catch {
    return false
  }
}

/** The key the app answers `P` with; null if that isn't one. */
export function keyOf(answer: Uint8Array): Uint8Array | null {
  return answer.length === 33 && answer[0] === OK ? answer.slice(1) : null
}

/** A key file's line for `key`, named (a maki's name, say: nothing but letters, digits, `._-`). */
export function keyLine(key: Uint8Array, name: string): string {
  const n = name.replace(/[^A-Za-z0-9._-]/g, '') || 'maki'
  return `${KEY_KIND} ${toBase64(key)} ${n}\n`
}

/** The keys in a key file: its lines of `KEY_KIND`, a key in base64 after, and anything else left be. */
export function keysIn(text: string): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const line of text.split('\n')) {
    const [kind, key] = line.trim().split(/\s+/)
    if (kind !== KEY_KIND || !key || !/^[A-Za-z0-9+/]{43}=$/.test(key)) continue
    const bytes = fromBase64(key)
    if (bytes?.length === 32) out.push(bytes)
  }
  return out
}

/** A key as maki's Confirm app shows it, from its menu: four lines of hex. */
export function keyHex(key: Uint8Array): string[] {
  const hex = [...key].map((b) => b.toString(16).padStart(2, '0')).join('')
  return [0, 1, 2, 3].map((i) => hex.slice(i * 16, i * 16 + 16))
}

/** What the app's answer, or maki desktop's word for it, says, for a person. */
export function confirmSays(status: string, answer: ConfirmAnswer | null): string {
  if (status === 'no match')
    return 'maki’s Confirm app isn’t installed: add it from the maki store, in maki desktop'
  if (status === 'locked') return 'maki is locked: enter its PIN first'
  if (status === 'unavailable')
    return 'maki couldn’t run its Confirm app: close the app that’s open on maki and ask again'
  if (status !== 'approved' || !answer) return `maki: ${status}`
  switch (answer.said) {
    case 'yes':
      return 'you said yes on maki'
    case 'no':
      return 'you said no on maki'
    case 'no answer':
      return 'nobody answered on maki in time'
    case 'locked':
      return 'maki is locked: enter its PIN first'
    case 'refused':
      return 'maki’s Confirm app wouldn’t show it: too long to show whole, or not a request it reads'
    case 'odd':
      return 'maki’s Confirm app answered oddly'
  }
}
