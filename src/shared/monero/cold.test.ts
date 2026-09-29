/**
 * maki as a view-only wallet's cold wallet: the unsigned sets Monero v0.18.5.1's view-only wallet
 * made on a regtest chain (fixtures/cold) become requests to maki with the same inputs, payments
 * and fee as its own cold wallet signed. (regtest.test.ts has the rest, against a live chain.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { prepare, type ViewWallet } from './cold'
import { encodeRequest } from './request'
import { fileKey, openFile, parseSigned, parseUnsigned } from './wallet2'
import { decodeAddress, leNumber, mulBase } from './xmr'

const dir = join(__dirname, 'fixtures', 'cold')
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)))
const fixture = JSON.parse(readFileSync(join(dir, 'wallet.json'), 'utf8')) as {
  address: string
  view: string
}

describe('maki as the cold wallet of a view-only wallet', () => {
  const address = decodeAddress(fixture.address)!
  const w: ViewWallet = {
    network: 'mainnet',
    spend: address.spend,
    view: leNumber(hex.decode(fixture.view))
  }
  const key = fileKey(w.view)

  it('asks maki for what wallet2’s own cold wallet signed', () => {
    for (let i = 1; i <= 5; i++) {
      const set = parseUnsigned(openFile('unsigned', file(`unsigned${i}.bin`), w.view, key))
      const signed = parseSigned(openFile('signed', file(`signed${i}.bin`), w.view, key))
      set.txes.forEach((c, t) => {
        const p = prepare(c, w)
        const theirs = signed.ptx[t]
        // the same fee, the same payments, the same inputs (by their key images, which the
        // regtest's own cold wallet made)
        expect(p.request.fee).toBe(theirs.fee)
        expect(p.request.payments.map((x) => x.amount).sort()).toEqual(
          theirs.dests.map((d) => d.amount).sort()
        )
        for (const pay of p.request.payments)
          expect(decodeAddress(pay.address)?.network).toBe('mainnet')
        expect(p.request.inputs.length).toBe(theirs.tx.inputs.length)
        expect(encodeRequest(p.request).length).toBeGreaterThan(1000)
        // change back to the wallet, or wallet2's output of nothing when there's none
        expect(
          p.request.change + p.request.fee + p.request.payments.reduce((t, x) => t + x.amount, 0n)
        ).toBe(p.request.inputs.reduce((t, x) => t + x.amount, 0n))
      })
    }
  })

  it('refuses a transaction that isn’t this wallet’s', () => {
    const set = parseUnsigned(openFile('unsigned', file('unsigned1.bin'), w.view, key))
    const other: ViewWallet = { ...w, spend: mulBase(7n).toBytes() }
    expect(() => prepare(set.txes[0], other)).toThrow('isn’t this wallet’s')
  })
})
