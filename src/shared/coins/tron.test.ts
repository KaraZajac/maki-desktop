/**
 * maki desktop's Tron payments against TronWeb (maki-trx's fixtures, made by TronWeb 6.5.1 from the
 * header of mainnet's block 86746173): a TRX payment, one with a memo, and a USDT payment, each
 * `raw_data` byte for byte and its ID; the signed transaction as `broadcasthex` takes it; and the
 * test phrase's address, the one Ledger's Tron app publishes.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addressOfKey, rawData, signedTransaction, TRON, txid, type TronPayment } from './tron'

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/tron-transactions.json'), 'utf8')
) as {
  name: string
  raw: string
  txid: string
  signature: string | null
}[]
const fixture = (name: string): { raw: string; txid: string; signature: string | null } =>
  fixtures.find((f) => f.name === name)!

/** The account of a key of `n`s, as the fixtures' other parties are. */
const other = (n: number): string =>
  addressOfKey(secp256k1.getPublicKey(new Uint8Array(32).fill(n), false))
const ME = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
// block 86746173's header, as the fixtures were made from it
const made = 1790911131000
const header = {
  refBlockBytes: hex.decode('a43d'),
  refBlockHash: hex.decode('93b3e5e6ef2de832'),
  timestamp: made,
  expiration: made + 60_000
}

describe('Tron payments', () => {
  it('are the transactions TronWeb makes, byte for byte', () => {
    const cases: [string, TronPayment][] = [
      ['trx', { ...header, owner: ME, to: other(1), amount: 1_500_000n }],
      [
        'memo',
        { ...header, owner: ME, to: other(1), amount: 20_000_000n, memo: 'thanks for the coffee' }
      ],
      [
        'usdt',
        {
          ...header,
          owner: ME,
          to: other(1),
          amount: 5_250_000n,
          token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          feeLimit: 30_000_000n
        }
      ]
    ]
    for (const [name, p] of cases) {
      const raw = rawData(p)
      expect(hex.encode(raw), name).toBe(fixture(name).raw)
      expect(txid(raw), name).toBe(fixture(name).txid)
    }
  })

  it('puts the signature in as broadcasthex takes it', () => {
    const f = fixture('trx')
    // TronWeb writes v in capitals (1B, 1C)
    const signature = f.signature!.toLowerCase()
    const signed = signedTransaction(hex.decode(f.raw), hex.decode(signature))
    // field 1, raw_data; field 2, the 65-byte signature
    expect(hex.encode(signed.subarray(signed.length - 67, signed.length - 65))).toBe('1241')
    expect(hex.encode(signed.subarray(signed.length - 65))).toBe(signature)
  })

  it('reads and writes addresses', () => {
    expect(TRON.valid(ME, 0)).toBe(true)
    expect(TRON.valid(other(1), 1)).toBe(true)
    expect(TRON.valid(ME.slice(0, -1) + 'J', 0)).toBe(false)
    expect(TRON.valid('0x9858EfFD232B4033E47d90003D41EC34EcaEda94', 0)).toBe(false)
  })
})
