import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromHex, quantity, rlpEncode, toHex, uint, unsignedEip1559 } from './rlp'

const FIXTURES = resolve(__dirname, '../../../xous-core/libs/maki-eth/tests/fixtures')

describe('RLP', () => {
  it('encodes as the yellow paper does', () => {
    const e = (i: Parameters<typeof rlpEncode>[0]): string => toHex(rlpEncode(i))
    expect(e(new TextEncoder().encode('dog'))).toBe('0x83646f67')
    expect(e([new TextEncoder().encode('cat'), new TextEncoder().encode('dog')])).toBe(
      '0xc88363617483646f67'
    )
    expect(e(new Uint8Array())).toBe('0x80')
    expect(e([])).toBe('0xc0')
    expect(e(uint(0))).toBe('0x80')
    expect(e(uint(15))).toBe('0x0f')
    expect(e(uint(1024))).toBe('0x820400')
    expect(e([[], [[]], [[], [[]]]])).toBe('0xc7c0c1c0c3c0c1c0')
    const lorem = new TextEncoder().encode(
      'Lorem ipsum dolor sit amet, consectetur adipisicing elit'
    )
    expect(e(lorem).slice(0, 6)).toBe('0xb838') // a 56-byte string: the long form
  })

  it('reads and writes JSON-RPC numbers and bytes', () => {
    expect(quantity('0x1a')).toBe(26n)
    expect(quantity(26)).toBe(26n)
    expect(() => quantity('26')).toThrow()
    expect(toHex(fromHex('0xdeadBEEF'))).toBe('0xdeadbeef')
    expect(() => fromHex('0xabc')).toThrow()
  })

  it.skipIf(!existsSync(resolve(FIXTURES, 'abandon-tx-unsigned.bin')))(
    'builds the transaction maki’s fixture holds, byte for byte',
    () => {
      // the firmware's fixture: 0.05 ETH to 0x7099…79C8 on Ethereum, built by alloy
      const tx = unsignedEip1559({
        chainId: 1n,
        nonce: 42n,
        maxPriorityFeePerGas: 1_500_000_000n,
        maxFeePerGas: 30_000_000_000n,
        gasLimit: 65_000n,
        to: fromHex('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
        value: 50_000_000_000_000_000n,
        data: new Uint8Array(),
        accessList: []
      })
      expect(tx).toEqual(new Uint8Array(readFileSync(resolve(FIXTURES, 'abandon-tx-unsigned.bin'))))
    }
  )
})
