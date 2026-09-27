import { useCallback, useEffect, useRef, useState } from 'react'
import { SSH_APP } from '@shared/bridge-types'
import { fingerprint, iconPixels, readBundle, type Bundle } from '@shared/bundle'
import type { InstalledApp } from '@shared/client'
import type { Link } from '@shared/link'
import type { ApprovalValue } from '@shared/protocol'

const button =
  'rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40'

/** An app's icon as maki draws it, or its initial. */
function Icon({ icon, name }: { icon: Uint32Array | null; name: string }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !icon) return
    const image = ctx.createImageData(64, 64)
    iconPixels(icon).forEach((light, i) => {
      const v = light ? 235 : 20
      image.data.set([v, v, v, 255], i * 4)
    })
    ctx.putImageData(image, 0, 0)
  }, [icon])
  if (!icon) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-lg font-semibold">
        {name.slice(0, 1).toUpperCase()}
      </div>
    )
  }
  return (
    <canvas
      ref={canvas}
      width={64}
      height={64}
      className="h-12 w-12 shrink-0 rounded-lg"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}

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
      return "maki couldn't: its firmware may not have the app host yet."
    default:
      return `maki couldn't: ${approval}.`
  }
}

/**
 * Apps on maki from this side: what's installed, installing a .maki file, removing one. maki
 * checks every bundle itself and asks its owner before installing or removing anything; this
 * shows what a bundle is and asks for, so the owner can compare with maki's screen.
 */
export function Apps({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [status, setStatus] = useState<ApprovalValue | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [chosen, setChosen] = useState<{ bundle: Bundle; path: string; developer: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | null>(null)
  useEffect(() => {
    void window.maki.ssh.socket().then(setAgent)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await link.appList()
      setStatus(r.status)
      setApps(r.apps)
      const prints = await Promise.all(r.apps.map(async (a) => [a.id, await fingerprint(a.developer)] as const))
      setKeys(Object.fromEntries(prints))
    } catch (e) {
      setProblem((e as Error).message)
    }
  }, [link])

  useEffect(() => {
    if (linked) void refresh()
    else setApps(null)
  }, [linked, refresh])

  // `maki install` goes round this window: show what it installed
  useEffect(() => {
    link.appsChanged = () => void refresh()
    return () => {
      link.appsChanged = null
    }
  }, [link, refresh])

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
      setChosen({ bundle, path: file.path, developer: await fingerprint(bundle.developer) })
    })

  const install = (): Promise<void> =>
    run('install', async () => {
      if (!chosen) return
      const r = await link.appInstall(chosen.bundle.manifest.name, chosen.bundle.bytes)
      if (r.approval === 'approved') {
        setChosen(null)
        await refresh()
      } else {
        setProblem(why(r.approval, r.reason))
      }
    })

  const remove = (app: InstalledApp): Promise<void> =>
    run(`remove ${app.id}`, async () => {
      const r = await link.appRemove(app.id, app.name)
      if (r === 'approved') await refresh()
      else setProblem(why(r, ''))
    })

  const idle = linked && busy === null
  const ssh = apps?.find((a) => a.id === SSH_APP)
  const m = chosen?.bundle.manifest
  const update = m ? apps?.find((a) => a.id === m.id) : undefined

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Apps</h2>
        <button className={button} disabled={!idle} onClick={() => void choose()}>
          Install from file…
        </button>
      </div>

      {!linked && <p className="mt-3 text-sm text-zinc-500">Plug maki in to see its apps.</p>}
      {linked && status === 'locked' && <p className="mt-3 text-sm text-zinc-400">maki is locked: enter its PIN to see its apps.</p>}
      {linked && status === 'approved' && apps?.length === 0 && !chosen && (
        <p className="mt-3 text-sm text-zinc-400">
          No apps yet. Apps come as .maki files; make your own with the SDK (<code>maki build</code>).
        </p>
      )}

      {apps && apps.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-800">
          {apps.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-2">
              <Icon icon={a.icon} name={a.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-xs text-zinc-500">{a.label || `version ${a.version}`}</span>
                  {!a.fromStore && (
                    <span className="rounded border border-amber-700/60 px-1.5 text-[10px] uppercase tracking-wide text-amber-400">
                      sideloaded
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-zinc-500">{a.id}</div>
                <div className="text-xs text-zinc-500">
                  developer <span className="font-mono">{keys[a.id] ?? '…'}</span>
                </div>
                <div className="text-xs text-zinc-500">
                  {(a.used / 1024).toFixed(1)} KiB stored · {a.backup ? 'backed up' : 'not backed up'}
                </div>
              </div>
              <button className={button} disabled={!idle} onClick={() => void remove(a)}>
                {busy === `remove ${a.id}` ? 'Approve on maki…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {ssh && agent && (
        <div className="mt-3 rounded-lg border border-zinc-800 p-3 text-sm">
          <p className="text-zinc-300">
            SSH and git: maki desktop is an SSH agent for {ssh.name}, which asks you on maki before every sign-in and
            signature. Point ssh at it:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300">
              export SSH_AUTH_SOCK={agent}
            </code>
            <button className={button} onClick={() => void window.maki.copy(`export SSH_AUTH_SOCK=${agent}`)}>
              Copy
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Then <code>ssh-add -L</code> shows its public key, for a server's authorized_keys, or for git to sign with
            (<code>git config gpg.format ssh</code>).
          </p>
        </div>
      )}

      {chosen && m && (
        <div className="mt-3 rounded-lg border border-zinc-700 p-3">
          <div className="flex items-start gap-3">
            <Icon icon={chosen.bundle.icon} name={m.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-zinc-500">
                  {m.label || `version ${m.version}`}
                  {update && ` (replaces ${update.label || `version ${update.version}`})`}
                </span>
              </div>
              <div className="truncate font-mono text-xs text-zinc-500">{m.id}</div>
              {m.description && <p className="mt-1 text-sm text-zinc-300">{m.description}</p>}
            </div>
          </div>
          <p className="mt-3 text-sm text-amber-400">Sideloaded: nobody has reviewed it. Install apps only from people you trust.</p>
          <p className="mt-1 text-sm text-zinc-400">
            Developer key <span className="font-mono text-zinc-200">{chosen.developer}</span>: maki shows it too; they should
            match.
          </p>
          <div className="mt-2 text-sm">
            {m.kind === 'native' ? (
              <p className="text-zinc-400">A native app: maki doesn't take these yet.</p>
            ) : m.permissions.length === 0 ? (
              <p className="text-zinc-400">
                It asks for nothing beyond the basics: its own screen, buttons and {m.storageKib} KiB of storage.
              </p>
            ) : (
              <ul className="space-y-1">
                {m.permissions.map(({ permission, reason }) => (
                  <li key={permission.id}>
                    <span className="font-medium">{permission.title}.</span>{' '}
                    <span className="text-zinc-400">{permission.warning}</span>
                    {reason && <span className="text-zinc-500"> The developer says: “{reason}”</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <button className={button} disabled={!idle} onClick={() => void install()}>
              {busy === 'install' ? 'Go through it on maki…' : update ? 'Update on maki' : 'Install on maki'}
            </button>
            <button className={button} disabled={busy === 'install'} onClick={() => setChosen(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {problem && <p className="mt-3 text-sm text-red-400">{problem}</p>}
    </section>
  )
}
