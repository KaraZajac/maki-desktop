import * as btc from '@scure/btc-signer'
import { describe, expect, it } from 'vitest'
import { decodeCashAddr, encodeCashAddr } from './cashaddr'

describe('CashAddr', () => {
  // the spec's own examples (Bitcoin Cash's cashaddr.md, "Examples of address translation")
  const SPEC: [string, string][] = [
    [
      '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu',
      'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
    ],
    [
      '1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR',
      'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'
    ],
    [
      '3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC',
      'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'
    ],
    ['3LDsS579y7sruadqu11beEJoTjdFiFCdX4', 'bitcoincash:pr95sy3j9xwd2ap32xkykttr4cvcu7as4yc93ky28e']
  ]

  it('writes and reads the spec’s examples', () => {
    for (const [legacy, cash] of SPEC) {
      const decoded = btc.Address(btc.NETWORK).decode(legacy) as {
        type: 'pkh' | 'sh'
        hash: Uint8Array
      }
      const kind = decoded.type === 'pkh' ? 'p2pkh' : 'p2sh'
      expect(encodeCashAddr('bitcoincash', kind, decoded.hash)).toBe(cash)
      expect(decodeCashAddr(cash, 'bitcoincash')).toEqual({ kind, hash: decoded.hash })
      // without its prefix, and in capitals: the same address
      expect(decodeCashAddr(cash.slice('bitcoincash:'.length), 'bitcoincash')?.hash).toEqual(
        decoded.hash
      )
      expect(decodeCashAddr(cash.toUpperCase(), 'bitcoincash')?.hash).toEqual(decoded.hash)
    }
  })

  it('refuses what isn’t one: a changed letter, mixed case, the other network, another size', () => {
    const [, cash] = SPEC[0]
    expect(decodeCashAddr(cash.replace('qpm2', 'qpm3'), 'bitcoincash')).toBeNull()
    expect(
      decodeCashAddr(cash.slice(0, 20) + cash.slice(20).toUpperCase(), 'bitcoincash')
    ).toBeNull()
    expect(decodeCashAddr(cash, 'bchtest')).toBeNull()
    expect(
      decodeCashAddr('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwv', 'bitcoincash')
    ).toBeNull()
    expect(decodeCashAddr('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bitcoincash')).toBeNull()
  })

  it('is the test phrase’s first address as libauth makes it', () => {
    // hash160 of m/44'/145'/0'/0/0's key: maki-btc's fixture, by libauth
    const cash = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6'
    const { hash } = decodeCashAddr(cash, 'bitcoincash')!
    expect(encodeCashAddr('bitcoincash', 'p2pkh', hash)).toBe(cash)
  })
})
