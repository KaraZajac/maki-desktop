import { useState } from 'react'
import {
  CARD_LINE,
  CARD_LINES,
  CARD_NAME,
  cardMessage,
  cardProblem,
  CONTACTS_APP,
  contactsSays,
  readPeople,
  vcards,
  type Person
} from '@shared/contacts'
import type { Link } from '@shared/link'
import { AppNeeded } from './AppNeeded'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Badge, Button, Card, Field, Label, PageHeader } from './ui'

/** Words from maki or the link as a sentence: a capital (but for maki, which has none), and a full stop. */
const sentence = (s: string): string =>
  `${s.startsWith('maki') ? s[0] : s[0].toUpperCase()}${s.slice(1)}${/[.?]$/.test(s) ? '' : '.'}`

/** Why maki didn't pass a message to the Contacts app, in words. */
function linkSays(status: string): string {
  switch (status) {
    case 'unavailable':
      return 'another app is open on maki: go back to its home screen, or open Contacts there'
    case 'locked':
      return 'maki is locked: put its PIN in on maki'
    default:
      return `maki’s Contacts app: ${status}`
  }
}

/** "2 Oct 2026", from seconds since 1970. */
const day = (s: number): string =>
  new Date(s * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })

const PLACEHOLDERS = ['@you@hackers.town', 'you@example.org', 'example.org']

/**
 * Contacts's page: your card, made here for maki to sign and show as a QR code, beside how another
 * maki will keep it; the people you've met, shown here and saved as vCards once you say yes on
 * maki; and how cards are swapped at the con.
 */
export function ContactsPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === CONTACTS_APP)
  const ready = link.state.linked && apps.status === 'approved' && installed !== undefined
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="on maki"
        title="Contacts"
        lede="Your card, which maki signs and shows as a QR code for someone else’s maki to scan, and the people you’ve met that way, to save as vCards."
      />

      <AppNeeded
        link={link}
        apps={apps}
        id={CONTACTS_APP}
        name="Contacts"
        glyph="person"
        pitch="With maki’s Contacts app, from the maki store, maki shows your card as a QR code, signed by your maki, to swap at the con, and keeps who you met."
        go={go}
      />

      {ready && <YourCard link={link} />}
      {ready && <People link={link} />}
      {ready && <AtTheCon />}
    </div>
  )
}

/** Sends `message` to the Contacts app: its answer if it did what was asked, else why not. */
async function ask(
  link: Link,
  message: Uint8Array
): Promise<{ answer: Uint8Array } | { why: string }> {
  const r = await link.appMessage(CONTACTS_APP, message)
  const why = r.status === 'approved' ? contactsSays(r.answer) : linkSays(r.status)
  return why === null ? { answer: r.answer } : { why: sentence(why) }
}

/** Your card: a name and up to three lines, beside how another maki keeps it. */
function YourCard({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [name, setName] = useState('')
  const [lines, setLines] = useState<string[]>(Array(CARD_LINES).fill(''))
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const problem = name === '' && lines.every((l) => l === '') ? null : cardProblem(name, lines)
  const shown = lines.map((l) => l.trim()).filter((l) => l !== '')

  const make = async (): Promise<void> => {
    const m = cardMessage(name, lines)
    if (!m) return
    setBusy(true)
    setSaid(null)
    try {
      const r = await ask(link, m)
      setSaid(
        'why' in r
          ? { ok: false, text: r.why }
          : { ok: true, text: 'Your card is on maki: open Contacts there to show it.' }
      )
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <Label>your card</Label>
        <div className="mt-4 grid gap-3">
          <Field
            label="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSaid(null)
            }}
            placeholder="Kara Zajac"
            hint={`up to ${CARD_NAME} bytes: a letter each, accents two`}
          />
          {lines.map((l, i) => (
            <Field
              key={i}
              label={`Line ${i + 1}`}
              value={l}
              onChange={(e) => {
                setLines(lines.map((x, j) => (j === i ? e.target.value : x)))
                setSaid(null)
              }}
              placeholder={PLACEHOLDERS[i]}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-overlay1">
          A handle, an email, a site or a phone number: up to {CARD_LINE} bytes a line. Lines left
          empty aren’t on the card.
        </p>
        {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            kind="primary"
            glyph="send"
            disabled={!linked || busy || name.trim() === '' || problem !== null}
            onClick={() => void make()}
          >
            {busy ? 'Say yes on maki…' : 'Make it my card'}
          </Button>
          {said && (
            <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</span>
          )}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-overlay1">
          maki doesn’t tell this computer the card it has: this one takes its place once you say yes
          on maki. maki signs it with a key from your recovery phrase, so a maki restored from the
          phrase signs it the same.
        </p>
      </Card>

      <Card>
        <Label>on their maki</Label>
        <p className="mt-3 text-sm text-subtext1">
          What another maki keeps once it scans your card, and shows when they open you:
        </p>
        <div className="mt-4 flex justify-center">
          <div
            className="w-full max-w-[17rem] rounded-xl border border-surface1/70 bg-oled px-4 py-3.5 font-mono text-rice shadow-[0_10px_30px_-14px_rgba(0,0,0,0.9)]"
            aria-label="Your card as another maki shows it"
          >
            <div className="truncate text-[0.95rem] font-bold">
              {name.trim() || <span className="text-rice/30">your name</span>}
            </div>
            <div className="mt-2 min-h-[3.4rem] space-y-0.5 text-[0.72rem] leading-snug">
              {shown.length === 0 ? (
                <div className="text-rice/30">your lines</div>
              ) : (
                shown.map((l, i) => (
                  <div key={i} className="truncate">
                    {l}
                  </div>
                ))
              )}
            </div>
            <div className="mt-3 text-[0.72rem] leading-snug">
              <div>met {day(Date.now() / 1000)}</div>
              <div>signed by your maki</div>
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-overlay1">
          On maki’s own screen, your card is a QR code: name, lines, maki’s key and its signature.
          Their maki checks the signature before it keeps you.
        </p>
      </Card>
    </div>
  )
}

/** The people you've met, shown and saved as vCards once you say yes on maki. */
function People({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [people, setPeople] = useState<Person[] | null>(null)
  const [busy, setBusy] = useState<'ask' | 'save' | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)

  const show = async (): Promise<void> => {
    setBusy('ask')
    setSaid(null)
    try {
      const r = await ask(link, Uint8Array.of('P'.charCodeAt(0)))
      if ('why' in r) {
        setSaid({ ok: false, text: r.why })
        return
      }
      const got = readPeople(r.answer)
      if (got === null) setSaid({ ok: false, text: 'maki’s Contacts app answered oddly.' })
      else setPeople(got.slice().reverse())
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const save = async (): Promise<void> => {
    if (!people || people.length === 0) return
    setBusy('save')
    setSaid(null)
    try {
      const path = await window.maki.contacts.save(vcards(people))
      if (path)
        setSaid({
          ok: true,
          text: `${people.length} ${people.length === 1 ? 'person' : 'people'} saved to ${path}`
        })
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const signed = people?.filter((p) => p.signed).length ?? 0

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Label>people you met</Label>
        <div className="flex gap-2">
          <Button
            small
            kind={people ? 'quiet' : 'ghost'}
            glyph={people ? 'refresh' : 'eye'}
            disabled={!linked || busy !== null}
            onClick={() => void show()}
          >
            {busy === 'ask' ? 'Say yes on maki…' : people ? 'Ask again' : 'Show them here'}
          </Button>
          {people && people.length > 0 && (
            <Button
              small
              kind="ghost"
              glyph="download"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              Save as vCards…
            </Button>
          )}
        </div>
      </div>

      {people === null ? (
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-subtext1">
          maki keeps who you met, from the cards it scanned: a maki’s, whose signature it checked,
          or a phone’s contact QR code. It asks you before this computer sees them; then they’re
          shown here until you leave this page, and saved as vCards for your address book if you
          choose.
        </p>
      ) : people.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-surface1 px-4 py-6 text-center">
          <p className="text-sm text-subtext1">Nobody yet.</p>
          <p className="mt-1 text-xs text-overlay1">
            On maki, open Contacts and pick Scan a card from its menu.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-5 font-mono">
            <span className="text-[1.45rem] font-bold tracking-[-0.03em] text-fg">
              {people.length}
            </span>{' '}
            <span className="ml-1 text-sm text-overlay1">
              {people.length === 1 ? 'person' : 'people'}, {signed} signed by their maki
            </span>
          </div>
          <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0">
            {people.map((p, i) => (
              <li
                key={`${i}:${p.key ?? p.name}`}
                className="flex flex-wrap items-start gap-x-6 gap-y-1 px-4 py-3"
              >
                <div className="min-w-[12rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg">{p.name}</span>
                    {p.signed ? (
                      <Badge kind="built">signed</Badge>
                    ) : (
                      <Badge kind="later">from a phone</Badge>
                    )}
                  </div>
                  {p.lines.length > 0 && (
                    <div className="mt-0.5 truncate font-mono text-[0.72rem] text-subtext0">
                      {p.lines.join(' · ')}
                    </div>
                  )}
                </div>
                <div className="text-right font-mono text-[0.68rem] leading-relaxed text-overlay1">
                  <div>{p.met > 0 ? `met ${day(p.met)}` : 'met before maki knew the date'}</div>
                  {p.key && <div title={p.key}>key {p.key.slice(0, 16)}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {said && (
        <p className={`mt-3 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</p>
      )}
    </Card>
  )
}

/** How cards are swapped, on maki. */
function AtTheCon(): React.JSX.Element {
  const steps: [string, string][] = [
    ['Show your card', 'Open Contacts on maki: its first screen is your card’s QR code.'],
    [
      'Scan theirs',
      'Contacts’ menu, Scan a card: maki checks a maki card’s signature, and keeps a phone’s contact QR code (a vCard or a MECARD) too, marked as unsigned.'
    ],
    [
      'See who you met',
      'Contacts’ menu, People you met: left and right go through them, by when you met.'
    ],
    ['Forget someone', 'Open them, then Forget this one from the menu.']
  ]
  return (
    <Card>
      <Label>at the con</Label>
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
