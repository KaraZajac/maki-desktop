/**
 * maki desktop's Cardano wallet against Cardano's own: the test phrase's account (maki-hd's vectors,
 * made with cardano-serialization-lib: its keys by role, its base, change, test-network and reward
 * addresses), and transaction bodies as CSL 17 makes them (maki-ada's fixtures): every plain payment
 * among them, rebuilt here from its own fields, is CSL's body byte for byte, its ID is CSL's, its
 * request is what maki's app takes, and its witnesses check out over it.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADA_CHANGE, ADA_ME, ADA_SNEK, ADA_THEM, cardanoStandIn, cborRead } from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  accountKey,
  body,
  CARDANO,
  type CardanoInput,
  type CardanoOutput,
  Keys,
  request,
  transaction,
  transactionId
} from './cardano'

const keys = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cardano-keys.json'), 'utf8')
)[0] as Record<string, string>
const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/cardano-transactions.json'), 'utf8')
) as {
  transactions: {
    name: string
    network: string
    body: string
    hash: string
    witnesses: { role: number; index: number; key: string; signature: string }[]
    change: { output: number; role: number; index: number }[]
  }[]
}
const account: SharedAccount = {
  network: 0,
  index: 0,
  address: keys.address,
  publicKey: keys.account
}

/** CBOR, read back as far as a payment's body goes: numbers, bytes, arrays, maps, tags. */
function decode(b: Uint8Array): unknown {
  let at = 0
  const item = (): unknown => {
    const first = b[at++]
    const major = first >> 5
    const info = first & 31
    let n: bigint
    if (info < 24) n = BigInt(info)
    else {
      const len = 1 << (info - 24)
      n = [...b.subarray(at, at + len)].reduce((v, x) => (v << 8n) | BigInt(x), 0n)
      at += len
    }
    if (major === 0) return n
    if (major === 1) return -1n - n
    if (major === 3) return new TextDecoder().decode(b.slice(at, (at += Number(n))))
    if (major === 2) return b.slice(at, (at += Number(n)))
    if (major === 4) return Array.from({ length: Number(n) }, item)
    if (major === 5)
      return new Map(Array.from({ length: Number(n) }, () => [item(), item()] as const))
    if (major === 6) return item() // a tag: what it tags
    if (major === 7) return info === 21 ? true : info === 20 ? false : null
    throw new Error(`major type ${major}`)
  }
  return item()
}

describe('the Cardano account', () => {
  it('is the test phrase’s as CSL makes it: keys by role, addresses', () => {
    const k = new Keys(accountKey(account))
    expect(hex.encode(k.key(0, 0))).toBe(keys.payment0)
    expect(hex.encode(k.key(1, 0))).toBe(keys.change0)
    expect(hex.encode(k.key(2, 0))).toBe(keys.stake0)
    expect(k.address(0, 0, 0)).toBe(keys.address)
    expect(k.address(0, 1, 0)).toBe(keys.changeAddress)
    expect(k.address(1, 0, 0)).toBe(keys.testAddress)
    expect(k.reward(0)).toBe(keys.reward)
    expect(CARDANO.valid(keys.address, 0)).toBe(true)
    expect(CARDANO.valid(keys.testAddress, 0)).toBe(false)
    expect(CARDANO.valid(keys.reward, 0)).toBe(false)
    expect(CARDANO.valid(keys.address.slice(0, -1) + 'x', 0)).toBe(false)
  })
})

describe('Cardano payments', () => {
  it('are CSL’s bodies byte for byte, with CSL’s IDs, and maki’s witnesses check out over them', () => {
    const seen: string[] = []
    for (const t of fixtures.transactions) {
      const bytes = hex.decode(t.body)
      const m = decode(bytes) as Map<bigint, unknown>
      if ([...m.keys()].join() !== '0,1,2,3') continue
      const ins = m.get(0n) as [Uint8Array, bigint][]
      const outs = m.get(1n) as [
        Uint8Array,
        bigint | [bigint, Map<Uint8Array, Map<Uint8Array, bigint>>]
      ][]
      if (!Array.isArray(outs[0])) continue
      const inputs: CardanoInput[] = ins.map(([txid, index]) => ({
        txid: hex.encode(txid),
        index: Number(index),
        lovelace: 0n,
        assets: new Map(),
        role: 0,
        keyIndex: 0
      }))
      const outputs: CardanoOutput[] = outs.map(([address, v], n) => {
        const assets = new Map<string, bigint>()
        if (Array.isArray(v))
          for (const [policy, names] of v[1])
            for (const [name, q] of names) assets.set(hex.encode(policy) + hex.encode(name), q)
        const change = t.change.find((c) => c.output === n)
        return {
          address,
          lovelace: Array.isArray(v) ? v[0] : v,
          assets,
          ...(change ? { change: { role: change.role as 0 | 1, index: change.index } } : {})
        }
      })
      const mine = body(inputs, outputs, m.get(2n) as bigint, m.get(3n) as bigint)
      expect(hex.encode(mine), t.name).toBe(t.body)
      expect(transactionId(mine), t.name).toBe(t.hash)
      // the request: the witnesses' keys, the change, the body
      const req = request(
        t.witnesses.map((w) => ({ role: w.role as 0 | 1, index: w.index })),
        outputs,
        mine
      )
      expect(req[0]).toBe(t.witnesses.length)
      expect(hex.encode(req.subarray(req.length - mine.length))).toBe(t.body)
      // the witnesses go in as they came, and each signs the body's hash
      const signed = transaction(
        mine,
        t.witnesses.map((w) => [hex.decode(w.key), hex.decode(w.signature)])
      )
      const back = decode(signed) as [
        unknown,
        Map<bigint, [Uint8Array, Uint8Array][]>,
        unknown,
        unknown
      ]
      for (const [key, sig] of back[1].get(0n)!)
        expect(ed25519.verify(sig, blake2b(mine, { dkLen: 32 }), key), t.name).toBe(true)
      seen.push(t.name)
    }
    for (const name of ['payment', 'two-keys', 'tokens', 'preprod', 'seventy'])
      expect(seen).toContain(name)
  })
})

describe('the Cardano wallet', () => {
  const fetchFrom =
    (standIn: ReturnType<typeof cardanoStandIn>): CoinFetch =>
    async (_network, method, path, body, binary) => {
      const bytes = binary ? hex.decode(body!) : new TextEncoder().encode(body ?? '')
      const [status, text] = await standIn.answer(method, path, body ?? '', bytes)
      return { status, text }
    }

  it('shows the account’s ADA and tokens, and makes a payment as the ledger prices it', async () => {
    const fetch = fetchFrom(cardanoStandIn())
    const state = await CARDANO.look(fetch, account)
    expect(state.holdings).toEqual([
      { token: null, amount: 125_000_000n },
      { token: { id: ADA_SNEK, symbol: 'SNEK', decimals: 0 }, amount: 500n }
    ])
    expect(state.activity[0]).toMatchObject({ kind: 'Received', amount: 120_000_000n })
    const p = await CARDANO.pay(fetch, account, state, ADA_THEM, 12_500_000n, null, '')
    const bodyBytes = p.carry as Uint8Array
    const fields = new Map(
      (cborRead(bodyBytes)[0] as [bigint, unknown][]).map(([k, v]) => [Number(k), v])
    )
    // the largest coin; 12.5 ADA to them; the rest, with its SNEK, back to the change address
    const outs = fields.get(1) as [Uint8Array, unknown][]
    expect(outs).toHaveLength(2)
    expect(outs[0][1]).toBe(12_500_000n)
    const [changeAda, assets] = outs[1][1] as [bigint, [Uint8Array, [Uint8Array, bigint][]][]]
    expect(hex.encode(assets[0][0]) + hex.encode(assets[0][1][0][0])).toBe(ADA_SNEK)
    expect(assets[0][1][0][1]).toBe(500n)
    expect(changeAda + 12_500_000n + p.fee).toBe(120_000_000n)
    // the fee: 44 a byte of the signed transaction (one witness) and 155,381
    expect(p.fee).toBe(
      44n * BigInt(transaction(bodyBytes, [[new Uint8Array(32), new Uint8Array(64)]]).length) +
        155_381n
    )
    // the request: one key (0/0), the change (output 1, 1/0), the body
    expect(hex.encode(p.payload.subarray(0, 1 + 5 + 1 + 7))).toBe(
      '01' + '0000000000' + '01' + '0100' + '0100000000'
    )
    expect(p.payload.subarray(14)).toEqual(bodyBytes)
  })

  it('pays tokens with the ADA an output must carry, and turns away what Cardano would', async () => {
    const fetch = fetchFrom(cardanoStandIn())
    const state = await CARDANO.look(fetch, account)
    const p = await CARDANO.pay(fetch, account, state, ADA_THEM, 200n, state.holdings[1].token, '')
    expect(p.notes.join(' ')).toMatch(/ADA with the tokens/)
    await expect(CARDANO.pay(fetch, account, state, ADA_THEM, 500_000n, null, '')).rejects.toThrow(
      /at least/
    )
    await expect(
      CARDANO.pay(fetch, account, state, ADA_THEM, 200_000_000n, null, '')
    ).rejects.toThrow(/not enough/)
    await expect(
      CARDANO.pay(fetch, account, state, keys.testAddress, 5_000_000n, null, '')
    ).rejects.toThrow(/isn’t a Cardano address/)
  })

  it('stands in for Koios: CSL’s signed payment is taken, and with a signature changed, it isn’t', async () => {
    const t = fixtures.transactions.find((x) => x.name === 'payment')!
    const bodyBytes = hex.decode(t.body)
    const fields = new Map(
      (cborRead(bodyBytes)[0] as [bigint, unknown][]).map(([k, v]) => [Number(k), v])
    )
    const outs = fields.get(1) as [Uint8Array, bigint][]
    const spent = outs.reduce((s, [, v]) => s + v, 0n) + (fields.get(2) as bigint)
    const coin = (): [
      string,
      { address: string; lovelace: bigint; assets: Record<string, bigint> }
    ][] => [[`${'10'.repeat(32)}#0`, { address: ADA_ME, lovelace: spent, assets: {} }]]
    const witnesses = t.witnesses.map(
      (w) => [hex.decode(w.key), hex.decode(w.signature)] as [Uint8Array, Uint8Array]
    )
    const submit = (standIn: ReturnType<typeof cardanoStandIn>, signed: Uint8Array) =>
      standIn.answer('POST', '/submittx', '', signed)
    const good = cardanoStandIn(coin())
    expect((await submit(good, transaction(bodyBytes, witnesses)))[0]).toBe(202)
    expect(good.sent[0]).toMatchObject({ id: t.hash, fee: fields.get(2), witnesses: 1 })
    const changed = witnesses.map(
      ([k, s]) =>
        [k, Uint8Array.from(s, (b, i) => (i === 0 ? b ^ 1 : b))] as [Uint8Array, Uint8Array]
    )
    expect((await submit(cardanoStandIn(coin()), transaction(bodyBytes, changed)))[0]).toBe(400)
    expect(ADA_CHANGE).toBe(keys.changeAddress)
  })
})
