/**
 * maki desktop's Portfolio: what the accounts maki shared hold, all together, and what that comes to
 * in the owner's currency.
 *
 * Each account is looked up the way its wallet card looks it up (btc-wallet.ts, eth-wallet.ts,
 * sol-wallet.ts, account-chain.ts), through the same servers and the main process's same queues,
 * one after another: a look is one account on one network. What each look found is kept by wallet,
 * in a small file of the main process's (wallets.ts): the amounts, and when they were found out. No
 * prices (they're asked for fresh), no keys, no addresses. So the page shows the last of them at
 * once, and the Overview its total. Values are worked out where they're shown, from CoinGecko's
 * prices (prices.ts), which are asked for only once the owner has chosen a currency. Test networks'
 * coins are worth nothing: they aren't looked up, or counted.
 *
 * No Node or DOM imports: the main process checks what's kept with it; the window and tests use it.
 */
import { CURRENCIES, worth, type Currency, type Prices } from './prices'

/** A coin or token a look found, and how much of it: what isn't held isn't kept. */
export interface Held {
  /** the symbol its price is kept under (prices.ts); null for a token maki doesn't know */
  symbol: string | null
  /** what the page calls it: its symbol, or a token's name or ID, shortened */
  name: string
  /** in its smallest units: more than nothing */
  amount: bigint
  decimals: number
}

/** An account on one network, as the Portfolio last looked it up. */
export interface Look {
  /** the wallet it's in, as the Wallets page has a card for each: 'bitcoin', 'ethereum', 'tron' */
  coin: string
  /** which of the wallet's accounts or networks it is: "native SegWit", "Base" */
  where: string
  /** when what it holds was last found out; null if it never has been */
  at: number | null
  /** when it was last tried: later than `at` when that failed, and what it held stays as it was */
  tried: number
  held: Held[]
  /**
   * Monero's: the block its own wallet had scanned to when the Portfolio read what it found (that
   * wallet keeps no time, and the Portfolio never scans), `at` being when the Portfolio read it
   */
  block?: number
}

/** The total on a day the page looked everything up, in the currency it was worked out in. */
export interface Day {
  /** on this computer's calendar: 2026-10-02 */
  day: string
  currency: Currency
  total: number
}

/** What the Portfolio keeps for one of maki's wallets. */
export interface Kept {
  /** each account on each network, by a key of its own: 'bitcoin:segwit', 'ethereum:8453' */
  looks: Record<string, Look>
  /** the total, a day at a time, oldest first */
  days: Day[]
}

/** How many looks are kept at most: Ethereum's 21 networks and every other wallet's, with room. */
export const MAX_LOOKS = 160
/** How many coins and tokens a look keeps at most. */
export const MAX_HELD = 40
/** How many days of the total are kept: a year of them, and some. */
export const MAX_DAYS = 400
/**
 * A look tried this recently, which went well, isn't tried again when the page opens (the button
 * tries everything): the wallet cards' own wait before they look again.
 */
export const FRESH_MS = 60_000

/** Nothing kept yet. */
export const emptyKept = (): Kept => ({ looks: {}, days: [] })

const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const KEY = /^[a-z0-9][a-z0-9:._-]{0,47}$/
const COIN = /^[a-z0-9-]{1,24}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** Text a person reads: a line, short, of no control characters. */
const isLabel = (v: unknown, most: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= most && !/\p{Cc}/u.test(v)

function readHeld(v: unknown): Held | null {
  const h = v as Record<string, unknown> | null
  if (typeof h !== 'object' || h === null) return null
  const { symbol, name, amount, decimals } = h
  if (symbol !== null && !isLabel(symbol, 24)) return null
  if (!isLabel(name, 48)) return null
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 40)
    return null
  const n =
    typeof amount === 'bigint'
      ? amount
      : typeof amount === 'string' && /^\d{1,80}$/.test(amount)
        ? BigInt(amount)
        : null
  if (n === null || n <= 0n || n >= 10n ** 80n) return null
  return { symbol, name, amount: n, decimals: decimals as number }
}

function readLook(v: unknown): Look | null {
  const l = v as Record<string, unknown> | null
  if (typeof l !== 'object' || l === null) return null
  const { coin, where, at, tried, held, block } = l
  if (typeof coin !== 'string' || !COIN.test(coin) || !isLabel(where, 48)) return null
  if ((at !== null && !isTime(at)) || !isTime(tried)) return null
  if (block !== undefined && !isTime(block)) return null
  if (!Array.isArray(held) || held.length > MAX_HELD) return null
  const all = held.map(readHeld)
  if (all.some((h) => h === null)) return null
  return {
    coin,
    where,
    at,
    tried,
    held: all as Held[],
    ...(block !== undefined && { block: block as number })
  }
}

function readDay(v: unknown): Day | null {
  const d = v as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return null
  const { day, currency, total } = d
  if (typeof day !== 'string' || !DAY.test(day)) return null
  if (!CURRENCIES.includes(currency as Currency)) return null
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > 1e18) return null
  return { day, currency: currency as Currency, total }
}

/**
 * What was kept (or sent to be kept), as the Portfolio keeps it: each look and day checked, and any
 * that isn't one dropped, with anything else that came with them; nothing at all if it isn't one.
 */
export function readKept(v: unknown): Kept {
  const out = emptyKept()
  const o = v as { looks?: unknown; days?: unknown } | null
  if (typeof o !== 'object' || o === null) return out
  if (typeof o.looks === 'object' && o.looks !== null && !Array.isArray(o.looks)) {
    for (const [key, value] of Object.entries(o.looks).slice(0, MAX_LOOKS)) {
      const look = KEY.test(key) ? readLook(value) : null
      if (look) out.looks[key] = look
    }
  }
  if (Array.isArray(o.days))
    out.days = o.days
      .slice(-MAX_DAYS)
      .map(readDay)
      .filter((d): d is Day => d !== null)
  return out
}

/** What's kept as JSON has it: amounts as decimal digits (JSON has no big numbers). */
export function keptJson(k: Kept): unknown {
  return {
    looks: Object.fromEntries(
      Object.entries(k.looks).map(([key, l]) => [
        key,
        { ...l, held: l.held.map((h) => ({ ...h, amount: h.amount.toString() })) }
      ])
    ),
    days: k.days
  }
}

/**
 * What a look at `key` found, at `now`: what's held, more than nothing of each; if there were ever
 * more than are kept, the coins and tokens with a price first.
 */
export function found(
  kept: Kept,
  key: string,
  look: { coin: string; where: string; held: Held[]; block?: number },
  now: number
): Kept {
  const some = look.held.filter((h) => h.amount > 0n)
  const held = [
    ...some.filter((h) => h.symbol !== null),
    ...some.filter((h) => h.symbol === null)
  ].slice(0, MAX_HELD)
  return {
    ...kept,
    looks: {
      ...kept.looks,
      [key]: {
        coin: look.coin,
        where: look.where,
        at: now,
        tried: now,
        held,
        ...(look.block !== undefined && { block: look.block })
      }
    }
  }
}

/** A look at `key` that failed at `now`: what it last found stays, as it was then. */
export function failed(
  kept: Kept,
  key: string,
  look: { coin: string; where: string },
  now: number
): Kept {
  const was = kept.looks[key]
  return {
    ...kept,
    looks: {
      ...kept.looks,
      [key]: was
        ? { ...was, coin: look.coin, where: look.where, tried: now }
        : { coin: look.coin, where: look.where, at: null, tried: now, held: [] }
    }
  }
}

/** Only the looks at `keys`: those of accounts that are no longer shared go. */
export function only(kept: Kept, keys: string[]): Kept {
  return {
    ...kept,
    looks: Object.fromEntries(Object.entries(kept.looks).filter(([k]) => keys.includes(k)))
  }
}

/** Whether a look's last try failed (or none ever went well). */
export const isFailed = (l: Look): boolean => l.at === null || l.tried > l.at

/** Whether a look went well so recently that opening the page doesn't try it again. */
export const isFresh = (l: Look | undefined, now: number): boolean =>
  !!l && !isFailed(l) && now - l.tried < FRESH_MS

/** Where some of a coin or token is: a look's, and how much. */
export interface Place {
  key: string
  coin: string
  where: string
  amount: bigint
  decimals: number
  /** whether it's as it was before the look's last try, which failed */
  stale: boolean
}

/** A coin or token, all of it, wherever it is. */
export interface Row {
  /** its symbol; for a token maki doesn't know, its wallet and name */
  id: string
  symbol: string | null
  name: string
  /** all of it, in `decimals` (the most of its places') */
  amount: bigint
  decimals: number
  places: Place[]
  /** one of it, in money; null without a price */
  price: number | null
  value: number | null
  /** of the total, from 0 to 1; null without a value, or with a total of nothing */
  share: number | null
  /** whether any of it is as it was before a look that failed */
  stale: boolean
}

/** The Portfolio, worked out. */
export interface Summary {
  /** what's held: the most valuable first, then what has no value, by name */
  rows: Row[]
  /** what the rows with a value come to (nothing, if none has one); null without prices */
  total: number | null
  /**
   * the oldest time a look found out what it holds (Monero's aside, which says its block): the
   * total is at least this fresh; null if nothing has been found out
   */
  asOf: number | null
  /** the looks whose last try failed */
  failed: { key: string; look: Look }[]
}

/** `amount` in `from` decimals, in `to` (no fewer). */
const scale = (amount: bigint, from: number, to: number): bigint =>
  amount * 10n ** BigInt(to - from)

/**
 * The Portfolio as the page shows it: each coin and token added up wherever it is (by its symbol,
 * which is what its price is kept under), its value and share in `prices`' currency, and what the
 * whole comes to. Without prices, the amounts alone.
 */
export function summarize(kept: Kept, prices: Prices | null): Summary {
  const rows = new Map<string, Row>()
  let asOf: number | null = null
  const failedLooks: Summary['failed'] = []
  for (const [key, look] of Object.entries(kept.looks)) {
    const stale = isFailed(look)
    if (stale) failedLooks.push({ key, look })
    if (look.at !== null && look.block === undefined) asOf = Math.min(asOf ?? look.at, look.at)
    for (const h of look.held) {
      const id = h.symbol ?? `${look.coin}:${h.name}`
      let row = rows.get(id)
      if (!row) {
        row = {
          id,
          symbol: h.symbol,
          name: h.symbol ?? h.name,
          amount: 0n,
          decimals: h.decimals,
          places: [],
          price: null,
          value: null,
          share: null,
          stale: false
        }
        rows.set(id, row)
      }
      if (h.decimals > row.decimals) {
        row.amount = scale(row.amount, row.decimals, h.decimals)
        row.decimals = h.decimals
      }
      row.amount += scale(h.amount, h.decimals, row.decimals)
      row.places.push({
        key,
        coin: look.coin,
        where: look.where,
        amount: h.amount,
        decimals: h.decimals,
        stale
      })
      row.stale ||= stale
    }
  }
  let total: number | null = prices ? 0 : null
  for (const row of rows.values()) {
    if (row.symbol === null || !prices) continue
    row.price = worth(prices, row.symbol, 1n, 0)
    row.value = worth(prices, row.symbol, row.amount, row.decimals)
    if (row.value !== null) total = (total ?? 0) + row.value
  }
  for (const row of rows.values())
    row.share = row.value !== null && total !== null && total > 0 ? row.value / total : null
  const byName = (a: Row, b: Row): number => a.name.localeCompare(b.name)
  const sorted = [...rows.values()].sort((a, b) =>
    a.value !== null && b.value !== null
      ? b.value - a.value || byName(a, b)
      : a.value !== null
        ? -1
        : b.value !== null
          ? 1
          : byName(a, b)
  )
  for (const row of sorted) row.places.sort((a, b) => a.where.localeCompare(b.where))
  return { rows: sorted, total, asOf, failed: failedLooks }
}

/** How many coins and tokens the allocation shows on their own: past it, the smallest are Other. */
export const MAX_SEGMENTS = 8

/** A part of the allocation: a coin or token, or the rest together. */
export interface Segment {
  /** the row's ID; null for Other */
  id: string | null
  name: string
  value: number
  /** of the total, from 0 to 1 */
  share: number
  /** its colour's place among the chart's colours; null for Other, which has the quiet one */
  slot: number | null
}

/**
 * The total shared out among what has a value: each coin or token its own part (or, past
 * MAX_SEGMENTS, the most valuable less one, and the rest as Other, last). The parts go in the order
 * their accounts were looked up, not by value, and take their colours in that order, so each keeps
 * its colour as prices move.
 */
export function allocation(kept: Kept, summary: Summary): Segment[] {
  const total = summary.total
  if (total === null || total <= 0) return []
  const valued = summary.rows.filter((r) => r.value !== null && r.value > 0)
  const own = valued.length > MAX_SEGMENTS ? valued.slice(0, MAX_SEGMENTS - 1) : valued
  const rest = valued.slice(own.length)
  const keys = Object.keys(kept.looks)
  const first = (r: Row): number => Math.min(...r.places.map((p) => keys.indexOf(p.key)))
  const parts: Segment[] = [...own]
    .sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name))
    .map((r, i) => ({ id: r.id, name: r.name, value: r.value!, share: r.value! / total, slot: i }))
  if (rest.length > 0) {
    const value = rest.reduce((n, r) => n + r.value!, 0)
    parts.push({ id: null, name: 'Other', value, share: value / total, slot: null })
  }
  return parts
}

/** The looks of each wallet, in the order they were kept (which is the order they're looked up). */
export function byCoin(kept: Kept): { coin: string; looks: { key: string; look: Look }[] }[] {
  const out: { coin: string; looks: { key: string; look: Look }[] }[] = []
  for (const [key, look] of Object.entries(kept.looks)) {
    let group = out.find((g) => g.coin === look.coin)
    if (!group) out.push((group = { coin: look.coin, looks: [] }))
    group.looks.push({ key, look })
  }
  return out
}

/** A day on this computer's calendar, as the days of the total are kept: 2026-10-02. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/**
 * The total on `day`, in `currency`: one a day for each currency (a later one that day takes its
 * place), the oldest going once there are more than MAX_DAYS.
 */
export function recordDay(kept: Kept, day: string, currency: Currency, total: number): Kept {
  if (!DAY.test(day) || !Number.isFinite(total) || total < 0) return kept
  const days = kept.days
    .filter((d) => !(d.day === day && d.currency === currency))
    .concat({ day, currency, total })
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-MAX_DAYS)
  return { ...kept, days }
}
