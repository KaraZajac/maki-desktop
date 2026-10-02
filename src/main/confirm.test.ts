/**
 * maki-confirm: its arguments, what it sends and how it takes each answer from a stand-in for
 * maki's Confirm app, and what it exits with; then the whole way, through maki desktop's socket and
 * the link, to the Confirm app on the fake maki: a yes checked against the key file --public-key
 * wrote, another maki's key turned down, and a no.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONFIRM_APP, keyLine, keysIn, SIGNED } from '../shared/confirm'
import { Link } from '../shared/link'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { askOver, type AskApp } from './age-plugin'
import { forWindow, serveBridge } from './bridge'
import { EXIT, parentCommand, runConfirm, USAGE, type Who } from './confirm'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

const ME: Who = {
  user: 'kara',
  host: 'laptop',
  cwd: '/home/kara/site',
  program: [enc('bash'), enc('./deploy.sh'), enc('production')]
}

type Say = 'yes' | 'no' | 'no answer' | 'locked' | 'refused' | 'odd' | 'forged'

/** A stand-in for maki's Confirm app: a key of its own, answering as the app does; what it was sent. */
function standIn(say: Say = 'yes'): { ask: AskApp; key: Uint8Array; sent: Uint8Array[] } {
  const secret = ed25519.utils.randomSecretKey()
  const key = ed25519.getPublicKey(secret)
  const sent: Uint8Array[] = []
  const ask: AskApp = async (m) => {
    sent.push(m)
    if (m.length === 1 && m[0] === 0x50)
      return { status: 'approved', answer: Uint8Array.of(0, ...key) }
    const codes: Partial<Record<Say, number>> = { no: 1, 'no answer': 2, locked: 3, refused: 4 }
    if (say in codes) return { status: 'approved', answer: Uint8Array.of(codes[say]!) }
    if (say === 'odd') return { status: 'approved', answer: Uint8Array.of(0, 1, 2) }
    // what the app signs: its words, then everything after the C; or something else, forged
    const signed =
      say === 'forged'
        ? enc('maki confirm approval\0something else')
        : Uint8Array.from([...SIGNED, ...m.subarray(1)])
    return { status: 'approved', answer: Uint8Array.of(0, ...ed25519.sign(signed, secret)) }
  }
  return { ask, key, sent }
}

/** maki-confirm's output, and what it exited with. */
async function confirm(
  args: string[],
  ask: AskApp,
  input = ''
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runConfirm(['electron', 'out/main/index.js', '--maki-confirm', ...args], {
    output: (t) => (out += t),
    error: (l) => (err += `${l}\n`),
    ask,
    who: () => ME,
    input: async () => input
  })
  return { code, out, err }
}

/** A request's parts, read back as the app reads them. */
function parts(m: Uint8Array): Record<string, unknown> {
  let at = 1 + 32
  const u16 = (): number => m[at++] | (m[at++] << 8)
  const take = (n: number): string => text(m.subarray(at, (at += n)))
  const timeout = u16()
  const question = take(m[at++])
  const detail = take(u16())
  const user = take(m[at++])
  const host = take(m[at++])
  const cwd = take(u16())
  const program = Array.from({ length: m[at++] }, () => take(u16()))
  const more = m[at++]
  return { timeout, question, detail, user, host, cwd, program, more, rest: m.length - at }
}

describe('maki-confirm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maki-confirm-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('asks with the question, the details and who asked where, and exits 0 on a yes', async () => {
    const app = standIn()
    const r = await confirm(['Deploy to production?', '--detail', 'web-1, web-2'], app.ask)
    expect(r.code, r.err).toBe(EXIT.yes)
    expect(r.out).toBe('')
    expect(app.sent).toHaveLength(1)
    expect(app.sent[0][0]).toBe(0x43)
    expect(parts(app.sent[0])).toEqual({
      timeout: 60,
      question: 'Deploy to production?',
      detail: 'web-1, web-2',
      user: 'kara',
      host: 'laptop',
      cwd: '/home/kara/site',
      program: ['bash', './deploy.sh', 'production'],
      more: 0,
      rest: 0
    })
    // a fresh nonce each time
    await confirm(['Deploy to production?'], app.ask)
    expect(app.sent[1].subarray(1, 33)).not.toEqual(app.sent[0].subarray(1, 33))
    // without a key file, it says whose word it took
    expect(r.err).toMatch(/maki desktop’s word for it: --key checks it/)
    // the time to answer, and options as --flag=value too
    await confirm(['Go?', '--timeout=15', '-d', ''], app.ask)
    expect(parts(app.sent[2])).toMatchObject({ timeout: 15, question: 'Go?', detail: '' })
  })

  it('checks a yes against the key file: maki’s goes ahead; another’s, or a forged one, doesn’t', async () => {
    const app = standIn()
    const mine = join(dir, 'mine.pub')
    const theirs = join(dir, 'theirs.pub')
    writeFileSync(mine, keyLine(app.key, 'uni'))
    writeFileSync(theirs, keyLine(standIn().key, 'roll'))
    const yes = await confirm(['Deploy?', '--key', mine], app.ask)
    expect(yes.code, yes.err).toBe(EXIT.yes)
    expect(yes.err).toMatch(/signed with the key in/)
    // a file of several keys: any of them
    writeFileSync(join(dir, 'both.pub'), `${keyLine(standIn().key, 'a')}${keyLine(app.key, 'b')}`)
    expect((await confirm(['Deploy?', '-k', join(dir, 'both.pub')], app.ask)).code).toBe(EXIT.yes)
    const other = await confirm(['Deploy?', '--key', theirs], app.ask)
    expect(other.code).toBe(EXIT.unchecked)
    expect(other.err).toMatch(/isn’t signed with a key in/)
    const forged = standIn('forged')
    writeFileSync(join(dir, 'forged.pub'), keyLine(forged.key, 'f'))
    expect((await confirm(['Deploy?', '--key', join(dir, 'forged.pub')], forged.ask)).code).toBe(
      EXIT.unchecked
    )
  })

  it('exits 1 on a no, 3 with no answer, 4 when maki can’t be asked, 5 when the answer is odd', async () => {
    const code = async (say: Say): Promise<number> =>
      (await confirm(['Go?'], standIn(say).ask)).code
    expect(await code('no')).toBe(EXIT.no)
    expect(await code('no answer')).toBe(EXIT.noAnswer)
    expect(await code('locked')).toBe(EXIT.unasked)
    expect(await code('refused')).toBe(EXIT.unasked)
    expect(await code('odd')).toBe(EXIT.unchecked)
    const status =
      (s: string): AskApp =>
      async () => ({ status: s, answer: new Uint8Array() })
    for (const s of ['no match', 'locked', 'unavailable', 'denied']) {
      const r = await confirm(['Go?'], status(s))
      expect(r.code, s).toBe(EXIT.unasked)
    }
    expect((await confirm(['Go?'], status('no match'))).err).toMatch(/isn’t installed/)
    const gone: AskApp = async () => {
      throw new Error('maki desktop isn’t running: start it, with maki plugged in')
    }
    const r = await confirm(['Go?'], gone)
    expect(r.code).toBe(EXIT.unasked)
    expect(r.err).toMatch(/maki desktop isn’t running/)
  })

  it('exits 2 when it was run wrong, and asks maki nothing then', async () => {
    const app = standIn()
    const empty = join(dir, 'empty.pub')
    writeFileSync(empty, '# nothing here\n')
    for (const args of [
      [],
      ['one', 'two'],
      ['Go?', '--what'],
      ['Go?', '--detail'],
      ['Go?', '--timeout', '9'],
      ['Go?', '--timeout', '81'],
      ['Go?', '-t', 'soon'],
      ['Go?', '--key', join(dir, 'missing.pub')],
      ['Go?', '--key', empty],
      ['q'.repeat(65)],
      ['Go?', '--detail', 'd'.repeat(1025)],
      ['--public-key', 'extra']
    ]) {
      const r = await confirm(args, app.ask)
      expect(r.code, args.join(' ')).toBe(EXIT.usage)
      expect(r.err).toMatch(/^maki-confirm: /)
    }
    expect(app.sent).toEqual([])
    // a question that starts with a dash, after --
    expect((await confirm(['--', '-rf everything?'], app.ask)).code).toBe(EXIT.yes)
    expect(parts(app.sent[0]).question).toBe('-rf everything?')
    // help
    const help = await confirm(['--help'], app.ask)
    expect(help.code).toBe(EXIT.yes)
    expect(help.out).toBe(USAGE)
    expect(USAGE).toMatch(/Without --key, maki-confirm takes maki desktop's word/)
  })

  it('reads the details from stdin with --detail -, a line a line', async () => {
    const app = standIn()
    const r = await confirm(
      ['Push these?', '--detail', '-'],
      app.ask,
      'a1b2c3 Fix it\r\nd4e5f6 Ship it\n\n'
    )
    expect(r.code, r.err).toBe(EXIT.yes)
    expect(parts(app.sent[0]).detail).toBe('a1b2c3 Fix it\nd4e5f6 Ship it')
  })

  it('prints Confirm’s key for a key file, and maki’s hex to compare it with', async () => {
    const app = standIn()
    const r = await confirm(['--public-key'], app.ask)
    expect(r.code).toBe(EXIT.yes)
    expect(r.out).toBe(keyLine(app.key, 'maki'))
    expect(keysIn(r.out)).toEqual([app.key])
    const hex = Buffer.from(app.key).toString('hex')
    expect(r.err).toContain(`  ${hex.slice(0, 16)}\n  ${hex.slice(16, 32)}`)
    const locked: AskApp = async () => ({ status: 'approved', answer: Uint8Array.of(3) })
    const no = await confirm(['--public-key'], locked)
    expect(no.code).toBe(EXIT.unasked)
    expect(no.err).toMatch(/maki is locked/)
  })

  it('finds the program that asked: its command line, past maki-confirm’s own processes', () => {
    const procs: Record<string, string> = {
      '/proc/40/cmdline':
        '/opt/maki/maki.AppImage\0--ozone-platform=headless\0--maki-confirm\0Go?\0',
      '/proc/40/status': 'Name:\tmaki\nPPid:\t30\n',
      '/proc/30/cmdline': 'bash\0./deploy.sh\0\0with space\0',
      '/proc/30/status': 'PPid:\t1\n'
    }
    const read = (p: string): Buffer => {
      if (!(p in procs)) throw new Error('gone')
      return Buffer.from(procs[p])
    }
    if (process.platform === 'linux') {
      expect(parentCommand(30, read).map(text)).toEqual(['bash', './deploy.sh', '', 'with space'])
      expect(parentCommand(40, read).map(text)).toEqual(['bash', './deploy.sh', '', 'with space'])
      expect(parentCommand(99, read)).toEqual([])
    }
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'maki-confirm with the link and the fake maki',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'maki-confirm-'))
    const running: { fake: ChildProcess; link: Link; server: Server }[] = []
    afterAll(() => {
      for (const r of running) {
        r.server.close()
        r.link.drop()
        r.fake.kill()
      }
      rmSync(dir, { recursive: true, force: true })
    })

    /** A fake maki with the Confirm app, linked to a Link of its own behind a socket. */
    const linked = async (name: string, args: string[] = []): Promise<AskApp> => {
      const fake = await startFake(['--app', join(APP_FIXTURES, 'confirm.maki'), ...args])
      const link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      const socket = join(dir, `${name}.sock`)
      const server = await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), socket)
      running.push({ fake: fake.proc, link, server })
      return askOver(socket, CONFIRM_APP)
    }

    it('goes ahead on maki’s yes, signed with the key --public-key wrote; not with another', async () => {
      const ask = await linked('yes')
      const keyFile = join(dir, 'maki-confirm.pub')
      const printed = await confirm(['--public-key'], ask)
      expect(printed.code, printed.err).toBe(EXIT.yes)
      writeFileSync(keyFile, printed.out)
      const yes = await confirm(['Deploy to production?', '-d', 'web-1, web-2', '-k', keyFile], ask)
      expect(yes.code, yes.err).toBe(EXIT.yes)
      // the key of a maki restored from another phrase isn't this one's
      const other = await linked('other', [
        '--phrase',
        'legal winner thank year wave sausage worth useful legal winner thank yellow'
      ])
      const theirs = await confirm(['Deploy to production?', '-k', keyFile], other)
      expect(theirs.code, theirs.err).toBe(EXIT.unchecked)
      expect(readFileSync(keyFile, 'utf8')).toBe(printed.out)
    })

    it('stops on a no', async () => {
      const ask = await linked('no', ['--deny'])
      const r = await confirm(['Drop the users table?'], ask)
      expect(r.code).toBe(EXIT.no)
      expect(r.err).toMatch(/you said no on maki/)
    })
  }
)
