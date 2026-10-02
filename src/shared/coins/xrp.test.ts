/**
 * maki desktop's XRP payments against xrpl.js (`fixtures/make-xrp.mjs`): each payment's bytes for
 * signing and, with xrpl.js's signature put in, the signed transaction and its ID, byte for byte;
 * and the classic address the test phrase's account has.
 */
import { hex } from '@scure/base'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountId,
  classicAddress,
  encodePayment,
  transactionId,
  XRP,
  type XrpPayment
} from './xrp'

interface Case {
  tx: Record<string, unknown>
  unsigned: string
  signed: string
  hash: string
  signature: string
}
const vectors = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/xrp-payments.json'), 'utf8')
) as { address: string; publicKey: string; cases: Record<string, Case> }

function paymentOf(tx: Record<string, unknown>): XrpPayment {
  const amount = tx.Amount as string | { currency: string; issuer: string; value: string }
  return {
    account: tx.Account as string,
    destination: tx.Destination as string,
    amount: typeof amount === 'string' ? BigInt(amount) : amount,
    fee: BigInt(tx.Fee as string),
    sequence: tx.Sequence as number,
    lastLedgerSequence: tx.LastLedgerSequence as number,
    signingPubKey: hex.decode((tx.SigningPubKey as string).toLowerCase()),
    destinationTag: tx.DestinationTag as number | undefined,
    networkId: tx.NetworkID as number | undefined
  }
}

describe('XRP payments', () => {
  it('are the bytes xrpl.js makes, for signing and signed', () => {
    for (const [name, c] of Object.entries(vectors.cases)) {
      const p = paymentOf(c.tx)
      // xrpl.js's bytes for signing start with the prefix "STX\0", which maki's app adds itself
      expect(hex.encode(encodePayment(p)).toUpperCase(), name).toBe(
        c.unsigned.slice(8).toUpperCase()
      )
      const signed = encodePayment(p, hex.decode(c.signature.toLowerCase()))
      expect(hex.encode(signed).toUpperCase(), name).toBe(c.signed.toUpperCase())
      expect(transactionId(signed), name).toBe(c.hash)
    }
  })

  it('reads and writes classic addresses', () => {
    const id = accountId(vectors.address)!
    expect(classicAddress(id)).toBe('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3')
    expect(XRP.valid('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3', 0)).toBe(true)
    // a changed letter, and not an address at all
    expect(XRP.valid('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v4', 0)).toBe(false)
    expect(XRP.valid('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 0)).toBe(false)
  })

  it('won’t encode an amount the ledger can’t hold exactly', () => {
    const p = paymentOf(vectors.cases.token.tx)
    expect(() =>
      encodePayment({
        ...p,
        amount: { ...(p.amount as object), value: '1.23456789012345678' } as never
      })
    ).toThrow(/16 digits/)
  })
})
