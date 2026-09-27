import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'

const button = 'rounded-lg border border-zinc-700 px-3 py-1 text-sm hover:border-zinc-500'

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
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Ethereum</h2>
      <p className="mb-3 text-sm text-zinc-400">
        Sites use maki’s Ethereum account through the maki extension. maki asks you before a site
        sees the account, and shows every message and transaction before it signs.
      </p>
      {sites.length === 0 ? (
        <p className="text-sm text-zinc-500">No site is connected.</p>
      ) : (
        <>
          <code className="mb-2 block break-all font-mono text-xs text-zinc-400">
            {sites[0].address}
          </code>
          <ul className="space-y-2 text-sm">
            {sites.map((s) => (
              <li key={s.site} className="flex items-center justify-between gap-3">
                <span className="truncate text-zinc-300">
                  {s.site} <span className="text-zinc-500">· {s.network}</span>
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
      <p className="mt-3 text-xs text-zinc-500">
        Balances and broadcasts go through public servers (
        {link.ethereum.networks.map((n) => n.name).join(', ')}), which see the account’s address and
        this computer’s IP address.
      </p>
    </section>
  )
}
