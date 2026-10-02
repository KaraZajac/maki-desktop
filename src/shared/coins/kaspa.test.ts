/**
 * maki desktop's Kaspa wallet against Kaspa's own: addresses as rusty-kaspa writes them (its
 * vectors), the test phrase's first address as Kastle publishes it, and a mainnet transaction's ID
 * and mass as api.kaspa.org has them, its signature checking out over the stand-in's signature
 * hash; then payments as the wallet makes them against the stand-in: the coins it spends, its
 * change and fee, and what it does with a payment too small for Kaspa or change too small to keep.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { describe, expect, it } from 'vitest'
import { encodeCashBytes } from '../cashaddr'
import {
  KAS_CHANGE,
  KAS_ME,
  KAS_NEXT_CHANGE,
  KAS_THEM,
  kaspaSignatureHash,
  kaspaStandIn,
  TEST_SEED
} from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  accountKeys,
  addressAt,
  addressOfScript,
  KASPA,
  type KaspaTransaction,
  mass,
  request,
  scriptOf,
  transactionId
} from './kaspa'

const account: SharedAccount = (() => {
  const k = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/111111'/0'")
  return {
    network: 0,
    index: 0,
    address: 'kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh',
    publicKey: hex.encode(Uint8Array.from([...k.publicKey!, ...k.chainCode!]))
  }
})()

/** api.kaspa.org's transaction 2de30034…, on mainnet in March 2026: one coin, paying two. */
const MAINNET: KaspaTransaction = {
  inputs: [
    {
      txid: '6d8242f50e61154b9532fe04ab1b1bfd9196c70b11669ff1c0c1224aab7e61b0',
      index: 1,
      amount: 50_960_108_648n,
      script: hex.decode('20cf440bd7607dadadd0d0551d7194319b6a79a24e6a17eb9983c7f05d602446b0ac'),
      chain: 0,
      keyIndex: 0
    }
  ],
  outputs: [
    {
      value: 39_800_000_000n,
      script: hex.decode('202c0b0a4c1f84e31b7234adb319ae970b6943592f0eae5e8513fcc476d0d211a5ac')
    },
    {
      value: 11_160_106_612n,
      script: hex.decode('20cf440bd7607dadadd0d0551d7194319b6a79a24e6a17eb9983c7f05d602446b0ac')
    }
  ]
}
const MAINNET_SIGNATURE =
  '84514ad2cf1e89aed3f6befb9aba67b046ccf7a1cb6a0f7dda092db25d2d7235cd9e89fa4bbffa762ce81e5aef2882cb492b7b2274c83cce1607de4fe01cbfb2'

const fetchFrom =
  (standIn: ReturnType<typeof kaspaStandIn>): CoinFetch =>
  async (_network, method, path, body) => {
    const [status, text] = await standIn.answer(method, path, body ?? '')
    return { status, text }
  }

describe('Kaspa addresses', () => {
  it('are written as rusty-kaspa writes them', () => {
    const key = hex.decode('5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522')
    const ecdsa = hex.decode('ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e')
    const cases: [string, number, Uint8Array, string][] = [
      [
        'kaspa',
        0,
        new Uint8Array(32),
        'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e'
      ],
      ['kaspa', 0, key, 'kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj'],
      [
        'kaspatest',
        0,
        new Uint8Array(32),
        'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya'
      ],
      [
        'kaspatest',
        1,
        new Uint8Array(33),
        'kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d'
      ],
      [
        'kaspatest',
        1,
        ecdsa,
        'kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks'
      ]
    ]
    for (const [prefix, version, payload, text] of cases) {
      expect(encodeCashBytes(prefix, [version, ...payload])).toBe(text)
      const network = prefix === 'kaspa' ? 0 : 1
      // and back, through the script that pays it
      expect(addressOfScript(scriptOf(text, network)!, network)).toBe(text)
      expect(KASPA.valid(text, network)).toBe(true)
      expect(KASPA.valid(text, network === 0 ? 1 : 0)).toBe(false)
    }
    const good = 'kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj'
    expect(KASPA.valid(good.replace('xmfj', 'xmfk'), 0)).toBe(false)
    expect(KASPA.valid(good.toUpperCase(), 0)).toBe(false)
    expect(KASPA.valid(good.slice('kaspa:'.length), 0)).toBe(false)
  })

  it('are the account’s Kastle makes from the test phrase', () => {
    const keys = accountKeys(account)
    expect(addressAt(keys, 0, 0, 0)).toBe(account.address)
    expect(KAS_ME).toBe(account.address)
    expect(addressAt(keys, 0, 1, 0)).toBe(KAS_CHANGE)
  })
})

describe('Kaspa transactions', () => {
  it('have the ID and mass mainnet gave them, and the signature checks out over the stand-in’s hash', () => {
    expect(transactionId(MAINNET)).toBe(
      '2de30034c236ebc4d0c6beeb8b78add2d39f699fb943f5a132de793f462c3d23'
    )
    expect(mass([MAINNET.inputs[0].amount], MAINNET.outputs)).toBe(2036n)
    const inputs = MAINNET.inputs.map((i) => ({
      txid: hex.decode(i.txid),
      index: i.index,
      sequence: 0n,
      sigOps: 1,
      amount: i.amount,
      script: i.script
    }))
    const hash = kaspaSignatureHash(inputs, MAINNET.outputs, 0)
    expect(
      schnorr.verify(hex.decode(MAINNET_SIGNATURE), hash, inputs[0].script.subarray(1, 33))
    ).toBe(true)
  })

  it('go to maki as maki-kas reads them', () => {
    const r = request({
      ...MAINNET,
      outputs: [MAINNET.outputs[0], { ...MAINNET.outputs[1], ours: { chain: 1, index: 7 } }]
    })
    // version, one input: its coin, sequence, one check, amount, script, key; two outputs; the rest
    expect(hex.encode(r)).toBe(
      [
        '0000',
        '01',
        MAINNET.inputs[0].txid,
        '01000000',
        '0000000000000000',
        '01',
        '688c75dd0b000000',
        '0000',
        '22',
        hex.encode(MAINNET.inputs[0].script),
        '00',
        '00000000',
        '02',
        '00ce434409000000',
        '0000',
        '22',
        hex.encode(MAINNET.outputs[0].script),
        '00',
        '74b6319902000000',
        '0000',
        '22',
        hex.encode(MAINNET.outputs[1].script),
        '01',
        '01',
        '07000000',
        '0000000000000000',
        '00'.repeat(20),
        '0000000000000000',
        '0000'
      ].join('')
    )
  })
})

describe('Kaspa payments', () => {
  it('spend the largest coin, change to the next change address, and pay 100 sompi a gram', async () => {
    const standIn = kaspaStandIn()
    const fetch = fetchFrom(standIn)
    const state = await KASPA.look(fetch, account)
    expect(state.holdings).toEqual([{ token: null, amount: 5_300_000_000n }])
    expect(state.activity[0]).toMatchObject({ kind: 'Received', amount: 5_000_000_000n })
    const p = await KASPA.pay(fetch, account, state, KAS_THEM, 1_250_000_000n, null, '')
    const tx = p.carry as KaspaTransaction
    // one coin and two outputs: 2036 grams (mainnet's), at 100 sompi each
    expect(p.fee).toBe(203_600n)
    expect(tx.inputs.map((i) => [i.txid, i.chain, i.keyIndex])).toEqual([['11'.repeat(32), 0, 0]])
    expect(tx.outputs.map((o) => [addressOfScript(o.script, 0), o.value, o.ours])).toEqual([
      [KAS_THEM, 1_250_000_000n, undefined],
      [KAS_NEXT_CHANGE, 5_000_000_000n - 1_250_000_000n - 203_600n, { chain: 1, index: 1 }]
    ])
    expect(p.payload).toEqual(request(tx))
    // signed by the coin's key, sent: the stand-in checks it
    const key = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/111111'/0'/0/0")
    const hash = kaspaSignatureHash(
      tx.inputs.map((i) => ({
        txid: hex.decode(i.txid),
        index: i.index,
        sequence: 0n,
        sigOps: 1,
        amount: i.amount,
        script: i.script
      })),
      tx.outputs,
      0
    )
    const bad = Uint8Array.from([
      ...schnorr.sign(hash, HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).privateKey!),
      1
    ])
    await expect(KASPA.submit(fetch, account, p, bad)).rejects.toThrow(/bad signature/)
    const good = Uint8Array.from([...schnorr.sign(hash, key.privateKey!), 1])
    expect(await KASPA.submit(fetch, account, p, good)).toBe(transactionId(tx))
    expect(standIn.sent).toEqual([
      expect.objectContaining({ fee: 203_600n, inputs: [{ txid: '11'.repeat(32), index: 0 }] })
    ])
  })

  it('give change too small to keep to the fee, and won’t send what Kaspa won’t take', async () => {
    const fetch = fetchFrom(kaspaStandIn())
    const state = await KASPA.look(fetch, account)
    // 49.99 of the 50: change of a hundredth less the fee would cost far more than it's worth
    const p = await KASPA.pay(fetch, account, state, KAS_THEM, 4_999_000_000n, null, '')
    expect((p.carry as KaspaTransaction).outputs).toHaveLength(1)
    expect(p.fee).toBe(1_000_000n)
    expect(p.notes.join(' ')).toMatch(/too little to keep as change/)
    await expect(KASPA.pay(fetch, account, state, KAS_THEM, 5_000_000n, null, '')).rejects.toThrow(
      /this small/
    )
    await expect(
      KASPA.pay(fetch, account, state, KAS_THEM, 6_000_000_000n, null, '')
    ).rejects.toThrow(/not enough/)
  })
})
