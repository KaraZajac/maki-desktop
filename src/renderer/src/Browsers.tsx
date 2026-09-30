import { useEffect, useState } from 'react'
import type { BrowserFamily, BrowserStatus, BrowsersView } from '@shared/bridge-types'
import type { Link } from '@shared/link'
import { Badge, Button, Card, Field, Glyph, Label, Segmented } from './ui'

/** What a browser's row says under its name. */
function detail(b: BrowserStatus): string {
  const parts = [b.family === 'firefox' ? 'Takes the Firefox extension' : 'Takes the Chrome extension']
  if (b.kind === 'flatpak') parts.push('a Flatpak: maki desktop shares one folder with its sandbox')
  if (b.kind === 'custom') parts.push('added by its folder')
  if (b.shares.length) parts.push(`connected together with ${b.shares.join(' and ')}, which read the same place`)
  if (b.restart) parts.push(`restart ${b.name} to finish: it was running before it could reach maki desktop`)
  else if (!b.registered && b.system) parts.push('it only looks in a system folder, so connecting asks for your admin password')
  return parts.join('; ') + '.'
}

/** The browsers the maki extension can reach maki desktop from: each connected, or not, here. */
export function BrowsersCard({ link }: { link: Link }): React.JSX.Element {
  const [view, setView] = useState<BrowsersView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [family, setFamily] = useState<BrowserFamily>('chromium')

  useEffect(() => {
    void window.maki.browsers.status().then(setView)
  }, [])
  // a Flatpak waiting to be restarted: see it happen
  const waiting = view?.browsers.some((b) => b.restart) ?? false
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => void window.maki.browsers.status().then(setView), 3000)
    return () => clearInterval(t)
  }, [waiting])

  async function change(b: BrowserStatus, how: 'connect' | 'disconnect' | 'remove'): Promise<void> {
    setBusy(b.id)
    try {
      const next =
        how === 'connect'
          ? await window.maki.browsers.register(b.id)
          : how === 'remove'
            ? await window.maki.browsers.remove(b.id)
            : await window.maki.browsers.unregister(b.id)
      setView(next)
      const now = next.browsers.find((x) => x.id === b.id)
      link.note(
        how === 'connect'
          ? now?.restart
            ? `${b.name} is connected: restart it, then add the maki extension there`
            : `${b.name} can reach maki desktop: add the maki extension there to finish`
          : how === 'remove'
            ? `${b.name} is disconnected and off the list`
            : `${b.name} can't reach maki desktop now`
      )
    } catch (e) {
      link.note(`${b.name}: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function add(): Promise<void> {
    setBusy('add')
    try {
      const next = await window.maki.browsers.add(name.trim(), family)
      if (!next) return
      setView(next)
      setAdding(false)
      setName('')
      link.note(`${name.trim()} can reach maki desktop: add the maki extension there to finish`)
    } catch (e) {
      link.note(`${name.trim()}: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="globe" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>browsers</Label>
          <p className="mt-2 text-sm text-subtext1">
            The maki extension fills logins and codes once you approve them on maki, and gives sites
            maki’s Ethereum, Solana and Nostr accounts. Connect each browser you use it in, then add
            the extension there.
          </p>
          {view === null ? null : view.browsers.length === 0 ? (
            <p className="mt-4 text-sm text-overlay1">No browser this list knows is on this computer.</p>
          ) : (
            <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
              {view.browsers.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-fg">{b.name}</span>
                      {b.kind === 'flatpak' && <Badge kind="info">flatpak</Badge>}
                      {b.kind === 'custom' && <Badge>added</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-overlay1">{detail(b)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {b.registered &&
                      (b.restart ? (
                        <Badge kind="warn">restart it</Badge>
                      ) : (
                        <Badge kind="built">
                          <Glyph name="check" className="h-3 w-3" /> connected
                        </Badge>
                      ))}
                    {b.registered ? (
                      <Button
                        small
                        aria-label={`Disconnect ${b.name}`}
                        disabled={busy !== null}
                        onClick={() => void change(b, 'disconnect')}
                      >
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        small
                        kind="ghost"
                        aria-label={`Connect ${b.name}`}
                        disabled={busy !== null}
                        onClick={() => void change(b, 'connect')}
                      >
                        {busy === b.id ? 'Connecting…' : 'Connect'}
                      </Button>
                    )}
                    {b.kind === 'custom' && (
                      <Button
                        small
                        kind="danger"
                        glyph="trash"
                        title={`Disconnect ${b.name} and take it off the list`}
                        aria-label={`Remove ${b.name}`}
                        disabled={busy !== null}
                        onClick={() => void change(b, 'remove')}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {view?.custom &&
            (adding ? (
              <div className="mt-3 space-y-3 rounded-xl border border-surface0 bg-crust/40 p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <Field
                    label="another browser"
                    placeholder="its name: Thorium, Waterfox…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-w-[14rem] flex-1"
                  />
                  <Segmented
                    label="which extension it takes"
                    value={family}
                    options={[
                      ['chromium', 'Chrome’s'],
                      ['firefox', 'Firefox’s']
                    ]}
                    onChange={setFamily}
                  />
                </div>
                <p className="text-xs leading-relaxed text-overlay1">
                  Then choose its folder (such as ~/.config/thorium, or ~/.waterfox), or the one it
                  looks for browser helpers in. For a browser installed as a Flatpak, its folder is
                  under ~/.var/app, and maki desktop shares one folder with its sandbox.
                </p>
                <div className="flex gap-2">
                  <Button small kind="primary" disabled={!name.trim() || busy !== null} onClick={() => void add()}>
                    {busy === 'add' ? 'Connecting…' : 'Choose its folder…'}
                  </Button>
                  <Button small onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <Button small glyph="plug" onClick={() => setAdding(true)}>
                  Another browser…
                </Button>
              </div>
            ))}
        </div>
      </div>
    </Card>
  )
}
