/**
 * Flashcards, end to end: the real app, offscreen, linked to the fake maki running maki's Flashcards
 * app (sdk/examples/flashcards). On its page a deck pasted in is shown as maki will have it, before
 * it's sent: what's changed for maki's fonts, and what's left out. It goes, in two pieces, and the app
 * itself, asked over the link, lists it; then it's removed, pressing what a person would. A deck maki
 * has studied is opened: its cards, each with its box and when it's next due, searched; one card
 * changed, one removed and one added, the deck renamed, and all of it sent back; and maki has it so,
 * each card's progress kept by its front. With the app's 1.0 (the store's), which can't read a deck
 * back, the page lists the decks and says to update the app to see their cards.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/flashcards.test.ts
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import {
  FLASHCARDS_APP,
  listMessage,
  readBack,
  readList,
  type DeckRead,
  type Listing
} from '../shared/flashcards'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive, E2E } from './drive'

const FIELD = 'A card a line: its front, a tab or a comma, then its back'
/** The Flashcards app's 1.0 as the maki store has it (KaraZajac/maki-apps), cloned beside this one. */
const FLASHCARDS_1_0 = resolve(__dirname, '../../../apps/apps/com.leviathan.maki.flashcards/1.maki')

/**
 * Today, as maki's clock has it on a fake maki that takes this computer's (`--clock-verified`): days
 * turn at midnight UTC, so a test that counts them waits out the last two minutes before one.
 */
async function today(): Promise<number> {
  const day = 86_400_000
  const left = day - (Date.now() % day)
  if (left < 120_000) await new Promise((ok) => setTimeout(ok, left + 1000))
  return Math.floor(Date.now() / day)
}

/**
 * What maki's Flashcards app keeps (sdk/examples/flashcards/src/deck.rs), as the fake maki's
 * `--storage` arguments: deck 1, `name`, each card with its box and how many days before `day` it was
 * seen; six new cards brought in that day; four days in a row studied, up to the day before.
 */
function studied(name: string, cards: [string, string, number, number][], day: number): string[] {
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
  const utf8 = (s: string): number[] => [...Buffer.from(s)]
  const hex = (b: number[]): string => Buffer.from(b).toString('hex')
  const records = cards.flatMap(([front, back]) =>
    [front, back].flatMap((side) => [...u16(utf8(side).length), ...utf8(side)])
  )
  const progress = [1, ...u16(day), ...u16(6)].concat(
    cards.flatMap(([, , box, ago]) => [box, ...u16(box === 0 ? 0 : day - ago)])
  )
  const decks = [1, 1, 0, utf8(name).length, ...utf8(name), ...u16(cards.length), 1]
  const state = [1, ...u16(day), ...u16(day - 1), ...u16(4), ...u16(20), 2]
  return [
    ['c1a.0', records],
    ['p1a', progress],
    ['decks', decks],
    ['state', state]
  ].flatMap(([key, value]) => ['--storage', `${FLASHCARDS_APP}:${key}=${hex(value as number[])}`])
}

/** A deck maki has studied: front, back, box, and how many days ago it was last seen. */
const SPANISH: [string, string, number, number][] = [
  ['hola', 'hello', 2, 1],
  ['gracias', 'thank you', 1, 1],
  ['el perro', 'the dog', 3, 2],
  ['el gato', 'the cat', 4, 3],
  ['la casa', 'the house', 5, 20],
  ['buenos días', 'good morning', 0, 0]
]

describe.skipIf(!E2E || !FAKE_BUILT || !APP_FIXTURES_THERE)('Flashcards, end to end', () => {
  const fakes: ChildProcess[] = []
  let home = ''

  beforeAll(() => {
    build()
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    for (const f of fakes) f.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** A fake maki with `bundle` installed, and what else it's given. */
  const fake = async (bundle: string, args: string[] = []): Promise<number> => {
    const f = await startFake(['--app', bundle, ...args])
    fakes.push(f.proc)
    return f.port
  }

  /** What maki's Flashcards app says over the link: `ask` of its messages, through a client. */
  const onMaki = async <T>(port: number, ask: (c: MakiClient) => Promise<T>): Promise<T> => {
    const t = await TcpTransport.open(port)
    try {
      return await ask(new MakiClient(t))
    } finally {
      await t.close()
    }
  }
  const listed = (port: number): Promise<Listing> =>
    onMaki(port, async (c) => readList((await c.appMessage(FLASHCARDS_APP, listMessage())).answer)!)
  const read = (port: number, id: number): Promise<DeckRead | null> =>
    onMaki(port, async (c) => {
      const got = await readBack((m) => c.appMessage(FLASHCARDS_APP, m), id)
      return got.ok ? got.deck : null
    })

  it('shows a deck as maki will have it, sends it, and removes it', async () => {
    const port = await fake(join(APP_FIXTURES, 'flashcards.maki'))
    // three hundred cards and four more: one with an accent maki's fonts lack, one they can't draw
    const words = Array.from({ length: 300 }, (_, i) => `word ${i}\tmeaning of word ${i}`)
    const deck = [
      'hola\thello',
      'gracias\tthank you',
      'źdźbło\ta blade of grass',
      'Жук\tbeetle',
      ...words
    ]
    // before it's sent: the cards as maki will have them, what's changed and what's left out
    const said = await drive(home, port, [
      ...['--click', 'Flashcards', '--until', 'No decks on maki yet'],
      ...['--fill', `${FIELD}=${deck.join('\n')}`, '--fill', 'Spanish=Spanish'],
      ...['--until', '303 cards for maki, as it will show them'],
      ...['--until', 'Changed to what maki’s fonts draw'],
      ...['--until', 'ź → z (2), ł → l (1)'],
      ...['--until', 'Left out, 1 card: line 4, maki can’t draw Ж у к.'],
      ...['--click', 'Send to maki', '--until', 'Spanish sent to maki: 303 cards.']
    ])
    expect(said).toContain('303 cards · 20 for today · 303 new')
    expect((await listed(port)).decks.map((d) => [d.name, d.cards, d.new])).toEqual([
      ['Spanish', 303, 303]
    ])

    // on the page, as maki lists it; then removed, once asked
    const after = await drive(home, port, [
      ...['--click', 'Flashcards', '--until', '303 cards · 20 for today · 303 new'],
      ...['--click', 'Remove Spanish', '--until', 'how well you know each of its cards'],
      ...['--click', 'Remove it', '--until', 'Spanish removed from maki.']
    ])
    expect(after).toContain('No decks on maki yet')
    expect((await listed(port)).decks).toEqual([])
  }, 360_000)

  it('opens a deck maki has studied, changes it, and sends it back with its progress', async () => {
    const day = await today()
    const port = await fake(join(APP_FIXTURES, 'flashcards.maki'), [
      '--clock-verified',
      ...studied('Spanish', SPANISH, day)
    ])
    const said = await drive(home, port, [
      // the deck, what it has for today and the days in a row; then its cards, each as it stands
      ...['--click', 'Flashcards', '--until', '6 cards · 3 for today · 1 new'],
      ...['--until', '4 days in a row'],
      ...['--click', 'Open Spanish', '--until', 'good morning'],
      ...['--fill', 'Search its cards=perro', '--until', '1 of 6 cards'],
      ...['--gone', 'thank you', '--fill', 'Search its cards=', '--until', 'thank you'],
      // a back changed, a card removed, one added, the deck renamed
      ...['--click', 'Edit gracias', '--fill', 'Back=thank you very much', '--click', 'Done'],
      ...['--click', 'Remove la casa'],
      ...['--click', 'Add a card', '--fill', 'A new card’s front=el sol'],
      ...['--fill', 'A new card’s back=the sun', '--click', 'Add it'],
      ...['--fill', 'The deck’s name=Español'],
      ...[
        '--until',
        'Changed here, not sent yet: 1 card changed, 1 added, 1 removed, renamed Español.'
      ],
      ...['--until', 'Sent, 4 cards keep their progress; the one removed takes its with it.'],
      ...['--click', 'Send changes to maki'],
      ...['--until', 'Español sent to maki: 6 cards, 4 kept their progress.']
    ])
    // as the page has it now, read from maki again
    expect(said).toContain('thank you very much')
    expect(said).toContain('el sol')
    expect(said).not.toContain('la casa')
    for (const due of ['tomorrow', 'in 2 days', 'in 5 days']) expect(said).toContain(due)
    // and as maki has it: each card's box kept by its front, the new one new
    const deck = await read(port, 1)
    expect(deck?.name).toBe('Español')
    expect(deck?.cards.map((c) => [c.front, c.back, c.box, c.box && c.due - day])).toEqual([
      ['hola', 'hello', 2, 1],
      ['gracias', 'thank you very much', 1, 0],
      ['el perro', 'the dog', 3, 2],
      ['el gato', 'the cat', 4, 5],
      ['buenos días', 'good morning', 0, 0],
      ['el sol', 'the sun', 0, 0]
    ])
  }, 360_000)

  it.skipIf(!existsSync(FLASHCARDS_1_0))(
    'lists the decks of the app’s 1.0, and says to update it to see their cards',
    async () => {
      const day = await today()
      const port = await fake(FLASHCARDS_1_0, [
        '--clock-verified',
        ...studied('Spanish', SPANISH, day)
      ])
      const said = await drive(home, port, [
        ...['--click', 'Flashcards', '--until', '6 cards · 3 for today · 1 new'],
        ...['--until', 'Update it to 1.1 on Apps to see each deck’s cards here']
      ])
      expect(said).toContain('maki’s Flashcards app is version 1.0.')
      expect(said).not.toMatch(/\bOpen\b/)
    },
    240_000
  )
})
