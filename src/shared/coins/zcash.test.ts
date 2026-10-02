/**
 * maki desktop's Zcash wallet against Zcash's own: the test phrase's t-addresses as zcash_transparent
 * derives them, and every transaction maki-zec's fixtures hold (made by librustzcash, signed as
 * zcash_transparent signs), rebuilt from its parts, byte for byte: what maki is asked to sign, the
 * transaction unsigned and signed, its ID and each input's ZIP-244 digest, its ZIP-317 fee. Then the
 * wallet against a stand-in for zecblock that reads each payment itself and takes it only if every
 * input's signature checks out by its coin's key: what it shows, the payments it makes, what's on
 * its way meanwhile, and what it refuses.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TEST_SEED,
  ZEC_CHANGE,
  ZEC_ME,
  ZEC_NEXT_CHANGE,
  ZEC_THEM,
  ZEC_THEM_TEX,
  ZEC_THEM_TEX_T,
  zecblockStandIn,
  zecKey,
  zecSighash
} from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  conventionalFee,
  keyAddress,
  payTo,
  readSignatures,
  request,
  signatureHash,
  transaction,
  transactionId,
  ZCASH,
  type ZecTransaction
} from './zcash'

/** maki-zec's fixtures: librustzcash's transactions for the test phrase's account. */
const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/zcash-transactions.json'), 'utf8')
) as {
  account: { chainCode: string; key: string }
  addresses: { address: string; chain: 0 | 1; index: number; network: 0 | 1 }[]
  payees: Record<'p2pkh' | 'p2pkhTest' | 'p2sh' | 'p2shTest' | 'tex' | 'texTest', string>
  transactions: {
    name: string
    network: 0 | 1
    request: string
    unsigned: string
    signed: string
    txid: string
    sighashes: string[]
    signatures: string[] | null
    conventionalFee: number
  }[]
}

/** A request read back (maki-zec's format), into the parts the wallet makes it from. */
function readRequest(
  bytes: Uint8Array,
  network: 0 | 1
): ZecTransaction & { lockTime: number; sequences: number[] } {
  let at = 0
  const take = (n: number): Uint8Array => bytes.subarray((at += n) - n, at)
  const le = (n: number): number => take(n).reduceRight((v, x) => v * 256 + x, 0)
  const u64 = (): bigint => BigInt(le(4)) + (BigInt(le(4)) << 32n)
  le(2)
  le(12)
  const lockTime = le(4)
  const expiry = le(4)
  const keys = (n: number): HDKey => {
    const k = new HDKey({
      publicKey: hex.decode(fixtures.account.key),
      chainCode: hex.decode(fixtures.account.chainCode)
    })
    return n === 0 ? k : HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/1'/0'")
  }
  const raw = Array.from({ length: le(1) }, () => {
    const txid = hex.encode(take(32).slice().reverse())
    const vout = le(4)
    le(1)
    return { txid, vout, sequence: le(4) }
  })
  const outs = Array.from({ length: le(1) }, () => ({ value: u64(), script: take(le(1)).slice() }))
  le(3)
  const inputs = raw.map((r) => {
    const value = u64()
    const script = take(le(1)).slice()
    const chain = le(1) as 0 | 1
    const index = le(4)
    return {
      ...r,
      value,
      script,
      chain,
      index,
      key: keys(network).deriveChild(chain).deriveChild(index).publicKey!
    }
  })
  const outputs = outs.map((o) => {
    const shown = le(1)
    return {
      ...o,
      shown: shown === 1 ? (le(1), { change: le(4) }) : (shown as 0 | 2)
    }
  })
  return { expiry, inputs, outputs, lockTime, sequences: raw.map((r) => r.sequence) }
}

describe('Zcash addresses', () => {
  it('are the test phrase’s, as zcash_transparent derives them, on both networks', () => {
    const main = new HDKey({
      publicKey: hex.decode(fixtures.account.key),
      chainCode: hex.decode(fixtures.account.chainCode)
    })
    const test = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/1'/0'")
    for (const a of fixtures.addresses) {
      const k = (a.network === 0 ? main : test).deriveChild(a.chain).deriveChild(a.index).publicKey!
      expect(keyAddress(k, a.network)).toBe(a.address)
    }
    expect(ZEC_ME).toBe('t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F')
    expect(ZEC_CHANGE).toBe('t1YF8h4qviS77p36wWdUfe8faw4DXduYZnm')
  })

  it('pay a key’s hash, a script’s, or a TEX address’s key hash, each on its own network', () => {
    const p = fixtures.payees
    expect(payTo(p.p2pkh, 0)?.shown).toBe(0)
    expect(hex.encode(payTo(p.p2sh, 0)!.script)).toMatch(/^a914[0-9a-f]{40}87$/)
    // a TEX address pays its key's hash, shown as the TEX address (ZIP-320's vector)
    expect(payTo(ZEC_THEM_TEX, 0)).toEqual({ script: payTo(ZEC_THEM_TEX_T, 0)!.script, shown: 2 })
    expect(payTo(p.tex, 0)?.shown).toBe(2)
    expect(payTo(p.tex.toUpperCase(), 0)?.shown).toBe(2)
    expect(payTo(p.tex.slice(0, 5) + p.tex.slice(5).toUpperCase(), 0)).toBeNull()
    expect(payTo(p.texTest, 1)?.shown).toBe(2)
    expect(payTo(p.p2pkhTest, 1)?.shown).toBe(0)
    expect(payTo(p.p2shTest, 1)).not.toBeNull()
    // another network's, or a typo, no
    expect(payTo(p.p2pkh, 1)).toBeNull()
    expect(payTo(p.tex, 1)).toBeNull()
    expect(payTo(p.p2pkh.slice(0, -1) + 'x', 0)).toBeNull()
  })
})

describe('Zcash transactions', () => {
  it('are librustzcash’s, byte for byte: the request, unsigned and signed, its ID and digests, its fee', () => {
    let checked = 0
    for (const f of fixtures.transactions) {
      const tx = readRequest(hex.decode(f.request), f.network)
      // the wallet makes no lock time, and final sequences: the fixtures' that have them aren't its
      if (tx.lockTime !== 0 || tx.sequences.some((s) => s !== 0xffffffff)) continue
      checked++
      expect(hex.encode(request(tx)), f.name).toBe(f.request)
      expect(hex.encode(transaction(tx)), f.name).toBe(f.unsigned)
      // the ID as explorers show it: the digest's bytes reversed (the fixtures have them as hashed)
      expect(transactionId(tx), f.name).toBe(hex.encode(hex.decode(f.txid).reverse()))
      tx.inputs.forEach((_, n) =>
        expect(hex.encode(signatureHash(tx, n)), f.name).toBe(f.sighashes[n])
      )
      expect(
        conventionalFee(
          tx.inputs.length,
          tx.outputs.map((o) => o.script)
        ),
        f.name
      ).toBe(BigInt(f.conventionalFee))
      // the stand-in's own digest agrees
      const parsed = {
        version: 0x80000005,
        group: 0x26a7270a,
        branch: 0x37a5165b,
        lockTime: 0,
        expiry: tx.expiry,
        inputs: tx.inputs.map((i) => ({
          prevout: Uint8Array.from([
            ...hex.decode(i.txid).reverse(),
            i.vout & 0xff,
            (i.vout >> 8) & 0xff,
            0,
            0
          ]),
          script: new Uint8Array(),
          sequence: 0xffffffff
        })),
        outputs: tx.outputs.map((o) => ({ value: o.value, script: o.script }))
      }
      tx.inputs.forEach((_, n) =>
        expect(hex.encode(zecSighash(parsed, tx.inputs, n)), f.name).toBe(f.sighashes[n])
      )
      if (!f.signatures) continue
      const sigs = f.signatures.map((s) => hex.decode(s))
      const answer = Uint8Array.from(sigs.flatMap((s) => [s.length, ...s]))
      expect(readSignatures(answer, tx.inputs.length)).toEqual(sigs)
      expect(
        hex.encode(
          transaction(
            tx,
            sigs.map((s, n) => Uint8Array.of(s.length, ...s, 0x21, ...tx.inputs[n].key))
          )
        ),
        f.name
      ).toBe(f.signed)
    }
    expect(checked).toBeGreaterThanOrEqual(9)
  })

  it('have the ID zecblock shows for one on Zcash itself', () => {
    // c4478a55…, mined at 3,503,949 on 2026-10-02: one coin, paying two t-addresses
    const tx: ZecTransaction = {
      expiry: 3_503_989,
      inputs: [
        {
          txid: '3847fb17c28107242c3b5f16ce386e85c03b9e668f4d4a49c3565328e3169fda',
          vout: 0,
          value: 7_248_093_683n,
          script: new Uint8Array(),
          chain: 0,
          index: 0,
          key: new Uint8Array()
        }
      ],
      outputs: [
        {
          value: 12_641_499n,
          script: payTo('t1Zq4XZkjshSReN7FQJLSCgjA9yXFhstM1c', 0)!.script,
          shown: 0
        },
        {
          value: 7_235_429_384n,
          script: payTo('t1awPHzk68j8ZBqCLZ4hL77wa5g6j3DePoC', 0)!.script,
          shown: 0
        }
      ]
    }
    expect(transactionId(tx)).toBe(
      'c4478a55931254428181016994399d1fc1a77b066e30b239abc8afc2cd9c1028'
    )
  })
})

const fetchFrom =
  (standIn: ReturnType<typeof zecblockStandIn>): CoinFetch =>
  async (_network, method, path, body) => {
    const [status, text] = await standIn.answer(method, path, body ?? '')
    return { status, text }
  }

/** The test phrase's account, as maki's Zcash app shares it. */
const account: SharedAccount = (() => {
  const k = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/133'/0'")
  return {
    network: 0,
    index: 0,
    address: ZEC_ME,
    publicKey: hex.encode(Uint8Array.from([...k.publicKey!, ...k.chainCode!]))
  }
})()

/** maki's signatures for a payment, as its Zcash app answers them. */
function signed(
  tx: ZecTransaction,
  by = (chain: 0 | 1, index: number) => zecKey(chain, index)
): Uint8Array {
  return Uint8Array.from(
    tx.inputs.flatMap((i, n) => {
      const sig = [
        ...secp256k1.sign(signatureHash(tx, n), by(i.chain, i.index).privateKey!, {
          prehash: false,
          format: 'der'
        }),
        1
      ]
      return [sig.length, ...sig]
    })
  )
}

describe('the Zcash wallet', () => {
  it('shows the account’s coins on two addresses, and their history', async () => {
    const state = await ZCASH.look(fetchFrom(zecblockStandIn()), account)
    expect(state.holdings).toEqual([{ token: null, amount: 175_000_000n }])
    expect(state.activity.map((a) => [a.kind, a.amount])).toEqual([
      ['Received', 25_000_000n],
      ['Received', 150_000_000n]
    ])
  })

  it('pays from both coins, change to the next change address, at ZIP-317’s fee: zecblock takes it', async () => {
    const standIn = zecblockStandIn()
    const fetch = fetchFrom(standIn)
    const state = await ZCASH.look(fetch, account)
    const p = await ZCASH.pay(fetch, account, state, ZEC_THEM, 160_000_000n, null, '')
    const { tx } = p.carry as { tx: ZecTransaction }
    // two inputs, two outputs: two actions, 10,000 zatoshis
    expect(p.fee).toBe(10_000n)
    expect(tx.expiry).toBe(3_503_950 + 1 + 40)
    expect(tx.inputs.map((i) => [i.txid, i.vout, i.chain, i.index])).toEqual([
      ['a1'.repeat(32), 0, 0, 0],
      ['b2'.repeat(32), 1, 1, 0]
    ])
    expect(tx.outputs.map((o) => [o.value, o.shown])).toEqual([
      [160_000_000n, 0],
      [175_000_000n - 160_000_000n - 10_000n, { change: 1 }]
    ])
    expect(keyAddress(zecKey(1, 1).publicKey!, 0)).toBe(ZEC_NEXT_CHANGE)
    expect(p.payload).toEqual(request(tx))
    // signed by another key: refused here, before it's sent
    const other = HDKey.fromMasterSeed(new Uint8Array(32).fill(9))
    await expect(
      ZCASH.submit(
        fetch,
        account,
        p,
        signed(tx, () => other)
      )
    ).rejects.toThrow(/doesn’t check out/)
    const id = await ZCASH.submit(fetch, account, p, signed(tx))
    expect(id).toBe(transactionId(tx))
    expect(standIn.sent).toEqual([
      {
        txid: id,
        inputs: [
          { txid: 'a1'.repeat(32), vout: 0 },
          { txid: 'b2'.repeat(32), vout: 1 }
        ],
        outputs: [
          { address: ZEC_THEM, value: 160_000_000n },
          { address: ZEC_NEXT_CHANGE, value: 14_990_000n }
        ],
        fee: 10_000n
      }
    ])

    // on its way: what it spends counted out, its change still the account's, and shown waiting
    const waiting = await ZCASH.look(fetch, account)
    expect(waiting.holdings[0].amount).toBe(14_990_000n)
    expect(waiting.activity[0]).toMatchObject({
      id,
      kind: 'Sent',
      amount: -160_010_000n,
      time: null
    })
    expect(waiting.notes.join(' ')).toMatch(/waits for a block/)
    // nothing else to spend meanwhile: the coins zecblock still calls unspent aren't offered again
    await expect(
      ZCASH.pay(fetch, account, waiting, ZEC_THEM, 1_000_000n, null, '')
    ).rejects.toThrow(/a payment on its way has some of it/)
    // in a block: zecblock has it, and the change is a coin of the account's
    standIn.mine()
    const mined = await ZCASH.look(fetch, account)
    expect(mined.holdings[0].amount).toBe(14_990_000n)
    expect(mined.activity[0]).toMatchObject({ id, kind: 'Sent', amount: -160_010_000n })
    expect(mined.activity[0].time).not.toBeNull()
  })

  it('pays a TEX address as the key’s hash it is, shown to maki as the TEX address', async () => {
    const standIn = zecblockStandIn()
    const fetch = fetchFrom(standIn)
    const state = await ZCASH.look(fetch, account)
    const p = await ZCASH.pay(fetch, account, state, ZEC_THEM_TEX, 1_000_000n, null, '')
    const { tx } = p.carry as { tx: ZecTransaction }
    expect(tx.outputs[0]).toMatchObject({ value: 1_000_000n, shown: 2 })
    await ZCASH.submit(fetch, account, p, signed(tx))
    expect(standIn.sent[0].outputs[0]).toEqual({ address: ZEC_THEM_TEX_T, value: 1_000_000n })
  })

  it('won’t make a payment once Zcash follows rules maki’s app doesn’t know', async () => {
    const fetch = fetchFrom(zecblockStandIn({ nextBranch: '77190ad9' }))
    const state = await ZCASH.look(fetch, account)
    await expect(ZCASH.pay(fetch, account, state, ZEC_THEM, 1_000_000n, null, '')).rejects.toThrow(
      /NU7’s rules, and maki’s Zcash app signs for NU6.3’s: it needs an update/
    )
  })
})
