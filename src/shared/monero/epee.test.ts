/**
 * epee, as monerod reads and writes it. (regtest.test.ts has maki desktop's own wallet against a
 * live chain.)
 */
import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { decodeEpee, encodeEpee } from './epee'

describe('epee', () => {
  it('reads what it writes, as monerod lays it out', () => {
    const bytes = encodeEpee({
      get_txid: { bool: false },
      outputs: { objects: [{ amount: { u64: 0 }, index: { u64: 5 } }] }
    })
    // the spec's worked example: the header, two fields, get_txid false, one output (0, 5)
    expect(hex.encode(bytes)).toBe(
      '011101010101020101' +
        '08' +
        '086765745f74786964' +
        '0b00' +
        '076f757470757473' +
        '8c04' +
        '08' +
        '06616d6f756e74' +
        '050000000000000000' +
        '05696e646578' +
        '050500000000000000'
    )
    expect(decodeEpee(bytes)).toEqual({ get_txid: false, outputs: [{ amount: 0n, index: 5n }] })
  })
})
