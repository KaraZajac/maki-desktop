import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { BrowserStatus } from '@shared/bridge-types'
import { Link } from '@shared/link'
import { TimeState } from '@shared/protocol'
import { DevTransport } from './transports'
import { chooseUsb, watchUsb } from './usb'

function formatClock(utcMs: number, tzOffsetS: number): string {
  return new Date(utcMs + tzOffsetS * 1000).toISOString().slice(11, 19)
}

/** Re-render whenever the link changes. */
function useLink(link: Link): Link {
  const version = useMemo(() => ({ n: 0 }), [])
  useSyncExternalStore(
    (notify) =>
      link.subscribe(() => {
        version.n++
        notify()
      }),
    () => version.n
  )
  return link
}

export default function App(): React.JSX.Element {
  const link = useLink(useMemo(() => new Link(window.maki.relay), []))
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null)
  const [, tick] = useState(0)

  useEffect(() => watchUsb(link), [link])
  useEffect(() => window.maki.onTraySync(() => void link.syncNow()), [link])
  useEffect(() => window.maki.onBrowserRequest((request) => link.fromBrowser(request)), [link])
  const [browsers, setBrowsers] = useState<BrowserStatus[] | null>(null)
  useEffect(() => {
    void window.maki.browsers.status().then(setBrowsers)
  }, [])
  useEffect(() => {
    void window.maki.settings.startAtLogin().then(setStartAtLogin)
  }, [])
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // keep the tray in step with the link
  const s = link.state
  const timeState = s.linked ? s.status.timeState : null
  useEffect(() => {
    window.maki.reportLink({ linked: s.linked, via: s.linked ? s.via : null, timeState })
  }, [s.linked, s.linked && s.via, timeState])

  const connectFake = async (): Promise<void> => {
    try {
      await link.attach(await DevTransport.open(), 'fake maki')
    } catch (e) {
      link.note(`fake maki not running on 127.0.0.1:7878 (${(e as Error).message})`)
    }
  }

  const badgeNow = s.linked && s.status.utcMs > 0 ? s.status.utcMs + (Date.now() - s.status.at) : null
  const drift = badgeNow !== null ? (badgeNow - Date.now()) / 1000 : null
  const state =
    timeState === TimeState.VERIFIED
      ? { label: 'verified', tone: 'text-emerald-400' }
      : timeState === TimeState.UNVERIFIED
        ? { label: 'unverified', tone: 'text-amber-400' }
        : { label: 'not set', tone: 'text-zinc-500' }

  return (
    <div className="flex h-full flex-col text-zinc-200">
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">maki</h1>
        <span className={`flex items-center gap-2 text-sm ${s.linked ? 'text-emerald-400' : 'text-zinc-500'}`}>
          <span className={`h-2 w-2 rounded-full ${s.linked ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          {s.linked ? `linked · ${s.via}` : 'looking for maki…'}
        </span>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto p-5">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Device</h2>
          {s.linked ? (
            <div className="flex items-baseline justify-between">
              <p className="text-lg">
                {s.hello.name} <span className="text-zinc-500">{s.hello.version}</span>
              </p>
              <button onClick={() => link.drop('disconnected')} className="text-sm text-zinc-500 hover:text-zinc-300">
                Disconnect
              </button>
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm text-zinc-400">Plug maki in. It links by itself once you’ve allowed it here.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => void chooseUsb(link)}
                  className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
                >
                  Allow maki
                </button>
                <button
                  onClick={() => void connectFake()}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500"
                >
                  Use fake maki
                </button>
              </div>
            </>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Clock</h2>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-3xl tabular-nums">
              {badgeNow !== null && s.linked ? formatClock(badgeNow, s.status.tzOffsetS) : '--:--:--'}
            </span>
            <span className={`text-sm ${state.tone}`}>{state.label}</span>
          </div>
          {drift !== null && (
            <p className="mt-1 text-xs text-zinc-500">
              {drift >= 0 ? '+' : ''}
              {drift.toFixed(1)} s from this computer
            </p>
          )}
          <div className="mt-4 flex items-center justify-between">
            <button
              disabled={!s.linked || link.syncing}
              onClick={() => void link.syncNow()}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500 disabled:opacity-40"
            >
              {link.syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={link.autoSync}
                onChange={(e) => {
                  link.autoSync = e.target.checked
                  link.note(`sync when linked: ${e.target.checked ? 'on' : 'off'}`)
                }}
              />
              Sync when linked
            </label>
          </div>
          {link.report && (
            <ul className="mt-4 space-y-1 text-sm">
              {link.report.servers.map((srv) => (
                <li key={srv.host} className="flex justify-between">
                  <span className="text-zinc-400">{srv.host}</span>
                  <span className={srv.result === 'verified' ? 'text-emerald-400' : 'text-amber-400'}>
                    {srv.result || 'no answer'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">This computer</h2>
          <label className="flex items-center justify-between text-sm text-zinc-300">
            Start maki at login, in the tray
            <input
              type="checkbox"
              disabled={startAtLogin === null}
              checked={!!startAtLogin}
              onChange={async (e) => setStartAtLogin(await window.maki.settings.setStartAtLogin(e.target.checked))}
            />
          </label>
          <p className="mt-2 text-xs text-zinc-500">Closing this window keeps maki linked from the tray.</p>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Browsers</h2>
          {browsers === null ? null : browsers.length === 0 ? (
            <p className="text-sm text-zinc-400">No supported browser found.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {browsers.map((b) => (
                <li key={b.name} className="flex items-center justify-between gap-3">
                  <span className="text-zinc-300">{b.name}</span>
                  {b.registered ? (
                    <span className="text-emerald-400">connected</span>
                  ) : (
                    <button
                      onClick={async () => {
                        try {
                          setBrowsers(await window.maki.browsers.register(b.name))
                          link.note(`${b.name} can reach maki desktop: add the maki extension to finish`)
                        } catch (e) {
                          link.note(`${b.name} setup failed: ${(e as Error).message}`)
                        }
                      }}
                      title={b.system ? `${b.name} only looks for browser helpers in a system folder` : undefined}
                      className="rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:border-zinc-500"
                    >
                      {b.system ? 'Set up (asks for admin password)' : 'Set up'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
          Apps — the maki app store will live here.
        </section>
      </main>

      <footer className="h-24 overflow-y-auto border-t border-zinc-800 px-5 py-2 font-mono text-xs text-zinc-500">
        {link.log.length === 0 ? 'Waiting for maki.' : link.log.map((l, i) => <div key={i}>{l}</div>)}
      </footer>
    </div>
  )
}
