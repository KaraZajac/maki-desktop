/**
 * The Esplora calls maki desktop's Bitcoin-kind wallet makes (`BtcWallet`), answered from an
 * Electrum server (the protocol Electron Cash and Bitcoin Cash's wallets use, served by Fulcrum):
 * for a chain with no Esplora of its own. Electrum knows scripts by their hash, so each address is
 * turned into the script it pays, and each transaction is read here from its raw bytes; amounts
 * spent come from the transactions spent, block times from their blocks' headers. Coins carrying
 * CashTokens are left out: maki won't spend them.
 *
 * No Node or DOM imports: the main process gives it a way to ask the server (`ElectrumCall`).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { decodeCashAddr, encodeCashAddr } from './cashaddr'

/** One Electrum request: its method and parameters, and the server's result. */
export type ElectrumCall = (method: string, params: unknown[]) => Promise<unknown>

/** How addresses read and write on the chain the server serves. */
export interface ElectrumChain {
  /** the script an address pays; null if it isn't one of this chain's */
  script(address: string): Uint8Array | null
  /** the address a script pays, if it has one */
  address(script: Uint8Array): string | undefined
}

/** Bitcoin Cash's addresses: CashAddr with `prefix`, and the base58 forms it takes too. */
export function cashChain(prefix: string, base58: typeof btc.NETWORK): ElectrumChain {
  return {
    script(address) {
      const cash = decodeCashAddr(address, prefix)
      if (cash)
        return btc.OutScript.encode({ type: cash.kind === 'p2pkh' ? 'pkh' : 'sh', hash: cash.hash })
      try {
        const decoded = btc.Address(base58).decode(address)
        return decoded.type === 'pkh' || decoded.type === 'sh'
          ? btc.OutScript.encode(decoded)
          : null
      } catch {
        return null
      }
    },
    address(script) {
      try {
        const out = btc.OutScript.decode(script)
        if (out.type === 'pkh') return encodeCashAddr(prefix, 'p2pkh', out.hash)
        if (out.type === 'sh') return encodeCashAddr(prefix, 'p2sh', out.hash)
      } catch {
        // a script with no address
      }
      return undefined
    }
  }
}

/** Electrum's name for a script: SHA-256 of it, the bytes reversed, in hex. */
export const scripthash = (script: Uint8Array): string => hex.encode(sha256(script).reverse())

/** Esplora's answers have at most this many transactions an address's: its newest. */
const TXS = 50

interface History {
  tx_hash: string
  height: number
}
interface Unspent {
  tx_hash: string
  tx_pos: number
  height: number
  value: number
  token_data?: unknown
}

/**
 * The Esplora paths `BtcWallet` asks (an address's totals, its coins and its transactions, a
 * transaction's bytes, a broadcast, fee rates), answered from `call`. Transactions and block times
 * are kept: they don't change.
 */
export function electrumEsplora(
  call: ElectrumCall,
  chain: ElectrumChain
): (path: string, body?: string) => Promise<string> {
  const raw = new Map<string, Uint8Array>()
  const times = new Map<number, number>()

  const rawTx = async (txid: string): Promise<Uint8Array> => {
    let bytes = raw.get(txid)
    if (!bytes) {
      const got = await call('blockchain.transaction.get', [txid, false])
      if (typeof got !== 'string' || !/^([0-9a-f]{2})+$/.test(got))
        throw new Error('the server sent no transaction')
      bytes = hex.decode(got)
      raw.set(txid, bytes)
    }
    return bytes
  }
  const blockTime = async (height: number): Promise<number | undefined> => {
    if (height <= 0) return undefined
    let t = times.get(height)
    if (t === undefined) {
      const header = await call('blockchain.block.header', [height])
      if (typeof header !== 'string' || header.length < 160) return undefined
      // the header's time: bytes 68 to 72, little-endian
      const b = hex.decode(header.slice(136, 144))
      t = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] * 2 ** 24)
      times.set(height, t)
    }
    return t
  }
  const hashOf = (address: string): string => {
    const script = chain.script(address)
    if (!script) throw new Error('not an address of this chain')
    return scripthash(script)
  }
  const describe = async (txid: string, height: number): Promise<unknown> => {
    const bytes = await rawTx(txid)
    const tx = btc.RawTx.decode(bytes)
    const vin = await Promise.all(
      tx.inputs.map(async (i) => {
        const prevId = hex.encode(i.txid)
        let prevout: { scriptpubkey_address?: string; value: number } | null = null
        if (!/^0{64}$/.test(prevId)) {
          const prev = btc.RawTx.decode(await rawTx(prevId))
          const o = prev.outputs[i.index]
          if (o)
            prevout = { scriptpubkey_address: chain.address(o.script), value: Number(o.amount) }
        }
        return { txid: prevId, vout: i.index, sequence: i.sequence, prevout }
      })
    )
    const vout = tx.outputs.map((o) => ({
      scriptpubkey_address: chain.address(o.script),
      value: Number(o.amount)
    }))
    const fee =
      vin.reduce((n, i) => n + (i.prevout?.value ?? 0), 0) - vout.reduce((n, o) => n + o.value, 0)
    const confirmed = height > 0
    return {
      txid,
      fee: Math.max(0, fee),
      weight: bytes.length * 4,
      status: { confirmed, block_time: confirmed ? await blockTime(height) : undefined },
      vin,
      vout
    }
  }

  return async (path, body) => {
    if (path === '/tx' && body !== undefined) {
      const txid = await call('blockchain.transaction.broadcast', [body])
      if (typeof txid !== 'string') throw new Error('the server didn’t take it')
      return txid
    }
    if (path === '/v1/fees/recommended') {
      // coins a kilobyte, as satoshis a byte to the hundredth, never below the relay fee
      const relay = Number(await call('blockchain.relayfee', []))
      const estimate = Number(await call('blockchain.estimatefee', [2]).catch(() => -1))
      const perKb = Math.max(relay > 0 ? relay : 0.00001, estimate)
      const rate = Math.ceil((perKb * 1e8) / 10) / 100
      return JSON.stringify({
        fastestFee: rate,
        halfHourFee: rate,
        hourFee: rate,
        economyFee: rate,
        minimumFee: rate
      })
    }
    let m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path)
    if (m) return hex.encode(await rawTx(m[1]))
    m = /^\/address\/([^/]+)(\/utxo|\/txs)?$/.exec(path)
    if (!m) throw new Error('not something the wallet asks')
    const hash = hashOf(m[1])
    if (m[2] === '/utxo') {
      const coins = (await call('blockchain.scripthash.listunspent', [hash])) as Unspent[]
      return JSON.stringify(
        coins
          .filter((c) => c.token_data === undefined)
          .map((c) => ({
            txid: c.tx_hash,
            vout: c.tx_pos,
            value: c.value,
            status: { confirmed: c.height > 0 }
          }))
      )
    }
    const history = (await call('blockchain.scripthash.get_history', [hash])) as History[]
    if (m[2] === '/txs') {
      // the newest first, those waiting for a block before them, as Esplora has them
      const newest = [...history]
        .sort(
          (a, b) => (b.height <= 0 ? Infinity : b.height) - (a.height <= 0 ? Infinity : a.height)
        )
        .slice(0, TXS)
      return JSON.stringify(await Promise.all(newest.map((h) => describe(h.tx_hash, h.height))))
    }
    const balance = (await call('blockchain.scripthash.get_balance', [hash])) as {
      confirmed: number
      unconfirmed: number
    }
    const waiting = history.filter((h) => h.height <= 0).length
    const stats = (sum: number, count: number): unknown => ({
      funded_txo_sum: Math.max(0, sum),
      spent_txo_sum: Math.max(0, -sum),
      tx_count: count
    })
    return JSON.stringify({
      chain_stats: stats(balance.confirmed, history.length - waiting),
      mempool_stats: stats(balance.unconfirmed, waiting)
    })
  }
}
