/**
 * maki desktop's Stellar payments against @stellar/stellar-base (`fixtures/make-stellar.mjs`): each
 * envelope unsigned, its hash on its network, and with stellar-base's signature put in, signed, byte
 * for byte; and the test phrase's account's address (SEP-5).
 */
import { base64, hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountAddress,
  accountKey,
  envelope,
  STELLAR,
  transactionHash,
  type StellarPayment
} from './stellar'

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/stellar-payments.json'), 'utf8')
) as {
  address: string
  other: string
  cases: Record<
    string,
    { network: 0 | 1; unsigned: string; signed: string; hash: string; signature: string }
  >
}
const USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const base = (over: Partial<StellarPayment>): StellarPayment => ({
  source: vectors.address,
  fee: 150,
  sequence: 123456789013n,
  maxTime: 1_800_000_000n,
  memo: '',
  kind: 'payment',
  destination: vectors.other,
  asset: 'native',
  amount: 0n,
  ...over
})
const PAYMENTS: Record<string, StellarPayment> = {
  xlm: base({ amount: 125_000_000n }),
  memo: base({ amount: 1n, memo: 'invoice 42' }),
  usdc: base({ asset: { code: 'USDC', issuer: USDC }, amount: 31_415_926n }),
  long: base({ asset: { code: 'LONGTOKEN12', issuer: USDC }, amount: 10_000_000n }),
  create: base({ kind: 'create', amount: 10_000_000n, memo: 'hello' })
}

describe('Stellar payments', () => {
  it('are the envelopes stellar-base makes, unsigned and signed, and its hashes', () => {
    for (const [name, p] of Object.entries(PAYMENTS)) {
      const c = vectors.cases[name]
      expect(base64.encode(envelope(p)), name).toBe(c.unsigned)
      expect(hex.encode(transactionHash(p, c.network)), name).toBe(c.hash)
      expect(base64.encode(envelope(p, hex.decode(c.signature))), name).toBe(c.signed)
    }
  })

  it('reads and writes addresses (StrKey)', () => {
    expect(vectors.address).toBe('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX')
    expect(accountAddress(accountKey(vectors.address)!)).toBe(vectors.address)
    expect(STELLAR.valid(vectors.other, 0)).toBe(true)
    expect(STELLAR.valid(vectors.address.slice(0, -1) + 'Y', 0)).toBe(false)
    expect(STELLAR.valid('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3', 0)).toBe(false)
  })

  it('won’t make a memo Stellar won’t take', () => {
    expect(() => envelope(base({ amount: 1n, memo: 'x'.repeat(29) }))).toThrow(/28 bytes/)
  })
})
