/**
 * maki's TON wallet: the account maki's TON app shares, in the two wallet contracts its key has on
 * TON. Its v4R2 wallet (the one Ledger Live shows) first; its W5 wallet (today's wallets' first
 * choice: Tonkeeper's, MyTonWallet's) below it once it holds anything or has been used, or once the
 * owner asks to see it. Each is a wallet of its own, at an address of its own.
 */
import { useEffect, useMemo, useState } from 'react'
import type { SharedAccount } from '@shared/coin-servers'
import { TON, TON_W5, w5Account, walletUsed } from '@shared/coins/ton'
import type { Link } from '@shared/link'
import { AccountCard, AccountWallet } from './AccountWallet'
import type { Apps } from './apps-state'
import { Button } from './ui'

/** Whether the owner asked to see an account's W5 wallet: by its v4R2 wallet's address. */
const shownKey = (account: SharedAccount): string => `maki.tonW5.${account.address}`

export function TonCard({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element {
  return (
    <AccountCard
      link={link}
      apps={apps}
      chain={TON}
      title="v4R2 wallet"
      more={(account) => <W5 key={account.address} link={link} account={account} />}
    />
  )
}

/** The key's W5 wallet: shown when it's been used or holds anything, or when the owner asks. */
function W5({ link, account }: { link: Link; account: SharedAccount }): React.JSX.Element | null {
  const w5 = useMemo(() => w5Account(account), [account])
  const [asked, setAsked] = useState(() => {
    try {
      return localStorage.getItem(shownKey(account)) === '1'
    } catch {
      return false
    }
  })
  const [used, setUsed] = useState<boolean | null>(null)
  useEffect(() => {
    if (asked) return
    let gone = false
    walletUsed(
      (network, method, path, body) => window.maki.coins.fetch('ton', network, method, path, body),
      w5
    ).then(
      (u) => !gone && setUsed(u),
      () => !gone && setUsed(false)
    )
    return () => {
      gone = true
    }
  }, [asked, w5])

  if (asked || used)
    return (
      <section className="mt-8 border-t border-surface0 pt-2">
        <h2 className="sr-only">TON W5 wallet</h2>
        <AccountWallet link={link} chain={TON_W5} account={w5} title="W5 wallet" />
      </section>
    )
  if (used === null) return null
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-surface1 px-5 py-4">
      <p className="max-w-xl text-sm leading-relaxed text-subtext0">
        The same key has a W5 wallet too, at an address of its own: the one Tonkeeper and
        MyTonWallet make first. It hasn’t been used.
      </p>
      <Button
        small
        onClick={() => {
          setAsked(true)
          try {
            localStorage.setItem(shownKey(account), '1')
          } catch {
            // remembered for this session only
          }
        }}
      >
        Show the W5 wallet
      </Button>
    </div>
  )
}
