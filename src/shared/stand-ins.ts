/**
 * Stand-ins for the networks the wallets use, for tests (Node only): a Bitcoin chain holding one
 * coin, behind an Esplora API, and an Ethereum network that holds a little of everything, behind
 * JSON-RPC; each keeps what it's sent. And what a signed Ethereum transaction says, read back.
 * And Solana: LiteSVM, Solana's runtime, behind the JSON-RPC calls maki desktop's wallet makes.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Esplora } from './btc-wallet'
import type { ElectrumChain } from './electrum-esplora'
import { NETWORKS, ProviderError, type Rpc } from './ethereum'
import { ENS_REGISTRY, namehash } from './eth-wallet'
import { fromHex, toHex } from './rlp'
import { associatedTokenAccount, keyOf, SOL_NETWORKS, type SolRpc, TOKEN_PROGRAM } from './solana'
import { fromBase64 } from './bridge-types'
import { base58 } from '@scure/base'
import { tokensOn } from './tokens'

const USDC = tokensOn(1n).find((t) => t.symbol === 'USDC')!

/** A transaction's weight; a made-up funding transaction's, which has no witness, from its size. */
function weight(tx: btc.Transaction): number {
  try {
    return tx.weight
  } catch {
    return (tx.hex.length / 2) * 4
  }
}

/** What the pretend chain's Esplora recommends, sat/vB. */
export const PRETEND_FEES = {
  fastestFee: 9,
  halfHourFee: 5,
  hourFee: 3,
  economyFee: 2,
  minimumFee: 1
}

/**
 * A chain as a ledger of transactions, some in blocks and some waiting, answering Esplora's
 * questions from them: each address's totals, its unspent coins and its transactions (the newest
 * first, those waiting before them). What's broadcast joins those waiting, replacing any it
 * spends the same coins as (BIP125), and is kept.
 */
export class PretendChain {
  private entries = new Map<string, { tx: btc.Transaction; confirmed: boolean; time: number }>()
  readonly broadcast: string[] = []

  /** `codec`, for a chain whose addresses btc-signer doesn't write (Bitcoin Cash's CashAddr). */
  constructor(
    private network = btc.NETWORK,
    private codec?: ElectrumChain
  ) {}

  /** A transaction, in a block or waiting for one; its ID. */
  add(tx: btc.Transaction, confirmed: boolean, time = 1_790_000_000): string {
    this.entries.set(tx.id, { tx, confirmed, time })
    return tx.id
  }

  /** `value` satoshis to `address`, in a transaction of their own, in a block; its ID. */
  fund(address: string, value: number, confirmed = true): string {
    const funding = new btc.Transaction({ allowUnknownInputs: true })
    // an input of its own, so each funding transaction's ID is different
    funding.addInput({
      txid: hex.encode(randomBytes(32)),
      index: 0,
      finalScriptSig: new Uint8Array()
    })
    if (this.codec)
      funding.addOutput({ script: this.codec.script(address)!, amount: BigInt(value) })
    else funding.addOutputAddress(address, BigInt(value), this.network)
    return this.add(funding, confirmed)
  }

  waiting(txid: string): boolean {
    return this.entries.get(txid)?.confirmed === false
  }

  private address(script: Uint8Array): string | undefined {
    if (this.codec) return this.codec.address(script)
    try {
      return btc.Address(this.network).encode(btc.OutScript.decode(script))
    } catch {
      return undefined
    }
  }

  private inputs(tx: btc.Transaction): { txid: string; vout: number; sequence: number }[] {
    return Array.from({ length: tx.inputsLength }, (_, i) => {
      const input = tx.getInput(i)
      return {
        txid: hex.encode(input.txid!),
        vout: input.index!,
        sequence: input.sequence ?? 0xffffffff
      }
    })
  }

  private output(txid: string, vout: number): { address?: string; value: number } | null {
    const e = this.entries.get(txid)
    if (!e || vout >= e.tx.outputsLength) return null
    const o = e.tx.getOutput(vout)
    return { address: this.address(o.script!), value: Number(o.amount!) }
  }

  private spender(txid: string, vout: number): { confirmed: boolean } | undefined {
    for (const e of this.entries.values()) {
      if (this.inputs(e.tx).some((i) => i.txid === txid && i.vout === vout)) return e
    }
    return undefined
  }

  /** The transaction as Esplora describes it. */
  private describe(txid: string): object {
    const { tx, confirmed, time } = this.entries.get(txid)!
    const vin = this.inputs(tx).map((i) => {
      const prev = this.output(i.txid, i.vout)
      return { ...i, prevout: prev && { scriptpubkey_address: prev.address, value: prev.value } }
    })
    const vout = Array.from({ length: tx.outputsLength }, (_, i) => {
      const o = tx.getOutput(i)
      return { scriptpubkey_address: this.address(o.script!), value: Number(o.amount!) }
    })
    const into = vin.reduce((n, i) => n + (i.prevout?.value ?? 0), 0)
    const out = vout.reduce((n, o) => n + o.value, 0)
    return {
      txid,
      fee: vin.every((i) => i.prevout) ? into - out : 0,
      weight: weight(tx),
      status: confirmed ? { confirmed: true, block_time: time } : { confirmed: false },
      vin,
      vout
    }
  }

  readonly esplora: Esplora = async (_network, path, body) => {
    if (path === '/tx' && body) {
      const tx = btc.Transaction.fromRaw(hex.decode(body))
      const spends = this.inputs(tx).map((i) => `${i.txid}:${i.vout}`)
      // a replacement: what it spends the same coins as, waiting, goes
      for (const [id, e] of this.entries) {
        if (!e.confirmed && this.inputs(e.tx).some((i) => spends.includes(`${i.txid}:${i.vout}`)))
          this.entries.delete(id)
      }
      this.broadcast.push(body)
      return this.add(tx, false)
    }
    if (path === '/v1/fees/recommended') return JSON.stringify(PRETEND_FEES)
    const raw = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path)
    if (raw) {
      const e = this.entries.get(raw[1])
      if (!e) throw new Error('Transaction not found')
      return e.tx.hex
    }
    const m = /^\/address\/([^/]+)(\/utxo|\/txs)?$/.exec(path)
    if (!m) throw new Error(`the pretend chain has no ${path}`)
    const address = m[1]
    const touching = [...this.entries].filter(
      ([id, e]) =>
        Array.from({ length: e.tx.outputsLength }, (_, i) => this.output(id, i)).some(
          (o) => o?.address === address
        ) || this.inputs(e.tx).some((i) => this.output(i.txid, i.vout)?.address === address)
    )
    if (m[2] === '/utxo') {
      const coins = touching.flatMap(([id, e]) =>
        Array.from({ length: e.tx.outputsLength }, (_, vout) => ({
          vout,
          o: this.output(id, vout)!
        }))
          .filter(({ vout, o }) => o.address === address && !this.spender(id, vout))
          .map(({ vout, o }) => ({
            txid: id,
            vout,
            value: o.value,
            status: { confirmed: e.confirmed }
          }))
      )
      return JSON.stringify(coins)
    }
    if (m[2] === '/txs') {
      const order = (e: { confirmed: boolean; time: number }): number =>
        e.confirmed ? e.time : Infinity
      return JSON.stringify(
        touching.sort(([, a], [, b]) => order(b) - order(a)).map(([id]) => this.describe(id))
      )
    }
    const stats = (
      confirmed: boolean
    ): { funded_txo_sum: number; spent_txo_sum: number; tx_count: number } => {
      let funded = 0
      let spent = 0
      let count = 0
      for (const [id, e] of touching) {
        if (e.confirmed === confirmed) count++
        for (let vout = 0; vout < e.tx.outputsLength; vout++) {
          const o = this.output(id, vout)!
          if (o.address === address && e.confirmed === confirmed) funded += o.value
        }
        if (e.confirmed === confirmed) {
          for (const i of this.inputs(e.tx)) {
            const prev = this.output(i.txid, i.vout)
            if (prev?.address === address) spent += prev.value
          }
        }
      }
      return { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: count }
    }
    return JSON.stringify({ chain_stats: stats(true), mempool_stats: stats(false) })
  }
}

/** A chain that holds one coin: `value` satoshis to `address`, in a transaction of its own. */
export function pretendChain(
  address: string,
  value: number,
  network = btc.NETWORK,
  codec?: ElectrumChain
) {
  const chain = new PretendChain(network, codec)
  const txid = chain.fund(address, value)
  return { chain, esplora: chain.esplora, broadcast: chain.broadcast, txid }
}

type Rlp = Uint8Array | Rlp[]
/** RLP, read back. */
export function rlpDecode(b: Uint8Array): Rlp {
  const one = (at: number): [Rlp, number] => {
    const p = b[at]
    const len = (n: number, from: number): number => Number(BigInt(toHex(b.slice(from, from + n))))
    if (p < 0x80) return [b.slice(at, at + 1), at + 1]
    if (p < 0xb8) return [b.slice(at + 1, at + 1 + p - 0x80), at + 1 + p - 0x80]
    if (p < 0xc0) {
      const n = len(p - 0xb7, at + 1)
      const start = at + 1 + p - 0xb7
      return [b.slice(start, start + n), start + n]
    }
    const [start, end] =
      p < 0xf8
        ? [at + 1, at + 1 + p - 0xc0]
        : [at + 1 + p - 0xf7, at + 1 + p - 0xf7 + len(p - 0xf7, at + 1)]
    const items: Rlp[] = []
    for (let i = start; i < end;) {
      const [item, next] = one(i)
      items.push(item)
      i = next
    }
    return [items, end]
  }
  return one(0)[0]
}

/** An EIP-1559 transaction as maki signed it: its fields, and who signed it. */
export function signedBy(raw: string): { fields: Uint8Array[]; from: string } {
  const bytes = fromHex(raw)
  if (bytes[0] !== 2) throw new Error('not an EIP-1559 transaction')
  const all = rlpDecode(bytes.slice(1)) as Uint8Array[]
  const fields = all.slice(0, 9)
  const [yParity, r, s] = all.slice(9) as Uint8Array[]
  // what was signed: the type, then the fields without the signature
  const unsigned = fromHex(raw).slice(0, 1)
  const body = (() => {
    const enc = (item: Rlp): Uint8Array => {
      const cat = (xs: Uint8Array[]): Uint8Array => Uint8Array.from(xs.flatMap((x) => [...x]))
      const head = (short: number, n: number): Uint8Array => {
        if (n < 56) return Uint8Array.of(short + n)
        const len = fromHex(
          `0x${n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0')}`
        )
        return Uint8Array.of(short + 55 + len.length, ...len)
      }
      if (item instanceof Uint8Array)
        return item.length === 1 && item[0] < 0x80 ? item : cat([head(0x80, item.length), item])
      const inner = cat(item.map(enc))
      return cat([head(0xc0, inner.length), inner])
    }
    return enc(all.slice(0, 9))
  })()
  const digest = keccak_256(Uint8Array.of(...unsigned, ...body))
  const pad = (x: Uint8Array): Uint8Array => Uint8Array.of(...new Uint8Array(32 - x.length), ...x)
  const sig = Uint8Array.of(yParity.length ? yParity[0] : 0, ...pad(r), ...pad(s))
  const pub = secp256k1.Point.fromBytes(
    secp256k1.recoverPublicKey(sig, digest, { prehash: false })
  ).toBytes(false)
  return { fields, from: toHex(keccak_256(pub.slice(1)).slice(12)) }
}

/** A network that holds 1 of its coin for everyone, and 1.5 USDC on Ethereum; it keeps what it's sent. */
/** Where the Ethereum stand-in's one ENS name, maki.eth, points. */
export const MAKI_ETH = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

export function ethStandIn(): { rpc: Rpc; sent: [string, string, unknown[]][] } {
  const sent: [string, string, unknown[]][] = []
  const answers: Record<string, unknown> = {
    eth_getBalance: '0xde0b6b3a7640000',
    eth_getTransactionCount: '0x7',
    eth_estimateGas: '0xc350',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_sendRawTransaction: '0xfeed'
  }
  return {
    sent,
    rpc: async (url, method, params) => {
      sent.push([url, method, params])
      if (method === 'eth_call') {
        const { to, data } = params[0] as { to: string; data: string }
        const word = (hex: string): string =>
          `0x${hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`
        // ENS, which has one name: the registry's resolver for it, and its address there
        const node = namehash('maki.eth').slice(2)
        const resolver = '0x' + '42'.repeat(20)
        if (to === ENS_REGISTRY && data === `0x0178b8bf${node}`) return word(resolver)
        if (to === resolver && data === `0x3b3b57de${node}`) return word(MAKI_ETH)
        return to === USDC.contract && url === NETWORKS[0].rpc
          ? word((1_500_000).toString(16))
          : word('0')
      }
      if (!(method in answers)) throw new ProviderError(-32601, `no ${method} here`)
      return answers[method]
    }
  }
}

/** A server on a free local port, answering with `answer`; its address, and a way to stop it. */
async function serve(
  answer: (method: string, path: string, body: string) => Promise<[number, string]>
): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', () => {
      answer(req.method ?? 'GET', req.url ?? '/', body).then(
        ([status, text]) => res.writeHead(status, { 'content-type': 'text/plain' }).end(text),
        (e: Error) => res.writeHead(500).end(e.message)
      )
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close()
  }
}

/** `esplora` as an Esplora API over HTTP, as the app's MAKI_ESPLORA takes one. */
export function serveEsplora(esplora: Esplora): Promise<{ url: string; close: () => void }> {
  return serve(async (method, path, body) => {
    try {
      return [200, await esplora('bitcoin', path, method === 'POST' ? body : undefined)]
    } catch (e) {
      return [404, (e as Error).message]
    }
  })
}

/** `rpc` as a JSON-RPC server, as the app's MAKI_ETH_RPC takes one: Ethereum's, whatever the network. */
export function serveEthRpc(rpc: Rpc): Promise<{ url: string; close: () => void }> {
  return serve(async (_method, _path, body) => {
    const { id, method, params } = JSON.parse(body) as {
      id: number
      method: string
      params: unknown[]
    }
    try {
      return [
        200,
        JSON.stringify({ jsonrpc: '2.0', id, result: await rpc(NETWORKS[0].rpc, method, params) })
      ]
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : -32603
      return [
        200,
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: (e as Error).message } })
      ]
    }
  })
}

// ---- Solana ----

/** The test phrase's first Solana account, as Phantom has it, and USDC's mint. */
export const SOL_ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** A mint's account (82 bytes): no authorities, `decimals`, initialized. */
function mintData(decimals: number): Uint8Array {
  const d = new Uint8Array(82)
  d[44] = decimals
  d[45] = 1
  return d
}

/** A token account (165 bytes): its mint, owner and amount, initialized. */
function tokenData(mint: string, owner: string, amount: bigint): Uint8Array {
  const d = new Uint8Array(165)
  d.set(keyOf(mint)!, 0)
  d.set(keyOf(owner)!, 32)
  new DataView(d.buffer).setBigUint64(64, amount, true)
  d[108] = 1
  return d
}

/** Whether LiteSVM is here to stand in for Solana. */
export async function haveLiteSvm(): Promise<boolean> {
  try {
    await import('litesvm')
    return true
  } catch {
    return false
  }
}

/**
 * Solana, as LiteSVM runs it: the account holds 10 SOL and 100 USDC (in its own token account for
 * it), and the JSON-RPC calls maki desktop's wallet makes are answered from the runtime's state.
 * Every transaction sent is checked as Solana checks it (maki's signature too) and run.
 */
export async function solStandIn(): Promise<{
  rpc: SolRpc
  /** lamports at an address */
  balance(address: string): bigint
  /** `owner`'s USDC, in its own token account for it; -1 if it hasn't one */
  usdc(owner: string): bigint
}> {
  const { LiteSVM } = await import('litesvm')
  const kit = await import('@solana/kit')
  const svm = new LiteSVM()
  svm.airdrop(kit.address(SOL_ME), kit.lamports(10_000_000_000n))
  const rent = svm.minimumBalanceForRentExemption(165n)
  const put = (address: string, data: Uint8Array): void =>
    svm.setAccount({
      address: kit.address(address),
      data,
      executable: false,
      lamports: kit.lamports(rent),
      programAddress: kit.address(TOKEN_PROGRAM),
      space: BigInt(data.length)
    })
  put(SOL_USDC, mintData(6))
  put(associatedTokenAccount(SOL_ME, SOL_USDC), tokenData(SOL_USDC, SOL_ME, 100_000_000n))
  const account = (a: string) => svm.getAccount(kit.address(a))
  const amountIn = (data: Uint8Array): bigint =>
    new DataView(data.buffer, data.byteOffset).getBigUint64(64, true)
  const decode = (b64: string) => kit.getTransactionDecoder().decode(fromBase64(b64)!)
  const rpc: SolRpc = async (_url, method, params) => {
    switch (method) {
      case 'getBalance':
        return { value: Number(svm.getBalance(kit.address(params[0] as string)) ?? 0n) }
      case 'getTokenAccountsByOwner': {
        const [owner, { programId }] = params as [string, { programId: string }]
        const at = associatedTokenAccount(owner, SOL_USDC, programId)
        const a = account(at)
        if (!a.exists || a.programAddress !== programId) return { value: [] }
        const info = {
          mint: SOL_USDC,
          tokenAmount: { amount: String(amountIn(a.data)), decimals: 6 }
        }
        return { value: [{ pubkey: at, account: { data: { parsed: { info } } } }] }
      }
      case 'getAccountInfo': {
        const a = account(params[0] as string)
        return {
          value: a.exists ? { owner: a.programAddress, lamports: Number(a.lamports) } : null
        }
      }
      case 'getRecentPrioritizationFees':
        return [{ slot: 1, prioritizationFee: 0 }]
      case 'getLatestBlockhash':
        return { value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000 } }
      case 'simulateTransaction': {
        // unsigned, as wallets simulate
        svm.withSigverify(false)
        const r = svm.simulateTransaction(decode(params[0] as string))
        svm.withSigverify(true)
        const meta = 'err' in r ? r.meta() : r.meta()
        return {
          value: {
            err: 'err' in r ? String(r.err()) : null,
            logs: meta.logs(),
            unitsConsumed: Number(meta.computeUnitsConsumed())
          }
        }
      }
      case 'sendTransaction': {
        const r = svm.sendTransaction(decode(params[0] as string))
        if ('err' in r) throw new ProviderError(-32002, `Transaction failed: ${String(r.err())}`)
        return base58.encode(fromBase64(params[0] as string)!.subarray(1, 65))
      }
      default:
        throw new ProviderError(-32601, `no ${method} here`)
    }
  }
  return {
    rpc,
    balance: (a) => svm.getBalance(kit.address(a)) ?? 0n,
    usdc: (owner) => {
      const a = account(associatedTokenAccount(owner, SOL_USDC))
      return a.exists ? amountIn(a.data) : -1n
    }
  }
}

/** A Solana stand-in's calls, as a JSON-RPC server (MAKI_SOL_RPC). */
export function serveSolRpc(rpc: SolRpc): Promise<{ url: string; close: () => void }> {
  return serve(async (_method, _path, body) => {
    const { id, method, params } = JSON.parse(body) as {
      id: number
      method: string
      params: unknown[]
    }
    try {
      return [
        200,
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: await rpc(SOL_NETWORKS[0].rpc, method, params)
        })
      ]
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : -32603
      return [
        200,
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: (e as Error).message } })
      ]
    }
  })
}
