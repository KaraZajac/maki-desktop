/**
 * The maki store's records, checked here as maki checks them: the development store the
 * firmware repo carries (libs/maki-store/dev-store), and records made here with keys of our own.
 */
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { storeSource } from '../main/store-source'
import { fromBase64 } from './bridge-types'
import { readBundle } from './bundle'
import {
  checkIndex,
  decodeRevocations,
  decodeRoot,
  FIRST_ROOT,
  memoryKeeper,
  replaces,
  revoked,
  sourcePage,
  Store,
  StoreError,
  trustFirst,
  type Root,
  type StoreSource
} from './store'
import { DEV_STORE, DEV_STORE_THERE, MAKI_STORE, MAKI_STORE_THERE } from './test-support'
/** After the development store was made, and long before anything in it expires. */
const NOW = new Date(1_790_600_000_000)

/** A source that changes what it hands out: `change(path, bytes)` returns what to hand instead. */
function changed(
  source: StoreSource,
  change: (path: string, bytes: Uint8Array | null) => Uint8Array | null
): StoreSource {
  return { get: async (path) => change(path, await source.get(path)) }
}

describe.skipIf(!MAKI_STORE_THERE)('the maki store', () => {
  it('checks out from the root this app carries, with each app’s kind, category and source', async () => {
    const store = new Store(storeSource(MAKI_STORE), memoryKeeper(), () => NOW)
    await store.refresh()
    expect(store.problem).toBeNull()
    const apps = store.index!.apps
    expect(apps.map((a) => [a.name, a.kind, a.category])).toEqual([
      ['Age', 'wasm', 'Security'],
      ['Bitcoin', 'wasm', 'Finance'],
      ['Breakout', 'wasm', 'Games'],
      ['Contacts', 'wasm', 'Social'],
      ['Dice', 'wasm', 'Games'],
      ['Ethereum', 'wasm', 'Finance'],
      ['Magic 8-Ball', 'wasm', 'Games'],
      ['Marble', 'wasm', 'Games'],
      ['Minisign', 'wasm', 'Security'],
      ['Monero', 'wasm', 'Finance'],
      ['Nostr', 'wasm', 'Social'],
      ['Notes', 'wasm', 'Security'],
      ['OpenPGP', 'wasm', 'Security'],
      ['Passphrase', 'wasm', 'Security'],
      ['Pomodoro', 'native', 'Productivity'],
      ['Scanner', 'wasm', 'Tools'],
      ['Sensors', 'wasm', 'Tools'],
      ['Snake', 'wasm', 'Games'],
      ['Solana', 'wasm', 'Finance'],
      ['SSH', 'wasm', 'Security'],
      ['Status', 'wasm', 'Productivity'],
      ['Sudo', 'wasm', 'Security'],
      ['Tally', 'wasm', 'Tools'],
      ['Wi-Fi', 'wasm', 'Tools']
    ])
    // what they may do, from their manifests, as the store's grid shows it
    const status = apps.find((a) => a.name === 'Status')!
    expect((await store.bundle(status)).manifest.permissions.map((p) => p.permission.name)).toEqual(
      ['link']
    )
    const pomodoro = apps.find((a) => a.name === 'Pomodoro')!
    expect(pomodoro.source?.repo).toBe('https://github.com/KaraZajac/maki-firmware')
    expect(pomodoro.source?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(sourcePage(pomodoro.source!)).toBe(
      `https://github.com/KaraZajac/maki-firmware/tree/${pomodoro.source!.commit}/sdk/examples/pomodoro`
    )
    expect(store.revocations?.entries).toEqual([])
    expect((await store.bundle(pomodoro)).manifest.kind).toBe('native')
    // a wallet: its accounts come with it, and what may sign for them (the camera: signing by QR codes)
    const bitcoin = apps.find((a) => a.name === 'Bitcoin')!
    expect(bitcoin.permissions.map((p) => p.permission.name)).toEqual(['link', 'camera', 'wallet'])
    // native SegWit, taproot and multisig (BIP48), on bitcoin and the test networks
    expect((await store.bundle(bitcoin)).manifest.wallet?.paths).toHaveLength(6)
    // Solana's is an Ed25519 wallet (host API 6), which this app reads too
    const solana = (await store.bundle(apps.find((a) => a.name === 'Solana')!)).manifest
    expect([solana.api, solana.wallet?.curve]).toEqual([6, 'ed25519'])
    // Sudo asks after pages on maki's review screen (host API 7)
    const sudo = (await store.bundle(apps.find((a) => a.name === 'Sudo')!)).manifest
    expect([sudo.api, sudo.permissions.map((p) => p.permission.name)]).toEqual([
      7,
      ['ask', 'link', 'keys']
    ])
  })
})

describe.skipIf(!DEV_STORE_THERE)('the development store', () => {
  const source = (): StoreSource => storeSource(DEV_STORE)

  it('is where the firmware starts: this app carries the same first root', () => {
    expect(Buffer.from(fromBase64(FIRST_ROOT)!)).toEqual(
      readFileSync(join(DEV_STORE, 'roots/1.bin'))
    )
  })

  it('checks out: root 2 replaces root 1, and its catalogue key signed the index and the revocation list', async () => {
    const keeper = memoryKeeper()
    const store = new Store(source(), keeper, () => NOW)
    await store.refresh()
    expect(store.problem).toBeNull()
    expect(store.root?.version).toBe(2)
    expect(store.index?.apps.map((a) => a.id)).toEqual([
      'com.leviathan.maki.dice',
      'com.leviathan.maki.sensors',
      'com.leviathan.maki.signer',
      'com.leviathan.maki.ssh'
    ])
    const sensors = store.index!.apps.find((a) => a.name === 'Sensors')!
    expect(sensors.permissions.map((p) => p.permission.name)).toEqual(['camera', 'motion'])
    expect(sensors.icon).toHaveLength(128)
    expect(store.revocations?.version).toBe(1)
    expect(revoked(store.revocations, 'com.leviathan.maki.tally', 1, new Uint8Array(32))).toMatch(
      /revokes Tally/
    )
    // up to the SDK's Tally, version 2
    expect(revoked(store.revocations, 'com.leviathan.maki.tally', 2, new Uint8Array(32))).toMatch(
      /revokes Tally/
    )
    expect(revoked(store.revocations, 'com.leviathan.maki.tally', 3, new Uint8Array(32))).toBeNull()
    // it keeps root 2 and the index's version
    const kept = await keeper.load()
    expect(decodeRoot(kept.root!).root.version).toBe(2)
    expect(kept.indexVersion).toBe(store.index!.version)

    // a bundle, as the index says it is, with its stamp
    const dice = await store.bundle(store.index!.apps[0])
    expect(dice.manifest.name).toBe('Dice')
    expect(dice.stamp).not.toBeNull()
  })

  it('remembers the newest root it took, even when the store stops showing it', async () => {
    const keeper = memoryKeeper()
    await new Store(source(), keeper, () => NOW).refresh()
    const hidden = changed(source(), (path, b) => (path === 'roots/2.bin' ? null : b))
    const store = new Store(hidden, keeper, () => NOW)
    await store.refresh()
    expect(store.root?.version).toBe(2)
  })

  it('turns away a changed index, an older one than it has seen, and a root without its signatures', async () => {
    const flip = (target: string, at: number) =>
      changed(source(), (path, b) => {
        if (path !== target || !b) return b
        const c = b.slice()
        c[at] ^= 1
        return c
      })
    await expect(
      new Store(flip('index.json', 20), memoryKeeper(), () => NOW).refresh()
    ).rejects.toThrow(/isn't signed/)
    await expect(
      new Store(flip('revocations.bin', 20), memoryKeeper(), () => NOW).refresh()
    ).rejects.toThrow(/isn't signed/)
    // root 2's last signature: one of its keys too few
    const root2 = readFileSync(join(DEV_STORE, 'roots/2.bin'))
    const store = new Store(flip('roots/2.bin', root2.length - 1), memoryKeeper(), () => NOW)
    await expect(store.refresh()).rejects.toThrow(/root 2 isn't signed/)
    expect(store.problem).toMatch(/root 2/)

    const seen = memoryKeeper()
    await seen.save({ root: null, indexVersion: 1000 })
    await expect(new Store(source(), seen, () => NOW).refresh()).rejects.toThrow(
      /older than one seen before/
    )
  })

  it("won't use an index past its expiry", async () => {
    const store = new Store(source(), memoryKeeper(), () => NOW)
    await store.refresh()
    const [file, sig] = ['index.json', 'index.sig'].map(
      (f) => new Uint8Array(readFileSync(join(DEV_STORE, f)))
    )
    await expect(checkIndex(store.root!, file, sig, store.index!.expires)).rejects.toThrow(
      /expired/
    )
    // and root 1's catalogue key didn't sign it
    const root1 = await trustFirst(decodeRoot(fromBase64(FIRST_ROOT)!))
    await expect(checkIndex(root1, file, sig, 0)).rejects.toThrow(StoreError)
  })

  it('checks a bundle against the index', async () => {
    const tampered = changed(source(), (path, b) => {
      if (!path.endsWith('.maki') || !b) return b
      const c = b.slice()
      c[c.length - 1] ^= 1
      return c
    })
    const store = new Store(tampered, memoryKeeper(), () => NOW)
    await store.refresh()
    await expect(store.bundle(store.index!.apps[0])).rejects.toThrow(/isn't what its index says/)
  })

  it('has sideloaded bundles without a stamp', () => {
    const plain = readBundle(
      new Uint8Array(readFileSync(join(DEV_STORE, '../../maki-wasm/tests/fixtures/dice.maki')))
    )
    expect(plain.stamp).toBeNull()
  })
})

// Records made here, with keys of our own: the rules, apart from any one store's files.

interface Key {
  public: Uint8Array
  private: KeyObject
}

function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { public: new Uint8Array(raw), private: privateKey }
}

function rootBody(r: Root): Uint8Array {
  const b = Buffer.alloc(8 + 1 + 4 + 1 + 1 + 32 * r.keys.length + 32 + 8)
  b.write('MAKIROOT')
  b[8] = 1
  b.writeUInt32LE(r.version, 9)
  b[13] = r.threshold
  b[14] = r.keys.length
  r.keys.forEach((k, i) => b.set(k, 15 + 32 * i))
  b.set(r.catalogue, 15 + 32 * r.keys.length)
  b.writeBigUInt64LE(BigInt(r.catalogueExpires), 47 + 32 * r.keys.length)
  return b
}

function signRoot(r: Root, by: Key[]): Uint8Array {
  const body = rootBody(r)
  const message = Buffer.concat([
    Buffer.from('maki store root v1\0'),
    createHash('sha256').update(body).digest()
  ])
  const sigs = by.map((k) => Buffer.concat([k.public, edSign(null, message, k.private)]))
  return new Uint8Array(Buffer.concat([body, Buffer.from([sigs.length]), ...sigs]))
}

describe('store roots', () => {
  const [k1, k2, k3, k4, k5, k6, catalogue] = Array.from({ length: 7 }, key)
  const root = (version: number, keys = [k1, k2, k3], threshold = 2): Root => ({
    version,
    threshold,
    keys: keys.map((k) => k.public),
    catalogue: catalogue.public,
    catalogueExpires: 2_000_000_000
  })

  it('need their threshold of their own keys', async () => {
    expect((await trustFirst(decodeRoot(signRoot(root(1), [k1, k3])))).version).toBe(1)
    for (const by of [[k1], [k1, k1], [k1, k4]]) {
      await expect(trustFirst(decodeRoot(signRoot(root(1), by)))).rejects.toThrow(
        /isn't signed by its own keys/
      )
    }
    await expect(
      trustFirst(decodeRoot(signRoot(root(1, [k1, k2, k3], 4), [k1, k2, k3])))
    ).rejects.toThrow(/threshold/)
    await expect(trustFirst(decodeRoot(signRoot(root(1, [k1, k1, k2]), [k1, k2])))).rejects.toThrow(
      /a key twice/
    )
  })

  it('replace another only when its keys and their own both signed, and only going forward', async () => {
    const current = root(1)
    const next = root(2, [k4, k5, k6])
    expect((await replaces(decodeRoot(signRoot(next, [k1, k2, k4, k5])), current)).version).toBe(2)
    await expect(replaces(decodeRoot(signRoot(next, [k4, k5])), current)).rejects.toThrow(
      /isn't signed by root 1's keys/
    )
    await expect(replaces(decodeRoot(signRoot(next, [k1, k2])), current)).rejects.toThrow(
      /its own keys/
    )
    await expect(replaces(decodeRoot(signRoot(root(1), [k1, k2])), current)).rejects.toThrow(
      /older/
    )
  })

  it("aren't anything else", () => {
    expect(() => decodeRoot(new TextEncoder().encode('MAKIROOT'))).toThrow(/cut short/)
    expect(() => decodeRoot(new TextEncoder().encode('MAKIROOT\x02'))).toThrow(/format 2/)
    expect(() => decodeRevocations(new TextEncoder().encode('not a list at all'))).toThrow(
      /not a store/
    )
  })
})
