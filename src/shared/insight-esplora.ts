/**
 * The Esplora calls maki desktop's Bitcoin-kind wallet makes (`BtcWallet`), answered from an
 * Insight API (bitcore's, which Dash's own explorer runs): for Dash, which has no Esplora. Each
 * answer is checked before it's believed: amounts are whole duffs (or decimal text with eight
 * places, read exactly), a transaction's bytes must hash to its ID, and a broadcast's ID must be the
 * transaction's. Dash's transactions are Bitcoin's from before SegWit, some with a special
 * transaction's payload after them (DIP-2): their ID is still the hash of their bytes as they are.
 *
 * No Node or DOM imports: the main process gives it a way to ask the server (`InsightCall`).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

/** One request to the Insight API: a GET, or a POST of JSON; its status and its body's text. */
export type InsightCall = (path: string, json?: string) => Promise<{ status: number; text: string }>

/** A transaction's ID from its bytes: their double SHA-256, reversed, as explorers write it. */
export const txidOf = (raw: Uint8Array): string => hex.encode(sha256(sha256(raw)).reverse())

const isTxid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const duffs = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('the server sent an amount that isn’t one')
  return v
}
/** Insight's outputs' amounts: decimal text, eight places at most, read exactly. */
function coins(v: unknown): number {
  const m = typeof v === 'string' ? /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(v) : null
  if (!m) throw new Error('the server sent an amount that isn’t one')
  return duffs(Number(m[1]) * 1e8 + Number((m[2] ?? '').padEnd(8, '0')))
}

interface InsightTx {
  txid: string
  confirmations?: number
  blocktime?: number
  size?: number
  isCoinBase?: boolean
  vin: { txid?: string; vout?: number; sequence?: number; addr?: string; valueSat?: number }[]
  vout: { value: string; scriptPubKey?: { addresses?: string[] } }[]
}

/**
 * The Esplora paths `BtcWallet` asks (an address's totals, its coins and its transactions, a
 * transaction's bytes, a broadcast, fee rates), answered from `call`.
 */
export function insightEsplora(
  call: InsightCall
): (path: string, body?: string) => Promise<string> {
  const get = async (path: string, json?: string): Promise<unknown> => {
    const r = await call(path, json)
    if (r.status !== 200)
      throw new Error(
        /^[^<]{1,300}$/.test(r.text.trim())
          ? `Insight: ${r.text.trim()}`
          : `Insight answered ${r.status}`
      )
    try {
      return JSON.parse(r.text)
    } catch {
      throw new Error('Insight sent something maki desktop can’t read')
    }
  }

  /** A transaction as Esplora describes it, from Insight's description. */
  const describe = (t: InsightTx): object => {
    if (!isTxid(t.txid) || !Array.isArray(t.vin) || !Array.isArray(t.vout))
      throw new Error('Insight sent a transaction maki desktop can’t read')
    const vin = t.vin.map((i) =>
      t.isCoinBase || i.txid === undefined
        ? { prevout: null }
        : {
            txid: isTxid(i.txid) ? i.txid : '',
            vout: i.vout,
            sequence: i.sequence,
            prevout: { scriptpubkey_address: i.addr, value: duffs(i.valueSat) }
          }
    )
    const vout = t.vout.map((o) => ({
      scriptpubkey_address:
        o.scriptPubKey?.addresses?.length === 1 ? o.scriptPubKey.addresses[0] : undefined,
      value: coins(o.value)
    }))
    const into = vin.reduce((n, i) => n + (i.prevout?.value ?? 0), 0)
    const out = vout.reduce((n, o) => n + o.value, 0)
    const confirmed = (t.confirmations ?? 0) > 0
    return {
      txid: t.txid,
      fee: t.isCoinBase ? 0 : Math.max(0, into - out),
      weight: typeof t.size === 'number' ? t.size * 4 : undefined,
      status: { confirmed, block_time: confirmed ? t.blocktime : undefined },
      vin,
      vout
    }
  }

  return async (path, body) => {
    if (path === '/tx' && body !== undefined) {
      const r = (await get('/tx/send', JSON.stringify({ rawtx: body }))) as { txid?: unknown }
      // the ID the server says must be the one of what was sent
      if (r.txid !== txidOf(hex.decode(body)))
        throw new Error('Insight took a different transaction')
      return r.txid
    }
    if (path === '/v1/fees/recommended') {
      // Insight's fee estimate doesn't answer: the network's relay fee, coins a kilobyte, is it
      const r = (await get('/status?q=getInfo')) as { info?: { relayfee?: unknown } }
      const perKb = r.info?.relayfee
      if (typeof perKb !== 'number' || !(perKb > 0) || perKb > 0.01)
        throw new Error('Insight sent a fee maki desktop can’t read')
      // whole duffs a kilobyte first: 0.00001 × 10⁸ isn't 1000 in floating point
      const rate = Math.max(1, Math.ceil(Math.round(perKb * 1e8) / 1000))
      return JSON.stringify({
        fastestFee: rate,
        halfHourFee: rate,
        hourFee: rate,
        economyFee: rate,
        minimumFee: rate
      })
    }
    let m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path)
    if (m) {
      const r = (await get(`/rawtx/${m[1]}`)) as { rawtx?: unknown }
      if (
        typeof r.rawtx !== 'string' ||
        !/^([0-9a-f]{2})+$/.test(r.rawtx) ||
        txidOf(hex.decode(r.rawtx)) !== m[1]
      )
        throw new Error('Insight sent a transaction that isn’t the one asked for')
      return r.rawtx
    }
    m = /^\/address\/([1-9A-HJ-NP-Za-km-z]{25,40})(\/utxo|\/txs)?$/.exec(path)
    if (!m) throw new Error('not something the wallet asks')
    const address = m[1]
    if (m[2] === '/utxo') {
      const coins_ = (await get(`/addrs/${address}/utxo`)) as unknown
      if (!Array.isArray(coins_)) throw new Error('Insight sent coins maki desktop can’t read')
      return JSON.stringify(
        (
          coins_ as {
            address?: unknown
            txid?: unknown
            vout?: unknown
            satoshis?: unknown
            confirmations?: unknown
          }[]
        )
          .filter((c) => c.address === address)
          .map((c) => {
            if (!isTxid(c.txid) || typeof c.vout !== 'number' || !Number.isSafeInteger(c.vout))
              throw new Error('Insight sent a coin maki desktop can’t read')
            return {
              txid: c.txid,
              vout: c.vout,
              value: duffs(c.satoshis),
              status: { confirmed: typeof c.confirmations === 'number' && c.confirmations > 0 }
            }
          })
      )
    }
    if (m[2] === '/txs') {
      const r = (await get(`/txs?address=${address}&pageNum=0`)) as { txs?: unknown }
      if (!Array.isArray(r.txs)) throw new Error('Insight sent history maki desktop can’t read')
      return JSON.stringify((r.txs as InsightTx[]).map(describe))
    }
    const a = (await get(`/addr/${address}?noTxList=1`)) as Record<string, unknown>
    if (a.addrStr !== address) throw new Error('Insight sent another address')
    const confirmed = duffs(a.balanceSat)
    const waiting = a.unconfirmedBalanceSat
    if (typeof waiting !== 'number' || !Number.isSafeInteger(waiting))
      throw new Error('Insight sent an amount that isn’t one')
    const count = (v: unknown): number =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
    return JSON.stringify({
      chain_stats: {
        funded_txo_sum: confirmed,
        spent_txo_sum: 0,
        tx_count: count(a.txAppearances ?? a.txApperances)
      },
      mempool_stats: {
        funded_txo_sum: Math.max(0, waiting),
        spent_txo_sum: Math.max(0, -waiting),
        tx_count: count(a.unconfirmedAppearances ?? a.unconfirmedTxApperances)
      }
    })
  }
}
