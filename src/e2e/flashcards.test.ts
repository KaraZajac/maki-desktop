/**
 * Flashcards, end to end: the real app, offscreen, linked to the fake maki running maki's Flashcards
 * app (sdk/examples/flashcards). On the Connections page a deck pasted in is shown as maki will have
 * it, before it's sent: what's changed for maki's fonts, and what's left out. It goes, in two pieces,
 * and the app itself, asked over the link, lists it; then it's removed, pressing what a person would.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/flashcards.test.ts
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from '../shared/client'
import { FLASHCARDS_APP, listMessage, readList, type Listing } from '../shared/flashcards'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { build, drive, E2E } from './drive'

const FIELD = 'A card a line: its front, a tab or a comma, then its back'

describe.skipIf(!E2E || !FAKE_BUILT || !APP_FIXTURES_THERE)('Flashcards, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'flashcards.maki')])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** What maki's Flashcards app keeps, as it answers the link. */
  const onMaki = async (): Promise<Listing> => {
    const t = await TcpTransport.open(fake.port)
    try {
      const r = await new MakiClient(t).appMessage(FLASHCARDS_APP, listMessage())
      return readList(r.answer)!
    } finally {
      await t.close()
    }
  }

  it('shows a deck as maki will have it, sends it, and removes it', async () => {
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
    const said = await drive(home, fake.port, [
      ...['--click', 'Flashcards', '--until', 'No decks on maki yet'],
      ...['--fill', `${FIELD}=${deck.join('\n')}`, '--fill', 'Spanish=Spanish'],
      ...['--until', '303 cards for maki, as it will show them'],
      ...['--until', 'Changed to what maki’s fonts draw'],
      ...['--until', 'ź → z (2), ł → l (1)'],
      ...['--until', 'Left out, 1 card: line 4, maki can’t draw Ж у к.'],
      ...['--click', 'flashcards › Send to maki', '--until', 'Spanish sent to maki: 303 cards.']
    ])
    expect(said).toContain('303 cards · 20 for today · 303 new')
    const listed = await onMaki()
    expect(listed.decks.map((d) => [d.name, d.cards, d.new])).toEqual([['Spanish', 303, 303]])

    // on the page, as maki lists it; then removed
    const after = await drive(home, fake.port, [
      ...['--click', 'Flashcards', '--until', '303 cards · 20 for today · 303 new'],
      ...['--click', 'flashcards › Remove Spanish', '--until', 'Spanish removed from maki.']
    ])
    expect(after).toContain('No decks on maki yet')
    expect((await onMaki()).decks).toEqual([])
  }, 360_000)
})
