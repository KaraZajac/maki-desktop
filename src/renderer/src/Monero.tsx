import { useState } from 'react'
import type { Link } from '@shared/link'
import { MONERO_APP, MoneroNetwork, type MoneroNetworkValue } from '@shared/wallet-apps'
import type { Apps } from './apps-state'
import { Button, Card, Glyph, Label, Segmented } from './ui'
import { WalletAppNeeded } from './WalletAppNeeded'

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
    </Card>
  )
}
