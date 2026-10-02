import { useState } from 'react'
import type { Link } from '@shared/link'
import {
  MACROPAD_APP,
  MAX_NAME,
  macropadReply,
  reviewScript,
  scriptMessage
} from '@shared/macropad'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader } from './ui'

/** Macro Pad's page: what maki desktop does with maki's Macro Pad app. */
export function MacroPadPage({
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
        label="on maki"
        title="Macro Pad"
        lede="Keystrokes maki types into a computer at the press of a button: text, keys and DuckyScript, written or loaded here and sent to maki, which keeps each script and types it only when you run it there."
      />

      <MacroPad link={link} apps={apps} go={go} />
    </div>
  )
}

/** Macro Pad: DuckyScript and keystrokes sent to maki's Macro Pad app, to type on maki's say. */
function MacroPad({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === MACROPAD_APP)
  const linked = link.state.linked
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const review = reviewScript(body)
  const send = async (): Promise<void> => {
    const m = scriptMessage(name, body)
    if (!m) {
      setSaid({
        ok: false,
        text: `A name of up to ${MAX_NAME} characters, and a script under 4 KB.`
      })
      return
    }
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(MACROPAD_APP, m)
      setSaid(
        r.status === 'approved'
          ? macropadReply(r.answer)
          : { ok: false, text: `maki’s Macro Pad: ${r.status}` }
      )
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const load = (file: File): void => {
    file
      .text()
      .then((text) => {
        setBody(text)
        if (name.trim() === '')
          setName(file.name.replace(/\.(txt|dd|duck)$/i, '').slice(0, MAX_NAME))
      })
      .catch((e) => setSaid({ ok: false, text: (e as Error).message }))
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="terminal" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>macro pad</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Macro Pad app installed, maki types keystrokes and DuckyScript into your
                computer at the press of a button — for demos, pentests and your own machine.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                Write or load a script and send it to maki. maki keeps it and types it only when you
                run it there, holding maki. It can press shortcuts, so it can open and run programs:
                send only scripts you trust. DuckyScript 1.0 (STRING, DELAY, GUI r, ENTER, REPEAT…).
              </p>
              <div className="mt-4 grid gap-3">
                <Field
                  label="Name"
                  value={name}
                  maxLength={MAX_NAME}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Open a terminal"
                />
                <label className="block">
                  <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
                    The script
                  </span>
                  <textarea
                    value={body}
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={'GUI r\nDELAY 300\nSTRING notepad\nENTER'}
                    className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
                  />
                </label>
              </div>
              {body.trim() !== '' && (
                <p className="mt-2 text-xs text-overlay1">
                  {review.actions} keystroke {review.actions === 1 ? 'line' : 'lines'}
                  {review.skipped.length > 0 && (
                    <span className="text-yellow">
                      {' '}
                      · maki will skip: {review.skipped.join(', ')}
                    </span>
                  )}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <Button
                  small
                  kind="primary"
                  glyph="send"
                  disabled={!linked || busy || name.trim() === '' || body.trim() === ''}
                  onClick={() => void send()}
                >
                  {busy ? 'Sending…' : 'Send to maki'}
                </Button>
                <label className="cursor-pointer text-sm text-subtext0 underline decoration-dotted hover:text-fg">
                  Load a file
                  <input
                    type="file"
                    accept=".txt,.dd,.duck,text/plain"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) load(file)
                      e.target.value = ''
                    }}
                  />
                </label>
                {said && (
                  <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                    {said.text}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
