/**
 * The Esplora calls answered from an Electrum server: against a server made here, holding a coin to
 * an address and a payment from it, each in a block, and a coin carrying CashTokens.
 */
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { describe, expect, it } from 'vitest'
import { BITCOINCASH } from './btc-wallet'
import { cashChain, electrumEsplora, scripthash, type ElectrumCall } from './electrum-esplora'

const chain = cashChain('bitcoincash', BITCOINCASH)
const ME = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6'
const THEM = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
const mine = chain.script(ME)!
const theirs = chain.script(THEM)!

const raw = (inputs: [string, number][], outputs: [Uint8Array, bigint][]): Uint8Array =>
  btc.RawTx.encode({
    version: 2,
    inputs: inputs.map(([txid, index]) => ({
      txid: hex.decode(txid),
      index,
      finalScriptSig: Uint8Array.of(0x51),
      sequence: 0xfffffffe
    })),
    outputs: outputs.map(([script, amount]) => ({ script, amount })),
    lockTime: 0,
    segwitFlag: false
  })
const idOf = (tx: Uint8Array): string =>
  btc.Transaction.fromRaw(tx, { allowUnknownInputs: true }).id

// a coin to me (at height 100: a coinbase's, nothing before it), then a payment from it to
// them, change back (at 101)
const funding = raw([['00'.repeat(32), 0xffffffff]], [[mine, 50_000n]])
const spend = raw(
  [[idOf(funding), 0]],
  [
    [theirs, 20_000n],
    [mine, 29_000n]
  ]
)
const header = (time: number): string => {
  const h = new Uint8Array(80)
  new DataView(h.buffer).setUint32(68, time, true)
  return hex.encode(h)
}

function server(): { call: ElectrumCall; asked: string[] } {
  const asked: string[] = []
  const txs = new Map([
    [idOf(funding), funding],
    [idOf(spend), spend]
  ])
  const call: ElectrumCall = async (method, params) => {
    asked.push(method)
    switch (method) {
      case 'blockchain.transaction.get':
        return hex.encode(txs.get(params[0] as string)!)
      case 'blockchain.block.header':
        return header(params[0] === 100 ? 1_790_000_000 : 1_790_000_600)
      case 'blockchain.scripthash.get_history':
        expect(params[0]).toBe(scripthash(mine))
        return [
          { tx_hash: idOf(funding), height: 100 },
          { tx_hash: idOf(spend), height: 101 }
        ]
      case 'blockchain.scripthash.get_balance':
        return { confirmed: 29_000, unconfirmed: 0 }
      case 'blockchain.scripthash.listunspent':
        return [
          { tx_hash: idOf(spend), tx_pos: 1, height: 101, value: 29_000 },
          // a coin with tokens: never offered for spending
          {
            tx_hash: 'ab'.repeat(32),
            tx_pos: 0,
            height: 99,
            value: 1_000,
            token_data: { amount: '5' }
          }
        ]
      case 'blockchain.transaction.broadcast':
        return idOf(hex.decode(params[0] as string))
      case 'blockchain.relayfee':
        return 0.00001
      case 'blockchain.estimatefee':
        return 0.0000101
    }
    throw new Error(`unexpected ${method}`)
  }
  return { call, asked }
}

describe('Esplora’s calls, from an Electrum server', () => {
  it('gives an address’s totals, its coins (no CashTokens) and its transactions as Esplora would', async () => {
    const esplora = electrumEsplora(server().call, chain)
    const stats = JSON.parse(await esplora(`/address/${ME}`))
    expect(stats.chain_stats).toEqual({ funded_txo_sum: 29_000, spent_txo_sum: 0, tx_count: 2 })
    expect(stats.mempool_stats.tx_count).toBe(0)
    expect(JSON.parse(await esplora(`/address/${ME}/utxo`))).toEqual([
      { txid: idOf(spend), vout: 1, value: 29_000, status: { confirmed: true } }
    ])
    const txs = JSON.parse(await esplora(`/address/${ME}/txs`))
    // the newest first, with what it spent and its fee worked out from what that was
    expect(txs.map((t: { txid: string }) => t.txid)).toEqual([idOf(spend), idOf(funding)])
    expect(txs[0]).toMatchObject({
      fee: 1_000,
      status: { confirmed: true, block_time: 1_790_000_600 },
      vin: [{ txid: idOf(funding), vout: 0, prevout: { scriptpubkey_address: ME, value: 50_000 } }],
      vout: [
        { scriptpubkey_address: THEM, value: 20_000 },
        { scriptpubkey_address: ME, value: 29_000 }
      ]
    })
  })

  it('passes a transaction’s bytes, a broadcast and the fee rate on', async () => {
    const esplora = electrumEsplora(server().call, chain)
    expect(await esplora(`/tx/${idOf(funding)}/hex`)).toBe(hex.encode(funding))
    expect(await esplora('/tx', hex.encode(spend))).toBe(idOf(spend))
    // 0.0000101 BCH a kilobyte: 1.01 satoshis a byte
    expect(JSON.parse(await esplora('/v1/fees/recommended')).halfHourFee).toBe(1.01)
  })

  it('asks for each transaction and block time once', async () => {
    const s = server()
    const esplora = electrumEsplora(s.call, chain)
    await esplora(`/address/${ME}/txs`)
    const first = s.asked.length
    await esplora(`/address/${ME}/txs`)
    // the history again, nothing else
    expect(s.asked.slice(first)).toEqual(['blockchain.scripthash.get_history'])
  })

  it('refuses addresses of other chains and paths the wallet doesn’t ask', async () => {
    const esplora = electrumEsplora(server().call, chain)
    await expect(esplora('/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).rejects.toThrow()
    await expect(esplora('/blocks/tip/height')).rejects.toThrow('not something the wallet asks')
  })
})
