/**
 * What the wallets' coins and tokens are worth in money, if the owner wants to see it: prices
 * from CoinGecko, which sees this computer's IP address and the list of coins asked about (the
 * same list for everyone), never an address or a balance. Test networks' coins are worth nothing.
 */

/** The money the owner can see values in. */
export const CURRENCIES = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'cad', 'aud'] as const
export type Currency = (typeof CURRENCIES)[number]

/** CoinGecko's names for the coins and the tokens maki knows, by symbol. */
const IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  POL: 'polygon-ecosystem-token',
  USDC: 'usd-coin',
  USDT: 'tether',
  USDT0: 'usdt0',
  DAI: 'dai',
  WETH: 'weth',
  WBTC: 'wrapped-bitcoin',
  XMR: 'monero',
  SOL: 'solana',
  PYUSD: 'paypal-usd'
}

/** Everything asked about, every time: the question says nothing about what's held. */
export const PRICE_IDS = [...new Set(Object.values(IDS))].sort()

/** Prices by CoinGecko's name, in one currency. */
export type Prices = Record<string, number>

/** The address that asks for them. */
export const pricesUrl = (currency: Currency): string =>
  `https://api.coingecko.com/api/v3/simple/price?ids=${PRICE_IDS.join(',')}&vs_currencies=${currency}`

/** CoinGecko's answer, as prices in `currency`: only the ones asked about, only numbers. */
export function readPrices(json: unknown, currency: Currency): Prices {
  const out: Prices = {}
  if (typeof json !== 'object' || json === null) return out
  for (const id of PRICE_IDS) {
    const v = (json as Record<string, Record<string, unknown> | undefined>)[id]?.[currency]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[id] = v
  }
  return out
}

/**
 * What `amount` (in its smallest units, `decimals` of them) of `symbol` is worth, or null if it
 * has no price: a test network's coin, or one CoinGecko didn't say.
 */
export function worth(
  prices: Prices | null,
  symbol: string,
  amount: bigint,
  decimals: number,
  test = false
): number | null {
  if (!prices || test) return null
  const price = prices[IDS[symbol] ?? '']
  if (price === undefined) return null
  // to a float only at the end, via a string, so a big balance keeps its digits
  return (
    Number(
      `${amount / 10n ** BigInt(decimals)}.${(amount % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')}`
    ) * price
  )
}

/** An amount of money as people write it (where this computer is, unless `locale` says). */
export function money(value: number, currency: Currency, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : 2
  }).format(value)
}
