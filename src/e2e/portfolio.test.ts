/**
 * The Portfolio, end to end: the real app, offscreen, linked to the fake maki running maki's Bitcoin,
 * Ethereum and Tron apps (the test phrase's accounts), their networks and CoinGecko stood in for on
 * this computer. The Wallets page adds the accounts, as a person would; the Portfolio adds them all
 * up, and its total is checked against what they hold at the stand-in's prices, worked out here.
 * Then, the app run again over what it kept, as if an hour had passed: the last of it shows at once,
 * while it's looked up again; and with Bitcoin's server gone, Bitcoin's coins are still counted, as
 * they were, the page saying why they weren't looked up, and the others are looked up again.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/portfolio.test.ts
 *
 * It needs a display to render into (Wayland or X), and builds the app first.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BtcWallet, parseDescriptor } from '../shared/btc-wallet'
import { MakiClient } from '../shared/client'
import { tronStandIn } from '../shared/coin-stand-ins'
import { NETWORKS } from '../shared/ethereum'
import { money } from '../shared/prices'
import { BtcAccount, Network } from '../shared/protocol'
import { ethStandIn, pretendChain, serve, serveEsplora, serveEthRpc } from '../shared/stand-ins'
import { APP_FIXTURES, FAKE_BUILT, startFake, TcpTransport } from '../shared/test-support'
import { BitcoinApp } from '../shared/wallet-apps'
import { build, drive, E2E } from './drive'

/** What the CoinGecko stand-in says, by CoinGecko's names: every other coin is 3. */
const PRICE: Record<string, number> = {
  bitcoin: 60_000,
  ethereum: 2_000,
  'usd-coin': 1,
  tether: 1,
  tron: 0.25
}

/** CoinGecko's simple price API, as the app asks it: the coins asked about, in US dollars. */
function pricesStandIn(): Promise<{ url: string; close: () => void }> {
  return serve(async (_method, path) => {
    const url = new URL(path, 'http://stand-in')
    if (url.pathname !== '/api/v3/simple/price' || url.searchParams.get('vs_currencies') !== 'usd')
      return [404, 'not here']
    const ids = (url.searchParams.get('ids') ?? '').split(',')
    return [200, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { usd: PRICE[id] ?? 3 }])))]
  })
}

/**
 * What the accounts hold, at the stand-in's prices, worked out here: the Bitcoin account's 50,000
 * satoshis; on each of Ethereum's networks but its test network, one of the network's coin (ether
 * on ten of them, USDC on Arc, and the others' own coins at 3), and 1.5 USDC on Ethereum; and the
 * Tron account's 120 TRX and 30 USDT.
 */
function expectedTotal(): number {
  const networks = NETWORKS.filter((n) => !n.test)
  expect(networks).toHaveLength(21)
  expect(networks.filter((n) => n.unit === 'ETH')).toHaveLength(10)
  const coins = networks.reduce(
    (n, net) => n + (net.unit === 'ETH' ? 2_000 : net.unit === 'USDC' ? 1 : 3),
    0
  )
  return 0.0005 * 60_000 + coins + 1.5 * 1 + 120 * 0.25 + 30 * 1
}

/** Money as the app writes it, in English, as the app is run here. */
const usd = (v: number): string => money(v, 'usd', 'en-US')

describe.skipIf(!E2E || !FAKE_BUILT)('the Portfolio, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''
  let data = ''
  /** The Bitcoin account's first receiving address: where the stand-in chain's coin is. */
  let receive = ''

  beforeAll(async () => {
    build()
    fake = await startFake(
      ['bitcoin', 'ethereum', 'tron'].flatMap((a) => ['--app', join(APP_FIXTURES, `${a}.maki`)])
    )
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
    // what the app keeps, kept from one run to the next, as a person's is
    data = mkdtempSync(join(tmpdir(), 'maki-e2e-data-'))
    const t = await TcpTransport.open(fake.port)
    const client = new MakiClient(t)
    const bitcoin = new BitcoinApp((app, message, timeoutMs) =>
      client.appMessage(app, message, timeoutMs)
    )
    const info = parseDescriptor(
      (await bitcoin.account(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
    )
    await t.close()
    receive = new BtcWallet(info, async () => '').keys.address(0, 0).address
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    for (const d of [home, data]) if (d) rmSync(d, { recursive: true, force: true })
  })

  /** The networks and CoinGecko, stood in for while `run` runs; Bitcoin's at `esplora`, if given. */
  async function withNetworks<T>(
    esplora: string | null,
    run: (env: Record<string, string>) => Promise<T>
  ): Promise<T> {
    const servers = [
      await serveEsplora(pretendChain(receive, 50_000).esplora),
      await serveEthRpc(ethStandIn().rpc),
      await serve(tronStandIn().answer),
      await pricesStandIn()
    ]
    try {
      return await run({
        MAKI_ESPLORA: esplora ?? servers[0].url,
        MAKI_ETH_RPC: servers[1].url,
        MAKI_COIN_SERVER: servers[2].url,
        MAKI_PRICES: servers[3].url,
        MAKI_OFFSCREEN_DATA: data,
        // money as this test writes it
        LANGUAGE: 'en_US',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8'
      })
    } finally {
      for (const s of servers) s.close()
    }
  }

  /** What the Portfolio kept, as if it had been looked up an hour sooner: none of it fresh now. */
  function anHourAgo(): void {
    const file = join(data, 'portfolio.json')
    const kept = JSON.parse(readFileSync(file, 'utf8')) as {
      looks: Record<string, { at: number | null; tried: number }>
    }
    for (const look of Object.values(kept.looks)) {
      if (look.at !== null) look.at -= 3_600_000
      look.tried -= 3_600_000
    }
    writeFileSync(file, JSON.stringify(kept))
  }

  it('adds up what the Wallets page’s accounts hold, at CoinGecko’s prices', async () => {
    const total = expectedTotal()
    expect(total).toBe(20_122.5)
    const said = await withNetworks(null, (env) =>
      drive(
        home,
        fake.port,
        [
          ...['--click', 'Wallets', '--choose', 'usd'],
          ...['--click', 'Bitcoin › Add from maki', '--until', '0.0005'],
          ...['--click', 'Ethereum › Connect on maki', '--until', 'USDC'],
          ...['--click', 'Tron › Add from maki', '--until', 'USDT'],
          ...['--click', 'Portfolio', '--until', usd(total), '--gone', 'Looking up']
        ],
        env
      )
    )
    expect(said).toContain(usd(total))
    // each coin and token, all of it wherever it is: its amount, price, value and share
    expect(said).toMatch(/ETH\s+Arbitrum One 1 · Base 1 · Ethereum 1 · [^\n]*ZKsync Era 1/)
    expect(said).toMatch(/ETH\s+[^\n]*\n\s*10\s+\$2,000\.00\s+\$20,000\.00\s+99\.4%/)
    expect(said).toMatch(/BTC\s+native SegWit 0\.0005\s+0\.0005\s+\$60,000\.00\s+\$30\.00\s+0\.1%/)
    expect(said).toMatch(/TRX\s+Tron 120\s+120\s+\$0\.25\s+\$30\.00\s+0\.1%/)
    expect(said).toMatch(/USDT\s+Tron 30\s+30\s+\$1\.00\s+\$30\.00\s+0\.1%/)
    // 1.5 USDC on Ethereum, and Arc's coin, which is USDC: 2.5
    expect(said).toMatch(/USDC\s+Arc 1 · Ethereum 1\.5\s+2\.5\s+\$1\.00\s+\$2\.50/)
    // the accounts, when they were looked up, and what isn't counted
    expect(said).toMatch(/Bitcoin\s+native SegWit\s+looked up just now/)
    expect(said).toMatch(/Ethereum\s+21 networks\s+looked up just now/)
    expect(said).toMatch(/Test networks[^\n]*: Ethereum \(Sepolia\)\./)
  }, 240_000)

  it('shows the last of it at once when it’s opened again, while it looks again', async () => {
    anHourAgo()
    // Bitcoin's server takes the request and never answers: what was kept is what shows meanwhile
    const silent = await serve(() => new Promise(() => {}))
    try {
      const said = await withNetworks(silent.url, (env) =>
        drive(
          home,
          fake.port,
          ['--click', 'Portfolio', '--until', 'Looking up Bitcoin, native SegWit'],
          env
        )
      )
      expect(said).toContain(usd(expectedTotal()))
      expect(said).toMatch(/BTC\s+native SegWit 0\.0005/)
      expect(said).toMatch(/Bitcoin\s+native SegWit\s+looking…/)
      expect(said).toMatch(/Ethereum\s+21 networks\s+looked up 1 h ago/)
    } finally {
      silent.close()
    }
  }, 240_000)

  it('counts what couldn’t be looked up as it was, says why, and looks the rest up again', async () => {
    anHourAgo()
    // nothing listens on port 9: Bitcoin's server can't be reached; the others answer
    const said = await withNetworks('http://127.0.0.1:9', (env) =>
      drive(
        home,
        fake.port,
        ['--click', 'Portfolio', '--until', 'couldn’t be looked up', '--gone', 'Looking up'],
        env
      )
    )
    expect(said).toContain(usd(expectedTotal()))
    expect(said).toMatch(/BTC\s+as it was\s+native SegWit 0\.0005\s/i)
    expect(said).toMatch(
      /Bitcoin\s+native SegWit\s+couldn’t be looked up: the Esplora server can’t be reached\. Counted as it was \d+ h ago\./
    )
    expect(said).toMatch(/An account couldn’t be looked up this time/)
    expect(said).toMatch(/Ethereum\s+21 networks\s+looked up just now/)
    expect(said).toMatch(/Tron\s+looked up just now/)
  }, 240_000)

  it('shows the total on the Overview, with when it was looked up', async () => {
    const said = await withNetworks(null, (env) =>
      drive(home, fake.port, ['--click', 'Overview', '--until', usd(expectedTotal())], env)
    )
    expect(said).toMatch(
      new RegExp(`PORTFOLIO\\s+${usd(expectedTotal()).replace(/[$.]/g, '\\$&')}\\s+looked up`)
    )
  }, 240_000)
})
