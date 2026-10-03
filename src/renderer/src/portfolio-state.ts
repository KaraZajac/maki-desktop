/**
 * The Portfolio's side of the window (shared/portfolio.ts): which accounts maki desktop has for the
 * wallet in use, each looked up the way its wallet card looks it up, through the same servers and
 * the main process's same queues, one account after another; and what's been found, which main
 * keeps for the wallet. One refresh at a time, whichever page started it, carrying on while the
 * owner looks elsewhere; the Portfolio page and the Overview's tile show what it's found so far.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { WALLET_SITE } from '@shared/bridge-types'
import {
  isTest,
  parseDescriptor,
  UNIT,
  type BtcAccountInfo,
  type BtcChain
} from '@shared/btc-wallet'
import type { AccountChain, ChainState } from '@shared/account-chain'
import type { SharedAccount } from '@shared/coin-servers'
import { APTOS } from '@shared/coins/aptos'
import { CARDANO } from '@shared/coins/cardano'
import { COSMOS } from '@shared/coins/cosmos'
import { KASPA } from '@shared/coins/kaspa'
import { NEAR } from '@shared/coins/near'
import { STELLAR } from '@shared/coins/stellar'
import { SUI } from '@shared/coins/sui'
import { TON, TON_W5, w5Account } from '@shared/coins/ton'
import { TRON } from '@shared/coins/tron'
import { XRP } from '@shared/coins/xrp'
import { ZCASH } from '@shared/coins/zcash'
import { NETWORKS, ProviderError, type Rpc } from '@shared/ethereum'
import { EthWallet, type NetworkHoldings } from '@shared/eth-wallet'
import type { Link } from '@shared/link'
import { readKept as readMonero } from '@shared/monero/kept'
import { balanceOf } from '@shared/monero/wallet'
import {
  emptyKept,
  failed,
  found,
  isFresh,
  keptJson,
  only,
  readKept,
  recordDay,
  summarize,
  dayOf,
  FRESH_MS,
  type Held,
  type Kept
} from '@shared/portfolio'
import { CURRENCIES, type Currency, type Prices } from '@shared/prices'
import { SOL_NETWORKS } from '@shared/solana'
import type { SolNetworkHoldings } from '@shared/sol-wallet'
import {
  BITCOIN_APP,
  BITCOINCASH_APP,
  COSMOS_APP,
  DASH_APP,
  DIGIBYTE_APP,
  DOGECOIN_APP,
  ETHEREUM_APP,
  LITECOIN_APP,
  MONERO_APP,
  SOLANA_APP,
  TON_APP
} from '@shared/wallet-apps'
import type { WalletId } from '@shared/wallets'
import {
  fetcher,
  keyOf as accountKey,
  kept as accountsSeen,
  tokenName as chainTokenName
} from './AccountWallet'
import { keyOf as btcKey, kept as btcSeen, walletFor } from './BitcoinWallet'
import { kept as ethSeen } from './EthereumWallet'
import { kept as solSeen, tokenName as solTokenName } from './SolanaWallet'

/** A wallet maki desktop has a card for on the Wallets page, as the Portfolio names it. */
export interface Coin {
  id: string
  name: string
  glyph: string
  /** its app on maki */
  app: string
}

/** The wallets, in the order the Wallets page shows them, which is the order they're looked up in. */
export const COINS: Coin[] = [
  { id: 'bitcoin', name: 'Bitcoin', glyph: 'bitcoin', app: BITCOIN_APP },
  { id: 'litecoin', name: 'Litecoin', glyph: 'litecoin', app: LITECOIN_APP },
  { id: 'dogecoin', name: 'Dogecoin', glyph: 'dogecoin', app: DOGECOIN_APP },
  { id: 'bitcoincash', name: 'Bitcoin Cash', glyph: 'bitcoincash', app: BITCOINCASH_APP },
  { id: 'dash', name: 'Dash', glyph: 'dash', app: DASH_APP },
  { id: 'digibyte', name: 'DigiByte', glyph: 'digibyte', app: DIGIBYTE_APP },
  { id: 'zcash', name: 'Zcash', glyph: 'zcash', app: ZCASH.app },
  { id: 'kaspa', name: 'Kaspa', glyph: 'kaspa', app: KASPA.app },
  { id: 'ethereum', name: 'Ethereum', glyph: 'ethereum', app: ETHEREUM_APP },
  { id: 'monero', name: 'Monero', glyph: 'monero', app: MONERO_APP },
  { id: 'solana', name: 'Solana', glyph: 'solana', app: SOLANA_APP },
  { id: 'xrp', name: 'XRP', glyph: 'xrp', app: XRP.app },
  { id: 'stellar', name: 'Stellar', glyph: 'stellar', app: STELLAR.app },
  { id: 'tron', name: 'Tron', glyph: 'tron', app: TRON.app },
  { id: 'aptos', name: 'Aptos', glyph: 'aptos', app: APTOS.app },
  { id: 'near', name: 'NEAR', glyph: 'near', app: NEAR.app },
  { id: 'cardano', name: 'Cardano', glyph: 'cardano', app: CARDANO.app },
  { id: 'cosmos', name: 'Cosmos', glyph: 'cosmos', app: COSMOS_APP },
  { id: 'sui', name: 'Sui', glyph: 'sui', app: SUI.app },
  { id: 'ton', name: 'TON', glyph: 'ton', app: TON_APP }
]

/** A wallet by its ID; one the Portfolio doesn't know (kept by a later maki desktop), by its ID. */
export const coinNamed = (id: string): Coin =>
  COINS.find((c) => c.id === id) ?? { id, name: id, glyph: 'wallet', app: '' }

/** The chains of Bitcoin's kind, by their wallet's ID. */
const BTC_CHAINS: BtcChain[] = [
  'bitcoin',
  'litecoin',
  'dogecoin',
  'bitcoincash',
  'dash',
  'digibyte'
]
/** The account chains with an account each (Cosmos's chains and TON's two wallets are below). */
const ACCOUNT_CHAINS: AccountChain[] = [ZCASH, KASPA, XRP, STELLAR, TRON, APTOS, NEAR, CARDANO, SUI]
const KIND: Record<BtcAccountInfo['kind'], string> = {
  segwit: 'native SegWit',
  taproot: 'taproot',
  legacy: 'legacy'
}

/** One account on one network, to look up. */
interface Job {
  key: string
  coin: string
  where: string
  /** what the account's card found in the last minute, and when: nothing to ask again */
  seen(): { held: Held[]; at: number } | null
  /** looks, telling `progress` how it's going, if it can */
  look(progress: (detail: string) => void): Promise<{ held: Held[]; block?: number }>
}

/** What the Portfolio can't count, and why. */
export interface Uncounted {
  /** accounts on test networks, whose coins are worth nothing: never looked up, never counted */
  test: { coin: string; where: string }[]
  /** wallets maki has (or had, last linked) that maki desktop has no account of yet */
  missing: { coin: string; why: string }[]
}

/** The accounts there are to look up, and what can't be counted. */
interface Plan extends Uncounted {
  jobs: Job[]
}

/** How long a name of a token's may be, as it's kept. */
const NAME_MOST = 48
const named = (s: string): string => (s.length > NAME_MOST ? `${s.slice(0, NAME_MOST - 1)}…` : s)

const btcHeld = (info: BtcAccountInfo, balance: bigint): Held[] => [
  { symbol: UNIT[info.network], name: UNIT[info.network], amount: balance, decimals: 8 }
]

const chainHeld = (chain: AccountChain, state: ChainState): Held[] =>
  state.holdings.map((h) => ({
    symbol: h.token ? h.token.symbol : chain.priced,
    name: named(h.token ? chainTokenName(chain, 0, h.token) : chain.units[0]),
    amount: h.amount,
    decimals: h.token ? h.token.decimals : chain.decimals
  }))

const ethHeld = (n: NetworkHoldings): Held[] =>
  n.holdings.map((h) => ({
    symbol: h.token ? h.token.symbol : n.network.unit,
    name: h.token ? h.token.symbol : n.network.unit,
    amount: h.amount,
    decimals: h.token ? h.token.decimals : 18
  }))

const solHeld = (holdings: SolNetworkHoldings['holdings']): Held[] =>
  holdings.map((h) => ({
    symbol: h.token ? h.token.symbol : 'SOL',
    name: named(solTokenName(h.token)),
    amount: h.amount,
    decimals: h.token ? h.token.decimals : 9
  }))

/** Ethereum's networks' servers, as the link asks them (App.tsx's), for EthWallet. */
const ethRpc: Rpc = async (url, method, params) => {
  const r = await window.maki.ethereum.rpc(url, method, params)
  if (r.error) throw new ProviderError(r.error.code, r.error.message)
  return r.result
}

/** An account chain's account, as a job: its card's look, and its card's memory of it. */
function chainJob(
  key: string,
  coin: string,
  where: string,
  chain: AccountChain,
  account: SharedAccount
): Job {
  return {
    key,
    coin,
    where,
    seen: () => {
      const s = accountsSeen.get(accountKey(chain, account))
      return s && Date.now() - s.at < FRESH_MS
        ? { held: chainHeld(chain, s.state), at: s.at }
        : null
    },
    look: async () => {
      const state = await chain.look(fetcher(chain), account)
      accountsSeen.set(accountKey(chain, account), { state, at: Date.now() })
      return { held: chainHeld(chain, state) }
    }
  }
}

/**
 * What there is to look up for the wallet in use, from what maki desktop keeps of it (nothing asked
 * of a network), and what can't be counted; `known`, the apps maki has, says which wallets have no
 * account here yet.
 */
async function plan(link: Link, known: string[]): Promise<Plan> {
  const out: Plan = { jobs: [], test: [], missing: [] }
  const has = (coin: string): boolean => known.includes(coinNamed(coin).app)
  const missing = (coin: string, why: string): void => {
    if (has(coin)) out.missing.push({ coin, why })
  }

  // Bitcoin and its kind: each account maki shared, by its descriptor
  const btc = new Map<BtcChain, BtcAccountInfo[]>()
  for (const chain of BTC_CHAINS) {
    const infos = (await window.maki.bitcoin.load(chain)).flatMap((d) => {
      try {
        return [parseDescriptor(d, chain)]
      } catch {
        return []
      }
    })
    btc.set(chain, infos)
  }
  const accounts = await window.maki.coins.load()
  const ethAddress =
    (await link.ethereum.sites()).find((s) => s.site === WALLET_SITE)?.address ?? null
  const solAddress =
    (await link.solana.sites()).find((s) => s.site === WALLET_SITE)?.address ?? null
  const monero = readMonero(await window.maki.monero.load())

  for (const coin of COINS) {
    const id = coin.id
    if ((BTC_CHAINS as string[]).includes(id)) {
      const infos = btc.get(id as BtcChain)!
      for (const info of infos.filter((i) => isTest(i.network)))
        out.test.push({ coin: id, where: `${KIND[info.kind]}, on its test network` })
      const main = infos.filter((i) => !isTest(i.network))
      if (main.length === 0) missing(id, 'none of its accounts is here yet')
      for (const info of main)
        out.jobs.push({
          key: `${id}:${info.kind}`,
          coin: id,
          where: KIND[info.kind],
          seen: () => {
            const s = btcSeen.get(btcKey(info))
            return s && Date.now() - s.at < FRESH_MS
              ? { held: btcHeld(info, s.state.confirmed + s.state.pending), at: s.at }
              : null
          },
          look: async (progress) => {
            const state = await walletFor(info).scan((n) => progress(`${n} addresses`))
            btcSeen.set(btcKey(info), { state, at: Date.now() })
            return { held: btcHeld(info, state.confirmed + state.pending) }
          }
        })
    } else if (id === 'ethereum') {
      if (!ethAddress) {
        missing(id, 'maki desktop isn’t connected to its account yet')
        continue
      }
      for (const network of NETWORKS) {
        if (network.test) {
          out.test.push({ coin: id, where: network.name })
          continue
        }
        out.jobs.push({
          key: `ethereum:${network.chainId}`,
          coin: id,
          where: network.name,
          seen: () => {
            const s = ethSeen
            const n =
              s && s.address === ethAddress && Date.now() - s.at < FRESH_MS
                ? s.holdings.find((h) => h.network.chainId === network.chainId)
                : undefined
            return n && n.problem === null ? { held: ethHeld(n), at: s!.at } : null
          },
          // EthWallet's own way, a network at a time: one server's few requests, then the next's
          look: async () => {
            const [n] = await new EthWallet(link.ethereum, ethRpc, [network]).holdings(ethAddress)
            if (n.problem !== null) throw new Error(n.problem)
            return { held: ethHeld(n) }
          }
        })
      }
    } else if (id === 'solana') {
      if (!solAddress) {
        missing(id, 'maki desktop isn’t connected to its account yet')
        continue
      }
      for (const network of SOL_NETWORKS) {
        if (network.test) {
          out.test.push({ coin: id, where: network.name })
          continue
        }
        out.jobs.push({
          key: `solana:${network.chain.replace(/^solana:/, '')}`,
          coin: id,
          where: network.name,
          seen: () => {
            const s = solSeen
            const n =
              s && s.address === solAddress && Date.now() - s.at < FRESH_MS
                ? s.holdings.find((h) => h.network.chain === network.chain)
                : undefined
            return n && n.problem === null ? { held: solHeld(n.holdings), at: s!.at } : null
          },
          look: async () => ({
            held: solHeld(await link.solWallet.holdingsOn(network, solAddress))
          })
        })
      }
    } else if (id === 'monero') {
      for (const [network, name] of [
        ['testnet', 'testnet'],
        ['stagenet', 'stagenet']
      ] as const)
        if (monero.watched[network]) out.test.push({ coin: id, where: name })
      const state = monero.wallets.mainnet
      if (!monero.watched.mainnet) missing(id, 'this computer doesn’t watch it yet')
      else if (!state) missing(id, 'maki desktop’s own wallet of it hasn’t been started')
      else
        out.jobs.push({
          key: 'monero',
          coin: id,
          where: 'Monero',
          seen: () => null,
          // what its own wallet last found, as it keeps it: no node asked, nothing scanned
          look: async () => ({
            held: [
              {
                symbol: 'XMR',
                name: 'XMR',
                amount: balanceOf(state, state.scanned).total,
                decimals: 12
              }
            ],
            block: state.scanned
          })
        })
    } else if (id === 'cosmos') {
      let any = false
      for (const chain of COSMOS) {
        const list = accounts[chain.id] ?? []
        const main = list.find((a) => a.network === 0 && a.index === 0)
        const test = list.find((a) => a.network === 1 && a.index === 0)
        if (test) out.test.push({ coin: id, where: `${chain.name}’s test network` })
        if (main) {
          any = true
          out.jobs.push(chainJob(`cosmos:${chain.id}`, id, chain.name, chain, main))
        }
      }
      if (!any) missing(id, 'none of its chains’ accounts is here yet')
    } else if (id === 'ton') {
      const list = accounts.ton ?? []
      const main = list.find((a) => a.network === 0 && a.index === 0)
      if (list.some((a) => a.network === 1 && a.index === 0))
        out.test.push({ coin: id, where: 'its test network' })
      if (!main) {
        missing(id, 'its account isn’t here yet')
        continue
      }
      // the key's two wallets, each at an address of its own
      out.jobs.push(chainJob('ton:v4r2', id, 'v4R2 wallet', TON, main))
      out.jobs.push(chainJob('ton:w5', id, 'W5 wallet', TON_W5, w5Account(main)))
    } else {
      const chain = ACCOUNT_CHAINS.find((c) => c.id === id)
      if (!chain) continue
      const list = accounts[chain.id] ?? []
      const main = list.find((a) => a.network === 0 && a.index === 0)
      const test = list.find((a) => a.network === 1 && a.index === 0)
      if (test) out.test.push({ coin: id, where: chain.networks[1] ?? 'its test network' })
      if (main) out.jobs.push(chainJob(id, id, chain.networks[0], chain, main))
      else missing(id, 'its account isn’t here yet')
    }
  }
  return out
}

/** What the Portfolio knows, for the wallet in use. */
export interface Folio extends Uncounted {
  /** the wallet it's all for */
  wallet: WalletId
  /** what's kept for it; null until it's been read */
  kept: Kept | null
  /** why each look's last try failed, as far as this session knows */
  problems: Record<string, string>
  /** whether there's been a plan yet: until then, what can't be counted isn't known */
  planned: boolean
  /** how many accounts (each on each network) the last plan found to look up */
  accounts: number
  /** the refresh under way: what it's looking at, and how far it's got */
  refreshing: { where: string | null; detail: string | null; done: number; of: number } | null
}

let folio: Folio = {
  wallet: null,
  kept: null,
  problems: {},
  planned: false,
  accounts: 0,
  refreshing: null,
  test: [],
  missing: []
}
const listeners = new Set<() => void>()
const set = (changes: Partial<Folio>): void => {
  folio = { ...folio, ...changes }
  for (const l of listeners) l()
}
/** The read under way, and which wallet's. */
let reading: { wallet: WalletId; done: Promise<void> } | null = null
/** The refresh under way, and which wallet's: one at a time, whichever wallet it's for. */
let running: { wallet: WalletId; done: Promise<void> } | null = null

/** Starts again for `wallet`, if it isn't the one the Portfolio has: maki opened another. */
function forWallet(wallet: WalletId): void {
  if (folio.wallet === wallet) return
  folio = {
    wallet,
    kept: null,
    problems: {},
    planned: false,
    accounts: 0,
    refreshing: null,
    test: [],
    missing: []
  }
  for (const l of listeners) l()
}

/** Reads what's kept for the wallet in use, unless it has been (or is being) read. */
function read(link: Link): Promise<void> {
  const wallet = link.wallet
  forWallet(wallet)
  if (folio.kept !== null) return Promise.resolve()
  if (reading?.wallet === wallet) return reading.done
  const done = (async (): Promise<void> => {
    let kept = emptyKept()
    try {
      kept = readKept(await window.maki.portfolio.load())
    } catch {
      // nothing kept that can be read: it starts again
    }
    // another wallet since: its own read is the one that counts
    if (link.wallet === wallet && folio.wallet === wallet && folio.kept === null) set({ kept })
  })()
  const now = { wallet, done }
  reading = now
  void done.finally(() => {
    if (reading === now) reading = null
  })
  return done
}

/** What can't be counted, worked out again from what maki desktop keeps (no network asked). */
export async function replan(link: Link, known: string[]): Promise<void> {
  const wallet = link.wallet
  const p = await plan(link, known)
  if (link.wallet === wallet && folio.wallet === wallet)
    set({ test: p.test, missing: p.missing, planned: true, accounts: p.jobs.length })
}

/** The currency chosen on the Wallets page (or here), or none. */
function savedCurrency(): Currency | null {
  try {
    const c = localStorage.getItem('maki.currency')
    return CURRENCIES.includes(c as Currency) ? (c as Currency) : null
  } catch {
    return null
  }
}

/**
 * Looks everything up for the wallet in use, one account after another, keeping what each look
 * finds as it goes; with `all`, even what was looked at in the last minute. One refresh at a time:
 * while one for this wallet is under way, this does nothing; one for another wallet (maki opened
 * this one since) is let finish its last request first. It stops when maki opens another wallet.
 */
export async function refresh(link: Link, known: string[], all: boolean): Promise<void> {
  const wallet = link.wallet
  if (running?.wallet === wallet) return
  if (running) await running.done.catch(() => {})
  if (running || link.wallet !== wallet) return
  const done = lookEverything(link, known, all, wallet)
  const now = { wallet, done }
  running = now
  try {
    await done
  } finally {
    if (running === now) running = null
  }
}

/** The refresh itself, for `wallet`: what it finds is shown only while that's the Portfolio's. */
async function lookEverything(
  link: Link,
  known: string[],
  all: boolean,
  wallet: WalletId
): Promise<void> {
  // changes to what's shown, while the Portfolio is still this wallet's
  const show = (changes: Partial<Folio>): void => {
    if (folio.wallet === wallet) set(changes)
  }
  const gone = (): boolean => link.wallet !== wallet || folio.wallet !== wallet
  await read(link)
  if (gone() || folio.kept === null) return
  show({ refreshing: { where: null, detail: null, done: 0, of: 0 } })
  try {
    const p = await plan(link, known)
    if (gone()) return
    let kept = only(
      folio.kept ?? emptyKept(),
      p.jobs.map((j) => j.key)
    )
    const problems: Record<string, string> = {}
    show({
      kept,
      problems,
      test: p.test,
      missing: p.missing,
      planned: true,
      accounts: p.jobs.length,
      refreshing: { where: null, detail: null, done: 0, of: p.jobs.length }
    })
    const keep = async (next: Kept): Promise<void> => {
      kept = next
      show({ kept, problems: { ...problems } })
      // turned down if maki opened another wallet meanwhile: that ends it
      await window.maki.portfolio.save(keptJson(kept), wallet)
    }
    await keep(kept)
    for (const [i, job] of p.jobs.entries()) {
      if (gone()) return
      const name = `${coinNamed(job.coin).name}, ${job.where}`
      show({ refreshing: { where: name, detail: null, done: i, of: p.jobs.length } })
      if (!all && isFresh(kept.looks[job.key], Date.now())) continue
      // what its card found in the last minute will do, unless the owner asked to look again
      const seen = all ? null : job.seen()
      if (seen) {
        await keep(
          found(kept, job.key, { coin: job.coin, where: job.where, held: seen.held }, seen.at)
        )
        continue
      }
      try {
        const got = await job.look((detail) =>
          show({ refreshing: { where: name, detail, done: i, of: p.jobs.length } })
        )
        if (gone()) return
        delete problems[job.key]
        await keep(found(kept, job.key, { coin: job.coin, where: job.where, ...got }, Date.now()))
      } catch (e) {
        if (gone()) return
        problems[job.key] = (e as Error).message
        await keep(failed(kept, job.key, { coin: job.coin, where: job.where }, Date.now()))
      }
    }
    // the day's total, in the currency chosen, if there's one and its prices come
    const currency = savedCurrency()
    if (p.jobs.length > 0 && currency) {
      const prices: Prices | null = await window.maki.prices(currency).catch(() => null)
      const total = prices && summarize(kept, prices).total
      if (typeof total === 'number' && !gone())
        await keep(recordDay(kept, dayOf(Date.now()), currency, total))
    }
  } catch (e) {
    // a save turned down (maki opened another wallet): the refresh ends here, and what it found so
    // far is on the page
    console.warn(`the Portfolio stopped: ${(e as Error).message}`)
  } finally {
    show({ refreshing: null })
  }
}

/** What the Portfolio knows for the wallet in use, kept up to date: read, if it hasn't been. */
export function usePortfolio(link: Link): Folio {
  const now = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => folio
  )
  const wallet = link.wallet
  useEffect(() => {
    void read(link)
  }, [link, wallet])
  return now.wallet === wallet ? now : { ...now, wallet, kept: null, refreshing: null }
}

/** The currency chosen (the Wallets page's choice, the same one), and a way to choose. */
export function useCurrency(): [Currency | null, (c: Currency | null) => void] {
  const [currency, setCurrency] = useState<Currency | null>(savedCurrency)
  const choose = (c: Currency | null): void => {
    setCurrency(c)
    try {
      if (c) localStorage.setItem('maki.currency', c)
      else localStorage.removeItem('maki.currency')
    } catch {
      // remembered for this session only
    }
  }
  return [currency, choose]
}

/** Prices older than this are asked for again, when they're looked at. */
const PRICES_EVERY_MS = 5 * 60_000
/** After CoinGecko couldn't be asked (it's down, or busy), this long before it's asked again. */
const PRICES_FAILED_WAIT_MS = 2 * 60_000
/** The last prices, so the page and the tile show them straight away. */
let lastPrices: { currency: Currency; prices: Prices; at: number } | null = null
/** The last time they couldn't be had, and why. */
let lastFailed: { currency: Currency; at: number; problem: string } | null = null

/**
 * CoinGecko's prices in `currency`, once one is chosen (none is asked for until then): when they
 * came, and why they didn't, if they didn't. Asked for again once they're five minutes old (two
 * minutes after a failure), but only while someone's looking: the window has the focus (it comes
 * back to it from the tray, say), not while it waits in the tray, the Overview showing.
 */
export function usePortfolioPrices(currency: Currency | null): {
  prices: Prices | null
  at: number | null
  problem: string | null
} {
  const now = (): { prices: Prices | null; at: number | null; problem: string | null } => {
    const last = currency && lastPrices?.currency === currency ? lastPrices : null
    const failure = currency && lastFailed?.currency === currency ? lastFailed : null
    return {
      prices: last?.prices ?? null,
      at: last?.at ?? null,
      problem: failure && (!last || failure.at > last.at) ? failure.problem : null
    }
  }
  const [got, setGot] = useState(now)
  useEffect(() => {
    setGot(now())
    if (!currency) return
    let gone = false
    let asking = false
    const ask = (): void => {
      const last = lastPrices?.currency === currency ? lastPrices : null
      const failure = lastFailed?.currency === currency ? lastFailed : null
      if (
        asking ||
        (last && Date.now() - last.at < PRICES_EVERY_MS) ||
        (failure && Date.now() - failure.at < PRICES_FAILED_WAIT_MS)
      )
        return
      asking = true
      window.maki
        .prices(currency)
        .then(
          (prices) => {
            lastPrices = { currency, prices, at: Date.now() }
            lastFailed = null
          },
          (e: Error) => {
            // the last prices stay, if there were any; the next ask may go better
            lastFailed = { currency, at: Date.now(), problem: e.message }
          }
        )
        .finally(() => {
          asking = false
          if (!gone) setGot(now())
        })
    }
    ask()
    const looked = (): void => ask()
    window.addEventListener('focus', looked)
    const id = setInterval(() => document.hasFocus() && ask(), 30_000)
    return () => {
      gone = true
      window.removeEventListener('focus', looked)
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency])
  return got
}
