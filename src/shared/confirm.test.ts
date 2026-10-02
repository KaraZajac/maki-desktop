/**
 * maki's Confirm app as maki-confirm and the window ask it: a request laid out as the app reads
 * it, what maki shows of it measured as maki measures, its answers, a yes checked against the key,
 * key files; then the real app on the fake maki (maki's own app host), taking just what
 * `confirmProblem` lets through and signing what the key checks.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  CONFIRM_APP,
  confirmAnswer,
  confirmBody,
  confirmMessage,
  confirmProblem,
  confirmSays,
  keyHex,
  keyLine,
  keyOf,
  keysIn,
  programFit,
  shownLength,
  SIGNED,
  verifyYes,
  wordLength,
  type ConfirmRequest
} from './confirm'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const bytes = (s: string): number[] => Array.from(enc(s))

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  question: 'Deploy to production?',
  detail: 'web-1, web-2',
  user: 'kara',
  host: 'laptop',
  cwd: '/home/kara/site',
  program: [enc('bash'), enc('./deploy.sh')],
  timeout: 60,
  ...over
})

describe('requests as maki’s Confirm app reads them', () => {
  it('lays one out as the app’s Request: the nonce, the time, then each part', () => {
    const r = request({ question: 'Go?', detail: 'd', user: 'u', host: 'h', cwd: '/c' })
    r.program = [enc('sh'), enc('x y')]
    const body = confirmBody(r, new Uint8Array(32).fill(9))
    expect(Array.from(body)).toEqual([
      ...Array(32).fill(9),
      60,
      0,
      ...[3, ...bytes('Go?')],
      ...[1, 0, ...bytes('d')],
      ...[1, ...bytes('u')],
      ...[1, ...bytes('h')],
      ...[2, 0, ...bytes('/c')],
      ...[2, 2, 0, ...bytes('sh'), 3, 0, ...bytes('x y')],
      0
    ])
    expect(Array.from(confirmMessage(body).subarray(0, 2))).toEqual([0x43, 9])
    expect(() => confirmBody(r, new Uint8Array(31))).toThrow()
  })

  it('measures what maki shows as maki does: an escape for each byte past printable ASCII', () => {
    // as the app's tests have them
    expect(shownLength(enc('D\u{e9}ployer ?'))).toBe('D\\xc3\\xa9ployer ?'.length)
    expect(shownLength(enc('a\tb\\c\r\nnext line'), true)).toBe(
      'a\\x09b\\\\c\\x0d\nnext line'.length
    )
    expect(shownLength(enc('a\nb'))).toBe(6)
    // a command line's words, quoted as a shell takes them back
    const words = ['/bin/sh', '-c', "echo 'hi' there", 'a\nb', '']
    expect(words.map((w) => wordLength(enc(w)))).toEqual([
      '/bin/sh'.length,
      '-c'.length,
      "'echo '\\''hi'\\'' there'".length,
      "$'a\\nb'".length,
      "''".length
    ])
    expect(wordLength(enc('caf\u{e9}'))).toBe("$'caf\\xc3\\xa9'".length)
  })

  it('keeps as much of a command line as maki shows, and counts the words left out', () => {
    const long = (n: number): Uint8Array => enc('p'.repeat(n))
    expect(programFit([long(400), long(111)])).toEqual({ words: [long(400), long(111)], more: 0 })
    expect(programFit([long(400), long(112), enc('x')])).toEqual({ words: [long(400)], more: 2 })
    expect(programFit([long(600)])).toEqual({ words: [], more: 1 })
    const many = Array.from({ length: 300 }, () => enc('a'))
    expect(programFit(many)).toEqual({ words: many.slice(0, 255), more: 45 })
  })

  it('says why the app would turn a request down, and nothing for one it takes', () => {
    expect(confirmProblem(request())).toBeNull()
    expect(confirmProblem(request({ question: 'q'.repeat(64) }))).toBeNull()
    for (const over of [
      { question: '' },
      { question: '   ' },
      { question: 'q'.repeat(65) },
      { question: `${'q'.repeat(61)}\u{e9}` },
      { detail: 'd'.repeat(1025) },
      { detail: '\u0000'.repeat(257) },
      { user: '' },
      { host: '' },
      { user: 'u'.repeat(65) },
      { cwd: 'c'.repeat(513) },
      { timeout: 9 },
      { timeout: 81 },
      { timeout: 30.5 }
    ])
      expect(confirmProblem(request(over)), JSON.stringify(over)).toMatch(/\w/)
    expect(confirmProblem(request({ question: 'q'.repeat(65) }))).toMatch(/64 characters/)
  })

  it('reads the app’s answers, and checks a yes against the key alone', () => {
    const secret = ed25519.utils.randomSecretKey()
    const key = ed25519.getPublicKey(secret)
    const body = confirmBody(request(), new Uint8Array(32).fill(1))
    const signature = ed25519.sign(new Uint8Array([...SIGNED, ...body]), secret)
    const yes = confirmAnswer(Uint8Array.from([0, ...signature]))
    expect(yes).toEqual({ said: 'yes', signature })
    expect(verifyYes(key, body, signature)).toBe(true)
    // another request, another key, a changed signature: no
    const other = confirmBody(request(), new Uint8Array(32).fill(2))
    expect(verifyYes(key, other, signature)).toBe(false)
    expect(verifyYes(ed25519.getPublicKey(ed25519.utils.randomSecretKey()), body, signature)).toBe(
      false
    )
    const changed = signature.slice()
    changed[0] ^= 1
    expect(verifyYes(key, body, changed)).toBe(false)
    expect(verifyYes(key.subarray(1), body, signature)).toBe(false)
    expect(verifyYes(new Uint8Array(32).fill(0xff), body, signature)).toBe(false)
    // the rest of what it says
    expect([1, 2, 3, 4, 9].map((c) => confirmAnswer(Uint8Array.of(c)).said)).toEqual([
      'no',
      'no answer',
      'locked',
      'refused',
      'odd'
    ])
    expect(confirmAnswer(Uint8Array.of(0)).said).toBe('odd')
    expect(confirmAnswer(Uint8Array.from([0, ...signature, 0])).said).toBe('odd')
    expect(confirmSays('no match', null)).toMatch(/isn’t installed/)
    expect(confirmSays('approved', { said: 'no' })).toBe('you said no on maki')
  })

  it('writes key files and reads them back, as many keys as they hold', () => {
    const a = new Uint8Array(32).fill(0xab)
    const b = new Uint8Array(32).fill(0x01)
    const line = keyLine(a, 'uni roll!')
    expect(line).toBe(`maki-confirm-ed25519 ${Buffer.from(a).toString('base64')} uniroll\n`)
    expect(
      keysIn(
        `# mine\n${line}${keyLine(b, '')}maki-sudo-ed25519 ${Buffer.from(b).toString('base64')} x\nmaki-confirm-ed25519 short\n`
      )
    ).toEqual([a, b])
    expect(keyHex(a)).toEqual(Array(4).fill('abababababababab'))
    expect(keyOf(Uint8Array.from([0, ...a]))).toEqual(a)
    expect(keyOf(Uint8Array.of(3))).toBeNull()
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('maki’s Confirm app on the fake maki', () => {
  const fakes: ChildProcess[] = []
  afterAll(() => fakes.forEach((p) => p.kill()))
  const client = async (args: string[] = []): Promise<MakiClient> => {
    const fake = await startFake(['--app', join(APP_FIXTURES, 'confirm.maki'), ...args])
    fakes.push(fake.proc)
    return new MakiClient(await TcpTransport.open(fake.port))
  }
  let maki: MakiClient
  let key: Uint8Array
  beforeAll(async () => {
    maki = await client()
    key = keyOf((await maki.appMessage(CONFIRM_APP, Uint8Array.of(0x50))).answer)!
    expect(key).toHaveLength(32)
  })
  const ask = async (
    r: ConfirmRequest,
    nonce = 7
  ): Promise<{ body: Uint8Array; answer: ReturnType<typeof confirmAnswer> }> => {
    const body = confirmBody(r, new Uint8Array(32).fill(nonce))
    const got = await maki.appMessage(CONFIRM_APP, confirmMessage(body))
    expect(got.status).toBe('approved')
    return { body, answer: confirmAnswer(got.answer) }
  }

  it('signs what maki showed, as far as its limits go, and the key checks it', async () => {
    const r = request({
      question: 'q'.repeat(64),
      detail: 'd'.repeat(1024),
      user: 'u'.repeat(64),
      host: 'h'.repeat(64),
      cwd: 'c'.repeat(512),
      program: [enc('p'.repeat(400)), enc('p'.repeat(111)), enc('left out')]
    })
    expect(confirmProblem(r)).toBeNull()
    const { body, answer } = await ask(r)
    expect(answer.said).toBe('yes')
    expect(answer.said === 'yes' && verifyYes(key, body, answer.signature)).toBe(true)
  })

  it('turns down just what confirmProblem does, without asking', async () => {
    for (const over of [
      { question: 'q'.repeat(65) },
      { question: `${'q'.repeat(61)}\u{e9}` },
      { detail: 'd'.repeat(1025) },
      { user: 'u'.repeat(65) },
      { host: 'h'.repeat(65) },
      { cwd: 'c'.repeat(513) },
      { question: ' ' },
      { timeout: 9 }
    ]) {
      const r = request(over)
      expect(confirmProblem(r), JSON.stringify(over)).not.toBeNull()
      expect((await ask(r)).answer.said, JSON.stringify(over)).toBe('refused')
    }
  })

  it('says so when maki’s owner says no, and signs nothing', async () => {
    const no = await client(['--deny'])
    const body = confirmBody(request(), new Uint8Array(32).fill(3))
    const got = await no.appMessage(CONFIRM_APP, confirmMessage(body))
    expect(confirmAnswer(got.answer).said).toBe('no')
  })
})
