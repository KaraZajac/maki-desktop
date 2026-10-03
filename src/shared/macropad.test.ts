/**
 * The Macro Pad's messages, and the scripts maki desktop sends, as maki's Macro Pad app takes them:
 * unit by unit, then through the fake maki (maki's own app host) running the app itself, version 2
 * and, from the firmware's history, version 1 (Macro Pad 1.0).
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  cost,
  getMessage,
  keptId,
  lineFeeds,
  linkSays,
  listMessage,
  lists,
  MACROPAD_APP,
  macropadReply,
  MAX_MESSAGE,
  MAX_NAME,
  MAX_SCRIPT,
  padSays,
  putMessage,
  readPad,
  readText,
  removeMessage,
  reviewScript,
  reviewText,
  scriptMessage,
  scriptProblem,
  scriptSays,
  type Pad
} from './macropad'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  firstMacroPad,
  startFake,
  TcpTransport
} from './test-support'

const dec = new TextDecoder()
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

/** `L`'s answer, as the app makes it, for these scripts: ID, kind, added, changed, text, name. */
function listing(
  scripts: [number, number, number, number, string, string][],
  used: number,
  most = 12,
  room = 16384
): Uint8Array {
  const parts: number[] = [0, 2, scripts.length, most]
  const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  const u64 = (n: number): number[] => [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))]
  parts.push(...u32(used), ...u32(room))
  for (const [id, kind, added, changed, text, name] of scripts) {
    const n = enc(name)
    const size = enc(text).length
    parts.push(id, kind, ...u64(added), ...u64(changed), size & 255, size >> 8, n.length, ...n)
  }
  return Uint8Array.from(parts)
}

const OPEN = 'GUI r\nDELAY 300\nSTRING cmd\nENTER'

describe('the Macro Pad’s messages (version 2)', () => {
  it('lists, gets, keeps and removes, each after the messages’ version', () => {
    expect(hex(listMessage())).toBe('024c')
    expect(hex(getMessage(7))).toBe('024707')
    expect(hex(removeMessage(255))).toBe('0244ff')
    // the ID it replaces, the kind, the name's length and the name, then the text
    expect(hex(putMessage(0, 'ducky', 'Run', 'GUI r')!)).toBe(
      '025000' + '00' + '03' + hex(enc('Run')) + hex(enc('GUI r'))
    )
    expect(hex(putMessage(3, 'text', 'Hi', 'hey')!)).toBe(
      '025003' + '01' + '02' + hex(enc('Hi')) + hex(enc('hey'))
    )
    // the name trimmed, and line endings as maki keeps them
    expect(dec.decode(putMessage(0, 'ducky', '  Run  ', 'GUI r\r\nENTER\r')!.subarray(5))).toBe(
      'RunGUI r\nENTER\n'
    )
    // the longest name in four-byte characters, and the longest script, fit a message
    expect(
      putMessage(0, 'ducky', '\u{1F980}'.repeat(MAX_NAME), 'x'.repeat(MAX_SCRIPT))!.length
    ).toBe(5 + 4 * MAX_NAME + MAX_SCRIPT)
    expect(5 + 4 * MAX_NAME + MAX_SCRIPT).toBeLessThanOrEqual(MAX_MESSAGE)
  })

  it('reads the list the app gives', () => {
    const a = listing(
      [
        [1, 0, 1_790_000_000, 0, OPEN, 'Open terminal'],
        [9, 1, 0, 1_790_086_400, 'héllo', 'Société']
      ],
      123
    )
    expect(readPad(a)).toEqual({
      most: 12,
      used: 123,
      room: 16384,
      scripts: [
        {
          id: 1,
          kind: 'ducky',
          added: 1_790_000_000,
          changed: 0,
          size: OPEN.length,
          name: 'Open terminal'
        },
        { id: 9, kind: 'text', added: 0, changed: 1_790_086_400, size: 6, name: 'Société' }
      ]
    })
    expect(readPad(listing([], 0))).toEqual({ most: 12, used: 0, room: 16384, scripts: [] })
    // anything else isn't a list
    expect(readPad(Uint8Array.of(1))).toBeNull()
    expect(readPad(Uint8Array.of(9, 2))).toBeNull()
    const another = listing([], 0)
    another[1] = 3
    expect(readPad(another)).toBeNull()
    const short = listing([[1, 0, 0, 0, 'x', 'Name']], 9)
    expect(readPad(short.subarray(0, short.length - 1))).toBeNull()
    const kind = listing([[1, 0, 0, 0, 'x', 'Name']], 9)
    kind[13] = 2
    expect(readPad(kind)).toBeNull()
    expect(readPad(Uint8Array.from([...listing([], 0), 0]))).toBeNull()
  })

  it('reads a script’s text, and the ID kept', () => {
    expect(readText(Uint8Array.from([0, ...enc(OPEN)]))).toBe(OPEN)
    expect(readText(Uint8Array.of(0))).toBe('')
    expect(readText(Uint8Array.of(7))).toBeNull()
    expect(readText(Uint8Array.of(0, 0xff))).toBeNull()
    expect(keptId(Uint8Array.of(0, 4))).toBe(4)
    expect(keptId(Uint8Array.of(0))).toBeNull()
    expect(keptId(Uint8Array.of(8))).toBeNull()
  })

  it('says what the app answered, in words', () => {
    expect(padSays(Uint8Array.of(0, 1))).toBeNull()
    expect(padSays(Uint8Array.of(1))).toBe('you said no on maki')
    expect(padSays(Uint8Array.of(2))).toBe('nobody answered on maki')
    expect(padSays(Uint8Array.from([4, ...enc("it isn't UTF-8")]))).toBe(
      'maki’s Macro Pad didn’t take it: it isn’t UTF-8'
    )
    expect(padSays(Uint8Array.from([5, ...enc('maki keeps 12 scripts: remove one first')]))).toBe(
      'maki keeps 12 scripts: remove one first'
    )
    expect(padSays(Uint8Array.of(5))).toBe('there’s no room for it on maki')
    expect(padSays(Uint8Array.of(7))).toBe('that script isn’t on maki any more')
    expect(padSays(Uint8Array.of(8))).toBe('maki has another script with that name')
    expect(padSays(Uint8Array.of(9, 3))).toMatch(/update maki desktop/)
    expect(linkSays('unavailable')).toMatch(/another app is open on maki/)
    expect(linkSays('locked')).toBe('maki is locked: put its PIN in on maki')
  })

  it('lists from version 2 of the app on', () => {
    expect(lists(1)).toBe(false)
    expect(lists(2)).toBe(true)
    expect(lists(3)).toBe(true)
  })
})

describe('what the app takes', () => {
  const pad = (scripts: Pad['scripts'], used: number): Pad => ({
    most: 12,
    used,
    room: 16384,
    scripts
  })
  const one = (id: number, name: string, size: number): Pad['scripts'][number] => ({
    id,
    kind: 'ducky',
    added: 0,
    changed: 0,
    size,
    name
  })

  it('a name of one line, of 24 characters at most', () => {
    expect(scriptProblem('ducky', '', 'x')).toBe('It needs a name: what maki lists it as.')
    expect(scriptProblem('ducky', '   ', 'x')).toBe('It needs a name: what maki lists it as.')
    expect(scriptProblem('ducky', 'x'.repeat(25), 'x')).toBe('A name is 24 characters at most.')
    expect(scriptProblem('ducky', 'é'.repeat(24), 'x')).toBeNull()
    expect(scriptProblem('ducky', 'a\tb', 'x')).toBe('A name is one line.')
    expect(scriptProblem('ducky', 'a\u0085b', 'x')).toBe('A name is one line.')
    expect(putMessage(0, 'ducky', 'a\tb', 'x')).toBeNull()
  })

  it('a script of 3,900 bytes at most, a text of what maki types', () => {
    expect(scriptProblem('ducky', 'x', 'a'.repeat(MAX_SCRIPT))).toBeNull()
    expect(scriptProblem('ducky', 'x', 'é'.repeat(1951))).toBe(
      'A script is 3,900 bytes at most, and this one is 3,902.'
    )
    // a file's CRLFs count as maki keeps them
    expect(scriptProblem('ducky', 'x', 'a\r\n'.repeat(1950))).toBeNull()
    expect(scriptProblem('text', 'x', 'Dear Kara,\r\n\tthanks.\n')).toBeNull()
    expect(scriptProblem('text', 'x', 'café crème, über alles')).toBe(
      'maki types a text’s letters, digits and symbols as a US keyboard has them, line breaks and tabs: not é è ü U+A0. Make it DuckyScript, or leave those out.'
    )
    // DuckyScript can hold anything: what maki can't type, it skips
    expect(scriptProblem('ducky', 'x', 'REM café')).toBeNull()
    expect(putMessage(0, 'text', 'x', 'café')).toBeNull()
  })

  it('against what maki has: names, how many, and room', () => {
    const two = pad([one(1, 'A', 10), one(2, 'B', 10)], 2 * (4 + 1 + 10))
    expect(scriptProblem('ducky', 'B', 'x', two)).toBe(
      'maki has a script called “B”: give this one another name.'
    )
    // its own name, replacing it, is fine
    expect(scriptProblem('ducky', 'B', 'x', two, 2)).toBeNull()
    expect(scriptProblem('ducky', 'A', 'x', two, 2)).toBe(
      'maki has a script called “A”: give this one another name.'
    )
    const full = pad(
      Array.from({ length: 12 }, (_, i) => one(i + 1, `s${i}`, 8)),
      12 * 14
    )
    expect(scriptProblem('ducky', 'new', 'x', full)).toBe(
      'maki keeps 12 scripts: remove one first.'
    )
    expect(scriptProblem('ducky', 's3', 'STRING y', full, 4)).toBeNull()
    // four of 3,900 bytes leave 764 bytes: what the app says
    const big = pad(
      ['a', 'b', 'c', 'd'].map((n, i) => one(i + 1, n, MAX_SCRIPT)),
      4 * (4 + 1 + MAX_SCRIPT)
    )
    expect(scriptProblem('ducky', 'e', 'x'.repeat(760), big)).toBe(
      'It takes 765 bytes of maki’s room for scripts, and 764 are free.'
    )
    expect(scriptProblem('ducky', 'e', 'x'.repeat(759), big)).toBeNull()
    // replacing one, what it took is free again
    expect(scriptProblem('ducky', 'a', 'x'.repeat(MAX_SCRIPT), big, 1)).toBeNull()
    expect(cost('a', 'é')).toBe(4 + 1 + 2)
  })
})

describe('what maki will make of a script', () => {
  it('counts keystroke lines and names what maki will skip', () => {
    const r = reviewScript('REM a comment\nSTRING hello\nGUI r\nENTER\nF5\na')
    expect(r).toEqual({ actions: 5, skipped: [] })
    // a lone modifier, and DuckyScript 3.0 commands maki doesn’t run, are named once
    const three = reviewScript('GUI\nVAR $x = 1\nSTRING hi\nMOUSE 10 10\nVAR $y = 2')
    expect(three.actions).toBe(1)
    expect(three.skipped).toEqual(['GUI on its own', 'VAR', 'MOUSE'])
  })

  it('counts a text’s characters, its Enters and Tabs, and what maki can’t type', () => {
    expect(reviewText('ab\n\tc\n')).toEqual({ characters: 6, enters: 2, tabs: 1, untypable: [] })
    expect(reviewText('naïve café').untypable).toEqual(['ï', 'é'])
  })

  it('says it in a line', () => {
    // a wait presses nothing
    expect(scriptSays('ducky', OPEN)).toEqual({ says: '3 keystroke lines', warn: null })
    expect(reviewScript('DELAY 100\nDEFAULT_DELAY 5\nDEFAULTDELAY 5')).toEqual({
      actions: 0,
      skipped: []
    })
    expect(scriptSays('ducky', 'STRING x\r\nVAR $a = 1')).toEqual({
      says: '1 keystroke line',
      warn: 'maki skips VAR'
    })
    expect(scriptSays('text', 'Dear Kara,\n\tthanks')).toEqual({
      says: '18 characters, 1 Enter and 1 Tab among them',
      warn: null
    })
    expect(scriptSays('text', 'olé')).toEqual({ says: '3 characters', warn: 'maki can’t type é' })
    expect(lineFeeds('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })
})

describe('Macro Pad 1.0’s message', () => {
  it('packs a script as name then body, and refuses what won’t fit', () => {
    const m = scriptMessage('Open run', 'GUI r\nSTRING cmd\nENTER')!
    expect(dec.decode(m)).toBe('Open run\nGUI r\nSTRING cmd\nENTER')
    // name is trimmed; a blank name, a too-long name, control characters, and an over-long body are refused
    expect(dec.decode(scriptMessage('  hi  ', 'STRING x')!)).toBe('hi\nSTRING x')
    expect(scriptMessage('', 'STRING x')).toBeNull()
    expect(scriptMessage('x'.repeat(MAX_NAME + 1), 'STRING x')).toBeNull()
    expect(scriptMessage('bad\tname', 'STRING x')).toBeNull()
    expect(scriptMessage('big', 'STRING ' + 'a'.repeat(MAX_MESSAGE))).toBeNull()
  })

  it('reads the app’s reply', () => {
    expect(macropadReply(enc('ok 1'))).toEqual({
      ok: true,
      text: 'Kept on maki — 1 script on the pad.'
    })
    expect(macropadReply(enc('ok 7'))).toEqual({
      ok: true,
      text: 'Kept on maki — 7 scripts on the pad.'
    })
    expect(macropadReply(enc('full')).ok).toBe(false)
    // version 2's words for the first version's message
    expect(macropadReply(enc('you said no on maki'))).toEqual({
      ok: false,
      text: 'maki’s Macro Pad: you said no on maki'
    })
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('the Macro Pad on the fake maki', () => {
  const fakes: ChildProcess[] = []
  const dir = mkdtempSync(join(tmpdir(), 'maki-macropad-'))
  afterAll(() => {
    fakes.forEach((p) => p.kill())
    rmSync(dir, { recursive: true, force: true })
  })
  const client = async (bundle: string, args: string[] = []): Promise<MakiClient> => {
    const fake = await startFake(['--app', bundle, ...args])
    fakes.push(fake.proc)
    return new MakiClient(await TcpTransport.open(fake.port))
  }
  const ask = async (c: MakiClient, m: Uint8Array): Promise<Uint8Array> => {
    const r = await c.appMessage(MACROPAD_APP, m)
    expect(r.status).toBe('approved')
    return r.answer
  }

  it('keeps, lists, gives back, replaces and removes scripts as maki desktop sends them', async () => {
    const c = await client(join(APP_FIXTURES, 'macropad.maki'))
    expect(readPad(await ask(c, listMessage()))).toEqual({
      most: 12,
      used: 0,
      room: 16384,
      scripts: []
    })
    expect(keptId(await ask(c, putMessage(0, 'ducky', 'Open terminal', OPEN)!))).toBe(1)
    expect(
      keptId(await ask(c, putMessage(0, 'text', 'Address', '1 Main St\r\n\tSpringfield\n')!))
    ).toBe(2)
    const pad = readPad(await ask(c, listMessage()))!
    expect(pad.scripts.map((s) => [s.id, s.kind, s.name, s.size, s.changed])).toEqual([
      [1, 'ducky', 'Open terminal', OPEN.length, 0],
      [2, 'text', 'Address', '1 Main St\n\tSpringfield\n'.length, 0]
    ])
    // the fake's clock is this computer's
    expect(Math.abs(pad.scripts[0].added - Date.now() / 1000)).toBeLessThan(60)
    expect(pad.used).toBe(
      cost('Open terminal', OPEN) + cost('Address', '1 Main St\n\tSpringfield\n')
    )
    expect(readText(await ask(c, getMessage(2)))).toBe('1 Main St\n\tSpringfield\n')
    // in place of the first, renamed
    expect(keptId(await ask(c, putMessage(1, 'ducky', 'Run box', 'GUI r')!))).toBe(1)
    expect(readText(await ask(c, getMessage(1)))).toBe('GUI r')
    expect(padSays(await ask(c, putMessage(0, 'ducky', 'Address', 'x')!))).toBe(
      'maki has another script with that name'
    )
    expect(padSays(await ask(c, removeMessage(2)))).toBeNull()
    expect(padSays(await ask(c, removeMessage(2)))).toBe('that script isn’t on maki any more')
    expect(readPad(await ask(c, listMessage()))!.scripts.map((s) => s.name)).toEqual(['Run box'])
  })

  it('changes nothing when maki says no', async () => {
    const c = await client(join(APP_FIXTURES, 'macropad.maki'), ['--deny'])
    expect(padSays(await ask(c, putMessage(0, 'ducky', 'x', 'STRING x')!))).toBe(
      'you said no on maki'
    )
    expect(readPad(await ask(c, listMessage()))!.scripts).toEqual([])
  })

  it('Macro Pad 1.0 still takes a script the first version’s way', async (t) => {
    const first = firstMacroPad(dir)
    if (!first) return t.skip()
    const c = await client(first)
    expect(macropadReply(await ask(c, scriptMessage('Open terminal', OPEN)!))).toEqual({
      ok: true,
      text: 'Kept on maki — 1 script on the pad.'
    })
  })
})
