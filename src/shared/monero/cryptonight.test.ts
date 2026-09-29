/**
 * CryptoNight and the hashes that finish it, held to Monero's own test vectors (tests/hash in
 * the monero repository: a subset, BSD-licensed, fixtures/monero-LICENSE), and to the key wallet2
 * makes from the BIP39 test phrase's view key, as Monero's slow-hash.c computed it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { cnSlowHash, groestl256, jh256, skein512_256 } from './cryptonight'
import { blake256 } from '@noble/hashes/blake1.js'

const vectors = (name: string): [string, Uint8Array][] =>
  readFileSync(join(__dirname, 'fixtures', `cn-${name}.txt`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, input] = line.split(' ')
      return [hash, input === 'x' ? new Uint8Array() : hex.decode(input)]
    })

describe('CryptoNight', () => {
  for (const [name, f] of [
    ['blake', (d: Uint8Array) => blake256(d)],
    ['groestl', groestl256],
    ['jh', jh256],
    ['skein', skein512_256]
  ] as const) {
    it(`finishes with ${name}, as Monero's does`, () => {
      const all = vectors(name)
      expect(all.length).toBeGreaterThan(50)
      for (const [hash, input] of all)
        expect(hex.encode(f(input)), `${input.length} bytes`).toBe(hash)
    })
  }

  it('is Monero’s slow hash, variant 0', () => {
    for (const [hash, input] of vectors('slow')) expect(hex.encode(cnSlowHash(input))).toBe(hash)
  })

  it('makes the key wallet2 encrypts the test phrase’s files with', () => {
    const view = hex.decode('0f3fe25d0c6d4c94dde0c0bcc214b233e9c72927f813728b0f01f28f9d5e1201')
    expect(hex.encode(cnSlowHash(view))).toBe(
      '6082c2d3ec4bf17e793002d5d21a38187515619d427648c6c7efa874711298c7'
    )
  })
})
