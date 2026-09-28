/** maki desktop's tokens are the ones maki knows, and amounts read and write back exactly. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUnits, TOKENS, units } from './tokens'

const FIRMWARE = resolve(__dirname, '../../../xous-core/libs/maki-eth/src/tokens.rs')

describe('tokens', () => {
  it.skipIf(!existsSync(FIRMWARE))('are the ones maki knows, entry for entry', () => {
    const rust = [
      ...readFileSync(FIRMWARE, 'utf8').matchAll(
        /token\((\d+), "(0x[0-9a-fA-F]{40})", "([^"]+)", (\d+)\)/g
      )
    ]
    expect(
      rust.map(([, chain, contract, symbol, decimals]) => [
        chain,
        contract,
        symbol,
        Number(decimals)
      ])
    ).toEqual(TOKENS.map((t) => [t.chainId.toString(), t.contract, t.symbol, t.decimals]))
  })

  it('read and write amounts exactly', () => {
    expect(units(1_500_000n, 6)).toBe('1.5')
    expect(units(1n, 6)).toBe('0.000001')
    expect(units(0n, 18)).toBe('0')
    expect(units(-25_000_000n, 6)).toBe('-25')
    expect(units(123n, 0)).toBe('123')
    expect(parseUnits('1.5', 6)).toBe(1_500_000n)
    expect(parseUnits('.25', 6)).toBe(250_000n)
    expect(parseUnits('3', 18)).toBe(3n * 10n ** 18n)
    for (const bad of ['', '.', '1.0000001', '-1', '1e3', 'abc', '1,5'])
      expect(parseUnits(bad, 6)).toBeNull()
  })
})
