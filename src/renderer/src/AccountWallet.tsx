import { useEffect, useMemo, useState } from 'react'
import { hex } from '@scure/base'
import type { Link } from '@shared/link'
import type { AccountChain, ChainState, ChainToken, Holding, Payment } from '@shared/account-chain'
import type { CoinFetch, SharedAccount } from '@shared/coin-servers'
import { money, worth } from '@shared/prices'
import { parseUnits, units } from '@shared/tokens'
import type { Apps } from './apps-state'
import { said } from './BitcoinWallet'
import { usePrices } from './prices-state'
import { Qr } from './Qr'
import { ago, Badge, Button, Card, Field, Glyph, Label, Segmented } from './ui'
import { WalletAppNeeded } from './WalletAppNeeded'

/**
 * What each account last looked like, so coming back to the page (or the Portfolio, which looks the
 * same way) shows it straight away.
 */
export const kept = new Map<string, { state: ChainState; at: number }>()
/** Older than this, it's looked up again. */
const STALE_MS = 60_000

export const keyOf = (chain: AccountChain, a: SharedAccount): string =>
  `${chain.id} ${a.network} ${a.address}`
export const fetcher =
  (chain: AccountChain): CoinFetch =>
  (network, method, path, body, binary) =>
    window.maki.coins.fetch(chain.id, network, method, path, body, binary)

/** What a token's called here: its symbol if it's known, else its ID, shortened. */
export const tokenName = (chain: AccountChain, network: 0 | 1, t: ChainToken | null): string =>
  t === null
    ? chain.units[network]
    : (t.symbol ?? t.label ?? (t.id.length > 14 ? `${t.id.slice(0, 6)}…${t.id.slice(-4)}` : t.id))
const decimalsOf = (chain: AccountChain, t: ChainToken | null): number =>
  t ? t.decimals : chain.decimals

function savedNetwork(chain: AccountChain): 0 | 1 {
  try {
    return localStorage.getItem(`maki.${chain.id}Network`) === '1' ? 1 : 0
  } catch {
    return 0
  }
}

/**
 * maki's account on a chain of accounts (Tron, XRP, Stellar, ...): a wallet here once maki's app for
 * the chain has shared the account's address, which it does once its owner says yes on maki.
 */
export function AccountCard({
  link,
  apps,
  chain,
  choose,
  title,
  more
}: {
  link: Link
  apps: Apps
  chain: AccountChain
  /** beside the network: a way to choose among the chains one app serves */
  choose?: React.ReactNode
  /** what the account's wallet is called, where its key has more than one (TON's) */
  title?: string
  /** after the account's wallet: the key's others (TON's W5) */
  more?: (account: SharedAccount) => React.ReactNode
}): React.JSX.Element {
  const linked = link.state.linked
  const [chosen, setNetwork] = useState<0 | 1>(() => savedNetwork(chain))
  // a chain without a test network maki's app knows is on its own
  const network = chain.networks[1] === null ? 0 : chosen
  const [all, setAll] = useState<SharedAccount[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // the wallet this card is (the page starts it again for another): what it keeps is that one's
  const [wallet] = useState(() => link.wallet)

  useEffect(() => {
    void window.maki.coins.load().then((k) => setAll(k[chain.id] ?? []))
  }, [chain.id])
  const account = all?.find((a) => a.network === network && a.index === 0) ?? null

  const keep = async (list: SharedAccount[]): Promise<void> => {
    const k = await window.maki.coins.load()
    await window.maki.coins.save({ ...k, [chain.id]: list }, wallet)
    setAll(list)
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    setProblem(null)
    try {
      link.note(`sharing the ${chain.name} account: approve on maki`)
      const r = await link.accountApp(chain.app, chain.name, chain.appChain).account(network, 0)
      if (r.approval !== 'approved') {
        setProblem(
          r.approval === 'no match'
            ? `maki’s ${chain.name} app isn’t installed.`
            : said(r.approval, r.reason).replace("won't sign it", "won't share it")
        )
        return
      }
      if (!chain.valid(r.address, network))
        throw new Error(`maki’s ${chain.name} app gave an address maki desktop can’t read`)
      link.note(`${chain.name} account shared`)
      await keep([
        ...(all ?? []).filter((a) => !(a.network === network && a.index === 0)),
        { network, index: 0, address: r.address, publicKey: hex.encode(r.publicKey) }
      ])
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const forget = async (): Promise<void> => {
    if (!account) return
    await keep((all ?? []).filter((a) => a !== account))
    link.note(`${chain.name} account removed from maki desktop (maki still has it)`)
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>{chain.name}</Label>
        <div className="flex flex-wrap items-center gap-3">
          {choose}
          {chain.networks[1] !== null && (
            <Segmented
              label="Network"
              value={network}
              options={[
                [0, chain.networks[0]],
                [1, chain.networks[1]]
              ]}
              onChange={(v) => {
                setNetwork(v)
                setProblem(null)
                try {
                  localStorage.setItem(`maki.${chain.id}Network`, String(v))
                } catch {
                  // remembered for this session only
                }
              }}
            />
          )}
        </div>
      </div>
      <WalletAppNeeded link={link} apps={apps} id={chain.app} name={chain.name} />

      {all === null ? null : account ? (
        <>
          <AccountWallet
            key={keyOf(chain, account)}
            link={link}
            chain={chain}
            account={account}
            title={title}
          />
          {more?.(account)}
        </>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
          <span
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${chain.tint}`}
          >
            <Glyph name={chain.glyph} className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[0.95rem] font-bold text-fg">
              Your {chain.name} account, here
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
              {chain.wallets} from maki’s recovery phrase. maki shares its address once you approve
              it on maki; maki desktop can then show what it holds and make payments, which maki’s{' '}
              {chain.name} app shows you and maki signs. It can never spend on its own.
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
        <p className="max-w-xl text-xs leading-relaxed text-overlay0">{chain.servers}</p>
        {account && (
          <Button small onClick={() => void forget()}>
            Remove from maki desktop
          </Button>
        )}
      </div>
    </Card>
  )
}

/** The account as a wallet: what it holds, receiving, sending, and its activity. */
export function AccountWallet({
  link,
  chain,
  account,
  title
}: {
  link: Link
  chain: AccountChain
  account: SharedAccount
  /** which of the key's wallets it is, where it has more than one */
  title?: string
}): React.JSX.Element {
  const fetch = useMemo(() => fetcher(chain), [chain])
  const network = account.network
  const unit = chain.units[network]
  const [seen, setSeen] = useState(kept.get(keyOf(chain, account)) ?? null)
  const [looking, setLooking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [panel, setPanel] = useState<'receive' | 'send' | null>(null)
  const [showAll, setShowAll] = useState(false)

  const look = async (): Promise<void> => {
    setLooking(true)
    setProblem(null)
    try {
      const state = await chain.look(fetch, account)
      const now = { state, at: Date.now() }
      kept.set(keyOf(chain, account), now)
      setSeen(now)
    } catch (e) {
      setProblem(`Couldn’t look: ${(e as Error).message}.`)
    } finally {
      setLooking(false)
    }
  }
  useEffect(() => {
    if (!seen || Date.now() - seen.at > STALE_MS) void look()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.address])

  const state = seen?.state ?? null
  const coin = state?.holdings.find((h) => h.token === null)?.amount ?? null
  const tokens = state?.holdings.filter((h) => h.token !== null) ?? []
  const { currency, prices } = usePrices()
  const inMoney = (h: Holding): string | null => {
    const symbol = h.token ? h.token.symbol : chain.priced
    const v =
      currency && symbol
        ? worth(prices, symbol, h.amount, decimalsOf(chain, h.token), network === 1)
        : null
    return v !== null && v !== undefined && currency ? money(v, currency) : null
  }
  const shown = state ? (showAll ? state.activity : state.activity.slice(0, 6)) : []

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            {title ? `${title} · balance` : 'Balance'}
          </div>
          <div className="mt-1.5 font-mono leading-none text-fg">
            {coin === null ? (
              <span className="text-[2.2rem] font-bold tracking-[-0.04em] text-overlay0">
                {looking ? '…' : '—'}
              </span>
            ) : (
              <>
                <span className="text-[2.4rem] font-bold tracking-[-0.04em]">
                  {units(coin, chain.decimals)}
                </span>
                <span className="ml-2 text-base text-overlay1">{unit}</span>
                {inMoney({ token: null, amount: coin }) && (
                  <span className="ml-3 font-sans text-base text-subtext0">
                    ≈ {inMoney({ token: null, amount: coin })}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-overlay1">
            {state && state.reserved > 0n && (
              <span>
                {units(state.reserved, chain.decimals)} {unit} of it is kept as the network’s
                reserve
              </span>
            )}
            <span>{looking ? 'looking…' : seen ? `as of ${ago(seen.at)}` : ''}</span>
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
            disabled={!state || !state.exists}
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
      {state?.notes.map((n) => (
        <p key={n} className="mt-3 max-w-2xl text-sm leading-relaxed text-subtext0">
          {n}
        </p>
      ))}

      {tokens.length > 0 && (
        <ul className="mt-5 divide-y divide-surface0/70 rounded-xl border border-surface0 px-4">
          {tokens.map((h) => (
            <li key={h.token!.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0 truncate text-sm text-subtext1" title={h.token!.id}>
                {tokenName(chain, network, h.token)}
                {h.token!.symbol === null && (
                  <span className="ml-2 text-xs text-overlay0">a token maki doesn’t know</span>
                )}
              </span>
              <span className="font-mono text-sm text-fg">
                {units(h.amount, h.token!.decimals)}
                {inMoney(h) && <span className="ml-2 text-overlay0">≈ {inMoney(h)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {panel === 'receive' && <Receive link={link} chain={chain} account={account} />}
      {panel === 'send' && state && (
        <Send
          link={link}
          chain={chain}
          account={account}
          state={state}
          fetch={fetch}
          sent={() => setTimeout(() => void look(), 3000)}
          close={() => setPanel(null)}
        />
      )}

      <div className={`mt-7 ${state ? '' : 'hidden'}`}>
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Activity
          </h3>
          {state && state.activity.length > 6 && (
            <button
              className="font-mono text-[0.68rem] text-peach hover:text-yellow"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? 'Fewer' : `All ${state.activity.length}`}
            </button>
          )}
        </div>
        {state && state.activity.length === 0 && (
          <p className="mt-3 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
            Nothing yet. Receive some {unit} and it shows here.
          </p>
        )}
        <ul className="mt-2 divide-y divide-surface0/70">
          {shown.map((a) => {
            const incoming = a.amount !== null && a.amount > 0n
            return (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    incoming ? 'bg-green/10 text-green' : 'bg-peach/10 text-peach'
                  }`}
                >
                  <Glyph name={incoming ? 'receive' : 'send'} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-subtext1">
                    {a.kind}
                    {a.failed && (
                      <span className="ml-2">
                        <Badge kind="warn">failed</Badge>
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[0.68rem] text-overlay0">
                    {a.counterparty ?? `${a.id.slice(0, 10)}…${a.id.slice(-6)}`}
                  </div>
                </div>
                <div className="text-right">
                  {a.amount !== null && (
                    <div className={`font-mono text-sm ${incoming ? 'text-green' : 'text-fg'}`}>
                      {incoming ? '+' : a.amount < 0n ? '−' : ''}
                      {units(a.amount < 0n ? -a.amount : a.amount, decimalsOf(chain, a.token))}{' '}
                      {tokenName(chain, network, a.token)}
                    </div>
                  )}
                  <div className="mt-0.5 text-[0.68rem] text-overlay1">
                    {a.time === null ? <Badge kind="warn">waiting</Badge> : ago(a.time * 1000)}
                  </div>
                </div>
                <button
                  className="rounded-md p-1.5 text-overlay1 transition-colors hover:bg-surface0 hover:text-fg"
                  title={`See it on ${chain.explorerName}`}
                  aria-label={`See it on ${chain.explorerName}`}
                  onClick={() => void window.maki.openExternal(chain.explorer(network, 'tx', a.id))}
                >
                  <Glyph name="external" className="h-3.5 w-3.5" />
                </button>
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
  chain,
  account
}: {
  link: Link
  chain: AccountChain
  account: SharedAccount
}): React.JSX.Element {
  const address = account.address
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{ approval: string; same: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const linked = link.state.linked

  const check = async (): Promise<void> => {
    setChecking(true)
    setChecked(null)
    try {
      link.note(`the ${chain.name} address is on maki's screen: compare it`)
      const r = await link
        .accountApp(chain.app, chain.name, chain.appChain)
        .address(account.network, account.index)
      setChecked({ approval: r.approval, same: r.address === '' || r.address === address })
    } catch (e) {
      link.note(`couldn't check the address: ${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="rise mt-5 flex flex-wrap gap-6 rounded-xl border border-surface0 bg-crust/40 p-5">
      <Qr text={chain.uri(address)} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
          Your address
        </div>
        <code className="mt-2 block break-all font-mono text-[0.98rem] leading-relaxed text-fg">
          {address}
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
            onClick={() =>
              void window.maki.openExternal(chain.explorer(account.network, 'address', address))
            }
          >
            {chain.explorerName}
          </Button>
        </div>
        {checked && (
          <p
            className={`mt-3 flex items-center gap-2 text-sm ${
              checked.approval === 'approved' && checked.same
                ? 'text-green'
                : checked.approval === 'denied' || !checked.same
                  ? 'text-red'
                  : 'text-yellow'
            }`}
          >
            <Glyph name={checked.approval === 'approved' && checked.same ? 'check' : 'warn'} />
            {!checked.same
              ? 'maki has a different address for this account: don’t use this one.'
              : checked.approval === 'approved'
                ? 'You said maki shows the same address. It’s yours.'
                : checked.approval === 'denied'
                  ? 'You said it doesn’t match: don’t use the address this computer shows.'
                  : said(checked.approval as never)}
          </p>
        )}
        <p className="mt-3 max-w-md text-xs leading-relaxed text-overlay1">
          Checking it on maki’s screen means nothing on this computer can have swapped it.
        </p>
      </div>
    </div>
  )
}

type Stage = 'making' | 'maki' | 'sending'

function Send({
  link,
  chain,
  account,
  state,
  fetch,
  sent,
  close
}: {
  link: Link
  chain: AccountChain
  account: SharedAccount
  state: ChainState
  fetch: CoinFetch
  sent: () => void
  close: () => void
}): React.JSX.Element {
  const network = account.network
  const [to, setTo] = useState('')
  const [what, setWhat] = useState('coin')
  const [amountText, setAmountText] = useState('')
  const [memo, setMemo] = useState('')
  const [stage, setStage] = useState<Stage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; amount: string } | null>(null)
  // what the payment being signed says of itself (its fee, if the chain can't bound it)
  const [notes, setNotes] = useState<string[]>([])
  const linked = link.state.linked

  const holding = state.holdings.find((h) => (h.token?.id ?? 'coin') === what) ?? null
  const token = holding?.token ?? null
  const decimals = decimalsOf(chain, token)
  const name = tokenName(chain, network, token)
  const amount = parseUnits(amountText, decimals)
  const address = to.trim()
  const spendable =
    holding && token === null
      ? holding.amount > state.reserved
        ? holding.amount - state.reserved
        : 0n
      : (holding?.amount ?? 0n)
  const problemNow = !address
    ? null
    : !chain.valid(address, network)
      ? `that isn’t ${/^[AEIOUX]/.test(chain.name) ? 'an' : 'a'} ${chain.name} address`
      : address === account.address
        ? 'that’s this account’s own address'
        : amountText.trim() === ''
          ? null
          : amount === null || amount <= 0n
            ? `that isn’t an amount of ${name}`
            : amount > spendable
              ? `the account has ${units(spendable, decimals)} ${name} to send`
              : chain.memo?.numeric && memo.trim() !== '' && !/^\d{1,10}$/.test(memo.trim())
                ? `the ${chain.memo.label.toLowerCase()} is a number`
                : null
  const ready = !!address && amount !== null && amount > 0n && problemNow === null

  const go = async (): Promise<void> => {
    if (!ready || amount === null) return
    setProblem(null)
    try {
      setStage('making')
      const payment: Payment = await chain.pay(
        fetch,
        account,
        state,
        address,
        amount,
        token,
        memo.trim()
      )
      setNotes(payment.notes)
      setStage('maki')
      link.note(`${chain.name} payment sent: go through it on maki`)
      const r = await link
        .accountApp(chain.app, chain.name, chain.appChain)
        .sign(network, account.index, payment.payload)
      if (!r.signature) {
        link.note(`${chain.name} payment: ${r.approval}`)
        setProblem(said(r.approval, r.reason))
        return
      }
      setStage('sending')
      const id = await chain.submit(fetch, account, payment, r.signature)
      link.note(`sent ${units(amount, decimals)} ${name}: ${id}`)
      setDone({ id, amount: `${units(amount, decimals)} ${name}` })
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
          <span className="font-mono text-sm font-bold">Sent {done.amount}</span>
        </div>
        <p className="mt-2 text-sm text-subtext1">maki signed it and the network has it.</p>
        <code className="mt-2 block break-all font-mono text-xs text-overlay1">{done.id}</code>
        <div className="mt-3 flex gap-2">
          <Button
            small
            glyph="external"
            onClick={() => void window.maki.openExternal(chain.explorer(network, 'tx', done.id))}
          >
            Follow it on {chain.explorerName}
          </Button>
          <Button small onClick={close}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  const busy = stage !== null
  const choices = state.holdings.map((h) => [
    h.token?.id ?? 'coin',
    tokenName(chain, network, h.token)
  ])

  return (
    <div className="rise mt-5 rounded-xl border border-surface0 bg-crust/40 p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
        <Field
          label="To"
          placeholder={chain.hint}
          value={to}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
        />
        <div>
          <Field
            label="Amount"
            unit={name}
            placeholder="0.00"
            inputMode="decimal"
            value={amountText}
            disabled={busy}
            onChange={(e) => setAmountText(e.target.value)}
          />
          {choices.length > 1 && (
            <select
              value={what}
              disabled={busy}
              onChange={(e) => setWhat(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
            >
              {choices.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {chain.memo && (
        <Field
          className="mt-4 max-w-sm"
          label={chain.memo.label}
          placeholder={chain.memo.placeholder}
          inputMode={chain.memo.numeric ? 'numeric' : 'text'}
          value={memo}
          disabled={busy}
          onChange={(e) => setMemo(e.target.value)}
        />
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-surface0 pt-4">
        <div className="min-w-0 text-sm">
          {problemNow ? (
            <span className="text-yellow">
              {problemNow[0].toUpperCase() + problemNow.slice(1)}.
            </span>
          ) : (
            <span className="text-overlay1">
              {ready
                ? 'maki desktop works out the fee; maki shows it with the payment.'
                : 'Where to, and how much?'}
            </span>
          )}
        </div>
        <Button
          kind="primary"
          glyph="chip"
          disabled={!ready || busy || !linked}
          onClick={() => void go()}
        >
          {stage === 'making'
            ? 'Making it…'
            : stage === 'maki'
              ? 'Go through it on maki…'
              : stage === 'sending'
                ? 'Sending…'
                : linked
                  ? 'Review on maki'
                  : 'Plug maki in to send'}
        </Button>
      </div>
      {stage === 'maki' && (
        <p className="mt-3 text-xs text-overlay1">
          maki shows where it goes, how much, and the fee. Check the address against the one you
          were given, then approve it there.
        </p>
      )}
      {stage === 'maki' &&
        notes.map((n) => (
          <p key={n} className="mt-2 max-w-2xl text-xs leading-relaxed text-subtext0">
            {n}
          </p>
        ))}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
    </div>
  )
}
