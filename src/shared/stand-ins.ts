/**
 * Stand-ins for the networks the wallets use, for tests (Node only): a Bitcoin chain holding one
 * coin, behind an Esplora API, and an Ethereum network that holds a little of everything, behind
 * JSON-RPC; each keeps what it's sent. And what a signed Ethereum transaction says, read back.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Esplora } from './btc-wallet'
import { NETWORKS, ProviderError, type Rpc } from './ethereum'
import { fromHex, toHex } from './rlp'
import { tokensOn } from './tokens'

const USDC = tokensOn(1n).find((t) => t.symbol === 'USDC')!

/** A chain that holds one coin: `value` satoshis to `address`, in a transaction of its own. */
export function pretendChain(address: string, value: number, network = btc.NETWORK) {
  const funding = new btc.Transaction({ allowUnknownInputs: true })
  funding.addInput({ txid: '11'.repeat(32), index: 0, finalScriptSig: new Uint8Array() })
  funding.addOutputAddress(address, BigInt(value), network)
  const raw = funding.hex
  const txid = funding.id
  const broadcast: string[] = []
  const empty = { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }
  const esplora: Esplora = async (_network, path, body) => {
    if (path === '/tx' && body) {
      broadcast.push(body)
      return btc.Transaction.fromRaw(hex.decode(body)).id
    }
    if (path === `/tx/${txid}/hex`) return raw
    if (path === '/v1/fees/recommended')
      return JSON.stringify({
        fastestFee: 9,
        halfHourFee: 5,
        hourFee: 3,
        economyFee: 2,
        minimumFee: 1
      })
    const m = /^\/address\/([^/]+)(\/utxo|\/txs)?$/.exec(path)
    if (!m) throw new Error(`the pretend chain has no ${path}`)
    const ours = m[1] === address
    if (m[2] === '/utxo')
      return JSON.stringify(ours ? [{ txid, vout: 0, value, status: { confirmed: true } }] : [])
    if (m[2] === '/txs')
      return JSON.stringify(
        ours
          ? [
              {
                txid,
                fee: 0,
                status: { confirmed: true, block_time: 1_790_000_000 },
                vin: [{ prevout: null }],
                vout: [{ scriptpubkey_address: address, value }]
              }
            ]
          : []
      )
    return JSON.stringify({
      chain_stats: ours ? { funded_txo_sum: value, spent_txo_sum: 0, tx_count: 1 } : empty,
      mempool_stats: empty
    })
  }
  return { esplora, broadcast, txid }
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
        const to = (params[0] as { to: string }).to
        return to === USDC.contract && url === NETWORKS[0].rpc
          ? `0x${(1_500_000).toString(16).padStart(64, '0')}`
          : `0x${'0'.repeat(64)}`
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
