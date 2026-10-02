/**
 * maki desktop's Aptos payments against the Aptos TypeScript SDK (maki-apt's fixtures, made by
 * @aptos-labs/ts-sdk 7.3.0: tests/fixtures/make.mjs there): each transfer it makes, rebuilt here from
 * the fixture's own fields, is the SDK's RawTransaction byte for byte, and with the SDK's
 * signature put in, its signed transaction and hash.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha3_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APT_ME, APT_THEM, APT_USDC, aptosStandIn, slip10, TEST_SEED } from '../coin-stand-ins'
import type { CoinFetch, SharedAccount } from '../coin-servers'
import { APTOS, type AptosCall, rawTransaction, signedTransaction, transactionHash } from './aptos'

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/aptos-transactions.json'), 'utf8')
) as {
  accounts: { publicKey: string; address: string }[]
  transactions: {
    name: string
    network: number
    raw: string
    signed: string | null
    signature: string | null
    hash: string | null
  }[]
}

/** A RawTransaction's fields, read back (BCS) as far as a transfer needs. */
function read(raw: Uint8Array) {
  let at = 0
  const take = (n: number): Uint8Array => raw.slice(at, (at += n))
  const u64 = (): bigint => new DataView(take(8).buffer).getBigUint64(0, true)
  const uleb = (): number => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const b = raw[at++]
      v += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return v
    }
  }
  const str = (): string => new TextDecoder().decode(take(uleb()))
  const address = (): string => `0x${hex.encode(take(32))}`
  const sender = address()
  const sequence = u64()
  if (uleb() !== 2) return null // not an entry function
  const module = `${address()}::${str()}`
  const fn = str()
  const types: string[] = []
  for (let n = uleb(); n > 0; n--) {
    if (uleb() !== 7) return null
    types.push(`${address()}::${str()}::${str()}`)
    if (uleb() !== 0) return null
  }
  const args: Uint8Array[] = []
  for (let n = uleb(); n > 0; n--) args.push(take(uleb()))
  return {
    sender,
    sequence,
    module,
    fn,
    types,
    args,
    maxGas: u64(),
    gasPrice: u64(),
    expiration: u64()
  }
}

const word = (b: Uint8Array): bigint => new DataView(b.buffer, b.byteOffset).getBigUint64(0, true)
const addr = (b: Uint8Array): string => `0x${hex.encode(b)}`

describe('Aptos payments', () => {
  it('are the SDK’s transactions, signed transactions and hashes, byte for byte', () => {
    const key = hex.decode(fixtures.accounts[0].publicKey.slice(2))
    let checked = 0
    for (const t of fixtures.transactions) {
      if (!t.signed || !t.signature) continue
      const raw = hex.decode(t.raw)
      const f = read(raw)
      if (!f || f.module !== `0x${'0'.repeat(63)}1::aptos_account`) continue
      let call: AptosCall
      if (f.fn === 'transfer' && f.args.length === 2)
        call = { function: 'transfer', to: addr(f.args[0]), amount: word(f.args[1]) }
      else if (f.fn === 'transfer_coins' && f.types.length === 1)
        call = {
          function: 'transfer_coins',
          coin: f.types[0],
          to: addr(f.args[0]),
          amount: word(f.args[1])
        }
      else if (f.fn === 'transfer_fungible_assets')
        call = {
          function: 'transfer_fungible_assets',
          asset: addr(f.args[0]),
          to: addr(f.args[1]),
          amount: word(f.args[2])
        }
      else continue
      const network = t.network === 1 ? 1 : 0
      const mine = rawTransaction({
        sender: f.sender,
        sequence: f.sequence,
        call,
        maxGas: f.maxGas,
        gasPrice: f.gasPrice,
        expiration: f.expiration,
        network
      })
      expect(hex.encode(mine), t.name).toBe(t.raw)
      const signed = signedTransaction(mine, key, hex.decode(t.signature!))
      expect(hex.encode(signed), t.name).toBe(t.signed)
      expect(transactionHash(signed), t.name).toBe(`0x${t.hash!}`)
      checked++
    }
    // APT (both ways), coins, Circle's and Tether's assets, and the test network's
    expect(checked).toBeGreaterThanOrEqual(6)
  })

  it('go to Aptos addresses written in full', () => {
    expect(APTOS.valid(fixtures.accounts[0].address, 0)).toBe(true)
    expect(APTOS.valid(fixtures.accounts[0].address.toUpperCase().replace('0X', '0x'), 0)).toBe(
      true
    )
    expect(APTOS.valid('0x1', 0)).toBe(false)
    expect(APTOS.valid(fixtures.accounts[0].address.slice(0, -1), 0)).toBe(false)
  })
})

describe('the Aptos wallet', () => {
  const secret = slip10(TEST_SEED, [44, 637, 0, 0, 0])
  const account: SharedAccount = {
    network: 0,
    index: 0,
    address: APT_ME,
    publicKey: hex.encode(ed25519.getPublicKey(secret))
  }
  const fetchFrom =
    (standIn: ReturnType<typeof aptosStandIn>): CoinFetch =>
    async (_network, method, path, body, binary) => {
      const bytes = binary ? hex.decode(body!) : new TextEncoder().encode(body ?? '')
      const [status, text] = await standIn.answer(method, path, body ?? '', bytes)
      return { status, text }
    }

  it('shows the account, simulates a USDC payment for its gas, and sends it signed', async () => {
    const standIn = aptosStandIn()
    const fetch = fetchFrom(standIn)
    const state = await APTOS.look(fetch, account)
    expect(state.holdings).toEqual([
      { token: null, amount: 250_000_000n },
      { token: { id: APT_USDC, symbol: 'USDC', decimals: 6 }, amount: 40_000_000n }
    ])
    expect(state.activity[0]).toMatchObject({
      id: '3000000123',
      kind: 'Received',
      amount: 250_000_000n
    })
    const usdc = state.holdings[1].token
    const p = await APTOS.pay(fetch, account, state, APT_THEM, 7_250_000n, usdc, '')
    // 12 units used, half again and 10 more for room, at 100 octas
    expect(p.fee).toBe(2800n)
    expect(p.feeIsMost).toBe(true)
    const signature = ed25519.sign(
      Uint8Array.from([
        ...sha3_256(new TextEncoder().encode('APTOS::RawTransaction')),
        ...p.payload
      ]),
      secret
    )
    const hash = await APTOS.submit(fetch, account, p, signature)
    expect(standIn.sent).toEqual([
      {
        hash,
        sender: APT_ME,
        sequence: 16n,
        function: '0x1::aptos_account::transfer_fungible_assets',
        types: [],
        args: [APT_USDC.slice(2), APT_THEM.slice(2), '50a06e0000000000'],
        maxGas: 28n,
        gasPrice: 100n
      }
    ])
    // the same again is turned away: its sequence number is spent
    await expect(APTOS.submit(fetch, account, p, signature)).rejects.toThrow(/SEQUENCE_NUMBER/)
  })
})
