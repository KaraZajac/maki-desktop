/** Where the maki store's files come from: nothing outside the store, and only https off this computer. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { storeSource, storeWhere } from './store-source'

describe('the store source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maki-store-'))
  mkdirSync(join(dir, 'roots'))
  writeFileSync(join(dir, 'roots', '1.bin'), Buffer.from([1, 2, 3]))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads files in a store folder, and nothing else', async () => {
    const source = storeSource(dir)
    expect(Array.from((await source.get('roots/1.bin'))!)).toEqual([1, 2, 3])
    expect(await source.get('roots/2.bin')).toBeNull()
    for (const path of ['../maki-outside.txt', 'roots/../../maki-outside.txt', '/etc/passwd', 'roots//1.bin', '.hidden', 'a\\b']) {
      await expect(source.get(path)).rejects.toThrow('not a store path')
    }
  })

  it('takes https, or http on this computer only', () => {
    expect(() => storeSource('https://store.example')).not.toThrow()
    expect(() => storeSource('http://localhost:8080/store')).not.toThrow()
    expect(() => storeSource('http://store.example')).toThrow(/https/)
    expect(() => storeSource('ftp://store.example')).toThrow(/https/)
  })

  it('is set by MAKI_STORE, and nowhere otherwise', () => {
    expect(storeWhere({})).toBeNull()
    expect(storeWhere({ MAKI_STORE: ' https://store.example ' })).toBe('https://store.example')
  })
})
