import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import {
  addMessage,
  type Alphabet,
  changeMessage,
  COLDCARD_LENGTH,
  entryProblem,
  freeNumber,
  LENGTHS,
  listMessage,
  MOST_ENTRIES,
  type PasswordEntry,
  PASSWORDS_APP,
  passwordSays,
  readList,
  removeMessage,
  SITE_BYTES,
  USER_BYTES
} from '@shared/passwords'
import { SIGN_TIMEOUT_MS } from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader, Segmented, Toggle } from './ui'

/** What the form holds: numbers as typed, until they're sent. */
interface Draft {
  id: number
  site: string
  user: string
  number: string
  length: string
  alphabet: Alphabet
  enter: boolean
}

const blank = (number: number): Draft => ({
  id: 0,
  site: '',
  user: '',
  number: String(number),
  length: String(COLDCARD_LENGTH),
  alphabet: 'base64',
  enter: true
})

/** The entries on maki, a page of the app's answer at a time. */
async function entriesOn(link: Link): Promise<PasswordEntry[] | null> {
  const entries: PasswordEntry[] = []
  for (;;) {
    const r = await link.appMessage(PASSWORDS_APP, listMessage(entries.length))
    const page = r.status === 'approved' ? readList(r.answer) : null
    if (!page) return null
    entries.push(...page.entries)
    if (entries.length >= page.total || page.entries.length === 0) return entries
  }
}

/**
 * Password Maker: which of the passwords maki makes from the recovery phrase (BIP-85) is which. maki
 * types or shows each itself; this computer never sees one.
 */
export function Passwords({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === PASSWORDS_APP)
  const linked = link.state.linked
  const [entries, setEntries] = useState<PasswordEntry[] | null>(null)
  const [draft, setDraft] = useState<Draft>(blank(0))
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const load = async (): Promise<void> => {
    const got = await entriesOn(link)
    setEntries(got)
    if (got) setDraft((d) => (d.id === 0 && d.site === '' ? blank(freeNumber(got)) : d))
  }
  useEffect(() => {
    if (installed && linked) load().catch(() => {})
  }, [link, installed, linked])

  const entry: PasswordEntry = {
    id: draft.id,
    site: draft.site,
    user: draft.user,
    number: Number(draft.number),
    length: Number(draft.length),
    alphabet: draft.alphabet,
    enter: draft.enter
  }
  // nothing to say of a form not filled in yet: Add waits for a site anyway
  const problem =
    draft.site.trim() === '' || draft.number.trim() === '' || draft.length.trim() === ''
      ? null
      : entryProblem(entry)
  const [least, most] = LENGTHS[draft.alphabet]

  /** Sends `m` and says what maki's Password Maker made of it. */
  const send = async (m: Uint8Array, done: string): Promise<boolean> => {
    setBusy(true)
    setSaid(null)
    try {
      // maki's review waits two minutes for its owner: this waits for its answer as long
      const r = await link.appMessage(PASSWORDS_APP, m, SIGN_TIMEOUT_MS)
      const why =
        r.status === 'approved' ? passwordSays(r.answer) : `maki’s Password Maker: ${r.status}`
      if (why !== null) {
        setSaid({ ok: false, text: why })
        return false
      }
      setSaid({ ok: true, text: done })
      await load()
      return true
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
      return false
    } finally {
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    const m = draft.id === 0 ? addMessage(entry) : changeMessage(entry)
    if (!m) {
      setSaid({ ok: false, text: entryProblem(entry) ?? 'maki’s Password Maker wouldn’t take it.' })
      return
    }
    const done = draft.id === 0 ? `${entry.site} added on maki.` : `${entry.site} changed on maki.`
    if (await send(m, done)) setDraft(blank(freeNumber([...(entries ?? []), entry])))
  }
  const edit = (e: PasswordEntry): void => {
    setSaid(null)
    setDraft({
      id: e.id,
      site: e.site,
      user: e.user,
      number: String(e.number),
      length: String(e.length),
      alphabet: e.alphabet,
      enter: e.enter
    })
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="key" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>password maker</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Password Maker installed, maki types passwords it makes from your
                recovery phrase (BIP-85): none is stored anywhere, and restoring maki restores them
                all.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki makes each password from your recovery phrase and types it, or shows it,
                itself, once you say yes on maki: this computer never sees one. Say here which is
                which; maki asks you before each change. A number makes the same password every
                time, on any maki with your phrase, and number N at {COLDCARD_LENGTH} base64
                characters is what a Coldcard’s Type Passwords types for N.
              </p>

              {entries && entries.length > 0 && (
                <ul className="mt-4 divide-y divide-surface0 rounded-lg border border-surface1">
                  {entries.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-fg">{e.site}</div>
                        <div className="truncate font-mono text-[0.7rem] text-overlay1">
                          {e.user || 'no username'} · number {e.number} · {e.length} {e.alphabet}
                          {e.enter ? ' · Enter' : ''}
                        </div>
                      </div>
                      <Button small kind="ghost" disabled={!linked || busy} onClick={() => edit(e)}>
                        Edit
                      </Button>
                      <Button
                        small
                        kind="ghost"
                        glyph="trash"
                        aria-label={`Remove ${e.site}`}
                        disabled={!linked || busy}
                        onClick={() =>
                          void send(removeMessage(e.id), `${e.site} removed from maki.`)
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {entries && entries.length === 0 && (
                <p className="mt-4 text-xs text-overlay1">None on maki yet.</p>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field
                  label="Site"
                  value={draft.site}
                  placeholder="github.com"
                  onChange={(e) => setDraft({ ...draft, site: e.target.value })}
                  hint={`what maki lists it as, up to ${SITE_BYTES} bytes`}
                />
                <Field
                  label="Username"
                  value={draft.user}
                  maxLength={USER_BYTES}
                  placeholder="you@example.com"
                  onChange={(e) => setDraft({ ...draft, user: e.target.value })}
                  hint="maki types it before a Tab when you log in"
                />
                <Field
                  label="Number"
                  value={draft.number}
                  inputMode="numeric"
                  placeholder="0"
                  onChange={(e) =>
                    setDraft({ ...draft, number: e.target.value.replace(/\D/g, '') })
                  }
                  hint="a new number is a new password"
                />
                <Field
                  label="Length"
                  value={draft.length}
                  inputMode="numeric"
                  placeholder={String(COLDCARD_LENGTH)}
                  onChange={(e) =>
                    setDraft({ ...draft, length: e.target.value.replace(/\D/g, '') })
                  }
                  hint={`${least} to ${most} characters`}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <Segmented
                  label="Alphabet"
                  value={draft.alphabet}
                  options={[
                    ['base64', 'letters, digits, + /'],
                    ['base85', 'and more symbols']
                  ]}
                  onChange={(alphabet) => setDraft({ ...draft, alphabet })}
                />
                <Toggle
                  label="Press Enter after it"
                  on={draft.enter}
                  onChange={(enter) => setDraft({ ...draft, enter })}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  small
                  kind="primary"
                  glyph="send"
                  disabled={!linked || busy || draft.site.trim() === '' || problem !== null}
                  onClick={() => void save()}
                >
                  {busy ? 'Say yes on maki…' : draft.id === 0 ? 'Add to maki' : 'Change on maki'}
                </Button>
                {draft.id !== 0 && (
                  <Button
                    small
                    kind="ghost"
                    onClick={() => setDraft(blank(freeNumber(entries ?? [])))}
                  >
                    Cancel
                  </Button>
                )}
                {problem && <span className="text-sm text-yellow">{problem}</span>}
                {!problem && said && (
                  <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                    {said.text}
                  </span>
                )}
              </div>
              <p className="mt-3 text-xs text-overlay1">
                maki keeps {MOST_ENTRIES} at most. To change a site’s password, give it a new
                number: the old one stays what it was. maki types as a US keyboard does: on a
                computer set to another layout, symbols come out as that layout has them.
              </p>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

/** Password Maker's page. */
export function PasswordMakerPage({
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
        title="Password Maker"
        lede="Passwords maki makes from your recovery phrase and types for you, the same on any maki with your phrase: none is stored anywhere, so restoring maki restores them all."
      />

      <Passwords link={link} apps={apps} go={go} />
    </div>
  )
}
