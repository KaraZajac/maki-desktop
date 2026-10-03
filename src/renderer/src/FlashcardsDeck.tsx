import { useEffect, useMemo, useRef, useState } from 'react'
import type { Link } from '@shared/link'
import {
  BOXES,
  carried,
  chars,
  count,
  deckBytes,
  dueIn,
  FLASHCARDS_APP,
  kib,
  MAX_BACK,
  MAX_CARDS,
  MAX_FRONT,
  MAX_NAME,
  prepareDeck,
  readBack,
  sendDeck,
  storedSize,
  wait,
  type AppSend,
  type CardOnMaki,
  type DeckOnMaki,
  type DeckRead,
  type Listing
} from '@shared/flashcards'
import { sentence } from './format'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label } from './ui'

/** How many of a deck's cards show at first, and how many more each time. */
const PAGE = 100
/**
 * The cards' columns: its place, front and back; and in a window wide enough, its box, when it's
 * next due and what can be done to it (in a narrower one, those go under the front and back).
 */
const COLUMNS =
  'grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.25fr)] lg:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1.25fr)_6.5rem_5.5rem_7rem]'

/** `n` days, in words. */
const days = (n: number): string => (n === 1 ? 'day' : `${n} days`)

/** A character as the owner can read it: spaces and what's invisible by its code point. */
export function shown(c: string): string {
  if (c === '') return 'nothing'
  return /^[\p{Z}\p{C}]$/u.test(c)
    ? `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    : c
}

/**
 * A deck's cards in Leitner's boxes, as maki's deck page draws them: a column for each box, 1 to 7,
 * as tall as it's full against the fullest, its number under it. `large` also puts each box's count
 * on its column and how long it waits under its number. Each column says what it is on hover.
 */
export function BoxChart({
  boxes,
  large = false
}: {
  boxes: number[]
  large?: boolean
}): React.JSX.Element {
  const most = Math.max(1, ...boxes)
  const [w, gap, h, top, under, r] = large ? [24, 12, 56, 16, 30, 4] : [8, 3, 22, 1, 12, 2]
  const width = BOXES * w + (BOXES - 1) * gap
  const base = top + h
  const label = `Leitner’s boxes: ${boxes.map((n, i) => `box ${i + 1}, ${count(n, 'card')}`).join('; ')}`
  return (
    <svg
      width={width}
      height={base + under}
      viewBox={`0 0 ${width} ${base + under}`}
      role="img"
      aria-label={label}
      className="shrink-0 overflow-visible"
    >
      <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} stroke="var(--color-surface1)" />
      {boxes.map((n, i) => {
        const x = i * (w + gap)
        const tall = n === 0 ? 0 : Math.max(2, Math.round((n / most) * h))
        const round = Math.min(r, tall / 2, w / 2)
        const y = base - tall
        return (
          <g key={i}>
            <title>{`Box ${i + 1}: ${count(n, 'card')}, each back ${days(wait(i + 1))} after it was last seen`}</title>
            <rect x={x - gap / 2} y={0} width={w + gap} height={base + under} fill="transparent" />
            {tall > 0 && (
              <path
                d={`M${x},${base}V${y + round}Q${x},${y} ${x + round},${y}H${x + w - round}Q${x + w},${y} ${x + w},${y + round}V${base}Z`}
                fill="var(--color-peach)"
              />
            )}
            {large && (
              <text
                x={x + w / 2}
                y={y - 5}
                textAnchor="middle"
                className="fill-subtext0 font-mono text-[10px]"
              >
                {n}
              </text>
            )}
            <text
              x={x + w / 2}
              y={base + (large ? 12 : 10)}
              textAnchor="middle"
              className={`fill-overlay1 font-mono ${large ? 'text-[10px] font-bold' : 'text-[8px]'}`}
            >
              {i + 1}
            </text>
            {large && (
              <text
                x={x + w / 2}
                y={base + 25}
                textAnchor="middle"
                className="fill-overlay0 font-mono text-[9px]"
              >
                {wait(i + 1)}d
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** A card's box as seven pips, the ones up to it lit: how far along Leitner's boxes it is. */
function Pips({ box }: { box: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: BOXES }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-1.5 rounded-[2px] ${i < box ? 'bg-peach' : 'bg-surface1/70'}`}
        />
      ))}
    </span>
  )
}

/** What can be done to a card in the list: a quiet word, so a long list stays readable. */
function RowAction({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md px-1.5 py-0.5 font-mono text-[0.68rem] font-bold text-overlay1 transition-colors hover:bg-surface0/70 hover:text-peach disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** A card as it's changed here: where it came from in the deck as read (null: added here). */
interface Row {
  key: number
  from: number | null
  front: string
  back: string
  removed: boolean
}

/** Text to search: lower case, its accents taken off, so "senor" finds "señor". */
const searchable = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** A text area for one side of a card, with how much of the most it may hold it has. */
function Side({
  label,
  value,
  most,
  placeholder,
  onChange,
  autoFocus = false
}: {
  label: string
  value: string
  most: number
  placeholder: string
  onChange: (value: string) => void
  autoFocus?: boolean
}): React.JSX.Element {
  const n = chars(value)
  return (
    <label className="block min-w-0">
      <span className="flex items-baseline justify-between font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
        {label}
        <span className={`tracking-normal ${n > most ? 'text-yellow' : ''}`}>
          {n}/{most}
        </span>
      </span>
      <textarea
        value={value}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
      />
    </label>
  )
}

/**
 * A deck on maki, opened: its cards as maki has them, each with its box and when it's next due, to
 * search; changed here (cards changed, added and removed, the deck renamed) and sent back whole in
 * its place, each card keeping its progress by its front, as the app keeps it. Nothing reaches maki
 * until the changes are sent.
 */
export function DeckEditor({
  link,
  deck,
  listing,
  busy,
  setBusy,
  reload,
  onClose,
  onDirty,
  go
}: {
  link: Link
  deck: DeckOnMaki
  listing: Listing
  busy: boolean
  setBusy: (busy: boolean) => void
  reload: () => Promise<Listing | string>
  onClose: () => void
  onDirty: (dirty: boolean) => void
  go: (page: Page) => void
}): React.JSX.Element {
  const linked = link.state.linked
  const send: AppSend = (m) => link.appMessage(FLASHCARDS_APP, m)
  /** the deck as read, and what the list said of it then (to see it hasn't changed since) */
  const [read, setRead] = useState<{ deck: DeckRead; was: DeckOnMaki } | null>(null)
  const [readSaid, setReadSaid] = useState<{ why: string; update?: true } | null>(null)
  const [reading, setReading] = useState<{ have: number; of: number } | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState(deck.name)
  const [query, setQuery] = useState('')
  const [showing, setShowing] = useState(PAGE)
  const [editing, setEditing] = useState<{ key: number; front: string; back: string } | null>(null)
  const [adding, setAdding] = useState<{ front: string; back: string } | null>(null)
  const [sending, setSending] = useState<{ have: number; of: number } | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const nextKey = useRef(0)
  const top = useRef<HTMLDivElement>(null)
  /** the read under way: one at a time, as the app reads a deck from where the last piece ended */
  const inFlight = useRef(false)

  /** The deck read from maki afresh, what's changed here let go. */
  const readDeck = async (was: DeckOnMaki): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setReading({ have: 0, of: 0 })
    setReadSaid(null)
    try {
      const got = await readBack(send, was.id, (have, of) => setReading({ have, of }))
      if (!got.ok) {
        setReadSaid(got)
        return
      }
      setRead({ deck: got.deck, was })
      setRows(
        got.deck.cards.map((c, i) => ({
          key: nextKey.current++,
          from: i,
          front: c.front,
          back: c.back,
          removed: false
        }))
      )
      setName(got.deck.name)
      setEditing(null)
      setAdding(null)
    } catch (e) {
      setReadSaid({ why: (e as Error).message })
    } finally {
      inFlight.current = false
      setReading(null)
    }
  }
  useEffect(() => {
    if (linked) void readDeck(deck)
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const old = read?.deck.cards ?? []
  const live = rows.filter((r) => !r.removed)
  // the deck as maki will have it, and where each card's progress comes from
  const prepared = useMemo(
    () =>
      prepareDeck(
        name,
        live.map((r, i) => ({ front: r.front, back: r.back, line: i + 1 }))
      ),
    [rows, name]
  )
  const whole = prepared.left.length === 0
  const from = useMemo(
    () => (whole ? carried(old, prepared.cards) : live.map((r) => r.from)),
    [prepared, read]
  )
  const changed = rows.filter(
    (r) =>
      !r.removed &&
      r.from !== null &&
      (r.front !== old[r.from]?.front || r.back !== old[r.from]?.back)
  ).length
  const added = rows.filter((r) => !r.removed && r.from === null).length
  const removed = rows.filter((r) => r.removed && r.from !== null).length
  const renamed = read !== null && prepared.name !== read.deck.name
  const dirty = changed + added + removed > 0 || renamed
  useEffect(() => onDirty(dirty), [dirty])
  useEffect(() => () => onDirty(false), [])
  // the deck sent again from elsewhere (the import below, say), nothing changed here: read afresh
  useEffect(() => {
    const was = read?.was
    if (
      linked &&
      was &&
      !dirty &&
      (deck.name !== was.name || deck.cards !== was.cards || deck.size !== was.size)
    )
      void readDeck(deck)
  }, [deck, read, dirty, linked])

  // what it keeps of what it had: cards with progress on maki that still have it once it's sent
  const withProgress = old.filter((c) => c.box > 0).length
  const keeps = from.filter((i) => i !== null && old[i].box > 0).length
  const free =
    listing.room - listing.used + deck.size + 6 + new TextEncoder().encode(deck.name).length
  const need = storedSize(prepared.name, prepared.cards, false, deck.id)
  const taken = listing.decks.find((d) => d.id !== deck.id && d.name === prepared.name)
  const why =
    prepared.problem ??
    prepared.nameProblem ??
    (prepared.left.length > 0
      ? `card ${prepared.left[0].line} can’t be sent: ${prepared.left[0].why}${prepared.left.length > 1 ? `, and ${count(prepared.left.length - 1, 'card')} more can’t either` : ''}`
      : taken
        ? `another deck on maki is called ${taken.name}`
        : need > free
          ? `it takes about ${kib(need)} of maki’s room, and ${kib(free)} is free for it: remove some cards, or another deck`
          : null)
  /** each live row's problem, by its place in the deck */
  const problems = new Map(prepared.left.map((l) => [l.line, l.why]))

  // the cards new today: those a sitting today brings in, in the deck's order, after those due
  const newToday = new Set(
    old
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.box === 0)
      .slice(0, Math.max(0, deck.study - deck.due))
      .map(([, i]) => i)
  )

  const q = searchable(query.trim())
  // each card with its place in the deck as it will be sent (none for one removed)
  let place = 0
  const numbered = rows.map((r) => ({ row: r, at: r.removed ? null : place++ }))
  const matching =
    q === ''
      ? numbered
      : numbered.filter(
          ({ row }) => searchable(row.front).includes(q) || searchable(row.back).includes(q)
        )

  const change = (key: number, to: Partial<Row>): void => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...to } : r)))
    setSaid(null)
  }
  const finishEdit = (): void => {
    if (editing) change(editing.key, { front: editing.front, back: editing.back })
    setEditing(null)
  }
  const add = (): void => {
    if (!adding) return
    setRows((rs) => [
      ...rs,
      { key: nextKey.current++, from: null, front: adding.front, back: adding.back, removed: false }
    ])
    setAdding(null)
    setSaid({
      ok: true,
      text: `Added as card ${live.length + 1}: send the changes to keep it on maki.`
    })
  }
  const discard = (): void => {
    if (!read) return
    setRows(
      read.deck.cards.map((c, i) => ({
        key: nextKey.current++,
        from: i,
        front: c.front,
        back: c.back,
        removed: false
      }))
    )
    setName(read.deck.name)
    setEditing(null)
    setAdding(null)
    setSaid(null)
  }

  const sendChanges = async (): Promise<void> => {
    if (!read || why !== null) return
    setBusy(true)
    setSaid(null)
    try {
      // the deck as it was read, still: sent again from elsewhere since, this would undo that
      const listed = await reload()
      if (typeof listed === 'string') {
        setSaid({ ok: false, text: sentence(listed) })
        return
      }
      const now = listed.decks.find((d) => d.id === deck.id)
      const was = read.was
      if (!now) {
        setSaid({ ok: false, text: 'That deck isn’t on maki any more.' })
        return
      }
      if (now.name !== was.name || now.cards !== was.cards || now.size !== was.size) {
        setSaid({
          ok: false,
          text: `${was.name} changed on maki since it was read here: discard these changes and read it again, to change it as it is now.`
        })
        return
      }
      const bytes = deckBytes(prepared.name, prepared.cards)
      setSending({ have: 0, of: bytes.length })
      const sent = await sendDeck(send, deck.id, bytes, (have) =>
        setSending({ have, of: bytes.length })
      )
      if (!sent.ok) {
        setSaid({ ok: false, text: sentence(sent.why) })
        return
      }
      const after = await reload()
      const fresh =
        typeof after === 'string' ? undefined : after.decks.find((d) => d.id === deck.id)
      if (fresh) await readDeck(fresh)
      setSaid({
        ok: true,
        text: `${prepared.name} sent to maki: ${count(sent.cards, 'card')}, ${sent.kept} kept their progress.`
      })
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
      setSending(null)
    }
  }

  const changes = [
    changed > 0 ? `${count(changed, 'card')} changed` : '',
    added > 0 ? `${added} added` : '',
    removed > 0 ? `${removed} removed` : '',
    renamed ? `renamed ${prepared.name}` : ''
  ].filter((s) => s !== '')
  // cards maki has seen that stay in the deck, but without their progress (a front changed)
  const seenRemoved = rows.filter((r) => r.removed && r.from !== null && old[r.from].box > 0).length
  const losing = Math.max(0, withProgress - keeps - seenRemoved)

  return (
    <Card>
      <div ref={top} className="flex scroll-mt-6 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Label>cards</Label>
          <h3 className="mt-2 truncate font-mono text-xl font-bold tracking-[-0.02em] text-fg">
            {read?.deck.name ?? deck.name}
          </h3>
          <p className="mt-1 font-mono text-[0.72rem] text-overlay1">
            {count(deck.cards, 'card')} · {deck.new} new · {deck.due} due today · {kib(deck.size)}{' '}
            on maki
          </p>
        </div>
        <div className="flex items-center gap-2">
          {read && !dirty && (
            <Button
              small
              kind="quiet"
              glyph="refresh"
              disabled={!linked || busy || reading !== null}
              onClick={() => void readDeck(deck)}
            >
              Read again
            </Button>
          )}
          <Button
            small
            kind={dirty ? 'danger' : 'quiet'}
            glyph="close"
            aria-label={`Close ${deck.name}`}
            onClick={onClose}
          >
            {dirty ? 'Close without sending' : 'Close'}
          </Button>
        </div>
      </div>

      {readSaid && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-yellow/30 bg-yellow/[0.05] p-4">
          <p className="min-w-0 flex-1 text-sm text-subtext0">
            {readSaid.update
              ? 'maki’s Flashcards app is version 1.0, which can’t show a deck’s cards here. Update it on Apps (1.1 does), and open the deck again to see its cards and change them.'
              : sentence(readSaid.why)}
          </p>
          {readSaid.update ? (
            <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
              Apps
            </Button>
          ) : (
            <Button
              small
              kind="ghost"
              glyph="refresh"
              disabled={!linked}
              onClick={() => void readDeck(deck)}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {reading && (
        <p className="mt-4 text-sm text-overlay1">
          Reading {deck.name} from maki
          {reading.of > 0 ? `: ${kib(reading.have)} of ${kib(reading.of)}` : '…'}
        </p>
      )}

      {read && (
        <>
          <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
            <Field
              className="min-w-[16rem] flex-1"
              label="Name"
              value={name}
              placeholder="The deck’s name"
              maxLength={MAX_NAME * 2}
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
            <div>
              <div className="mb-2 font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
                Leitner’s boxes · back after
              </div>
              <BoxChart boxes={deck.boxes} large />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-lg border border-surface1 bg-crust/60 px-3 transition-colors focus-within:border-peach/70">
              <span className="sr-only">Search its cards</span>
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-overlay1"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
              <input
                value={query}
                placeholder="Search its cards"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setQuery(e.target.value)
                  setShowing(PAGE)
                }}
                className="min-w-0 flex-1 bg-transparent py-2 text-sm text-fg outline-none placeholder:text-overlay0"
              />
            </label>
            <span className="font-mono text-[0.7rem] text-overlay1">
              {q === ''
                ? count(live.length, 'card')
                : `${matching.length} of ${count(rows.length, 'card')}`}
            </span>
            <Button
              small
              kind="ghost"
              disabled={adding !== null || live.length >= MAX_CARDS}
              onClick={() => {
                setAdding({ front: '', back: '' })
                setEditing(null)
              }}
            >
              + Add a card
            </Button>
          </div>

          {adding && (
            <div className="mt-3 rounded-xl border border-peach/40 bg-peach/[0.04] p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Side
                  label="New card’s front"
                  value={adding.front}
                  most={MAX_FRONT}
                  placeholder="A new card’s front"
                  onChange={(front) => setAdding({ ...adding, front })}
                  autoFocus
                />
                <Side
                  label="New card’s back"
                  value={adding.back}
                  most={MAX_BACK}
                  placeholder="A new card’s back"
                  onChange={(back) => setAdding({ ...adding, back })}
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  small
                  kind="primary"
                  disabled={adding.front.trim() === '' || adding.back.trim() === ''}
                  onClick={add}
                >
                  Add it
                </Button>
                <Button small kind="quiet" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
                <span className="text-xs text-overlay1">
                  It goes at the end: maki brings new cards in a deck’s order.
                </span>
              </div>
            </div>
          )}

          <div className="mt-3 overflow-hidden rounded-xl border border-surface0">
            <div
              className={`grid ${COLUMNS} gap-3 border-b border-surface0 bg-crust/40 px-3 py-2 font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-overlay1`}
            >
              <span>#</span>
              <span>Front</span>
              <span>Back</span>
              <span className="hidden lg:block">Box</span>
              <span className="hidden lg:block">Next</span>
              <span className="hidden lg:block" />
            </div>
            {matching.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-overlay1">
                {q === '' ? 'No cards: add one, or the deck can’t be sent.' : 'No card has that.'}
              </p>
            )}
            <ul className="divide-y divide-surface0">
              {matching.slice(0, showing).map(({ row, at }) => {
                const was = row.from === null ? null : old[row.from]
                const source = at === null ? null : from[at]
                const isChanged =
                  row.from === null ||
                  (was !== null && (row.front !== was.front || row.back !== was.back))
                const problem = at === null ? undefined : problems.get(at + 1)
                // how it stands once sent: the progress it takes, or new
                const stands = source === null || source === undefined ? null : old[source]
                const label = row.front.split('\n')[0]
                if (editing?.key === row.key)
                  return (
                    <li key={row.key} className="bg-peach/[0.04] px-3 py-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Side
                          label={`Card ${at === null ? '' : at + 1}’s front`}
                          value={editing.front}
                          most={MAX_FRONT}
                          placeholder="Front"
                          onChange={(front) => setEditing({ ...editing, front })}
                          autoFocus
                        />
                        <Side
                          label="Back"
                          value={editing.back}
                          most={MAX_BACK}
                          placeholder="Back"
                          onChange={(back) => setEditing({ ...editing, back })}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          small
                          kind="primary"
                          disabled={editing.front.trim() === '' || editing.back.trim() === ''}
                          onClick={finishEdit}
                        >
                          Done
                        </Button>
                        <Button small kind="quiet" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        {was && editing.front !== was.front && was.box > 0 && (
                          <span className="text-xs text-yellow">
                            maki keeps a card’s progress by its front: with this front it starts
                            again, new.
                          </span>
                        )}
                      </div>
                    </li>
                  )
                return (
                  <li
                    key={row.key}
                    className={`grid ${COLUMNS} items-start gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm ${
                      row.removed
                        ? 'opacity-45'
                        : isChanged
                          ? 'bg-peach/[0.05] shadow-[inset_2px_0_0_var(--color-peach)]'
                          : ''
                    }`}
                  >
                    <span className="pt-0.5 font-mono text-[0.7rem] text-overlay1">
                      {at === null ? '–' : at + 1}
                    </span>
                    <span
                      className={`line-clamp-4 whitespace-pre-wrap break-words text-fg ${row.removed ? 'line-through' : ''}`}
                    >
                      {row.front}
                    </span>
                    <span
                      className={`line-clamp-4 whitespace-pre-wrap break-words text-subtext1 ${row.removed ? 'line-through' : ''}`}
                    >
                      {row.back}
                      {problem && (
                        <span className="mt-1 block text-xs text-yellow">{sentence(problem)}</span>
                      )}
                    </span>
                    {/* under the front and back in a narrow window, in columns of their own in a wide one */}
                    <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-x-4 lg:contents">
                      <span className="pt-0.5 font-mono text-[0.7rem]">
                        {row.removed ? (
                          <span className="text-overlay1">removed</span>
                        ) : row.from === null ? (
                          <span className="text-peach">added</span>
                        ) : stands === null ? (
                          <span
                            className="text-yellow"
                            title="maki keeps a card’s progress by its front: this one’s changed, so it starts again"
                          >
                            {was && was.box > 0 ? 'starts again' : 'new'}
                          </span>
                        ) : stands.box === 0 ? (
                          <span className="text-overlay1">new</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-2 text-subtext0"
                            title={`Box ${stands.box}: back ${days(wait(stands.box))} after it was last seen`}
                          >
                            <Pips box={stands.box} />
                            {stands.box}
                          </span>
                        )}
                      </span>
                      <span
                        className="pt-0.5 font-mono text-[0.7rem] text-subtext0"
                        title={
                          stands?.box === 0
                            ? `maki brings in ${listing.newADay} new cards a day from each deck, in its order (its menu says how many)`
                            : undefined
                        }
                      >
                        {row.removed || row.from === null || stands === null
                          ? '–'
                          : stands.box === 0
                            ? source !== null && newToday.has(source)
                              ? 'today'
                              : 'later'
                            : dueIn(stands, listing.today)}
                      </span>
                      <span className="ml-auto flex justify-end gap-1 lg:ml-0">
                        {row.removed ? (
                          <RowAction
                            label={`Keep ${label}`}
                            onClick={() => change(row.key, { removed: false })}
                          >
                            Undo
                          </RowAction>
                        ) : (
                          <>
                            <RowAction
                              label={`Edit ${label}`}
                              disabled={busy}
                              onClick={() => {
                                setEditing({ key: row.key, front: row.front, back: row.back })
                                setAdding(null)
                              }}
                            >
                              Edit
                            </RowAction>
                            <RowAction
                              label={`Remove ${label}`}
                              disabled={busy}
                              onClick={() =>
                                row.from === null
                                  ? setRows((rs) => rs.filter((r) => r.key !== row.key))
                                  : change(row.key, { removed: true })
                              }
                            >
                              Remove
                            </RowAction>
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
            {matching.length > showing && (
              <div className="flex items-center justify-between gap-3 border-t border-surface0 px-3 py-2">
                <span className="text-xs text-overlay1">
                  Showing {showing} of {matching.length}
                </span>
                <Button small kind="quiet" onClick={() => setShowing(showing + PAGE)}>
                  Show {Math.min(PAGE, matching.length - showing)} more
                </Button>
              </div>
            )}
          </div>

          {(dirty || said) && (
            <div className="sticky bottom-4 z-10 mt-4 rounded-xl border border-peach/40 bg-mantle/95 p-4 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.85)] backdrop-blur">
              {dirty && (
                <div className="space-y-1 text-sm text-subtext1">
                  <p>
                    <span className="font-semibold text-fg">Changed here, not sent yet:</span>{' '}
                    {changes.join(', ')}.
                  </p>
                  {whole && withProgress > 0 && (
                    <p className="text-xs text-overlay1">
                      Sent, {keeps === 1 ? '1 card keeps its' : `${keeps} cards keep their`}{' '}
                      progress
                      {losing > 0
                        ? `; ${losing} whose ${losing === 1 ? 'front changed starts' : 'fronts changed start'} again, new, as maki keeps a card’s progress by its front`
                        : ''}
                      {seenRemoved > 0
                        ? `; ${seenRemoved === 1 ? 'the one removed takes its' : `the ${seenRemoved} removed take theirs`} with ${seenRemoved === 1 ? 'it' : 'them'}`
                        : ''}
                      .
                    </p>
                  )}
                  {prepared.changed.length > 0 && (
                    <p className="text-xs text-yellow">
                      Changed to what maki’s fonts draw:{' '}
                      {prepared.changed.map((c) => `${shown(c.from)} → ${shown(c.to)}`).join(', ')}.
                    </p>
                  )}
                  {why !== null && <p className="text-xs text-yellow">{sentence(why)}</p>}
                </div>
              )}
              <div className={`flex flex-wrap items-center gap-3 ${dirty ? 'mt-3' : ''}`}>
                {dirty && (
                  <>
                    <Button
                      small
                      kind="primary"
                      glyph="send"
                      disabled={!linked || busy || why !== null}
                      onClick={() => void sendChanges()}
                    >
                      {sending
                        ? `Sending… ${kib(sending.have)} of ${kib(sending.of)}`
                        : 'Send changes to maki'}
                    </Button>
                    <Button small kind="quiet" disabled={busy} onClick={discard}>
                      Discard changes
                    </Button>
                  </>
                )}
                {said && (
                  <span
                    className={`min-w-0 flex-1 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}
                  >
                    {said.text}
                  </span>
                )}
                {said && !dirty && (
                  <button
                    aria-label="Put this away"
                    onClick={() => setSaid(null)}
                    className="rounded-md p-1 text-overlay1 transition-colors hover:bg-surface0/70 hover:text-fg"
                  >
                    <Glyph name="close" className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
