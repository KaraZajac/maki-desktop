import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fingerprint, formatPath, readBundle, walletCoins, type Bundle } from '@shared/bundle'
import type { AppSpace, InstalledApp } from '@shared/client'
import type { Link } from '@shared/link'
import type { ApprovalValue } from '@shared/protocol'
import { revoked, sourcePage, type StoreApp } from '@shared/store'
import type { Apps } from './apps-state'
import { appColours, StorageChart, takes } from './StorageChart'
import { ago, Badge, Button, bytes, Card, Glyph, Label, PageHeader, PixelIcon } from './ui'
import { PAGES, type Page } from './pages'

function why(approval: ApprovalValue, reason: string): string {
  switch (approval) {
    case 'refused':
      return `maki won't install it: ${reason}.`
    case 'denied':
      return 'You cancelled it on maki.'
    case 'timed out':
      return 'maki stopped waiting for an answer.'
    case 'locked':
      return 'maki is locked: enter its PIN first.'
    case 'no match':
      return 'maki has no such app.'
    case 'unavailable':
      return "maki couldn't: another app may be open on it, or its firmware has no app host."
    default:
      return `maki couldn't: ${approval}.`
  }
}

/** A bundle to install, from the store or a file, with its developer key's fingerprint. */
interface Chosen {
  bundle: Bundle
  developer: string
  store: StoreApp | null
}

/** A line of news across the page: something went wrong, or needs saying. */
function Banner({
  kind,
  children
}: {
  kind: 'danger' | 'warn'
  children: React.ReactNode
}): React.JSX.Element {
  const tone =
    kind === 'danger'
      ? 'border-red/40 bg-red/[0.07] text-red'
      : 'border-yellow/40 bg-yellow/[0.06] text-yellow'
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tone}`}>
      <Glyph name="warn" className="mt-0.5 h-4 w-4" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Nothing to show yet, and why. */
function Empty({
  glyph,
  title,
  children
}: {
  glyph: string
  title: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="card flex items-center gap-4 border-dashed px-5 py-6">
      <div className="rounded-xl border border-surface1 bg-crust p-2.5 text-overlay1">
        <Glyph name={glyph} className="h-5 w-5" />
      </div>
      <div>
        <div className="font-medium text-fg">{title}</div>
        {children && <div className="mt-0.5 text-sm text-subtext0">{children}</div>}
      </div>
    </div>
  )
}

/**
 * Apps on maki from this side: how much room they take, what's installed, and the maki store.
 * maki checks every bundle itself and asks its owner before installing or removing anything;
 * this shows what a bundle is and asks for, so the owner can compare with maki's screen.
 */
export function AppsPage({
  link,
  apps: state,
  storeName,
  storePrivate,
  go
}: {
  link: Link
  apps: Apps
  storeName: string | null
  /** on GitHub, with no token to read it: if it can't be read, it may be private */
  storePrivate: boolean
  go: (page: Page) => void
}): React.JSX.Element {
  const linked = link.state.linked
  const { status, apps, space, keys } = state
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // installing and removing need maki; looking at a bundle or the store doesn't
  const idle = linked && busy === null
  const store = link.store
  const index = store?.index ?? null
  const colours = appColours(apps)

  const run = async (what: string, f: () => Promise<void>): Promise<void> => {
    setBusy(what)
    setProblem(null)
    try {
      await f()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const choose = (): Promise<void> =>
    run('choose', async () => {
      const file = await window.maki.apps.open()
      if (!file) return
      const bundle = readBundle(file.data)
      setChosen({ bundle, developer: await fingerprint(bundle.developer), store: null })
    })

  // from the store: its bundle, checked against the index, to go through before maki does
  const chooseFromStore = (app: StoreApp): Promise<void> =>
    run(`store ${app.id}`, async () => {
      if (!link.store) return
      const bundle = await link.store.bundle(app)
      setChosen({ bundle, developer: await fingerprint(bundle.developer), store: app })
    })

  const install = (): Promise<void> =>
    run('install', async () => {
      if (!chosen) return
      const r = chosen.store
        ? await link.storeInstall(chosen.store)
        : await link.appInstall(chosen.bundle.manifest.name, chosen.bundle.bytes)
      if (r.approval === 'approved') {
        setChosen(null)
        await state.refresh()
      } else {
        setProblem(why(r.approval, r.reason))
      }
    })

  const remove = (app: InstalledApp): Promise<void> =>
    run(`remove ${app.id}`, async () => {
      const r = await link.appRemove(app.id, app.name)
      if (r === 'approved') await state.refresh()
      else setProblem(why(r, ''))
    })

  return (
    <div className="rise space-y-8">
      <PageHeader
        label="apps"
        title="Apps"
        lede="Apps for maki: from the maki store, reviewed and built from their source, or from a .maki file anyone can make. maki shows you each one on its own screen before it installs it."
        actions={
          <Button kind="ghost" glyph="file" disabled={busy !== null} onClick={() => void choose()}>
            Install from file…
          </Button>
        }
      />

      {problem && !chosen && <Banner kind="danger">{problem}</Banner>}

      <Card>
        <div className="flex items-center justify-between">
          <Label>maki’s storage</Label>
          {apps && apps.length > 0 && (
            <span className="font-mono text-[0.68rem] text-overlay1">
              {apps.length} {apps.length === 1 ? 'app' : 'apps'}
            </span>
          )}
        </div>
        <div className="mt-4">
          {!linked ? (
            <p className="text-sm text-subtext0">Plug maki in to see what its apps take.</p>
          ) : status === 'locked' ? (
            <p className="text-sm text-subtext0">
              maki is locked: enter its PIN on maki to see its apps.
            </p>
          ) : apps ? (
            <StorageChart space={space} apps={apps} />
          ) : (
            <p className="text-sm text-overlay1">Asking maki…</p>
          )}
        </div>
        <p className="mt-5 border-t border-surface0 pt-3 text-xs leading-relaxed text-overlay1">
          Apps share maki’s encrypted database with its logins, codes and passkeys
          {space ? `, and have ${bytes(space.space)} of it, for at most ${space.maxApps} apps` : ''}
          . Each takes its bundle and the storage it asks for, which maki keeps for it whether it
          uses it or not.
        </p>
      </Card>

      <section>
        <Label className="mb-3.5">installed</Label>
        {!linked ? (
          <Empty glyph="usb" title="maki isn’t linked">
            Plug maki in, and allow it on the Overview page, to see its apps.
          </Empty>
        ) : status === 'locked' ? (
          <Empty glyph="key" title="maki is locked">
            Enter its PIN on maki to see its apps.
          </Empty>
        ) : apps && apps.length === 0 ? (
          <Empty glyph="apps" title="No apps yet">
            Install one from the maki store below, or from a .maki file (make your own with the SDK:{' '}
            <code className="font-mono text-green">maki build</code>).
          </Empty>
        ) : (
          <div className="card divide-y divide-surface0 px-5 py-1">
            {(apps ?? []).map((a) => {
              const fromStore = index?.apps.find((s) => s.id === a.id) ?? null
              const revokedWhy = revoked(store?.revocations ?? null, a.id, a.version, a.developer)
              return (
                <div key={a.id} className="flex items-center gap-4 py-4">
                  <PixelIcon icon={a.icon} name={a.name} className="h-12 w-12" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-fg">{a.name}</span>
                      <span className="font-mono text-[0.7rem] text-overlay1">
                        {a.label || `version ${a.version}`}
                      </span>
                      {a.fromStore ? (
                        <Badge kind="built">maki store</Badge>
                      ) : (
                        <Badge kind="warn">sideloaded</Badge>
                      )}
                      {fromStore?.kind === 'native' && <Badge kind="info">native</Badge>}
                      {fromStore && fromStore.version > a.version && (
                        <Badge kind="next">
                          {fromStore.label || `version ${fromStore.version}`} out
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-[0.68rem] text-overlay1">
                      {a.id} · developer {keys[a.id] ?? '…'}
                    </div>
                    {revokedWhy && (
                      <p className="mt-1.5 text-xs text-red">
                        Revoked by the maki store: {revokedWhy} maki warns before opening it; remove
                        it unless you’re sure.
                      </p>
                    )}
                  </div>
                  <div className="w-56 shrink-0 text-right font-mono text-[0.68rem] leading-relaxed text-overlay1">
                    <div className="flex items-center justify-end gap-2 text-[0.8rem] font-bold text-subtext1">
                      <span className="h-2 w-2 rounded-sm" style={{ background: colours[a.id] }} />
                      {bytes(takes(a))}
                    </div>
                    <div>
                      {bytes(a.bundle)} app · {bytes(a.storage)} storage
                    </div>
                    <div className="text-overlay0">
                      {a.used > 0 ? `${bytes(a.used)} used · ` : ''}
                      {a.backup ? 'backed up' : 'not backed up'}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {fromStore && fromStore.version > a.version && (
                      <Button
                        kind="primary"
                        small
                        glyph="download"
                        disabled={!idle}
                        onClick={() => void chooseFromStore(fromStore)}
                      >
                        Update
                      </Button>
                    )}
                    {PAGES.some((p) => p.app === a.id) && (
                      <Button
                        small
                        kind="ghost"
                        glyph="external"
                        title={`${a.name}’s page in maki desktop`}
                        onClick={() => go(PAGES.find((p) => p.app === a.id)!.id)}
                      >
                        Open
                      </Button>
                    )}
                    <Button
                      kind="danger"
                      small
                      glyph="trash"
                      disabled={!idle}
                      onClick={() => void remove(a)}
                    >
                      {busy === `remove ${a.id}` ? 'On maki…' : 'Remove'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <StoreSection
        link={link}
        storeName={storeName}
        storePrivate={storePrivate}
        installed={apps}
        space={space}
        disabled={busy !== null}
        busy={busy}
        choose={(a) => void chooseFromStore(a)}
      />

      {chosen && (
        <AppSheet
          chosen={chosen}
          installed={apps}
          space={space}
          installing={busy === 'install'}
          linked={linked}
          problem={problem}
          install={() => void install()}
          close={() => {
            if (busy === 'install') return
            setChosen(null)
            setProblem(null)
          }}
        />
      )}
    </div>
  )
}

/** Room left for a bundle of `needs` bytes, allowing for the version of it that's installed. */
function roomFor(space: AppSpace | null, update: InstalledApp | undefined): number | null {
  return space ? space.space - space.taken + (update ? takes(update) : 0) : null
}

/** The maki store's apps, as its signed index lists them, with what's installed. */
function StoreSection({
  link,
  storeName,
  storePrivate,
  installed,
  space,
  disabled,
  busy,
  choose
}: {
  link: Link
  storeName: string | null
  storePrivate: boolean
  installed: InstalledApp[] | null
  space: AppSpace | null
  disabled: boolean
  busy: string | null
  choose: (app: StoreApp) => void
}): React.JSX.Element {
  const store = link.store
  const index = store?.index
  const [category, setCategory] = useState<string | null>(null)
  const categories = [
    ...new Set((index?.apps ?? []).flatMap((a) => (a.category ? [a.category] : [])))
  ].sort()
  const shown = (index?.apps ?? []).filter((a) => !category || a.category === category)
  const [checking, setChecking] = useState(false)

  return (
    <section>
      <div className="flex items-center justify-between gap-6">
        <Label>maki store</Label>
        <div className="flex min-w-0 items-center gap-3 font-mono text-[0.66rem] text-overlay1">
          {storeName && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Glyph name="store" className="h-3.5 w-3.5" />
              <span className="truncate">{storeName}</span>
            </span>
          )}
          {store && store.checkedAt > 0 && <span>checked {ago(store.checkedAt)}</span>}
          {store && (
            <Button
              small
              glyph="refresh"
              disabled={checking || busy !== null}
              onClick={async () => {
                setChecking(true)
                await link.storeCheck()
                setChecking(false)
              }}
            >
              {checking ? 'Checking…' : 'Check'}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 mb-4 text-sm text-subtext0">
        Reviewed, and rebuilt from their source by the store before it stamps them. maki checks each
        stamp itself.
      </p>

      {categories.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {[null, ...categories].map((c) => (
            <button
              key={c ?? 'all'}
              onClick={() => setCategory(c)}
              className={`rounded-full border px-3 py-1 font-mono text-[0.68rem] font-bold tracking-wide transition-colors ${
                category === c
                  ? 'border-peach bg-peach/15 text-peach'
                  : 'border-surface1 text-subtext0 hover:border-surface2 hover:text-fg'
              }`}
            >
              {c ?? 'All'}
            </button>
          ))}
        </div>
      )}

      {!store && (
        <p className="text-sm text-overlay1">The maki store isn’t set up in this build.</p>
      )}
      {store?.problem &&
        (storePrivate && !index ? (
          <Banner kind="warn">
            The maki store can’t be read: its repository ({storeName}) is private for now.
            <span className="mt-1 block text-subtext0">
              Start maki desktop with MAKI_STORE_TOKEN set to a GitHub token that can read it, such
              as <code className="font-mono text-green">gh auth token</code> gives. It goes to
              GitHub’s file server and nowhere else.
            </span>
          </Banner>
        ) : (
          <Banner kind="warn">The maki store: {store.problem}</Banner>
        ))}
      {store && !store.problem && !index && (
        <p className="text-sm text-overlay1">Checking the maki store…</p>
      )}
      {index && index.apps.length === 0 && (
        <p className="text-sm text-overlay1">No apps in the store yet.</p>
      )}

      {shown.length > 0 && (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {shown.map((a) => {
            const have = installed?.find((i) => i.id === a.id)
            const newer = have && have.version < a.version
            const room = roomFor(space, have)
            const fits = room === null || a.bytes + a.storageKib * 1024 <= room
            return (
              <button
                key={a.id}
                disabled={disabled}
                onClick={() => choose(a)}
                className="card group flex flex-col p-4 text-left transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-peach/50 disabled:hover:translate-y-0"
              >
                <div className="flex items-start gap-3.5">
                  <PixelIcon icon={a.icon} name={a.name} className="h-[3.25rem] w-[3.25rem]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate font-semibold text-fg">{a.name}</span>
                      {have && !newer ? (
                        <span className="flex items-center gap-1 font-mono text-[0.62rem] font-bold uppercase tracking-wider text-green">
                          <Glyph name="check" className="h-3 w-3" />
                          on maki
                        </span>
                      ) : newer ? (
                        <Badge kind="next">update</Badge>
                      ) : !fits ? (
                        <Badge kind="danger">no room</Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 font-mono text-[0.64rem] uppercase tracking-[0.1em] text-overlay1">
                      {[a.category, a.kind === 'native' ? 'native' : null]
                        .filter(Boolean)
                        .join(' · ') || a.label}
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 flex-1 text-[0.85rem] leading-snug text-subtext0">
                  {a.description}
                </p>
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-surface0 pt-2.5 font-mono text-[0.64rem] text-overlay1">
                  <span>{bytes(a.bytes + a.storageKib * 1024)}</span>
                  <span className="truncate">
                    {a.permissions.length === 0
                      ? 'nothing beyond the basics'
                      : a.permissions.map((p) => p.permission.name).join(' · ')}
                  </span>
                  <span className="text-peach opacity-0 transition-opacity group-hover:opacity-100">
                    {busy === `store ${a.id}`
                      ? '…'
                      : have && !newer
                        ? 'details'
                        : newer
                          ? 'update'
                          : 'get'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {store?.revocations && store.revocations.expires * 1000 < Date.now() && (
        <p className="mt-3 text-xs text-yellow">
          The store’s revocation list went out of date on{' '}
          {new Date(store.revocations.expires * 1000).toLocaleDateString()}: apps it has revoked
          since may not be on it.
        </p>
      )}
      {index && index.skipped > 0 && (
        <p className="mt-3 text-xs text-overlay1">
          {index.skipped} more {index.skipped === 1 ? 'app needs' : 'apps need'} a newer maki
          desktop.
        </p>
      )}
    </section>
  )
}

/** What a bundle is and asks for, before maki shows the same and asks its owner. */
function AppSheet({
  chosen,
  installed,
  space,
  installing,
  linked,
  problem,
  install,
  close
}: {
  chosen: Chosen
  installed: InstalledApp[] | null
  space: AppSpace | null
  installing: boolean
  linked: boolean
  problem: string | null
  install: () => void
  close: () => void
}): React.JSX.Element {
  const m = chosen.bundle.manifest
  const s = chosen.store
  const update = installed?.find((a) => a.id === m.id)
  const needs = chosen.bundle.bytes.length + m.storageKib * 1024
  const room = roomFor(space, update)
  const fits = room === null || needs <= room
  const full = !!space && !update && space.apps >= space.maxApps
  const same = update && update.version >= m.version

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const row = (title: string, body: React.ReactNode): React.JSX.Element => (
    <div className="grid grid-cols-[7.5rem_1fr] gap-4 border-t border-surface0 py-3">
      <div className="pt-0.5 font-mono text-[0.64rem] font-bold uppercase tracking-[0.12em] text-overlay1">
        {title}
      </div>
      <div className="min-w-0 text-sm text-subtext1">{body}</div>
    </div>
  )

  // on the body: a page's entrance animation would otherwise hold it inside the page
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-crust/75 p-8 backdrop-blur-sm"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label={`${m.name}: install`}
        className="card rise max-h-full w-full max-w-xl overflow-y-auto bg-mantle p-7 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-5">
          <PixelIcon icon={chosen.bundle.icon} name={m.name} className="h-20 w-20" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-2xl font-bold tracking-[-0.03em] text-fg">{m.name}</div>
            <div className="mt-1 font-mono text-[0.72rem] text-overlay1">
              {m.label || `version ${m.version}`}
              {update && ` · replaces ${update.label || `version ${update.version}`}`} · {m.id}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {s ? <Badge kind="built">maki store</Badge> : <Badge kind="warn">sideloaded</Badge>}
              {m.kind === 'native' && <Badge kind="info">native</Badge>}
              {s?.category && <Badge>{s.category}</Badge>}
            </div>
          </div>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-overlay1 hover:bg-surface0 hover:text-fg"
            aria-label="Close"
          >
            <Glyph name="close" className="h-4 w-4" />
          </button>
        </div>

        {m.description && (
          <p className="mt-5 text-[0.95rem] leading-relaxed text-subtext1">{m.description}</p>
        )}

        <div className="mt-5">
          {row(
            'Where from',
            s ? (
              <span className="text-green">
                Reviewed, and built from its source by the maki store.
              </span>
            ) : (
              <span className="text-yellow">
                Sideloaded: nobody has reviewed it. Install apps only from people you trust.
              </span>
            )
          )}
          {s?.source &&
            row(
              'Source',
              <button
                className="group min-w-0 text-left font-mono text-[0.78rem] text-peach hover:text-yellow"
                onClick={() => void window.maki.openExternal(sourcePage(s.source!))}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate">
                    {s.source.repo.replace(/^https:\/\/(github\.com\/)?/, '')} @{' '}
                    {s.source.commit.slice(0, 10)}
                  </span>
                  <Glyph name="external" className="h-3.5 w-3.5" />
                </span>
                {s.source.path && (
                  <span className="block truncate text-overlay1 group-hover:text-subtext0">
                    {s.source.path}
                  </span>
                )}
              </button>
            )}
          {update?.fromStore &&
            !s &&
            row(
              'Replacing',
              <span className="text-yellow">the maki store’s version of {update.name}.</span>
            )}
          {row(
            'Developer',
            <>
              <code className="font-mono text-[0.78rem] text-fg">{chosen.developer}</code>
              <div className="mt-0.5 text-xs text-overlay1">
                maki shows this key too: they should match.
              </div>
            </>
          )}
          {m.kind === 'native' &&
            row(
              'Native',
              <>
                Machine code for maki’s processor, which maki runs in a process of its own, confined
                by its kernel to its own memory and to what it asks for here.
                <span className="text-overlay1">
                  {' '}
                  Built for {m.firmware || 'no firmware in particular'}.
                </span>
              </>
            )}
          {row(
            'It asks to',
            m.permissions.length === 0 ? (
              <span className="text-subtext0">
                Nothing beyond the basics: its own screen, the buttons and its storage.
              </span>
            ) : (
              <ul className="space-y-2">
                {m.permissions.map(({ permission, reason }) => (
                  <li key={permission.id}>
                    <span className="font-medium text-fg">{permission.title}.</span>{' '}
                    <span className="text-subtext0">{permission.warning}</span>
                    {reason && (
                      <span className="mt-0.5 block text-xs text-overlay1">
                        The developer says: “{reason}”
                      </span>
                    )}
                    {permission.name === 'wallet' && m.wallet && (
                      <span className="mt-1 block text-xs text-subtext0">
                        <span className="font-medium text-fg">
                          {walletCoins(m.wallet.paths).join(', ')}
                        </span>
                        , from your recovery phrase:{' '}
                        <span className="font-mono text-subtext1">
                          {m.wallet.paths.map(formatPath).join('  ')}
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}
          {row(
            'It needs',
            <>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['app', bytes(chosen.bundle.bytes.length)],
                  ['storage', bytes(m.storageKib * 1024)],
                  ['memory', bytes(m.memoryKib * 1024)]
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-surface0 bg-crust/60 px-3 py-2">
                    <div className="font-mono text-[0.95rem] font-bold text-fg">{v}</div>
                    <div className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-overlay1">
                      {k}
                    </div>
                  </div>
                ))}
              </div>
              <div className={`mt-2 text-xs ${fits && !full ? 'text-overlay1' : 'text-red'}`}>
                {full
                  ? `maki has room for ${space!.maxApps} apps: remove one first.`
                  : room === null
                    ? `It takes ${bytes(needs)} of maki’s room for apps.`
                    : fits
                      ? `It takes ${bytes(needs)} of maki’s room for apps; ${bytes(room - needs)} will be left.`
                      : `It needs ${bytes(needs)}, and ${bytes(room)} is free: remove an app first.`}
              </div>
            </>
          )}
        </div>

        {problem && (
          <p className="mt-4 rounded-lg border border-red/40 bg-red/[0.07] px-3 py-2 text-sm text-red">
            {problem}
          </p>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <div className="text-xs text-overlay1">
            {installing ? (
              <span className="flex items-center gap-2 text-peach">
                <span className="breathe h-2 w-2 rounded-full bg-peach" />
                Go through it on maki: it shows you the same, and asks.
              </span>
            ) : !linked ? (
              'Plug maki in to install it.'
            ) : same ? (
              'This version is on maki already.'
            ) : (
              'maki shows you all of this on its own screen, and installs it only if you say so there.'
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={close} disabled={installing}>
              Cancel
            </Button>
            <Button
              kind="primary"
              glyph="download"
              disabled={!linked || installing || !fits || full || !!same}
              onClick={install}
            >
              {update ? 'Update on maki' : 'Install on maki'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
