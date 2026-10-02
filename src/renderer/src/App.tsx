import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ProviderError } from '@shared/ethereum'
import { Link } from '@shared/link'
import { Store } from '@shared/store'
import { About } from './About'
import { Activity } from './Activity'
import { useApps, useKnownApps } from './apps-state'
import { useBunker } from './bunker-state'
import { AppsPage } from './AppsPage'
import { Backups } from './Backups'
import { BrowsersPage } from './Browsers'
import { ContactsPage } from './Contacts'
import { ErrorBoundary } from './ErrorBoundary'
import { FlashcardsPage } from './Flashcards'
import { KeysPage } from './Keys'
import { MacroPadPage } from './MacroPad'
import { NostrPage } from './Nostr'
import { NotesPage } from './Notes'
import { Overview } from './Overview'
import { PAGES, shown, type Page } from './pages'
import { PasswordMakerPage } from './Passwords'
import { ShowQrPage } from './ShowQr'
import { Sidebar } from './Sidebar'
import { SudoPage } from './Sudo'
import { DevTransport } from './transports'
import { chooseUsb, watchUsb } from './usb'
import { Wallets } from './Wallets'

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

function savedPage(): Page {
  try {
    const p = localStorage.getItem('maki.page')
    return PAGES.some((x) => x.id === p) ? (p as Page) : 'overview'
  } catch {
    return 'overview'
  }
}

export default function App(): React.JSX.Element {
  const link = useLink(
    useMemo(() => {
      const made = new Link(
        window.maki.relay,
        undefined,
        {
          save: (data) => window.maki.backups.save(data),
          latest: () => window.maki.backups.latest()
        },
        {
          rpc: async (url, method, params) => {
            const r = await window.maki.ethereum.rpc(url, method, params)
            if (r.error) throw new ProviderError(r.error.code, r.error.message)
            return r.result
          },
          store: {
            load: () => window.maki.ethereum.load(),
            save: (s, wallet) => window.maki.ethereum.save(s, wallet)
          }
        },
        {
          rpc: async (url, method, params) => {
            const r = await window.maki.solana.rpc(url, method, params)
            if (r.error) throw new ProviderError(r.error.code, r.error.message)
            return r.result
          },
          store: {
            load: () => window.maki.solana.load(),
            save: (s, wallet) => window.maki.solana.save(s, wallet)
          }
        }
      )
      // which wallet's files main reads and writes, in step with the link's from the start: told
      // the moment the link hears of another, before anything reads for it (messages to main go in
      // order)
      void window.maki.wallets.use(made.wallet)
      made.onWallet = (wallet) => void window.maki.wallets.use(wallet)
      return made
    }, [])
  )
  const apps = useApps(link)
  const known = useKnownApps(apps)
  const bunker = useBunker(link)
  const [chosen, setPage] = useState<Page>(savedPage)
  // an app's page that's gone from the sidebar (maki hasn't the app any more): the overview
  const page = shown(
    PAGES.find((p) => p.id === chosen)!,
    known
  )
    ? chosen
    : 'overview'
  const go = (p: Page): void => {
    setPage(p)
    try {
      localStorage.setItem('maki.page', p)
    } catch {
      // remembered for this session only
    }
  }
  const [backup, setBackup] = useState<{ at: number; bytes: number } | null>(null)
  // the latest backup's age: refresh when the link has news (a backup is a line in its log)
  useEffect(() => {
    void window.maki.backups.info().then(setBackup)
  }, [link.notes])
  const [, tick] = useState(0)
  const [storeName, setStoreName] = useState<string | null>(null)
  // on GitHub with no token: a store that can't be read may just be private
  const [storePrivate, setStorePrivate] = useState(false)

  // the maki store: its apps to show, and records for maki
  useEffect(() => {
    void window.maki.store.where().then(({ where, name, github, token }) => {
      setStoreName(name)
      setStorePrivate(github && !token)
      if (link.store) return
      link.storeWhere = where
      link.store = new Store(
        { get: (path) => window.maki.store.get(path) },
        { load: () => window.maki.store.load(), save: (kept) => window.maki.store.save(kept) }
      )
      void link.storeCheck().then(() => link.storeNow())
    })
  }, [link])

  useEffect(() => watchUsb(link), [link])
  useEffect(() => window.maki.onTraySync(() => void link.syncNow()), [link])
  useEffect(() => window.maki.onBrowserRequest((request) => link.fromBrowser(request)), [link])
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

  const updates =
    link.store?.index?.apps.filter((a) =>
      apps.apps?.some((i) => i.id === a.id && i.version < a.version)
    ).length ?? 0

  return (
    <div className="flex h-full text-fg">
      <Sidebar link={link} page={page} go={go} updates={updates} known={known} />
      <div className="glow flex min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto">
          <div key={page} className="mx-auto max-w-5xl px-10 pt-10 pb-12">
            <ErrorBoundary name={PAGES.find((p) => p.id === page)?.title ?? page}>
              {page === 'overview' && (
                <Overview
                  link={link}
                  apps={apps}
                  storeName={storeName}
                  backup={backup}
                  go={go}
                  connectFake={() => void connectFake()}
                  allow={() => void chooseUsb(link)}
                />
              )}
              {page === 'apps' && (
                <AppsPage
                  link={link}
                  apps={apps}
                  storeName={storeName}
                  storePrivate={storePrivate}
                  go={go}
                />
              )}
              {page === 'backups' && <Backups link={link} backup={backup} />}
              {page === 'wallets' && <Wallets link={link} apps={apps} />}
              {page === 'macropad' && <MacroPadPage link={link} apps={apps} go={go} />}
              {page === 'flashcards' && <FlashcardsPage link={link} apps={apps} go={go} />}
              {page === 'notes' && <NotesPage link={link} apps={apps} go={go} />}
              {page === 'contacts' && <ContactsPage link={link} apps={apps} go={go} />}
              {page === 'passwordmaker' && <PasswordMakerPage link={link} apps={apps} go={go} />}
              {page === 'showqr' && <ShowQrPage link={link} apps={apps} go={go} />}
              {page === 'browsers' && <BrowsersPage link={link} />}
              {page === 'keys' && <KeysPage link={link} apps={apps} go={go} />}
              {page === 'sudo' && <SudoPage link={link} apps={apps} go={go} />}
              {page === 'nostr' && <NostrPage apps={apps} go={go} bunker={bunker} />}
              {page === 'about' && <About link={link} updates={updates} go={go} />}
            </ErrorBoundary>
          </div>
        </main>
        <ErrorBoundary name="Activity">
          <Activity link={link} />
        </ErrorBoundary>
      </div>
    </div>
  )
}
