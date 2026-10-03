import { useEffect, useMemo } from 'react'
import type { Link } from '@shared/link'
import {
  allocation,
  byCoin,
  isFailed,
  summarize,
  type Kept,
  type Look,
  type Row,
  type Segment
} from '@shared/portfolio'
import { CURRENCIES, money, type Currency } from '@shared/prices'
import { units } from '@shared/tokens'
import { useKnownApps, type Apps } from './apps-state'
import type { Page } from './pages'
import {
  coinNamed,
  refresh,
  replan,
  useCurrency,
  usePortfolio,
  usePortfolioPrices,
  type Folio
} from './portfolio-state'
import { PortfolioChart } from './PortfolioChart'
import { ago, Badge, Button, Card, Glyph, Label, PageHeader, readable } from './ui'

/**
 * The allocation's colours, in their order: blue, peach, teal, yellow, pink, green, mauve and red,
 * maki's own hues at steps dark enough for these cards, ordered so that anyone tells each from the
 * next, colour-blind or not. (Checked with a simulation of colour blindness: each neighbour at
 * least 8.4 apart in OKLab with protanopia or deuteranopia, 19 without; each 3:1 against the card.)
 */
export const SLOTS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767'
]
/** Other's colour: the quiet grey of what's set aside. */
const OTHER = '#6c7086'
const colourOf = (s: Segment): string => (s.slot === null ? OTHER : SLOTS[s.slot % SLOTS.length])

/** A share as people read one: to a tenth of a percent, and a sliver as less than that. */
export const percent = (share: number): string =>
  share > 0 && share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(1)}%`

/** The total, shared out: a part for each coin or token, in its colour, with a gap between. */
export function AllocationBar({
  parts,
  compact = false
}: {
  parts: Segment[]
  compact?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-surface0/60 ${compact ? 'h-2.5' : 'h-4'}`}
      role="img"
      aria-label={parts.map((p) => `${p.name} ${percent(p.share)}`).join(', ')}
    >
      {parts.map((p) => (
        <div
          key={p.id ?? 'other'}
          title={`${p.name}: ${percent(p.share)}`}
          className="h-full shrink-0 border-r-2 border-crust/80 transition-[width] duration-500 last:border-r-0"
          style={{ width: `max(${(p.share * 100).toFixed(3)}%, 4px)`, background: colourOf(p) }}
        />
      ))}
    </div>
  )
}

/** The prices chosen, as the Wallets page has the same choice: none, or a currency. */
function PricesChoice({
  currency,
  choose
}: {
  currency: Currency | null
  choose: (c: Currency | null) => void
}): React.JSX.Element {
  return (
    <label
      className="flex items-center gap-2 font-mono text-[0.68rem] text-overlay1"
      title="Prices come from CoinGecko, which sees this computer's IP address and the list of coins asked about (the same for everyone), never your addresses or balances."
    >
      prices
      <select
        value={currency ?? ''}
        onChange={(e) => choose((e.target.value || null) as Currency | null)}
        className="rounded-lg border border-surface1 bg-crust/60 px-2 py-1.5 font-mono text-[0.72rem] text-fg outline-none focus:border-peach/70"
      >
        <option value="">off</option>
        {CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * What a look's last try says of it, in a few words: why it failed, if this session knows (what's
 * kept is times, not reasons), and what's counted instead.
 */
function lookSays(look: Look, problem: string | undefined): string {
  const failed = problem
    ? `couldn’t be looked up: ${problem}`
    : `couldn’t be looked up when last tried, ${ago(look.tried)}`
  return look.at === null
    ? `${failed}. Nothing of it is counted`
    : `${failed}. Counted as it was ${ago(look.at)}`
}

/**
 * Everything the accounts maki shared hold, all together, and what it comes to in the currency
 * chosen: each coin and token's amount, price, value and share, the allocation, and when each
 * account was last looked up, or why it couldn't be, or isn't counted.
 */
export function PortfolioPage({
  link,
  apps,
  go
}: {
  link: Link
  apps: Apps
  go: (page: Page) => void
}): React.JSX.Element {
  const folio = usePortfolio(link)
  const known = useKnownApps(apps)
  const [currency, choose] = useCurrency()
  const { prices, at: pricesAt, problem: pricesProblem } = usePortfolioPrices(currency)
  const wallet = link.wallet

  // opened: look everything up (what was looked at in the last minute aside), one after another
  useEffect(() => {
    void refresh(link, known, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, wallet])
  // maki said which apps it has: what isn't counted, again (no network asked)
  const knownSaid = known.join(' ')
  useEffect(() => {
    if (!folio.refreshing) void replan(link, known)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, wallet, knownSaid])

  const kept = folio.kept
  const summary = useMemo(() => (kept ? summarize(kept, prices) : null), [kept, prices])
  const parts = useMemo(() => (kept && summary ? allocation(kept, summary) : []), [kept, summary])
  const colours = useMemo(() => {
    const by = new Map<string, string>()
    for (const p of parts) if (p.id !== null) by.set(p.id, colourOf(p))
    return by
  }, [parts])
  const looks = kept ? Object.keys(kept.looks).length : 0
  // no account to look up at all (or none yet: the first plan's under way)
  const none = folio.planned && folio.accounts === 0 && looks === 0

  return (
    <div className="rise space-y-6">
      <PageHeader
        label="portfolio"
        title="Portfolio"
        lede="What the accounts maki has shared hold, all together, and what that comes to in money: each looked up as its card on the Wallets page looks it up, one after another."
        actions={
          none ? undefined : (
            <div className="flex items-center gap-3">
              {currency && <PricesChoice currency={currency} choose={choose} />}
              <Button
                glyph="refresh"
                disabled={folio.refreshing !== null || kept === null}
                onClick={() => void refresh(link, known, true)}
              >
                {folio.refreshing ? 'Looking…' : 'Look again'}
              </Button>
            </div>
          )
        }
      />

      {wallet !== null && (
        <div className="flex items-start gap-3 rounded-xl border border-lavender/30 bg-lavender/[0.05] p-4">
          <Glyph name="key" className="mt-0.5 h-4 w-4 text-lavender" />
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-subtext0">
            <span className="font-semibold text-fg">
              These are passphrase wallet {wallet}’s accounts,
            </span>{' '}
            the wallet maki has open (or had, last linked): its total is its own. The phrase’s own
            wallet’s is kept for when it’s open again.
          </p>
        </div>
      )}

      {kept === null ? null : none ? (
        <Empty folio={folio} go={go} />
      ) : looks === 0 && !folio.planned ? (
        <Refreshing folio={folio} />
      ) : (
        <>
          {currency ? (
            <Total
              folio={folio}
              currency={currency}
              summary={summary}
              first={looks === 0}
              parts={parts}
              pricesAt={pricesAt}
              pricesProblem={pricesProblem}
            />
          ) : (
            <Card className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label>what it’s worth</Label>
                <Refreshing folio={folio} />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
                <p className="max-w-2xl text-sm leading-relaxed text-subtext0">
                  <span className="font-semibold text-fg">
                    Choose a currency to see what it’s all worth.
                  </span>{' '}
                  Prices come from CoinGecko only once you do: it sees this computer’s IP address
                  and the list of coins asked about, the same list for everyone, never your
                  addresses or balances. Until then, here are the amounts.
                </p>
                <PricesChoice currency={currency} choose={choose} />
              </div>
            </Card>
          )}
          <Holdings summary={summary} currency={currency} colours={colours} first={looks === 0} />
          <Accounts folio={folio} kept={kept} go={go} unpriced={summary} />
          {currency && <PortfolioChart days={kept.days} currency={currency} />}
        </>
      )}
    </div>
  )
}

/**
 * The page with nothing to add up: no wallet on maki (or none known), or wallets whose accounts
 * maki hasn't shared with maki desktop yet, each said.
 */
function Empty({ folio, go }: { folio: Folio; go: (page: Page) => void }): React.JSX.Element {
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-peach/10 text-peach">
          <Glyph name="pie" className="h-7 w-7" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-mono text-[0.95rem] font-bold text-fg">Nothing to add up yet</h3>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
            {folio.missing.length === 0
              ? 'maki’s wallets are apps from the maki store. Add one on the Wallets page and have maki share its account: what it holds shows here, with the others’, and what they come to.'
              : 'maki has wallets whose accounts it hasn’t shared with maki desktop yet. Share them on the Wallets page, and what they hold shows here, all together, and what it comes to.'}
          </p>
        </div>
        <Button kind="primary" glyph="wallet" onClick={() => go('wallets')}>
          Open Wallets
        </Button>
      </div>
      {folio.missing.length > 0 && (
        <ul className="mt-5 space-y-1.5 text-sm leading-relaxed text-subtext0">
          {folio.missing.map((m) => (
            <li key={m.coin} className="flex items-start gap-2.5">
              <Glyph name={coinNamed(m.coin).glyph} className="mt-0.5 h-4 w-4 text-overlay1" />
              <span>
                <span className="font-semibold text-fg">{coinNamed(m.coin).name}</span>: {m.why}.
              </span>
            </li>
          ))}
        </ul>
      )}
      {folio.test.length > 0 && (
        <p className="mt-4 text-xs leading-relaxed text-overlay1">
          Accounts on test networks aren’t counted: their coins are worth nothing.
        </p>
      )}
    </Card>
  )
}

/** The refresh under way, in a line. */
function Refreshing({ folio }: { folio: Folio }): React.JSX.Element | null {
  const r = folio.refreshing
  if (!r) return null
  return (
    <p className="flex items-center gap-2 text-xs text-overlay1">
      <span className="breathe inline-block h-1.5 w-1.5 rounded-full bg-peach" />
      {r.where
        ? `Looking up ${r.where}${r.detail ? `: ${r.detail}` : ''}… (${r.done + 1} of ${r.of})`
        : 'Finding the accounts…'}
    </p>
  )
}

/** What it all comes to, the allocation, and how fresh it is. */
function Total({
  folio,
  currency,
  summary,
  first,
  parts,
  pricesAt,
  pricesProblem
}: {
  folio: Folio
  currency: Currency
  summary: ReturnType<typeof summarize> | null
  /** whether nothing has been found out yet: the first look is under way, and there's no total */
  first: boolean
  parts: Segment[]
  pricesAt: number | null
  pricesProblem: string | null
}): React.JSX.Element {
  const total = first ? null : (summary?.total ?? null)
  const valued = summary?.rows.filter((r) => r.value !== null).length ?? 0
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>total</Label>
        <Refreshing folio={folio} />
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="font-mono text-[2.6rem] leading-none font-bold tracking-[-0.04em] text-fg">
            {total !== null ? money(total, currency) : '—'}
          </div>
          <p className="mt-2.5 text-xs text-overlay1">
            {total === null
              ? first
                ? 'Looking them up for the first time…'
                : pricesProblem
                  ? `No prices: ${pricesProblem}. They’re asked for again in a few minutes.`
                  : 'Asking CoinGecko for prices…'
              : [
                  `${valued} ${valued === 1 ? 'coin or token' : 'coins and tokens'} with a price`,
                  summary?.asOf ? `looked up ${ago(summary.asOf)}` : null,
                  pricesAt ? `prices from CoinGecko, ${ago(pricesAt)}` : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
          {total !== null && pricesProblem && (
            <p className="mt-1 text-xs text-yellow">
              Prices couldn’t be asked for again ({pricesProblem}): these are the last.
            </p>
          )}
        </div>
      </div>
      {summary && summary.failed.length > 0 && total !== null && (
        <p className="mt-3 text-xs leading-relaxed text-yellow">
          {summary.failed.length === 1 ? 'An account' : 'Some accounts'} couldn’t be looked up this
          time: what {summary.failed.length === 1 ? 'it' : 'they'} last held is counted, as it was
          then (below).
        </p>
      )}
      {parts.length > 1 && (
        <div className="mt-6">
          <AllocationBar parts={parts} />
          <ul className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2">
            {parts.map((p) => (
              <li key={p.id ?? 'other'} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: colourOf(p) }}
                />
                <span className="font-mono text-[0.78rem] text-subtext1">{p.name}</span>
                <span className="font-mono text-[0.72rem] text-overlay1">{percent(p.share)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

/**
 * A row's mark: its part's colour in the allocation; Other's, if it's among the rest; an empty box
 * if it has no value there.
 */
const swatch = (colour: string | undefined, r: Row): React.CSSProperties =>
  colour
    ? { background: colour }
    : r.value !== null && r.value > 0
      ? { background: OTHER }
      : { boxShadow: 'inset 0 0 0 1px #585b70' }

/** Where some of a coin or token is, in a line: each account or network, and how much there. */
function places(row: Row): React.JSX.Element {
  return (
    <>
      {row.places.map((p, i) => (
        <span key={p.key} className={p.stale ? 'text-yellow/80' : undefined}>
          {i > 0 && <span className="text-overlay0"> · </span>}
          {p.where} {readable(p.amount, p.decimals)}
          {p.stale && row.places.length > 1 && ' (as it was)'}
        </span>
      ))}
    </>
  )
}

/** Each coin and token: how much, at what price, worth what, and its share of the total. */
function Holdings({
  summary,
  currency,
  colours,
  first
}: {
  summary: ReturnType<typeof summarize> | null
  currency: Currency | null
  colours: Map<string, string>
  /** whether nothing has been looked up yet: the first look is under way */
  first: boolean
}): React.JSX.Element {
  const rows = summary?.rows ?? []
  const head = 'pb-2 font-mono text-[0.6rem] font-bold uppercase tracking-[0.14em] text-overlay1'
  return (
    <Card className="p-6">
      <Label>holdings</Label>
      {first ? (
        <p className="mt-4 text-sm text-overlay1">Looking them up for the first time…</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-surface1 px-4 py-5 text-center text-sm text-overlay1">
          Nothing held, as far as the accounts here were last looked up.
        </p>
      ) : (
        <table className="mt-4 w-full border-collapse">
          <thead>
            <tr className="border-b border-surface0">
              <th className={`${head} text-left`}>Coin or token</th>
              <th className={`${head} text-right`}>Amount</th>
              {currency && (
                <>
                  <th className={`${head} text-right`}>Price</th>
                  <th className={`${head} text-right`}>Value</th>
                  <th className={`${head} text-right`}>Share</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-surface0/60 align-top last:border-b-0">
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2.5">
                    {currency && (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={swatch(colours.get(r.id), r)}
                      />
                    )}
                    <span className="font-mono text-sm font-bold text-fg">{r.name}</span>
                    {r.stale && <Badge kind="warn">as it was</Badge>}
                  </div>
                  <div
                    className={`mt-1 text-xs leading-relaxed text-overlay1 ${currency ? 'pl-5' : ''}`}
                  >
                    {places(r)}
                  </div>
                </td>
                <td
                  className="py-3 pl-2 text-right font-mono text-sm whitespace-nowrap text-fg tabular-nums"
                  title={`${units(r.amount, r.decimals)} ${r.name}`}
                >
                  {readable(r.amount, r.decimals)}
                </td>
                {currency && (
                  <>
                    <td className="py-3 pl-4 text-right font-mono text-[0.8rem] whitespace-nowrap text-subtext0 tabular-nums">
                      {r.price !== null
                        ? money(r.price, currency)
                        : summary?.total !== null
                          ? 'no price'
                          : '—'}
                    </td>
                    <td className="py-3 pl-4 text-right font-mono text-sm whitespace-nowrap text-fg tabular-nums">
                      {r.value !== null ? money(r.value, currency) : '—'}
                    </td>
                    <td className="py-3 pl-4 text-right font-mono text-[0.8rem] whitespace-nowrap text-subtext0 tabular-nums">
                      {r.share !== null ? percent(r.share) : '—'}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/**
 * What a group of a wallet's looks is called: its few accounts by name (nothing, for one named as
 * the wallet is), or how many.
 */
function lookNames(coin: string, looks: { look: Look }[]): string {
  if (looks.length === 1 && looks[0].look.where === coinNamed(coin).name) return ''
  if (looks.length <= 3) return looks.map((l) => l.look.where).join(', ')
  const what = coin === 'ethereum' ? 'networks' : coin === 'cosmos' ? 'chains' : 'accounts'
  return `${looks.length} ${what}`
}

/**
 * Each wallet's accounts: when they were looked up, and those that couldn't be; then what isn't
 * counted: test networks, wallets without an account here yet, and what has no price.
 */
function Accounts({
  folio,
  kept,
  go,
  unpriced
}: {
  folio: Folio
  kept: Kept
  go: (page: Page) => void
  unpriced: ReturnType<typeof summarize> | null
}): React.JSX.Element | null {
  const groups = byCoin(kept)
  const noPrice =
    unpriced && unpriced.total !== null ? unpriced.rows.filter((r) => r.value === null) : []
  const test = new Map<string, string[]>()
  for (const t of folio.test) test.set(t.coin, [...(test.get(t.coin) ?? []), t.where])
  const uncounted = folio.missing.length > 0 || folio.test.length > 0 || noPrice.length > 0
  // nothing looked up yet, and nothing to say of what isn't: the first look is under way
  if (groups.length === 0 && !uncounted) return null
  return (
    <Card className="p-6">
      <Label>accounts</Label>
      {groups.length > 0 && (
        <ul className="mt-4 divide-y divide-surface0/70">
          {groups.map(({ coin, looks }) => {
            const c = coinNamed(coin)
            const fine = looks.filter((l) => !isFailed(l.look))
            const oldest = fine.length ? Math.min(...fine.map((l) => l.look.at!)) : null
            const monero = looks.find((l) => l.look.block !== undefined)
            const looking = folio.refreshing?.where?.startsWith(`${c.name}, `)
            return (
              <li key={coin} className="flex gap-3 py-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface0/60 text-subtext1">
                  <Glyph name={c.glyph} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="font-mono text-sm font-bold text-fg">{c.name}</span>
                    {lookNames(coin, looks) && (
                      <span className="text-xs text-overlay1">{lookNames(coin, looks)}</span>
                    )}
                    <span className="text-xs text-overlay1">
                      {looking
                        ? 'looking…'
                        : monero
                          ? `as its own wallet here last found it, to block ${monero.look.block!.toLocaleString()}`
                          : oldest !== null
                            ? `looked up ${ago(oldest)}`
                            : ''}
                    </span>
                  </div>
                  {looks
                    .filter((l) => isFailed(l.look))
                    .map(({ key, look }) => (
                      <p key={key} className="mt-1 text-xs leading-relaxed text-yellow">
                        {looks.length > 1 ? `${look.where}: ` : ''}
                        {lookSays(look, folio.problems[key])}.
                      </p>
                    ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {uncounted && (
        <div className={groups.length > 0 ? 'mt-2 border-t border-surface0 pt-4' : 'mt-4'}>
          <h3 className="font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1">
            Not counted
          </h3>
          <ul className="mt-2 space-y-2 text-sm leading-relaxed text-subtext0">
            {folio.missing.map((m) => (
              <li key={m.coin}>
                <span className="font-semibold text-fg">{coinNamed(m.coin).name}</span>: {m.why}.
              </li>
            ))}
            {test.size > 0 && (
              <li>
                <span className="font-semibold text-fg">Test networks</span>, whose coins are worth
                nothing, aren’t looked up:{' '}
                {[...test.entries()]
                  .map(([coin, where]) => `${coinNamed(coin).name} (${where.join(', ')})`)
                  .join(', ')}
                .
              </li>
            )}
            {noPrice.length > 0 && (
              <li>
                <span className="font-semibold text-fg">No price</span>, so not in the total:{' '}
                {noPrice.map((r) => r.name).join(', ')}. CoinGecko isn’t asked about{' '}
                {noPrice.length === 1 ? 'it' : 'them'}, or didn’t say.
              </li>
            )}
          </ul>
          {folio.missing.length > 0 && (
            <div className="mt-3">
              <Button small kind="ghost" glyph="wallet" onClick={() => go('wallets')}>
                Open Wallets
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * The Overview's glance at the Portfolio: what it all comes to, when it was found out, and its
 * allocation; or, briefly, why there's no total.
 */
export function PortfolioGlance({ link }: { link: Link }): React.JSX.Element {
  const folio = usePortfolio(link)
  const [currency] = useCurrency()
  const { prices, problem } = usePortfolioPrices(currency)
  const kept = folio.kept
  const summary = useMemo(() => (kept ? summarize(kept, prices) : null), [kept, prices])
  const parts = useMemo(() => (kept && summary ? allocation(kept, summary) : []), [kept, summary])
  const said = (text: string): React.JSX.Element => (
    <p className="text-sm leading-relaxed text-subtext0">{text}</p>
  )
  if (!kept) return said('…')
  if (Object.keys(kept.looks).length === 0)
    return said('Nothing looked up yet: the Portfolio adds up what the accounts maki shared hold.')
  if (!currency) return said('Prices are off: choose a currency to see what it all comes to.')
  if (!summary || summary.total === null)
    return said(problem ? `No prices right now: ${problem}.` : 'Asking CoinGecko for prices…')
  return (
    <>
      <div className="font-mono text-[1.7rem] font-bold tracking-[-0.03em] text-fg">
        {money(summary.total, currency)}
      </div>
      {parts.length > 0 && (
        <div className="mt-3">
          <AllocationBar parts={parts} compact />
        </div>
      )}
      <div className="mt-2 font-mono text-[0.66rem] text-overlay1">
        {[
          summary.asOf ? `looked up ${ago(summary.asOf)}` : null,
          folio.refreshing ? 'looking…' : null,
          summary.failed.length > 0 ? `${summary.failed.length} couldn’t be looked up` : null
        ]
          .filter(Boolean)
          .join(' · ') || ' '}
      </div>
    </>
  )
}
