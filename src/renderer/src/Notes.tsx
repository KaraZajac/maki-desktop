import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import { NOTE_TEXT, NOTE_TITLE, NOTES_APP, noteMessage, noteSays, noteTitles } from '@shared/notes'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader } from './ui'

/** Notes's page: what maki desktop does with maki's Notes app. */
export function NotesPage({
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
        title="Notes"
        lede="Secrets you send to maki’s Notes app, to read on maki alone: a recovery code, a PIN, a door code. Once sent, they live on maki, not here."
      />

      <Notes link={link} apps={apps} go={go} />
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
