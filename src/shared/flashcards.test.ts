/**
 * Flashcards as maki desktop sends it decks: what maki's fonts draw (held to the fonts themselves,
 * in the firmware repo), and the stand-ins for what they don't; decks read from CSV, tab-separated
 * text and Anki's plain text exports, as Anki writes them; a deck fitted to maki, with what was
 * changed and left out; and the app's messages, byte by byte. Then the real app on the fake maki
 * (maki's own app host): decks sent in pieces, listed, replaced and removed; what maki desktop works
 * out a deck takes of the app's room just what the app counts; and every deck it fits, taken.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  chars,
  decodeFile,
  deckBytes,
  drawable,
  FLASHCARDS_APP,
  flashcardsSays,
  kib,
  linkSays,
  listMessage,
  MAX_BACK,
  MAX_FRONT,
  PIECE,
  prepareDeck,
  readDeck,
  readList,
  removeMessage,
  sendDeck,
  standIn,
  storedSize,
  uploadMessages,
  type AppSend,
  type Card
} from './flashcards'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const cp = (n: number): string => String.fromCodePoint(n)

/** maki's fonts, in the firmware repo beside this one: the code points each draws. */
const FONTS = resolve(__dirname, '../../../xous-core/libs/blitstr2/src/fonts')

describe('what maki’s fonts draw', () => {
  it.skipIf(!existsSync(FONTS))(
    'is what each of its fonts has, but the box and the soft hyphen',
    () => {
      for (const font of ['regular', 'bold', 'small', 'mono', 'tall']) {
        const src = readFileSync(join(FONTS, `${font}.rs`), 'utf8')
        const table = /pub const CODEPOINTS: \[u32; \d+\] = \[([^\]]*)\]/.exec(src)![1]
        const has = new Set([...table.matchAll(/0x([0-9a-fA-F]+)/g)].map((m) => parseInt(m[1], 16)))
        expect(has.size, font).toBe(207)
        // the box with a question mark is what maki draws for the rest; the soft hyphen should be
        // invisible, and is taken out
        const wrong: string[] = []
        for (let n = 0; n <= 0xffff; n++)
          if (
            (n < 0xd800 || n > 0xdfff) &&
            drawable(cp(n)) !== (has.has(n) && n !== 0xfffd && n !== 0xad)
          )
            wrong.push(n.toString(16))
        expect(wrong, font).toEqual([])
      }
    }
  )

  it('has a stand-in for what means the same, and none for other scripts', () => {
    const cases: [string, string | null][] = [
      // dashes, spaces and what's invisible
      [cp(0x2013), '-'],
      [cp(0x2014), '-'],
      [cp(0x2212), '-'],
      [cp(0x2009), ' '],
      [cp(0x3000), ' '],
      [cp(0x200b), ''],
      [cp(0xad), ''],
      [cp(0xfeff), ''],
      // arrows, comparisons, superscripts and subscripts
      ['→', '->'],
      ['⇒', '=>'],
      ['≤', '<='],
      ['≠', '!='],
      ['⁴', '^4'],
      ['₂', '2'],
      // Unicode's compatibility forms: ligatures, full-width letters, ℃, fractions
      ['ﬁ', 'fi'],
      ['Ａ', 'A'],
      ['℃', '°C'],
      ['™', 'TM'],
      ['⅓', '1/3'],
      // letters with marks maki's fonts lack: as many of the marks as make one they draw
      ['ą', 'a'],
      ['ł', 'l'],
      ['Ś', 'S'],
      ['ș', 's'],
      ['ǖ', 'ü'],
      ['ệ', 'ê'],
      ['ő', 'o'],
      ['İ', 'I'],
      // no stand-in: maki would draw a box
      ['Ж', null],
      ['й', null],
      ['日', null],
      ['α', null],
      ['ŋ', null],
      [cp(0x1f600), null]
    ]
    for (const [c, want] of cases) expect(standIn(c), c).toBe(want)
    // every stand-in is drawn
    const undrawn: string[] = []
    for (let n = 0x80; n <= 0xffff; n++) {
      const s = n >= 0xd800 && n <= 0xdfff ? null : standIn(cp(n))
      if (s !== null && ![...s].every(drawable)) undrawn.push(`${n.toString(16)} ${s}`)
    }
    expect(undrawn).toEqual([])
  })
})

describe('reading a deck', () => {
  it('reads tab- and comma-separated text, quoted as CSV is', () => {
    const tsv = readDeck('hola\thello\ngracias\tthank you\n\nel perro\tthe dog\n')
    expect(tsv.separator).toBe('tab')
    expect(tsv.cards).toEqual([
      { front: 'hola', back: 'hello', line: 1 },
      { front: 'gracias', back: 'thank you', line: 2 },
      { front: 'el perro', back: 'the dog', line: 4 }
    ])
    const csv = readDeck(
      'Front,Back\r\n"Hello, world","Hola, mundo"\r\n"She said ""hi""",Dijo «hola»\r\nmulti,"line one\r\nline two"\r\nlonely\r\n'
    )
    expect(csv.separator).toBe('comma')
    expect(csv.cards).toEqual([
      { front: 'Hello, world', back: 'Hola, mundo', line: 2 },
      { front: 'She said "hi"', back: 'Dijo «hola»', line: 3 },
      { front: 'multi', back: 'line one\nline two', line: 4 }
    ])
    expect(csv.skipped).toEqual([{ line: 6, why: 'it has one field: no back' }])
    expect(csv.notes).toContain(
      'The first line, “Front, Back”, names the columns: it isn’t a card.'
    )
    // as Europe's spreadsheets save them; and told the separator
    expect(readDeck('Haus;house\nBaum;tree').separator).toBe('semicolon')
    expect(readDeck('a|b\nc|d').cards[1]).toEqual({ front: 'c', back: 'd', line: 2 })
    const told = readDeck('a,b;c\nd,e;f', { separator: 'semicolon' })
    expect(told.cards.map((c) => [c.front, c.back])).toEqual([
      ['a,b', 'c'],
      ['d,e', 'f']
    ])
    // a third column isn't sent, and says so
    expect(readDeck('a\tb\tc').notes).toContain(
      'Its third column isn’t sent: a card on maki has a front and a back.'
    )
  })

  it('reads Anki’s Cards in Plain Text, its HTML made text', () => {
    const anki = [
      '#separator:tab',
      '#html:true',
      'hola\thello',
      'el perro<br>grande\tthe <b>big</b> dog',
      '"tab\there"\tfirst<div>second</div><div>third</div>',
      '¿Qué tal?&nbsp;&nbsp;\tHow are you?[sound:que-tal.mp3]',
      '<img src="perro.jpg">perro\tdog &amp; cat &lt;3 &#233; &#x20AC;',
      '"#not a comment"\t<ul><li>one</li><li>two</li></ul>',
      '# a comment',
      ''
    ].join('\n')
    const r = readDeck(anki)
    expect([r.separator, r.html]).toEqual(['tab', 'header'])
    expect(r.cards.map((c) => [c.front, c.back])).toEqual([
      ['hola', 'hello'],
      ['el perro\ngrande', 'the big dog'],
      // HTML's spaces, a tab among them, are one space
      ['tab here', 'first\nsecond\nthird'],
      ['¿Qué tal? ', 'How are you?'],
      ['perro', 'dog & cat <3 é €'],
      ['#not a comment', '\n\n• one\n• two']
    ])
    expect(r.notes).toEqual([
      'Read as Anki’s plain text export, by its header.',
      'maki shows text: 1 sound and 1 picture in it aren’t sent.'
    ])
    // fitted, the line breaks around a list go, and the tab is a space
    const p = prepareDeck('Spanish', r.cards)
    expect(p.cards[2].front).toBe('tab here')
    expect(p.cards[5].back).toBe('• one\n• two')
    // without HTML, as written; Anki's separator by its name with what followed it, or itself
    const plain = readDeck('#separator:Pipe,,,,\n#html:false\na<br>b|c')
    expect(plain.cards).toEqual([{ front: 'a<br>b', back: 'c', line: 3 }])
    expect(readDeck('#separator:,\na,b').separator).toBe('comma')
    expect(readDeck('#separator:\t\na\tb').separator).toBe('tab')
    // and before Anki 2.1.54, a first line of tags
    expect(readDeck('tags:spanish verbs\nhola\thello').cards).toEqual([
      { front: 'hola', back: 'hello', line: 2 }
    ])
  })

  it('reads Anki’s Notes in Plain Text: its own columns left, a deck of several, clozes as cards', () => {
    const anki = [
      '#separator:tab',
      '#html:true',
      '#guid column:1',
      '#notetype column:2',
      '#deck column:3',
      '#tags column:6',
      'a1\tBasic\tSpanish\thola\thello\tgreeting',
      'b2\tBasic\tSpanish::Verbs\tir\tto go\tverb',
      'c3\tCloze\tSpanish\t{{c1::Hola}}, ¿{{c2::cómo::how}} estás?\tBack extra\t',
      'd4\tCloze\tSpanish\t{{c1::Uno}} y {{c1::dos}}\t\t'
    ].join('\n')
    const r = readDeck(anki)
    expect(r.decks).toEqual([
      { name: 'Spanish', notes: 3 },
      { name: 'Spanish::Verbs', notes: 1 }
    ])
    expect(r.cards.map((c) => [c.front, c.back])).toEqual([
      ['hola', 'hello'],
      ['[...], ¿cómo estás?', 'Hola, ¿cómo estás?\n\nBack extra'],
      ['Hola, ¿[how] estás?', 'Hola, ¿cómo estás?\n\nBack extra'],
      ['[...] y [...]', 'Uno y dos']
    ])
    expect(r.notes).toContain('It has 2 decks: this is Spanish.')
    expect(r.notes).toContain(
      'Cloze deletions made into a card for each, as Anki makes them (2 notes).'
    )
    const verbs = readDeck(anki, { deck: 'Spanish::Verbs' })
    expect(verbs.cards).toEqual([{ front: 'ir', back: 'to go', line: 8 }])
  })

  it('reads files as they’re written: UTF-8, UTF-16 by its mark, else Windows-1252', () => {
    const utf8 = new TextEncoder().encode('café\tcoffee')
    expect(decodeFile(utf8)).toEqual({ text: 'café\tcoffee', encoding: 'UTF-8' })
    expect(decodeFile(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8)).text).toBe('café\tcoffee')
    const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from('été\tsummer', 'utf16le')])
    expect(decodeFile(utf16)).toEqual({ text: 'été\tsummer', encoding: 'UTF-16' })
    const cp1252 = Uint8Array.of(0x43, 0x61, 0x66, 0xe9, 0x3b, 0x31, 0x80)
    expect(decodeFile(cp1252)).toEqual({ text: 'Café;1€', encoding: 'Windows-1252' })
  })
})

describe('a deck fitted to maki', () => {
  it('changes what has a stand-in, leaves out what can’t be shown, and says so', () => {
    const p = prepareDeck(' Spanish ' + cp(0x2014) + ' basics ', [
      { front: cp(0x2013) + 'dash' + cp(0x2014), back: 'a → b' },
      { front: 'Жук', back: 'beetle' },
      { front: '  ', back: 'no front' },
      { front: 'y'.repeat(201), back: 'long' },
      { front: 'ok', back: 'é'.repeat(500) },
      { front: 'ǖ ệ ą ą', back: 'H₂O x⁴ ﬁne ⅓' },
      { front: 'two\r\nlines\twith' + cp(7) + 'bell', back: 'a' + cp(0x2028) + 'b' + cp(0x200b) },
      { front: 'emoji', back: cp(0x1f600) }
    ])
    expect(p.name).toBe('Spanish - basics')
    expect(p.nameProblem).toBeNull()
    expect(p.cards).toEqual([
      { front: '-dash-', back: 'a -> b' },
      { front: 'ok', back: 'é'.repeat(500) },
      { front: 'ü ê a a', back: 'H2O x^4 fine 1/3' },
      { front: 'two\nlines withbell', back: 'a\nb' }
    ])
    expect(p.left).toEqual([
      { line: 2, card: { front: 'Жук', back: 'beetle' }, why: 'maki can’t draw Ж у к' },
      { line: 3, card: { front: '  ', back: 'no front' }, why: 'it has no front' },
      {
        line: 4,
        card: { front: 'y'.repeat(201), back: 'long' },
        why: 'its front is longer than 200 characters'
      },
      {
        line: 8,
        card: { front: 'emoji', back: cp(0x1f600) },
        why: `maki can’t draw ${cp(0x1f600)}`
      }
    ])
    expect(p.undrawable).toEqual(['Ж', 'у', 'к', cp(0x1f600)])
    const changed = Object.fromEntries(p.changed.map((c) => [c.from, [c.to, c.times]]))
    expect(changed).toEqual({
      [cp(0x2013)]: ['-', 1],
      [cp(0x2014)]: ['-', 2],
      '→': ['->', 1],
      ǖ: ['ü', 1],
      ệ: ['ê', 1],
      ą: ['a', 2],
      '₂': ['2', 1],
      '⁴': ['^4', 1],
      ﬁ: ['fi', 1],
      '⅓': ['1/3', 1],
      [cp(0x200b)]: ['', 1]
    })
    expect(p.bytes).toBe(deckBytes(p.name, p.cards).length)
    expect(p.problem).toBeNull()
  })

  it('says why a deck can’t be sent at all, or its name won’t do', () => {
    const card = { front: 'a', back: 'b' }
    expect(prepareDeck('', [card]).nameProblem).toBe('it needs a name')
    expect(prepareDeck('x'.repeat(33), [card]).nameProblem).toBe('a name is 32 characters at most')
    expect(prepareDeck('x'.repeat(32), [card]).nameProblem).toBeNull()
    expect(prepareDeck('Русский', [card]).nameProblem).toBe('maki can’t draw Р у с к и й in a name')
    expect(prepareDeck('two\nlines', [card]).name).toBe('two lines')
    expect(prepareDeck('Deck', []).problem).toBe('there are no cards in it')
    expect(prepareDeck('Deck', [{ front: 'Ж', back: 'zh' }]).problem).toBe(
      'none of its cards can be sent'
    )
    expect(prepareDeck('Deck', Array(1001).fill(card)).problem).toBe(
      'maki keeps 1000 cards a deck, and this has 1001: send it as two decks or more'
    )
    expect(prepareDeck('Deck', Array(1000).fill(card)).problem).toBeNull()
    const big = Array(200).fill({ front: 'f'.repeat(MAX_FRONT), back: 'b'.repeat(MAX_BACK) })
    expect(prepareDeck('Deck', big).problem).toBe('it’s 138 KiB, and a deck is 64 KiB at most')
    expect(chars('é' + cp(0x1f600))).toBe(2)
  })
})

describe('the app’s messages', () => {
  it('carries a deck as the app reads it, in pieces of 4096 bytes', () => {
    expect(hex(deckBytes('Hi', [{ front: 'a', back: 'bé' }]))).toBe(
      '02' + '4869' + '0100' + '0100' + '61' + '0300' + '62c3a9'
    )
    const deck = new Uint8Array(PIECE * 2 + 7).map((_, i) => i & 0xff)
    const m = uploadMessages(3, deck)
    expect(m.map((x) => x.length)).toEqual([4096, 4096, 18])
    expect(hex(m[1].subarray(0, 11))).toBe('015503' + 'f11f0000' + 'f50f0000')
    expect(m[2].subarray(11)).toEqual(deck.subarray(PIECE * 2))
    expect(hex(listMessage())).toBe('014c')
    expect(hex(removeMessage(7))).toBe('014407')
  })

  it('reads the app’s list strictly', () => {
    const deck = (id: number, name: string): number[] => [
      id,
      name.length,
      ...Buffer.from(name),
      ...[3, 0, 1, 0, 2, 0, 3, 0],
      ...[100, 1, 0, 0],
      ...[1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ]
    const a = Uint8Array.from([
      0,
      1,
      0x20,
      0x4e,
      1,
      2,
      0,
      20,
      0,
      ...[0x10, 0x27, 0, 0],
      ...[0, 0, 1, 0],
      2,
      ...deck(1, 'Spanish'),
      ...deck(4, 'Numbers')
    ])
    expect(readList(a)).toEqual({
      today: 20000,
      known: true,
      streak: 2,
      newADay: 20,
      used: 10000,
      room: 65536,
      decks: [
        {
          id: 1,
          name: 'Spanish',
          cards: 3,
          new: 1,
          due: 2,
          study: 3,
          size: 356,
          boxes: [1, 1, 0, 0, 0, 0, 0]
        },
        {
          id: 4,
          name: 'Numbers',
          cards: 3,
          new: 1,
          due: 2,
          study: 3,
          size: 356,
          boxes: [1, 1, 0, 0, 0, 0, 0]
        }
      ]
    })
    expect(readList(a.subarray(0, a.length - 1))).toBeNull()
    expect(readList(Uint8Array.from([...a, 0]))).toBeNull()
    expect(readList(Uint8Array.from([0, 2, ...a.subarray(2)]))).toBeNull()
    expect(readList(Uint8Array.of(4, ...Buffer.from('no')))).toBeNull()
    const odd = Uint8Array.from(a)
    odd[4] = 2
    expect(readList(odd)).toBeNull()
    const notUtf8 = Uint8Array.from(a)
    notUtf8[20] = 0xff
    expect(readList(notUtf8)).toBeNull()
  })

  it('says what the app’s answers mean', () => {
    const why = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(flashcardsSays(Uint8Array.of(0))).toBeNull()
    expect(flashcardsSays(Uint8Array.of(4, ...why('a piece out of order')))).toBe(
      'maki’s Flashcards app didn’t take it: a piece out of order'
    )
    expect(flashcardsSays(Uint8Array.of(5, ...why('maki keeps 8 decks')))).toBe(
      'no room on maki: maki keeps 8 decks'
    )
    expect(flashcardsSays(Uint8Array.of(7))).toBe('that deck isn’t on maki any more')
    expect(flashcardsSays(Uint8Array.of(8))).toBe('another deck on maki has that name')
    expect(flashcardsSays(Uint8Array.of(9, 2))).toMatch(
      /version 2 of its messages, and maki desktop 1/
    )
    expect(flashcardsSays(Uint8Array.of(3))).toBe('maki’s Flashcards app answered oddly')
    expect(linkSays('no match')).toBe('maki’s Flashcards app isn’t installed')
    expect(kib(15)).toBe('0 KiB')
    expect(kib(3477)).toBe('3.4 KiB')
    expect(kib(62058)).toBe('61 KiB')
  })

  it('sends a deck a piece at a time, checking each answer', async () => {
    const deck = new Uint8Array(PIECE + 100)
    const asked: Uint8Array[] = []
    const answering =
      (answers: Uint8Array[]): AppSend =>
      async (m) => {
        asked.push(m)
        return { status: 'approved', answer: answers.shift()! }
      }
    const heard: number[] = []
    const ok = await sendDeck(
      answering([Uint8Array.of(6, 0xf5, 0x0f, 0, 0), Uint8Array.of(0, 9, 2, 0, 1, 0)]),
      9,
      deck,
      (n) => heard.push(n)
    )
    expect(ok).toEqual({ ok: true, id: 9, cards: 2, kept: 1 })
    expect(heard).toEqual([PIECE, PIECE + 100])
    expect(asked.map((m) => m[2])).toEqual([9, 9])
    // a piece answered as if another length had come; a refusal; the link saying no
    expect(await sendDeck(answering([Uint8Array.of(6, 1, 0, 0, 0)]), 0, deck)).toEqual({
      ok: false,
      why: 'maki’s Flashcards app answered oddly'
    })
    expect(await sendDeck(answering([Uint8Array.of(7)]), 2, deck)).toEqual({
      ok: false,
      why: 'that deck isn’t on maki any more'
    })
    expect(
      await sendDeck(async () => ({ status: 'unavailable', answer: new Uint8Array() }), 0, deck)
    ).toEqual({ ok: false, why: linkSays('unavailable') })
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'maki’s Flashcards app on the fake maki',
  () => {
    let fake: ChildProcess
    let maki: MakiClient
    beforeAll(async () => {
      const f = await startFake(['--app', join(APP_FIXTURES, 'flashcards.maki')])
      fake = f.proc
      maki = new MakiClient(await TcpTransport.open(f.port))
    })
    afterAll(() => fake?.kill())
    const send: AppSend = async (m) => {
      const r = await maki.appMessage(FLASHCARDS_APP, m)
      return { status: r.status, answer: r.answer }
    }
    const list = async () => {
      const r = await send(listMessage())
      expect(r.status).toBe('approved')
      return readList(r.answer)!
    }

    it('takes a deck in pieces, lists it, takes its new version and removes it', async () => {
      const start = await list()
      expect(start.known).toBe(true)
      expect(Math.abs(start.today - Math.floor(Date.now() / 86_400_000))).toBeLessThanOrEqual(1)
      expect(start.decks).toEqual([])
      // a thousand cards, nine pieces
      const many: Card[] = Array.from({ length: 1000 }, (_, i) => ({
        front: `word ${i}`,
        back: `the meaning of word ${i}`
      }))
      const p = prepareDeck('Many words', many)
      const deck = deckBytes(p.name, p.cards)
      expect(uploadMessages(0, deck).length).toBe(9)
      const sent = await sendDeck(send, 0, deck)
      expect(sent).toEqual({ ok: true, id: expect.any(Number), cards: 1000, kept: 0 })
      if (!sent.ok) return
      const after = await list()
      expect(after.decks).toEqual([
        {
          id: sent.id,
          name: 'Many words',
          cards: 1000,
          new: 1000,
          due: 0,
          study: 20,
          size: expect.any(Number),
          boxes: [0, 0, 0, 0, 0, 0, 0]
        }
      ])
      // what maki desktop works out it takes, just what the app counts
      expect(after.used - start.used).toBe(storedSize(p.name, p.cards, true, sent.id))
      expect(storedSize(p.name, p.cards, true)).toBeGreaterThanOrEqual(after.used - start.used)
      // its new version: in its place, under the same ID
      const changed = prepareDeck('Many words, again', many.slice(0, 600))
      const again = await sendDeck(send, sent.id, deckBytes(changed.name, changed.cards))
      expect(again).toEqual({ ok: true, id: sent.id, cards: 600, kept: 0 })
      expect((await list()).decks.map((d) => [d.id, d.name, d.cards])).toEqual([
        [sent.id, 'Many words, again', 600]
      ])
      // and removed; again, it isn't there
      expect(flashcardsSays((await send(removeMessage(sent.id))).answer)).toBeNull()
      expect(flashcardsSays((await send(removeMessage(sent.id))).answer)).toBe(
        'that deck isn’t on maki any more'
      )
      expect(await list()).toEqual({ ...start, today: expect.any(Number), known: true })
    }, 60_000)

    it('takes every deck maki desktop fits, and keeps what it says', async () => {
      // cards from pieces of many scripts, and of every length up to past the most
      const pieces = [
        'hola',
        'ą',
        'Ж',
        'ﬁ',
        '→',
        ' ',
        '\n',
        '\t',
        'é',
        '日本',
        'x',
        cp(0x2014),
        '"',
        '€',
        'a b c '
      ]
      let seed = 3
      const next = (n: number): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return Math.floor(seed / 65536) % n
      }
      const side = (most: number): string => {
        const n = next(4) === 0 ? most - 5 + next(10) : 1 + next(12)
        let s = ''
        while (chars(s) < n) s += pieces[next(pieces.length)]
        return [...s].slice(0, n).join('')
      }
      for (let d = 0; d < 6; d++) {
        const cards = Array.from({ length: 5 + next(40) }, () => ({
          front: side(MAX_FRONT),
          back: side(MAX_BACK)
        }))
        const p = prepareDeck(`Deck ${d} ${pieces[next(4)]}`, cards)
        if (p.problem !== null || p.nameProblem !== null) continue
        const before = await list()
        const sent = await sendDeck(send, 0, deckBytes(p.name, p.cards))
        expect(sent.ok, JSON.stringify(sent)).toBe(true)
        if (!sent.ok) continue
        const after = await list()
        const listed = after.decks.find((x) => x.id === sent.id)!
        expect(listed.name).toBe(p.name)
        expect(listed.cards).toBe(p.cards.length)
        expect(after.used - before.used).toBe(
          storedSize(p.name, p.cards, before.decks.length === 0, sent.id)
        )
        expect(flashcardsSays((await send(removeMessage(sent.id))).answer)).toBeNull()
      }
    }, 120_000)
  }
)
