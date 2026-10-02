import { describe, expect, it } from 'vitest'
import { money, PRICE_IDS, pricesUrl, readPrices, worth } from './prices'

describe('prices', () => {
  it('asks about every coin and token maki knows, whatever is held', () => {
    expect(PRICE_IDS).toEqual([
      'akash-network',
      'aptos',
      'axelar',
      'babylon',
      'bitcoin',
      'bitcoin-cash',
      'cardano',
      'celestia',
      'cosmos',
      'dai',
      'dogecoin',
      'dydx-chain',
      'ethereum',
      'euro-coin',
      'juno-network',
      'kaspa',
      'litecoin',
      'monero',
      'near',
      'neutron-3',
      'osmosis',
      'paypal-usd',
      'polygon-ecosystem-token',
      'ripple',
      'solana',
      'stellar',
      'tether',
      'tron',
      'usd-coin',
      'usdt0',
      'weth',
      'wrapped-bitcoin'
    ])
    expect(pricesUrl('eur')).toBe(
      'https://api.coingecko.com/api/v3/simple/price?ids=akash-network,aptos,axelar,babylon,bitcoin,bitcoin-cash,cardano,celestia,cosmos,dai,dogecoin,dydx-chain,ethereum,euro-coin,juno-network,kaspa,litecoin,monero,near,neutron-3,osmosis,paypal-usd,polygon-ecosystem-token,ripple,solana,stellar,tether,tron,usd-coin,usdt0,weth,wrapped-bitcoin&vs_currencies=eur'
    )
  })

  it('takes only numbers, for what it asked about', () => {
    expect(
      readPrices(
        {
          bitcoin: { usd: 83105 },
          ethereum: { usd: '2649' },
          'shiba-inu': { usd: 1 },
          dai: { eur: 1 }
        },
        'usd'
      )
    ).toEqual({ bitcoin: 83105 })
    expect(readPrices(null, 'usd')).toEqual({})
  })

  it('works out what an amount is worth, exactly until the end', () => {
    const prices = { bitcoin: 80_000, 'usd-coin': 1, ethereum: 2_000 }
    expect(worth(prices, 'BTC', 150_000n, 8)).toBeCloseTo(120)
    expect(worth(prices, 'USDC', 1_500_000n, 6)).toBe(1.5)
    expect(worth(prices, 'ETH', 10n ** 18n / 4n, 18)).toBe(500)
    // a test network's coin, and one without a price, are worth nothing to show
    expect(worth(prices, 'ETH', 10n ** 18n, 18, true)).toBeNull()
    expect(worth(prices, 'POL', 10n ** 18n, 18)).toBeNull()
    expect(worth(null, 'BTC', 1n, 8)).toBeNull()
  })

  it('writes money as people do', () => {
    expect(money(1234.5, 'usd', 'en-US')).toBe('$1,234.50')
    expect(money(0.1234, 'usd', 'en-US')).toBe('$0.1234')
    expect(money(1234.5, 'eur', 'de-DE')).toBe('1.234,50\u00a0€')
  })
})
