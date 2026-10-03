import { useEffect, useState } from 'react'
import type { CommandStatus } from '@shared/commands'
import {
  CONFIRM_APP,
  confirmAnswer,
  confirmBody,
  confirmMessage,
  confirmSays,
  DEFAULT_S,
  keyHex,
  keyLine,
  keyOf,
  verifyYes
} from '@shared/confirm'
import type { Link } from '@shared/link'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Badge, Button, Card, Glyph, Label } from './ui'
import { GetIt } from './AppNeeded'

/**
 * maki-confirm: scripts and programs asking maki before they go ahead. Confirm's key, to compare
 * with maki's and keep in a key file; maki-confirm on the PATH; and a test, a yes checked as
 * maki-confirm checks it.
 */
export function Confirm({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === CONFIRM_APP)
  const linked = link.state.linked
  const [command, setCommand] = useState<CommandStatus | null>(null)
  const [key, setKey] = useState<Uint8Array | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<{ tone: 'good' | 'plain' | 'warn'; text: string } | null>(
    null
  )
  useEffect(() => {
    void window.maki.confirm.status().then(setCommand)
  }, [])
  // Confirm's key (the app starts out of sight to answer)
  useEffect(() => {
    if (!installed || !linked) return
    link.appMessage(CONFIRM_APP, Uint8Array.of('P'.charCodeAt(0))).then(
      (r) => {
        const k = r.status === 'approved' ? keyOf(r.answer) : null
        if (k) setKey(k)
        else
          setProblem(
            r.status === 'approved' && r.answer[0] === 3
              ? 'maki is locked: enter its PIN'
              : confirmSays(r.status, null)
          )
      },
      (e: Error) => setProblem(e.message)
    )
  }, [link, installed, linked])
  const line = key ? keyLine(key, linked ? link.state.hello.name : 'maki') : null

  // as maki-confirm asks, from here: nothing goes ahead either way
  const test = async (): Promise<void> => {
    if (!key) return
    setTesting(true)
    setTested(null)
    try {
      const who = await window.maki.confirm.who()
      const body = confirmBody(
        {
          question: 'Test maki-confirm?',
          detail: 'maki desktop asks, from its Connections page: nothing goes ahead either way.',
          user: who.user,
          host: who.host,
          cwd: '',
          program: [],
          timeout: DEFAULT_S
        },
        crypto.getRandomValues(new Uint8Array(32))
      )
      const r = await link.appMessage(CONFIRM_APP, confirmMessage(body), (DEFAULT_S + 20) * 1000)
      const answer = r.status === 'approved' ? confirmAnswer(r.answer) : null
      if (answer?.said === 'yes')
        setTested(
          verifyYes(key, body, answer.signature)
            ? {
                tone: 'good',
                text: 'maki said yes, signed with the key above: maki-confirm --key checks it so.'
              }
            : { tone: 'warn', text: 'maki said yes, but not with the key above.' }
        )
      else if (answer?.said === 'no')
        setTested({
          tone: 'plain',
          text: 'You said no on maki: maki-confirm would exit 1, and the script stop there.'
        })
      else setTested({ tone: 'warn', text: `${confirmSays(r.status, answer)}.` })
    } catch (e) {
      setTested({ tone: 'warn', text: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="check" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>confirm</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Confirm app installed, scripts and programs ask maki before they go
                ahead with what matters (a deploy, terraform apply, a force push), and go ahead only
                on your yes there, which they can check is maki’s.
              </p>
              <GetIt apps={apps} go={go} />
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki-confirm asks maki, which shows the question, the details and who asked where;
                it exits 0 only on your yes there. maki signs its yes with Confirm’s key: with a key
                file, maki-confirm checks the signature, so nothing on this computer can say yes for
                maki.
              </p>
              <div className="mt-4 flex items-start gap-4">
                <pre className="selectable rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs leading-relaxed text-green">
                  {key
                    ? keyHex(key).join('\n')
                    : linked
                      ? 'asking maki…'
                      : 'plug maki in\nfor its key'}
                </pre>
                <p className="text-xs leading-relaxed text-overlay1">
                  Confirm’s key. Check it’s the one maki’s Confirm app shows, from its menu, before
                  you keep it in a key file.
                </p>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                  {line?.trim() ?? 'maki-confirm-ed25519 …'}
                </code>
                <Button
                  small
                  disabled={!line}
                  onClick={async () => {
                    await window.maki.copy(line!)
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
                    maki-confirm
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
                          setCommand(await window.maki.confirm.install())
                          link.note('maki-confirm installed: scripts can ask maki first')
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
                  <span className="text-sm text-fg">The key file, maki-confirm.pub</span>
                  <Button
                    small
                    kind="ghost"
                    glyph="download"
                    disabled={!line}
                    onClick={async () => {
                      const path = await window.maki.confirm.save(line!)
                      if (path) link.note(`Confirm’s key saved to ${path}`)
                    }}
                  >
                    Save…
                  </Button>
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 text-sm text-fg">
                    Ask maki now, as maki-confirm would
                    {tested && (
                      <span
                        className={`mt-1 block text-xs ${
                          tested.tone === 'good'
                            ? 'text-green'
                            : tested.tone === 'warn'
                              ? 'text-yellow'
                              : 'text-subtext1'
                        }`}
                      >
                        {tested.text}
                      </span>
                    )}
                  </span>
                  <Button small kind="ghost" disabled={!key || testing} onClick={() => void test()}>
                    {testing ? 'Say yes or no on maki…' : 'Test it'}
                  </Button>
                </li>
              </ul>
              {command && command.installed && !command.onPath && (
                <p className="mt-2 text-xs text-yellow">
                  Its folder isn’t on your PATH: add it to run maki-confirm by name.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-overlay1">
                <code className="font-mono text-subtext0">
                  maki-confirm "Deploy to production?" --key maki-confirm.pub && ./deploy.sh
                </code>{' '}
                deploys once you say yes on maki. Without{' '}
                <code className="font-mono text-subtext0">--key</code>, maki-confirm takes maki
                desktop’s word for your answer: anything that can stand in for maki desktop could
                say yes.
              </p>
              {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
