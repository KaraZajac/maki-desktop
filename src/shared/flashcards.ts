/**
 * maki's Flashcards app (sdk/examples/flashcards): decks studied on maki a card at a time, with
 * Leitner's boxes. maki desktop reads a deck from a CSV or tab-separated file, pasted text, or Anki's
 * plain text export; says what maki will make of it before it's sent; sends it in pieces; and lists
 * and removes the decks on maki.
 *
 * What maki draws: its fonts (libs/blitstr2, all five alike, as maki-wasm draws them) have printable
 * ASCII, Latin-1 (U+00A0 to U+00FF), Œ and œ, the quotes, daggers and bullet from U+2018 to U+2022,
 * the ellipsis and the euro sign; anything else shows as a box with a question mark. So each card is
 * fitted to them before it's sent: a character with a stand-in maki draws is changed to it (an
 * accent maki's fonts lack dropped, a dash or an arrow written as ASCII, a ligature spelled out),
 * and a card with a character that has none (Greek, Cyrillic, Chinese, an emoji) is left out. The
 * owner sees both, with the cards left out, before anything is sent.
 *
 * Anki's plain text export (Anki 2.1.54 on, rslib/src/import_export/text/csv): `#key:value` lines
 * first (`#separator:tab`, `#html:true`, and for notes `#guid column:`, `#notetype column:`, `#deck
 * column:` and `#tags column:`, numbered from 1; Anki takes `#deck:`, `#columns:` and others too),
 * then a line a card (Cards in Plain Text: its question and answer) or a note (Notes in Plain Text:
 * its fields), separated as `#separator` says, quoted as CSV is where a field holds the separator, a
 * quote or a line break. Lines starting with `#` are comments. With `#html:true` the fields are
 * HTML: line breaks are kept, and other tags and media taken out. A note's cloze deletions are made
 * into a card each, as Anki makes them.
 *
 * The app's messages, numbers little-endian, each starting with their version (1) and a letter:
 * `L` the decks; `U` a deck in pieces, in place of deck `target` or (0) as a new one: the target, the
 * deck's length (u32), where the piece goes (u32), then the piece, up to 4085 bytes; `D` a deck's ID,
 * removed. A deck is its name (a byte's length, then UTF-8), how many cards (u16), then each card's
 * front and back, each a u16's length and UTF-8. Answers start with 0 done (for `U`'s last piece the
 * deck's ID, its cards and how many kept their progress follow; for `L`, the list), 4 not taken (why
 * follows), 5 no room (why follows), 6 a piece taken (how much of the deck the app has, u32), 7 no
 * such deck, 8 another deck has that name, 9 another version (the one it speaks).
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */

export const FLASHCARDS_APP = 'com.leviathan.maki.flashcards'
/** The version of the app's messages, which this speaks. */
export const FLASHCARDS_VERSION = 1

/** The app's limits: decks, cards a deck, characters in a name, a front, a back. */
export const MAX_DECKS = 8
export const MAX_CARDS = 1000
export const MAX_NAME = 32
export const MAX_FRONT = 200
export const MAX_BACK = 500
/** The app's room on maki, which its decks and their progress share; a deck is no longer. */
export const ROOM = 64 * 1024
/** A message's most bytes, and how many of them a piece's header takes. */
const MESSAGE = 4096
export const PIECE = MESSAGE - 11
/** maki's most for a stored value: a deck's cards are kept in values of up to this. */
const VALUE = 16 * 1024

const OK = 0
const BAD = 4
const FULL = 5
const MORE = 6
const NOT_FOUND = 7
const EXISTS = 8
const OTHER_VERSION = 9

/** A card: its front and back. */
export interface Card {
  front: string
  back: string
}

// ---- what maki's fonts draw

/** Whether maki's fonts draw `c`, a character (one code point). */
export function drawable(c: string): boolean {
  const n = c.codePointAt(0) ?? 0
  return (
    (n >= 0x20 && n <= 0x7e) ||
    (n >= 0xa0 && n <= 0xff && n !== 0xad) ||
    n === 0x152 ||
    n === 0x153 ||
    (n >= 0x2018 && n <= 0x2022) ||
    n === 0x2026 ||
    n === 0x20ac
  )
}

/**
 * What maki draws for a character it doesn't, where something it does means the same: dashes and
 * the minus sign as hyphens, spaces as a space, what's invisible as nothing (the soft hyphen too,
 * which maki's fonts would draw), arrows and comparisons as ASCII, superscripts with a caret and
 * subscripts as digits (H₂O as H2O), and letters with no accent to drop as the letter they're
 * written with.
 */
const STAND_INS: Record<string, string> = {
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2043': '-',
  '\u2212': '-',
  '\u2032': "'",
  '\u2033': '"',
  '\u2035': "'",
  '\u2039': '<',
  '\u203a': '>',
  '\u2044': '/',
  '\u2215': '/',
  '\u2217': '*',
  '\u2027': '\u00b7',
  '\u2190': '<-',
  '\u2192': '->',
  '\u2194': '<->',
  '\u21d0': '<=',
  '\u21d2': '=>',
  '\u21d4': '<=>',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2260': '!=',
  '\u2248': '~',
  '\u00ad': '',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\u200e': '',
  '\u200f': '',
  '\u2060': '',
  '\ufeff': '',
  '\u2070': '^0',
  '\u2071': '^i',
  '\u2074': '^4',
  '\u2075': '^5',
  '\u2076': '^6',
  '\u2077': '^7',
  '\u2078': '^8',
  '\u2079': '^9',
  '\u207a': '^+',
  '\u207b': '^-',
  '\u207f': '^n',
  '\u0142': 'l',
  '\u0141': 'L',
  '\u0111': 'd',
  '\u0110': 'D',
  '\u0127': 'h',
  '\u0126': 'H',
  '\u0131': 'i',
  '\u0167': 't',
  '\u0166': 'T',
  '\u017f': 's',
  '\u0192': 'f'
}
for (let c = 0x2000; c <= 0x200a; c++) STAND_INS[String.fromCodePoint(c)] = ' '
for (const c of [0x202f, 0x205f, 0x3000]) STAND_INS[String.fromCodePoint(c)] = ' '
for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
  STAND_INS[String.fromCodePoint(c)] = ''
for (let d = 0; d <= 9; d++) STAND_INS[String.fromCodePoint(0x2080 + d)] = String(d)

/**
 * A stand-in maki draws for `c`, a character its fonts don't; null if there's none. The table's
 * first; then what Unicode makes of it as a compatibility character (a ligature spelled out, a
 * full-width letter, ℃ as °C, ⅓ as 1/3); then, for a letter with marks maki's fonts lack, the most
 * of its marks that still make a letter they draw (ǖ as ü, ệ as ê, ą as a).
 */
export function standIn(c: string): string | null {
  if (c in STAND_INS) return STAND_INS[c]
  const each = (s: string): string | null => {
    const out = [...s].map((x) => (drawable(x) ? x : (STAND_INS[x] ?? null)))
    return out.every((x) => x !== null) ? out.join('') : null
  }
  const compatible = c.normalize('NFKC')
  if (compatible !== c) {
    const s = each(compatible)
    if (s !== null) return s
  }
  const [base, ...marks] = [...c.normalize('NFD')]
  if (marks.length === 0 || !marks.every((m) => /\p{M}/u.test(m))) return null
  // the marks kept, most first: every choice of them, as there are three at most
  const choices: string[][] = []
  for (let mask = (1 << marks.length) - 2; mask >= 0; mask--)
    choices.push(marks.filter((_, i) => mask & (1 << i)))
  choices.sort((a, b) => b.length - a.length)
  for (const kept of choices) {
    const letter = (base + kept.join('')).normalize('NFC')
    if ([...letter].every(drawable)) return letter
  }
  return null
}

/** Rust's White_Space, which the app's `trim` takes off. */
const SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g
const trim = (s: string): string => s.replace(SPACE, '')

/** What fitting text to maki's fonts changed, and what it couldn't. */
interface Fitted {
  text: string
  /** each character changed, what to, and how many times */
  changed: Map<string, { to: string; times: number }>
  /** characters with no stand-in, which maki would draw as a box */
  undrawable: Set<string>
}

/**
 * `text` as maki takes it and its fonts draw it: Unicode's composed forms (NFC), line breaks as new
 * lines (`lines`) or spaces, tabs as spaces, other control characters taken out, each character
 * maki's fonts lack changed to a stand-in where there is one, and the ends trimmed.
 */
function fit(text: string, lines: boolean): Fitted {
  const changed = new Map<string, { to: string; times: number }>()
  const undrawable = new Set<string>()
  const breaks = text
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/\n/g, lines ? '\n' : ' ')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  let out = ''
  for (const c of breaks) {
    if (c === '\n' || drawable(c)) {
      out += c
      continue
    }
    const s = standIn(c)
    if (s === null) {
      undrawable.add(c)
      out += c
    } else {
      changed.set(c, { to: s, times: (changed.get(c)?.times ?? 0) + 1 })
      out += s
    }
  }
  return { text: trim(out), changed, undrawable }
}

/** How many characters `s` is, as maki counts them (code points). */
export const chars = (s: string): number => [...s].length

// ---- reading a deck from a file or pasted text

export type Separator = 'tab' | 'comma' | 'semicolon' | 'pipe' | 'colon' | 'space'

const SEPARATORS: Record<Separator, string> = {
  tab: '\t',
  comma: ',',
  semicolon: ';',
  pipe: '|',
  colon: ':',
  space: ' '
}

/** A deck as read from a file or pasted text, before it's fitted to maki. */
export interface Read {
  /** its cards, with the line of the file each starts on */
  cards: (Card & { line: number })[]
  /** lines that aren't a card, and why: a single field, nothing for a side */
  skipped: { line: number; why: string }[]
  /** the separator its fields are separated by */
  separator: Separator
  /** whether its fields were taken as HTML, and why: Anki's header, or what's in them */
  html: false | 'header' | 'guessed'
  /** what the file names the deck (Anki's `#deck:`), if it does */
  name: string | null
  /** the decks a notes export's deck column names, with how many notes each, if it has one */
  decks: { name: string; notes: number }[]
  /** what else was made of it, for the owner to read */
  notes: string[]
}

/** What `readDeck` may be told: the separator, and which of a file's decks to take. */
export interface ReadOptions {
  separator?: Separator
  deck?: string
}

/**
 * The text of a file, as it's written: UTF-8 (with or without its byte order mark), UTF-16 (by its
 * byte order mark), else Windows-1252, which spreadsheets on Windows save CSV files in.
 */
export function decodeFile(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }
  }
}

/** Fields and the line each record starts on, as CSV quotes them (RFC 4180, as Anki writes them). */
function records(text: string, sep: string): { fields: string[]; line: number; quoted: boolean }[] {
  const out: { fields: string[]; line: number; quoted: boolean }[] = []
  let fields: string[] = []
  let field = ''
  let line = 1
  let start = 1
  let quoted = false
  let first = true
  let i = 0
  const end = (): void => {
    fields.push(field)
    field = ''
    first = true
  }
  while (i < text.length) {
    const c = text[i]
    if (first && c === '"') {
      // a quoted field: to its closing quote, a doubled quote standing for one
      first = false
      if (fields.length === 0) quoted = true
      i++
      for (;;) {
        if (i >= text.length) break
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        if (text[i] === '\n') line++
        field += text[i++]
      }
      continue
    }
    first = false
    if (c === sep) {
      end()
      i++
    } else if (c === '\r' || c === '\n') {
      end()
      out.push({ fields, line: start, quoted })
      fields = []
      quoted = false
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      line++
      start = line
    } else {
      field += c
      i++
    }
  }
  if (field !== '' || fields.length > 0) {
    end()
    out.push({ fields, line: start, quoted })
  }
  return out
}

/**
 * A separator by its name or itself, as Anki's `#separator:` takes it: a name, whatever follows it
 * (Anki's header can come back with separators after it, read as a line of fields), or a character.
 */
function separatorOf(value: string): Separator | null {
  const word = /^\s*([a-z]+)/i.exec(value)?.[1].toLowerCase()
  if (word !== undefined && word in SEPARATORS) return word as Separator
  for (const [name, c] of Object.entries(SEPARATORS)) if (value[0] === c) return name as Separator
  return null
}

/**
 * The separator a file without Anki's header most likely has: a tab if a line has one (spreadsheets
 * and Anki write tabs, and text rarely has them), else whichever of comma, semicolon and pipe most of
 * its first lines have outside quotes.
 */
function guessSeparator(lines: string[]): Separator {
  const sample = lines.filter((l) => l.trim() !== '' && !l.startsWith('#')).slice(0, 30)
  if (sample.some((l) => l.includes('\t'))) return 'tab'
  let best: Separator = 'comma'
  let most = 0
  for (const s of ['comma', 'semicolon', 'pipe'] as const) {
    const n = sample.filter((l) => l.replace(/"[^"]*"/g, '').includes(SEPARATORS[s])).length
    if (n > most) {
      best = s
      most = n
    }
  }
  return best
}

/** Names of a heading line, which isn't a card: a front's and a back's, in lower case. */
const HEADINGS = [
  ['front', 'back'],
  ['question', 'answer'],
  ['term', 'definition'],
  ['word', 'meaning'],
  ['word', 'translation'],
  ['prompt', 'response'],
  ['q', 'a'],
  ['side 1', 'side 2'],
  ['side a', 'side b']
]

/** What looks like HTML, as Anki's editor writes it. */
const HTML_LIKE =
  /<(br|div|p|b|i|u|span|img|ul|ol|li|sup|sub|font)\b[^>]*>|<\/(div|p|b|i|u|span|li|ul|ol)>|&(nbsp|amp|lt|gt|quot);|\[sound:[^\]]+\]/i

/** HTML's named characters, those Anki's editor and exports write. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  dagger: '\u2020',
  Dagger: '\u2021',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  minus: '\u2212',
  sect: '\u00a7',
  para: '\u00b6',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  shy: '\u00ad',
  larr: '\u2190',
  rarr: '\u2192',
  harr: '\u2194',
  rArr: '\u21d2',
  lArr: '\u21d0',
  hArr: '\u21d4',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  asymp: '\u2248',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup1: '\u00b9',
  sup2: '\u00b2',
  sup3: '\u00b3',
  micro: '\u00b5',
  szlig: '\u00df',
  OElig: '\u0152',
  oelig: '\u0153'
}
// HTML 4's Latin-1 letters: Agrave to yuml, by name
const LATIN1 =
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
LATIN1.split(' ').forEach((name, i) => (ENTITIES[name] ??= String.fromCodePoint(0xc0 + i)))

/** HTML's character references in `s` decoded: named ones Anki writes, and numbered ones. */
function entities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const n =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : whole
    }
    return ENTITIES[ref] ?? whole
  })
}

/** What taking HTML out found, beyond tags: media, which maki doesn't show. */
interface Media {
  sounds: number
  pictures: number
}

/**
 * A field's HTML as text, as maki shows it: a line break for each `<br>`, and where a block (a
 * `<div>`, a paragraph, an item of a list, which gets a bullet) starts; HTML's spaces made one;
 * sounds, pictures and other tags taken out; characters decoded.
 */
function htmlText(html: string, media: Media): string {
  return entities(
    html
      .replace(/<!--[\s\S]*?-->|<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/\[sound:[^\]]*\]/gi, () => {
        media.sounds++
        return ''
      })
      .replace(/<img\b[^>]*>/gi, () => {
        media.pictures++
        return ''
      })
      .replace(/[\s]+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n\u2022 ')
      .replace(/<(div|p|h[1-6]|ul|ol|blockquote|pre|tr|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \u00a0]*\n[ \u00a0]*/g, '\n')
    .replace(/ {2,}/g, ' ')
}

/**
 * A note's field with cloze deletions (`{{c1::answer::hint}}`), as the cards Anki makes of it, one
 * for each number: that deletion hidden on the front, as `[hint]` or `[...]`, and every one shown on
 * the back. Null if it hasn't any.
 */
function clozes(text: string): Card[] | null {
  const deletion = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g
  const numbers = [...new Set([...text.matchAll(deletion)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b
  )
  if (numbers.length === 0) return null
  const back = text.replace(deletion, (_, _n, answer: string) => answer)
  return numbers.map((n) => ({
    front: text.replace(deletion, (_, m: string, answer: string, hint?: string) =>
      Number(m) === n ? `[${hint ?? '...'}]` : answer
    ),
    back
  }))
}

/**
 * A deck from `text`: a CSV or tab-separated file, pasted text, or Anki's plain text export (its
 * header read as Anki reads it); a card a line, its front and back the first two fields that aren't
 * Anki's own columns (a note's ID, type, deck and tags).
 */
export function readDeck(text: string, options: ReadOptions = {}): Read {
  const notes: string[] = []
  const all = text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)
  // Anki's header: #key:value lines at the top (or, before 2.1.54, a first line of tags)
  let separator: Separator | null = null
  let html: Read['html'] = false
  let htmlSaid: boolean | null = null
  let name: string | null = null
  const special = new Map<number, string>()
  let headerLines = 0
  let anki = false
  for (const line of all) {
    if (headerLines === 0 && line.startsWith('tags:')) {
      headerLines++
      continue
    }
    const m = /^#([^:]+):(.*)$/.exec(line)
    if (!line.startsWith('#')) break
    headerLines++
    if (!m) continue
    const key = m[1].trim().toLowerCase()
    const value = m[2]
    anki ||= /^(separator|html|tags|columns|notetype|deck|(guid|notetype|deck|tags) column)$/.test(
      key
    )
    if (key === 'separator') separator = separatorOf(value) ?? separator
    else if (key === 'html')
      htmlSaid = /^\s*true/i.test(value) ? true : /^\s*false/i.test(value) ? false : htmlSaid
    else if (key === 'deck' && value.trim() !== '') name = value.trim()
    else if (/^(guid|notetype|deck|tags) column$/.test(key)) {
      const n = parseInt(value.trim(), 10)
      if (n > 0) special.set(n - 1, key.replace(' column', ''))
    }
  }
  if (anki) notes.push('Read as Anki’s plain text export, by its header.')
  const body = all.slice(headerLines).join('\n')
  const sepName = options.separator ?? separator ?? guessSeparator(all.slice(headerLines))
  const sep = SEPARATORS[sepName]
  const rows = records(body, sep)
    .map((r) => ({ ...r, line: r.line + headerLines }))
    // comments, as Anki takes them; and blank lines
    .filter((r) => !(r.fields[0].startsWith('#') && !r.quoted))
    .filter((r) => r.fields.some((f) => f.trim() !== ''))
  if (htmlSaid === true) html = 'header'
  else if (htmlSaid === null && rows.some((r) => r.fields.some((f) => HTML_LIKE.test(f)))) {
    html = 'guessed'
    notes.push('Its fields look like HTML, as Anki writes them: their tags are taken out.')
  }
  // a notes export's decks, and the one to take
  const deckColumn = [...special].find(([, kind]) => kind === 'deck')?.[0]
  const decks: Read['decks'] = []
  if (deckColumn !== undefined) {
    for (const r of rows) {
      const d = r.fields[deckColumn] ?? ''
      const seen = decks.find((x) => x.name === d)
      if (seen) seen.notes++
      else decks.push({ name: d, notes: 1 })
    }
  }
  const wanted = deckColumn === undefined ? null : (options.deck ?? decks[0]?.name ?? null)
  const regular = (fields: string[]): string[] => fields.filter((_, i) => !special.has(i))
  const media: Media = { sounds: 0, pictures: 0 }
  let extra = 0
  let clozed = 0
  const cards: Read['cards'] = []
  const skipped: Read['skipped'] = []
  rows.forEach((r, i) => {
    if (wanted !== null && r.fields[deckColumn as number] !== wanted) return
    const fields = regular(r.fields)
    // a heading line: the columns' names, not a card
    if (i === 0 && headerLines === 0 && fields.length >= 2) {
      const pair = [fields[0], fields[1]].map((f) => f.trim().toLowerCase())
      if (HEADINGS.some(([a, b]) => pair[0] === a && pair[1] === b)) {
        notes.push(
          `The first line, “${fields[0].trim()}, ${fields[1].trim()}”, names the columns: it isn’t a card.`
        )
        return
      }
    }
    extra = Math.max(extra, fields.length - 2)
    const side = (f: string): string => (html ? htmlText(f, media) : f)
    const front = side(fields[0] ?? '')
    const back = side(fields[1] ?? '')
    const made = clozes(front)
    if (made) {
      clozed++
      for (const c of made)
        cards.push({
          front: c.front,
          back: trim(back) === '' ? c.back : `${c.back}\n\n${back}`,
          line: r.line
        })
    } else if (fields.length < 2) {
      skipped.push({ line: r.line, why: 'it has one field: no back' })
    } else {
      cards.push({ front, back, line: r.line })
    }
  })
  if (wanted !== null && decks.length > 1)
    notes.push(
      `It has ${decks.length} decks: this is ${wanted === '' ? 'the one with no name' : wanted}.`
    )
  if (extra > 0)
    notes.push(
      `Its ${extra === 1 ? 'third column isn’t' : `columns after the second aren’t`} sent: a card on maki has a front and a back.`
    )
  if (clozed > 0)
    notes.push(
      `Cloze deletions made into a card for each, as Anki makes them (${count(clozed, 'note')}).`
    )
  const media_ = [
    media.sounds > 0 ? count(media.sounds, 'sound') : '',
    media.pictures > 0 ? count(media.pictures, 'picture') : ''
  ].filter((s) => s !== '')
  if (media_.length > 0)
    notes.push(
      `maki shows text: ${media_.join(' and ')} in it ${media.sounds + media.pictures === 1 ? 'isn’t' : 'aren’t'} sent.`
    )
  return { cards, skipped, separator: sepName, html, name, decks, notes }
}

// ---- a deck fitted to maki

/** A deck as maki will have it, and what was made of it on the way. */
export interface Prepared {
  name: string
  /** why the name won't do, if it won't */
  nameProblem: string | null
  /** the cards, fitted to maki */
  cards: Card[]
  /** characters changed to what maki draws, each with how many times */
  changed: { from: string; to: string; times: number }[]
  /** cards left out, with the line each was on and why */
  left: { line: number; card: Card; why: string }[]
  /** characters maki can't draw, which left cards out */
  undrawable: string[]
  /** the deck's bytes on the link */
  bytes: number
  /** why it can't be sent at all, if it can't */
  problem: string | null
}

/**
 * A deck named `name` of `cards` as maki will take it, each side fitted to maki's fonts (`fit`):
 * a card left out if a side is empty, too long, or has a character maki can't draw.
 */
export function prepareDeck(name: string, cards: (Card & { line?: number })[]): Prepared {
  const changed = new Map<string, { to: string; times: number }>()
  const note = (f: Fitted): void => {
    for (const [from, { to, times }] of f.changed)
      changed.set(from, { to, times: (changed.get(from)?.times ?? 0) + times })
  }
  const undrawable = new Set<string>()
  const kept: Card[] = []
  const left: Prepared['left'] = []
  cards.forEach((c, i) => {
    const line = c.line ?? i + 1
    const front = fit(c.front, true)
    const back = fit(c.back, true)
    const cannot = new Set([...front.undrawable, ...back.undrawable])
    const card = { front: front.text, back: back.text }
    const why =
      cannot.size > 0
        ? `maki can’t draw ${[...cannot].join(' ')}`
        : card.front === ''
          ? 'it has no front'
          : card.back === ''
            ? 'it has no back'
            : chars(card.front) > MAX_FRONT
              ? `its front is longer than ${MAX_FRONT} characters`
              : chars(card.back) > MAX_BACK
                ? `its back is longer than ${MAX_BACK} characters`
                : null
    if (why === null) {
      note(front)
      note(back)
      kept.push(card)
    } else {
      for (const x of cannot) undrawable.add(x)
      left.push({ line, card: { front: c.front, back: c.back }, why })
    }
  })
  const n = fit(name, false)
  note(n)
  const nameProblem =
    n.undrawable.size > 0
      ? `maki can’t draw ${[...n.undrawable].join(' ')} in a name`
      : n.text === ''
        ? 'it needs a name'
        : chars(n.text) > MAX_NAME
          ? `a name is ${MAX_NAME} characters at most`
          : null
  const bytes = deckBytes(n.text, kept).length
  const problem =
    kept.length === 0
      ? cards.length === 0
        ? 'there are no cards in it'
        : 'none of its cards can be sent'
      : kept.length > MAX_CARDS
        ? `maki keeps ${MAX_CARDS} cards a deck, and this has ${kept.length}: send it as two decks or more`
        : bytes > ROOM
          ? `it’s ${kib(bytes)}, and a deck is ${kib(ROOM)} at most`
          : null
  return {
    name: n.text,
    nameProblem,
    cards: kept,
    changed: [...changed].map(([from, { to, times }]) => ({ from, to, times })),
    left,
    undrawable: [...undrawable],
    bytes,
    problem
  }
}

/** `n` and a noun for it: "1 card", "3 cards". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Bytes as maki's screens have them: KiB, to a tenth below 10. */
export function kib(n: number): string {
  const tenths = Math.floor((n * 10 + 512) / 1024)
  return tenths < 100 && tenths % 10 !== 0
    ? `${Math.floor(tenths / 10)}.${tenths % 10} KiB`
    : `${Math.floor((tenths + 5) / 10)} KiB`
}

// ---- the app's messages

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

function u16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff)
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

/** A deck as the link carries it: its name, how many cards, then each card's front and back. */
export function deckBytes(name: string, cards: Card[]): Uint8Array {
  const n = utf8(name)
  const parts = [Uint8Array.of(n.length & 0xff), n, u16(cards.length)]
  for (const c of cards)
    for (const side of [c.front, c.back]) {
      const b = utf8(side)
      parts.push(u16(b.length), b)
    }
  return concat(parts)
}

/** `deck` sent in place of deck `target` (0: as a new one), in as few messages as it takes. */
export function uploadMessages(target: number, deck: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let at = 0; at < deck.length; at += PIECE) {
    const piece = deck.subarray(at, at + PIECE)
    const m = new Uint8Array(11 + piece.length)
    const v = new DataView(m.buffer)
    m.set([FLASHCARDS_VERSION, 'U'.charCodeAt(0), target])
    v.setUint32(3, deck.length, true)
    v.setUint32(7, at, true)
    m.set(piece, 11)
    out.push(m)
  }
  return out
}

/** `L`: the decks. */
export function listMessage(): Uint8Array {
  return Uint8Array.of(FLASHCARDS_VERSION, 'L'.charCodeAt(0))
}

/** `D`: deck `id` removed, with its progress. */
export function removeMessage(id: number): Uint8Array {
  return Uint8Array.of(FLASHCARDS_VERSION, 'D'.charCodeAt(0), id)
}

/** A deck on maki, as the app lists it. */
export interface DeckOnMaki {
  id: number
  name: string
  cards: number
  /** cards not seen yet, those due today, and those a sitting would hold today */
  new: number
  due: number
  study: number
  /** what it takes of the app's room */
  size: number
  /** how many cards are in each of Leitner's boxes, 1 to 7 */
  boxes: number[]
}

/** The decks on maki, and the day as the app has it. */
export interface Listing {
  /** days since 1970, and whether maki knows it (if not, the last day it knew) */
  today: number
  known: boolean
  /** the days in a row studied, and how many new cards a deck brings in a day */
  streak: number
  newADay: number
  /** the app's room, and what's used of it */
  used: number
  room: number
  decks: DeckOnMaki[]
}

/** The app's answer to `L`, read strictly; null if it isn't one. */
export function readList(a: Uint8Array): Listing | null {
  if (a.length < 18 || a[0] !== OK || a[1] !== FLASHCARDS_VERSION || a[4] > 1) return null
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength)
  const listing: Listing = {
    today: v.getUint16(2, true),
    known: a[4] === 1,
    streak: v.getUint16(5, true),
    newADay: v.getUint16(7, true),
    used: v.getUint32(9, true),
    room: v.getUint32(13, true),
    decks: []
  }
  let at = 18
  for (let i = 0; i < a[17]; i++) {
    if (at + 2 > a.length) return null
    const [id, len] = [a[at], a[at + 1]]
    if (at + 2 + len + 26 > a.length) return null
    let name: string
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(a.subarray(at + 2, at + 2 + len))
    } catch {
      return null
    }
    at += 2 + len
    const n = (k: number): number => v.getUint16(at + 2 * k, true)
    listing.decks.push({
      id,
      name,
      cards: n(0),
      new: n(1),
      due: n(2),
      study: n(3),
      size: v.getUint32(at + 8, true),
      boxes: [0, 1, 2, 3, 4, 5, 6].map((b) => n(6 + b))
    })
    at += 26
  }
  return at === a.length ? listing : null
}

/** What the app's answer says, in words: null if it's done. */
export function flashcardsSays(a: Uint8Array): string | null {
  const why = new TextDecoder().decode(a.subarray(1))
  switch (a[0]) {
    case OK:
      return null
    case BAD:
      return `maki’s Flashcards app didn’t take it: ${why}`
    case FULL:
      return `no room on maki: ${why}`
    case NOT_FOUND:
      return 'that deck isn’t on maki any more'
    case EXISTS:
      return 'another deck on maki has that name'
    case OTHER_VERSION:
      return `maki’s Flashcards app speaks version ${a[1]} of its messages, and maki desktop ${FLASHCARDS_VERSION}: update them both`
    default:
      return 'maki’s Flashcards app answered oddly'
  }
}

/** Why a message didn't reach the app, in words, by the link's status. */
export function linkSays(status: string): string {
  switch (status) {
    case 'no match':
      return 'maki’s Flashcards app isn’t installed'
    case 'unavailable':
      return 'another app is open on maki: go back to its home screen, or open Flashcards there'
    case 'locked':
      return 'maki is locked'
    default:
      return `maki’s Flashcards app: ${status}`
  }
}

/** How a deck sent went: kept as deck `id`, with how many cards kept their progress; or why not. */
export type Sent =
  { ok: true; id: number; cards: number; kept: number } | { ok: false; why: string }

/** How the link sends a message to an app and gives back its answer. */
export type AppSend = (message: Uint8Array) => Promise<{ status: string; answer: Uint8Array }>

/**
 * Sends `deck` in place of deck `target` (0: as a new one), a piece at a time, each answer checked:
 * `progress` hears how many bytes the app has.
 */
export async function sendDeck(
  send: AppSend,
  target: number,
  deck: Uint8Array,
  progress?: (have: number) => void
): Promise<Sent> {
  const pieces = uploadMessages(target, deck)
  for (const [i, m] of pieces.entries()) {
    const r = await send(m)
    if (r.status !== 'approved') return { ok: false, why: linkSays(r.status) }
    const a = r.answer
    const have = Math.min(deck.length, (i + 1) * PIECE)
    if (i < pieces.length - 1) {
      if (
        a.length === 5 &&
        a[0] === MORE &&
        new DataView(a.buffer, a.byteOffset).getUint32(1, true) === have
      ) {
        progress?.(have)
        continue
      }
    } else if (a.length === 6 && a[0] === OK) {
      progress?.(have)
      const v = new DataView(a.buffer, a.byteOffset)
      return { ok: true, id: a[1], cards: v.getUint16(2, true), kept: v.getUint16(4, true) }
    }
    return { ok: false, why: flashcardsSays(a) ?? 'maki’s Flashcards app answered oddly' }
  }
  return { ok: false, why: 'there’s nothing to send' }
}

/**
 * What a deck takes of the app's room once kept, as the app counts it: its cards in values of up to
 * 16 KiB of whole cards, each under a key such as `c12a.0`; its progress, under `p12a`, 5 bytes and
 * 3 for each card; and its line in the list (with the list's own key and format byte, if it's the
 * first). For deck `id`, or, for a new one, as if its ID were three digits long: a byte or two more
 * than it may take.
 */
export function storedSize(name: string, cards: Card[], first: boolean, id = 100): number {
  const digits = String(id).length
  let total = 0
  let value = 0
  let values = 0
  for (const c of cards) {
    const record = 4 + utf8(c.front).length + utf8(c.back).length
    if (value + record > VALUE) {
      values++
      value = 0
    }
    value += record
    total += record
  }
  if (value > 0) values++
  for (let n = 0; n < values; n++) total += 3 + digits + String(n).length
  total += 2 + digits + 5 + 3 * cards.length
  return total + 6 + utf8(name).length + (first ? 6 : 0)
}
