import { useEffect, useMemo, useRef, useState } from 'react'
import { hex } from '@scure/base'
import type { Link } from '@shared/link'
import type { ViewWallet } from '@shared/monero/cold'
import { MoneroNode } from '@shared/monero/node'
import { decodeSigned, encodeRequest } from '@shared/monero/request'
import { planPayment, type Plan } from '@shared/monero/send'
import { newWallet, Wallet, type WalletState } from '@shared/monero/wallet'
import {
  decodeAddress,
  encodeAddress,
  formatXmr,
  type Network,
  parseXmr,
  subaddressKeys
} from '@shared/monero/xmr'
import { money, worth } from '@shared/prices'
import type { MoneroNetworkValue } from '@shared/wallet-apps'
import { Grouped, said } from './BitcoinWallet'
import { ago, readable } from './format'
import { usePrices } from './prices-state'
import { Badge, Button, Field, Glyph, Segmented } from './ui'

/** Your own node's address, on each network, as monerod listens by default. */
const OWN_NODE: Record<Network, string> = {
  mainnet: 'http://127.0.0.1:18081',
  testnet: 'http://127.0.0.1:28081',
  stagenet: 'http://127.0.0.1:38081'
}
const UNIT: Record<Network, string> = { mainnet: 'XMR', testnet: 'tXMR', stagenet: 'sXMR' }
const SPEEDS: [number, string][] = [
  [1, 'Slow'],
  [2, 'Normal'],
  [3, 'Fast'],
  [4, 'Fastest']
]
/** How often to look for new blocks while the page is open. */
const EVERY_MS = 60_000

const nodeAt = (url: string): MoneroNode =>
  new MoneroNode((path, body) => window.maki.monero.node(url, path, body))

interface Activity {
  txid: string
  /** what the wallet gained (negative: paid out, fee and all) */
  net: bigint
  fee: bigint
  height: number | null
  at: number | null
}

/** What each transaction did to the wallet, newest first. */
function activity(state: WalletState): Activity[] {
  const by = new Map<string, Activity>()
  const one = (txid: string): Activity => {
    let a = by.get(txid)
    if (!a) by.set(txid, (a = { txid, net: 0n, fee: 0n, height: null, at: null }))
    return a
  }
  for (const o of state.outputs) {
    const a = one(o.txid)
    a.net += BigInt(o.amount)
    a.height = o.height
    if (o.spent?.txid) {
      const s = one(o.spent.txid)
      s.net -= BigInt(o.amount)
      if (o.spent.height !== null) s.height = o.spent.height
    }
  }
  for (const s of state.sent) {
    const a = one(s.txid)
    a.fee = BigInt(s.fee)
    a.at = s.at
    if (s.height !== undefined) a.height = s.height
    // its change, until a block has it and it's among the outputs
    if (!state.outputs.some((o) => o.txid === s.txid)) a.net += BigInt(s.change)
  }
  return [...by.values()]
    .filter((a) => a.txid !== '')
    .sort((x, y) => (y.height ?? Infinity) - (x.height ?? Infinity))
}

/**
 * maki's Monero wallet, kept here: the chain scanned with the view key maki shared (the node
 * never sees it), the balance, a fresh subaddress to receive to (checked on maki), and sending,
 * which maki makes and signs once you've gone through it on its screen.
 */
export function MoneroWallet({
  link,
  network,
  wire,
  keys,
  state,
  keep
}: {
  link: Link
  network: Network
  wire: MoneroNetworkValue
  keys: ViewWallet
  state: WalletState | undefined
  keep: (state: WalletState | null) => Promise<void>
}): React.JSX.Element {
  const unit = UNIT[network]
  const linked = link.state.linked
  const [node, setNode] = useState(OWN_NODE[network])
  const [from, setFrom] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [panel, setPanel] = useState<'receive' | 'send' | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { currency, prices } = usePrices()

  // one wallet while the node and restore height stay: it keeps its state up to date itself, and
  // each save hands the page a copy
  const wallet = useMemo(
    () => (state ? new Wallet(keys, state, nodeAt(state.node)) : null),
    [state?.node, state?.restoreHeight, keys]
  )
  const busy = useRef(false)

  /** Scan to the node's height, then ask maki for the key images of what it found. */
  const sync = async (): Promise<void> => {
    if (!wallet || busy.current) return
    busy.current = true
    setSyncing(true)
    setProblem(null)
    try {
      await wallet.sync((scanned, h) => {
        setProgress([scanned - wallet.state.restoreHeight, h - wallet.state.restoreHeight])
        setHeight(h)
      })
      // what the scan found is kept whatever maki says next
      await keep({ ...wallet.state })
      const need = wallet.withoutKeyImages()
      if (need.length > 0 && link.state.linked) {
        const r = await link.moneroKeyImages(
          need.map((o) => ({
            txKey: hex.decode(o.txKey),
            index: BigInt(o.index),
            major: o.major,
            minor: o.minor,
            key: hex.decode(o.key)
          }))
        )
        if (r.approval === 'approved') {
          await wallet.learnKeyImages(
            need.map((o, i) => ({ key: o.key, image: hex.encode(r.images[i].image) }))
          )
          await keep({ ...wallet.state })
        }
      }
    } catch (e) {
      setProblem(`Couldn’t look: ${(e as Error).message}.`)
    } finally {
      busy.current = false
      setSyncing(false)
    }
  }
  useEffect(() => {
    void sync()
    const t = setInterval(() => void sync(), EVERY_MS)
    return () => clearInterval(t)
  }, [wallet])

  if (!state || !wallet) {
    const start = async (): Promise<void> => {
      setProblem(null)
      try {
        const info = await nodeAt(node).info()
        const want = { mainnet: 'mainnet', testnet: 'testnet', stagenet: 'stagenet' }[network]
        // a regtest chain (fakechain) takes mainnet's addresses
        if (info.nettype !== want && !(network === 'mainnet' && info.nettype === 'fakechain')) {
          throw new Error(`that node is on ${info.nettype}, not ${want}`)
        }
        const h = from.trim() === '' ? info.height : Number(from)
        if (!Number.isInteger(h) || h < 0 || h > info.height)
          throw new Error('a restore height is a block from 0 to the chain’s height')
        await keep(newWallet(node.replace(/\/$/, ''), h))
      } catch (e) {
        setProblem((e as Error).message)
      }
    }
    return (
      <div className="mt-6 rounded-xl border border-surface0 p-5">
        <h3 className="font-mono text-[0.95rem] font-bold text-fg">This wallet, here</h3>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-subtext0">
          maki desktop finds the wallet’s payments itself, with the view key, in the blocks a Monero
          node gives it: your own node sees nothing of it; a remote one sees this computer’s address
          and what it asks for, never the view key. Blocks before the restore height are skipped: a
          new wallet starts at the chain’s height now.
        </p>
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-[1fr_12rem]">
          <Field
            label="Node"
            value={node}
            onChange={(e) => setNode(e.target.value)}
            placeholder={OWN_NODE[network]}
          />
          <Field
            label="Restore height"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="now"
          />
        </div>
        <div className="mt-4">
          <Button kind="primary" glyph="refresh" onClick={() => void start()}>
            Start
          </Button>
        </div>
        {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
      </div>
    )
  }

  const chain = height ?? state.scanned
  const b = wallet.balance(chain)
  const inMoney = (piconero: bigint): string | null => {
    const v = currency && worth(prices, 'XMR', piconero, 12, network !== 'mainnet')
    return v !== null && v !== undefined && currency ? money(v, currency) : null
  }
  const acts = activity(state)
  const shown = showAll ? acts : acts.slice(0, 6)
  const noImages = wallet.withoutKeyImages().filter((o) => !o.spent).length

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Balance
          </div>
          <div className="mt-1.5 font-mono leading-none text-fg">
            <span
              className="text-[2.4rem] font-bold tracking-[-0.04em]"
              title={`${formatXmr(b.total)} ${unit}`}
            >
              {readable(b.total, 12)}
            </span>
            <span className="ml-2 text-base text-overlay1">{unit}</span>
            {inMoney(b.total) && (
              <span className="ml-3 font-sans text-base text-subtext0">≈ {inMoney(b.total)}</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-overlay1">
            {b.pending > 0n && (
              <span className="text-yellow">
                {readable(b.pending, 12)} {unit} of it can be spent in a few blocks
              </span>
            )}
            <span>
              {syncing && progress
                ? `looking… ${progress[0]} of ${progress[1]} blocks`
                : `block ${state.scanned.toLocaleString()}`}
              {` · ${state.outputs.filter((o) => !o.spent).length} outputs`}
            </span>
            {noImages > 0 && (
              <span title="Spends made elsewhere, by another wallet of the same phrase, show once maki has made its key images.">
                {linked ? '' : 'plug maki in to see what’s spent elsewhere'}
              </span>
            )}
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
            disabled={b.unlocked === 0n}
            onClick={() => setPanel(panel === 'send' ? null : 'send')}
          >
            Send
          </Button>
          <Button
            glyph="refresh"
            aria-label="Look again"
            title="Look again"
            disabled={syncing}
            onClick={() => void sync()}
          />
        </div>
      </div>
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      {panel === 'receive' && (
        <Receive link={link} wire={wire} wallet={wallet} keep={keep} linked={linked} />
      )}
      {panel === 'send' && (
        <Send
          link={link}
          wire={wire}
          network={network}
          unit={unit}
          wallet={wallet}
          unlocked={b.unlocked}
          linked={linked}
          done={async () => {
            await keep({ ...wallet.state })
            setTimeout(() => void sync(), 2500)
          }}
        />
      )}

      <div className="mt-7">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Activity
          </h3>
          {acts.length > 6 && (
            <button
              className="font-mono text-[0.68rem] text-peach hover:text-yellow"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Fewer' : `All ${acts.length}`}
            </button>
          )}
        </div>
        {acts.length === 0 && (
          <p className="mt-3 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
            Nothing yet. Receive some monero and it shows here.
          </p>
        )}
        <ul className="mt-2 divide-y divide-surface0/70">
          {shown.map((a) => {
            const incoming = a.net > 0n
            return (
              <li key={a.txid} className="flex items-center gap-3 py-2.5">
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
                    {a.fee > 0n && ` · fee ${formatXmr(a.fee)} ${unit}`}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-mono text-sm ${incoming ? 'text-green' : 'text-fg'}`}>
                    {incoming ? '+' : a.net < 0n ? '−' : ''}
                    {readable(a.net < 0n ? -a.net : a.net, 12)} {unit}
                  </div>
                  <div className="mt-0.5 text-[0.68rem] text-overlay1">
                    {a.height === null ? (
                      <Badge kind="warn">waiting</Badge>
                    ) : a.at ? (
                      ago(a.at)
                    ) : (
                      `block ${a.height.toLocaleString()}`
                    )}
                  </div>
                </div>
                <button
                  className="rounded-md p-1.5 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
                  title="Copy the transaction's ID"
                  aria-label="Copy the transaction's ID"
                  onClick={() => void window.maki.copy(a.txid)}
                >
                  <Glyph name="copy" className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="mt-4 text-right">
        <button
          className="font-mono text-[0.62rem] text-overlay0 hover:text-subtext0"
          title={`Node ${state.node}; restore height ${state.restoreHeight}`}
          onClick={() => void keep(null)}
        >
          start again (another node, or restore height)
        </button>
      </div>
    </div>
  )
}

/** A fresh subaddress to receive to, checked on maki's screen first. */
function Receive({
  link,
  wire,
  wallet,
  keep,
  linked
}: {
  link: Link
  wire: MoneroNetworkValue
  wallet: Wallet
  keep: (state: WalletState) => Promise<void>
  linked: boolean
}): React.JSX.Element {
  const [shown, setShown] = useState<{ address: string; index: number } | null>(null)
  // the next subaddress, worked out here from the keys this wallet watches with: shown while
  // maki shows its own, for the owner to compare, and checked against the one maki sends back
  const [comparing, setComparing] = useState<{ address: string; index: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fresh = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setShown(null)
    try {
      const index = wallet.state.receiveIndex + 1
      const k = subaddressKeys(wallet.keys.view, wallet.keys.spend, 0, index)
      const here = encodeAddress({
        network: wallet.keys.network,
        kind: 'subaddress',
        spend: k.spend,
        view: k.view
      })
      setComparing({ address: here, index })
      const r = await link.moneroAddress(wire, index)
      if (r.approval !== 'approved') {
        setProblem(
          r.approval === 'denied'
            ? 'You said it doesn’t match: don’t use the address this computer has.'
            : said(r.approval)
        )
        return
      }
      if (r.address !== here) {
        setProblem('maki has a different address for this account: don’t use this one.')
        return
      }
      wallet.state.receiveIndex = index
      await keep({ ...wallet.state })
      setShown({ address: here, index })
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setComparing(null)
      setBusy(false)
    }
  }
  return (
    <div className="mt-5 rounded-xl border border-surface0 p-4">
      <p className="text-sm leading-relaxed text-subtext0">
        A new subaddress for each payer keeps them from seeing each other’s payments. maki shows it
        too: pay to it once they match.
      </p>
      <div className="mt-3">
        <Button
          small
          kind="primary"
          glyph="receive"
          disabled={!linked || busy}
          onClick={() => void fresh()}
        >
          {busy ? 'Compare on maki…' : linked ? 'A fresh subaddress' : 'Plug maki in'}
        </Button>
      </div>
      {comparing && (
        <div className="mt-3">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Subaddress {comparing.index}: is it the same on maki?
          </div>
          <code className="mt-1 block break-all font-mono text-xs">
            <Grouped text={comparing.address} />
          </code>
        </div>
      )}
      {shown && (
        <div className="mt-3">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Subaddress {shown.index}, matches maki’s
          </div>
          <code className="mt-1 block break-all font-mono text-xs">
            <Grouped text={shown.address} />
          </code>
          <div className="mt-2">
            <Button small glyph="copy" onClick={() => void window.maki.copy(shown.address)}>
              Copy
            </Button>
          </div>
        </div>
      )}
      {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
    </div>
  )
}

/** A payment: planned here (the outputs, their rings, the fee), then gone through and signed on maki. */
function Send({
  link,
  wire,
  network,
  unit,
  wallet,
  unlocked,
  linked,
  done
}: {
  link: Link
  wire: MoneroNetworkValue
  network: Network
  unit: string
  wallet: Wallet
  unlocked: bigint
  linked: boolean
  done: () => Promise<void>
}): React.JSX.Element {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [all, setAll] = useState(false)
  const [speed, setSpeed] = useState(2)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [stage, setStage] = useState<'planning' | 'maki' | 'sending' | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const address = decodeAddress(to.trim())
  const piconero = parseXmr(amount)
  const ready =
    !!address && address.network === network && (all || (piconero !== null && piconero > 0n))

  const review = async (): Promise<void> => {
    setProblem(null)
    setPlan(null)
    setStage('planning')
    try {
      setPlan(
        await planPayment(wallet, [{ address: to.trim(), amount: piconero ?? 0n }], speed, all)
      )
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setStage(null)
    }
  }

  const sign = async (): Promise<void> => {
    if (!plan) return
    setProblem(null)
    setStage('maki')
    try {
      const r = await link.moneroSign(wire, encodeRequest(plan.request))
      if (r.approval !== 'approved' || !r.signed) {
        setProblem(said(r.approval, r.reason))
        return
      }
      setStage('sending')
      const s = await wallet.send(plan, decodeSigned(r.signed))
      setSent(s.txid)
      setPlan(null)
      await done()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setStage(null)
    }
  }

  if (sent) {
    return (
      <div className="mt-5 rounded-xl border border-green/30 bg-green/[0.05] p-4 text-sm">
        <p className="text-green">Sent. It waits in the pool for a block, about two minutes.</p>
        <code className="mt-1 block break-all font-mono text-xs text-subtext1">{sent}</code>
      </div>
    )
  }

  const paying = plan ? plan.request.payments.reduce((t, p) => t + p.amount, 0n) : 0n
  return (
    <div className="mt-5 rounded-xl border border-surface0 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field
          label="To"
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            setPlan(null)
          }}
          placeholder={`a ${network === 'mainnet' ? 'Monero' : network} address`}
        />
        <Field
          label={all ? `All of it, ${unit}` : `Amount, ${unit}`}
          value={all ? formatXmr(unlocked) : amount}
          onChange={(e) => {
            setAmount(e.target.value)
            setPlan(null)
          }}
          placeholder="0.0"
          disabled={all}
        />
      </div>
      {to.trim() !== '' && !address && (
        <p className="mt-2 text-xs text-yellow">That isn’t a Monero address.</p>
      )}
      {address && address.network !== network && (
        <p className="mt-2 text-xs text-yellow">That address is {address.network}’s.</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Segmented
          label="Speed"
          value={speed}
          options={SPEEDS}
          onChange={(v) => {
            setSpeed(v)
            setPlan(null)
          }}
        />
        <label className="flex items-center gap-2 text-xs text-subtext0">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked)
              setPlan(null)
            }}
          />
          send everything that can be spent
        </label>
      </div>
      {!plan ? (
        <div className="mt-4">
          <Button
            small
            kind="primary"
            glyph="send"
            disabled={!ready || stage !== null}
            onClick={() => void review()}
          >
            {stage === 'planning' ? 'Picking decoys…' : 'Review'}
          </Button>
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-crust/60 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-subtext0">Send</span>
            <span className="font-mono">
              {formatXmr(paying)} {unit}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-subtext0">Fee</span>
            <span className="font-mono">
              {formatXmr(plan.request.fee)} {unit}
            </span>
          </div>
          {plan.request.change > 0n && (
            <div className="flex justify-between">
              <span className="text-subtext0">Change, back to you</span>
              <span className="font-mono">
                {formatXmr(plan.request.change)} {unit}
              </span>
            </div>
          )}
          <p className="mt-2 text-xs text-overlay1">
            {plan.request.inputs.length} of this wallet’s outputs, each hidden among 15 others. maki
            shows you the address, the amount and the fee before it signs.
          </p>
          <div className="mt-3">
            <Button
              small
              kind="primary"
              glyph="chip"
              disabled={!linked || stage !== null}
              onClick={() => void sign()}
            >
              {stage === 'maki'
                ? 'Go through it on maki…'
                : stage === 'sending'
                  ? 'Sending…'
                  : linked
                    ? 'Sign on maki'
                    : 'Plug maki in'}
            </Button>
          </div>
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
    </div>
  )
}
