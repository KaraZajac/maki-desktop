/**
 * maki's Bitcoin accounts as a wallet in maki desktop: their balance and activity, a fresh address
 * to receive at, and sending, which maki shows and signs.
 *
 * maki desktop has only what maki shares for wallet software, the account's descriptor (its
 * master key's fingerprint, its path and its xpub): enough to work out every address, never to
 * spend. The chain comes from Esplora (mempool.space's API), which sees the account's addresses
 * and this computer's IP address. A send is a PSBT made the way maki reads them (the whole
 * previous transaction of each native SegWit coin, each key's derivation, and change marked as
 * change), and maki goes through every output and the fee with its owner before it signs.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { HDKey } from '@scure/bip32'
import { createBase58check, hex } from '@scure/base'
import * as btc from '@scure/btc-signer'

export type BtcNetwork = 'bitcoin' | 'test'
export type BtcKind = 'segwit' | 'taproot'

/** An account, as its descriptor says. */
export interface BtcAccountInfo {
  kind: BtcKind
  network: BtcNetwork
  /** the master key's fingerprint, as PSBTs carry it */
  fingerprint: number
  /** from the master key to the account: purpose', coin', account' */
  path: number[]
  xpub: string
  descriptor: string
}

/** Esplora's API, on the main process's side: a path under the network's API; with a body, a POST. */
export type Esplora = (network: BtcNetwork, path: string, body?: string) => Promise<string>

const HARDENED = 0x80000000
/** Unused addresses in a row that end a scan, as wallets agree (BIP44). */
export const GAP = 20
/** Change smaller than this isn't worth an output: it goes to the fee. */
export const DUST = 546n

const VERSIONS = {
  bitcoin: { private: 0x0488ade4, public: 0x0488b21e },
  test: { private: 0x04358394, public: 0x043587cf }
}
const NETWORKS = { bitcoin: btc.NETWORK, test: btc.TEST_NETWORK }

/** Where to look a transaction or an address up on the web. */
export const EXPLORER = { bitcoin: 'https://mempool.space', test: 'https://mempool.space/testnet4' }

/**
 * The account's key as wallet software takes it on its own: a zpub (vpub on the test network) for
 * native SegWit, as SLIP-132 has them; an xpub (tpub) for taproot, which has no such prefix.
 */
export function walletKey(info: BtcAccountInfo): string {
  const b58 = createBase58check(sha256)
  const key = b58.decode(info.xpub)
  const version =
    info.kind === 'segwit'
      ? info.network === 'bitcoin'
        ? 0x04b24746
        : 0x045f1cf6
      : VERSIONS[info.network].public
  new DataView(key.buffer, key.byteOffset).setUint32(0, version)
  return b58.encode(key)
}

/** The account a descriptor of maki's describes; throws if it isn't one. */
export function parseDescriptor(descriptor: string): BtcAccountInfo {
  const m =
    /^(wpkh|tr)\(\[([0-9a-f]{8})\/(\d+)h\/(\d+)h\/(\d+)h\]([1-9A-HJ-NP-Za-km-z]+)\/<0;1>\/\*\)(#[0-9a-z]{8})?$/.exec(
      descriptor.trim()
    )
  if (!m) throw new Error('not a descriptor of maki’s')
  const [, fn, fp, purpose, coin, account, xpub] = m
  const kind: BtcKind = fn === 'wpkh' ? 'segwit' : 'taproot'
  if ((kind === 'segwit' && purpose !== '84') || (kind === 'taproot' && purpose !== '86'))
    throw new Error('not a descriptor of maki’s')
  if (coin !== '0' && coin !== '1') throw new Error('not a Bitcoin descriptor')
  return {
    kind,
    network: coin === '0' ? 'bitcoin' : 'test',
    fingerprint: parseInt(fp, 16),
    path: [purpose, coin, account].map((n) => Number(n) + HARDENED),
    xpub,
    descriptor: descriptor.trim()
  }
}

/** An address of the account's: on the receiving chain (0) or change (1). */
export interface BtcAddress {
  chain: 0 | 1
  index: number
  address: string
  /** 33 bytes */
  publicKey: Uint8Array
  script: Uint8Array
}

export class BtcKeys {
  private account: HDKey
  private cache = new Map<string, BtcAddress>()

  constructor(readonly info: BtcAccountInfo) {
    this.account = HDKey.fromExtendedKey(info.xpub, VERSIONS[info.network])
  }

  get network(): typeof btc.NETWORK {
    return NETWORKS[this.info.network]
  }

  address(chain: 0 | 1, index: number): BtcAddress {
    const key = `${chain}/${index}`
    const known = this.cache.get(key)
    if (known) return known
    const publicKey = this.account.deriveChild(chain).deriveChild(index).publicKey!
    const pay =
      this.info.kind === 'segwit'
        ? btc.p2wpkh(publicKey, this.network)
        : btc.p2tr(publicKey.slice(1), undefined, this.network)
    const a = { chain, index, address: pay.address!, publicKey, script: pay.script }
    this.cache.set(key, a)
    return a
  }

  /** Its derivation from the master key, as a PSBT gives it maki. */
  derivation(a: BtcAddress): { fingerprint: number; path: number[] } {
    return { fingerprint: this.info.fingerprint, path: [...this.info.path, a.chain, a.index] }
  }
}

/** A coin the account holds. */
export interface BtcCoin {
  txid: string
  vout: number
  value: bigint
  address: BtcAddress
  confirmed: boolean
}

/** A transaction that touched the account: what it did to it. */
export interface BtcActivity {
  txid: string
  /** what came in, less what went out, in satoshis */
  net: bigint
  fee: bigint
  /** unix seconds, once it's in a block */
  time: number | null
}

export interface BtcWalletState {
  confirmed: bigint
  pending: bigint
  coins: BtcCoin[]
  activity: BtcActivity[]
  /** where to receive next: the first address after the last one used */
  receive: BtcAddress
  /** where change goes next */
  change: BtcAddress
}

interface Stats {
  funded_txo_sum: number
  spent_txo_sum: number
  tx_count: number
}

interface EsploraTx {
  txid: string
  fee: number
  status: { confirmed: boolean; block_time?: number }
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[]
  vout: { scriptpubkey_address?: string; value: number }[]
}

interface Utxo {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean }
}

/** Fee rates mempool.space recommends, in sat/vB. */
export interface FeeRates {
  fastestFee: number
  halfHourFee: number
  hourFee: number
  economyFee: number
  minimumFee: number
}

/** A payment, worked out: the coins it spends, and what goes where, in satoshis. */
export interface BtcPlan {
  /** the output script paid */
  to: Uint8Array
  coins: BtcCoin[]
  sent: bigint
  fee: bigint
  change: bigint
  /** the transaction's size, near enough */
  vbytes: number
}

/** Virtual bytes, as the network counts them. */
const OVERHEAD_VB = 10.5
const INPUT_VB = { segwit: 68, taproot: 57.5 }
const outputVb = (script: Uint8Array): number => 9 + script.length

export class BtcWallet {
  readonly keys: BtcKeys
  /** each used address as the last look found it, to look again only at those that changed */
  private known = new Map<
    string,
    { count: number; waiting: number; utxos: Utxo[]; txs: EsploraTx[] }
  >()

  constructor(
    info: BtcAccountInfo,
    private esplora: Esplora
  ) {
    this.keys = new BtcKeys(info)
  }

  private get(path: string): Promise<string> {
    return this.esplora(this.keys.info.network, path)
  }

  /**
   * Both chains, until GAP unused addresses in a row: the balance, the coins, the activity.
   * `progress` hears how many addresses it has looked at so far.
   */
  async scan(progress?: (addresses: number) => void): Promise<BtcWalletState> {
    let confirmed = 0n
    let pending = 0n
    let looked = 0
    const used: BtcAddress[] = []
    // those with coins on them now: only they have any to list
    const funded = new Set<string>()
    // how many transactions each used address has, and how many of them wait for a block
    const counts = new Map<string, { count: number; waiting: number }>()
    const next = { 0: 0, 1: 0 }
    for (const chain of [0, 1] as const) {
      let unused = 0
      for (let start = 0; unused < GAP; start += 5) {
        // five at a time: fewer round trips, and still gentle on the server
        const batch = [0, 1, 2, 3, 4].map((i) => this.keys.address(chain, start + i))
        const stats = await Promise.all(
          batch.map(
            async (a) =>
              JSON.parse(await this.get(`/address/${a.address}`)) as {
                chain_stats: Stats
                mempool_stats: Stats
              }
          )
        )
        for (const [i, s] of stats.entries()) {
          if (unused >= GAP) break
          if (s.chain_stats.tx_count + s.mempool_stats.tx_count > 0) {
            used.push(batch[i])
            unused = 0
            next[chain] = batch[i].index + 1
            const inChain = BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum)
            const inMempool = BigInt(s.mempool_stats.funded_txo_sum - s.mempool_stats.spent_txo_sum)
            confirmed += inChain
            pending += inMempool
            if (inChain + inMempool > 0n) funded.add(batch[i].address)
            counts.set(batch[i].address, {
              count: s.chain_stats.tx_count + s.mempool_stats.tx_count,
              waiting: s.mempool_stats.tx_count
            })
          } else {
            unused++
          }
        }
        progress?.((looked += batch.length))
      }
    }
    const ours = new Map(used.map((a) => [a.address, a]))
    const coins: BtcCoin[] = []
    const seen = new Map<string, EsploraTx>()
    await Promise.all(
      used.map(async (a) => {
        const now = counts.get(a.address)!
        let known = this.known.get(a.address)
        // an address whose transactions are all in blocks, as they were last time, is as it was
        if (!known || known.count !== now.count || known.waiting > 0 || now.waiting > 0) {
          const utxos = funded.has(a.address)
            ? (JSON.parse(await this.get(`/address/${a.address}/utxo`)) as Utxo[])
            : []
          const txs = JSON.parse(await this.get(`/address/${a.address}/txs`)) as EsploraTx[]
          known = { ...now, utxos, txs }
          this.known.set(a.address, known)
        }
        for (const u of known.utxos)
          coins.push({
            txid: u.txid,
            vout: u.vout,
            value: BigInt(u.value),
            address: a,
            confirmed: u.status.confirmed
          })
        for (const tx of known.txs) seen.set(tx.txid, tx)
      })
    )
    const activity = [...seen.values()]
      .map((tx) => {
        const came = tx.vout
          .filter((o) => o.scriptpubkey_address && ours.has(o.scriptpubkey_address))
          .reduce((n, o) => n + BigInt(o.value), 0n)
        const went = tx.vin
          .filter(
            (i) => i.prevout?.scriptpubkey_address && ours.has(i.prevout.scriptpubkey_address)
          )
          .reduce((n, i) => n + BigInt(i.prevout!.value), 0n)
        return {
          txid: tx.txid,
          net: came - went,
          fee: BigInt(tx.fee),
          time: tx.status.confirmed ? (tx.status.block_time ?? null) : null
        }
      })
      // the newest first, those not yet in a block before them
      .sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity))
    return {
      confirmed,
      pending,
      coins,
      activity,
      receive: this.keys.address(0, next[0]),
      change: this.keys.address(1, next[1])
    }
  }

  /** mempool.space's fee rates, sat/vB. */
  async feeRates(): Promise<FeeRates> {
    return JSON.parse(await this.get('/v1/fees/recommended')) as FeeRates
  }

  /** Whether `address` is one this network takes. */
  valid(address: string): boolean {
    try {
      btc.Address(this.keys.network).decode(address)
      return true
    } catch {
      return false
    }
  }

  /**
   * How a payment of `amount` satoshis (or everything, less the fee) to `address` at `feeRate`
   * sat/vB would go: which coins, the biggest first (confirmed ones before those that aren't), and
   * what goes where. Change too small to be worth an output goes to the fee. Throws if it can't.
   */
  plan(state: BtcWalletState, address: string, amount: bigint | 'all', feeRate: number): BtcPlan {
    if (!this.valid(address))
      throw new Error(
        `that isn’t a ${this.keys.info.network === 'bitcoin' ? 'Bitcoin' : 'test network'} address`
      )
    if (!(feeRate > 0)) throw new Error('the fee rate must be more than nothing')
    const to = btc.OutScript.encode(btc.Address(this.keys.network).decode(address))
    const kind = this.keys.info.kind
    const size = (inputs: number, change: boolean): number =>
      OVERHEAD_VB +
      inputs * INPUT_VB[kind] +
      outputVb(to) +
      (change ? outputVb(state.change.script) : 0)
    const fee = (inputs: number, change: boolean): bigint =>
      BigInt(Math.ceil(size(inputs, change) * feeRate))

    // confirmed coins first, then the biggest
    const coins = [...state.coins].sort((a, b) =>
      a.confirmed !== b.confirmed
        ? a.confirmed
          ? -1
          : 1
        : b.value > a.value
          ? 1
          : b.value < a.value
            ? -1
            : 0
    )
    const chosen: BtcCoin[] = []
    let total = 0n
    let sent: bigint
    let change = 0n
    if (amount === 'all') {
      chosen.push(...coins)
      total = coins.reduce((n, c) => n + c.value, 0n)
      sent = total - fee(chosen.length, false)
    } else {
      if (amount < DUST) throw new Error(`send at least ${DUST} satoshis`)
      for (const c of coins) {
        chosen.push(c)
        total += c.value
        if (total >= amount + fee(chosen.length, false)) break
      }
      sent = amount
      change = total - amount - fee(chosen.length, true)
      // change too small to be worth an output goes to the fee
      if (change < DUST) change = 0n
    }
    // the fee is what's left over, and it has to cover the rate asked for
    const paid = total - sent - change
    if (chosen.length === 0 || sent < DUST || paid < fee(chosen.length, change > 0n)) {
      throw new Error('the account doesn’t hold enough for that and its fee')
    }
    return {
      to,
      coins: chosen,
      sent,
      fee: paid,
      change,
      vbytes: Math.ceil(size(chosen.length, change > 0n))
    }
  }

  /**
   * A PSBT paying `amount` satoshis (or everything, less the fee) to `address` at `feeRate`
   * sat/vB, as `plan` has it; change goes to the next change address, marked as change so maki
   * shows it as such.
   */
  async send(
    state: BtcWalletState,
    address: string,
    amount: bigint | 'all',
    feeRate: number
  ): Promise<{ psbt: Uint8Array; sent: bigint; fee: bigint; change: bigint }> {
    const {
      to,
      coins: chosen,
      sent,
      fee: paid,
      change
    } = this.plan(state, address, amount, feeRate)
    const kind = this.keys.info.kind

    const tx = new btc.Transaction()
    for (const c of chosen) {
      const a = c.address
      const der = this.keys.derivation(a)
      if (kind === 'segwit') {
        // maki takes no amount on a PSBT's word: the whole transaction the coin comes from
        const raw = hex.decode((await this.get(`/tx/${c.txid}/hex`)).trim())
        tx.addInput({
          txid: c.txid,
          index: c.vout,
          nonWitnessUtxo: btc.RawTx.decode(raw),
          witnessUtxo: { script: a.script, amount: c.value },
          bip32Derivation: [[a.publicKey, der]]
        })
      } else {
        const xOnly = a.publicKey.slice(1)
        tx.addInput({
          txid: c.txid,
          index: c.vout,
          witnessUtxo: { script: a.script, amount: c.value },
          tapInternalKey: xOnly,
          tapBip32Derivation: [[xOnly, { hashes: [], der }]]
        })
      }
    }
    tx.addOutput({ script: to, amount: sent })
    if (change > 0n) {
      const a = state.change
      const der = this.keys.derivation(a)
      tx.addOutput(
        kind === 'segwit'
          ? { script: a.script, amount: change, bip32Derivation: [[a.publicKey, der]] }
          : {
              script: a.script,
              amount: change,
              tapInternalKey: a.publicKey.slice(1),
              tapBip32Derivation: [[a.publicKey.slice(1), { hashes: [], der }]]
            }
      )
    }
    return { psbt: tx.toPSBT(), sent, fee: paid, change }
  }

  /** maki's signed PSBT, finished and broadcast; its transaction ID. */
  async broadcast(signed: Uint8Array): Promise<string> {
    const tx = btc.Transaction.fromPSBT(signed)
    tx.finalize()
    return (await this.esplora(this.keys.info.network, '/tx', tx.hex)).trim()
  }
}
