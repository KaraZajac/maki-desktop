import { useState } from 'react'
import {
  CARD_LINES,
  cardMessage,
  CONTACTS_APP,
  contactsSays,
  readPeople,
  vcards
} from '@shared/contacts'
import type { Link } from '@shared/link'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader } from './ui'

/** Contacts's page: what maki desktop does with maki's Contacts app. */
export function ContactsPage({
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
        title="Contacts"
        lede="Your card, which maki signs and shows for someone else’s maki to scan, and the people you’ve met that way, to save as vCards."
      />

      <Contacts link={link} apps={apps} go={go} />
    </div>
  )
}

/** Contacts: your card, which maki signs and shows to swap, and the people you met, as vCards. */
function Contacts({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === CONTACTS_APP)
  const linked = link.state.linked
  const [name, setName] = useState('')
  const [lines, setLines] = useState<string[]>(Array(CARD_LINES).fill(''))
  const [busy, setBusy] = useState<'card' | 'people' | null>(null)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const ask = async (what: 'card' | 'people', message: Uint8Array): Promise<Uint8Array | null> => {
    setBusy(what)
    setSaid(null)
    try {
      const r = await link.appMessage(CONTACTS_APP, message)
      const why =
        r.status === 'approved' ? contactsSays(r.answer) : `maki’s Contacts app: ${r.status}`
      if (why !== null) setSaid({ ok: false, text: why })
      return why === null ? r.answer : null
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
      return null
    } finally {
      setBusy(null)
    }
  }
  const setCard = async (): Promise<void> => {
    const m = cardMessage(name, lines)
    if (!m) {
      setSaid({ ok: false, text: 'A name of up to 32 bytes, and lines of up to 48.' })
      return
    }
    if (await ask('card', m))
      setSaid({ ok: true, text: 'Your card is on maki: open Contacts to show it.' })
  }
  const savePeople = async (): Promise<void> => {
    const a = await ask('people', Uint8Array.of('P'.charCodeAt(0)))
    const people = a ? readPeople(a) : null
    if (!people) return
    if (people.length === 0) {
      setSaid({ ok: true, text: 'Nobody yet: scan someone’s card on maki.' })
      return
    }
    const path = await window.maki.contacts.save(vcards(people))
    if (path) setSaid({ ok: true, text: `${people.length} people saved to ${path}` })
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="qr" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>contacts</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Contacts app installed, maki shows your card as a QR code, signed by
                your maki, to swap at the con, and keeps who you met.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                Your card: a name and up to three lines (a handle, an email, a site). maki signs it
                and shows it as a QR code; other makis check the signature when they scan it.
              </p>
              <div className="mt-4 grid gap-3">
                <Field
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Kara Zajac"
                />
                {lines.map((l, i) => (
                  <Field
                    key={i}
                    label={`Line ${i + 1}`}
                    value={l}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={['@you@hackers.town', 'you@example.org', 'example.org'][i]}
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  small
                  kind="primary"
                  glyph="send"
                  disabled={!linked || busy !== null || !name.trim()}
                  onClick={() => void setCard()}
                >
                  {busy === 'card' ? 'Say yes on maki…' : 'Make it my card'}
                </Button>
                <Button
                  small
                  kind="ghost"
                  glyph="download"
                  disabled={!linked || busy !== null}
                  onClick={() => void savePeople()}
                >
                  {busy === 'people' ? 'Say yes on maki…' : 'Save the people you met…'}
                </Button>
              </div>
              {said && (
                <p className={`mt-3 text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                  {said.text}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
