import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import { CURRENCIES, type Currency } from '@shared/prices'
import {
  BITCOIN_APP,
  BITCOINCASH_APP,
  DOGECOIN_APP,
  ETHEREUM_APP,
  LITECOIN_APP,
  MONERO_APP,
  SOLANA_APP
} from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import { Bitcoin } from './Bitcoin'
import { Ethereum } from './Ethereum'
import { STELLAR } from '@shared/coins/stellar'
import { TRON } from '@shared/coins/tron'
import { XRP } from '@shared/coins/xrp'
import { AccountCard } from './AccountWallet'
import { BitcoinCash, Dogecoin, Litecoin } from './BtcCoin'
import { Monero } from './Monero'
import { Solana } from './Solana'
import { PricesContext, useFreshPrices } from './prices-state'
import { Button, Card, Glyph, Label, PageHeader } from './ui'
import { useAddFromStore } from './WalletAppNeeded'

function savedCurrency(): Currency | null {
  try {
    const c = localStorage.getItem('maki.currency')
    return CURRENCIES.includes(c as Currency) ? (c as Currency) : null
  } catch {
    return null
  }
}

/** A wallet maki desktop has a page for: its app on maki, and the card it's shown in. */
interface WalletKind {
  app: string
  name: string
  glyph: string
  /** what it is, in a line */
  line: string
  Card: (props: { link: Link; apps: Apps }) => React.JSX.Element
}

/** maki desktop's wallets, in the order the page shows them. */
const WALLETS: WalletKind[] = [
  {
    app: BITCOIN_APP,
    name: 'Bitcoin',
    glyph: 'bitcoin',
    line: 'Native SegWit and taproot, multisig, and wallet software such as Sparrow.',
    Card: Bitcoin
  },
  {
    app: LITECOIN_APP,
    name: 'Litecoin',
    glyph: 'litecoin',
    line: 'The accounts Litecoin Core, Electrum-LTC and Ledger make from the phrase.',
    Card: Litecoin
  },
  {
    app: DOGECOIN_APP,
    name: 'Dogecoin',
    glyph: 'dogecoin',
    line: 'The account Trezor, Ledger and the other BIP44 wallets make from the phrase.',
    Card: Dogecoin
  },
  {
    app: BITCOINCASH_APP,
    name: 'Bitcoin Cash',
    glyph: 'bitcoincash',
    line: 'The account Electron Cash and Ledger make, through its Electrum servers.',
    Card: BitcoinCash
  },
  {
    app: ETHEREUM_APP,
    name: 'Ethereum',
    glyph: 'ethereum',
    line: 'Its networks and tokens, and sites through the maki extension.',
    Card: Ethereum
  },
  {
    app: MONERO_APP,
    name: 'Monero',
    glyph: 'monero',
    line: 'The wallet a Ledger makes, here and as the Monero GUI’s cold wallet.',
    Card: Monero
  },
  {
    app: SOLANA_APP,
    name: 'Solana',
    glyph: 'solana',
    line: 'SOL and tokens, as Phantom and Solflare have the account.',
    Card: Solana
  },
  {
    app: XRP.app,
    name: 'XRP',
    glyph: 'xrp',
    line: 'XRP, RLUSD and USDC, the account Xaman, Ledger and Trust Wallet make.',
    Card: (p) => <AccountCard {...p} chain={XRP} />
  },
  {
    app: STELLAR.app,
    name: 'Stellar',
    glyph: 'stellar',
    line: 'XLM, USDC and EURC, the account Freighter and Ledger make.',
    Card: (p) => <AccountCard {...p} chain={STELLAR} />
  },
  {
    app: TRON.app,
    name: 'Tron',
    glyph: 'tron',
    line: 'TRX and USDT, the account TronLink and Ledger make.',
    Card: (p) => <AccountCard {...p} chain={TRON} />
  }
]

/** The wallets shown as cards when maki has never been seen: the ones it began with. */
const FIRST = [BITCOIN_APP, ETHEREUM_APP, MONERO_APP, SOLANA_APP]

/** Which wallet apps maki had when maki desktop last knew: their cards show while it's away. */
function rememberedWallets(): string[] | null {
  try {
    const kept = JSON.parse(localStorage.getItem('maki.wallets') ?? 'null') as unknown
    return Array.isArray(kept) ? kept.filter((a): a is string => typeof a === 'string') : null
  } catch {
    return null
  }
}

/**
 * maki's wallets, here and for wallet software and sites. Each is an app from the maki store, which
 * a maki has only if its owner adds it: a card for each maki has, and the others to add.
 */
export function Wallets({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element {
  const [currency, setCurrency] = useState<Currency | null>(savedCurrency)
  const prices = useFreshPrices(currency)
  const choose = (c: Currency | null): void => {
    setCurrency(c)
    try {
      if (c) localStorage.setItem('maki.currency', c)
      else localStorage.removeItem('maki.currency')
    } catch {
      // remembered for this session only
    }
  }

  // the wallet apps on maki, once it says; what it last said while it doesn't
  const installed = useMemo(
    () =>
      apps.status === 'approved' && apps.apps
        ? WALLETS.filter((w) => apps.apps!.some((a) => a.id === w.app)).map((w) => w.app)
        : null,
    [apps.status, apps.apps]
  )
  const [remembered, setRemembered] = useState(rememberedWallets)
  useEffect(() => {
    if (!installed) return
    setRemembered(installed)
    try {
      localStorage.setItem('maki.wallets', JSON.stringify(installed))
    } catch {
      // remembered for this session only
    }
  }, [installed])
  const inUse = installed ?? remembered ?? FIRST
  const cards = WALLETS.filter((w) => inUse.includes(w.app))
  const others = WALLETS.filter((w) => !inUse.includes(w.app))

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="wallets"
        title="Wallets"
        lede="Keys on maki, from its recovery phrase, behind its PIN, for the wallet apps you add from the maki store. Here you see what they hold and make payments; wallet software and sites can too. The app shows you each one on maki, the payments, change and fees spelled out, and maki signs only when you say so."
        actions={
          <label
            className="flex items-center gap-2 font-mono text-[0.68rem] text-overlay1"
            title="Prices come from CoinGecko, which sees this computer's IP address and the list of coins asked about (the same for everyone), never your addresses or balances."
          >
            values in
            <select
              value={currency ?? ''}
              onChange={(e) => choose((e.target.value || null) as Currency | null)}
              className="rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
            >
              <option value="">nothing</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <PricesContext.Provider value={{ currency, prices }}>
        {cards.map(({ app, Card: WalletCard }) => (
          <WalletCard key={app} link={link} apps={apps} />
        ))}
      </PricesContext.Provider>
      {others.length > 0 && (
        <Card className="p-6">
          <Label>More wallets</Label>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-subtext0">
            Each is an app from the maki store, with the accounts other wallets make from the same
            recovery phrase. Add one and maki goes through it with you first.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {others.map((w) => (
              <AddWallet key={w.app} link={link} apps={apps} wallet={w} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/** A wallet maki hasn't, to add from the maki store. */
function AddWallet({
  link,
  apps,
  wallet
}: {
  link: Link
  apps: Apps
  wallet: WalletKind
}): React.JSX.Element {
  const { fromStore, busy, problem, add } = useAddFromStore(link, apps, wallet.app)
  const ready = link.state.linked && apps.status === 'approved'
  return (
    <li className="flex gap-3 rounded-xl border border-surface0 bg-crust/30 p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface0/60 text-subtext1">
        <Glyph name={wallet.glyph} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm font-bold text-fg">{wallet.name}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-overlay1">{wallet.line}</p>
        <div className="mt-2.5">
          {fromStore ? (
            <Button
              small
              kind="ghost"
              glyph="store"
              disabled={!ready || busy}
              onClick={() => void add()}
            >
              {busy ? 'Go through it on maki…' : ready ? `Add ${wallet.name}` : 'Plug maki in'}
            </Button>
          ) : (
            <span className="text-xs text-overlay0">Not in the maki store yet.</span>
          )}
        </div>
        {problem && <p className="mt-1.5 text-xs text-yellow">{problem}</p>}
      </div>
    </li>
  )
}
