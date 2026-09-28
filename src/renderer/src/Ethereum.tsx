import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'

const button =
  'inline-flex items-center gap-2 rounded-lg border border-surface1 bg-surface0/40 px-3 py-1.5 font-mono text-[0.72rem] font-bold tracking-wide text-subtext1 transition-colors hover:border-surface2 hover:text-fg'

/**
 * maki's Ethereum account as sites use it, through the maki extension: which sites are
 * connected, on which network. Connecting and signing are asked on maki; this only lists and
 * forgets.
 */
export function Ethereum({ link }: { link: Link }): React.JSX.Element {
  const [sites, setSites] = useState<{ site: string; address: string; network: string }[]>([])
  // a connection is a line in the log: refresh when there's news
  useEffect(() => {
    void link.ethereum.sites().then(setSites)
  }, [link, link.log.length])

  return (
    <section className="card p-6">
      <h2 className="mb-3 flex items-center gap-2.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.18em] text-peach">
        <span className="h-0.5 w-5 rounded bg-peach" />
        Ethereum
      </h2>
      <p className="mb-3 text-sm text-subtext0">
        Sites use maki’s Ethereum account through the maki extension. maki asks you before a site
        sees the account, and shows every message and transaction before it signs.
      </p>
      {sites.length === 0 ? (
        <p className="text-sm text-overlay1">No site is connected.</p>
      ) : (
        <>
          <code className="mb-2 block break-all font-mono text-xs text-subtext0">
            {sites[0].address}
          </code>
          <ul className="space-y-2 text-sm">
            {sites.map((s) => (
              <li key={s.site} className="flex items-center justify-between gap-3">
                <span className="truncate text-subtext1">
                  {s.site} <span className="text-overlay1">· {s.network}</span>
                </span>
                <button
                  className={button}
                  onClick={async () => {
                    await link.ethereum.disconnect(s.site)
                    link.note(`${s.site} disconnected from your Ethereum account`)
                  }}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-xs text-overlay1">
        Balances and broadcasts go through public servers (
        {link.ethereum.networks.map((n) => n.name).join(', ')}), which see the account’s address and
        this computer’s IP address.
      </p>
    </section>
  )
}
