import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import { keyLines, keyOf, SUDO_APP, type SudoStatus } from '@shared/sudo'
import type { Apps } from './apps-state'
import { Confirm } from './Confirm'
import type { Page } from './pages'
import { Badge, Button, Card, Glyph, Label, PageHeader } from './ui'

/** sudo and scripts asking maki first: a yes on maki's screen, signed, before they go ahead. */
export function SudoPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="computer"
        title="sudo & Confirm"
        lede="sudo, and any script you write, can wait for your yes on maki before they go ahead: maki signs it, so they can tell it came from maki and not from something else on this computer."
      />

      <Sudo link={link} apps={apps} go={go} />

      <Confirm link={link} apps={apps} go={go} />
    </div>
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
