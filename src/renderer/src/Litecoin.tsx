import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import { BtcAccount, Network, type BtcAccountValue, type NetworkValue } from '@shared/protocol'
import { parseDescriptor, type BtcAccountInfo } from '@shared/btc-wallet'
import { LITECOIN_APP } from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import { BitcoinWallet } from './BitcoinWallet'
import { Button, Card, Glyph, Label, Segmented } from './ui'
import { WalletAppNeeded } from './WalletAppNeeded'

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

const accountOf = (d: string): BtcAccountInfo | null => {
  try {
    return parseDescriptor(d, 'litecoin')
  } catch {
    return null
  }
}

/**
 * maki's Litecoin accounts: a wallet here (balance, receive, send, activity) once maki's Litecoin
 * app has shared the account's public key. Litecoin's transactions are Bitcoin's, so it's the
 * Bitcoin wallet on Litecoin's networks, its chain from litecoinspace.org.
 */
export function Litecoin({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element {
  const linked = link.state.linked
  const [network, setNetwork] = useState<NetworkValue>(() =>
    saved('maki.ltcNetwork', Network.BITCOIN, Network.TESTNET)
  )
  const [kind, setKind] = useState<BtcAccountValue>(() =>
    saved('maki.ltcAccount', BtcAccount.SEGWIT, BtcAccount.TAPROOT)
  )
  const [descriptors, setDescriptors] = useState<string[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void window.maki.bitcoin.load('litecoin').then(setDescriptors)
  }, [])

  const net = network === Network.TESTNET ? 'litecoin-test' : 'litecoin'
  const k = kind === BtcAccount.TAPROOT ? 'taproot' : 'segwit'
  const info = useMemo(
    () => descriptors?.map(accountOf).find((a) => a?.network === net && a.kind === k) ?? null,
    [descriptors, net, k]
  )

  const keep = async (list: string[]): Promise<void> => {
    await window.maki.bitcoin.save(list, 'litecoin')
    setDescriptors(list)
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    setProblem(null)
    try {
      const a = await link.btcAccount(network, kind, 'litecoin')
      if (!a) {
        setProblem('maki didn’t share the account.')
        return
      }
      const got = parseDescriptor(a.descriptor, 'litecoin')
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
      `${k === 'taproot' ? 'taproot' : 'native SegWit'} Litecoin account removed from maki desktop (maki still has it)`
    )
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>Litecoin</Label>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label="Account"
            value={kind}
            options={[
              [BtcAccount.SEGWIT, 'Native SegWit'],
              [BtcAccount.TAPROOT, 'Taproot']
            ]}
            onChange={(v) => {
              setKind(v)
              setProblem(null)
              remember('maki.ltcAccount', v)
            }}
          />
          <Segmented
            label="Network"
            value={network}
            options={[
              [Network.BITCOIN, 'Litecoin'],
              [Network.TESTNET, 'Testnet']
            ]}
            onChange={(v) => {
              setNetwork(v)
              setProblem(null)
              remember('maki.ltcNetwork', v)
            }}
          />
        </div>
      </div>
      <WalletAppNeeded link={link} apps={apps} id={LITECOIN_APP} name="Litecoin" />

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
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-sky/10 text-sky">
            <Glyph name="litecoin" className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[0.95rem] font-bold text-fg">Your litecoin, here</h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
              The {k === 'taproot' ? 'taproot' : 'native SegWit'} account Litecoin Core,
              Electrum-LTC and Ledger make from maki’s recovery phrase. maki shares its public key
              once you approve it on maki; maki desktop can then show the balance, give you
              addresses and make payments, which maki shows you and signs. It can never spend on its
              own.
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
        <p className="max-w-xl text-xs leading-relaxed text-overlay0">
          Balances and payments go through litecoinspace.org, which sees the account’s addresses and
          this computer’s IP address.
        </p>
        {info && (
          <Button small onClick={() => void forget()}>
            Remove from maki desktop
          </Button>
        )}
      </div>
    </Card>
  )
}
