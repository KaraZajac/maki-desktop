import { createContext, useContext, useEffect, useState } from 'react'
import type { Currency, Prices } from '@shared/prices'

/** The currency the owner sees values in, or none; and the prices in it, once they've come. */
export const PricesContext = createContext<{ currency: Currency | null; prices: Prices | null }>({
  currency: null,
  prices: null
})

export const usePrices = (): { currency: Currency | null; prices: Prices | null } =>
  useContext(PricesContext)

/** Asked again this often, while the Wallets page is open. */
const EVERY_MS = 5 * 60_000
/** The last prices, so coming back to the page shows them straight away. */
let kept: { currency: Currency; prices: Prices; at: number } | null = null

/** Prices in `currency` (none if it's null), kept fresh while in use. */
export function useFreshPrices(currency: Currency | null): Prices | null {
  const [prices, setPrices] = useState<Prices | null>(
    currency && kept?.currency === currency ? kept.prices : null
  )
  useEffect(() => {
    if (!currency) {
      setPrices(null)
      return
    }
    let gone = false
    const ask = (): void => {
      window.maki.prices(currency).then(
        (p) => {
          kept = { currency, prices: p, at: Date.now() }
          if (!gone) setPrices(p)
        },
        () => {
          // no prices this time: the values wait for the next
        }
      )
    }
    if (!kept || kept.currency !== currency || Date.now() - kept.at > EVERY_MS) ask()
    else setPrices(kept.prices)
    const id = setInterval(ask, EVERY_MS)
    return () => {
      gone = true
      clearInterval(id)
    }
  }, [currency])
  return prices
}
