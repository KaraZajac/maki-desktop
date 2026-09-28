import { useCallback, useEffect, useState } from 'react'
import { fingerprint } from '@shared/bundle'
import type { AppSpace, InstalledApp } from '@shared/client'
import type { Link } from '@shared/link'
import type { ApprovalValue } from '@shared/protocol'

/** The apps on maki, and its room for them, as the pages show them. */
export interface Apps {
  /** 'approved', or why maki didn't say ('locked' until its PIN is in) */
  status: ApprovalValue | null
  apps: InstalledApp[] | null
  /** null from firmware that doesn't say (before APP_SPACE) */
  space: AppSpace | null
  /** each app's developer key as a fingerprint, to compare with what maki shows */
  keys: Record<string, string>
  problem: string | null
  refresh: () => Promise<void>
}

/** How often to look again while maki is locked: its apps show once its PIN is in. */
const LOCKED_RECHECK_MS = 5000

export function useApps(link: Link): Apps {
  const linked = link.state.linked
  const [status, setStatus] = useState<ApprovalValue | null>(null)
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [space, setSpace] = useState<AppSpace | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await link.appList()
      const s =
        r.status === 'approved'
          ? await link.appSpace().then(
              (a) => a.space,
              () => null
            )
          : null
      const prints = await Promise.all(
        r.apps.map(async (a) => [a.id, await fingerprint(a.developer)] as const)
      )
      setStatus(r.status)
      setApps(r.apps)
      setSpace(s)
      setKeys(Object.fromEntries(prints))
      setProblem(null)
    } catch (e) {
      setProblem((e as Error).message)
    }
  }, [link])

  useEffect(() => {
    if (linked) void refresh()
    else {
      setStatus(null)
      setApps(null)
      setSpace(null)
    }
  }, [linked, refresh])

  useEffect(() => {
    if (!linked || status !== 'locked') return
    const id = setInterval(() => void refresh(), LOCKED_RECHECK_MS)
    return () => clearInterval(id)
  }, [linked, status, refresh])

  // `maki install` goes round the window: show what it installed
  useEffect(() => {
    link.appsChanged = () => void refresh()
    return () => {
      link.appsChanged = null
    }
  }, [link, refresh])

  return { status, apps, space, keys, problem, refresh }
}
