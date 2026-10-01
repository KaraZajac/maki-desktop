/** Reading .maki bundles (libs/maki-bundle's format) to show them before they go to maki. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BundleError, fingerprint, formatPath, iconPixels, readBundle, walletCoins } from './bundle'
import { APP_FIXTURES, APP_FIXTURES_THERE } from './test-support'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(APP_FIXTURES, `${name}.maki`)))

describe.skipIf(!APP_FIXTURES_THERE)('the SDK’s example bundles', () => {
  it('read as maki reads them', async () => {
    const b = readBundle(fixture('dice'))
    expect(b.manifest).toMatchObject({
      id: 'com.leviathan.maki.dice',
      name: 'Dice',
      version: 2,
      label: '2.0',
      kind: 'wasm',
      api: 8,
      permissions: [],
      storageKib: 1,
      memoryKib: 64,
      backup: true
    })
    expect(b.manifest.description).toMatch(/Dice for tabletop games/)
    expect(b.codeBytes).toBeGreaterThan(1000)
    expect(b.developer).toHaveLength(32)
    // as `maki keygen` and maki itself show it
    expect(await fingerprint(b.developer)).toBe('7e13 f03a 3f27 667b 0a78 8e37')
    expect(b.icon).toHaveLength(128)
    const px = iconPixels(b.icon!)
    expect(px).toHaveLength(64 * 64)
    expect(px.filter(Boolean).length).toBeGreaterThan(200)
  })

  it('reads a wallet app’s accounts, naming their coins as maki does', () => {
    const btc = readBundle(fixture('bitcoin')).manifest
    expect(btc.api).toBe(3)
    expect(btc.permissions.map((p) => p.permission.name)).toEqual(['link', 'camera', 'wallet'])
    // native SegWit, taproot and multisig (BIP48), on bitcoin and the test networks
    expect(btc.wallet!.paths.map(formatPath)).toEqual([
      "m/84'/0'",
      "m/86'/0'",
      "m/48'/0'",
      "m/84'/1'",
      "m/86'/1'",
      "m/48'/1'"
    ])
    expect(walletCoins(btc.wallet!.paths)).toEqual(['Bitcoin', 'test networks'])
    const eth = readBundle(fixture('ethereum')).manifest
    expect(eth.wallet!.paths.map(formatPath)).toEqual(["m/44'/60'"])
    expect(walletCoins(eth.wallet!.paths)).toEqual(['Ethereum'])
    const xmr = readBundle(fixture('monero')).manifest
    expect([xmr.api, xmr.wallet!.paths.map(formatPath), walletCoins(xmr.wallet!.paths)]).toEqual([
      5,
      ["m/44'/128'"],
      ['Monero']
    ])
    // Solana's: Ed25519 keys (host API 6)
    const sol = readBundle(fixture('solana')).manifest
    expect([
      sol.api,
      sol.wallet!.curve,
      sol.wallet!.paths.map(formatPath),
      walletCoins(sol.wallet!.paths)
    ]).toEqual([6, 'ed25519', ["m/44'/501'"], ['Solana']])
    expect(btc.wallet!.curve).toBe('secp256k1')
    // an app without the permission has no paths
    expect(readBundle(fixture('dice')).manifest.wallet).toBeNull()
  })

  it('turns away what isn’t a whole bundle', () => {
    const good = fixture('hello')
    expect(() => readBundle(new TextEncoder().encode('PK\x03\x04 a zip'))).toThrow(BundleError)
    expect(() => readBundle(good.subarray(0, good.length - 1))).toThrow('cut short')
    const longer = new Uint8Array([...good, 0])
    expect(() => readBundle(longer)).toThrow('out of order')
    const newer = good.slice()
    newer[4] = 2
    expect(() => readBundle(newer)).toThrow('bundle format 2')
    expect(() => readBundle(new Uint8Array(512 * 1024 + 1))).toThrow('bigger than maki takes')
  })
})
