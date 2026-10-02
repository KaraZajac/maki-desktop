/**
 * maki desktop's Cosmos sends against CosmJS 0.39 (maki-atom's fixtures: tests/fixtures/make.mjs
 * there): every bank send's sign doc among them, on every chain, rebuilt here from its own fields,
 * is CosmJS's byte for byte (escapes and all), and the plain send's whole transaction, with CosmJS's
 * signature, is its TxRaw byte for byte; the test phrase's address on each chain.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATOM_KEY, atomOf, atomThem, cosmosStandIn, TEST_SEED } from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  addressOf,
  COSMOS,
  COSMOS_CHAINS,
  type CosmosSend,
  signDoc,
  transactionHash,
  txRaw
} from './cosmos'

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cosmos-signdocs.json'), 'utf8')
) as {
  name: string
  chain: string
  doc: string
  signature: string | null
  tx: string | null
}[]
/** The test phrase's key at m/44'/118'/0'/0/0, as the Hub has it on chain. */
const KEY = base64.decode('Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti')

/** A sign doc's fields, if it's one bank send of one coin, its fee in that coin. */
function sendOf(doc: string): CosmosSend | null {
  const d = JSON.parse(doc) as {
    account_number: string
    chain_id: string
    fee: {
      amount: { amount: string; denom: string }[]
      gas: string
      payer?: string
      granter?: string
    }
    memo: string
    msgs: {
      type: string
      value: {
        amount: { amount: string; denom: string }[]
        from_address: string
        to_address: string
      }
    }[]
    sequence: string
    timeout_height?: string
  }
  const m = d.msgs[0]
  if (d.msgs.length !== 1 || m.type !== 'cosmos-sdk/MsgSend' || m.value.amount.length !== 1)
    return null
  if (d.fee.payer || d.fee.granter || d.timeout_height) return null
  const fee = d.fee.amount[0]
  if (d.fee.amount.length > 1 || (fee && fee.denom !== m.value.amount[0].denom)) return null
  // a fee of nothing, written as a coin of 0: not something the wallet makes
  if (fee?.amount === '0') return null
  return {
    chainId: d.chain_id,
    accountNumber: d.account_number,
    sequence: d.sequence,
    from: m.value.from_address,
    to: m.value.to_address,
    denom: m.value.amount[0].denom,
    amount: BigInt(m.value.amount[0].amount),
    fee: BigInt(fee?.amount ?? 0),
    gas: BigInt(d.fee.gas),
    memo: d.memo
  }
}

describe('Cosmos sends', () => {
  it('are CosmJS’s sign docs byte for byte, on every chain', () => {
    const seen: string[] = []
    for (const f of fixtures) {
      const send = sendOf(f.doc)
      if (!send) continue
      expect(new TextDecoder().decode(signDoc(send)), f.name).toBe(f.doc)
      // and the test phrase's key signed it, as maki's app would
      if (f.signature)
        expect(
          secp256k1.verify(hex.decode(f.signature), sha256(signDoc(send)), KEY, { prehash: false }),
          f.name
        ).toBe(true)
      seen.push(f.name)
    }
    for (const name of [
      'send',
      'send-memo',
      'send-escapes',
      'send-osmosis',
      'send-dydx',
      'send-noble',
      'send-hubtest'
    ])
      expect(seen).toContain(name)
  })

  it('make CosmJS’s transaction, with maki’s signature in it', () => {
    const f = fixtures.find((x) => x.name === 'send')!
    const raw = txRaw(sendOf(f.doc)!, KEY, hex.decode(f.signature!))
    expect(hex.encode(raw)).toBe(f.tx)
    expect(transactionHash(raw)).toBe(hex.encode(sha256(hex.decode(f.tx!))).toUpperCase())
  })

  it('come from the test phrase’s account, its address on each chain', () => {
    expect(addressOf(KEY, 'cosmos')).toBe('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4')
    for (const [spec, chain] of COSMOS_CHAINS.map((s, i) => [s, COSMOS[i]] as const)) {
      const address = addressOf(KEY, spec.prefix)
      expect(chain.valid(address, 0), spec.name).toBe(true)
      expect(address.slice(spec.prefix.length + 1, -6)).toBe('9rl4cm2hmr8afy4kldpxz3fka4jguq0a')
    }
    expect(COSMOS[0].valid('osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', 0)).toBe(false)
  })
})

describe('the Cosmos wallet', () => {
  const key = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/118'/0'/0/0")
  const fetchFrom =
    (standIn: ReturnType<typeof cosmosStandIn>): CoinFetch =>
    async (_network, method, path, body) => {
      const [status, text] = await standIn.answer(method, path, body ?? '')
      return { status, text }
    }
  const sign = (doc: Uint8Array): Uint8Array =>
    secp256k1.sign(sha256(doc), key.privateKey!, { prehash: false, format: 'compact' })

  it('is the test phrase’s key', () => {
    expect(hex.encode(key.publicKey!)).toBe(hex.encode(ATOM_KEY))
  })

  for (const [n, gasPrice, fee] of [
    [0, 0.005, 499n],
    [1, 0.03, 2_992n]
  ] as const) {
    const spec = COSMOS_CHAINS[n]
    it(`sends ${spec.symbol} on ${spec.name}: gas simulated, priced, signed, taken`, async () => {
      const standIn = cosmosStandIn({
        id: spec.chainIds[0],
        prefix: spec.prefix,
        denom: spec.denom,
        gasPrice
      })
      const fetch = fetchFrom(standIn)
      const account: SharedAccount = {
        network: 0,
        index: 0,
        address: atomOf(spec.prefix),
        publicKey: hex.encode(ATOM_KEY)
      }
      const chain = COSMOS[n]
      const state = await chain.look(fetch, account)
      expect(state.holdings).toEqual([{ token: null, amount: 25_000_000n }])
      expect(state.notes.join(' ')).toMatch(/1 other coin/)
      expect(state.activity[0]).toMatchObject({ kind: 'Received', amount: 25_000_000n })
      const p = await chain.pay(
        fetch,
        account,
        state,
        atomThem(spec.prefix),
        1_500_000n,
        null,
        'thanks <3 & more'
      )
      // 71,234 gas used, 1.4 times that for room, at the chain's price, rounded up
      expect(p.fee).toBe(fee)
      const hash = await chain.submit(fetch, account, p, sign(p.payload))
      expect(standIn.sent).toEqual([
        {
          hash,
          from: account.address,
          to: atomThem(spec.prefix),
          amount: 1_500_000n,
          denom: spec.denom,
          fee,
          gas: 99_728n,
          memo: 'thanks <3 & more',
          sequence: 7n
        }
      ])
      // the same again: its sequence is spent
      await expect(chain.submit(fetch, account, p, sign(p.payload))).rejects.toThrow(/sequence/)
    })
  }

  it('is turned away when another key signs', async () => {
    const standIn = cosmosStandIn({
      id: 'cosmoshub-4',
      prefix: 'cosmos',
      denom: 'uatom',
      gasPrice: 0.005
    })
    const fetch = fetchFrom(standIn)
    const account: SharedAccount = {
      network: 0,
      index: 0,
      address: atomOf('cosmos'),
      publicKey: hex.encode(ATOM_KEY)
    }
    const state = await COSMOS[0].look(fetch, account)
    const p = await COSMOS[0].pay(fetch, account, state, atomThem('cosmos'), 1n, null, '')
    const other = secp256k1.sign(sha256(p.payload), secp256k1.utils.randomSecretKey(), {
      prehash: false,
      format: 'compact'
    })
    await expect(COSMOS[0].submit(fetch, account, p, other)).rejects.toThrow(
      /signature verification failed/
    )
  })
})
