import { useEffect, useState } from 'react'
import { AGE_APP, identityFile, recipientOf, type AgePluginStatus } from '@shared/age'
import { SSH_APP } from '@shared/bridge-types'
import type { CommandStatus } from '@shared/commands'
import type { Link } from '@shared/link'
import { armour, OPENPGP_APP, PGP_OK, pgpSays, userId } from '@shared/openpgp'
import {
  keyIdHex,
  MINISIGN_APP,
  parseKeyAnswer,
  publicKeyFile,
  publicKeyText,
  type MinisignKey
} from '@shared/minisign'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Badge, Button, Card, Field, Glyph, Label, PageHeader } from './ui'
import { GetIt } from './AppNeeded'

/** What ssh, git, gpg, age and minisign reach maki for: keys from the recovery phrase, each use asked. */
export function KeysPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const [agent, setAgent] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.ssh.socket().then(setAgent)
  }, [])
  const ssh = apps.apps?.find((a) => a.id === SSH_APP)

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="computer"
        title="SSH, Git & keys"
        lede="ssh, git, gpg, age and minisign use keys maki makes from your recovery phrase, through maki desktop: they ask, and maki asks you on its own screen before every sign-in, signature and decryption."
      />

      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
            <Glyph name="terminal" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Label>ssh and git</Label>
            {ssh && agent ? (
              <>
                <p className="mt-2 text-sm text-subtext1">
                  maki desktop is an SSH agent for {ssh.name}, which asks you on maki before every
                  sign-in and signature, with the user and the server’s key. Point ssh at it:
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                    export SSH_AUTH_SOCK={agent}
                  </code>
                  <Button
                    small
                    onClick={async () => {
                      await window.maki.copy(`export SSH_AUTH_SOCK=${agent}`)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-overlay1">
                  Then <code className="font-mono text-subtext0">ssh-add -L</code> shows its public
                  key, for a server’s authorized_keys. Turn on the certificate authority in the SSH
                  app’s menu, and{' '}
                  <code className="font-mono text-subtext0">ssh-keygen -s ca.pub -U</code> signs
                  certificates with its key, each one read out on maki first.
                </p>
                <GitSigning link={link} />
              </>
            ) : (
              <div className="mt-2 flex items-center justify-between gap-4">
                <p className="text-sm text-subtext1">
                  With maki’s SSH app installed, maki desktop is an SSH agent: an SSH key from your
                  recovery phrase, and every sign-in and git signature waits for your yes on maki.
                </p>
                <GetIt apps={apps} go={go} />
              </div>
            )}
          </div>
        </div>
      </Card>

      <Age link={link} apps={apps} go={go} />

      <Minisign link={link} apps={apps} go={go} />

      <OpenPgp link={link} apps={apps} go={go} />
    </div>
  )
}

/** age: maki's age key, age-plugin-maki where age finds it, and the identity file that names it. */
function Age({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === AGE_APP)
  const linked = link.state.linked
  const [plugin, setPlugin] = useState<AgePluginStatus | null>(null)
  const [recipient, setRecipient] = useState<Uint8Array | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.age.status().then(setPlugin)
  }, [])
  // the recipient, from maki's Age app (it starts out of sight to answer)
  useEffect(() => {
    if (!installed || !linked) return
    link.appMessage(AGE_APP, Uint8Array.of(1)).then(
      (r) => {
        if (r.status === 'approved' && r.answer[0] === 0 && r.answer.length === 33)
          setRecipient(r.answer.slice(1))
        else
          setProblem(
            r.answer[0] === 3 ? 'maki is locked: enter its PIN' : `maki’s Age app: ${r.status}`
          )
      },
      (e: Error) => setProblem(e.message)
    )
  }, [link, installed, linked])
  const r = recipient ? recipientOf(recipient) : null

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="lock" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>age</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Age app installed, maki keeps an age key from your recovery phrase:
                anyone encrypts files to it with age, and decrypting one asks you on maki.
              </p>
              <GetIt apps={apps} go={go} />
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki keeps an age key. Anyone encrypts files to it with age, to its recipient;
                decrypting one asks you on maki first, through age-plugin-maki.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                  {r ?? (linked ? 'asking maki…' : 'plug maki in to see its recipient')}
                </code>
                <Button
                  small
                  disabled={!r}
                  onClick={async () => {
                    await window.maki.copy(r!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 text-sm text-fg">
                    age-plugin-maki
                    {plugin && (
                      <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                        {plugin.path}
                      </span>
                    )}
                  </span>
                  {plugin?.installed ? (
                    <Badge kind="built">
                      <Glyph name="check" className="h-3 w-3" /> installed
                    </Badge>
                  ) : (
                    <Button
                      small
                      kind="ghost"
                      onClick={async () => {
                        try {
                          setPlugin(await window.maki.age.install())
                          link.note('age-plugin-maki installed: age can ask maki to decrypt')
                        } catch (e) {
                          setProblem((e as Error).message)
                        }
                      }}
                    >
                      Install
                    </Button>
                  )}
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm text-fg">
                    Your identity file, which names maki’s key
                  </span>
                  <Button
                    small
                    kind="ghost"
                    glyph="download"
                    disabled={!recipient}
                    onClick={async () => {
                      const path = await window.maki.age.save(identityFile(recipient!))
                      if (path) link.note(`age identity saved to ${path}`)
                    }}
                  >
                    Save…
                  </Button>
                </li>
              </ul>
              {plugin && plugin.installed && !plugin.onPath && (
                <p className="mt-2 text-xs text-yellow">
                  Its folder isn’t on your PATH, where age looks for plugins: add it.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-overlay1">
                <code className="font-mono text-subtext0">
                  age -r {r ? `${r.slice(0, 12)}…` : 'age1…'} -o notes.age notes.txt
                </code>{' '}
                encrypts;{' '}
                <code className="font-mono text-subtext0">age -d -i maki-age.txt notes.age</code>{' '}
                decrypts, once you say so on maki. The identity file holds nothing secret: it names
                maki’s key.
              </p>
              {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** minisign: maki's minisign key, maki-minisign on the PATH, and the public key to publish. */
function Minisign({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === MINISIGN_APP)
  const linked = link.state.linked
  const [command, setCommand] = useState<CommandStatus | null>(null)
  const [key, setKey] = useState<MinisignKey | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.minisign.status().then(setCommand)
  }, [])
  // the public key, from maki's Minisign app (it starts out of sight to answer)
  useEffect(() => {
    if (!installed || !linked) return
    link.appMessage(MINISIGN_APP, Uint8Array.of('P'.charCodeAt(0))).then(
      (r) => {
        const k = r.status === 'approved' ? parseKeyAnswer(r.answer) : null
        if (k) setKey(k)
        else
          setProblem(
            r.answer[0] === 3 ? 'maki is locked: enter its PIN' : `maki’s Minisign app: ${r.status}`
          )
      },
      (e: Error) => setProblem(e.message)
    )
  }, [link, installed, linked])
  const text = key ? publicKeyText(key) : null

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="file" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>minisign</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Minisign app installed, maki keeps a minisign key from your recovery
                phrase, for signing files and releases: each one waits for your yes on maki.
              </p>
              <GetIt apps={apps} go={go} />
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki keeps a minisign key. maki-minisign signs a file once you say so on maki, which
                signs when it did by its own clock; anyone checks it with minisign and this key
                {key ? ` (${keyIdHex(key.id)})` : ''}.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                  {text ?? (linked ? 'asking maki…' : 'plug maki in to see its public key')}
                </code>
                <Button
                  small
                  disabled={!text}
                  onClick={async () => {
                    await window.maki.copy(text!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 text-sm text-fg">
                    maki-minisign
                    {command && (
                      <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                        {command.path}
                      </span>
                    )}
                  </span>
                  {command?.installed ? (
                    <Badge kind="built">
                      <Glyph name="check" className="h-3 w-3" /> installed
                    </Badge>
                  ) : (
                    <Button
                      small
                      kind="ghost"
                      onClick={async () => {
                        try {
                          setCommand(await window.maki.minisign.install())
                          link.note('maki-minisign installed: it can ask maki to sign files')
                        } catch (e) {
                          setProblem((e as Error).message)
                        }
                      }}
                    >
                      Install
                    </Button>
                  )}
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm text-fg">Your public key file, minisign.pub</span>
                  <Button
                    small
                    kind="ghost"
                    glyph="download"
                    disabled={!key}
                    onClick={async () => {
                      const path = await window.maki.minisign.save(publicKeyFile(key!))
                      if (path) link.note(`minisign public key saved to ${path}`)
                    }}
                  >
                    Save…
                  </Button>
                </li>
              </ul>
              {command && command.installed && !command.onPath && (
                <p className="mt-2 text-xs text-yellow">
                  Its folder isn’t on your PATH: add it to run maki-minisign by name.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-overlay1">
                <code className="font-mono text-subtext0">maki-minisign -Sm release.tar.gz</code>{' '}
                signs, once you say so on maki;{' '}
                <code className="font-mono text-subtext0">
                  minisign -Vm release.tar.gz -P {text ? `${text.slice(0, 10)}…` : 'RW…'}
                </code>{' '}
                checks it, anywhere.
              </p>
              {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** An SSH message's strings, from `at`; null if they aren't there. */
function sshStrings(b: Uint8Array, at: number, n: number): Uint8Array[] | null {
  const out: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    if (at + 4 > b.length) return null
    const len = new DataView(b.buffer, b.byteOffset + at).getUint32(0)
    if (at + 4 + len > b.length) return null
    out.push(b.slice(at + 4, at + 4 + len))
    at += 4 + len
  }
  return out
}

/** git's commits and tags signed on maki: maki-ssh-keygen, and git's settings for it. */
function GitSigning({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [command, setCommand] = useState<CommandStatus | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.sshKeygen.status().then(setCommand)
  }, [])
  // the SSH app's key, as ssh-add -L shows it: the first it offers
  useEffect(() => {
    if (!linked) return
    link.appMessage(SSH_APP, Uint8Array.of(0, 0, 0, 0, 11)).then(
      (r) => {
        const blob =
          r.status === 'approved' && r.answer[0] === 12 ? sshStrings(r.answer, 5, 1) : null
        if (blob) setKey(`ssh-ed25519 ${btoa(String.fromCharCode(...blob[0]))} maki`)
      },
      () => {}
    )
  }, [link, linked])
  const config = [
    'git config --global gpg.format ssh',
    'git config --global gpg.ssh.program maki-ssh-keygen',
    `git config --global user.signingkey "key::${key ?? 'ssh-ed25519 AAAA… maki'}"`,
    'git config --global commit.gpgsign true'
  ].join('\n')

  return (
    <div className="mt-5 border-t border-surface0 pt-4">
      <p className="text-sm text-subtext1">
        git can sign commits and tags on maki too, which shows each one’s subject and author before
        it signs: maki-ssh-keygen hands it the whole commit, in ssh-keygen’s place.
      </p>
      <ul className="mt-3 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
        <li className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="min-w-0 text-sm text-fg">
            maki-ssh-keygen
            {command && (
              <span className="ml-2 font-mono text-[0.68rem] text-overlay1">{command.path}</span>
            )}
          </span>
          {command?.installed ? (
            <Badge kind="built">
              <Glyph name="check" className="h-3 w-3" /> installed
            </Badge>
          ) : (
            <Button
              small
              kind="ghost"
              onClick={async () => {
                try {
                  setCommand(await window.maki.sshKeygen.install())
                  link.note('maki-ssh-keygen installed: git can sign on maki')
                } catch (e) {
                  link.note(`maki-ssh-keygen: ${(e as Error).message}`)
                }
              }}
            >
              Install
            </Button>
          )}
        </li>
      </ul>
      {command && command.installed && !command.onPath && (
        <p className="mt-2 text-xs text-yellow">
          Its folder isn’t on your PATH, where git looks: add it.
        </p>
      )}
      <div className="mt-3 flex items-start gap-2">
        <pre className="selectable min-w-0 flex-1 overflow-x-auto rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-[0.68rem] leading-relaxed text-green">
          {config}
        </pre>
        <Button
          small
          disabled={!key}
          onClick={async () => {
            await window.maki.copy(config)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

/** OpenPGP: maki's key for gpg and git, maki-gpg on the PATH, and the public key to hand out. */
function OpenPgp({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === OPENPGP_APP)
  const linked = link.state.linked
  const [command, setCommand] = useState<CommandStatus | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [key, setKey] = useState<Uint8Array | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.gpg.status().then(setCommand)
  }, [])
  const refresh = async (): Promise<void> => {
    const f = await link.appMessage(OPENPGP_APP, Uint8Array.of('F'.charCodeAt(0)))
    if (f.status === 'approved' && f.answer[0] === PGP_OK && f.answer.length === 29)
      setFingerprint(
        [...f.answer.subarray(1, 21)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
      )
    const k = await link.appMessage(OPENPGP_APP, Uint8Array.of('K'.charCodeAt(0)))
    setKey(k.status === 'approved' && k.answer[0] === PGP_OK ? k.answer.slice(1) : null)
  }
  useEffect(() => {
    if (installed && linked) refresh().catch(() => {})
  }, [link, installed, linked])
  const uid = key ? userId(key) : null
  const nameIt = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(OPENPGP_APP, new TextEncoder().encode(`U${name}`))
      if (r.status === 'approved' && r.answer[0] === PGP_OK) {
        setSaid({ ok: true, text: 'Named, and certified on maki.' })
        setName('')
        await refresh()
      } else setSaid({ ok: false, text: r.status === 'approved' ? pgpSays(r.answer[0]) : r.status })
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const config = [
    'git config --global gpg.program maki-gpg',
    `git config --global user.signingkey ${fingerprint ?? 'FINGERPRINT'}`,
    'git config --global commit.gpgsign true'
  ].join('\n')

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="key" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>openpgp</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s OpenPGP app installed, maki keeps an OpenPGP key from your recovery
                phrase, for gpg and git: each commit shows its subject on maki before it’s signed,
                and each message sent to you opens only once you say so there.
              </p>
              <GetIt apps={apps} go={go} />
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki keeps an OpenPGP key{uid ? `, named ${uid}` : ''}. maki-gpg hands it what’s
                signed whole (a git commit, say), and messages sent to it, and maki asks you on its
                screen each time.
              </p>
              <code className="selectable mt-3 block break-all rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                {fingerprint
                  ? fingerprint.replace(/(.{4})/g, '$1 ').trim()
                  : linked
                    ? 'asking maki…'
                    : 'plug maki in to see its key'}
              </code>
              {!uid && (
                <div className="mt-4 flex items-end gap-3">
                  <Field
                    className="min-w-0 flex-1"
                    label="Its name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Kara Zajac <kara@example.org>"
                  />
                  <Button
                    small
                    kind="primary"
                    disabled={!linked || busy || !name.trim()}
                    onClick={() => void nameIt()}
                  >
                    {busy ? 'Say yes on maki…' : 'Name it'}
                  </Button>
                </div>
              )}
              <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 text-sm text-fg">
                    maki-gpg
                    {command && (
                      <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                        {command.path}
                      </span>
                    )}
                  </span>
                  {command?.installed ? (
                    <Badge kind="built">
                      <Glyph name="check" className="h-3 w-3" /> installed
                    </Badge>
                  ) : (
                    <Button
                      small
                      kind="ghost"
                      onClick={async () => {
                        try {
                          setCommand(await window.maki.gpg.install())
                          link.note('maki-gpg installed: gpg and git can use maki’s OpenPGP key')
                        } catch (e) {
                          setSaid({ ok: false, text: (e as Error).message })
                        }
                      }}
                    >
                      Install
                    </Button>
                  )}
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm text-fg">
                    Your public key, for gpg --import anywhere
                  </span>
                  <Button
                    small
                    kind="ghost"
                    glyph="download"
                    disabled={!key || !uid}
                    onClick={async () => {
                      const path = await window.maki.gpg.save(armour('PUBLIC KEY BLOCK', key!))
                      if (path) link.note(`OpenPGP public key saved to ${path}`)
                    }}
                  >
                    Save…
                  </Button>
                </li>
              </ul>
              <div className="mt-3 flex items-start gap-2">
                <pre className="selectable min-w-0 flex-1 overflow-x-auto rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-[0.68rem] leading-relaxed text-green">
                  {config}
                </pre>
                <Button
                  small
                  disabled={!fingerprint}
                  onClick={async () => {
                    await window.maki.copy(config)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-overlay1">
                <code className="font-mono text-subtext0">maki-gpg --decrypt message.asc</code>{' '}
                opens a message sent to maki’s key, once you say so on maki; anything else maki-gpg
                hands to gpg as it is.
              </p>
              {said && (
                <p className={`mt-2 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                  {said.text}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
