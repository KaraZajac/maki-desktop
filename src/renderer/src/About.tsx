import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import type { Page } from './pages'
import { Button, Card, Glyph, Label, PageHeader, Toggle } from './ui'
import { Updates } from './Updates'

/** What maki desktop runs on and where it keeps its files, as main says. */
interface AboutInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  data: string
}

/** maki's places on the web: the site, its docs, and the four repositories it's made from. */
const LINKS: { title: string; url: string; line: string }[] = [
  {
    title: 'maki.netslum.io',
    url: 'https://maki.netslum.io/',
    line: 'the site: downloads, the apps in the store'
  },
  {
    title: 'The docs',
    url: 'https://maki.netslum.io/docs/',
    line: 'how maki and maki desktop work'
  },
  {
    title: 'What’s new',
    url: 'https://maki.netslum.io/docs/changelog.html',
    line: 'each preview’s changes'
  },
  {
    title: 'maki-desktop',
    url: 'https://github.com/KaraZajac/maki-desktop',
    line: 'this app’s source'
  },
  {
    title: 'maki-firmware',
    url: 'https://github.com/KaraZajac/maki-firmware',
    line: 'maki’s firmware and the SDK'
  },
  {
    title: 'maki',
    url: 'https://github.com/KaraZajac/maki',
    line: 'the docs, the site, the emulator tests'
  },
  { title: 'maki-apps', url: 'https://github.com/KaraZajac/maki-apps', line: 'the maki store' }
]

/** maki desktop: its version and what it runs on, updates, its license, and this computer's settings. */
export function About({
  link,
  updates,
  go
}: {
  link: Link
  /** store apps newer than maki has */
  updates: number
  go: (page: Page) => void
}): React.JSX.Element {
  const s = link.state
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [license, setLicense] = useState<string | null>(null)
  const [showLicense, setShowLicense] = useState(false)
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    void window.maki.app.about().then(setInfo)
    void window.maki.settings.startAtLogin().then(setStartAtLogin)
  }, [])

  const toggleLicense = async (): Promise<void> => {
    setShowLicense((on) => !on)
    if (license === null) {
      try {
        setLicense(await window.maki.app.license())
      } catch (e) {
        setLicense(`maki desktop couldn’t read its license: ${(e as Error).message}`)
      }
    }
  }
  const attempt = async (step: () => Promise<void>): Promise<void> => {
    setProblem(null)
    try {
      await step()
    } catch (e) {
      setProblem((e as Error).message)
    }
  }

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="about"
        title="maki desktop"
        lede="maki’s companion on this computer: it holds maki’s link, keeps what maki shares with it, and brings ssh, git, browsers and wallets to maki, which asks you on its own screen before anything it does."
      />

      <Card>
        <Label>versions</Label>
        <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-subtext0">maki desktop</dt>
          <dd className="selectable font-mono text-fg">{info?.version ?? '…'}</dd>
          <dt className="text-subtext0">maki</dt>
          <dd className="selectable font-mono text-fg">
            {s.linked ? `${s.hello.name}, firmware ${s.hello.version}` : 'not linked'}
          </dd>
          <dt className="text-subtext0">runs on</dt>
          <dd className="selectable font-mono text-xs leading-6 text-subtext1">
            {info
              ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`
              : '…'}
          </dd>
        </dl>
      </Card>

      <Updates link={link} appUpdates={updates} goApps={() => go('apps')} />

      <Card>
        <Label>license</Label>
        <p className="mt-2 text-sm text-subtext1">
          maki desktop is free software under the MIT License, © 2026 .leviathan: use it, change it
          and share it, keeping the license with it. The code of others it carries comes with its
          own licenses and notices, all permissive.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button small kind="ghost" glyph="file" onClick={() => void toggleLicense()}>
            {showLicense ? 'Hide the license' : 'The license'}
          </Button>
          <Button
            small
            kind="ghost"
            glyph="file"
            onClick={() => void attempt(() => window.maki.app.notices())}
          >
            Third-party notices
          </Button>
        </div>
        {showLicense && (
          <pre className="selectable mt-4 max-h-72 overflow-y-auto rounded-lg border border-surface0 bg-crust px-4 py-3 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap text-subtext1">
            {license ?? '…'}
          </pre>
        )}
      </Card>

      <Card>
        <Label>links</Label>
        <ul className="mt-3 divide-y divide-surface0">
          {LINKS.map((l) => (
            <li key={l.url} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg">{l.title}</div>
                <div className="text-xs text-overlay1">{l.line}</div>
              </div>
              <button
                aria-label={`Open ${l.title}`}
                title={l.url}
                className="rounded-md p-1.5 text-overlay1 hover:bg-surface0/60 hover:text-fg"
                onClick={() => void window.maki.openExternal(l.url)}
              >
                <Glyph name="external" className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <Label>this computer</Label>
        <label className="mt-3 flex items-center justify-between gap-4 text-sm text-fg">
          Start maki desktop at login, in the tray
          <Toggle
            label="Start at login"
            disabled={startAtLogin === null}
            on={!!startAtLogin}
            onChange={async (on) => setStartAtLogin(await window.maki.settings.setStartAtLogin(on))}
          />
        </label>
        <p className="mt-1.5 text-xs text-overlay1">
          Closing this window keeps maki linked from the tray.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <code className="selectable min-w-0 flex-1 truncate rounded-lg border border-surface0 bg-crust px-3 py-2 font-mono text-xs text-subtext1">
            {info?.data ?? '…'}
          </code>
          <Button
            small
            kind="ghost"
            glyph="external"
            onClick={() => void attempt(() => window.maki.app.openData())}
          >
            Open
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-overlay1">
          Where maki desktop keeps what maki shared with it: accounts, settings, backups.
        </p>
        {problem && <p className="mt-3 text-xs text-red">{problem}</p>}
      </Card>
    </div>
  )
}
