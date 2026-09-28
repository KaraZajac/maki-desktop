import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import type { EthNetwork } from '@shared/ethereum'
import { isAddress, isEnsName, type Holding, type NetworkHoldings } from '@shared/eth-wallet'
import { money, worth } from '@shared/prices'
import { usePrices } from './prices-state'
import { parseUnits, units, type Token } from '@shared/tokens'
import { Qr } from './Qr'
import { ago, Button, Field, Glyph, readable, Segmented } from './ui'

/** What the account last held, so coming back to the page shows it straight away. */
let kept: { address: string; holdings: NetworkHoldings[]; at: number } | null = null
const STALE_MS = 60_000

/** An amount of a coin or a token, exactly, with its symbol. */
export const amountOf = (amount: bigint, token: Token | null, network: EthNetwork): string =>
  `${units(amount, token ? token.decimals : 18)} ${token ? token.symbol : network.unit}`

/**
 * maki's Ethereum account as a wallet: what it holds on each network (its coin, and the tokens maki
 * knows), an address to receive at, and sending, which maki shows (token amounts spelled out) and
 * signs.
 */
export function EthereumWallet({
  link,
  address
}: {
  link: Link
  address: string
}): React.JSX.Element {
  const wallet = link.ethWallet
  const linked = link.state.linked
  const [seen, setSeen] = useState(kept?.address === address ? kept : null)
  const [looking, setLooking] = useState(false)
  const [panel, setPanel] = useState<'receive' | 'send' | null>(null)
  const [copied, setCopied] = useState(false)

  const look = async (): Promise<void> => {
    setLooking(true)
    try {
      const holdings = await wallet.holdings(address)
      kept = { address, holdings, at: Date.now() }
      setSeen(kept)
    } finally {
      setLooking(false)
    }
  }
  useEffect(() => {
    if (!seen || Date.now() - seen.at > STALE_MS) void look()
  }, [address])

  const all = seen?.holdings ?? null
  const { currency, prices } = usePrices()
  const worthOf = (h: Holding, n: NetworkHoldings): number | null =>
    worth(
      prices,
      h.token ? h.token.symbol : n.network.unit,
      h.amount,
      h.token ? h.token.decimals : 18,
      n.network.test
    )
  const value = (h: Holding, n: NetworkHoldings): string | null => {
    const v = worthOf(h, n)
    return v !== null && currency ? money(v, currency) : null
  }
  // a network's holdings together, of those with a price
  const total = (n: NetworkHoldings): string | null => {
    const vs = n.holdings.map((h) => worthOf(h, n)).filter((v): v is number => v !== null)
    return vs.length > 1 && currency
      ? money(
          vs.reduce((a, b) => a + b, 0),
          currency
        )
      : null
  }
  const some = all?.filter((n) => n.holdings.some((h) => h.amount > 0n)) ?? []
  const none =
    all?.filter((n) => n.problem === null && !n.holdings.some((h) => h.amount > 0n)) ?? []
  const unreachable = all?.filter((n) => n.problem !== null) ?? []

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Account
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="truncate font-mono text-[1.05rem] text-fg" title={address}>
              {address.slice(0, 8)}…{address.slice(-6)}
            </code>
            <button
              className="rounded-md p-1 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
              title="Copy the address"
              aria-label="Copy the address"
              onClick={async () => {
                await window.maki.copy(address)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              <Glyph name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 text-xs text-overlay1">
            {looking ? 'looking…' : seen ? `as of ${ago(seen.at)}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            kind={panel === 'receive' ? 'primary' : 'ghost'}
            glyph="receive"
            onClick={() => setPanel(panel === 'receive' ? null : 'receive')}
          >
            Receive
          </Button>
          <Button
            kind={panel === 'send' ? 'primary' : 'ghost'}
            glyph="send"
            disabled={some.length === 0}
            onClick={() => setPanel(panel === 'send' ? null : 'send')}
          >
            Send
          </Button>
          <Button
            glyph="refresh"
            aria-label="Look again"
            title="Look again"
            disabled={looking}
            onClick={() => void look()}
          />
        </div>
      </div>

      {panel === 'receive' && (
        <div className="rise mt-5 flex flex-wrap gap-6 rounded-xl border border-surface0 bg-crust/40 p-5">
          <Qr text={address} />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
              Your address, on every network
            </div>
            <code className="mt-2 block break-all font-mono text-[1.02rem] leading-relaxed text-fg">
              {address}
            </code>
            <p className="mt-3 max-w-md text-xs leading-relaxed text-overlay1">
              maki showed you this address when you connected maki desktop to the account. It’s the
              same on Ethereum, Base, Optimism, Arbitrum and Polygon: have whoever pays you say
              which network they send on.
            </p>
          </div>
        </div>
      )}
      {panel === 'send' && all && (
        <Send
          link={link}
          holdings={some}
          linked={linked}
          sent={() => setTimeout(() => void look(), 4000)}
          close={() => setPanel(null)}
        />
      )}

      {/* what it holds */}
      <div className="mt-7">
        <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Holdings
        </h3>
        {all === null ? (
          <p className="mt-3 text-sm text-overlay1">{looking ? 'Asking each network…' : '—'}</p>
        ) : (
          <>
            {some.length > 0 ? (
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {some.map((n) => (
                  <div
                    key={String(n.network.chainId)}
                    className="rounded-xl border border-surface0 bg-crust/30 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[0.72rem] font-bold text-subtext1">
                        {n.network.name}
                        {total(n) !== null && (
                          <span className="ml-2 font-sans font-normal text-overlay1">
                            ≈ {total(n)}
                          </span>
                        )}
                      </span>
                      <button
                        className="rounded-md p-1 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
                        title={`See it on ${new URL(n.network.explorer).host}`}
                        aria-label={`See it on ${new URL(n.network.explorer).host}`}
                        onClick={() =>
                          void window.maki.openExternal(`${n.network.explorer}/address/${address}`)
                        }
                      >
                        <Glyph name="external" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {n.holdings
                        .filter((h) => h.amount > 0n || h.token === null)
                        .map((h) => (
                          <li
                            key={h.token?.contract ?? 'coin'}
                            className="flex items-baseline justify-between gap-3 font-mono"
                            title={amountOf(h.amount, h.token, n.network)}
                          >
                            <span
                              className={`text-[1.05rem] ${h.amount > 0n ? 'text-fg' : 'text-overlay0'}`}
                            >
                              {readable(h.amount, h.token ? h.token.decimals : 18)}
                            </span>
                            <span className="text-xs text-overlay1">
                              {value(h, n) !== null && (
                                <span className="mr-2 font-sans text-subtext0">
                                  ≈ {value(h, n)}
                                </span>
                              )}
                              {h.token ? h.token.symbol : n.network.unit}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
                Nothing yet, on any network maki desktop knows.
              </p>
            )}
            {some.length > 0 && none.length > 0 && (
              <p className="mt-3 text-xs text-overlay1">
                Nothing on {none.map((n) => n.network.name).join(', ')}.
              </p>
            )}
            {unreachable.map((n) => (
              <p key={String(n.network.chainId)} className="mt-2 text-xs text-yellow">
                Couldn’t reach {n.network.name}: {n.problem}
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function Send({
  link,
  holdings,
  linked,
  sent,
  close
}: {
  link: Link
  holdings: NetworkHoldings[]
  linked: boolean
  sent: () => void
  close: () => void
}): React.JSX.Element {
  const [chain, setChain] = useState(String(holdings[0].network.chainId))
  const on = holdings.find((n) => String(n.network.chainId) === chain) ?? holdings[0]
  const network = on.network
  const [asset, setAsset] = useState('coin')
  const held = on.holdings.filter((h) => h.amount > 0n)
  const holding = held.find((h) => (h.token?.contract ?? 'coin') === asset) ?? held[0]
  const token = holding?.token ?? null
  const decimals = token ? token.decimals : 18
  const symbol = token ? token.symbol : network.unit
  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ hash: string; what: string; network: EthNetwork } | null>(null)

  // another network: its coin, to start with
  useEffect(() => setAsset('coin'), [chain])

  const amount = parseUnits(amountText, decimals)
  const typed = to.trim()
  // an ENS name, looked up as it's typed: where it points now
  const name = isEnsName(typed.toLowerCase()) ? typed.toLowerCase() : null
  const [named, setNamed] = useState<{ name: string; address: string | null } | null>(null)
  useEffect(() => {
    if (!name) return
    let gone = false
    const soon = setTimeout(() => {
      link.ethWallet.resolve(name).then(
        (address) => !gone && setNamed({ name, address }),
        () => !gone && setNamed({ name, address: null })
      )
    }, 400)
    return () => {
      gone = true
      clearTimeout(soon)
    }
  }, [link, name])
  const looked = name && named?.name === name ? named : null
  const address = name ? (looked?.address ?? '') : typed
  const check = useMemo((): string | null => {
    if (name && looked && !looked.address) return `${name} doesn’t point to an address.`
    if (!name && address && !isAddress(address))
      return 'That isn’t an address, or a letter of it is wrong.'
    if (amountText.trim() && amount === null) return `That isn’t an amount of ${symbol}.`
    if (amount !== null && holding && amount > holding.amount)
      return `The account has ${units(holding.amount, decimals)} ${symbol}.`
    return null
  }, [name, looked, address, amountText, amount, holding, decimals, symbol])
  const ready = !!holding && isAddress(address) && amount !== null && amount > 0n && check === null

  const go = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const hash = await link.ethWallet.send(network, address, amount!, token)
      if (name) link.note(`${name} was ${address} when it was paid`)
      const what = `${units(amount!, decimals)} ${symbol}`
      link.note(`sent ${what} on ${network.name}: ${hash}`)
      setDone({ hash, what, network })
      sent()
    } catch (e) {
      const m = (e as Error).message
      setProblem(/rejected|denied/i.test(m) ? 'You turned it down on maki.' : m)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rise mt-5 rounded-xl border border-green/30 bg-green/[0.05] p-5">
        <div className="flex items-center gap-2 text-green">
          <Glyph name="check" className="h-5 w-5" />
          <span className="font-mono text-sm font-bold">
            Sent {done.what} on {done.network.name}
          </span>
        </div>
        <p className="mt-2 text-sm text-subtext1">
          maki signed it and the network has it; it’s final in a block or two.
        </p>
        <code className="mt-2 block break-all font-mono text-xs text-overlay1">{done.hash}</code>
        <div className="mt-3 flex gap-2">
          <Button
            small
            glyph="external"
            onClick={() =>
              void window.maki.openExternal(`${done.network.explorer}/tx/${done.hash}`)
            }
          >
            Follow it on {new URL(done.network.explorer).host}
          </Button>
          <Button small onClick={close}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rise mt-5 rounded-xl border border-surface0 bg-crust/40 p-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Network
          </div>
          <div className="mt-1.5">
            <Segmented
              label="Network"
              value={chain}
              disabled={busy}
              options={holdings.map((n) => [String(n.network.chainId), n.network.name])}
              onChange={setChain}
            />
          </div>
        </div>
        <div>
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            What
          </div>
          <div className="mt-1.5">
            <Segmented
              label="What to send"
              value={holding ? (holding.token?.contract ?? 'coin') : 'coin'}
              disabled={busy}
              options={held.map((h) => [
                h.token?.contract ?? 'coin',
                h.token ? h.token.symbol : network.unit
              ])}
              onChange={setAsset}
            />
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_16rem]">
        <Field
          label="To"
          placeholder="0x… or name.eth"
          value={to}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
          hint={
            name ? (
              looked?.address ? (
                <>
                  → <span className="font-mono text-subtext1">{looked.address}</span>, the address
                  maki will show you
                </>
              ) : looked ? null : (
                'looking it up…'
              )
            ) : undefined
          }
        />
        <div>
          <Field
            label="Amount"
            unit={symbol}
            placeholder="0.00"
            inputMode="decimal"
            value={amountText}
            disabled={busy}
            onChange={(e) => setAmountText(e.target.value)}
          />
          {holding && (
            <div className="mt-1.5 flex items-center justify-between text-xs text-overlay1">
              <span>
                has {units(holding.amount, decimals)} {symbol}
              </span>
              {token && (
                <button
                  className="font-mono text-peach hover:text-yellow"
                  disabled={busy}
                  onClick={() => setAmountText(units(holding.amount, decimals))}
                >
                  all of it
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-surface0 pt-4">
        <p className="min-w-0 flex-1 text-sm">
          {check ? (
            <span className="text-yellow">{check}</span>
          ) : ready ? (
            <span className="text-subtext1">
              maki shows {token ? 'the token, the amount' : 'the amount'}, where it goes and the
              most the fee can be ({network.unit}, on {network.name}).
            </span>
          ) : (
            <span className="text-overlay1">Where to, and how much?</span>
          )}
        </p>
        <Button
          kind="primary"
          glyph="chip"
          disabled={!ready || busy || !linked}
          onClick={() => void go()}
        >
          {busy ? 'Go through it on maki…' : linked ? 'Review on maki' : 'Plug maki in to send'}
        </Button>
      </div>
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
    </div>
  )
}
