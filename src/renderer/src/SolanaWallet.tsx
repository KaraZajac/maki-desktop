import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import { money, worth } from '@shared/prices'
import { isAddress, type SolNetwork } from '@shared/solana'
import type { SolHolding, SolNetworkHoldings, SolToken } from '@shared/sol-wallet'
import { parseUnits, units } from '@shared/tokens'
import { usePrices } from './prices-state'
import { Qr } from './Qr'
import { ago, Button, Field, Glyph, readable, Segmented } from './ui'

/**
 * What the account last held, so coming back to the page shows it straight away (and the Portfolio
 * needn't ask again).
 */
export let kept: { address: string; holdings: SolNetworkHoldings[]; at: number } | null = null
const STALE_MS = 60_000

/** What a token's called here: its symbol if maki knows it, else its mint, shortened. */
export const tokenName = (t: SolToken | null): string =>
  t === null ? 'SOL' : (t.symbol ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`)

const decimalsOf = (t: SolToken | null): number => (t ? t.decimals : 9)
const keyOf = (h: SolHolding): string => h.token?.mint ?? 'sol'

const page = (n: SolNetwork, path: string): string => `${n.explorer}/${path}${n.explorerQuery}`

/**
 * maki's Solana account as a wallet: what it holds on Solana and its devnet (SOL, and its tokens),
 * an address to receive at, and sending, which maki shows (the token, the amount, whose account it
 * goes to, the most the fee can be) and signs.
 */
export function SolanaWallet({
  link,
  address
}: {
  link: Link
  address: string
}): React.JSX.Element {
  const wallet = link.solWallet
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
  const value = (h: SolHolding, n: SolNetworkHoldings): string | null => {
    const v =
      h.token && h.token.symbol === null
        ? null
        : worth(prices, tokenName(h.token), h.amount, decimalsOf(h.token), n.network.test)
    return v !== null && currency ? money(v, currency) : null
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
              {address.slice(0, 6)}…{address.slice(-6)}
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
              Your address
            </div>
            <code className="mt-2 block break-all font-mono text-[1.02rem] leading-relaxed text-fg">
              {address}
            </code>
            <p className="mt-3 max-w-md text-xs leading-relaxed text-overlay1">
              maki showed you this address when you connected maki desktop to the account. SOL and
              every token come to it: a token lands in the account’s own account for that token,
              which the one sending opens if it isn’t yet.
            </p>
          </div>
        </div>
      )}
      {/* a balance that can't be read now leaves nothing to send from: no panel, rather than a broken one */}
      {panel === 'send' && all && some.length > 0 && (
        <Send
          link={link}
          account={address}
          holdings={some}
          linked={linked}
          sent={() => setTimeout(() => void look(), 4000)}
          close={() => setPanel(null)}
        />
      )}

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
                    key={n.network.chain}
                    className="rounded-xl border border-surface0 bg-crust/30 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[0.72rem] font-bold text-subtext1">
                        {n.network.name}
                      </span>
                      <button
                        className="rounded-md p-1 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
                        title={`See it on ${new URL(n.network.explorer).host}`}
                        aria-label={`See it on ${new URL(n.network.explorer).host}`}
                        onClick={() =>
                          void window.maki.openExternal(page(n.network, `address/${address}`))
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
                            key={keyOf(h)}
                            className="flex items-baseline justify-between gap-3 font-mono"
                            title={`${units(h.amount, decimalsOf(h.token))} ${tokenName(h.token)}${h.token ? `\nmint ${h.token.mint}` : ''}`}
                          >
                            <span
                              className={`text-[1.05rem] ${h.amount > 0n ? 'text-fg' : 'text-overlay0'}`}
                            >
                              {readable(h.amount, decimalsOf(h.token))}
                            </span>
                            <span className="text-xs text-overlay1">
                              {value(h, n) !== null && (
                                <span className="mr-2 font-sans text-subtext0">
                                  ≈ {value(h, n)}
                                </span>
                              )}
                              {tokenName(h.token)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
                Nothing yet, on Solana or its devnet.
              </p>
            )}
            {some.length > 0 && none.length > 0 && (
              <p className="mt-3 text-xs text-overlay1">
                Nothing on {none.map((n) => n.network.name).join(', ')}.
              </p>
            )}
            {unreachable.map((n) => (
              <p key={n.network.chain} className="mt-2 text-xs text-yellow">
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
  account,
  holdings,
  linked,
  sent,
  close
}: {
  link: Link
  account: string
  holdings: SolNetworkHoldings[]
  linked: boolean
  sent: () => void
  close: () => void
}): React.JSX.Element {
  const [chain, setChain] = useState(holdings[0].network.chain)
  // the network chosen, if its balance could still be read the last time it was looked at: if
  // not, nothing is sent until another is chosen, rather than quietly sending on another
  const chosen = holdings.find((n) => n.network.chain === chain)
  const on = chosen ?? holdings[0]
  const network = on.network
  const [asset, setAsset] = useState('sol')
  const held = on.holdings.filter((h) => h.amount > 0n)
  const holding = held.find((h) => keyOf(h) === asset) ?? held[0]
  const token = holding?.token ?? null
  const decimals = decimalsOf(token)
  const symbol = tokenName(token)
  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ signature: string; what: string; network: SolNetwork } | null>(
    null
  )

  useEffect(() => setAsset('sol'), [chain])

  const amount = parseUnits(amountText, decimals)
  const address = to.trim()
  const check = useMemo((): string | null => {
    if (address && !isAddress(address))
      return 'That isn’t a Solana address, or a letter of it is wrong.'
    if (address === account) return 'That’s this account.'
    if (amountText.trim() && amount === null) return `That isn’t an amount of ${symbol}.`
    if (amount !== null && holding && amount > holding.amount)
      return `The account has ${units(holding.amount, decimals)} ${symbol}.`
    return null
  }, [address, account, amountText, amount, holding, decimals, symbol])
  const ready =
    !!chosen && !!holding && isAddress(address) && amount !== null && amount > 0n && check === null

  const go = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const signature = await link.solWallet.send(network, account, address, amount!, token)
      const what = `${units(amount!, decimals)} ${symbol}`
      link.note(`sent ${what} on ${network.name}: ${signature}`)
      setDone({ signature, what, network })
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
          maki signed it and the network has it; it’s final in a few seconds.
        </p>
        <code className="mt-2 block break-all font-mono text-xs text-overlay1">
          {done.signature}
        </code>
        <div className="mt-3 flex gap-2">
          <Button
            small
            glyph="external"
            onClick={() =>
              void window.maki.openExternal(page(done.network, `tx/${done.signature}`))
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
              options={holdings.map((n) => [n.network.chain, n.network.name])}
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
              value={holding ? keyOf(holding) : 'sol'}
              disabled={busy}
              options={held.map((h) => [keyOf(h), tokenName(h.token)])}
              onChange={setAsset}
            />
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_16rem]">
        <Field
          label="To"
          placeholder="their Solana address"
          value={to}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
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
          {!chosen ? (
            <span className="text-yellow">
              That network’s balance couldn’t be read just now: choose one again.
            </span>
          ) : check ? (
            <span className="text-yellow">{check}</span>
          ) : ready ? (
            <span className="text-subtext1">
              maki shows{' '}
              {token
                ? 'the token, the amount, whose account it goes to'
                : 'the amount, where it goes'}{' '}
              and the most the fee can be (SOL, on {network.name}).
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
