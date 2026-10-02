import { useState } from 'react'
import type { Link } from '@shared/link'
import { showCheck, showMessage, showSays, SHOWQR_APP } from '@shared/showqr'
import type { Apps } from './apps-state'
import type { Page } from './pages'
import { Button, Card, Field, Glyph, Label, PageHeader } from './ui'

/** Show QR: text from here on maki's screen as a QR code, for a phone to scan. */
export function ShowQr({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === SHOWQR_APP)
  const linked = link.state.linked
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  // what maki would make of it, worked out as maki does, before it's sent
  const check = text === '' ? null : showCheck(text)
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
          <Glyph name="qr" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>show qr</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Show QR app installed, maki shows a link, a Wi-Fi network, an address or
                a few words from here as a QR code, for a phone to scan off its screen.
              </p>
              <Button small kind="ghost" glyph="apps" onClick={() => go('apps')}>
                Get it
              </Button>
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-subtext1">
                maki shows it as a QR code, and the text itself on its next page; it keeps the last
                five. A Wi-Fi network goes as phones share them:{' '}
                <code className="font-mono text-xs text-subtext0">
                  WIFI:S:name;T:WPA;P:password;;
                </code>
              </p>
              <Field
                className="mt-4"
                label="To show"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setSaid(null)
                }}
                placeholder="A link, a Wi-Fi network, an address, a few words"
              />
              {check && (
                <p className={`mt-2 text-xs ${check.ok ? 'text-overlay1' : 'text-yellow'}`}>
                  {check.ok
                    ? `${check.bytes} ${check.bytes === 1 ? 'byte' : 'bytes'}: a version ${check.version} QR code, ${check.pixels} pixels a module on maki’s screen.`
                    : `${check.why[0].toUpperCase()}${check.why.slice(1)}.`}
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
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
                  <span className={`text-sm ${said.ok ? 'text-green' : 'text-yellow'}`}>
                    {said.text}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
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

      <ShowQr link={link} apps={apps} go={go} />
    </div>
  )
}
