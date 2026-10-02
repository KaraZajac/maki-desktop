import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS_OF } from '../shared/btc-wallet'
import { ANOTHER_WALLET } from '../shared/wallets'
import { loadDescriptors, saveDescriptors, WalletFiles } from './wallet-files'

let dir: string
let files: WalletFiles
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maki-wallets-'))
  files = new WalletFiles(() => dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in for an account's descriptor: what's tested is where it goes, not what it says. */
const descriptor = (chain: string, n = 0): string =>
  `pkh([73c5da0a/44h/0h/${n}h]xpub-of-${chain}/<0;1>/*)`

describe('the wallet in use', () => {
  it('is the phrase’s own until the window says otherwise, and its files are those it always had', () => {
    expect(files.inUse).toBe(null)
    expect(files.path('accounts')).toBe(join(dir, 'accounts.json'))
    files.use('ae958f6d')
    expect(files.inUse).toBe('ae958f6d')
    expect(files.path('accounts')).toBe(join(dir, 'accounts.wallet-ae958f6d.json'))
    expect(files.path('monero')).toBe(join(dir, 'monero.wallet-ae958f6d.json'))
    files.use(null)
    expect(files.path('ethereum')).toBe(join(dir, 'ethereum.json'))
  })

  it('takes only a wallet it can name a file for', () => {
    files.use('ae958f6d')
    for (const w of ['../../.ssh/x', 'AE958F6D', '', undefined, 7])
      expect(() => files.use(w)).toThrow('which wallet?')
    expect(files.inUse).toBe('ae958f6d')
  })

  it('turns down what’s kept for any wallet but the one in use', () => {
    expect(files.refuses(null)).toBe(null)
    expect(files.refuses('ae958f6d')).toBe(ANOTHER_WALLET)
    files.use('ae958f6d')
    expect(files.refuses('ae958f6d')).toBe(null)
    expect(files.refuses(null)).toBe(ANOTHER_WALLET)
    // nothing named, or a name that isn't a wallet's, isn't the wallet in use either
    for (const w of [undefined, 'AE958F6D', '../x']) expect(files.refuses(w)).toBe(ANOTHER_WALLET)
  })
})

describe('the Bitcoin family’s descriptors', () => {
  it('keeps each chain’s in a file of its own: saving one chain’s leaves the others’', async () => {
    const chains = Object.keys(NETWORKS_OF)
    expect(chains).toEqual(
      expect.arrayContaining(['bitcoin', 'litecoin', 'dogecoin', 'bitcoincash'])
    )
    for (const c of chains)
      expect(await saveDescriptors(files, c, [descriptor(c)], null)).toBe(null)
    // Dogecoin's and Bitcoin Cash's went to bitcoin.json before, over the Bitcoin card's
    expect(await saveDescriptors(files, 'dogecoin', [descriptor('dogecoin', 1)], null)).toBe(null)
    expect(await saveDescriptors(files, 'bitcoincash', [], null)).toBe(null)
    for (const c of chains)
      expect(await loadDescriptors(files, c)).toEqual(
        c === 'dogecoin' ? [descriptor(c, 1)] : c === 'bitcoincash' ? [] : [descriptor(c)]
      )
    expect(readdirSync(dir).sort()).toEqual(chains.map((c) => `${c}.json`).sort())
  })

  it('refuses a chain it doesn’t know, and writes nothing for it', async () => {
    await expect(saveDescriptors(files, 'ethereum', [descriptor('x')], null)).rejects.toThrow(
      'which chain?'
    )
    await expect(saveDescriptors(files, undefined, [descriptor('x')], null)).rejects.toThrow(
      'which chain?'
    )
    await expect(loadDescriptors(files, '__proto__')).rejects.toThrow('which chain?')
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps only what descriptors could be, at most eight', async () => {
    const many = Array.from({ length: 10 }, (_, i) => descriptor('bitcoin', i))
    await saveDescriptors(files, 'bitcoin', [42, 'x'.repeat(300), ...many], null)
    expect(await loadDescriptors(files, 'bitcoin')).toEqual(many.slice(0, 8))
  })

  it('keeps a passphrase wallet’s apart from the phrase’s own, and reads the wallet in use’s', async () => {
    await saveDescriptors(files, 'bitcoin', [descriptor('bitcoin')], null)
    files.use('ae958f6d')
    expect(await loadDescriptors(files, 'bitcoin')).toEqual([])
    await saveDescriptors(files, 'bitcoin', [descriptor('bitcoin', 7)], 'ae958f6d')
    expect(await loadDescriptors(files, 'bitcoin')).toEqual([descriptor('bitcoin', 7)])
    files.use(null)
    expect(await loadDescriptors(files, 'bitcoin')).toEqual([descriptor('bitcoin')])
    expect(readdirSync(dir).sort()).toEqual(['bitcoin.json', 'bitcoin.wallet-ae958f6d.json'])
  })

  it('turns down what’s kept for a wallet that isn’t the one in use, and writes nothing', async () => {
    files.use('ae958f6d')
    expect(await saveDescriptors(files, 'bitcoin', [descriptor('bitcoin')], null)).toBe(
      ANOTHER_WALLET
    )
    expect(await saveDescriptors(files, 'bitcoin', [descriptor('bitcoin')], undefined)).toBe(
      ANOTHER_WALLET
    )
    expect(readdirSync(dir)).toEqual([])
  })

  it('puts a save under way as the wallet switches in the wallet it was for', async () => {
    // maki opens a passphrase wallet just as a save of the phrase's own is written
    const saving = saveDescriptors(files, 'bitcoin', [descriptor('bitcoin')], null)
    files.use('ae958f6d')
    expect(await saving).toBe(null)
    expect(JSON.parse(readFileSync(join(dir, 'bitcoin.json'), 'utf8'))).toEqual({
      descriptors: [descriptor('bitcoin')]
    })
    expect(existsSync(join(dir, 'bitcoin.wallet-ae958f6d.json'))).toBe(false)
  })
})
