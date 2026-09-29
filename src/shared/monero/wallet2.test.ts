/**
 * wallet2's cold-signing files, as Monero v0.18.5.1's binaries wrote them on a private regtest
 * chain (fixtures/cold: four transfers, a standard address, one with a subaddress too, an
 * integrated address and a subaddress alone; an outputs file, binary and ASCII-armoured; a key
 * image file): each opens with the wallet's view key, reads whole, and writes back byte for byte.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { parseTransaction, transactionId } from './transaction'
import {
  fileKey,
  fileKind,
  openFile,
  parseKeyImages,
  parseOutputs,
  parseSigned,
  parseUnsigned,
  sealFile,
  writeKeyImages,
  writeOutputsFile,
  writeSigned,
  writeUnsigned
} from './wallet2'
import { decodeAddress, leNumber } from './xmr'

const dir = join(__dirname, 'fixtures', 'cold')
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)))
const wallet = JSON.parse(readFileSync(join(dir, 'wallet.json'), 'utf8')) as {
  address: string
  view: string
}
const view = leNumber(hex.decode(wallet.view))
const address = decodeAddress(wallet.address)!
const key = fileKey(view)

describe('wallet2’s files', () => {
  it('makes the files’ key from the view key, as wallet2 does', () => {
    expect(hex.encode(key)).toBe('4d48b550504cae52fa74a63d61d01a5b6b4765519a20b41b2bf749dad61131ad')
  })

  it('reads unsigned transaction sets, and writes them back the same', () => {
    for (let i = 1; i <= 5; i++) {
      const f = file(`unsigned${i}.bin`)
      expect(fileKind(f)).toBe('unsigned')
      const body = openFile('unsigned', f, view, key)
      const set = parseUnsigned(body)
      expect(set.txes.length).toBeGreaterThan(0)
      for (const tx of set.txes) {
        expect(tx.sources.every((s) => s.outputs.length === 16)).toBe(true)
        // every ring in the chain's order
        for (const s of tx.sources)
          expect(s.outputs.every((o, j) => j === 0 || o.index > s.outputs[j - 1].index)).toBe(true)
      }
      expect(writeUnsigned(set)).toEqual(body)
    }
  })

  it('reads signed transaction sets, their transactions whole, and writes them back the same', () => {
    for (let i = 1; i <= 5; i++) {
      const body = openFile('signed', file(`signed${i}.bin`), view, key)
      const set = parseSigned(body)
      for (const p of set.ptx) {
        const tx = parseTransaction(p.tx.bytes)
        expect(tx.rctType).toBe(6)
        expect(tx.fee).toBe(p.fee)
        expect(transactionId(tx).length).toBe(32)
        // wallet2 withholds the transaction's key: the identity scalar
        expect(hex.encode(p.txKey)).toBe('01' + '00'.repeat(31))
      }
      expect(writeSigned(set)).toEqual(body)
    }
  })

  it('reads the outputs a view-only wallet exports, armoured or not', () => {
    for (const name of ['outputs_file.bin', 'outputs_ascii.txt']) {
      const f = file(name)
      expect(fileKind(f)).toBe('outputs')
      const body = openFile('outputs', f, view, key)
      const o = parseOutputs(body, address.spend, address.view)
      expect(o.outputs.length).toBeGreaterThan(0)
      expect(writeOutputsFile(o, address.spend, address.view)).toEqual(body)
      expect(() => parseOutputs(body, address.view, address.spend)).toThrow('another wallet')
    }
  })

  it('reads key image files', () => {
    const body = openFile('keyImages', file('keyimages_full.bin'), view, key)
    const k = parseKeyImages(body)
    expect(k.images.length).toBeGreaterThan(100)
    expect(k.spend).toEqual(address.spend)
    expect(writeKeyImages(k.offset, k.spend, k.view, k.images)).toEqual(body)
  })

  it('seals files wallet2 opens: encrypted, and signed by the view key', () => {
    const plain = new TextEncoder().encode('what a view-only wallet reads')
    const sealed = sealFile('signed', plain, view, key)
    expect(new TextDecoder().decode(sealed.subarray(0, 21))).toBe('Monero signed tx set\x05')
    expect(openFile('signed', sealed, view, key)).toEqual(plain)
    // another wallet's key, or a changed byte: refused
    expect(() => openFile('signed', sealed, view + 1n, key)).toThrow('another wallet')
    const changed = sealed.slice()
    changed[30] ^= 1
    expect(() => openFile('signed', changed, view, key)).toThrow('another wallet')
    expect(() => openFile('unsigned', sealed, view, key)).toThrow(
      'not a Monero unsigned transaction file'
    )
  })
})
