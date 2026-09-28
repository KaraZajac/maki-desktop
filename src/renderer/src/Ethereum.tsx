import { useEffect, useState } from 'react'
import type { Link } from '@shared/link'
import { WALLET_SITE } from '@shared/eth-wallet'
import { EthereumWallet } from './EthereumWallet'
import { Button, Card, Glyph, Label } from './ui'

/**
 * maki's Ethereum account: a wallet here once the owner connects maki desktop to it on maki, and
 * the sites connected to it through the maki extension. Connecting and signing are asked on maki.
 */
export function Ethereum({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [sites, setSites] = useState<{ site: string; address: string; network: string }[] | null>(
    null
  )
  const [connecting, setConnecting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // a connection is a line in the log: look again when there's news
  useEffect(() => {
    void link.ethereum.sites().then(setSites)
  }, [link, link.log.length])

  const mine = sites?.find((s) => s.site === WALLET_SITE) ?? null
  const others = sites?.filter((s) => s.site !== WALLET_SITE) ?? []

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setProblem(null)
    try {
      await link.ethWallet.connect()
      link.note('maki desktop connected to your Ethereum account')
    } catch (e) {
      const m = (e as Error).message
      setProblem(/rejected|denied/i.test(m) ? 'You turned it down on maki.' : m)
    } finally {
      setConnecting(false)
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-3">
        <Label>Ethereum</Label>
        {mine && (
          <Button
            small
            onClick={async () => {
              await link.ethWallet.disconnect()
              link.note('maki desktop disconnected from your Ethereum account')
            }}
          >
            Disconnect
          </Button>
        )}
      </div>

      {sites === null ? null : mine ? (
        <EthereumWallet key={mine.address} link={link} address={mine.address} />
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-lavender/10 text-lavender">
            <Glyph name="ethereum" className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[0.95rem] font-bold text-fg">
              Your Ethereum account, here
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
              Connect maki desktop to the account the way a site connects: maki asks you first. Then
              see what it holds on Ethereum, Base, Optimism, Arbitrum and Polygon, and send from it,
              each payment shown on maki and signed there.
            </p>
          </div>
          <Button
            kind="primary"
            glyph="chip"
            disabled={!linked || connecting}
            onClick={() => void connect()}
          >
            {connecting ? 'Approve on maki…' : linked ? 'Connect on maki' : 'Plug maki in'}
          </Button>
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      <div className="mt-7 border-t border-surface0 pt-4">
        <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Sites
        </h3>
        <p className="mt-1.5 text-xs text-overlay1">
          Sites use the account through the maki extension. maki asks you before a site sees it, and
          shows every message and transaction before it signs.
        </p>
        {others.length === 0 ? (
          <p className="mt-3 text-sm text-overlay1">No site is connected.</p>
        ) : (
          <ul className="mt-2 divide-y divide-surface0/70">
            {others.map((s) => (
              <li key={s.site} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Glyph name="globe" className="h-3.5 w-3.5 text-overlay1" />
                  <span className="truncate text-subtext1">{s.site}</span>
                  <span className="text-xs text-overlay1">· {s.network}</span>
                </span>
                <Button
                  small
                  onClick={async () => {
                    await link.ethereum.disconnect(s.site)
                    link.note(`${s.site} disconnected from your Ethereum account`)
                  }}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-5 text-xs leading-relaxed text-overlay0">
        Balances and payments go through public servers (
        {link.ethereum.networks.map((n) => n.name).join(', ')}), which see the account’s address and
        this computer’s IP address.
      </p>
    </Card>
  )
}
