import { useState } from 'react'
import { NOSTR_APP } from '@shared/nostr'
import type { Apps } from './apps-state'
import type { BunkerView } from './bunker-state'
import type { Page } from './pages'
import { Qr } from './Qr'
import { Button, Card, Glyph, Label, PageHeader, Toggle } from './ui'
import { GetIt } from './AppNeeded'

/** Nostr apps signing with maki's Nostr key, through maki desktop as their bunker (NIP-46). */
export function NostrPage({
  apps,
  go,
  bunker
}: {
  apps: Apps
  go: (page: Page) => void
  bunker: BunkerView
}): React.JSX.Element {
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="computer"
        title="Nostr"
        lede="Nostr apps on this computer and your phone sign with maki’s Nostr key, through maki desktop as their remote signer: maki shows each event and asks you before it signs."
      />

      <NostrRemote apps={apps} go={go} bunker={bunker} />
    </div>
  )
}

/** NIP-46: Nostr apps signing with maki's Nostr key, through maki desktop as their bunker. */
function NostrRemote({
  apps,
  go,
  bunker
}: {
  apps: Apps
  go: (page: Page) => void
  bunker: BunkerView
}): React.JSX.Element {
  const installed = apps.apps?.find((a) => a.id === NOSTR_APP)
  const [pasted, setPasted] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const act = async (f: () => Promise<void> | void): Promise<void> => {
    setProblem(null)
    try {
      await f()
    } catch (e) {
      setProblem((e as Error).message)
    }
  }
  const dot = (s: string): string =>
    s === 'open' ? 'bg-green' : s === 'connecting' ? 'bg-yellow' : 'bg-surface2'

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-peach">
          <Glyph name="send" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <Label>nostr apps</Label>
          {!installed ? (
            <div className="mt-2 flex items-center justify-between gap-4">
              <p className="text-sm text-subtext1">
                With maki’s Nostr app installed, Nostr apps on your phone or the web can sign with
                your Nostr key through maki desktop (NIP-46), each event shown on maki first.
              </p>
              <GetIt apps={apps} go={go} />
            </div>
          ) : (
            <>
              <label className="mt-2 flex items-center justify-between gap-4 text-sm text-fg">
                <span className="text-subtext1">
                  Nostr apps (Coracle, Nostrudel, Amethyst…) connect to maki desktop over relays and
                  ask it for your key and signatures, as a bunker (NIP-46). maki asks you before an
                  app first sees your key, and shows every event before it signs it; the key never
                  leaves maki.
                </span>
                <Toggle
                  label="Remote signing"
                  disabled={bunker.on === null}
                  on={!!bunker.on}
                  onChange={(on) => void act(() => bunker.turn(on))}
                />
              </label>
              {bunker.on && (
                <>
                  <div className="mt-4 flex flex-wrap items-start gap-4">
                    <Qr text={bunker.uri} className="h-36 w-36" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-relaxed text-overlay1">
                        Scan this in the app, or paste it where it asks for a bunker. It lets one
                        app connect: once one has, maki desktop makes a new one.
                      </p>
                      <code className="selectable mt-2 block truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-green">
                        {bunker.uri}
                      </code>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          small
                          glyph="copy"
                          onClick={async () => {
                            await window.maki.copy(bunker.uri)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                          }}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                        <Button
                          small
                          kind="ghost"
                          glyph="refresh"
                          onClick={() => void act(() => bunker.newLink())}
                        >
                          New link
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <input
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      placeholder="or an app’s own link: nostrconnect://…"
                      className="min-w-0 flex-1 rounded-lg border border-surface1 bg-crust/60 px-2.5 py-1.5 font-mono text-xs text-fg outline-none placeholder:text-overlay0 focus:border-peach/70"
                    />
                    <Button
                      small
                      kind="ghost"
                      disabled={busy || !pasted.trim().startsWith('nostrconnect://')}
                      onClick={() =>
                        void act(async () => {
                          setBusy(true)
                          try {
                            await bunker.connect(pasted)
                            setPasted('')
                          } finally {
                            setBusy(false)
                          }
                        })
                      }
                    >
                      {busy ? 'Look at maki…' : 'Connect'}
                    </Button>
                  </div>

                  <ul className="mt-4 divide-y divide-surface0 rounded-xl border border-surface0 bg-crust/40">
                    {bunker.clients.length === 0 && (
                      <li className="px-4 py-3 text-sm text-overlay1">No apps yet.</li>
                    )}
                    {bunker.clients.map((c) => (
                      <li
                        key={c.pubkey}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="min-w-0 text-sm text-fg">
                          {c.name}
                          <span className="ml-2 font-mono text-[0.68rem] text-overlay1">
                            since {new Date(c.since * 1000).toLocaleDateString()}
                          </span>
                        </span>
                        <Button small kind="danger" onClick={() => bunker.revoke(c.pubkey)}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-4 text-xs text-overlay1">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {bunker.relays.map((r) => (
                        <span key={r.url} className="inline-flex items-center gap-1.5 font-mono">
                          <span className={`h-1.5 w-1.5 rounded-full ${dot(r.state)}`} />
                          {r.url.replace(/^wss:\/\//, '')}
                        </span>
                      ))}
                      <button
                        className="text-peach hover:underline"
                        onClick={() => setEditing(bunker.configured.join('\n'))}
                      >
                        relays…
                      </button>
                    </div>
                    {editing !== null && (
                      <div className="mt-2">
                        <textarea
                          value={editing}
                          onChange={(e) => setEditing(e.target.value)}
                          rows={3}
                          className="w-full resize-none rounded-lg border border-surface1 bg-crust/60 p-2.5 font-mono text-xs text-subtext1 outline-none focus:border-peach/70"
                        />
                        <div className="mt-1 flex gap-2">
                          <Button
                            small
                            onClick={() =>
                              void act(() => {
                                bunker.setRelays(editing.split(/\s+/).filter(Boolean))
                                setEditing(null)
                              })
                            }
                          >
                            Save relays
                          </Button>
                          <Button small kind="quiet" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
              {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
