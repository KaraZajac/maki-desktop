import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import type { ApprovalValue, BtcAccountValue, NetworkValue } from '@shared/protocol'
import {
  BtcWallet,
  CHAIN,
  COIN_WORD,
  EXPLORER,
  EXPLORER_NAME,
  isTest,
  UNIT,
  type BtcAccountInfo,
  type BtcChain,
  type BtcActivity,
  type BtcPlan,
  type BtcWalletState,
  type FeeRates
} from '@shared/btc-wallet'
import { parseUnits, units } from '@shared/tokens'
import { Qr } from './Qr'
import { money, worth } from '@shared/prices'
import { usePrices } from './prices-state'
import { ago, Badge, Button, Field, Glyph, Segmented } from './ui'

/**
 * What each account last looked like, so coming back to the page shows it straight away: by
 * network and descriptor (a test network's descriptor is Bitcoin's and Litecoin's both).
 */
const kept = new Map<string, { state: BtcWalletState; at: number }>()
/** Each account's wallet, which remembers what it's seen of each address between looks. */
const wallets = new Map<string, BtcWallet>()
const keyOf = (info: BtcAccountInfo): string => `${info.network} ${info.descriptor}`
const walletFor = (info: BtcAccountInfo): BtcWallet => {
  let w = wallets.get(keyOf(info))
  if (!w) wallets.set(keyOf(info), (w = new BtcWallet(info, window.maki.bitcoin.esplora)))
  return w
}
/** The symbol prices are kept under: the coin's, whichever network. */
const PRICED: Record<BtcChain, string> = { bitcoin: 'BTC', litecoin: 'LTC' }
/** What an address of each network starts with, as a hint where one goes. */
const STARTS: Record<BtcAccountInfo['network'], string> = {
  bitcoin: 'bc1…',
  test: 'tb1…',
  litecoin: 'ltc1…',
  'litecoin-test': 'tltc1…'
}
/** Older than this, it's looked up again. */
const STALE_MS = 60_000

/** Satoshis as bitcoin (litoshis as litecoin), exactly. */
export const btcAmount = (sats: bigint): string => units(sats, 8)
/** Satoshis, as people count them. */
const satoshis = (sats: bigint): string => `${sats.toLocaleString()} sats`

/** A Bitcoin address in fours, easier to compare by eye; copying it copies it whole. */
export function Grouped({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.match(/.{1,4}/g)!.map((g, i) => (
        <span key={i} className={i % 2 ? 'text-subtext1' : 'text-fg'}>
          {g}
          {/* a gap that isn't a character: selecting the address gets it as it is */}
          <span className="inline-block w-[0.4em]" />
        </span>
      ))}
    </>
  )
}

export function said(approval: ApprovalValue, reason = ''): string {
  switch (approval) {
    case 'refused':
      return `maki won't sign it${reason ? `: ${reason}` : ''}.`
    case 'denied':
      return 'You turned it down on maki.'
    case 'timed out':
      return 'maki stopped waiting for an answer.'
    case 'locked':
      return 'maki is locked: enter its PIN first.'
    case 'no phrase':
      return 'maki has no recovery phrase yet.'
    default:
      return `maki couldn't: ${approval}.`
  }
}

const SPEEDS: [keyof FeeRates | 'custom', string, string][] = [
  ['fastestFee', 'Fast', 'next block'],
  ['halfHourFee', 'Normal', '~30 min'],
  ['hourFee', 'Slow', '~1 hour'],
  ['economyFee', 'Economy', 'hours or more'],
  ['custom', 'Custom', 'your rate']
]

type Stage = 'building' | 'maki' | 'broadcasting'

/**
 * A Bitcoin (or Litecoin) account of maki's as a wallet: its balance, an address to receive at
 * (checked on maki's screen), sending (maki shows the payment, the change and the fee, and signs),
 * and its activity.
 */
export function BitcoinWallet({
  link,
  info,
  network,
  kind
}: {
  link: Link
  info: BtcAccountInfo
  network: NetworkValue
  kind: BtcAccountValue
}): React.JSX.Element {
  const wallet = useMemo(() => walletFor(info), [info])
  const explorer = EXPLORER[info.network]
  const site = EXPLORER_NAME[info.network]
  const unit = UNIT[info.network]
  const chain = CHAIN[info.network]
  const linked = link.state.linked

  const [seen, setSeen] = useState(kept.get(keyOf(info)) ?? null)
  const [looking, setLooking] = useState(false)
  // addresses looked at so far, while looking
  const [looked, setLooked] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [panel, setPanel] = useState<'receive' | 'send' | null>(null)
  const [all, setAll] = useState(false)
  // the waiting payment being sped up, if one is
  const [bumping, setBumping] = useState<string | null>(null)

  const look = async (): Promise<void> => {
    setLooking(true)
    setLooked(0)
    setProblem(null)
    try {
      const state = await wallet.scan(setLooked)
      const now = { state, at: Date.now() }
      kept.set(keyOf(info), now)
      setSeen(now)
    } catch (e) {
      setProblem(`Couldn’t look: ${(e as Error).message}.`)
    } finally {
      setLooking(false)
    }
  }
  useEffect(() => {
    if (!seen || Date.now() - seen.at > STALE_MS) void look()
  }, [wallet])

  const state = seen?.state ?? null
  const balance = state ? state.confirmed + state.pending : null
  const shown = state ? (all ? state.activity : state.activity.slice(0, 6)) : []
  const { currency, prices } = usePrices()
  const test = isTest(info.network)
  const inMoney = (sats: bigint): string | null => {
    const v = currency && worth(prices, PRICED[chain], sats, 8, test)
    return v !== null && v !== undefined && currency ? money(v, currency) : null
  }

  return (
    <div>
      {/* the balance, and what to do with it */}
      <div className="mt-6 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Balance
          </div>
          <div className="mt-1.5 font-mono leading-none text-fg">
            {balance === null ? (
              <span className="text-[2.2rem] font-bold tracking-[-0.04em] text-overlay0">
                {looking ? '…' : '—'}
              </span>
            ) : (
              <>
                <span className="text-[2.4rem] font-bold tracking-[-0.04em]">
                  {btcAmount(balance)}
                </span>
                <span className="ml-2 text-base text-overlay1">{unit}</span>
                {inMoney(balance) && (
                  <span className="ml-3 font-sans text-base text-subtext0">
                    ≈ {inMoney(balance)}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-overlay1">
            {state && state.pending > 0n && (
              <span className="text-yellow">
                {btcAmount(state.pending)} {unit} of it is waiting for a block
              </span>
            )}
            {state && state.pending < 0n && (
              <span className="text-yellow">
                {btcAmount(-state.pending)} {unit} on its way out
              </span>
            )}
            <span>
              {looking
                ? `looking… ${looked ? `${looked} addresses` : ''}`
                : seen
                  ? `as of ${ago(seen.at)}`
                  : ''}
              {state && ` · ${state.coins.length} ${state.coins.length === 1 ? 'coin' : 'coins'}`}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            kind={panel === 'receive' ? 'primary' : 'ghost'}
            glyph="receive"
            disabled={!state}
            onClick={() => setPanel(panel === 'receive' ? null : 'receive')}
          >
            Receive
          </Button>
          <Button
            kind={panel === 'send' ? 'primary' : 'ghost'}
            glyph="send"
            disabled={!state || balance === 0n}
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
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      {state && panel === 'receive' && (
        <Receive
          link={link}
          state={state}
          network={network}
          kind={kind}
          chain={chain}
          explorer={explorer}
          site={site}
          linked={linked}
        />
      )}
      {state && panel === 'send' && (
        <Send
          link={link}
          wallet={wallet}
          state={state}
          network={network}
          chain={chain}
          unit={unit}
          hint={STARTS[info.network]}
          explorer={explorer}
          site={site}
          linked={linked}
          sent={() => {
            // the network has it a moment later
            setTimeout(() => void look(), 2500)
          }}
          close={() => setPanel(null)}
        />
      )}

      {/* activity */}
      <div className={`mt-7 ${state ? '' : 'hidden'}`}>
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Activity
          </h3>
          {state && state.activity.length > 6 && (
            <button
              className="font-mono text-[0.68rem] text-peach hover:text-yellow"
              onClick={() => setAll(!all)}
            >
              {all ? 'Fewer' : `All ${state.activity.length}`}
            </button>
          )}
        </div>
        {state && state.activity.length === 0 && (
          <p className="mt-3 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
            Nothing yet. Receive some {COIN_WORD[chain]} and it shows here.
          </p>
        )}
        <ul className="mt-2 divide-y divide-surface0/70">
          {shown.map((a) => {
            const incoming = a.net > 0n
            return (
              <li key={a.txid} className="py-2.5">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      incoming ? 'bg-green/10 text-green' : 'bg-peach/10 text-peach'
                    }`}
                  >
                    <Glyph name={incoming ? 'receive' : 'send'} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-subtext1">
                      {incoming ? 'Received' : a.net === 0n ? 'Moved' : 'Sent'}
                    </div>
                    <div className="truncate font-mono text-[0.68rem] text-overlay0">
                      {a.txid.slice(0, 10)}…{a.txid.slice(-6)}
                      {!incoming && a.fee > 0n && ` · fee ${satoshis(a.fee)}`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono text-sm ${incoming ? 'text-green' : 'text-fg'}`}>
                      {incoming ? '+' : a.net < 0n ? '−' : ''}
                      {btcAmount(a.net < 0n ? -a.net : a.net)} {unit}
                    </div>
                    <div className="mt-0.5 flex items-center justify-end gap-2 text-[0.68rem] text-overlay1">
                      {a.replaceable && (
                        <button
                          className="font-mono font-bold text-peach hover:text-yellow"
                          onClick={() => setBumping(bumping === a.txid ? null : a.txid)}
                        >
                          speed up
                        </button>
                      )}
                      {a.time === null ? <Badge kind="warn">waiting</Badge> : ago(a.time * 1000)}
                    </div>
                  </div>
                  <button
                    className="rounded-md p-1.5 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
                    title={`See it on ${site}`}
                    aria-label={`See it on ${site}`}
                    onClick={() => void window.maki.openExternal(`${explorer}/tx/${a.txid}`)}
                  >
                    <Glyph name="external" className="h-3.5 w-3.5" />
                  </button>
                </div>
                {bumping === a.txid && (
                  <SpeedUp
                    link={link}
                    wallet={wallet}
                    activity={a}
                    network={network}
                    chain={chain}
                    linked={linked}
                    done={() => {
                      setBumping(null)
                      setTimeout(() => void look(), 2500)
                    }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function Receive({
  link,
  state,
  network,
  kind,
  chain,
  explorer,
  site,
  linked
}: {
  link: Link
  state: BtcWalletState
  network: NetworkValue
  kind: BtcAccountValue
  chain: BtcChain
  explorer: string
  site: string
  linked: boolean
}): React.JSX.Element {
  const address = state.receive.address
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{
    address: string
    approval: ApprovalValue
    same: boolean
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const check = async (): Promise<void> => {
    setChecking(true)
    setChecked(null)
    try {
      const r = await link.btcAddress(network, false, state.receive.index, kind, chain)
      // only an address maki sent back can differ: a timeout, a locked maki or no wallet app
      // sends none, and says so on its own rather than as a different address
      setChecked({ address, approval: r.approval, same: r.address === '' || r.address === address })
    } catch (e) {
      link.note(`couldn't check the address: ${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }
  const verdict = checked?.address === address ? checked : null

  return (
    <div className="rise mt-5 flex flex-wrap gap-6 rounded-xl border border-surface0 bg-crust/40 p-5">
      <Qr text={`${COIN_WORD[chain]}:${address}`} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Your address · #{state.receive.index}
        </div>
        <code className="mt-2 block break-all font-mono text-[1.02rem] leading-relaxed">
          <Grouped text={address} />
        </code>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            small
            glyph={copied ? 'check' : 'copy'}
            onClick={async () => {
              await window.maki.copy(address)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            small
            kind="ghost"
            glyph="chip"
            disabled={!linked || checking}
            onClick={() => void check()}
          >
            {checking ? 'Compare it on maki…' : 'Check it on maki'}
          </Button>
          <Button
            small
            glyph="external"
            onClick={() => void window.maki.openExternal(`${explorer}/address/${address}`)}
          >
            {site}
          </Button>
        </div>
        {verdict && (
          <p
            className={`mt-3 flex items-center gap-2 text-sm ${
              verdict.approval === 'approved' && verdict.same
                ? 'text-green'
                : verdict.approval === 'denied' || !verdict.same
                  ? 'text-red'
                  : 'text-yellow'
            }`}
          >
            <Glyph name={verdict.approval === 'approved' && verdict.same ? 'check' : 'warn'} />
            {!verdict.same
              ? 'maki has a different address for this account: don’t use this one.'
              : verdict.approval === 'approved'
                ? 'You said maki shows the same address. It’s yours.'
                : verdict.approval === 'denied'
                  ? 'You said it doesn’t match: don’t use the address this computer shows.'
                  : said(verdict.approval)}
          </p>
        )}
        <p className="mt-3 max-w-md text-xs leading-relaxed text-overlay1">
          Checking it on maki’s screen means nothing on this computer can have swapped it. Each
          payment gets a fresh address; once this one is used, the next takes its place.
        </p>
      </div>
    </div>
  )
}

function Send({
  link,
  wallet,
  state,
  network,
  chain,
  unit,
  hint,
  explorer,
  site,
  linked,
  sent,
  close
}: {
  link: Link
  wallet: BtcWallet
  state: BtcWalletState
  network: NetworkValue
  chain: BtcChain
  unit: string
  /** what an address starts with */
  hint: string
  explorer: string
  site: string
  linked: boolean
  sent: () => void
  close: () => void
}): React.JSX.Element {
  const { currency, prices } = usePrices()
  const inMoney = (sats: bigint): string | null => {
    const v = currency && worth(prices, PRICED[chain], sats, 8, unit.startsWith('t'))
    return v !== null && v !== undefined && currency ? money(v, currency) : null
  }
  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [everything, setEverything] = useState(false)
  const [rates, setRates] = useState<FeeRates | null>(null)
  const [speed, setSpeed] = useState<keyof FeeRates | 'custom'>('halfHourFee')
  const [custom, setCustom] = useState('')
  const [stage, setStage] = useState<Stage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ txid: string; sent: bigint; fee: bigint } | null>(null)

  useEffect(() => {
    wallet.feeRates().then(setRates, () => setSpeed('custom'))
  }, [wallet])

  const rate = speed === 'custom' ? Number(custom) : (rates?.[speed] ?? 0)
  const amount = everything ? 'all' : parseUnits(amountText, 8)
  const address = to.trim()

  // how it would go, worked out as it's typed
  const plan = useMemo((): { plan: BtcPlan } | { problem: string } | null => {
    if (!address || (!everything && amountText.trim() === '')) return null
    if (amount === null) return { problem: `that isn’t an amount of ${unit}` }
    if (!(rate > 0)) return null
    try {
      return { plan: wallet.plan(state, address, amount, rate) }
    } catch (e) {
      return { problem: (e as Error).message }
    }
  }, [wallet, state, address, amount, amountText, everything, rate, unit])

  const most = useMemo(() => {
    if (!rates && speed !== 'custom') return null
    try {
      // the most that can go to any address like the account's own, at this rate
      return rate > 0 ? wallet.plan(state, state.receive.address, 'all', rate).sent : null
    } catch {
      return null
    }
  }, [wallet, state, rate, rates, speed])

  const go = async (): Promise<void> => {
    if (!plan || !('plan' in plan)) return
    setProblem(null)
    try {
      setStage('building')
      const { psbt, sent: amountSent, fee } = await wallet.send(state, address, amount!, rate)
      setStage('maki')
      const r = await link.btcSign(network, psbt, chain)
      if (!r.signed) {
        setProblem(said(r.approval, r.reason))
        return
      }
      setStage('broadcasting')
      const txid = await wallet.broadcast(r.signed)
      link.note(`sent ${btcAmount(amountSent)} ${unit}: ${txid}`)
      setDone({ txid, sent: amountSent, fee })
      sent()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setStage(null)
    }
  }

  if (done) {
    return (
      <div className="rise mt-5 rounded-xl border border-green/30 bg-green/[0.05] p-5">
        <div className="flex items-center gap-2 text-green">
          <Glyph name="check" className="h-5 w-5" />
          <span className="font-mono text-sm font-bold">
            Sent {btcAmount(done.sent)} {unit}
          </span>
        </div>
        <p className="mt-2 text-sm text-subtext1">
          maki signed it and the network has it. It’s final once it’s in a block, usually within the
          hour at the fee you chose ({satoshis(done.fee)}).
        </p>
        <code className="mt-2 block break-all font-mono text-xs text-overlay1">{done.txid}</code>
        <div className="mt-3 flex gap-2">
          <Button
            small
            glyph="external"
            onClick={() => void window.maki.openExternal(`${explorer}/tx/${done.txid}`)}
          >
            Follow it on {site}
          </Button>
          <Button small onClick={close}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  const busy = stage !== null
  const p = plan && 'plan' in plan ? plan.plan : null

  return (
    <div className="rise mt-5 rounded-xl border border-surface0 bg-crust/40 p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <Field
          label="To"
          placeholder={hint}
          value={to}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
        />
        <div>
          <Field
            label="Amount"
            unit={unit}
            placeholder="0.00"
            inputMode="decimal"
            value={everything ? (p ? btcAmount(p.sent) : '') : amountText}
            disabled={busy || everything}
            onChange={(e) => setAmountText(e.target.value)}
          />
          <label className="mt-1.5 flex items-center gap-2 text-xs text-overlay1">
            <input
              type="checkbox"
              checked={everything}
              disabled={busy}
              onChange={(e) => setEverything(e.target.checked)}
              className="accent-peach"
            />
            Everything{most !== null && `, ${btcAmount(most)} ${unit} after the fee`}
          </label>
        </div>
      </div>

      <div className="mt-4">
        <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Fee
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {SPEEDS.map(([key, name, when]) => {
            const r = key === 'custom' ? null : rates?.[key]
            const chosen = speed === key
            return (
              <button
                key={key}
                disabled={busy || (key !== 'custom' && !rates)}
                onClick={() => setSpeed(key)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  chosen ? 'border-peach bg-peach/10' : 'border-surface1 hover:border-surface2'
                }`}
              >
                <div
                  className={`font-mono text-[0.72rem] font-bold ${chosen ? 'text-peach' : 'text-subtext1'}`}
                >
                  {name}
                </div>
                <div className="mt-0.5 font-mono text-[0.68rem] text-subtext0">
                  {key === 'custom' ? 'sat/vB' : r !== undefined ? `${r} sat/vB` : '…'}
                </div>
                <div className="text-[0.66rem] text-overlay1">{when}</div>
              </button>
            )
          })}
        </div>
        {speed === 'custom' && (
          <Field
            className="mt-3 max-w-[14rem]"
            label="Fee rate"
            unit="sat/vB"
            inputMode="decimal"
            placeholder="2"
            value={custom}
            disabled={busy}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
      </div>

      {/* what maki will show */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-surface0 pt-4">
        <div className="min-w-0 text-sm">
          {p ? (
            <div className="space-y-0.5 font-mono text-[0.78rem] text-subtext1">
              <div>
                <span className="inline-block w-16 text-overlay1">pays</span>
                {btcAmount(p.sent)} {unit}
                {inMoney(p.sent) && <span className="text-overlay0"> ≈ {inMoney(p.sent)}</span>}
              </div>
              <div>
                <span className="inline-block w-16 text-overlay1">fee</span>
                {satoshis(p.fee)}
                <span className="text-overlay0">
                  {' '}
                  · {p.vbytes} vB{inMoney(p.fee) && ` ≈ ${inMoney(p.fee)}`}
                </span>
              </div>
              {p.change > 0n && (
                <div>
                  <span className="inline-block w-16 text-overlay1">change</span>
                  {btcAmount(p.change)} {unit} back to you
                </div>
              )}
            </div>
          ) : plan && 'problem' in plan ? (
            <span className="text-yellow">
              {plan.problem[0].toUpperCase() + plan.problem.slice(1)}.
            </span>
          ) : (
            <span className="text-overlay1">Where to, and how much?</span>
          )}
        </div>
        <Button
          kind="primary"
          glyph="chip"
          disabled={!p || busy || !linked}
          onClick={() => void go()}
        >
          {stage === 'building'
            ? 'Making it…'
            : stage === 'maki'
              ? 'Go through it on maki…'
              : stage === 'broadcasting'
                ? 'Sending…'
                : linked
                  ? 'Review on maki'
                  : 'Plug maki in to send'}
        </Button>
      </div>
      {stage === 'maki' && (
        <p className="mt-3 text-xs text-overlay1">
          maki shows where it goes, the change and the fee. Check the address against the one you
          were given, then approve it there.
        </p>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
    </div>
  )
}

/**
 * A payment still waiting for a block, sent again with a higher fee: the same coins and payments,
 * the extra fee out of its change. maki shows it like any payment.
 */
function SpeedUp({
  link,
  wallet,
  activity,
  network,
  chain,
  linked,
  done
}: {
  link: Link
  wallet: BtcWallet
  activity: BtcActivity
  network: NetworkValue
  chain: BtcChain
  linked: boolean
  done: () => void
}): React.JSX.Element {
  const [rates, setRates] = useState<FeeRates | null>(null)
  const [rate, setRate] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    wallet.feeRates().then(
      (r) => {
        setRates(r)
        // the fastest there is, and at least a little more than it paid
        setRate(String(Math.max(r.fastestFee, Math.ceil((activity.rate ?? 0) + 1))))
      },
      () => setRate(String(Math.ceil((activity.rate ?? 1) * 2)))
    )
  }, [wallet, activity.rate])

  const go = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const { psbt, fee, was } = await wallet.bump(activity.txid, Number(rate))
      const r = await link.btcSign(network, psbt, chain)
      if (!r.signed) {
        setProblem(said(r.approval, r.reason))
        return
      }
      const txid = await wallet.broadcast(r.signed)
      link.note(`sped up: its fee ${satoshis(was)} → ${satoshis(fee)}, now ${txid}`)
      done()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rise mt-2.5 ml-11 rounded-lg border border-surface0 bg-crust/40 p-3.5">
      <p className="text-xs leading-relaxed text-subtext0">
        Send it again with a higher fee: the same payment, the extra fee out of its change back to
        you.
        {activity.rate !== null && ` It pays about ${activity.rate.toFixed(1)} sat/vB now.`}
        {rates && ` The fastest now is ${rates.fastestFee} sat/vB.`}
      </p>
      <div className="mt-2.5 flex flex-wrap items-end gap-3">
        <Field
          className="w-40"
          label="New fee rate"
          unit="sat/vB"
          inputMode="decimal"
          value={rate}
          disabled={busy}
          onChange={(e) => setRate(e.target.value)}
        />
        <Button
          small
          kind="primary"
          glyph="chip"
          disabled={!linked || busy || !(Number(rate) > 0)}
          onClick={() => void go()}
        >
          {busy ? 'Go through it on maki…' : linked ? 'Review on maki' : 'Plug maki in'}
        </Button>
      </div>
      {problem && (
        <p className="mt-2 text-sm text-yellow">
          {problem[0].toUpperCase() + problem.slice(1)}
          {problem.endsWith('.') ? '' : '.'}
        </p>
      )}
    </div>
  )
}
