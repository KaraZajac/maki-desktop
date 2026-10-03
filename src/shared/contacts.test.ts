/**
 * Contacts through maki's Contacts app on the fake maki (maki's own app host): your card set once
 * maki says yes, and the people you met saved as vCards.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  cardMessage,
  cardProblem,
  CONTACTS_APP,
  contactsSays,
  readPeople,
  vcards
} from './contacts'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

/** Someone as the app keeps them: signed or not, when met, their card, their key. */
function kept(name: string, lines: string[], met: number, key?: number): string {
  const t = (s: string): number[] => [...new TextEncoder().encode(s)]
  const card = [
    1,
    t(name).length,
    ...t(name),
    lines.length,
    ...lines.flatMap((l) => [t(l).length, ...t(l)])
  ]
  const metBytes = [...new Uint8Array(new BigUint64Array([BigInt(met)]).buffer)]
  const b = [key === undefined ? 0 : 1, ...metBytes, card.length & 0xff, card.length >> 8, ...card]
  if (key !== undefined) b.push(...new Array(32).fill(key))
  return Buffer.from(b).toString('hex')
}

describe('cards and people as the app takes them', () => {
  it('a card: its name and lines, each a byte’s length first', () => {
    expect(Array.from(cardMessage('Kara', ['k@x.org', ' '])!)).toEqual([
      67,
      1,
      4,
      75,
      97,
      114,
      97,
      1,
      7,
      ...new TextEncoder().encode('k@x.org')
    ])
    expect(cardMessage('', [])).toBeNull()
    expect(cardMessage('Kara', ['a', 'b', 'c', 'd'])).toBeNull()
    expect(cardMessage('x'.repeat(33), [])).toBeNull()
    // the name trimmed, as its lines are
    expect(cardMessage('  Kara ', [])).toEqual(cardMessage('Kara', []))
  })

  it('says why it wouldn’t take a card', () => {
    expect(cardProblem('Kara', ['k@x.org', '', 'example.org'])).toBeNull()
    expect(cardProblem('  ', [])).toBe('Your card needs a name.')
    expect(cardProblem('é'.repeat(17), [])).toBe(
      'A name fits in 32 bytes, and this one is 34: accents and other scripts take two or more each.'
    )
    expect(cardProblem('Kara\tZ', [])).toBe('A name is one line.')
    expect(cardProblem('Kara', ['a', 'b', 'c', 'd'])).toBe('A card has 3 lines at most.')
    expect(cardProblem('Kara', ['', 'x'.repeat(49)])).toBe('Line 2 fits in 48 bytes, and it’s 49.')
    expect(cardProblem('Kara', ['a\u0085b'])).toBe('Line 1 is one line.')
  })

  it('people as vCards, a line as what it looks like', () => {
    const v = vcards([
      {
        name: 'Alex Chen',
        lines: ['alex@example.org', '+1 555 0100', 'alex.example/blog', '@alex@hackers.town'],
        signed: true,
        key: 'ab'.repeat(32),
        met: 1_790_000_000
      }
    ])
    expect(v).toContain('FN:Alex Chen\r\n')
    expect(v).toContain('EMAIL:alex@example.org\r\n')
    expect(v).toContain('TEL:+1 555 0100\r\n')
    expect(v).toContain('URL:alex.example/blog\r\n')
    expect(v).toContain(
      'NOTE:@alex@hackers.town\\nMet 2026-09-21\\, their card signed by their maki (key abababababababab). Saved from maki.\r\n'
    )
    expect(v).toContain(`X-MAKI-KEY:${'ab'.repeat(32)}\r\n`)
    // vCard's own separators in a value are escaped, so a name stays one field
    const semi = vcards([{ name: 'Kim; Lee, Jr.', lines: [], signed: false, key: null, met: 0 }])
    expect(semi).toContain('FN:Kim\\; Lee\\, Jr.\r\n')
    expect(semi).toContain('N:;Kim\\; Lee\\, Jr.;;;\r\n')
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('contacts with the fake maki', () => {
  const fakes: ChildProcess[] = []
  afterAll(() => fakes.forEach((p) => p.kill()))

  it('sets your card, and saves who you met once maki says yes', async () => {
    const fake = await startFake([
      '--app',
      join(APP_FIXTURES, 'contacts.maki'),
      '--storage',
      `${CONTACTS_APP}:p:0101010101010101=${kept('Alex Chen', ['alex@example.org'], 1_790_000_000, 1)}`,
      '--storage',
      `${CONTACTS_APP}:p:u0000000000000001=${kept('Jane Doe', ['+1 555 0100'], 0)}`
    ])
    fakes.push(fake.proc)
    const client = new MakiClient(await TcpTransport.open(fake.port))
    const set = await client.appMessage(
      CONTACTS_APP,
      cardMessage('Kara Zajac', ['kara@soulstone.org'])!
    )
    expect(contactsSays(set.answer)).toBeNull()
    const people = readPeople(
      (await client.appMessage(CONTACTS_APP, Uint8Array.of('P'.charCodeAt(0)))).answer
    )!
    expect(people.map((p) => [p.name, p.lines, p.signed, p.met])).toEqual([
      ['Jane Doe', ['+1 555 0100'], false, 0],
      ['Alex Chen', ['alex@example.org'], true, 1_790_000_000]
    ])
    expect(people[1].key).toBe('01'.repeat(32))
  })
})
