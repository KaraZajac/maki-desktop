import { describe, expect, it } from 'vitest'
import {
  allocation,
  byCoin,
  dayOf,
  emptyKept,
  failed,
  found,
  FRESH_MS,
  isFailed,
  isFresh,
  keptJson,
  MAX_DAYS,
  MAX_HELD,
  MAX_LOOKS,
  MAX_SEGMENTS,
  only,
  readKept,
  recordDay,
  summarize,
  type Held,
  type Kept
} from './portfolio'
import type { Prices } from './prices'
import { balanceOf, newWallet, type Output, type WalletState } from './monero/wallet'

const T = 1_790_000_000_000
const held = (symbol: string | null, amount: bigint, decimals: number, name?: string): Held => ({
  symbol,
  name: name ?? symbol ?? 'token',
  amount,
  decimals
})

/** Prices by CoinGecko's names, as prices.ts keeps them. */
const PRICES: Prices = {
  bitcoin: 60_000,
  ethereum: 2_000,
  'usd-coin': 1,
  tron: 0.25,
  tether: 1
}

/** An account of each kind, looked up at T: Bitcoin's two, Ethereum on two networks, and Tron's. */
function kept(): Kept {
  let k = emptyKept()
  k = found(
    k,
    'bitcoin:segwit',
    { coin: 'bitcoin', where: 'native SegWit', held: [held('BTC', 30_000n, 8)] },
    T
  )
  k = found(
    k,
    'bitcoin:taproot',
    { coin: 'bitcoin', where: 'taproot', held: [held('BTC', 20_000n, 8)] },
    T + 1000
  )
  k = found(
    k,
    'ethereum:1',
    {
      coin: 'ethereum',
      where: 'Ethereum',
      held: [held('ETH', 10n ** 18n, 18), held('USDC', 1_500_000n, 6)]
    },
    T + 2000
  )
  // BNB Chain's USDC has 18 decimals: it's added to Ethereum's 6 exactly
  k = found(
    k,
    'ethereum:56',
    {
      coin: 'ethereum',
      where: 'BNB Chain',
      held: [held('USDC', 2_500_000_000_000_000_000n, 18)]
    },
    T + 3000
  )
  k = found(
    k,
    'tron',
    {
      coin: 'tron',
      where: 'Tron',
      held: [held('TRX', 120_000_000n, 6), held('USDT', 30_000_000n, 6)]
    },
    T + 4000
  )
  return k
}

describe('what the Portfolio keeps', () => {
  it('goes to JSON and back as it was: amounts as digits', () => {
    const k = recordDay(kept(), '2026-10-02', 'usd', 1234.5)
    const json = JSON.parse(JSON.stringify(keptJson(k))) as {
      looks: Record<string, { held: { amount: unknown }[] }>
    }
    expect(json.looks['ethereum:56'].held[0].amount).toBe('2500000000000000000')
    expect(readKept(json)).toEqual(k)
  })

  it('keeps amounts and times, and nothing else that comes with them', () => {
    const k = readKept({
      looks: {
        'bitcoin:segwit': {
          coin: 'bitcoin',
          where: 'native SegWit',
          at: T,
          tried: T,
          held: [{ symbol: 'BTC', name: 'BTC', amount: '5', decimals: 8, price: 60_000 }],
          descriptor: 'wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)',
          address: 'bc1q…'
        }
      },
      days: [{ day: '2026-10-02', currency: 'usd', total: 3, prices: { bitcoin: 60_000 } }],
      view: 'a secret view key'
    })
    expect(k).toEqual({
      looks: {
        'bitcoin:segwit': {
          coin: 'bitcoin',
          where: 'native SegWit',
          at: T,
          tried: T,
          held: [{ symbol: 'BTC', name: 'BTC', amount: 5n, decimals: 8 }]
        }
      },
      days: [{ day: '2026-10-02', currency: 'usd', total: 3 }]
    })
  })

  it('drops a look or a day that isn’t one, and keeps the rest', () => {
    const good = { coin: 'tron', where: 'Tron', at: T, tried: T, held: [] }
    const bad: Record<string, unknown> = {
      'Bad Key': good,
      '../x': good,
      a: { ...good, coin: 'Tron!' },
      b: { ...good, where: '' },
      c: { ...good, where: 'x'.repeat(49) },
      d: { ...good, where: 'a\nb' },
      e: { ...good, at: -1 },
      f: { ...good, tried: 1.5 },
      g: { ...good, at: undefined },
      h: { ...good, held: 'BTC' },
      i: { ...good, held: [{ symbol: 'BTC', name: 'BTC', amount: '0', decimals: 8 }] },
      j: { ...good, held: [{ symbol: 'BTC', name: 'BTC', amount: '-5', decimals: 8 }] },
      k: { ...good, held: [{ symbol: 'BTC', name: 'BTC', amount: 5, decimals: 8 }] },
      l: { ...good, held: [{ symbol: 'BTC', name: 'BTC', amount: '5', decimals: 41 }] },
      m: { ...good, held: [{ symbol: 'BTC\u0000', name: 'BTC', amount: '5', decimals: 8 }] },
      m2: { ...good, held: [{ symbol: 'B'.repeat(25), name: 'BTC', amount: '5', decimals: 8 }] },
      n: { ...good, held: Array(MAX_HELD + 1).fill(held('BTC', 1n, 8)) },
      o: { ...good, block: 'tip' },
      p: null
    }
    const k = readKept({
      looks: {
        ...bad,
        tron: {
          ...good,
          held: [{ symbol: 'USDC (old)', name: 'USDC (old)', amount: '5', decimals: 6 }]
        },
        'cosmos:osmosis': { ...good, coin: 'cosmos' }
      },
      days: [
        { day: '2026-10-02', currency: 'usd', total: 1 },
        { day: '2026-10-02', currency: 'btc', total: 1 },
        { day: '2 Oct', currency: 'usd', total: 1 },
        { day: '2026-10-03', currency: 'usd', total: -1 },
        { day: '2026-10-03', currency: 'usd', total: Infinity }
      ]
    })
    expect(Object.keys(k.looks)).toEqual(['tron', 'cosmos:osmosis'])
    expect(k.days).toEqual([{ day: '2026-10-02', currency: 'usd', total: 1 }])
    for (const v of [null, 'x', 7, [], { looks: [] }, { looks: 'x', days: 'y' }])
      expect(readKept(v)).toEqual(emptyKept())
  })

  it('keeps at most so many looks and days', () => {
    const looks = Object.fromEntries(
      Array.from({ length: MAX_LOOKS + 10 }, (_, i) => [
        `l${i}`,
        { coin: 'x', where: 'x', at: T, tried: T, held: [] }
      ])
    )
    const days = Array.from({ length: MAX_DAYS + 10 }, (_, i) => ({
      day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      currency: 'usd',
      total: i
    }))
    const k = readKept({ looks, days })
    expect(Object.keys(k.looks)).toHaveLength(MAX_LOOKS)
    expect(k.days).toHaveLength(MAX_DAYS)
    // the newest of them
    expect(k.days[k.days.length - 1].total).toBe(MAX_DAYS + 9)
  })
})

describe('looking', () => {
  it('keeps what a look found, more than nothing of each', () => {
    const k = found(
      emptyKept(),
      'solana:mainnet',
      {
        coin: 'solana',
        where: 'Solana',
        held: [held('SOL', 0n, 9), held('USDC', 7n, 6)]
      },
      T
    )
    expect(k.looks['solana:mainnet']).toEqual({
      coin: 'solana',
      where: 'Solana',
      at: T,
      tried: T,
      held: [held('USDC', 7n, 6)]
    })
  })

  it('keeps the coins and tokens with a price first, when there are too many to keep', () => {
    const spam = Array.from({ length: MAX_HELD }, (_, i) => held(null, 1n, 0, `spam ${i}`))
    const k = found(
      emptyKept(),
      'solana:mainnet',
      { coin: 'solana', where: 'Solana', held: [...spam, held('SOL', 5n, 9)] },
      T
    )
    const h = k.looks['solana:mainnet'].held
    expect(h).toHaveLength(MAX_HELD)
    expect(h[0]).toEqual(held('SOL', 5n, 9))
  })

  it('keeps what a look last found when the next one fails, as it was then', () => {
    let k = kept()
    k = failed(k, 'tron', { coin: 'tron', where: 'Tron' }, T + 60_000)
    expect(k.looks['tron']).toMatchObject({ at: T + 4000, tried: T + 60_000 })
    expect(k.looks['tron'].held).toHaveLength(2)
    expect(isFailed(k.looks['tron'])).toBe(true)
    // and a look that never went well holds nothing, and says so
    k = failed(k, 'xrp', { coin: 'xrp', where: 'XRP Ledger' }, T + 60_000)
    expect(k.looks['xrp']).toEqual({
      coin: 'xrp',
      where: 'XRP Ledger',
      at: null,
      tried: T + 60_000,
      held: []
    })
    expect(isFailed(k.looks['xrp'])).toBe(true)
    // once one goes well again, it isn't
    k = found(k, 'tron', { coin: 'tron', where: 'Tron', held: [] }, T + 120_000)
    expect(isFailed(k.looks['tron'])).toBe(false)
  })

  it('keeps only the accounts still shared', () => {
    expect(Object.keys(only(kept(), ['tron', 'bitcoin:segwit', 'gone']).looks)).toEqual([
      'bitcoin:segwit',
      'tron'
    ])
  })

  it('doesn’t look again at what was looked at in the last minute, unless it failed', () => {
    const k = kept()
    const tron = k.looks['tron']
    expect(isFresh(tron, T + 4000 + FRESH_MS - 1)).toBe(true)
    expect(isFresh(tron, T + 4000 + FRESH_MS)).toBe(false)
    expect(isFresh(undefined, T)).toBe(false)
    const tried = failed(k, 'tron', { coin: 'tron', where: 'Tron' }, T + 5000).looks['tron']
    expect(isFresh(tried, T + 6000)).toBe(false)
  })

  it('groups the looks by wallet, in the order they were looked at', () => {
    expect(byCoin(kept()).map((g) => [g.coin, g.looks.map((l) => l.key)])).toEqual([
      ['bitcoin', ['bitcoin:segwit', 'bitcoin:taproot']],
      ['ethereum', ['ethereum:1', 'ethereum:56']],
      ['tron', ['tron']]
    ])
  })
})

describe('the sums', () => {
  it('adds each coin and token up wherever it is, and values it', () => {
    const s = summarize(kept(), PRICES)
    const row = (id: string) => s.rows.find((r) => r.id === id)!
    // 0.0005 BTC, from two accounts
    expect(row('BTC')).toMatchObject({ amount: 50_000n, decimals: 8, price: 60_000, value: 30 })
    expect(row('BTC').places.map((p) => [p.where, p.amount])).toEqual([
      ['native SegWit', 30_000n],
      ['taproot', 20_000n]
    ])
    // 1.5 USDC on Ethereum (6 decimals) and 2.5 on BNB Chain (18): 4 USDC, exactly
    expect(row('USDC')).toMatchObject({ amount: 4n * 10n ** 18n, decimals: 18, value: 4 })
    expect(row('ETH').value).toBe(2000)
    expect(row('TRX').value).toBe(30)
    expect(row('USDT').value).toBe(30)
    expect(s.total).toBe(30 + 4 + 2000 + 30 + 30)
  })

  it('shares out the total, the most valuable first', () => {
    const s = summarize(kept(), PRICES)
    expect(s.rows.map((r) => r.id)).toEqual(['ETH', 'BTC', 'TRX', 'USDT', 'USDC'])
    expect(s.rows.map((r) => r.share)).toEqual([2000, 30, 30, 30, 4].map((v) => v / 2094))
    expect(s.rows.reduce((n, r) => n + r.share!, 0)).toBeCloseTo(1, 12)
  })

  it('leaves out of the total what has no price, and says it has none', () => {
    let k = kept()
    k = found(
      k,
      'solana:mainnet',
      {
        coin: 'solana',
        where: 'Solana',
        held: [held(null, 12_500_000n, 6, 'Fh3a…9QzX')]
      },
      T
    )
    // a symbol CoinGecko isn't asked about
    k = found(
      k,
      'aptos',
      { coin: 'aptos', where: 'Aptos', held: [held('lzUSDC', 5_000_000n, 6)] },
      T
    )
    const s = summarize(k, PRICES)
    expect(s.total).toBe(2094)
    const none = s.rows.filter((r) => r.value === null)
    expect(none.map((r) => [r.id, r.name, r.price, r.share])).toEqual([
      ['solana:Fh3a…9QzX', 'Fh3a…9QzX', null, null],
      ['lzUSDC', 'lzUSDC', null, null]
    ])
    // they come after what has a value
    expect(s.rows.slice(-2)).toEqual(none)
  })

  it('without prices, has the amounts and nothing in money', () => {
    const s = summarize(kept(), null)
    expect(s.total).toBe(null)
    expect(s.rows.every((r) => r.price === null && r.value === null && r.share === null)).toBe(true)
    expect(s.rows.map((r) => r.id)).toEqual(['BTC', 'ETH', 'TRX', 'USDC', 'USDT'])
  })

  it('with prices and nothing held, comes to nothing', () => {
    const k = found(emptyKept(), 'tron', { coin: 'tron', where: 'Tron', held: [] }, T)
    expect(summarize(k, PRICES)).toEqual({ rows: [], total: 0, asOf: T, failed: [] })
    expect(summarize(emptyKept(), PRICES)).toEqual({
      rows: [],
      total: 0,
      asOf: null,
      failed: []
    })
  })

  it('says what’s as it was before a look that failed, and still counts it', () => {
    const k = failed(kept(), 'bitcoin:taproot', { coin: 'bitcoin', where: 'taproot' }, T + 9000)
    const s = summarize(k, PRICES)
    const btc = s.rows.find((r) => r.id === 'BTC')!
    expect(btc.stale).toBe(true)
    expect(btc.places.map((p) => [p.where, p.stale])).toEqual([
      ['native SegWit', false],
      ['taproot', true]
    ])
    expect(btc.value).toBe(30)
    expect(s.rows.find((r) => r.id === 'ETH')!.stale).toBe(false)
    expect(s.failed.map((f) => f.key)).toEqual(['bitcoin:taproot'])
  })

  it('is as of the oldest look’s finding, Monero’s aside (it says its block)', () => {
    let k = kept()
    expect(summarize(k, PRICES).asOf).toBe(T)
    k = found(
      k,
      'monero',
      {
        coin: 'monero',
        where: 'Monero',
        held: [held('XMR', 2n * 10n ** 12n, 12)],
        block: 3_500_000
      },
      T - 86_400_000
    )
    expect(k.looks['monero'].block).toBe(3_500_000)
    expect(summarize(k, PRICES).asOf).toBe(T)
    // a look that failed is as of when it last went well: with the others looked at again since,
    // it's the oldest
    for (const key of ['bitcoin:segwit', 'bitcoin:taproot', 'ethereum:1', 'ethereum:56'])
      k = found(k, key, { ...k.looks[key], held: k.looks[key].held }, T + 90_000)
    k = failed(k, 'tron', { coin: 'tron', where: 'Tron' }, T + 99_000)
    expect(summarize(k, PRICES).asOf).toBe(T + 4000)
  })
})

describe('the allocation', () => {
  it('shares the total out in the order the accounts were looked up, each in its own colour', () => {
    const k = kept()
    const parts = allocation(k, summarize(k, PRICES))
    expect(parts.map((p) => [p.id, p.slot])).toEqual([
      ['BTC', 0],
      ['ETH', 1],
      ['USDC', 2],
      ['TRX', 3],
      ['USDT', 4]
    ])
    expect(parts.reduce((n, p) => n + p.share, 0)).toBeCloseTo(1, 12)
    expect(parts[1]).toMatchObject({ name: 'ETH', value: 2000, share: 2000 / 2094 })
  })

  it('keeps each coin’s colour as prices move', () => {
    const k = kept()
    const before = allocation(k, summarize(k, PRICES))
    const after = allocation(k, summarize(k, { ...PRICES, bitcoin: 100_000_000, ethereum: 1 }))
    expect(after.map((p) => [p.id, p.slot])).toEqual(before.map((p) => [p.id, p.slot]))
    expect(after[0].share).toBeGreaterThan(0.99)
  })

  it('past so many, shows the most valuable on their own and the rest as Other, last', () => {
    let k = emptyKept()
    const symbols = ['BTC', 'LTC', 'DOGE', 'BCH', 'DASH', 'DGB', 'ZEC', 'KAS', 'XMR', 'SOL']
    const prices: Prices = {}
    const ids = [
      'bitcoin',
      'litecoin',
      'dogecoin',
      'bitcoin-cash',
      'dash',
      'digibyte',
      'zcash'
    ].concat(['kaspa', 'monero', 'solana'])
    symbols.forEach((symbol, i) => {
      k = found(k, `c${i}`, { coin: `c${i}`, where: 'x', held: [held(symbol, 1n, 0)] }, T)
      // the later, the more valuable: 1, 2, ... 10
      prices[ids[i]] = i + 1
    })
    const parts = allocation(k, summarize(k, prices))
    expect(parts).toHaveLength(MAX_SEGMENTS)
    // the seven most valuable (SOL down to DASH), in the order they were looked up
    expect(parts.slice(0, -1).map((p) => p.id)).toEqual([
      'BCH',
      'DASH',
      'DGB',
      'ZEC',
      'KAS',
      'XMR',
      'SOL'
    ])
    expect(parts.slice(0, -1).map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parts[parts.length - 1]).toEqual({
      id: null,
      name: 'Other',
      value: 1 + 2 + 3,
      share: 6 / 55,
      slot: null
    })
  })

  it('has no parts without prices, or with nothing of value', () => {
    const k = kept()
    expect(allocation(k, summarize(k, null))).toEqual([])
    expect(allocation(k, summarize(k, {}))).toEqual([])
  })
})

describe('the total, day by day', () => {
  it('keeps one a day for each currency, the later taking the earlier’s place', () => {
    let k = emptyKept()
    k = recordDay(k, '2026-10-02', 'usd', 100)
    k = recordDay(k, '2026-10-01', 'usd', 90)
    k = recordDay(k, '2026-10-02', 'eur', 85)
    k = recordDay(k, '2026-10-02', 'usd', 110)
    expect(k.days).toEqual([
      { day: '2026-10-01', currency: 'usd', total: 90 },
      { day: '2026-10-02', currency: 'eur', total: 85 },
      { day: '2026-10-02', currency: 'usd', total: 110 }
    ])
  })

  it('keeps no more than MAX_DAYS, the newest', () => {
    let k = emptyKept()
    const start = Date.UTC(2025, 0, 1, 12)
    for (let i = 0; i < MAX_DAYS + 5; i++) k = recordDay(k, dayOf(start + i * 86_400_000), 'usd', i)
    expect(k.days).toHaveLength(MAX_DAYS)
    expect(k.days[0].total).toBe(5)
    expect(k.days[MAX_DAYS - 1].total).toBe(MAX_DAYS + 4)
  })

  it('takes only a day and a total that are one', () => {
    const k = emptyKept()
    expect(recordDay(k, 'today', 'usd', 1)).toBe(k)
    expect(recordDay(k, '2026-10-02', 'usd', NaN)).toBe(k)
    expect(recordDay(k, '2026-10-02', 'usd', -1)).toBe(k)
  })

  it('names days by this computer’s calendar', () => {
    const noon = new Date(2026, 9, 2, 12, 0, 0).getTime()
    expect(dayOf(noon)).toBe('2026-10-02')
    expect(dayOf(new Date(2026, 0, 9, 23, 59).getTime())).toBe('2026-01-09')
  })
})

describe('Monero, as its own wallet last found it', () => {
  const output = (txid: string, amount: bigint, unlockHeight: number, spent = false): Output => ({
    txid,
    height: unlockHeight - 10,
    index: 0,
    global: '1',
    key: txid,
    commitment: '',
    amount: amount.toString(),
    mask: '',
    txKey: '',
    major: 0,
    minor: 0,
    unlockHeight,
    ...(spent && { spent: { txid: 'spender', height: 3_400_100 } })
  })

  it('counts what the wallet holds, what can’t be spent yet too, and change waiting for a block', () => {
    const state: WalletState = {
      ...newWallet('http://127.0.0.1:18081', 3_400_000),
      scanned: 3_456_789,
      outputs: [
        output('a', 2_000_000_000_000n, 3_400_010),
        // spent: no longer the wallet's
        output('b', 5_000_000_000_000n, 3_400_020, true),
        // too recent to spend at the block scanned to, but the wallet's
        output('c', 500_000_000_000n, 3_456_795)
      ],
      sent: [
        {
          txid: 'spender',
          tx: '',
          at: 0,
          fee: '30000000',
          to: [],
          change: '1000000000000',
          spends: ['b'],
          own: []
        }
      ]
    }
    expect(balanceOf(state, state.scanned)).toEqual({
      total: 3_500_000_000_000n,
      unlocked: 2_000_000_000_000n,
      pending: 1_500_000_000_000n
    })
    // what the Portfolio keeps of it: its total, as of the block scanned to
    const k = found(
      emptyKept(),
      'monero',
      {
        coin: 'monero',
        where: 'Monero',
        held: [held('XMR', balanceOf(state, state.scanned).total, 12)],
        block: state.scanned
      },
      T
    )
    expect(summarize(k, { monero: 150 }).total).toBe(3.5 * 150)
  })
})
