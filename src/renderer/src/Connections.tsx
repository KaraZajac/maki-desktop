import { useEffect, useState } from 'react'
import { AGE_APP, identityFile, recipientOf, type AgePluginStatus } from '@shared/age'
import { SSH_APP, type BrowserStatus } from '@shared/bridge-types'
import type { CommandStatus } from '@shared/commands'
import type { Link } from '@shared/link'
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
import { Badge, Button, Card, Glyph, Label, PageHeader, Toggle } from './ui'

/** What reaches maki through maki desktop: browsers, ssh and git; and maki desktop itself. */
export function Connections({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const [browsers, setBrowsers] = useState<BrowserStatus[] | null>(null)
  const [agent, setAgent] = useState<string | null>(null)
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.maki.browsers.status().then(setBrowsers)
    void window.maki.ssh.socket().then(setAgent)
    void window.maki.settings.startAtLogin().then(setStartAtLogin)
  }, [])
  const ssh = apps.apps?.find((a) => a.id === SSH_APP)

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="connections"
        title="Connections"
        lede="Browsers, ssh, git, age and minisign reach maki through maki desktop, which holds the link: they ask, and maki asks you on its own screen."
      />

      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
            <Glyph name="globe" className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Label>browsers</Label>
            <p className="mt-2 text-sm text-subtext1">
              The maki extension fills logins and codes once you approve them on maki, and gives
              sites maki’s Ethereum account. Each browser needs to be able to reach maki desktop
              first.
            </p>
            {browsers === null ? null : browsers.length === 0 ? (
              <p className="mt-4 text-sm text-overlay1">
                No supported browser found on this computer.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                {browsers.map((b) => (
                  <li key={b.name} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="text-sm text-fg">{b.name}</span>
                    {b.registered ? (
                      <Badge kind="built">
                        <Glyph name="check" className="h-3 w-3" /> connected
                      </Badge>
                    ) : (
                      <Button
                        small
                        kind="ghost"
                        title={
                          b.system
                            ? `${b.name} only looks for browser helpers in a system folder`
                            : undefined
                        }
                        onClick={async () => {
                          try {
                            setBrowsers(await window.maki.browsers.register(b.name))
                            link.note(
                              `${b.name} can reach maki desktop: add the maki extension to finish`
                            )
                          } catch (e) {
                            link.note(`${b.name} setup failed: ${(e as Error).message}`)
                          }
                        }}
                      >
                        {b.system ? 'Set up (asks for admin password)' : 'Set up'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

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
                  key, for a server’s authorized_keys, or for git to sign with (
                  <code className="font-mono text-subtext0">git config gpg.format ssh</code>).
                </p>
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
