/** Where the maki store's files come from: nothing outside the store, and only https off this computer. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { STORE, storeName, storeSource, storeToken, storeWhere } from './store-source'

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

  it('is the maki store, or MAKI_STORE', () => {
    expect(storeWhere({})).toBe(STORE)
    expect(storeWhere({ MAKI_STORE: ' https://store.example ' })).toBe('https://store.example')
    expect(storeToken({})).toBeNull()
    expect(storeToken({ MAKI_STORE_TOKEN: ' t0ken ' })).toBe('t0ken')
  })

  it('goes by its repository, host or folder', () => {
    expect(storeName(STORE)).toBe('KaraZajac/maki-apps')
    expect(storeName('https://maki.example/store/')).toBe('maki.example')
    expect(storeName('/home/me/maki-apps/store')).toBe('/home/me/maki-apps/store')
  })

  it('sends its token to GitHub\'s file server only', async () => {
    const seen: { url: string; auth: string | null }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') })
      return new Response(new Uint8Array([7]))
    }) as typeof fetch
    try {
      await storeSource(STORE, 'secret').get('index.json')
      await storeSource('https://store.example/', 'secret').get('index.json')
      await storeSource('http://localhost:8080/', 'secret').get('index.json')
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual([
      { url: `${STORE}index.json`, auth: 'token secret' },
      { url: 'https://store.example/index.json', auth: null },
      { url: 'http://localhost:8080/index.json', auth: null }
    ])
  })
})
