import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import {
  getMessage,
  KIND_NAME,
  keptId,
  lineFeeds,
  linkSays,
  listMessage,
  lists,
  MACROPAD_APP,
  macropadReply,
  MAX_NAME,
  MAX_SCRIPT,
  MAX_SCRIPTS,
  PAD_ROOM,
  padSays,
  putMessage,
  readPad,
  readText,
  removeMessage,
  scriptMessage,
  scriptProblem,
  scriptSays,
  type Pad,
  type PadScript,
  type ScriptKind
} from '@shared/macropad'
import { SIGN_TIMEOUT_MS } from '@shared/wallet-apps'
import { AppNeeded } from './AppNeeded'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Badge, Button, bytes, Card, Field, Label, PageHeader, Segmented } from './ui'

/** How full the pad's room is when its meter turns yellow. */
const NEARLY_FULL = 0.9

/** What the editor holds: a script as it is here, `id` the one it is on maki (0 for a new one). */
interface Draft {
  id: number
  kind: ScriptKind
  name: string
  body: string
}

const blank = (): Draft => ({ id: 0, kind: 'ducky', name: '', body: '' })

/** Words from maki or the link as a sentence: a capital (but for maki, which has none), and a full stop. */
const sentence = (s: string): string =>
  `${s.startsWith('maki') ? s[0] : s[0].toUpperCase()}${s.slice(1)}${/[.?]$/.test(s) ? '' : '.'}`

/** "2 Oct 2026", from seconds since 1970. */
const day = (s: number): string =>
  new Date(s * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })

/** When a script came, or last changed: nothing if maki didn't know the time. */
function when(s: PadScript): string | null {
  if (s.changed > 0) return `changed ${day(s.changed)}`
  if (s.added > 0) return `added ${day(s.added)}`
  return null
}

/** What the script's field says while it's empty, for each kind. */
const PLACEHOLDER: Record<ScriptKind, string> = {
  ducky: 'A command a line: GUI r, then DELAY 300, then STRING notepad, then ENTER',
  text: 'What maki types, as it is: a line break presses Enter, a tab Tab'
}

/**
 * Macro Pad's page: the scripts maki keeps, each with what maki makes of it; one opened to read
 * and change, or a new one written or loaded from a file, sent to maki, which asks its owner before
 * it keeps, replaces or removes one; and how maki runs them. Macro Pad 1.0 only takes scripts: for
 * it, the page says to update it, and still sends one the way it takes them.
 */
export function MacroPadPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === MACROPAD_APP)
  const ready = link.state.linked && apps.status === 'approved' && installed !== undefined
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="on maki"
        title="Macro Pad"
        lede="Keystrokes maki types into a computer at the press of a button, from scripts you write here or load from a file: DuckyScript, or text as it is. maki types one only when you run it there, holding maki."
      />

      <AppNeeded
        link={link}
        apps={apps}
        id={MACROPAD_APP}
        name="Macro Pad"
        glyph="keyboard"
        pitch="With maki’s Macro Pad app, from the maki store, maki types keystrokes and DuckyScript into your computer at the press of a button: for demos, pentests and your own machine."
        go={go}
      />

      {ready &&
        (lists(installed.version) ? (
          <Scripts link={link} />
        ) : (
          <FirstVersion link={link} label={installed.label} go={go} />
        ))}

      {ready && lists(installed.version) && <HowItRuns />}
    </div>
  )
}

/** The scripts on maki (Macro Pad 1.1 and later), and the editor. */
function Scripts({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [pad, setPad] = useState<Pad | null>(null)
  // each script's text, null for one maki didn't give back
  const [texts, setTexts] = useState<Record<number, string | null>>({})
  const [padSaid, setPadSaid] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(blank())
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  /** The scripts as the app lists them now, and each one's text. */
  const load = async (): Promise<Pad | null> => {
    const r = await link.appMessage(MACROPAD_APP, listMessage())
    const got = r.status === 'approved' ? readPad(r.answer) : null
    setPadSaid(
      r.status !== 'approved'
        ? linkSays(r.status)
        : got === null
          ? (padSays(r.answer) ?? 'maki’s Macro Pad answered oddly')
          : null
    )
    if (got === null) return null
    const read: Record<number, string | null> = {}
    for (const s of got.scripts) {
      const t = await link.appMessage(MACROPAD_APP, getMessage(s.id))
      read[s.id] = t.status === 'approved' ? readText(t.answer) : null
    }
    setPad(got)
    setTexts(read)
    return got
  }
  useEffect(() => {
    load().catch((e) => setPadSaid((e as Error).message))
  }, [link])

  // a script open that's gone from maki (removed there) is closed: changes to it stay, as a new one
  const openOn = pad?.scripts.find((s) => s.id === draft.id) ?? null
  useEffect(() => {
    if (pad && draft.id !== 0 && !openOn) {
      setDraft((d) => (dirty ? { ...d, id: 0 } : blank()))
      setSaid({
        ok: false,
        text: dirty
          ? `${draft.name} isn’t on maki any more: your changes are here, as a new script.`
          : `${draft.name} isn’t on maki any more.`
      })
    }
  }, [pad])

  const open = (s: PadScript): void => {
    setDraft({ id: s.id, kind: s.kind, name: s.name, body: texts[s.id] ?? '' })
    setDirty(false)
    setSaid(null)
  }
  const edit = (change: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...change }))
    setDirty(true)
    setSaid(null)
  }
  const fresh = (): void => {
    setDraft(blank())
    setDirty(false)
    setSaid(null)
  }
  const undo = (): void => {
    if (openOn) open(openOn)
    else fresh()
  }
  const loadFile = (file: File): void => {
    file
      .text()
      .then((text) => {
        const name = file.name.replace(/\.(txt|duck|dd)$/i, '').slice(0, MAX_NAME)
        edit({ body: lineFeeds(text), name: draft.name.trim() === '' ? name : draft.name })
        setSaid({ ok: true, text: `${file.name} is here, not on maki until you send it.` })
      })
      .catch((e) => setSaid({ ok: false, text: (e as Error).message }))
  }

  const problem =
    draft.name.trim() === '' && draft.body === ''
      ? null
      : scriptProblem(draft.kind, draft.name, draft.body, pad, draft.id)
  const says = draft.body.trim() === '' ? null : scriptSays(draft.kind, draft.body)
  const size = new TextEncoder().encode(lineFeeds(draft.body)).length
  const unchanged =
    openOn !== null &&
    draft.kind === openOn.kind &&
    draft.name.trim() === openOn.name &&
    lineFeeds(draft.body) === texts[openOn.id]

  /** Sends `m` and says what came of it: the app's answer if it did what was asked, else null. */
  const send = async (
    what: 'save' | 'remove',
    m: Uint8Array,
    done: string
  ): Promise<Uint8Array | null> => {
    setBusy(what)
    setSaid(null)
    try {
      // maki shows the script and asks: as long as its owner may take
      const r = await link.appMessage(MACROPAD_APP, m, SIGN_TIMEOUT_MS)
      const no = r.status === 'approved' ? padSays(r.answer) : linkSays(r.status)
      setSaid(no === null ? { ok: true, text: done } : { ok: false, text: sentence(no) })
      return no === null ? r.answer : null
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
      return null
    } finally {
      setBusy(null)
    }
  }
  const save = async (): Promise<void> => {
    const m = putMessage(draft.id, draft.kind, draft.name, draft.body)
    if (m === null || problem !== null) return
    const name = draft.name.trim()
    const kept = await send(
      'save',
      m,
      draft.id === 0 ? `${name} is on maki now.` : `${name} changed on maki.`
    )
    if (kept === null) return
    const id = keptId(kept) ?? draft.id
    setDraft({ id, kind: draft.kind, name, body: lineFeeds(draft.body) })
    setDirty(false)
    await load().catch(() => {})
  }
  const remove = async (s: PadScript): Promise<void> => {
    setRemoving(s.id)
    const gone = await send('remove', removeMessage(s.id), `${s.name} removed from maki.`)
    setRemoving(null)
    if (gone === null) return
    if (draft.id === s.id) {
      setDraft(blank())
      setDirty(false)
    }
    await load().catch(() => {})
  }

  const scripts = pad?.scripts ?? []
  const full = pad ? pad.used / pad.room : 0

  return (
    <>
      <Card>
        <div className="flex items-start justify-between gap-4">
          <Label>scripts on maki</Label>
          <Button
            small
            kind="quiet"
            glyph="refresh"
            disabled={!linked || busy !== null}
            onClick={() => void load().catch((e) => setPadSaid((e as Error).message))}
          >
            Refresh
          </Button>
        </div>

        {pad === null && !padSaid && (
          <p className="mt-4 text-sm text-overlay1">Asking maki’s Macro Pad…</p>
        )}
        {padSaid && <p className="mt-4 text-sm text-yellow">{sentence(padSaid)}</p>}

        {pad && (
          <>
            <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div className="min-w-0">
                <div className="font-mono">
                  <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">
                    {scripts.length}
                  </span>{' '}
                  <span className="ml-1 text-sm text-overlay1">of {pad.most} scripts</span>
                </div>
                <div className="mt-1 text-xs leading-snug text-overlay1">
                  {scripts.length === 0
                    ? 'nothing to run yet'
                    : `${scripts.filter((s) => s.kind === 'ducky').length} DuckyScript, ${scripts.filter((s) => s.kind === 'text').length} text`}
                </div>
              </div>
              <div className="min-w-0">
                <div className="font-mono">
                  <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">
                    {bytes(pad.used)}
                  </span>{' '}
                  <span className="ml-1 text-sm text-overlay1">of {bytes(pad.room)}</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-surface0/70 ring-1 ring-surface1/50 ring-inset"
                  role="meter"
                  aria-label="The Macro Pad’s room on maki"
                  aria-valuemin={0}
                  aria-valuemax={pad.room}
                  aria-valuenow={pad.used}
                  aria-valuetext={`${bytes(pad.used)} of ${bytes(pad.room)}`}
                >
                  <div
                    className={`h-full rounded-full ${full >= NEARLY_FULL ? 'bg-yellow' : 'bg-peach'}`}
                    style={{ width: `max(${Math.min(100, full * 100).toFixed(2)}%, 3px)` }}
                  />
                </div>
                <div className="mt-1 text-xs leading-snug text-overlay1">
                  {bytes(Math.max(0, pad.room - pad.used))} free for scripts, their names and text
                </div>
              </div>
            </div>

            {scripts.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-surface1 px-4 py-6 text-center">
                <p className="text-sm text-subtext1">No scripts on maki yet.</p>
                <p className="mt-1 text-xs text-overlay1">
                  Write one below, or load a DuckyScript file (.txt): maki asks you before it keeps
                  it.
                </p>
              </div>
            ) : (
              <ul className="mt-5 divide-y divide-surface0 rounded-xl border border-surface0">
                {scripts.map((s) => {
                  const text = texts[s.id] ?? null
                  const review = text === null ? null : scriptSays(s.kind, text)
                  const at = when(s)
                  const isOpen = draft.id === s.id
                  return (
                    <li
                      key={s.id}
                      className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 ${isOpen ? 'bg-peach/[0.06]' : ''}`}
                    >
                      <div className="min-w-[14rem] flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-fg">{s.name}</span>
                          <Badge kind={s.kind === 'text' ? 'info' : 'later'}>
                            {KIND_NAME[s.kind]}
                          </Badge>
                          {isOpen && <Badge kind="next">open below</Badge>}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[0.7rem] text-overlay1">
                          {review ? review.says : 'maki didn’t give its text back'} ·{' '}
                          {bytes(s.size)}
                          {at ? ` · ${at}` : ''}
                        </div>
                        {review?.warn && (
                          <div className="mt-0.5 truncate text-xs text-yellow">
                            {sentence(review.warn)}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {!isOpen && (
                          <Button
                            small
                            kind="ghost"
                            aria-label={`Open ${s.name}`}
                            title={
                              dirty
                                ? 'Send the changes below to maki, or undo them, first'
                                : undefined
                            }
                            disabled={!linked || busy !== null || dirty || text === null}
                            onClick={() => open(s)}
                          >
                            Open
                          </Button>
                        )}
                        <Button
                          small
                          kind="ghost"
                          glyph="trash"
                          aria-label={`Remove ${s.name}`}
                          disabled={!linked || busy !== null}
                          onClick={() => void remove(s)}
                        >
                          {removing === s.id ? 'Say yes on maki…' : 'Remove'}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </Card>

      {pad && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <Label>{draft.id === 0 ? 'a new script' : 'a script on maki'}</Label>
            {draft.id !== 0 && (
              <Button
                small
                kind="quiet"
                disabled={busy !== null || dirty}
                title={dirty ? 'Send the changes to maki, or undo them, first' : undefined}
                onClick={fresh}
              >
                New script
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <Field
              className="min-w-[16rem] flex-1"
              label="Name"
              value={draft.name}
              placeholder="Open a terminal"
              onChange={(e) => edit({ name: e.target.value })}
              hint={`what maki lists it as, up to ${MAX_NAME} characters`}
            />
            <div className="pb-6">
              <Segmented
                label="What it is"
                value={draft.kind}
                options={[
                  ['ducky', 'DuckyScript'],
                  ['text', 'Text as it is']
                ]}
                onChange={(kind) => edit({ kind })}
              />
            </div>
          </div>
          <label className="mt-3 block">
            <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
              {draft.kind === 'ducky' ? 'The script' : 'The text'}
            </span>
            <textarea
              value={draft.body}
              rows={10}
              spellCheck={false}
              autoComplete="off"
              aria-label={draft.kind === 'ducky' ? 'The script' : 'The text'}
              onChange={(e) => edit({ body: e.target.value })}
              placeholder={PLACEHOLDER[draft.kind]}
              className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm leading-relaxed text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
            />
          </label>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-1 text-xs">
            <span className="text-overlay1">
              {says ? says.says : draft.kind === 'ducky' ? 'No lines yet' : 'Nothing yet'}
              {says?.warn && <span className="text-yellow"> · {says.warn}</span>}
            </span>
            <span className={size > MAX_SCRIPT ? 'text-yellow' : 'text-overlay1'}>
              {size.toLocaleString('en-US')} of {MAX_SCRIPT.toLocaleString('en-US')} bytes
            </span>
          </div>
          {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              kind="primary"
              glyph="send"
              disabled={
                !linked ||
                busy !== null ||
                problem !== null ||
                draft.name.trim() === '' ||
                draft.body.trim() === '' ||
                unchanged
              }
              onClick={() => void save()}
            >
              {busy === 'save'
                ? 'Say yes on maki…'
                : draft.id === 0
                  ? 'Send to maki'
                  : 'Save on maki'}
            </Button>
            {dirty && (
              <Button kind="quiet" disabled={busy !== null} onClick={undo}>
                {draft.id === 0 ? 'Clear' : 'Undo changes'}
              </Button>
            )}
            <label className="cursor-pointer text-sm text-subtext0 underline decoration-dotted hover:text-fg">
              Load a file…
              <input
                type="file"
                accept=".txt,.duck,.dd,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) loadFile(file)
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
        </Card>
      )}
    </>
  )
}

/**
 * Macro Pad 1.0, which keeps scripts without asking and can't list them or give them back: the
 * page says to update it, and sends a script the way it takes one.
 */
function FirstVersion({
  link,
  label,
  go
}: {
  link: Link
  label: string
  go: (page: Page) => void
}): React.JSX.Element {
  const linked = link.state.linked
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const says = body.trim() === '' ? null : scriptSays('ducky', body)
  const send = async (): Promise<void> => {
    const m = scriptMessage(name, lineFeeds(body))
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
          : { ok: false, text: sentence(linkSays(r.status)) }
      )
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <Label>scripts on maki</Label>
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-peach/30 bg-peach/[0.05] p-4">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-subtext0">
            <span className="font-semibold text-fg">
              maki’s Macro Pad is version {label || '1.0'}, which keeps scripts but can’t show them
              here.
            </span>{' '}
            Update it to 1.1 on Apps to see the scripts maki keeps, open them here to read and
            change, and remove them; 1.1 also asks you on maki before it keeps or replaces one, and
            types text as it is.
          </p>
          <Button kind="ghost" glyph="apps" onClick={() => go('apps')}>
            Update on Apps
          </Button>
        </div>
      </Card>

      <Card>
        <Label>send a script</Label>
        <p className="mt-3 max-w-3xl text-sm text-subtext1">
          Macro Pad {label || '1.0'} keeps a script it’s sent at once, without asking you, in place
          of one with the same name: send only scripts you trust.
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
              rows={8}
              spellCheck={false}
              autoComplete="off"
              aria-label="The script"
              onChange={(e) => setBody(e.target.value)}
              placeholder={PLACEHOLDER.ducky}
              className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm leading-relaxed text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
            />
          </label>
        </div>
        {says && (
          <p className="mt-2 text-xs text-overlay1">
            {says.says}
            {says.warn && <span className="text-yellow"> · {says.warn}</span>}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            kind="primary"
            glyph="send"
            disabled={!linked || busy || name.trim() === '' || body.trim() === ''}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Send to maki'}
          </Button>
          {said && (
            <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</span>
          )}
        </div>
      </Card>
    </>
  )
}

/** DuckyScript's commands maki runs, as the help shows them: the command, and what it does. */
const COMMANDS: [string, string][] = [
  ['STRING hello', 'types the text after it'],
  ['STRINGLN hello', 'types it, then presses Enter'],
  ['ENTER  TAB  ESC  UP  F5', 'presses a key'],
  ['GUI r  CTRL ALT DELETE', 'presses a shortcut'],
  ['DELAY 500', 'waits 500 ms, a minute at most'],
  ['DEFAULTDELAY 100', 'waits that long after every line'],
  ['REPEAT 3', 'does the line before three more times'],
  ['REM', 'a note: nothing typed']
]

/** How maki runs a script, what it types, and the pad's limits. */
function HowItRuns(): React.JSX.Element {
  return (
    <Card>
      <Label>how maki runs them</Label>
      <div className="mt-4 grid gap-x-10 gap-y-6 text-sm leading-relaxed text-subtext1 md:grid-cols-[1.6fr_1fr]">
        <div>
          <div className="font-mono text-xs font-bold text-fg">DuckyScript</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-5 gap-y-1.5">
            {COMMANDS.map(([command, does]) => (
              <div key={command} className="contents">
                <dt className="font-mono text-[0.78rem] whitespace-pre text-peach">{command}</dt>
                <dd className="text-subtext1">{does}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-overlay1">
            DuckyScript 1.0, and STRINGLN. 3.0’s variables, conditions, mouse and ATTACKMODE aren’t:
            maki skips those lines, and this page names them before you send a script.
          </p>
        </div>
        <div className="space-y-5">
          <div>
            <div className="font-mono text-xs font-bold text-fg">Text as it is</div>
            <p className="mt-1.5">
              Typed just as it’s written, nothing read as a command: letters, digits and symbols as
              a US keyboard has them, a line break pressing Enter and a tab Tab. On a computer set
              to another layout, symbols come out as that layout has them.
            </p>
          </div>
          <div>
            <div className="font-mono text-xs font-bold text-fg">On maki</div>
            <p className="mt-1.5">
              Open Macro Pad, pick a script, and the centre types it, with “typing” in maki’s bar.
              maki keeps {MAX_SCRIPTS} scripts, each up to {MAX_SCRIPT.toLocaleString('en-US')}{' '}
              bytes and {bytes(PAD_ROOM)} of them in all, and stops a run at 5,000 keystrokes.
            </p>
          </div>
        </div>
      </div>
      <p className="mt-5 border-t border-surface0 pt-4 text-xs leading-relaxed text-overlay1">
        A script can press shortcuts, so it can open and run programs: keep only scripts you trust
        and understand, and read the script maki shows you before you say yes. Scripts aren’t
        secret: maki desktop reads them back without asking you, so keep passwords in Password Maker
        or Notes, not in a script.
      </p>
    </Card>
  )
}
