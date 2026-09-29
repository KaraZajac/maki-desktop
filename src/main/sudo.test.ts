/**
 * maki's sudo plugin: what maki desktop reads of sudo's setup and writes into it; then, with the
 * plugin itself (sudo/, built with cargo), loaded and called as sudo does by its test harness
 * (sudo/tests/approve.c), the whole way: through maki desktop's socket and the link, to the Sudo app on the fake maki,
 * which shows each command and signs it once the owner says yes (or doesn't).
 */
import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Link } from '../shared/link'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { forWindow, serveBridge } from './bridge'
import {
  INSTALL,
  KEY_FILE,
  keyLines,
  keyOf,
  keysIn,
  pluginLine,
  SUDO_APP,
  SUDO_CONF,
  sudoStatus,
  UNINSTALL
} from './sudo'

const KEY = '7Tg0BuoiCjCYPn09UWk3Czpx6m3r03pL9c7Kl0Ln4dI='

describe('sudo’s setup, as maki desktop reads it', () => {
  it('finds its line in sudo.conf, and the keys in the key file', () => {
    const conf =
      '# sudo.conf\nPath askpass /usr/bin/ssh-askpass\n  Plugin maki_approval /usr/local/libexec/maki/maki_sudo.so users=kara,alice\n'
    expect(pluginLine(conf)).toEqual({
      path: '/usr/local/libexec/maki/maki_sudo.so',
      options: ['users=kara,alice']
    })
    expect(pluginLine('Plugin sudoers_policy sudoers.so\n#Plugin maki_approval x.so\n')).toBeNull()
    expect(
      keysIn(`# uni\nmaki-sudo-ed25519 ${KEY} uni\nssh-ed25519 AAAA\nmaki-sudo-ed25519 short\n`)
    ).toEqual([KEY])
    expect(keyLines(KEY)).toEqual([
      'ed383406ea220a30',
      '983e7d3d5169370b',
      '3a71ea6debd37a4b',
      'f5ceca9742e7e1d2'
    ])
    expect(keyOf(Uint8Array.of(0, ...Buffer.from(KEY, 'base64')))).toBe(KEY)
    expect(keyOf(Uint8Array.of(3))).toBeNull()
  })

  it('says whether it’s on, for whom, and whether sudo starts with it', async () => {
    const files = new Map([
      [SUDO_CONF, 'Plugin maki_approval /usr/local/libexec/maki/maki_sudo.so users=kara\n'],
      [KEY_FILE, `maki-sudo-ed25519 ${KEY} uni\n`]
    ])
    const read = async (p: string): Promise<string> => {
      const t = files.get(p)
      if (t === undefined) throw new Error('ENOENT')
      return t
    }
    const said =
      "Sudo version 1.9.17p2\nSudoers policy plugin version 1.9.17p2\nmaki's sudo approval plugin version 0.1.0\n"
    expect(await sudoStatus('linux', read, async () => said)).toEqual({
      unavailable: null,
      version: '1.9.17p2',
      on: true,
      users: ['kara'],
      keys: [KEY],
      loads: true,
      problem: null
    })
    // sudo won't start: the plugin's why
    const stopped = await sudoStatus('linux', read, async () => {
      throw new Error(
        "maki: sudo can't ask maki: the key file /etc/maki/sudo.pub isn't root's\nsudo: error initializing approval plugin maki_approval"
      )
    })
    expect(stopped).toMatchObject({ on: true, problem: expect.stringContaining('approval plugin') })
    // off, too old, or not here
    files.delete(SUDO_CONF)
    expect(await sudoStatus('linux', read, async () => 'Sudo version 1.9.5\n')).toMatchObject({
      on: false,
      users: null,
      loads: false
    })
    expect(
      (await sudoStatus('linux', read, async () => 'Sudo version 1.8.31\n')).unavailable
    ).toMatch(/older than 1.9/)
    expect((await sudoStatus('darwin', read, async () => said)).unavailable).toMatch(/Linux/)
    expect(
      (
        await sudoStatus('linux', read, async () => {
          throw new Error('spawn sudo ENOENT')
        })
      ).unavailable
    ).toMatch(/no sudo/)
  })

  it('writes its scripts for sh, checking what it’s handed', () => {
    for (const script of [INSTALL, UNINSTALL]) {
      execFileSync('sh', ['-n', '-c', script]) // it parses
    }
    // anything odd stops it before it touches the system
    const tries: [string, string, string, string, string][] = [
      ['/x.so', 'ab', 'short', 'uni', 'kara'],
      ['/x.so', 'ab', `${KEY.slice(0, 43)};`, 'uni', 'kara'],
      ['/x.so', 'ab', KEY, 'u ni', 'kara'],
      ['/x.so', 'ab', KEY, 'uni', '-kara'],
      ['/x.so', 'ab', KEY, 'uni', 'ka ra'],
      ['/x.so', 'AB', KEY, 'uni', 'kara']
    ]
    for (const args of tries) {
      const r = (() => {
        try {
          execFileSync('sh', ['-c', INSTALL, 'maki-sudo', ...args], { stdio: 'pipe' })
          return ''
        } catch (e) {
          return String((e as { stderr?: Buffer }).stderr)
        }
      })()
      expect(r, args.join(' ')).toMatch(
        /^maki: (that isn't maki's key|maki's name is odd|that user name is odd|that isn't a hash)/
      )
    }
  })
})

const PLUGIN = resolve(__dirname, '../../sudo')
const have = (cmd: string): boolean => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const BUILDS = have('cargo') && have('cc')

describe.skipIf(!BUILDS || !FAKE_BUILT || !APP_FIXTURES_THERE || process.platform !== 'linux')(
  'the sudo plugin, called as sudo calls it, with the link and the fake maki',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'maki-sudo-'))
    const socket = join(dir, `maki-${userInfo().uid}.sock`)
    const keys = join(dir, 'keys', 'sudo.pub')
    let fakes: { port: number; proc: ChildProcess; said: string[] }[] = []
    let links: Link[] = []
    let servers: Server[] = []

    /** A fake maki with the Sudo app (installed at start: one that says no to everything would
     * turn down installing it), linked and behind a maki desktop socket of its own. */
    async function maki(args: string[], path: string): Promise<{ said: string[] }> {
      const fake = {
        ...(await startFake([...args, '--app', join(APP_FIXTURES, 'sudo.maki')])),
        said: [] as string[]
      }
      fake.proc.stdout!.on('data', (d: Buffer) => fake.said.push(d.toString()))
      fakes.push(fake)
      const link = new Link(async () => {
        throw new Error('offline')
      })
      link.autoSync = false
      links.push(link)
      expect(await link.attach(await TcpTransport.open(fake.port), 'fake maki')).toBe(true)
      servers.push(await serveBridge(async (r) => link.fromBrowser(await forWindow(r)), path))
      return fake
    }

    const harness = join(dir, 'approve')
    const approve = (
      options: string[],
      command: string[],
      env: Record<string, string> = {}
    ): Promise<{ code: number; err: string }> =>
      new Promise((ok) =>
        execFile(
          harness,
          [
            join(PLUGIN, 'target/debug/libmaki_sudo.so'),
            `key=${keys}`,
            ...options,
            '--',
            ...command
          ],
          { encoding: 'utf8', env: { ...process.env, ...env } },
          (e, _out, err) => ok({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err })
        )
      )

    let yes: { said: string[] }
    let no: { said: string[] }
    beforeAll(async () => {
      execFileSync('cargo', ['build', '--quiet', '--lib'], { cwd: PLUGIN, stdio: 'inherit' })
      execFileSync('cc', ['-o', harness, join(PLUGIN, 'tests/approve.c'), '-ldl'], {
        stdio: 'inherit'
      })
      yes = await maki([], socket)
      no = await maki(['--deny'], join(dir, 'deny.sock'))
      // maki's key, as setting it up takes it: from the Sudo app, into a key file of the test's
      const r = await links[0].appMessage(SUDO_APP, Uint8Array.of('P'.charCodeAt(0)))
      const key = keyOf(r.answer)
      expect(key).toBe(KEY) // the BIP39 test phrase's
      mkdirSync(join(dir, 'keys'))
      writeFileSync(keys, `maki-sudo-ed25519 ${key} uni\n`)
      chmodSync(join(dir, 'keys'), 0o755)
      chmodSync(keys, 0o644)
    }, 300_000)
    afterAll(() => {
      servers.forEach((s) => s.close())
      links.forEach((l) => l.drop())
      fakes.forEach((f) => f.proc.kill())
      rmSync(dir, { recursive: true, force: true })
    })

    it('runs a command once maki’s owner says yes to it, shown whole on maki', async () => {
      const r = await approve([`socket=${socket}`], ['/usr/bin/systemctl', 'restart', 'nginx'])
      expect(r.err).toContain("look at maki's screen")
      expect(r.code, r.err).toBe(0)
      const shown = yes.said.join('')
      expect(shown).toContain('shows [Command] systemctl /usr/bin/systemctl restart nginx')
      expect(shown).toMatch(/Run it as root\? sudo on /)
      // what the command line sets for it, it shows; and what every command gets, it doesn't
      const preload = await approve([`socket=${socket}`], ['/usr/bin/true'], {
        MAKI_TEST_ENV: 'LD_PRELOAD=/tmp/evil.so'
      })
      expect(preload.code, preload.err).toBe(0)
      expect(yes.said.join('')).toContain('shows [Given]  LD_PRELOAD=/tmp/evil.so')
      expect(yes.said.join('')).not.toContain('SUDO_COMMAND=')
    })

    it('doesn’t run it when maki’s owner says no, or maki can’t be asked, or answers with another key', async () => {
      const denied = await approve([`socket=${join(dir, 'deny.sock')}`], ['/usr/bin/id'])
      expect(denied.code).toBe(1)
      expect(denied.err).toContain('you said no on maki')
      expect(no.said.join('')).toContain('shows [Command] id /usr/bin/id')
      const gone = await approve([`socket=${join(dir, 'gone.sock')}`], ['/usr/bin/id'])
      expect(gone.code).toBe(1)
      expect(gone.err).toContain("maki desktop isn't running")
      // a key file with another maki's key: the yes doesn't count
      const other = join(dir, 'other')
      mkdirSync(other)
      chmodSync(other, 0o755)
      writeFileSync(
        join(other, 'sudo.pub'),
        `maki-sudo-ed25519 ${Buffer.alloc(32, 1).toString('base64')}\n`
      )
      chmodSync(join(other, 'sudo.pub'), 0o644)
      const r = await new Promise<{ code: number; err: string }>((ok) =>
        execFile(
          harness,
          [
            join(PLUGIN, 'target/debug/libmaki_sudo.so'),
            `key=${join(other, 'sudo.pub')}`,
            `socket=${socket}`,
            '--',
            '/usr/bin/id'
          ],
          { encoding: 'utf8' },
          (e, _o, err) => ok({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err })
        )
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain("isn't signed by the maki sudo trusts")
    })
  }
)

// the plugin's own tests, and the harness's, run with cargo in sudo/
if (!existsSync(join(PLUGIN, 'Cargo.toml'))) throw new Error('sudo/ is missing')
