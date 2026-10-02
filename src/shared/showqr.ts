/**
 * maki's Show QR app: what maki desktop sends it, on maki's screen as a QR code for a phone to
 * scan, the text itself on its next page. It shows what maki's screen, 110 pixels high, draws at
 * two pixels a module or more: QR code version 8, at the lowest error correction, as maki draws
 * its codes, which phone cameras read. `qrVersion` works out the version as maki does
 * (maki-wasm's `qr_bits`): the `qrcode` crate's parser (0.12) cuts the text into runs of digits,
 * of capitals and the like, and of anything else, the Kanji pairs it finds written as bytes, as
 * maki writes them so phones read back what was sent; then runs are joined left to right while
 * joining takes no more bits. So maki desktop says why before it sends; maki checks again, and
 * has the last word. The classes, state table and joining are ported from that crate
 * (src/optimize.rs, github.com/kennytm/qrcode-rust, by kennytm; MIT or Apache-2.0).
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const SHOWQR_APP = 'com.leviathan.maki.showqr'
/** The most bytes of text a message may carry (the app's `MOST`). */
export const MOST = 512
/** The biggest QR code maki's screen shows at two pixels a module. */
export const MAX_VERSION = 8
/** The app's part of maki's screen, high, and the light modules around a code maki draws. */
const SCREEN = 110
const QUIET = 2

/** What the app answers `S` with: shown, or why not (it doesn't use 3). */
const SHOWN = 0
const TOO_LONG = 1
const NOT_TEXT = 2

/** The modes maki writes text in, each holding all the one before it holds. */
const MODES = ['numeric', 'alphanumeric', 'byte'] as const
type Mode = (typeof MODES)[number]

/** The bits a segment of `len` bytes takes in versions 1 to 9: the mode's four, its length, its data. */
function bits(mode: Mode, len: number): number {
  switch (mode) {
    case 'numeric':
      return 4 + 10 + Math.ceil((len * 10) / 3)
    case 'alphanumeric':
      return 4 + 9 + Math.ceil((len * 11) / 2)
    case 'byte':
      return 4 + 8 + len * 8
  }
}

/** The mode that holds both. */
function max(a: Mode, b: Mode): Mode {
  return MODES.indexOf(a) >= MODES.indexOf(b) ? a : b
}

/**
 * A byte's class, as the crate's parser has them: the end (null), a symbol of alphanumeric mode's,
 * a digit, a capital, the first byte of a Shift JIS pair (three kinds), a second byte (two),
 * anything else. The pairs matter even though maki writes them as bytes: a capital or a digit
 * taken into one isn't the start of a run of its own.
 */
function cls(c: number | null): number {
  if (c === null) return 0
  if ([0x20, 0x24, 0x25, 0x2a, 0x2b, 0x2d, 0x2e, 0x2f, 0x3a].includes(c)) return 1
  if (c >= 0x30 && c <= 0x39) return 2
  if (c >= 0x41 && c <= 0x5a) return 3
  if (c >= 0x81 && c <= 0x9f) return 4
  if (c >= 0xe0 && c <= 0xea) return 5
  if (c === 0xeb) return 6
  if (c === 0x40 || (c >= 0x5b && c <= 0x7e) || c === 0x80 || (c >= 0xa0 && c <= 0xbf)) return 7
  if ((c >= 0xc0 && c <= 0xdf) || (c >= 0xec && c <= 0xfc)) return 8
  return 9
}

// the parser's states, and what a step does: nothing yet, end a segment of a mode, or end a Kanji
// segment but for its last byte, a segment of its own
const [INIT, NUM, ALPHA, BYTE, HI12, HI3, KANJI] = [0, 1, 2, 3, 4, 5, 6]
const [IDLE, END_NUM, END_ALPHA, END_BYTE, END_KANJI, KANJI_AND_BYTE] = [0, 1, 2, 3, 4, 5]
type Step = [number, number]

/** Its next state and what it does, by state (a row) and the next byte's class (a column). */
const STEP: Step[][] = [
  // a row each, by state; in each, the next byte's class: end, symbol, digit, capital, hi1, hi2,
  // hi3, lo1, lo2, byte
  // from the start
  [
    [INIT, IDLE],
    [ALPHA, IDLE],
    [NUM, IDLE],
    [ALPHA, IDLE],
    [HI12, IDLE],
    [HI12, IDLE],
    [HI3, IDLE],
    [BYTE, IDLE],
    [BYTE, IDLE],
    [BYTE, IDLE]
  ],
  // in digits
  [
    [INIT, END_NUM],
    [ALPHA, END_NUM],
    [NUM, IDLE],
    [ALPHA, END_NUM],
    [HI12, END_NUM],
    [HI12, END_NUM],
    [HI3, END_NUM],
    [BYTE, END_NUM],
    [BYTE, END_NUM],
    [BYTE, END_NUM]
  ],
  // in capitals, digits and symbols
  [
    [INIT, END_ALPHA],
    [ALPHA, IDLE],
    [NUM, END_ALPHA],
    [ALPHA, IDLE],
    [HI12, END_ALPHA],
    [HI12, END_ALPHA],
    [HI3, END_ALPHA],
    [BYTE, END_ALPHA],
    [BYTE, END_ALPHA],
    [BYTE, END_ALPHA]
  ],
  // in bytes
  [
    [INIT, END_BYTE],
    [ALPHA, END_BYTE],
    [NUM, END_BYTE],
    [ALPHA, END_BYTE],
    [HI12, END_BYTE],
    [HI12, END_BYTE],
    [HI3, END_BYTE],
    [BYTE, IDLE],
    [BYTE, IDLE],
    [BYTE, IDLE]
  ],
  // after a first byte of Shift JIS (hi1, hi2)
  [
    [INIT, KANJI_AND_BYTE],
    [ALPHA, KANJI_AND_BYTE],
    [NUM, KANJI_AND_BYTE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [BYTE, KANJI_AND_BYTE]
  ],
  // after hi3
  [
    [INIT, KANJI_AND_BYTE],
    [ALPHA, KANJI_AND_BYTE],
    [NUM, KANJI_AND_BYTE],
    [KANJI, IDLE],
    [KANJI, IDLE],
    [HI12, KANJI_AND_BYTE],
    [HI3, KANJI_AND_BYTE],
    [KANJI, IDLE],
    [BYTE, KANJI_AND_BYTE],
    [BYTE, KANJI_AND_BYTE]
  ],
  // in Kanji pairs
  [
    [INIT, END_KANJI],
    [ALPHA, END_KANJI],
    [NUM, END_KANJI],
    [ALPHA, END_KANJI],
    [HI12, IDLE],
    [HI12, IDLE],
    [HI3, IDLE],
    [BYTE, END_KANJI],
    [BYTE, END_KANJI],
    [BYTE, END_KANJI]
  ]
]

interface Segment {
  mode: Mode
  begin: number
  end: number
}

/**
 * The segments the crate's parser cuts `data` into, each of one class of characters; Kanji pairs
 * as bytes, as maki writes them.
 */
function parse(data: Uint8Array): Segment[] {
  const out: Segment[] = []
  let state = INIT
  let begin = 0
  for (let i = 0; i <= data.length; i++) {
    const [next, action] = STEP[state][cls(i < data.length ? data[i] : null)]
    state = next
    if (action === IDLE) continue
    if (action === KANJI_AND_BYTE && begin !== i - 1) {
      // the pairs so far, then the byte after them on its own
      out.push({ mode: 'byte', begin, end: i - 1 }, { mode: 'byte', begin: i - 1, end: i })
    } else {
      const mode: Mode =
        action === END_NUM ? 'numeric' : action === END_ALPHA ? 'alphanumeric' : 'byte'
      out.push({ mode, begin, end: i })
    }
    begin = i
  }
  return out
}

/** The parser's segments joined left to right while joining takes no more bits, as the crate does. */
function optimize(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  let last = segments[0]
  if (!last) return out
  for (const s of segments.slice(1)) {
    const joined: Segment = { mode: max(last.mode, s.mode), begin: last.begin, end: s.end }
    const size = (g: Segment): number => bits(g.mode, g.end - g.begin)
    if (size(last) + size(s) >= size(joined)) last = joined
    else {
      out.push(last)
      last = s
    }
  }
  out.push(last)
  return out
}

/** Data bits each version from 1 to 9 holds, at the lowest error correction. */
const HOLDS = [152, 272, 440, 640, 864, 1088, 1248, 1552, 1856]

/** The version of maki's QR code for `data`, as maki makes it: null for one past 9, more than maki's screen shows. */
export function qrVersion(data: Uint8Array): number | null {
  const total = optimize(parse(data)).reduce((n, s) => n + bits(s.mode, s.end - s.begin), 0)
  const v = HOLDS.findIndex((holds) => holds >= total)
  return v < 0 ? null : v + 1
}

/** How big maki draws a version's modules on its screen, in pixels. */
export function moduleSize(version: number): number {
  return Math.floor(SCREEN / (17 + 4 * version + 2 * QUIET))
}

export type ShowCheck =
  | { ok: true; version: number; pixels: number; bytes: number }
  /** why not: the app's answer to it (`TOO_LONG`, `NOT_TEXT`), and in words */
  | { ok: false; code: number; why: string }

/** Whether maki's Show QR app shows `text`, and how big; or why not, in words. */
export function showCheck(text: string): ShowCheck {
  const data = new TextEncoder().encode(text)
  const tooLong = {
    ok: false,
    code: TOO_LONG,
    why: `too long for a QR code on maki’s screen: ${data.length} bytes, where it holds 192 (279 if it’s all capitals, digits, spaces and $%*+-./:, or 461 digits)`
  } as const
  // in the order the app checks: its most bytes, then what's text, then the code
  if (data.length > MOST) return tooLong
  // nothing but what Rust's trim takes off (Unicode's White_Space)
  if (/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(text))
    return { ok: false, code: NOT_TEXT, why: 'there’s nothing to show' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text))
    return {
      ok: false,
      code: NOT_TEXT,
      why: 'maki shows text and new lines: not tabs, carriage returns or other control characters'
    }
  const version = qrVersion(data)
  if (version === null || version > MAX_VERSION) return tooLong
  return { ok: true, version, pixels: moduleSize(version), bytes: data.length }
}

/** The app's `S` message: show this, and keep it. */
export function showMessage(text: string): Uint8Array {
  const data = new TextEncoder().encode(text)
  const m = new Uint8Array(1 + data.length)
  m[0] = 'S'.charCodeAt(0)
  m.set(data, 1)
  return m
}

/** What the app's answer to `S` says, in words: null if it shows it. */
export function showSays(answer: Uint8Array): string | null {
  if (answer.length !== 1) return 'maki’s Show QR app answered oddly'
  switch (answer[0]) {
    case SHOWN:
      return null
    case TOO_LONG:
      return 'too long for a QR code on maki’s screen'
    case NOT_TEXT:
      return 'that isn’t text maki shows'
    default:
      return 'maki’s Show QR app didn’t take it'
  }
}

/** What the app says it's showing, in its answer to `?`: null if it isn't one. */
export function shownText(answer: Uint8Array): string | null {
  if (answer[0] !== 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(answer.subarray(1))
  } catch {
    return null
  }
}
