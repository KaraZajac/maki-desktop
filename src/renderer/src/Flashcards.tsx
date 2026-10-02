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
  readDeck,
  readList,
  removeMessage,
  ROOM,
  sendDeck,
  storedSize,
  type Listing,
  type Separator
} from '@shared/flashcards'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader, Segmented, Toggle } from './ui'

/** How many cards the preview shows, and how many of those left out it names. */
const PREVIEW = 5

/** A deck's name for maki from Anki's: as it is if it fits, else its last part (after `::`). */
function shortName(anki: string): string {
  if (chars(anki) <= MAX_NAME) return anki
  return [...(anki.split('::').pop() ?? anki)].slice(0, MAX_NAME).join('')
}

/** A character as the owner can read it: spaces and what's invisible by its code point. */
function shown(c: string): string {
  if (c === '') return 'nothing'
  return /^[\p{Z}\p{C}]$/u.test(c)
    ? `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    : c
}

/**
 * Flashcards: decks from a file or pasted text, shown as maki will have them before they're sent to
 * maki's Flashcards app; and the decks on maki, to remove.
 */
export function Flashcards({
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
  const [listing, setListing] = useState<Listing | null>(null)
  const [listSaid, setListSaid] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [from, setFrom] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [separator, setSeparator] = useState<Separator | 'auto'>('auto')
  const [deck, setDeck] = useState<string | null>(null)
  const [swap, setSwap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState<{ have: number; of: number } | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async (): Promise<void> => {
    const r = await link.appMessage(FLASHCARDS_APP, listMessage())
    const got = r.status === 'approved' ? readList(r.answer) : null
    setListing(got)
    setListSaid(
      r.status !== 'approved'
        ? linkSays(r.status)
        : got === null
          ? (flashcardsSays(r.answer) ?? 'maki’s Flashcards app answered oddly')
          : null
    )
  }
  useEffect(() => {
    if (installed && linked) load().catch(() => {})
  }, [link, installed, linked])

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
      } else setSaid({ ok: false, text: `${sent.why[0].toUpperCase()}${sent.why.slice(1)}.` })
      await load()
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
      setSending(null)
    }
  }
  const remove = async (id: number, deckName: string): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(FLASHCARDS_APP, removeMessage(id))
      const no = r.status === 'approved' ? flashcardsSays(r.answer) : linkSays(r.status)
      setSaid(
        no === null
          ? { ok: true, text: `${deckName} removed from maki.` }
          : { ok: false, text: `${no[0].toUpperCase()}${no.slice(1)}.` }
      )
      await load()
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
          <Glyph name="copy" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>flashcards</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Flashcards app installed, maki shows decks of cards from here a card at
                a time, and brings back those you don’t know sooner than those you do.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki shows a deck’s cards one at a time: the centre turns a card over, then left
                says you didn’t know it and right that you did. Cards you know come back less and
                less often (Leitner’s boxes). Send a deck from a CSV or tab-separated file, pasted
                text, or Anki (File › Export, Cards in Plain Text): a card a line, its front and its
                back.
              </p>

              {listing && listing.decks.length > 0 && (
                <ul className="mt-4 divide-y divide-surface0 rounded-lg border border-surface1">
                  {listing.decks.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-fg">{d.name}</div>
                        <div className="truncate font-mono text-[0.7rem] text-overlay1">
                          {count(d.cards, 'card')} ·{' '}
                          {d.study > 0 ? `${d.study} for today` : 'nothing for today'}
                          {d.new > 0 ? ` · ${d.new} new` : ''} · {kib(d.size)}
                        </div>
                      </div>
                      <Button
                        small
                        kind="ghost"
                        glyph="trash"
                        aria-label={`Remove ${d.name}`}
                        disabled={!linked || busy}
                        onClick={() => void remove(d.id, d.name)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {listing && listing.decks.length === 0 && (
                <p className="mt-4 text-xs text-overlay1">No decks on maki yet.</p>
              )}
              {listing && (
                <p className="mt-2 text-xs text-overlay1">
                  {kib(listing.used)} of {kib(listing.room)} used · {listing.decks.length} of{' '}
                  {MAX_DECKS} decks
                  {!listing.known
                    ? ' · maki doesn’t know the date: until it does, it studies as on the last day it knew'
                    : listing.streak >= 2
                      ? ` · ${listing.streak} days in a row`
                      : ''}
                </p>
              )}
              {listSaid && <p className="mt-2 text-xs text-yellow">{listSaid}</p>}

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
                          ? `${prepared.nameProblem[0].toUpperCase()}${prepared.nameProblem.slice(1)}.`
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
                          <span className="whitespace-pre-wrap break-words text-subtext1">
                            {c.back}
                          </span>
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
                        Changed to what maki’s fonts draw (Latin letters, Western Europe’s accents,
                        digits and the usual punctuation):{' '}
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
                        {read.skipped.length > PREVIEW
                          ? `; and ${read.skipped.length - PREVIEW} more`
                          : ''}
                        .
                      </p>
                    )}
                    {target && why === null && (
                      <p>
                        {target.name} is on maki: this replaces it, and each card whose front it
                        still has keeps its progress.
                      </p>
                    )}
                    {why !== null && (
                      <p className="text-yellow">{`${why[0].toUpperCase()}${why.slice(1)}.`}</p>
                    )}
                  </div>
                </>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-3">
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
                  <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                    {said.text}
                  </span>
                )}
              </div>
              <p className="mt-3 text-xs text-overlay1">
                maki keeps {MAX_DECKS} decks, of up to {MAX_CARDS} cards each, in {kib(ROOM)}: about
                2000 cards of a word or two. A card’s front has up to {MAX_FRONT} characters and its
                back up to {MAX_BACK}. maki’s fonts draw Latin letters with Western Europe’s
                accents: other accents are dropped (ą as a), and cards in other scripts are left
                out, as this says before anything is sent.
              </p>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** Flashcards's page. */
export function FlashcardsPage({
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
        title="Flashcards"
        lede="Decks you send from here, studied on maki a card at a time: the cards you don’t know come back sooner than those you do."
      />

      <Flashcards link={link} apps={apps} go={go} />
    </div>
  )
}
