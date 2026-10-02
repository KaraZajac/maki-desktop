/**
 * maki's Cosmos wallet: the chains maki's Cosmos app serves (the Cosmos Hub and the chains that
 * share its keys), one at a time, the one chosen here remembered; each is an account card of its
 * own, its account shared by maki on that chain.
 */
import { COSMOS } from '@shared/coins/cosmos'
import type { Link } from '@shared/link'
import { useState } from 'react'
import { AccountCard } from './AccountWallet'
import type { Apps } from './apps-state'

const KEY = 'maki.cosmosChain'

export function CosmosCard({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element {
  const [id, setId] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? 'cosmos'
    } catch {
      return 'cosmos'
    }
  })
  const chain = COSMOS.find((c) => c.id === id) ?? COSMOS[0]
  const choose = (
    <select
      aria-label="Chain"
      value={chain.id}
      onChange={(e) => {
        setId(e.target.value)
        try {
          localStorage.setItem(KEY, e.target.value)
        } catch {
          // remembered for this session only
        }
      }}
      className="rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
    >
      {COSMOS.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
  return <AccountCard key={chain.id} link={link} apps={apps} chain={chain} choose={choose} />
}
