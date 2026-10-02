import { describe, expect, it } from 'vitest'
import {
  addedId,
  addMessage,
  changeMessage,
  entryBytes,
  entryProblem,
  freeNumber,
  listMessage,
  passwordSays,
  readEntry,
  readList,
  removeMessage,
  type PasswordEntry
} from './passwords'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

const github: PasswordEntry = {
  id: 1,
  alphabet: 'base64',
  length: 21,
  number: 0,
  enter: true,
  site: 'github.com',
  user: 'kara'
}

describe('the Passwords app’s messages', () => {
  it('carries an entry as the app reads it', () => {
    // id, alphabet, length, number, Enter, the site's length and the site, the username's
    expect(hex(entryBytes(github))).toBe(
      '01000000' +
        '00' +
        '15' +
        '00000000' +
        '01' +
        '0a' +
        hex(Buffer.from('github.com')) +
        '04' +
        hex(Buffer.from('kara'))
    )
    const bank: PasswordEntry = {
      ...github,
      id: 7,
      alphabet: 'base85',
      length: 30,
      number: 2 ** 31 - 1,
      enter: false,
      site: 'Société',
      user: ''
    }
    const b = entryBytes(bank)
    expect(readEntry(b)).toEqual({ entry: bank, size: b.length })
    expect(hex(b.subarray(4, 11))).toBe('011effffff7f00')
  })

  it('asks for what the app takes, and says why not', () => {
    const { id: _, ...e } = github
    expect(hex(addMessage(e)!)).toBe('41' + hex(entryBytes({ ...github, id: 0 })))
    expect(hex(changeMessage(github)!)).toBe('52' + hex(entryBytes(github)))
    expect(changeMessage({ ...github, id: 0 })).toBeNull()
    expect(hex(removeMessage(0x01020304))).toBe('4404030201')
    expect(hex(listMessage(0))).toBe('4c0000')
    expect(hex(listMessage(300))).toBe('4c2c01')
    for (const [bad, why] of [
      [{ length: 19 }, /20 to 86/],
      [{ length: 87 }, /20 to 86/],
      [{ alphabet: 'base85', length: 9 }, /10 to 80/],
      [{ alphabet: 'base85', length: 81 }, /10 to 80/],
      [{ length: 21.5 }, /20 to 86/],
      [{ number: -1 }, /0 to 2147483647/],
      [{ number: 2 ** 31 }, /0 to 2147483647/],
      [{ site: ' ' }, /needs a site/],
      [{ site: 'a\nb' }, /one line/],
      [{ site: 'é'.repeat(17) }, /32 bytes/],
      [{ user: 'k'.repeat(65) }, /64/],
      [{ user: 'kära' }, /US keyboard/],
      [{ user: 'ka\tra' }, /US keyboard/]
    ] as const) {
      expect(entryProblem({ ...e, ...bad } as typeof e), JSON.stringify(bad)).toMatch(why)
      expect(addMessage({ ...e, ...bad } as typeof e)).toBeNull()
    }
    // the longest the app takes
    expect(
      entryProblem({ ...e, site: 'é'.repeat(16), user: '~'.repeat(64), length: 86 })
    ).toBeNull()
  })

  it('reads the app’s list strictly', () => {
    const second: PasswordEntry = { ...github, id: 2, number: 3, site: 'mail', user: '' }
    const answer = Uint8Array.of(0, 1, 2, 0, ...entryBytes(github), ...entryBytes(second))
    expect(readList(answer)).toEqual({ total: 2, entries: [github, second] })
    // a page: two in all, one carried
    expect(readList(Uint8Array.of(0, 1, 2, 0, ...entryBytes(github)))).toEqual({
      total: 2,
      entries: [github]
    })
    expect(readList(Uint8Array.of(0, 1, 0, 0))).toEqual({ total: 0, entries: [] })
    // another version, a refusal, an entry cut short or one the app wouldn't put
    expect(readList(Uint8Array.of(0, 2, 0, 0))).toBeNull()
    expect(readList(Uint8Array.of(4))).toBeNull()
    expect(readList(answer.subarray(0, answer.length - 1))).toBeNull()
    const odd = entryBytes(github)
    odd[4] = 2
    expect(readList(Uint8Array.of(0, 1, 1, 0, ...odd))).toBeNull()
    const long = entryBytes({ ...github, length: 87 })
    expect(readList(Uint8Array.of(0, 1, 1, 0, ...long))).toBeNull()
    const notUtf8 = entryBytes(github)
    notUtf8[12] = 0xff
    expect(readList(Uint8Array.of(0, 1, 1, 0, ...notUtf8))).toBeNull()
  })

  it('reads the app’s answers', () => {
    expect(addedId(Uint8Array.of(0, 5, 0, 0, 0))).toBe(5)
    expect(addedId(Uint8Array.of(1))).toBeNull()
    expect(passwordSays(Uint8Array.of(0))).toBeNull()
    expect(passwordSays(Uint8Array.of(1))).toBe('you said no on maki')
    expect(passwordSays(Uint8Array.of(2))).toBe('nobody answered on maki')
    expect(passwordSays(Uint8Array.of(5))).toMatch(/100 at most/)
    expect(passwordSays(Uint8Array.of(4))).toMatch(/didn’t take it/)
  })

  it('suggests the lowest number nothing has', () => {
    expect(freeNumber([])).toBe(0)
    expect(freeNumber([github, { ...github, number: 1 }, { ...github, number: 3 }])).toBe(2)
  })
})
