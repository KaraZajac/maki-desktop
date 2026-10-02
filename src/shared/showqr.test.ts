/**
 * Show QR as maki desktop sends it things: maki's QR codes worked out as maki makes them (the
 * versions here are the ones maki draws, which the firmware's tests/showqr.rs measures on its
 * screen), and what the app takes; then the real app on the fake maki (maki's own app host): it
 * shows what it's sent and says what it's showing, and over hundreds of texts in many scripts and
 * sizes, and right at the edge of what fits, it takes just what `showCheck` says it will, and
 * turns the rest down for the same reason.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  moduleSize,
  qrVersion,
  showCheck,
  showMessage,
  shownText,
  SHOWQR_APP,
  showSays
} from './showqr'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const JAPANESE = '日本語のテキストです。これは長い文章です。'

/**
 * Texts and the version of maki's QR code for each, as maki draws it: the firmware's
 * tests/showqr.rs has the same, measured off the app's screen (9 is past what it shows).
 */
const VERSIONS: [string, number][] = [
  ['https://maki.netslum.io', 2],
  ['https://maki.netslum.io/docs/confirm', 3],
  ['WIFI:T:WPA;S:Café Wi-Fi;P:correct horse battery staple;;', 4],
  ['HTTPS://MAKI.NETSLUM.IO/DOCS/', 2],
  ['bitcoin:BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ?amount=0.0007', 4],
  [`x${'7'.repeat(220)}`, 5],
  [JAPANESE, 4],
  ['ΑΒΓΔΕΖΗΘ', 1],
  ['→→→ ★★★', 2],
  ['a'.repeat(192), 8],
  ['a'.repeat(193), 9],
  ['A'.repeat(279), 8],
  ['A'.repeat(280), 9],
  ['7'.repeat(461), 8],
  ['7'.repeat(462), 9],
  [`${'あ'.repeat(60)}${'x'.repeat(12)}`, 8],
  [`${'あ'.repeat(60)}${'x'.repeat(13)}`, 9],
  [`ORDER ${'1234567890'.repeat(20)} PAID`, 5],
  // ā ends in a byte Shift JIS starts a pair with: the first capital after it goes in that pair
  [`${'ā'.repeat(40)}${'B'.repeat(30)}`, 5],
  [`${'ā'.repeat(40)}${'b'.repeat(30)}`, 6]
]

describe('QR codes as maki makes them', () => {
  it('picks the version maki does, at the lowest error correction', () => {
    for (const [text, version] of VERSIONS) expect(qrVersion(enc(text)), text).toBe(version)
    expect(qrVersion(enc('a'.repeat(300)))).toBeNull()
    // and how big maki draws its modules: four pixels, down to two at version 8
    expect([1, 3, 8, 9].map(moduleSize)).toEqual([4, 3, 2, 1])
  })

  it('says what maki shows, how big, and why not', () => {
    expect(showCheck('https://maki.netslum.io')).toEqual({
      ok: true,
      version: 2,
      pixels: 3,
      bytes: 23
    })
    expect(showCheck(JAPANESE)).toEqual({ ok: true, version: 4, pixels: 2, bytes: 63 })
    const no = (t: string): number | null => {
      const c = showCheck(t)
      return c.ok ? null : c.code
    }
    expect(no('a'.repeat(193))).toBe(1)
    expect(no('a'.repeat(600))).toBe(1)
    expect(no(' \n　')).toBe(2)
    expect(no('tab\there')).toBe(2)
    expect(no('line\r\nend')).toBe(2)
    expect(no('two\nlines')).toBeNull()
    const long = showCheck('a'.repeat(193))
    expect(!long.ok && long.why).toMatch(/193 bytes, where it holds 192/)
  })

  it('sends text as the app reads it, and reads its answers', () => {
    expect(Array.from(showMessage('hi'))).toEqual([0x53, 0x68, 0x69])
    expect(showSays(Uint8Array.of(0))).toBeNull()
    expect(showSays(Uint8Array.of(1))).toMatch(/too long/)
    expect(showSays(Uint8Array.of(2))).toMatch(/isn’t text/)
    expect(showSays(Uint8Array.of(3))).toMatch(/didn’t take it/)
    expect(showSays(Uint8Array.of(0, 0))).toMatch(/oddly/)
    expect(shownText(Uint8Array.from([0, ...enc('hi')]))).toBe('hi')
    expect(shownText(Uint8Array.of(0))).toBe('')
    expect(shownText(Uint8Array.of(4))).toBeNull()
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('maki’s Show QR app on the fake maki', () => {
  let fake: ChildProcess
  let maki: MakiClient
  beforeAll(async () => {
    const f = await startFake(['--app', join(APP_FIXTURES, 'showqr.maki')])
    fake = f.proc
    maki = new MakiClient(await TcpTransport.open(f.port))
  })
  afterAll(() => fake?.kill())
  const send = async (m: Uint8Array): Promise<Uint8Array> => {
    const r = await maki.appMessage(SHOWQR_APP, m)
    expect(r.status).toBe('approved')
    return r.answer
  }
  const answerTo = async (text: string): Promise<number[]> =>
    Array.from(await send(showMessage(text)))
  const expected = (text: string): number[] => {
    const c = showCheck(text)
    return [c.ok ? 0 : c.code]
  }

  // what texts are made of: digits and capitals in runs of many lengths, bytes of one to four a
  // character (`ā` ends in a byte Shift JIS would start a pair with), spaces and new lines
  const pieces = [
    'hello ',
    'Wi-Fi',
    '42',
    '1234567890',
    '7777777',
    'HELLO WORLD ',
    'QR-CODE:',
    '$%*+-./:',
    'https://',
    '.com/',
    JAPANESE.slice(0, 6),
    '中文测试',
    '한국어',
    'ПРИВЕТ ',
    'привет ',
    'ΑΒΓΔΕ',
    '→★',
    'ā',
    'āB',
    '\u{1f600}',
    '€',
    '“q”',
    'ß',
    ' ',
    '\n',
    'x'
  ]
  let seed = 7
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return Math.floor(seed / 65536) % n
  }

  it('shows what it’s sent, and says what it’s showing', async () => {
    const link = 'https://maki.netslum.io'
    expect(showSays(await send(showMessage(link)))).toBeNull()
    expect(shownText(await send(Uint8Array.of(0x3f)))).toBe(link)
    // what it turns down leaves it showing what it was
    expect(showSays(await send(showMessage('a'.repeat(300))))).toMatch(/too long/)
    expect(shownText(await send(Uint8Array.of(0x3f)))).toBe(link)
    // text in any script, as it was sent
    expect(showSays(await send(showMessage(JAPANESE)))).toBeNull()
    expect(shownText(await send(Uint8Array.of(0x3f)))).toBe(JAPANESE)
  })

  it('takes just what showCheck says it will, and turns the rest down for the same reason', async () => {
    const texts: string[] = []
    for (let i = 0; i < 400; i++) {
      // most short; some long enough to be too long; and some with a tab, which isn't text it shows
      const count = 1 + (i % 4 === 0 ? 10 + next(50) : next(10))
      const text = Array.from({ length: count }, () => pieces[next(pieces.length)]).join('')
      texts.push(i % 9 === 0 ? `${text}\t` : text)
    }
    const codes = texts.map((t) => expected(t)[0])
    // every kind, plenty of each
    for (const code of [0, 1, 2])
      expect(codes.filter((c) => c === code).length, `answer ${code}`).toBeGreaterThan(30)
    for (const [i, t] of texts.entries())
      expect(await answerTo(t), JSON.stringify(t)).toEqual([codes[i]])
  }, 120_000)

  it('draws the line where maki does: the most that fits is shown, a piece more isn’t', async () => {
    for (let i = 0; i < 100; i++) {
      // pieces added until one more would be too much, starting from one that isn't a space
      let text = pieces[next(pieces.length - 3)]
      let more = pieces[next(pieces.length)]
      while (showCheck(text + more).ok) {
        text += more
        more = pieces[next(pieces.length)]
      }
      const check = showCheck(text)
      expect(check.ok && check.version, JSON.stringify(text)).toBeGreaterThanOrEqual(7)
      expect(await answerTo(text), JSON.stringify(text)).toEqual([0])
      expect(await answerTo(text + more), JSON.stringify(text + more)).toEqual([1])
    }
  }, 120_000)
})
