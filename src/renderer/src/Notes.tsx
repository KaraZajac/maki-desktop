import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import {
  NOTE_TEXT,
  NOTE_TITLE,
  NOTES_APP,
  noteMessage,
  noteProblem,
  noteSays,
  noteTitles
} from '@shared/notes'
import { AppNeeded } from './AppNeeded'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader } from './ui'

/** Words from maki or the link as a sentence: a capital (but for maki, which has none), and a full stop. */
const sentence = (s: string): string =>
  `${s.startsWith('maki') ? s[0] : s[0].toUpperCase()}${s.slice(1)}${/[.?]$/.test(s) ? '' : '.'}`

/** Why maki didn't pass a message to the Notes app, in words. */
function linkSays(status: string): string {
  switch (status) {
    case 'unavailable':
      return 'another app is open on maki: go back to its home screen, or open Notes there'
    case 'locked':
      return 'maki is locked: put its PIN in on maki'
    default:
      return `maki’s Notes app: ${status}`
  }
}

/**
 * Notes's page: the notes maki keeps, by title (all this computer ever sees of them), a new one to
 * send, which maki asks its owner about before it keeps it, and what the app does with them on
 * maki.
 */
export function NotesPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === NOTES_APP)
  const ready = link.state.linked && apps.status === 'approved' && installed !== undefined
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="on maki"
        title="Notes"
        lede="Secrets you read on maki alone: a recovery code, a PIN, a door code. Send one from here, maki asks you before it keeps it, and this computer forgets it then: it sees only the notes’ titles after."
      />

      <AppNeeded
        link={link}
        apps={apps}
        id={NOTES_APP}
        name="Notes"
        glyph="note"
        pitch="With maki’s Notes app, from the maki store, maki keeps secrets you read on its own screen and never on the computer again: recovery codes, PINs, a safe’s combination."
        go={go}
      />

      {ready && <Notes link={link} />}
      {ready && <OnMaki />}
    </div>
  )
}

/** The notes on maki, by title, and a new one to send. */
function Notes({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [titles, setTitles] = useState<string[] | null>(null)
  const [listSaid, setListSaid] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  /** The notes' titles, as the app lists them now. */
  const list = async (): Promise<void> => {
    const r = await link.appMessage(NOTES_APP, Uint8Array.of('L'.charCodeAt(0)))
    const got = r.status === 'approved' ? noteTitles(r.answer) : null
    setTitles(got)
    setListSaid(
      r.status !== 'approved'
        ? linkSays(r.status)
        : got === null
          ? 'maki’s Notes app answered oddly'
          : null
    )
  }
  useEffect(() => {
    list().catch((e) => setListSaid((e as Error).message))
  }, [link])

  const problem = title === '' && text === '' ? null : noteProblem(title, text)
  const size = new TextEncoder().encode(text).length
  const send = async (): Promise<void> => {
    const m = noteMessage(title, text)
    if (!m) return
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(NOTES_APP, m)
      const why = r.status === 'approved' ? noteSays(r.answer) : linkSays(r.status)
      if (why === null) {
        const kept = title.trim()
        setTitle('')
        setText('')
        setSaid({ ok: true, text: `${kept} is on maki, and gone from here: read it on maki.` })
        await list().catch(() => {})
      } else setSaid({ ok: false, text: sentence(why) })
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.35fr]">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <Label>notes on maki</Label>
          <Button
            small
            kind="quiet"
            glyph="refresh"
            disabled={!linked || busy}
            onClick={() => void list().catch((e) => setListSaid((e as Error).message))}
          >
            Refresh
          </Button>
        </div>
        {titles === null && !listSaid && (
          <p className="mt-4 text-sm text-overlay1">Asking maki’s Notes app…</p>
        )}
        {listSaid && <p className="mt-4 text-sm text-yellow">{sentence(listSaid)}</p>}
        {titles && (
          <>
            {titles.length > 0 && (
              <div className="mt-5 font-mono">
                <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">
                  {titles.length}
                </span>{' '}
                <span className="ml-1 text-sm text-overlay1">
                  {titles.length === 1 ? 'note' : 'notes'}
                </span>
              </div>
            )}
            {titles.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-surface1 px-4 py-6 text-center">
                <p className="text-sm text-subtext1">No notes on maki yet.</p>
                <p className="mt-1 text-xs text-overlay1">
                  Write one here, or scan one on maki: Notes’ menu, Scan a note.
                </p>
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0">
                {titles.map((t, i) => (
                  <li key={`${i}:${t}`} className="flex items-center gap-3 px-4 py-2.5">
                    <Glyph name="lock" className="h-4 w-4 text-overlay1" />
                    <span className="min-w-0 truncate text-sm text-fg">{t}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs leading-relaxed text-overlay1">
              Their titles are all maki shows this computer: what a note says, you read on maki.
            </p>
          </>
        )}
      </Card>

      <Card>
        <Label>a new note</Label>
        <div className="mt-4 grid gap-3">
          <Field
            label="Title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setSaid(null)
            }}
            placeholder="GitHub recovery codes"
            hint={`what maki lists it as, up to ${NOTE_TITLE} characters`}
          />
          <label className="block">
            <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
              The secret
            </span>
            <textarea
              value={text}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              aria-label="The secret"
              onChange={(e) => {
                setText(e.target.value)
                setSaid(null)
              }}
              placeholder="What only maki should show you"
              className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
            />
          </label>
        </div>
        <div className="mt-2 flex justify-end text-xs">
          <span className={size > NOTE_TEXT ? 'text-yellow' : 'text-overlay1'}>
            {size.toLocaleString('en-US')} of {NOTE_TEXT.toLocaleString('en-US')} bytes
          </span>
        </div>
        {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            kind="primary"
            glyph="send"
            disabled={!linked || busy || title.trim() === '' || problem !== null}
            onClick={() => void send()}
          >
            {busy ? 'Say yes on maki…' : 'Send to maki'}
          </Button>
          {said && (
            <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</span>
          )}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-overlay1">
          maki shows you its title and length and asks before it keeps it; then this page clears it,
          and nothing of it stays on this computer. It’s kept in maki’s encrypted storage, and in
          maki’s backups, which only your recovery phrase opens.
        </p>
      </Card>
    </div>
  )
}

/** What the Notes app does on maki. */
function OnMaki(): React.JSX.Element {
  const steps: [string, string][] = [
    ['Read one', 'Open Notes on maki and pick a note: the centre opens it, a page at a time.'],
    [
      'Type it',
      'From an open note’s menu, maki types it into the field your cursor is in, saying first how many Enters and Tabs that presses.'
    ],
    ['Scan a note', 'From the menu, a QR code becomes a note: its first line the title.'],
    ['Delete it', 'From an open note’s menu, once the centre says so: it’s gone for good.']
  ]
  return (
    <Card>
      <Label>on maki</Label>
      <dl className="mt-4 grid gap-x-8 gap-y-4 text-sm leading-relaxed sm:grid-cols-2">
        {steps.map(([what, how]) => (
          <div key={what}>
            <dt className="font-mono text-xs font-bold text-fg">{what}</dt>
            <dd className="mt-1 text-subtext1">{how}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
