/**
 * maki-confirm: a script or program asks maki before it goes ahead with something that matters
 * (a deploy, terraform apply, a force push, a database migration), and goes ahead only on maki's
 * owner's yes. It sends maki's Confirm app the question, more about it, and who's asking where
 * (this user, this computer, the directory, the program that ran it), through the tray app's
 * socket and the link; maki shows all of it and asks. A yes is a signature of the request with
 * Confirm's key, from maki's recovery phrase: with --key, maki-confirm checks it against the keys
 * in a key file, so nothing on this computer can say yes for maki, nor use an old yes again.
 * Without --key it takes maki desktop's word, as its help says.
 *
 *     maki-confirm QUESTION [-d DETAIL] [-k KEYFILE] [-t SECONDS]
 *     maki-confirm --public-key
 *
 * It exits 0 on a yes (one that checks out, with --key), 1 on a no, 2 when it was run wrong, 3
 * when nobody answered in time, 4 when maki couldn't be asked, 5 when maki's yes didn't check out.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import type { Readable } from 'node:stream'
import {
  confirmAnswer,
  confirmBody,
  confirmMessage,
  confirmProblem,
  confirmSays,
  DEFAULT_S,
  keyHex,
  keyLine,
  keyOf,
  keysIn,
  LATEST_S,
  SOONEST_S,
  verifyYes
} from '../shared/confirm'
import type { AskApp } from './age-plugin'
import type { Command } from './scripts'

export const CONFIRM_COMMAND: Command = {
  name: 'maki-confirm',
  flag: '--maki-confirm',
  why: 'asks maki before a script goes ahead'
}

/** What it exits with. */
export const EXIT = { yes: 0, no: 1, usage: 2, noAnswer: 3, unasked: 4, unchecked: 5 } as const

/** Who's asking, where: as maki shows it. */
export interface Who {
  user: string
  host: string
  cwd: string
  /** the program that ran maki-confirm: its command line, a word each */
  program: Uint8Array[]
}

export interface ConfirmIO {
  /** what goes to stdout */
  output: (text: string) => void
  /** a line to stderr */
  error: (line: string) => void
  /** maki's Confirm app */
  ask: AskApp
  who: () => Who
  /** all of stdin, for --detail - */
  input: () => Promise<string>
  /** a fresh nonce: 32 random bytes */
  nonce?: () => Uint8Array
}

export const USAGE = `maki-confirm: ask maki before going ahead, and wait for your yes on it

  maki-confirm QUESTION [-d DETAIL] [-k KEYFILE] [-t SECONDS]
  maki-confirm --public-key       Confirm's key, for a key file: compare it with maki's

  -d, --detail TEXT    more about it, shown on maki before the question (- reads stdin)
  -k, --key FILE       check maki's yes against the keys in FILE (--public-key's lines)
  -t, --timeout SEC    how long maki waits for your answer: ${SOONEST_S} to ${LATEST_S} seconds (${DEFAULT_S})

maki shows the question, the details, and who asked where: you, this computer, the
directory, and the program that ran maki-confirm.

Without --key, maki-confirm takes maki desktop's word for your answer: anything that
can stand in for maki desktop on this computer could say yes. With --key, only maki's
own key can, and an old yes can't be used again: keep the key file where nothing else
can change it.

It exits 0 on your yes, 1 on a no, 2 if it was run wrong, 3 if nobody answered in time,
4 if maki couldn't be asked, and 5 if maki's yes didn't check out against the key file.
`

interface Options {
  question?: string
  detail?: string
  key?: string
  timeout: number
  publicKey: boolean
  help: boolean
}

/** Its arguments: a question, and the options; or what's wrong with them. */
function parse(args: string[]): Options | string {
  const o: Options = { timeout: DEFAULT_S, publicKey: false, help: false }
  const words: string[] = []
  const takes = new Map<string, 'detail' | 'key' | 'timeout'>([
    ['-d', 'detail'],
    ['--detail', 'detail'],
    ['-k', 'key'],
    ['--key', 'key'],
    ['-t', 'timeout'],
    ['--timeout', 'timeout']
  ])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      words.push(...args.slice(i + 1))
      break
    }
    // --key=FILE as well as --key FILE
    const [flag, joined]: (string | undefined)[] =
      a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s) : [a]
    const which = takes.get(flag!)
    if (flag === '-h' || flag === '--help') o.help = true
    else if (flag === '--public-key') o.publicKey = true
    else if (which) {
      const v = joined ?? args[++i]
      if (v === undefined) return `${flag} needs something after it`
      if (which === 'timeout') {
        if (!/^\d+$/.test(v) || +v < SOONEST_S || +v > LATEST_S)
          return `${flag} is ${SOONEST_S} to ${LATEST_S} seconds`
        o.timeout = +v
      } else o[which] = v
    } else if (a.startsWith('-') && a !== '-') return `what is ${a}?`
    else words.push(a)
  }
  if (o.help || o.publicKey) return words.length === 0 ? o : `what is ${words[0]}?`
  if (words.length === 0) return 'what should maki ask? Give the question first'
  if (words.length > 1) return `one question at a time: put it in quotes (what is ${words[1]}?)`
  o.question = words[0]
  return o
}

/** Text from stdin as maki shows details: lines ending in a new line alone, none at the end. */
function tidy(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

/** Confirm's key, from maki. */
async function makiKey(ask: AskApp): Promise<Uint8Array> {
  const r = await ask(Uint8Array.of('P'.charCodeAt(0)))
  const key = r.status === 'approved' ? keyOf(r.answer) : null
  if (key) return key
  throw new Error(
    r.status === 'approved' && r.answer[0] === 3
      ? 'maki is locked: enter its PIN first'
      : confirmSays(r.status, null)
  )
}

export async function runConfirm(argv: string[], io: ConfirmIO): Promise<number> {
  const at = argv.indexOf(CONFIRM_COMMAND.flag)
  const o = parse(at >= 0 ? argv.slice(at + 1) : argv)
  if (typeof o === 'string') {
    io.error(`maki-confirm: ${o}`)
    io.error(USAGE)
    return EXIT.usage
  }
  if (o.help) {
    io.output(USAGE)
    return EXIT.yes
  }
  const fail = (code: number, why: string): number => {
    io.error(`maki-confirm: ${why}`)
    return code
  }
  try {
    if (o.publicKey) {
      const key = await makiKey(io.ask)
      io.output(keyLine(key, 'maki'))
      io.error(
        'maki-confirm: Confirm’s key. Compare it with what Confirm shows on maki, from its menu:'
      )
      for (const line of keyHex(key)) io.error(`  ${line}`)
      return EXIT.yes
    }

    // the key file first: a mistake there is the caller's, found before maki's owner is asked
    let keys: Uint8Array[] | null = null
    if (o.key !== undefined) {
      let text: string
      try {
        text = await readFile(o.key, 'utf8')
      } catch (e) {
        return fail(EXIT.usage, `can’t read ${o.key}: ${(e as Error).message}`)
      }
      keys = keysIn(text)
      if (keys.length === 0)
        return fail(
          EXIT.usage,
          `${o.key} has no maki-confirm key in it: make it with maki-confirm --public-key`
        )
    }
    const detail = o.detail === '-' ? tidy(await io.input()) : (o.detail ?? '')
    const request = { question: o.question!, detail, timeout: o.timeout, ...io.who() }
    const problem = confirmProblem(request)
    if (problem) return fail(EXIT.usage, problem)

    const body = confirmBody(request, io.nonce?.() ?? new Uint8Array(randomBytes(32)))
    io.error('maki-confirm: asking maki: look at its screen')
    const r = await io.ask(confirmMessage(body))
    const answer = r.status === 'approved' ? confirmAnswer(r.answer) : null
    if (answer?.said !== 'yes') {
      const code =
        answer?.said === 'no'
          ? EXIT.no
          : answer?.said === 'no answer'
            ? EXIT.noAnswer
            : answer?.said === 'odd'
              ? EXIT.unchecked
              : EXIT.unasked
      return fail(code, confirmSays(r.status, answer))
    }
    if (keys && !keys.some((k) => verifyYes(k, body, answer.signature)))
      return fail(
        EXIT.unchecked,
        `maki’s yes isn’t signed with a key in ${o.key}: another maki’s, or not maki’s at all`
      )
    io.error(
      keys
        ? `maki-confirm: you said yes on maki, signed with the key in ${o.key}`
        : 'maki-confirm: you said yes on maki (maki desktop’s word for it: --key checks it)'
    )
    return EXIT.yes
  } catch (e) {
    return fail(EXIT.unasked, (e as Error).message)
  }
}

const PROC = /^\d+$/

/**
 * The command line of the program that ran this, a word each, as Linux keeps it: the first
 * process up from this one that isn't maki-confirm itself (an AppImage's runtime, say). Elsewhere,
 * its name alone, or nothing.
 */
export function parentCommand(
  ppid: number = process.ppid,
  read: (path: string) => Buffer = (p) => readFileSync(p)
): Uint8Array[] {
  try {
    if (process.platform === 'linux') {
      let pid = String(ppid)
      for (let hops = 0; hops < 4 && PROC.test(pid) && pid !== '0'; hops++) {
        const raw = read(`/proc/${pid}/cmdline`)
        const words: Uint8Array[] = []
        let start = 0
        for (let i = 0; i <= raw.length; i++) {
          if (i === raw.length || raw[i] === 0) {
            if (i > start || i < raw.length) words.push(new Uint8Array(raw.subarray(start, i)))
            start = i + 1
          }
        }
        if (!words.some((w) => Buffer.from(w).toString() === CONFIRM_COMMAND.flag)) return words
        pid = /^PPid:\s*(\d+)$/m.exec(read(`/proc/${pid}/status`).toString())?.[1] ?? ''
      }
      return []
    }
    if (process.platform === 'darwin') {
      const name = execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], {
        encoding: 'utf8',
        timeout: 2000
      }).trim()
      return name ? [new TextEncoder().encode(name)] : []
    }
  } catch {
    // gone already, or not this user's to read: maki shows no program
  }
  return []
}

/** Who's asking from here: this user, this computer, the directory, the program that ran this. */
export function whoAsks(): Who {
  return {
    user: userInfo().username,
    host: hostname(),
    cwd: process.cwd(),
    program: parentCommand()
  }
}

/** All of a stream, as text. */
export async function readAll(input: Readable): Promise<string> {
  let text = ''
  input.setEncoding('utf8')
  for await (const chunk of input) text += chunk as string
  return text
}
