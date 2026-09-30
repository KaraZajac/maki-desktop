import { useEffect, useState } from 'react'
import { AGE_APP, identityFile, recipientOf, type AgePluginStatus } from '@shared/age'
import { SSH_APP } from '@shared/bridge-types'
import type { CommandStatus } from '@shared/commands'
import {
  CARD_LINES,
  cardMessage,
  CONTACTS_APP,
  contactsSays,
  readPeople,
  vcards
} from '@shared/contacts'
import type { Link } from '@shared/link'
import { armour, OPENPGP_APP, PGP_OK, pgpSays, userId } from '@shared/openpgp'
import { NOTE_TEXT, NOTE_TITLE, NOTES_APP, noteMessage, noteSays, noteTitles } from '@shared/notes'
import { keyLines, keyOf, SUDO_APP, type SudoStatus } from '@shared/sudo'
import { NOSTR_APP } from '@shared/nostr'
import { BrowsersCard } from './Browsers'
import type { BunkerView } from './bunker-state'
import { Qr } from './Qr'
import {
  keyIdHex,
  MINISIGN_APP,
  parseKeyAnswer,
  publicKeyFile,
  publicKeyText,
  type MinisignKey
} from '@shared/minisign'
import type { Apps } from './apps-state'
import type { Page } from './Overview'
import { Badge, Button, Card, Field, Glyph, Label, PageHeader, Toggle } from './ui'

/** What reaches maki through maki desktop: browsers, ssh and git; and maki desktop itself. */
export function Connections({
  link,
  apps,
  go,
  bunker
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
  bunker: BunkerView
}): React.JSX.Element {
  const [agent, setAgent] = useState<string | null>(null)
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.ssh.socket().then(setAgent)
    void window.maki.settings.startAtLogin().then(setStartAtLogin)
  }, [])
  const ssh = apps.apps?.find((a) => a.id === SSH_APP)

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="connections"
        title="Connections"
        lede="Browsers, ssh, git, gpg, age, minisign, sudo, Nostr apps, your notes and your card reach maki through maki desktop, which holds the link: they ask, and maki asks you on its own screen."
      />

      <BrowsersCard link={link} />

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
                <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                  Get it
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <Age link={link} apps={apps} go={go} />

      <Minisign link={link} apps={apps} go={go} />

      <Sudo link={link} apps={apps} go={go} />

      <NostrRemote apps={apps} go={go} bunker={bunker} />

      <OpenPgp link={link} apps={apps} go={go} />

      <Notes link={link} apps={apps} go={go} />

      <Contacts link={link} apps={apps} go={go} />

      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
            <Glyph name="plug" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Label>this computer</Label>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-fg">
              Start maki desktop at login, in the tray
              <Toggle
                label="Start at login"
                disabled={startAtLogin === null}
                on={!!startAtLogin}
                onChange={async (on) =>
                  setStartAtLogin(await window.maki.settings.setStartAtLogin(on))
                }
              />
            </label>
            <p className="mt-1.5 text-xs text-overlay1">
              Closing this window keeps maki linked from the tray.
            </p>
          </div>
        </div>
      </Card>
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
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
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
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
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

/** NIP-46: Nostr apps signing with maki's Nostr key, through maki desktop as their bunker. */
function NostrRemote({
  apps,
  go,
  bunker
}: {
  apps: Apps
  go: (page: Page) => void
  bunker: BunkerView
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === NOSTR_APP)
  const [pasted, setPasted] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const act = async (f: () => Promise<void> | void): Promise<void> => {
    setProblem(null)
    try {
      await f()
    } catch (e) {
      setProblem((e as Error).message)
    }
  }
  const dot = (s: string): string =>
    s === 'open' ? 'bg-green' : s === 'connecting' ? 'bg-yellow' : 'bg-surface2'

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="send" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>nostr apps</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Nostr app installed, Nostr apps on your phone or the web can sign with
                your Nostr key through maki desktop (NIP-46), each event shown on maki first.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <label className="mt-2 flex items-center justify-between gap-4 text-sm text-fg">
                <span className="text-subtext1">
                  Nostr apps (Coracle, Nostrudel, Amethyst…) connect to maki desktop over relays and
                  ask it for your key and signatures, as a bunker (NIP-46). maki asks you before an
                  app first sees your key, and shows every event before it signs it; the key never
                  leaves maki.
                </span>
                <Toggle
                  label="Remote signing"
                  disabled={bunker.on === null}
                  on={!!bunker.on}
                  onChange={(on) => void act(() => bunker.turn(on))}
                />
              </label>
              {bunker.on && (
                <>
                  <div className="mt-4 flex flex-wrap items-start gap-4">
                    <Qr text={bunker.uri} className="h-36 w-36" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-relaxed text-overlay1">
                        Scan this in the app, or paste it where it asks for a bunker. It lets one
                        app connect: once one has, maki desktop makes a new one.
                      </p>
                      <code className="selectable mt-2 block truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                        {bunker.uri}
                      </code>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          small
                          glyph="copy"
                          onClick={async () => {
                            await window.maki.copy(bunker.uri)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          }}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                        <Button
                          small
                          kind="ghost"
                          glyph="refresh"
                          onClick={() => void act(() => bunker.newLink())}
                        >
                          New link
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <input
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      placeholder="or an app’s own link: nostrconnect://…"
                      className="min-w-0 flex-1 rounded-lg border border-surface1 bg-crust/60 px-2.5 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-overlay0 focus:border-peach/70"
                    />
                    <Button
                      small
                      kind="ghost"
                      disabled={busy || !pasted.trim().startsWith('nostrconnect://')}
                      onClick={() =>
                        void act(async () => {
                          setBusy(true)
                          try {
                            await bunker.connect(pasted)
                            setPasted('')
                          } finally {
                            setBusy(false)
                          }
                        })
                      }
                    >
                      {busy ? 'Look at maki…' : 'Connect'}
                    </Button>
                  </div>

                  <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                    {bunker.clients.length === 0 && (
                      <li className="px-4 py-3 text-sm text-overlay1">No apps yet.</li>
                    )}
                    {bunker.clients.map((c) => (
                      <li
                        key={c.pubkey}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="min-w-0 text-sm text-fg">
                          {c.name}
                          <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                            since {new Date(c.since * 1000).toLocaleDateString()}
                          </span>
                        </span>
                        <Button small kind="danger" onClick={() => bunker.revoke(c.pubkey)}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-4 text-xs text-overlay1">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {bunker.relays.map((r) => (
                        <span key={r.url} className="inline-flex items-center gap-1.5 font-mono">
                          <span className={`h-1.5 w-1.5 rounded-full ${dot(r.state)}`} />
                          {r.url.replace(/^wss:\/\//, '')}
                        </span>
                      ))}
                      <button
                        className="text-peach hover:underline"
                        onClick={() => setEditing(bunker.configured.join('\n'))}
                      >
                        relays…
                      </button>
                    </div>
                    {editing !== null && (
                      <div className="mt-2">
                        <textarea
                          value={editing}
                          onChange={(e) => setEditing(e.target.value)}
                          rows={3}
                          className="w-full resize-none rounded-lg border border-surface1 bg-crust/60 p-2.5 font-mono text-xs text-subtext1 outline-none focus:border-peach/70"
                        />
                        <div className="mt-1 flex gap-2">
                          <Button
                            small
                            onClick={() =>
                              void act(() => {
                                bunker.setRelays(editing.split(/\s+/).filter(Boolean))
                                setEditing(null)
                              })
                            }
                          >
                            Save relays
                          </Button>
                          <Button small kind="quiet" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
              {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

function Sudo({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === SUDO_APP)
  const linked = link.state.linked
  const [status, setStatus] = useState<SudoStatus | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.maki.sudo.status().then(setStatus)
  }, [])
  // maki's key, from its Sudo app (it starts out of sight to answer)
  useEffect(() => {
    if (!installed || !linked) return
    link.appMessage(SUDO_APP, Uint8Array.of('P'.charCodeAt(0))).then(
      (r) => {
        const k = r.status === 'approved' ? keyOf(r.answer) : null
        if (k) setKey(k)
        else
          setProblem(
            r.answer[0] === 3 ? 'maki is locked: enter its PIN' : `maki’s Sudo app: ${r.status}`
          )
      },
      (e: Error) => setProblem(e.message)
    )
  }, [link, installed, linked])
  const trusted = !!key && !!status?.keys.includes(key)
  const act = async (what: () => Promise<SudoStatus>, done: string): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setStatus(await what())
      link.note(done)
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="shield" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>sudo</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Sudo app installed, every command sudo runs waits for your yes on maki,
                which shows it whole: nothing on this computer can say yes for you, even with your
                password.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                Once sudoers says yes to a command, maki desktop’s sudo plugin asks maki, which
                shows the command line, what it’s given to run with and who asked; it runs only once
                you say yes there. maki signs its yes, and sudo checks the signature with maki’s
                key, which root keeps: sudo’s remembered password isn’t enough, and nor is yours.
              </p>
              <div className="mt-4 flex items-start gap-4">
                <pre className="selectable rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs leading-relaxed text-green">
                  {key
                    ? keyLines(key).join('\n')
                    : linked
                      ? 'asking maki…'
                      : 'plug maki in\nfor its key'}
                </pre>
                <p className="text-xs leading-relaxed text-overlay1">
                  maki’s key for sudo. Check it’s the one maki’s Sudo app shows, from its menu,
                  before you turn it on.
                </p>
              </div>
              {status?.unavailable ? (
                <p className="mt-4 text-sm text-overlay1">{status.unavailable}.</p>
              ) : (
                <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                  <li className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="min-w-0 text-sm text-fg">
                      {status?.on
                        ? `Every sudo command of ${status.users?.join(', ') ?? 'everyone’s'} waits for maki`
                        : 'sudo runs what sudoers says, without maki'}
                      {status?.version && (
                        <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                          sudo {status.version}
                        </span>
                      )}
                    </span>
                    {status?.on ? (
                      <span className="flex items-center gap-2">
                        {trusted ? (
                          <Badge kind="built">
                            <Glyph name="check" className="h-3 w-3" /> this maki
                          </Badge>
                        ) : (
                          key && <Badge kind="warn">another maki’s key</Badge>
                        )}
                        {!trusted && key && (
                          <Button
                            small
                            kind="ghost"
                            disabled={busy}
                            onClick={() =>
                              act(
                                () =>
                                  window.maki.sudo.on(key, linked ? link.state.hello.name : null),
                                'sudo trusts this maki too'
                              )
                            }
                          >
                            Trust this maki too
                          </Button>
                        )}
                        <Button
                          small
                          kind="danger"
                          disabled={busy}
                          onClick={() =>
                            act(() => window.maki.sudo.off(), 'sudo no longer waits for maki')
                          }
                        >
                          Turn off
                        </Button>
                      </span>
                    ) : (
                      <Button
                        small
                        kind="ghost"
                        disabled={busy || !key || !status}
                        onClick={() =>
                          act(
                            () => window.maki.sudo.on(key!, linked ? link.state.hello.name : null),
                            'sudo waits for maki now: each command, shown on maki'
                          )
                        }
                      >
                        {busy ? 'Asking for your password…' : 'Turn on'}
                      </Button>
                    )}
                  </li>
                </ul>
              )}
              {status?.problem && (
                <p className="mt-2 text-sm text-yellow">sudo won’t start: {status.problem}</p>
              )}
              {status?.on && !status.problem && !status.loads && (
                <p className="mt-2 text-sm text-yellow">
                  sudo.conf has the plugin, but sudo didn’t load it for you.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-overlay1">
                Turning it on or off asks for your admin password. Keep another way in before you
                turn it on: if maki is lost, you’ll need one to turn it off (su with root’s
                password, or pkexec). maki approves what sudo runs; those other ways to root still
                take a password alone.
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

/** Notes: secrets sent to maki's Notes app, to read on maki alone. */
function Notes({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === NOTES_APP)
  const linked = link.state.linked
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [titles, setTitles] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const list = async (): Promise<void> => {
    const r = await link.appMessage(NOTES_APP, Uint8Array.of('L'.charCodeAt(0)))
    if (r.status === 'approved') setTitles(noteTitles(r.answer))
  }
  useEffect(() => {
    if (installed && linked) list().catch(() => {})
  }, [link, installed, linked])
  const send = async (): Promise<void> => {
    const m = noteMessage(title, text)
    if (!m) {
      setSaid({
        ok: false,
        text: `A title of up to ${NOTE_TITLE} characters, and up to ${NOTE_TEXT} of text.`
      })
      return
    }
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(NOTES_APP, m)
      const why = r.status === 'approved' ? noteSays(r.answer) : `maki’s Notes app: ${r.status}`
      if (why === null) {
        setTitle('')
        setText('')
        setSaid({ ok: true, text: 'Kept on maki, and cleared here: it shows on maki alone now.' })
        void list()
      } else setSaid({ ok: false, text: why })
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="eye" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>notes</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Notes app installed, maki keeps secrets you read on its screen and never
                on the computer again: recovery codes, PINs, a safe’s combination.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                Type a secret here and send it to maki, which asks you before it keeps it; this
                computer forgets it then, and sees only its title after.
              </p>
              <div className="mt-4 grid gap-3">
                <Field
                  label="Title"
                  value={title}
                  maxLength={NOTE_TITLE}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="GitHub recovery codes"
                />
                <label className="block">
                  <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
                    The secret
                  </span>
                  <textarea
                    value={text}
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setText(e.target.value)}
                    className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
                  />
                </label>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button
                  small
                  kind="primary"
                  glyph="send"
                  disabled={!linked || busy || !title.trim()}
                  onClick={() => void send()}
                >
                  {busy ? 'Say yes on maki…' : 'Send to maki'}
                </Button>
                {said && (
                  <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                    {said.text}
                  </span>
                )}
              </div>
              {titles && titles.length > 0 && (
                <p className="mt-4 text-xs text-overlay1">On maki: {titles.join(' · ')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** Contacts: your card, which maki signs and shows to swap, and the people you met, as vCards. */
function Contacts({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === CONTACTS_APP)
  const linked = link.state.linked
  const [name, setName] = useState('')
  const [lines, setLines] = useState<string[]>(Array(CARD_LINES).fill(''))
  const [busy, setBusy] = useState<'card' | 'people' | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const ask = async (what: 'card' | 'people', message: Uint8Array): Promise<Uint8Array | null> => {
    setBusy(what)
    setSaid(null)
    try {
      const r = await link.appMessage(CONTACTS_APP, message)
      const why =
        r.status === 'approved' ? contactsSays(r.answer) : `maki’s Contacts app: ${r.status}`
      if (why !== null) setSaid({ ok: false, text: why })
      return why === null ? r.answer : null
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
      return null
    } finally {
      setBusy(null)
    }
  }
  const setCard = async (): Promise<void> => {
    const m = cardMessage(name, lines)
    if (!m) {
      setSaid({ ok: false, text: 'A name of up to 32 bytes, and lines of up to 48.' })
      return
    }
    if (await ask('card', m))
      setSaid({ ok: true, text: 'Your card is on maki: open Contacts to show it.' })
  }
  const savePeople = async (): Promise<void> => {
    const a = await ask('people', Uint8Array.of('P'.charCodeAt(0)))
    const people = a ? readPeople(a) : null
    if (!people) return
    if (people.length === 0) {
      setSaid({ ok: true, text: 'Nobody yet: scan someone’s card on maki.' })
      return
    }
    const path = await window.maki.contacts.save(vcards(people))
    if (path) setSaid({ ok: true, text: `${people.length} people saved to ${path}` })
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="qr" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>contacts</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Contacts app installed, maki shows your card as a QR code, signed by
                your maki, to swap at the con, and keeps who you met.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                Your card: a name and up to three lines (a handle, an email, a site). maki signs it
                and shows it as a QR code; other makis check the signature when they scan it.
              </p>
              <div className="mt-4 grid gap-3">
                <Field
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Kara Zajac"
                />
                {lines.map((l, i) => (
                  <Field
                    key={i}
                    label={`Line ${i + 1}`}
                    value={l}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={['@you@hackers.town', 'you@example.org', 'example.org'][i]}
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  small
                  kind="primary"
                  glyph="send"
                  disabled={!linked || busy !== null || !name.trim()}
                  onClick={() => void setCard()}
                >
                  {busy === 'card' ? 'Say yes on maki…' : 'Make it my card'}
                </Button>
                <Button
                  small
                  kind="ghost"
                  glyph="download"
                  disabled={!linked || busy !== null}
                  onClick={() => void savePeople()}
                >
                  {busy === 'people' ? 'Say yes on maki…' : 'Save the people you met…'}
                </Button>
              </div>
              {said && (
                <p className={`mt-3 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
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
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
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
