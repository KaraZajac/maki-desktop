import { useState } from 'react'
import type { Link } from '@shared/link'
import { CURRENCIES, type Currency } from '@shared/prices'
import { Bitcoin } from './Bitcoin'
import { Ethereum } from './Ethereum'
import { PricesContext, useFreshPrices } from './prices-state'
import { PageHeader } from './ui'

function savedCurrency(): Currency | null {
  try {
    const c = localStorage.getItem('maki.currency')
    return CURRENCIES.includes(c as Currency) ? (c as Currency) : null
  } catch {
    return null
  }
}

/** maki's wallets: Bitcoin and Ethereum, here and for wallet software and sites. */
export function Wallets({ link }: { link: Link }): React.JSX.Element {
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

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="wallets"
        title="Wallets"
        lede="Keys on maki, from its recovery phrase, behind its PIN. Here you see what they hold and make payments; wallet software and sites can too. maki shows you each one, the payments, change and fees spelled out, and signs only when you say so."
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
        <Bitcoin link={link} />
        <Ethereum link={link} />
      </PricesContext.Provider>
    </div>
  )
}
