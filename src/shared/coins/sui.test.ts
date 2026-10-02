/**
 * maki desktop's Sui payments against @mysten/sui 2.33.2 (maki-sui's fixtures: tests/fixtures/
 * make.mjs there, the SDK's own coin and address-balance logic run against a stand-in): each send
 * the wallet makes (SUI from coins and from the address balance, a coin from coins and from the
 * address balance), rebuilt here from the fixture's fields, is the SDK's TransactionData byte for
 * byte, what maki signs of it is the fixture's, and the test phrase's key signed it.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { base58, hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { slip10, SUI_ME, SUI_THEM, SUI_USDC, suiStandIn, TEST_SEED } from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import {
  fromBalance,
  fromCoins,
  type ObjectRef,
  SUI,
  type SuiTransaction,
  transactionData,
  transactionDigest
} from './sui'

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/sui-transactions.json'), 'utf8')
) as {
  accounts: { address: string; key: string }[]
  transactions: { name: string; tx: string; digest: string; signature: string | null }[]
}

/** The fields of a fixture's transaction a send is made from, read back (BCS). */
function read(b: Uint8Array) {
  let at = 0
  const take = (n: number): Uint8Array => b.slice(at, (at += n))
  const uleb = (): number => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const x = b[at++]
      v += (x & 0x7f) * 2 ** shift
      if (!(x & 0x80)) return v
    }
  }
  const int = (n: number): bigint => [...take(n)].reduceRight((v, x) => (v << 8n) | BigInt(x), 0n)
  const address = (): string => `0x${hex.encode(take(32))}`
  const ref = (): ObjectRef => ({ id: address(), version: int(8), digest: take(uleb()) })
  const typeTag = (): string => {
    if (uleb() !== 7) throw new Error('a type maki desktop doesn’t write')
    const t = `${address()}::${new TextDecoder().decode(take(uleb()))}::${new TextDecoder().decode(take(uleb()))}`
    if (uleb() !== 0) throw new Error('type arguments')
    return t
  }
  if (uleb() !== 0 || uleb() !== 0) return null
  const pure: Uint8Array[] = []
  const owned: ObjectRef[] = []
  let withdraw: { amount: bigint; type: string } | null = null
  for (let n = uleb(); n > 0; n--) {
    const k = uleb()
    if (k === 0) pure.push(take(uleb()))
    else if (k === 1 && uleb() === 0) owned.push(ref())
    else if (k === 2) {
      uleb()
      const amount = int(8)
      uleb()
      withdraw = { amount, type: typeTag() }
      uleb()
    } else return null
  }
  // skip the commands: the test rebuilds them, and the bytes say whether they're the same
  const commandsAt = at
  return { pure, owned, withdraw, commandsAt, tail: () => b }
}

/** The gas data and expiration after the commands: found by trying the rebuilt commands' length. */
function gasAndExpiry(b: Uint8Array, from: number) {
  let at = from
  const take = (n: number): Uint8Array => b.slice(at, (at += n))
  const uleb = (): number => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const x = b[at++]
      v += (x & 0x7f) * 2 ** shift
      if (!(x & 0x80)) return v
    }
  }
  const int = (n: number): bigint => [...take(n)].reduceRight((v, x) => (v << 8n) | BigInt(x), 0n)
  const address = (): string => `0x${hex.encode(take(32))}`
  const sender = address()
  const payment = Array.from({ length: uleb() }, () => ({
    id: address(),
    version: int(8),
    digest: take(uleb())
  }))
  address()
  const price = int(8)
  const budget = int(8)
  const kind = uleb()
  let expiration: SuiTransaction['expiration'] = null
  if (kind === 2) {
    take(1)
    const min = int(8)
    take(1)
    const max = int(8)
    take(2)
    const chain = take(uleb())
    expiration = { min, max, chain, nonce: Number(int(4)) }
  }
  return { sender, payment, price, budget, expiration }
}

describe('Sui payments', () => {
  const me = fixtures.accounts[0]
  const word = (b: Uint8Array): bigint => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n)

  for (const [name, make] of [
    [
      'sui',
      (f: NonNullable<ReturnType<typeof read>>) =>
        fromCoins(`0x${hex.encode(f.pure[1])}`, word(f.pure[0]), null)
    ],
    [
      'ab-sui',
      (f: NonNullable<ReturnType<typeof read>>) =>
        fromBalance(me.address, `0x${hex.encode(f.pure[0])}`, f.withdraw!.amount)
    ],
    [
      'token-send-funds',
      (f: NonNullable<ReturnType<typeof read>>) =>
        fromCoins(
          `0x${hex.encode(f.pure[1])}`,
          word(f.pure[0]),
          f.owned,
          '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
        )
    ],
    [
      'ab-usdc',
      (f: NonNullable<ReturnType<typeof read>>) =>
        fromBalance(me.address, `0x${hex.encode(f.pure[0])}`, f.withdraw!.amount, f.withdraw!.type)
    ]
  ] as const) {
    it(`is the SDK’s ${name}, byte for byte, with its digest and the account’s signature`, () => {
      const t = fixtures.transactions.find((x) => x.name === name)!
      const bytes = hex.decode(t.tx)
      const f = read(bytes)!
      const parts = make(f)
      // the commands' length: the rebuilt transaction's, up to the sender
      const probe = transactionData({
        sender: me.address,
        ...parts,
        payment: [],
        price: 0n,
        budget: 0n,
        expiration: null
      })
      const gas = gasAndExpiry(bytes, probe.length - 32 - 1 - 32 - 8 - 8 - 1)
      const tx: SuiTransaction = { ...gas, ...parts }
      const mine = transactionData(tx)
      expect(hex.encode(mine)).toBe(t.tx)
      // what maki signs: the hash of Sui's intent and the transaction (the fixture's digest)
      const message = blake2b(Uint8Array.from([0, 0, 0, ...mine]), { dkLen: 32 })
      expect(hex.encode(message)).toBe(t.digest)
      expect(ed25519.verify(hex.decode(t.signature!), message, hex.decode(me.key))).toBe(true)
      // and the digest explorers show it by: the SDK's getDigestFromBytes
      const tagged = Uint8Array.from([...new TextEncoder().encode('TransactionData::'), ...mine])
      expect(transactionDigest(mine)).toBe(base58.encode(blake2b(tagged, { dkLen: 32 })))
    })
  }

  it('go to Sui addresses written in full', () => {
    expect(SUI.valid(me.address, 0)).toBe(true)
    expect(SUI.valid('0x2', 0)).toBe(false)
    expect(SUI.valid(me.address.slice(0, -1), 0)).toBe(false)
  })
})

describe('the Sui wallet', () => {
  const secret = slip10(TEST_SEED, [44, 784, 0, 0, 0])
  const account: SharedAccount = {
    network: 0,
    index: 0,
    address: SUI_ME,
    publicKey: hex.encode(ed25519.getPublicKey(secret))
  }
  const fetchFrom =
    (standIn: ReturnType<typeof suiStandIn>): CoinFetch =>
    async (_network, method, path, body) => {
      const [status, text] = await standIn.answer(method, path, body ?? '')
      return { status, text }
    }
  const sign = (payload: Uint8Array, by = secret): Uint8Array =>
    ed25519.sign(blake2b(Uint8Array.from([0, 0, 0, ...payload]), { dkLen: 32 }), by)
  const SUI_FULL = `0x${'0'.repeat(63)}2::sui::SUI`
  const USDC_FULL = SUI_USDC

  it('is the test phrase’s account', () => {
    expect(
      `0x${hex.encode(blake2b(Uint8Array.of(0, ...ed25519.getPublicKey(secret)), { dkLen: 32 }))}`
    ).toBe(SUI_ME)
  })

  it('shows SUI and USDC, sends SUI from its coins, and USDC from its address balance', async () => {
    const standIn = suiStandIn()
    const fetch = fetchFrom(standIn)
    const state = await SUI.look(fetch, account)
    expect(state.holdings).toEqual([
      { token: null, amount: 4_000_000_000n },
      { token: { id: USDC_FULL, symbol: 'USDC', decimals: 6 }, amount: 20_000_000n }
    ])
    expect(state.activity[0]).toMatchObject({ kind: 'Received', amount: 4_000_000_000n })
    const p = await SUI.pay(fetch, account, state, SUI_THEM, 1_250_000_000n, null, '')
    // the simulated cost (computation and storage), half again
    expect(p.fee).toBe(4_464_000n)
    await SUI.submit(fetch, account, p, sign(p.payload))
    const q = await SUI.pay(
      fetch,
      account,
      state,
      SUI_THEM,
      7_500_000n,
      state.holdings[1].token,
      ''
    )
    // the gas coins were spent by the first: this one's fee comes from the address balance
    expect(q.notes.join(' ')).toMatch(/address balance/)
    await SUI.submit(fetch, account, q, sign(q.payload))
    expect(standIn.sent.map((s) => [s.payments, s.gas])).toEqual([
      [[{ to: SUI_THEM, amount: 1_250_000_000n, type: SUI_FULL }], 'coins'],
      [[{ to: SUI_THEM, amount: 7_500_000n, type: USDC_FULL }], 'address balance']
    ])
  })

  it('sends SUI from the address balance alone, good this epoch and the next only', async () => {
    const standIn = suiStandIn({ withCoins: false })
    const fetch = fetchFrom(standIn)
    const state = await SUI.look(fetch, account)
    const p = await SUI.pay(fetch, account, state, SUI_THEM, 500_000_000n, null, '')
    await expect(
      SUI.submit(fetch, account, p, sign(p.payload, ed25519.utils.randomSecretKey()))
    ).rejects.toThrow(/another key|doesn’t check out/)
    await SUI.submit(fetch, account, p, sign(p.payload))
    expect(standIn.sent).toEqual([
      expect.objectContaining({
        payments: [{ to: SUI_THEM, amount: 500_000_000n, type: SUI_FULL }],
        gas: 'address balance'
      })
    ])
    await expect(
      SUI.pay(fetch, account, state, SUI_THEM, 2_000_000_000n, null, '')
    ).rejects.toThrow(/not enough SUI/)
  })
})
