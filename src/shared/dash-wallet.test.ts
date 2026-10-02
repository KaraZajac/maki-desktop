/**
 * maki desktop's Dash wallet: the Esplora calls it makes, answered from Dash's Insight API (its
 * answers as insight.dash.org gave them, read exactly, a transaction's bytes held to its ID); and,
 * with the fake maki running maki's Dash app (Bitcoin's wallet code before SegWit, on Dash's
 * networks; the test phrase's account), the addresses Dash's own library makes for the test phrase,
 * and a payment that spends a plain coin and one Dash Platform paid out (a special transaction, its
 * payload in the PSBT whole, as maki needs it), signed by maki and taken by a stand-in for Insight
 * that checks each signature itself.
 */
import { hex } from '@scure/base'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BtcWallet, DASH, finishLegacy, parseDescriptor } from './btc-wallet'
import { MakiClient } from './client'
import { insightEsplora, txidOf, type InsightCall } from './insight-esplora'
import { BtcAccount, Network } from './protocol'
import { DashInsight, readDashTx } from './stand-ins'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { BitcoinApp, DASH_APP } from './wallet-apps'

/** insight.dash.org's answers, recorded. */
const recorded = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/dash-insight.json'), 'utf8')
) as {
  status: unknown
  address: string
  receiver: string
  addr: unknown
  utxo: unknown[]
  txs: unknown
  rawtx: Record<string, string>
}

/** Insight, as the recording has it: what was asked, answered as it was. */
const replay: InsightCall = async (path, json) => {
  const ok = (v: unknown): { status: number; text: string } => ({
    status: 200,
    text: JSON.stringify(v)
  })
  if (json !== undefined) return { status: 400, text: 'TX decode failed. Code:-22' }
  if (path === '/status?q=getInfo') return ok(recorded.status)
  if (path === `/addr/${recorded.receiver}?noTxList=1`) return ok(recorded.addr)
  if (path === `/addrs/${recorded.receiver}/utxo`) return ok(recorded.utxo)
  if (path === `/txs?address=${recorded.address}&pageNum=0`) return ok(recorded.txs)
  const raw = /^\/rawtx\/([0-9a-f]{64})$/.exec(path)
  if (raw && recorded.rawtx[raw[1]]) return ok({ rawtx: recorded.rawtx[raw[1]] })
  return { status: 404, text: 'Not found' }
}

describe('Dash’s Insight API, as Esplora', () => {
  const esplora = insightEsplora(replay)

  it('answers an address’s totals and coins as Insight has them', async () => {
    expect(JSON.parse(await esplora(`/address/${recorded.receiver}`))).toEqual({
      chain_stats: { funded_txo_sum: 30_000, spent_txo_sum: 0, tx_count: 1 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }
    })
    expect(JSON.parse(await esplora(`/address/${recorded.receiver}/utxo`))).toEqual([
      {
        txid: 'ad81885d6ed6cf0e5a4c797d370841def52bb6b275d95ad93b5967a57fdc4c15',
        vout: 0,
        value: 30_000,
        status: { confirmed: true }
      }
    ])
  })

  it('describes an address’s transactions exactly: what came and went, the fee, the time', async () => {
    const txs = JSON.parse(await esplora(`/address/${recorded.address}/txs`)) as {
      txid: string
      fee: number
      status: { confirmed: boolean; block_time?: number }
      vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[]
      vout: { scriptpubkey_address?: string; value: number }[]
    }[]
    expect(txs.map((t) => t.txid)).toEqual([
      'ad81885d6ed6cf0e5a4c797d370841def52bb6b275d95ad93b5967a57fdc4c15',
      '56ba33d1b9583952fa88d0d28d37560dcc392134bb08589cf6681b81c929fc35'
    ])
    // 0.0004 DASH in, 0.0003 out: a fee of 0.0001, in a block at its time
    expect(txs[0]).toMatchObject({
      fee: 10_000,
      status: { confirmed: true, block_time: 1_790_960_500 },
      vin: [{ prevout: { scriptpubkey_address: recorded.address, value: 40_000 } }],
      vout: [{ scriptpubkey_address: recorded.receiver, value: 30_000 }]
    })
  })

  it('gives a transaction’s bytes only if they hash to its ID, a special one’s payload and all', async () => {
    const coinbase = '00c0910dc5e0431c409e0d5c0c32d3189de809f2a03d844e9d8a111dd319191c'
    const raw = await esplora(`/tx/${coinbase}/hex`)
    expect(txidOf(hex.decode(raw))).toBe(coinbase)
    expect(readDashTx(hex.decode(raw))).toMatchObject({ version: 3, type: 5 })
    const lying = insightEsplora(async (path) =>
      path.startsWith('/rawtx/')
        ? {
            status: 200,
            text: JSON.stringify({ rawtx: recorded.rawtx[coinbase].replace(/00$/, '01') })
          }
        : replay(path)
    )
    await expect(lying(`/tx/${coinbase}/hex`)).rejects.toThrow(/isn’t the one asked for/)
  })

  it('takes the network’s relay fee as the rate, and says why a broadcast is turned down', async () => {
    expect(JSON.parse(await esplora('/v1/fees/recommended'))).toMatchObject({
      fastestFee: 1,
      halfHourFee: 1,
      minimumFee: 1
    })
    await expect(esplora('/tx', '0200000000')).rejects.toThrow(
      'Insight: TX decode failed. Code:-22'
    )
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('the Dash wallet, with the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  let transport: TcpTransport
  let dash: BitcoinApp
  beforeAll(async () => {
    fake = await startFake(['--clock-verified'])
    transport = await TcpTransport.open(fake.port)
    const client = new MakiClient(transport)
    dash = new BitcoinApp(
      (app, message, timeoutMs) => client.appMessage(app, message, timeoutMs),
      DASH_APP,
      'Dash'
    )
    const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'dash.maki')))
    expect(await client.appInstall(bundle)).toEqual({ approval: 'approved', reason: '' })
  })
  afterAll(async () => {
    await transport?.close()
    fake?.proc.kill()
  })

  it('works out the addresses Dash’s own library makes for the test phrase', async () => {
    const info = parseDescriptor(
      (await dash.account(Network.BITCOIN, BtcAccount.LEGACY)).descriptor,
      'dash'
    )
    expect(info).toMatchObject({ kind: 'legacy', network: 'dash', fingerprint: 0x73c5da0a })
    expect(info.xpub).toBe(
      'xpub6CYEjsU6zPM3sADS2ubu2aZeGxCm3C5KabkCpo4rkNbXGAH9M7rRUJ4E5CKiyUddmRzrSCopPzisTBrXkfCD4o577XKM9mzyZtP1Xdbizyk'
    )
    const keys = new BtcWallet(info, async () => '').keys
    expect(keys.address(0, 0).address).toBe('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5')
    expect(keys.address(0, 1).address).toBe('XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ')
    expect(keys.address(1, 0).address).toBe('XeBdurzVrhrFtgqf9SxzQqvhHodb53njW4')
    const test = parseDescriptor(
      (await dash.account(Network.TESTNET, BtcAccount.LEGACY)).descriptor,
      'dash'
    )
    expect(new BtcWallet(test, async () => '').keys.address(0, 0).address).toBe(
      'yRd4FhXfVGHXpsuZXPNkMrfD9GVj46pnjt'
    )
  })

  it('spends a plain coin and one from Dash Platform: maki signs both, Insight takes it', async () => {
    const info = parseDescriptor(
      (await dash.account(Network.BITCOIN, BtcAccount.LEGACY)).descriptor,
      'dash'
    )
    const insight = new DashInsight(DASH)
    const plain = insight.fund('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5', 150_000_000n)
    const platform = insight.withdraw('XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ', 25_000_000n)
    const esplora = insightEsplora(async (path, json) => {
      const [status, text] = await insight.answer(
        json === undefined ? 'GET' : 'POST',
        path,
        json ?? ''
      )
      return { status, text }
    })
    const wallet = new BtcWallet(info, (_network, path, body) => esplora(path, body))
    const state = await wallet.scan()
    expect(state.confirmed).toBe(175_000_000n)
    const payee = 'XtNTcJBRDXN6xLh8o56kAMSvgFpxwVh4rJ'
    // more than the plain coin holds: both coins, at a duff a byte
    const { psbt, fee, change } = await wallet.send(state, payee, 160_000_000n, 1)
    expect(fee).toBe(374n)
    expect(change).toBe(175_000_000n - 160_000_000n - 374n)
    const r = await dash.sign(Network.BITCOIN, psbt)
    expect(r).toMatchObject({ approval: 'approved', reason: '' })
    const txid = await wallet.broadcast(r.signed!)
    expect(insight.sent).toEqual([
      {
        txid,
        inputs: [
          { txid: plain, vout: 0 },
          { txid: platform, vout: 0 }
        ],
        outputs: [
          { address: payee, value: 160_000_000n },
          { address: 'XeBdurzVrhrFtgqf9SxzQqvhHodb53njW4', value: change }
        ],
        fee
      }
    ])
    // a plain transaction, as Dash writes one
    expect(readDashTx(finishLegacy(r.signed!))).toMatchObject({ version: 2, type: 0 })
  })
})
