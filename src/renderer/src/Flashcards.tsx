import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import {
  chars,
  count,
  decodeFile,
  deckBytes,
  FLASHCARDS_APP,
  flashcardsSays,
  kib,
  linkSays,
  listMessage,
  MAX_BACK,
  MAX_CARDS,
  MAX_DECKS,
  MAX_FRONT,
  MAX_NAME,
  prepareDeck,
  READS_SINCE,
  readDeck,
  readList,
  removeMessage,
  ROOM,
  sendDeck,
  storedSize,
  type Listing,
  type Separator
} from '@shared/flashcards'
import { AppNeeded } from './AppNeeded'
import type { Apps } from './apps-state'
import { BoxChart, DeckEditor, shown } from './FlashcardsDeck'
import { sentence } from './format'
import type { Page } from './pages'
import { Button, Card, Field, Label, PageHeader, Segmented, Toggle } from './ui'

/** How many cards the preview shows, and how many of those left out it names. */
const PREVIEW = 5
/** How full the app's room is when its meter turns yellow. */
const NEARLY_FULL = 0.9

/** A deck's name for maki from Anki's: as it is if it fits, else its last part (after `::`). */
function shortName(anki: string): string {
  if (chars(anki) <= MAX_NAME) return anki
  return [...(anki.split('::').pop() ?? anki)].slice(0, MAX_NAME).join('')
}

/** One of the figures over the decks: a number, what it counts, and a line under it. */
function Figure({
  value,
  label,
  under
}: {
  value: React.ReactNode
  label: string
  under?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="font-mono whitespace-nowrap">
        <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">{value}</span>{' '}
        <span className="ml-1 text-sm text-overlay1">{label}</span>
      </div>
      {under && <div className="mt-1 text-xs leading-snug text-overlay1">{under}</div>}
    </div>
  )
}

/**
 * Flashcards's page: the decks on maki, what each has for today and how its cards stand in
 * Leitner's boxes, the app's room; a deck opened, its cards to see and change; and new decks from a
 * file, pasted text or Anki, each shown as maki will have it before it's sent.
 */
export function FlashcardsPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === FLASHCARDS_APP)
  const linked = link.state.linked
  const ready = linked && apps.status === 'approved' && installed !== undefined
  // the app's version as maki last said it (maki away, it doesn't say): 1.0 can't read a deck back
  const [app, setApp] = useState<{ version: number; label: string } | null>(null)
  useEffect(() => {
    if (installed) setApp({ version: installed.version, label: installed.label })
  }, [installed?.version, installed?.label])
  const reads = app !== null && app.version >= READS_SINCE
  const [listing, setListing] = useState<Listing | null>(null)
  const [listSaid, setListSaid] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [asking, setAsking] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  // what maki last said stays while it's away or locked, a deck opened and its changes with it:
  // gone once maki says it hasn't the app
  const gone = linked && apps.status === 'approved' && installed === undefined
  const show = !gone && (ready || listing !== null)

  /**
   * The decks, as the app lists them now; or why not, in words (what it listed last stays, a deck
   * opened with it).
   */
  const load = async (): Promise<Listing | string> => {
    const r = await link.appMessage(FLASHCARDS_APP, listMessage())
    const got = r.status === 'approved' ? readList(r.answer) : null
    const why =
      r.status !== 'approved'
        ? linkSays(r.status)
        : (flashcardsSays(r.answer) ?? 'maki’s Flashcards app answered oddly')
    if (got) setListing(got)
    setListSaid(got ? null : why)
    return got ?? why
  }
  useEffect(() => {
    if (ready) load().catch((e) => setListSaid((e as Error).message))
  }, [link, ready])
  // a deck open that's gone from maki (removed there) is closed
  const openDeck = listing?.decks.find((d) => d.id === open) ?? null
  useEffect(() => {
    if (listing && open !== null && !openDeck) setOpen(null)
  }, [listing, open])

  const remove = async (id: number, deckName: string): Promise<void> => {
    setBusy(true)
    setSaid(null)
    setAsking(null)
    try {
      const r = await link.appMessage(FLASHCARDS_APP, removeMessage(id))
      const no = r.status === 'approved' ? flashcardsSays(r.answer) : linkSays(r.status)
      setSaid(
        no === null
          ? { ok: true, text: `${deckName} removed from maki.` }
          : { ok: false, text: sentence(no) }
      )
      if (no === null && open === id) setOpen(null)
      await load()
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const decks = listing?.decks ?? []
  const today = decks.reduce((n, d) => n + d.study, 0)
  const due = decks.reduce((n, d) => n + d.due, 0)
  const cards = decks.reduce((n, d) => n + d.cards, 0)
  const full = listing ? listing.used / listing.room : 0

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="on maki"
        title="Flashcards"
        lede="Decks studied on maki a card at a time, the cards you don’t know back sooner than those you do. Here, what each deck has for today and how well you know it; its cards, to change; and new decks from a file, pasted text or Anki."
      />

      <AppNeeded
        link={link}
        apps={apps}
        id={FLASHCARDS_APP}
        name="Flashcards"
        glyph="cards"
        pitch="With maki’s Flashcards app, from the maki store, maki shows decks of cards from here a card at a time, and brings back those you don’t know sooner than those you do."
        go={go}
      />

      {show && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <Label>decks on maki</Label>
            <Button
              small
              kind="quiet"
              glyph="refresh"
              disabled={!ready || busy}
              onClick={() => void load().catch((e) => setListSaid((e as Error).message))}
            >
              Refresh
            </Button>
          </div>

          {listing === null && !listSaid && (
            <p className="mt-4 text-sm text-overlay1">Asking maki’s Flashcards app…</p>
          )}
          {listSaid && <p className="mt-4 text-sm text-yellow">{sentence(listSaid)}</p>}

          {listing && (
            <>
              <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.3fr)]">
                <Figure
                  value={today}
                  label="for today"
                  under={
                    decks.length === 0
                      ? 'nothing to study yet'
                      : `${due} due and ${today - due} new`
                  }
                />
                <Figure
                  value={listing.streak}
                  label={listing.streak === 1 ? 'day in a row' : 'days in a row'}
                  under={
                    !listing.known
                      ? 'maki doesn’t know the date: it studies as on the last day it knew'
                      : listing.streak === 0
                        ? 'study a deck on maki to begin a run'
                        : 'of studying on maki'
                  }
                />
                <Figure
                  value={`${decks.length}`}
                  label={`of ${MAX_DECKS} decks`}
                  under={`${count(cards, 'card')} in all`}
                />
                <div className="min-w-0">
                  <div className="font-mono whitespace-nowrap">
                    <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">
                      {kib(listing.used)}
                    </span>{' '}
                    <span className="ml-1 text-sm text-overlay1">of {kib(listing.room)}</span>
                  </div>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full bg-surface0/70 ring-1 ring-surface1/50 ring-inset"
                    role="meter"
                    aria-label="The Flashcards app’s room on maki"
                    aria-valuemin={0}
                    aria-valuemax={listing.room}
                    aria-valuenow={listing.used}
                    aria-valuetext={`${kib(listing.used)} of ${kib(listing.room)}`}
                  >
                    <div
                      className={`h-full rounded-full ${full >= NEARLY_FULL ? 'bg-yellow' : 'bg-peach'}`}
                      style={{ width: `max(${Math.min(100, full * 100).toFixed(2)}%, 3px)` }}
                    />
                  </div>
                  <div className="mt-1 text-xs leading-snug text-overlay1">
                    {kib(Math.max(0, listing.room - listing.used))} free for decks
                  </div>
                </div>
              </div>

              {app !== null && !reads && decks.length > 0 && (
                <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-peach/30 bg-peach/[0.05] p-4">
                  <p className="min-w-0 flex-1 text-sm leading-relaxed text-subtext0">
                    <span className="font-semibold text-fg">
                      maki’s Flashcards app is version {app.label}.
                    </span>{' '}
                    Update it to 1.1 on Apps to see each deck’s cards here, and change them.
                  </p>
                  <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                    Apps
                  </Button>
                </div>
              )}

              {decks.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-surface1 px-4 py-6 text-center">
                  <p className="text-sm text-subtext1">No decks on maki yet.</p>
                  <p className="mt-1 text-xs text-overlay1">
                    Add one below: from a CSV or tab-separated file, pasted text, or Anki.
                  </p>
                </div>
              ) : (
                <ul className="mt-5 divide-y divide-surface0 rounded-xl border border-surface0">
                  {decks.map((d) => (
                    <li
                      key={d.id}
                      className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 ${open === d.id ? 'bg-peach/[0.06]' : ''}`}
                    >
                      <div className="min-w-[12rem] flex-1">
                        <div className="truncate font-medium text-fg">{d.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[0.7rem] text-overlay1">
                          {count(d.cards, 'card')} ·{' '}
                          {d.study > 0 ? `${d.study} for today` : 'nothing for today'}
                          {d.new > 0 ? ` · ${d.new} new` : ''} · {kib(d.size)}
                        </div>
                      </div>
                      <BoxChart boxes={d.boxes} />
                      <div className="flex gap-2">
                        {reads && (
                          <Button
                            small
                            kind={open === d.id ? 'quiet' : 'ghost'}
                            aria-label={`${open === d.id ? 'Close' : 'Open'} ${d.name}`}
                            title={
                              dirty
                                ? 'Send the changes to the deck that’s open, or discard them, first'
                                : undefined
                            }
                            disabled={!linked || dirty}
                            className="min-w-[4.5rem]"
                            onClick={() => setOpen(open === d.id ? null : d.id)}
                          >
                            {open === d.id ? 'Close' : 'Open'}
                          </Button>
                        )}
                        <Button
                          small
                          kind="quiet"
                          glyph="trash"
                          aria-label={`Remove ${d.name}`}
                          disabled={!linked || busy}
                          onClick={() => setAsking(asking === d.id ? null : d.id)}
                        >
                          Remove
                        </Button>
                      </div>
                      {asking === d.id && (
                        <div className="flex basis-full flex-wrap items-center gap-3 rounded-lg border border-red/30 bg-red/[0.05] px-3 py-2">
                          <span className="min-w-0 flex-1 text-sm text-subtext0">
                            Remove {d.name} from maki, and how well you know each of its cards? That
                            can’t be undone.
                          </span>
                          <Button
                            small
                            kind="danger"
                            disabled={!linked || busy}
                            onClick={() => void remove(d.id, d.name)}
                          >
                            Remove it
                          </Button>
                          <Button small kind="quiet" onClick={() => setAsking(null)}>
                            Keep it
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {said && (
                <p className={`mt-3 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                  {said.text}
                </p>
              )}
            </>
          )}
        </Card>
      )}

      {show && listing && openDeck && (
        <DeckEditor
          key={openDeck.id}
          link={link}
          deck={openDeck}
          listing={listing}
          busy={busy}
          setBusy={setBusy}
          reload={load}
          onClose={() => setOpen(null)}
          onDirty={setDirty}
          go={go}
        />
      )}

      {show && (
        <AddDeck link={link} listing={listing} busy={busy} setBusy={setBusy} reload={load} />
      )}
    </div>
  )
}

/**
 * A new deck from a file or pasted text, shown as maki will have it before it's sent to maki's
 * Flashcards app; under the name of one on maki, in its place, each card keeping its progress by its
 * front.
 */
function AddDeck({
  link,
  listing,
  busy,
  setBusy,
  reload
}: {
  link: Link
  listing: Listing | null
  busy: boolean
  setBusy: (busy: boolean) => void
  reload: () => Promise<Listing | string>
}): React.JSX.Element {
  const linked = link.state.linked
  const [text, setText] = useState('')
  const [from, setFrom] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [separator, setSeparator] = useState<Separator | 'auto'>('auto')
  const [deck, setDeck] = useState<string | null>(null)
  const [swap, setSwap] = useState(false)
  const [sending, setSending] = useState<{ have: number; of: number } | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  // the deck as read, then as maki will have it, worked out as the owner changes what it's read with
  const read = useMemo(
    () =>
      text.trim() === ''
        ? null
        : readDeck(text, {
            separator: separator === 'auto' ? undefined : separator,
            deck: deck ?? undefined
          }),
    [text, separator, deck]
  )
  const prepared = useMemo(
    () =>
      read === null
        ? null
        : prepareDeck(
            name,
            swap ? read.cards.map((c) => ({ ...c, front: c.back, back: c.front })) : read.cards
          ),
    [read, name, swap]
  )
  // the deck it replaces on maki, the one of that name; and the room it takes, against what's free
  const target = prepared && listing?.decks.find((d) => d.name === prepared.name)
  const free =
    listing === null
      ? null
      : listing.room -
        listing.used +
        (target ? target.size + 6 + new TextEncoder().encode(target.name).length : 0)
  const need =
    prepared === null || listing === null
      ? 0
      : storedSize(prepared.name, prepared.cards, listing.decks.length === 0, target?.id)
  const why =
    prepared === null
      ? null
      : (prepared.problem ??
        prepared.nameProblem ??
        (listing !== null && !target && listing.decks.length >= MAX_DECKS
          ? `maki keeps ${MAX_DECKS} decks: remove one there first, or give this one the name of the one it replaces`
          : free !== null && need > free
            ? `it takes about ${kib(need)} of maki’s room, and ${kib(free)} is free: remove a deck there, or send fewer cards`
            : null))

  const choose = (file: File): void => {
    file
      .arrayBuffer()
      .then((buffer) => {
        const { text, encoding } = decodeFile(new Uint8Array(buffer))
        const got = readDeck(text)
        setText(text)
        setSeparator('auto')
        setDeck(got.decks[0]?.name ?? null)
        setName(
          shortName(
            got.decks[0]?.name || got.name || file.name.replace(/\.(txt|csv|tsv|tab)$/i, '')
          )
        )
        setFrom(
          encoding === 'Windows-1252'
            ? `${file.name}, read as Windows-1252, as it isn’t UTF-8`
            : file.name
        )
        setSaid(null)
      })
      .catch((e) => setSaid({ ok: false, text: (e as Error).message }))
  }
  const clear = (): void => {
    setText('')
    setFrom(null)
    setDeck(null)
    setSeparator('auto')
    setSwap(false)
  }

  const send = async (): Promise<void> => {
    if (prepared === null || why !== null) return
    setBusy(true)
    setSaid(null)
    const bytes = deckBytes(prepared.name, prepared.cards)
    setSending({ have: 0, of: bytes.length })
    try {
      const sent = await sendDeck(
        (m) => link.appMessage(FLASHCARDS_APP, m),
        target?.id ?? 0,
        bytes,
        (have) => setSending({ have, of: bytes.length })
      )
      if (sent.ok) {
        setSaid({
          ok: true,
          text: `${prepared.name} sent to maki: ${count(sent.cards, 'card')}${target ? `, ${sent.kept} kept their progress` : ''}.`
        })
        clear()
        setName('')
      } else setSaid({ ok: false, text: sentence(sent.why) })
      await reload()
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
      setSending(null)
    }
  }

  return (
    <Card>
      <Label>add a deck</Label>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-subtext1">
        A card a line: its front, a tab or a comma, then its back. Paste them, or load a CSV or
        tab-separated file, or what Anki exports (File › Export, Cards in Plain Text). Under the
        name of a deck on maki, it replaces that deck, and each card whose front it still has keeps
        its progress.
      </p>

      <label className="mt-4 block">
        <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Cards
        </span>
        <textarea
          value={text}
          rows={5}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value)
            setFrom(null)
            setSaid(null)
          }}
          placeholder="A card a line: its front, a tab or a comma, then its back"
          className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
        />
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer text-subtext0 underline decoration-dotted hover:text-fg">
          Load a file
          <input
            type="file"
            accept=".txt,.csv,.tsv,.tab,text/plain,text/csv,text/tab-separated-values"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) choose(file)
              e.target.value = ''
            }}
          />
        </label>
        {from && <span className="text-xs text-overlay1">{from}</span>}
        {text !== '' && (
          <button
            className="text-xs text-overlay1 underline decoration-dotted hover:text-fg"
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>

      {read && prepared && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field
              label="Deck"
              value={name}
              placeholder="Spanish"
              onChange={(e) => {
                setName(e.target.value)
                setSaid(null)
              }}
              hint={
                prepared.nameProblem
                  ? sentence(prepared.nameProblem)
                  : `its name on maki, up to ${MAX_NAME} characters`
              }
            />
            {read.decks.length > 1 && (
              <label className="block">
                <span className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
                  Anki’s deck
                </span>
                <select
                  aria-label="Anki’s deck"
                  value={deck ?? ''}
                  onChange={(e) => {
                    setDeck(e.target.value)
                    setName(shortName(e.target.value))
                  }}
                  className="mt-1.5 w-full rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
                >
                  {read.decks.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name || 'no name'} ({count(d.notes, 'note')})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Segmented
              label="Separated by"
              value={separator === 'auto' ? read.separator : separator}
              options={[
                ['tab', 'tabs'],
                ['comma', 'commas'],
                ['semicolon', 'semicolons'],
                ['pipe', 'bars']
              ]}
              onChange={(s) => setSeparator(s)}
            />
            <label className="flex items-center gap-2 text-sm text-subtext1">
              <Toggle label="Back as the front" on={swap} onChange={setSwap} />
              Back as the front
            </label>
          </div>

          {prepared.cards.length > 0 && (
            <ul className="mt-4 divide-y divide-surface0 rounded-lg border border-surface1 font-mono text-xs">
              {prepared.cards.slice(0, PREVIEW).map((c, i) => (
                <li key={i} className="grid grid-cols-2 gap-3 px-3 py-1.5">
                  <span className="whitespace-pre-wrap break-words text-fg">{c.front}</span>
                  <span className="whitespace-pre-wrap break-words text-subtext1">{c.back}</span>
                </li>
              ))}
              {prepared.cards.length > PREVIEW && (
                <li className="px-3 py-1.5 text-overlay1">
                  and {count(prepared.cards.length - PREVIEW, 'card')} more
                </li>
              )}
            </ul>
          )}

          <div className="mt-3 space-y-1.5 text-xs text-overlay1">
            <p>
              {count(prepared.cards.length, 'card')} for maki, as it will show them
              {free !== null && prepared.cards.length > 0
                ? `: about ${kib(need)} of its room, where ${kib(free)} is free`
                : ''}
              .
            </p>
            {read.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
            {prepared.changed.length > 0 && (
              <p className="text-yellow">
                Changed to what maki’s fonts draw (Latin letters, Western Europe’s accents, digits
                and the usual punctuation):{' '}
                {prepared.changed
                  .map((c) => `${shown(c.from)} → ${shown(c.to)} (${c.times})`)
                  .join(', ')}
                .
              </p>
            )}
            {prepared.left.length > 0 && (
              <p className="text-yellow">
                Left out, {count(prepared.left.length, 'card')}:{' '}
                {prepared.left
                  .slice(0, PREVIEW)
                  .map((l) => `line ${l.line}, ${l.why}`)
                  .join('; ')}
                {prepared.left.length > PREVIEW
                  ? `; and ${prepared.left.length - PREVIEW} more`
                  : ''}
                .
                {prepared.left.length > PREVIEW && prepared.undrawable.length > 0
                  ? ` In all, maki’s fonts can’t draw ${prepared.undrawable
                      .slice(0, 24)
                      .map(shown)
                      .join(' ')}${prepared.undrawable.length > 24 ? ' …' : ''}.`
                  : ''}
              </p>
            )}
            {read.skipped.length > 0 && (
              <p className="text-yellow">
                Not cards:{' '}
                {read.skipped
                  .slice(0, PREVIEW)
                  .map((s) => `line ${s.line}, ${s.why}`)
                  .join('; ')}
                {read.skipped.length > PREVIEW ? `; and ${read.skipped.length - PREVIEW} more` : ''}
                .
              </p>
            )}
            {target && why === null && (
              <p>
                {target.name} is on maki: this replaces it, and each card whose front it still has
                keeps its progress.
              </p>
            )}
            {why !== null && <p className="text-yellow">{sentence(why)}</p>}
          </div>
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          small
          kind="primary"
          glyph="send"
          disabled={!linked || busy || prepared === null || why !== null}
          onClick={() => void send()}
        >
          {sending
            ? `Sending… ${kib(sending.have)} of ${kib(sending.of)}`
            : target
              ? `Replace ${target.name} on maki`
              : 'Send to maki'}
        </Button>
        {said && (
          <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</span>
        )}
      </div>
      <p className="mt-4 border-t border-surface0 pt-3 text-xs leading-relaxed text-overlay1">
        maki keeps {MAX_DECKS} decks, of up to {MAX_CARDS} cards each, in {kib(ROOM)}: about 2000
        cards of a word or two. A card’s front has up to {MAX_FRONT} characters and its back up to{' '}
        {MAX_BACK}. maki’s fonts draw Latin letters with Western Europe’s accents: other accents are
        dropped (ą as a), and cards in other scripts are left out, as this says before anything is
        sent.
      </p>
    </Card>
  )
}
