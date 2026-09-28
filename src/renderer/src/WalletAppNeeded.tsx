import { useState } from 'react'
import type { Link } from '@shared/link'
import type { Apps } from './apps-state'
import { Button } from './ui'

/**
 * A wallet's app, when maki is linked without it. The wallets are apps from the maki store (maki
 * keeps the keys; the app reads what you sign and shows it on maki's screen), so a maki has them
 * only if its owner adds them. Offers the store's, which maki goes through with its owner like any
 * other app. Nothing while maki is locked or away: its apps aren't known then.
 */
export function WalletAppNeeded({
  link,
  apps,
  id,
  name
}: {
  link: Link
  apps: Apps
  id: string
  name: string
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!link.state.linked || apps.status !== 'approved' || !apps.apps) return null
  if (apps.apps.some((a) => a.id === id)) return null
  const fromStore = link.store?.index?.apps.find((a) => a.id === id) ?? null

  const add = async (): Promise<void> => {
    if (!fromStore) return
    setBusy(true)
    setProblem(null)
    try {
      const r = await link.storeInstall(fromStore)
      if (r.approval === 'approved') await apps.refresh()
      else
        setProblem(
          r.approval === 'refused'
            ? `maki won’t install it: ${r.reason}`
            : r.approval === 'denied'
              ? 'You turned it down on maki.'
              : `maki: ${r.approval}`
        )
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-peach/30 bg-peach/[0.05] p-4">
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-subtext0">
        <span className="font-semibold text-fg">maki’s {name} app isn’t installed.</span> maki keeps
        the keys; the app, from the maki store, reads what you sign and shows it to you on maki’s
        screen.{' '}
        {fromStore ? 'Add it here, then say yes on maki.' : 'Add it from the maki store, in Apps.'}
        {problem && <span className="mt-1.5 block text-yellow">{problem}</span>}
      </p>
      {fromStore && (
        <Button kind="ghost" glyph="store" disabled={busy} onClick={() => void add()}>
          {busy ? 'Go through it on maki…' : `Add ${name}`}
        </Button>
      )}
    </div>
  )
}
