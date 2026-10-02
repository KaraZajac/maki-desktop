import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import { BtcAccount, Network, type BtcAccountValue, type NetworkValue } from '@shared/protocol'
import {
  KINDS,
  NETWORKS_OF,
  parseDescriptor,
  type BtcAccountInfo,
  type BtcChain,
  type BtcKind
} from '@shared/btc-wallet'
import {
  BITCOINCASH_APP,
  DASH_APP,
  DIGIBYTE_APP,
  DOGECOIN_APP,
  LITECOIN_APP
} from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import { BitcoinWallet } from './BitcoinWallet'
import { Button, Card, Glyph, Label, Segmented } from './ui'
import { WalletAppNeeded } from './WalletAppNeeded'

/** What sets one of Bitcoin's kind apart, as its card shows it. */
interface CoinCard {
  name: string
  app: string
  glyph: string
  /** its colour, as the card's mark has it */
  tint: string
  /** where its accounts come from, after "The … account" */
  wallets: string
  /** where its balance comes from, and who sees what */
  servers: string
  /** its test network's name on the card; null for none maki desktop has a server for */
  test?: string | null
}

const COINS: Record<Exclude<BtcChain, 'bitcoin'>, CoinCard> = {
  litecoin: {
    name: 'Litecoin',
    app: LITECOIN_APP,
    glyph: 'litecoin',
    tint: 'bg-sky/10 text-sky',
    wallets: 'Litecoin Core, Electrum-LTC and Ledger make',
    servers:
      'Balances and payments go through litecoinspace.org, which sees the account’s addresses and this computer’s IP address.'
  },
  dogecoin: {
    name: 'Dogecoin',
    app: DOGECOIN_APP,
    glyph: 'dogecoin',
    tint: 'bg-yellow/10 text-yellow',
    wallets: 'Trezor, Ledger and the other BIP44 wallets make',
    servers:
      'Balances and payments go through a Dogecoin server, which sees the account’s addresses and this computer’s IP address.'
  },
  bitcoincash: {
    name: 'Bitcoin Cash',
    app: BITCOINCASH_APP,
    glyph: 'bitcoincash',
    tint: 'bg-green/10 text-green',
    wallets: 'Electron Cash, Ledger and the other BIP44 wallets make',
    servers:
      'Balances and payments go through Bitcoin Cash’s Electrum servers (bch.imaginary.cash and others, as Electron Cash lists them), which see the account’s addresses and this computer’s IP address. The test network is chipnet.'
  },
  dash: {
    name: 'Dash',
    app: DASH_APP,
    glyph: 'dash',
    tint: 'bg-sapphire/10 text-sapphire',
    wallets: 'Dash Core, Ledger and Trezor make',
    servers:
      'Balances and payments go through insight.dash.org, Dash’s own Insight API, which sees the account’s addresses and this computer’s IP address. maki signs payments alone: a masternode’s or Dash Platform’s transactions it refuses, and coins Dash Platform paid out it spends like any other.'
  },
  digibyte: {
    name: 'DigiByte',
    app: DIGIBYTE_APP,
    glyph: 'digibyte',
    tint: 'bg-blue/10 text-blue',
    wallets: 'Ledger and the other BIP44 wallets make',
    servers:
      'Balances and payments go through digiexplorer.info, which sees the account’s addresses and this computer’s IP address; there’s no test network server it can use. maki won’t sign DigiDollar’s transactions or spend its coins of no DGB; it can’t see DigiAssets either, so a payment from an address that holds some would lose them, as one spending Omni coins on Bitcoin would.',
    test: null
  }
}
/** Each kind of account as the card names it, and as maki's apps number it. */
const KIND_OF: Record<BtcKind, [BtcAccountValue, string]> = {
  segwit: [BtcAccount.SEGWIT, 'Native SegWit'],
  taproot: [BtcAccount.TAPROOT, 'Taproot'],
  legacy: [BtcAccount.LEGACY, 'Legacy']
}

function saved<T>(key: string, one: T, other: T): T {
  try {
    return localStorage.getItem(key) === '1' ? other : one
  } catch {
    return one
  }
}

function remember(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // remembered for this session only
  }
}

/**
 * One of maki's accounts on a chain of Bitcoin's kind besides Bitcoin (Litecoin, Dogecoin, Bitcoin
 * Cash, Dash, DigiByte): a wallet here (balance, receive, send, activity) once maki's app for it has
 * shared the account's public key. Its transactions are Bitcoin's, so it's the Bitcoin wallet on its
 * networks.
 */
export function BtcCoin({
  link,
  apps,
  chain
}: {
  link: Link
  apps: Apps
  chain: Exclude<BtcChain, 'bitcoin'>
}): React.JSX.Element {
  const coin = COINS[chain]
  const kinds = KINDS[chain]
  const linked = link.state.linked
  const [chosenNetwork, setNetwork] = useState<NetworkValue>(() =>
    saved(`maki.${chain}Network`, Network.BITCOIN, Network.TESTNET)
  )
  // a chain without a test network server is on its own
  const network = coin.test === null ? Network.BITCOIN : chosenNetwork
  const [chosen, setKind] = useState<BtcAccountValue>(() => {
    try {
      const v = Number(localStorage.getItem(`maki.${chain}Account`))
      return kinds.map((k) => KIND_OF[k][0]).find((n) => n === v) ?? KIND_OF[kinds[0]][0]
    } catch {
      return KIND_OF[kinds[0]][0]
    }
  })
  const kind = kinds.length === 1 ? KIND_OF[kinds[0]][0] : chosen
  const [descriptors, setDescriptors] = useState<string[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // the wallet this card is (the page starts it again for another): what it keeps is that one's
  const [wallet] = useState(() => link.wallet)

  useEffect(() => {
    void window.maki.bitcoin.load(chain).then(setDescriptors)
  }, [chain])

  const net = NETWORKS_OF[chain][network === Network.TESTNET ? 1 : 0]
  const k: BtcKind =
    kind === BtcAccount.LEGACY ? 'legacy' : kind === BtcAccount.TAPROOT ? 'taproot' : 'segwit'
  const accountOf = (d: string): BtcAccountInfo | null => {
    try {
      return parseDescriptor(d, chain)
    } catch {
      return null
    }
  }
  const info = useMemo(
    () => descriptors?.map(accountOf).find((a) => a?.network === net && a.kind === k) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [descriptors, net, k]
  )
  const which =
    k === 'taproot'
      ? 'taproot'
      : k === 'segwit'
        ? 'native SegWit'
        : kinds.length > 1
          ? 'legacy'
          : ''

  const keep = async (list: string[]): Promise<void> => {
    await window.maki.bitcoin.save(list, chain, wallet)
    setDescriptors(list)
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    setProblem(null)
    try {
      const a = await link.btcAccount(network, kind, chain)
      if (!a) {
        setProblem('maki didn’t share the account.')
        return
      }
      const got = parseDescriptor(a.descriptor, chain)
      if (got.network !== net || got.kind !== k)
        throw new Error('maki shared a different account from the one asked for')
      await keep([
        ...(descriptors ?? []).filter(
          (d) =>
            d !== got.descriptor && !(accountOf(d)?.network === net && accountOf(d)?.kind === k)
        ),
        got.descriptor
      ])
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const forget = async (): Promise<void> => {
    if (!info) return
    await keep((descriptors ?? []).filter((d) => d !== info.descriptor))
    link.note(
      `${which ? `${which} ` : ''}${coin.name} account removed from maki desktop (maki still has it)`
    )
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>{coin.name}</Label>
        <div className="flex flex-wrap gap-2">
          {kinds.length > 1 && (
            <Segmented
              label="Account"
              value={kind}
              options={kinds.map((k) => KIND_OF[k])}
              onChange={(v) => {
                setKind(v)
                setProblem(null)
                remember(`maki.${chain}Account`, v)
              }}
            />
          )}
          {coin.test !== null && (
            <Segmented
              label="Network"
              value={network}
              options={[
                [Network.BITCOIN, coin.name],
                [Network.TESTNET, coin.test ?? (chain === 'bitcoincash' ? 'Chipnet' : 'Testnet')]
              ]}
              onChange={(v) => {
                setNetwork(v)
                setProblem(null)
                remember(`maki.${chain}Network`, v)
              }}
            />
          )}
        </div>
      </div>
      <WalletAppNeeded link={link} apps={apps} id={coin.app} name={coin.name} />

      {descriptors === null ? null : info ? (
        <BitcoinWallet
          key={`${info.network} ${info.descriptor}`}
          link={link}
          info={info}
          network={network}
          kind={kind}
        />
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
          <span
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${coin.tint}`}
          >
            <Glyph name={coin.glyph} className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[0.95rem] font-bold text-fg">
              Your {coin.name.toLowerCase()}, here
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
              The {which ? `${which} ` : ''}account {coin.wallets} from maki’s recovery phrase. maki
              shares its public key once you approve it on maki; maki desktop can then show the
              balance, give you addresses and make payments, which maki shows you and signs. It can
              never spend on its own.
            </p>
          </div>
          <Button
            kind="primary"
            glyph="chip"
            disabled={!linked || adding}
            onClick={() => void add()}
          >
            {adding ? 'Approve on maki…' : linked ? 'Add from maki' : 'Plug maki in'}
          </Button>
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-surface0 pt-4">
        <p className="max-w-xl text-xs leading-relaxed text-overlay0">{coin.servers}</p>
        {info && (
          <Button small onClick={() => void forget()}>
            Remove from maki desktop
          </Button>
        )}
      </div>
    </Card>
  )
}

export const Litecoin = (p: { link: Link; apps: Apps }): React.JSX.Element => (
  <BtcCoin {...p} chain="litecoin" />
)
export const Dogecoin = (p: { link: Link; apps: Apps }): React.JSX.Element => (
  <BtcCoin {...p} chain="dogecoin" />
)
export const BitcoinCash = (p: { link: Link; apps: Apps }): React.JSX.Element => (
  <BtcCoin {...p} chain="bitcoincash" />
)
export const Dash = (p: { link: Link; apps: Apps }): React.JSX.Element => (
  <BtcCoin {...p} chain="dash" />
)
export const DigiByte = (p: { link: Link; apps: Apps }): React.JSX.Element => (
  <BtcCoin {...p} chain="digibyte" />
)
