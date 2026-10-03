import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import { showCheck, showMessage, showSays, shownText, SHOWQR_APP } from '@shared/showqr'
import { AppNeeded } from './AppNeeded'
import type { Apps } from './apps-state'
import { sentence } from './format'
import type { Page } from './pages'
import { Button, Card, Label, PageHeader } from './ui'

/**
 * What phones do more with than show as text, each as it's written: a start to edit. (Wi-Fi as
 * phones share networks; a number to call; an address to write to.)
 */
const KINDS: [string, string][] = [
  ['a Wi-Fi network', 'WIFI:S:name;T:WPA;P:password;;'],
  ['a number to call', 'tel:+15555550123'],
  ['an email to write', 'mailto:you@example.com']
]

/** Show QR: text from here on maki's screen as a QR code, for a phone to scan. */
function ShowQr({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element | null {
  const installed = apps.apps?.find((a) => a.id === SHOWQR_APP)
  const linked = link.state.linked
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  /** what maki's app is showing ('' for nothing), as it last said; null until it has */
  const [showing, setShowing] = useState<string | null>(null)
  // what maki would make of it, worked out as maki does, before it's sent
  const check = text === '' ? null : showCheck(text)

  /** What maki's app is showing now, as it says. */
  const look = async (): Promise<void> => {
    const r = await link.appMessage(SHOWQR_APP, Uint8Array.of('?'.charCodeAt(0)))
    setShowing(r.status === 'approved' ? shownText(r.answer) : null)
  }
  useEffect(() => {
    if (installed && linked) look().catch(() => setShowing(null))
  }, [link, installed, linked])

  const send = async (): Promise<void> => {
    if (!check?.ok) return
    setBusy(true)
    setSaid(null)
    try {
      const r = await link.appMessage(SHOWQR_APP, showMessage(text))
      const why =
        r.status === 'approved'
          ? showSays(r.answer)
          : r.status === 'unavailable'
            ? 'another app is open on maki: close it, or open Show QR there'
            : `maki’s Show QR app: ${r.status}`
      setSaid(
        why === null
          ? { ok: true, text: 'On maki now, in Show QR: open it there if it isn’t open.' }
          : { ok: false, text: why }
      )
      if (why === null) setShowing(text)
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (!installed || !linked) return null
  return (
    <>
      <Card>
        <Label>to show</Label>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-subtext1">
          maki shows it as a QR code, and the text itself a press away; it keeps the last five, left
          and right going through them there.
        </p>
        <textarea
          aria-label="To show"
          value={text}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value)
            setSaid(null)
          }}
          placeholder="A link, a Wi-Fi network, an address, a few words"
          className="mt-4 block w-full resize-y rounded-lg border border-surface1 bg-crust/60 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-overlay0 focus:border-peach/70"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-overlay1">
          <span>Start from what phones act on:</span>
          {KINDS.map(([kind, start]) => (
            <button
              key={kind}
              title={start}
              onClick={() => {
                setText(start)
                setSaid(null)
              }}
              className="rounded-full border border-surface1 px-2 py-0.5 text-subtext0 transition-colors hover:border-peach/60 hover:text-peach"
            >
              {kind}
            </button>
          ))}
        </div>
        {check && (
          <p className={`mt-3 text-xs ${check.ok ? 'text-overlay1' : 'text-yellow'}`}>
            {check.ok
              ? `${check.bytes} ${check.bytes === 1 ? 'byte' : 'bytes'}: a version ${check.version} QR code, ${check.pixels} pixels a module on maki’s screen.`
              : sentence(check.why)}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            small
            kind="primary"
            glyph="send"
            disabled={!linked || busy || !check?.ok}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Show on maki'}
          </Button>
          {said && (
            <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>{said.text}</span>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-4">
          <Label>on maki now</Label>
          <Button small kind="quiet" glyph="refresh" onClick={() => void look().catch(() => {})}>
            Look again
          </Button>
        </div>
        {showing === null ? (
          <p className="mt-3 text-sm text-overlay1">
            maki’s Show QR app hasn’t said: if another app is open on maki, go back to its home
            screen, and look again.
          </p>
        ) : showing === '' ? (
          <p className="mt-3 text-sm text-overlay1">Nothing yet: what you send shows here too.</p>
        ) : (
          <pre className="selectable mt-3 max-h-40 overflow-auto rounded-lg border border-surface0 bg-crust/50 px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap text-fg">
            {showing}
          </pre>
        )}
      </Card>
    </>
  )
}

/** Show QR's page. */
export function ShowQrPage({
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
        title="Show QR"
        lede="Anything you send from here, shown on maki’s screen as a QR code for a phone to read: a link, a Wi-Fi network, an address, a short text."
      />

      <AppNeeded
        link={link}
        apps={apps}
        id={SHOWQR_APP}
        name="Show QR"
        glyph="qr"
        pitch="With maki’s Show QR app, from the maki store, maki shows a link, a Wi-Fi network, an address or a few words from here as a QR code, for a phone to scan off its screen."
        go={go}
      />
      <ShowQr link={link} apps={apps} />
    </div>
  )
}
