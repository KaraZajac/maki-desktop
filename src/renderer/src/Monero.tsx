import { useEffect, useMemo, useRef, useState } from 'react'
import { hex } from '@scure/base'
import type { Link } from '@shared/link'
import { type KeptMonero, readKept, viewWallet } from '@shared/monero/kept'
import type { WalletState } from '@shared/monero/wallet'
import { decodeAddress, type Network } from '@shared/monero/xmr'
import { MONERO_APP, MoneroNetwork, type MoneroNetworkValue } from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import { MoneroGui } from './MoneroGui'
import { MoneroWallet } from './MoneroWallet'
import { Button, Card, Glyph, Label, Segmented } from './ui'
import { WalletAppNeeded } from './WalletAppNeeded'

const NETWORK_OF: Record<MoneroNetworkValue, Network> = {
  [MoneroNetwork.MONERO]: 'mainnet',
  [MoneroNetwork.TESTNET]: 'testnet',
  [MoneroNetwork.STAGENET]: 'stagenet'
}

/**
 * maki's Monero wallet: the one a Ledger makes from the same recovery phrase, in maki's Monero
 * app. An address to receive to, compared on maki's screen first; its backup words show on maki
 * alone.
 */
export function Monero({ link, apps }: { link: Link; apps: Apps }): React.JSX.Element {
  const linked = link.state.linked
  const [network, setNetwork] = useState<MoneroNetworkValue>(MoneroNetwork.MONERO)
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState<{
    address: string
    network: MoneroNetworkValue
    index: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [kept, setKept] = useState<KeptMonero | null>(null)
  const [watching, setWatching] = useState(false)
  // the wallet this card is (the page starts it again for another): what it keeps is that one's
  const [wallet] = useState(() => link.wallet)

  useEffect(() => {
    void window.maki.monero.load().then((v) => setKept(readKept(v)))
  }, [])

  const net = NETWORK_OF[network]
  const watched = kept?.watched[net]
  const keys = useMemo(
    () => (watched ? viewWallet(watched, net) : null),
    [watched?.address, watched?.view, net]
  )

  // what's kept as of now: a wallet saves itself after awaits, when this render's may be old
  const latest = useRef<KeptMonero | null>(null)
  latest.current = kept
  const keep = async (next: KeptMonero): Promise<void> => {
    latest.current = next
    await window.maki.monero.save(next, wallet)
    setKept(next)
  }

  /** maki's view key, once its owner lets this computer watch. */
  const watch = async (): Promise<void> => {
    setWatching(true)
    setProblem(null)
    try {
      const r = await link.moneroWatch(network)
      if (r.approval !== 'approved' || !r.viewKey) {
        setProblem(
          r.approval === 'denied'
            ? 'You said no on maki.'
            : r.approval === 'no match'
              ? 'Add the Monero app first.'
              : `maki: ${r.approval}`
        )
        return
      }
      if (decodeAddress(r.address)?.network !== net)
        throw new Error('maki shared another network’s address')
      await keep({
        ...(kept ?? { watched: {}, wallets: {} }),
        watched: { ...kept?.watched, [net]: { address: r.address, view: hex.encode(r.viewKey) } }
      })
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setWatching(false)
    }
  }

  const forget = async (): Promise<void> => {
    const rest = { ...kept?.watched }
    delete rest[net]
    const wallets = { ...kept?.wallets }
    delete wallets[net]
    await keep({ watched: rest, wallets })
    link.note('the Monero view key is gone from maki desktop (maki still has it)')
  }

  const show = async (i: number): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const r = await link.moneroAddress(network, i)
      if (r.approval === 'approved') {
        setShown({ address: r.address, network, index: i })
        setIndex(i)
      } else {
        setShown(null)
        setProblem(
          r.approval === 'denied'
            ? "You said it doesn't match: don't use the address this computer has."
            : r.approval === 'no match'
              ? 'Add the Monero app first.'
              : `maki: ${r.approval}`
        )
      }
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>Monero</Label>
        <Segmented
          label="Network"
          value={network}
          options={[
            [MoneroNetwork.MONERO, 'Monero'],
            [MoneroNetwork.STAGENET, 'Stagenet']
          ]}
          onChange={(v) => {
            setNetwork(v)
            setShown(null)
            setProblem(null)
          }}
        />
      </div>
      <WalletAppNeeded link={link} apps={apps} id={MONERO_APP} name="Monero" />

      <div className="mt-6 flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-peach/10 text-peach">
          <Glyph name="monero" className="h-7 w-7" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-mono text-[0.95rem] font-bold text-fg">Your Monero wallet</h3>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
            The one a Ledger makes from the same recovery phrase. Receive to its address, or a fresh
            subaddress, once you've compared it on maki's screen. Its 25 backup words, which restore
            it in any Monero wallet, show on maki alone: open Monero there, then Backup words in its
            menu.
          </p>
        </div>
        <Button
          kind="primary"
          glyph="receive"
          disabled={!linked || busy}
          onClick={() => void show(0)}
        >
          {busy ? 'Compare on maki…' : linked ? 'Show on maki' : 'Plug maki in'}
        </Button>
      </div>
      {shown && (
        <div className="mt-4 rounded-xl border border-surface0 bg-crust/60 p-4">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            {shown.index === 0 ? 'Primary address' : `Subaddress ${shown.index}`}, matches maki's
          </div>
          <div className="mt-2 break-all font-mono text-sm text-fg">{shown.address}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              small
              glyph="copy"
              onClick={() => void navigator.clipboard.writeText(shown.address)}
            >
              Copy
            </Button>
            <Button
              small
              glyph="refresh"
              disabled={!linked || busy}
              onClick={() => void show(index + 1)}
            >
              A fresh subaddress
            </Button>
          </div>
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      {kept && !watched && (
        <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-surface0 p-4">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-subtext0">
            <span className="font-semibold text-fg">Watch it here, or in the Monero GUI.</span> maki
            shares the wallet’s view key once you say so on its screen: it finds the wallet’s
            payments and can’t spend them. Spending stays with maki, which shows you each payment
            first.
          </p>
          <Button glyph="eye" disabled={!linked || watching} onClick={() => void watch()}>
            {watching ? 'Say yes on maki…' : linked ? 'Let this computer watch' : 'Plug maki in'}
          </Button>
        </div>
      )}
      {keys && (
        <MoneroWallet
          link={link}
          network={net}
          wire={network}
          keys={keys}
          state={kept?.wallets[net]}
          keep={async (state: WalletState | null) => {
            const now = latest.current ?? { watched: {}, wallets: {} }
            const wallets = { ...now.wallets }
            if (state) wallets[net] = state
            else delete wallets[net]
            await keep({ watched: now.watched, wallets })
          }}
        />
      )}
      {watched && <MoneroGui link={link} network={net} wire={network} watched={watched} />}
      {watched && (
        <div className="mt-4 text-right">
          <button
            className="font-mono text-[0.62rem] text-overlay0 hover:text-subtext0"
            onClick={() => void forget()}
          >
            forget the view key on this computer
          </button>
        </div>
      )}
    </Card>
  )
}
