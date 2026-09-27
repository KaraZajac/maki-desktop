/**
 * The maki store from this side (ARCHITECTURE.md in the BAOKEY repo, "The store"): its files,
 * fetched from wherever it's published, checked the way maki checks them (libs/maki-store in the
 * firmware repo; keep the two in step), so this window shows only what the store signed; and
 * the store's newest root and revocation list, handed to maki. maki checks all of it again
 * itself, each bundle's stamp included: this side is as untrusted as the rest of the computer,
 * and its checks are for the owner's sake.
 *
 * A store publishes roots/1.bin, roots/2.bin, ... (each root signed to replace the one before),
 * revocations.bin, index.json with index.sig (the catalogue key's signature over the file) and
 * the stamped bundles the index names.
 *
 * No Node or DOM imports here: WebCrypto only, so it runs in the renderer and in tests alike.
 */

import { APP_ID, fromBase64 } from './bridge-types'
import { MAX_BUNDLE, Permissions, readBundle, type Bundle, type Permission } from './bundle'
import type { MakiClient, StoreUpdate } from './client'
import { Reader, Truncated } from './protocol'

export class StoreError extends Error {}

/**
 * The root maki's firmware carries, and this side starts from: the development store's
 * (libs/maki-store/dev-store in the firmware repo) until the real store opens.
 */
export const FIRST_ROOT =
  'TUFLSVJPT1QBAQAAAAIDMPSHsxqplIH0EqB6h8R32T0sNVN4K8fvmVqmdGzjv7Y5D8jHjuKU0RzL2VofzHkcjJoBXUi2E5BIhy4AXdSpt1dTRatqS2A4XN2qry/0fxZig9n88iqhzuxTNsm6WvPOpoQ36UhVgiC07oJIHLfsYxTRmK2YRT6FVDQn+kxDFXMuYYV9AAAAAAIw9IezGqmUgfQSoHqHxHfZPSw1U3grx++ZWqZ0bOO/thvpEYKoBoaczYt9PrmZFPVK4qmnGmtxYSU8AdLoOpnb0grhUe6Z6TguTIOqU0x0JtpMFht52imavsA4j0ErjQA5D8jHjuKU0RzL2VofzHkcjJoBXUi2E5BIhy4AXdSpt3b9cGgDMbC0qWii76DvEkGPotO70UR/dLE6YRRmHL+xpaRDzSKEPseYokHjjidoHHvShnhbNGnaZcpN7kx8nww='

export const MAX_ROOT_KEYS = 8
export const MAX_REVOKED = 4096
/** How long a check of the store is good for, while maki desktop runs. */
export const RECHECK_MS = 60 * 60 * 1000

const utf8 = new TextEncoder()
const ROOT_MAGIC = utf8.encode('MAKIROOT')
const REVOKED_MAGIC = utf8.encode('MAKIREVO')
const FORMAT = 1
const ROOT_DOMAIN = utf8.encode('maki store root v1\0')
const REVOKED_DOMAIN = utf8.encode('maki store revocations v1\0')
const INDEX_DOMAIN = utf8.encode('maki store index v1\0')

export const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

export const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

function unhex(s: unknown, bytes: number): Uint8Array | null {
  if (typeof s !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s)) return null
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
}

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))
}

/** An Ed25519 signature by `key` over `domain` and the SHA-256 of `body`, as the store signs. */
async function verify(key: Uint8Array, domain: Uint8Array, body: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const message = new Uint8Array([...domain, ...(await sha256(body))])
  try {
    const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, k, new Uint8Array(signature), message)
  } catch {
    return false
  }
}

function read<T>(what: string, bytes: Uint8Array, magic: Uint8Array, f: (r: Reader) => T): T {
  const r = new Reader(bytes)
  try {
    if (!equal(r.fixed(8), magic)) throw new StoreError(`not a store ${what}`)
    const format = r.u8()
    if (format !== FORMAT) throw new StoreError(`store ${what} format ${format}, newer than this app reads`)
    const out = f(r)
    r.end()
    return out
  } catch (e) {
    if (e instanceof Truncated) throw new StoreError(`the store's ${what} is cut short, or has bytes after it`)
    if (e instanceof TypeError) throw new StoreError(`the store's ${what} has text that isn't UTF-8`)
    throw e
  }
}

// ------------------------------------------------------------------------------------------
// Roots

/** Who the store is: the root keys, how many of them sign a root, and the catalogue key. */
export interface Root {
  version: number
  threshold: number
  keys: Uint8Array[]
  /** signs stamps, revocation lists and the index */
  catalogue: Uint8Array
  /** unix seconds: after this, nothing new the catalogue key signed counts */
  catalogueExpires: number
}

export interface SignedRoot {
  root: Root
  /** what the signatures are over */
  body: Uint8Array
  signatures: { key: Uint8Array; signature: Uint8Array }[]
  /** as published, to hand maki */
  bytes: Uint8Array
}

export function decodeRoot(bytes: Uint8Array): SignedRoot {
  return read('root', bytes, ROOT_MAGIC, (r) => {
    const version = r.u32()
    const threshold = r.u8()
    const n = r.u8()
    if (n > MAX_ROOT_KEYS) throw new StoreError('the store root names too many keys')
    const keys = Array.from({ length: n }, () => r.fixed(32))
    const catalogue = r.fixed(32)
    const catalogueExpires = r.u64()
    const body = bytes.slice(0, r.offset)
    const count = r.u8()
    if (count > 2 * MAX_ROOT_KEYS) throw new StoreError('the store root has too many signatures')
    const signatures = Array.from({ length: count }, () => ({ key: r.fixed(32), signature: r.fixed(64) }))
    return { root: { version, threshold, keys, catalogue, catalogueExpires }, body, signatures, bytes }
  })
}

/** How many of `root`'s keys signed `signed`, each counted once. */
async function signers(root: Root, signed: SignedRoot): Promise<number> {
  let count = 0
  for (const key of root.keys) {
    for (const s of signed.signatures) {
      if (equal(s.key, key) && (await verify(key, ROOT_DOMAIN, signed.body, s.signature))) {
        count++
        break
      }
    }
  }
  return count
}

/** The first root: one whose threshold can be met, with no key twice, signed by `threshold` of its own keys. */
export async function trustFirst(signed: SignedRoot): Promise<Root> {
  const { root } = signed
  const distinct = root.keys.every((k, i) => !root.keys.slice(0, i).some((o) => equal(o, k)))
  if (root.threshold < 1 || root.threshold > root.keys.length || !distinct) {
    throw new StoreError(`store root ${root.version} can't be trusted: a threshold nobody can meet, or a key twice`)
  }
  if ((await signers(root, signed)) < root.threshold) throw new StoreError(`store root ${root.version} isn't signed by its own keys`)
  return root
}

/** A root that replaces `current`: newer, and signed by `threshold` of `current`'s keys and of its own. */
export async function replaces(signed: SignedRoot, current: Root): Promise<Root> {
  const v = signed.root.version
  if (v <= current.version) throw new StoreError(`store root ${v} is older than root ${current.version}`)
  await trustFirst(signed)
  if ((await signers(current, signed)) < current.threshold) {
    throw new StoreError(`store root ${v} isn't signed by root ${current.version}'s keys`)
  }
  return signed.root
}

// ------------------------------------------------------------------------------------------
// Revocations

export type Revoked =
  | { kind: 'app'; id: string }
  /** this version of the app and every one before */
  | { kind: 'up to'; id: string; version: number }
  /** everything this developer key signed */
  | { kind: 'developer'; key: Uint8Array }

export interface Revocations {
  version: number
  /** unix seconds: after this the list is stale */
  expires: number
  entries: { what: Revoked; why: string }[]
  body: Uint8Array
  signature: Uint8Array
  /** as published, to hand maki */
  bytes: Uint8Array
}

export function decodeRevocations(bytes: Uint8Array): Revocations {
  return read('revocation list', bytes, REVOKED_MAGIC, (r) => {
    const version = r.u32()
    const expires = r.u64()
    const n = r.u16()
    if (n > MAX_REVOKED) throw new StoreError('the store revocation list is too long')
    const entries: Revocations['entries'] = []
    for (let i = 0; i < n; i++) {
      const tag = r.u8()
      const what: Revoked =
        tag === 1
          ? { kind: 'app', id: r.str8() }
          : tag === 2
            ? { kind: 'up to', id: r.str8(), version: r.u32() }
            : tag === 3
              ? { kind: 'developer', key: r.fixed(32) }
              : (() => {
                  throw new StoreError("the store's revocation list has an entry this app doesn't know")
                })()
      entries.push({ what, why: r.str8() })
    }
    const body = bytes.slice(0, r.offset)
    return { version, expires, entries, body, signature: r.fixed(64), bytes }
  })
}

/** Whether `root`'s catalogue key signed the list. */
export function revocationsSigned(list: Revocations, root: Root): Promise<boolean> {
  return verify(root.catalogue, REVOKED_DOMAIN, list.body, list.signature)
}

/** Why the store revoked this app, or null. */
export function revoked(list: Revocations | null, id: string, version: number, developer: Uint8Array): string | null {
  const hit = list?.entries.find(({ what }) =>
    what.kind === 'app' ? what.id === id : what.kind === 'up to' ? what.id === id && version <= what.version : equal(what.key, developer)
  )
  return hit?.why ?? null
}

// ------------------------------------------------------------------------------------------
// The index

/** An app in the store, as its index describes it. */
export interface StoreApp {
  id: string
  name: string
  version: number
  label: string
  description: string
  developer: Uint8Array
  permissions: { permission: Permission; reason: string }[]
  storageKib: number
  memoryKib: number
  backup: boolean
  /** the stamped bundle: its size, its SHA-256, and where it is in the store */
  bytes: number
  sha256: Uint8Array
  path: string
  /** 64x64 in maki_icons form, or null */
  icon: Uint32Array | null
}

export interface Index {
  /** only goes up */
  version: number
  /** unix seconds */
  expires: number
  apps: StoreApp[]
  /** apps this app can't show: a permission it doesn't know, say */
  skipped: number
}

/** A path inside the store: no way out of it. */
export const STORE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

function storeApp(e: Record<string, unknown>): StoreApp | null {
  const str = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null)
  const num = (k: string): number | null => (Number.isSafeInteger(e[k]) && (e[k] as number) >= 0 ? (e[k] as number) : null)
  const [id, name, label, description, path] = ['id', 'name', 'label', 'description', 'path'].map(str)
  const [version, storageKib, memoryKib, bytes] = ['version', 'storage_kib', 'memory_kib', 'bytes'].map(num)
  const developer = unhex(e.developer, 32)
  const hash = unhex(e.sha256, 32)
  if (id === null || !APP_ID.test(id) || !name || label === null || description === null || !version) return null
  if (path === null || !STORE_PATH.test(path) || !path.endsWith('.maki')) return null
  if (storageKib === null || memoryKib === null || !bytes || bytes > MAX_BUNDLE || !developer || !hash) return null
  if (!Array.isArray(e.permissions) || typeof e.backup !== 'boolean') return null
  const permissions: StoreApp['permissions'] = []
  for (const p of e.permissions as unknown[]) {
    const known = Permissions.find((k) => k.name === (p as { name?: unknown })?.name)
    const reason = (p as { reason?: unknown })?.reason
    if (!known || typeof reason !== 'string') return null
    permissions.push({ permission: known, reason })
  }
  let icon: Uint32Array | null = null
  if (typeof e.icon === 'string') {
    const raw = fromBase64(e.icon)
    if (!raw || raw.length !== 512) return null
    const view = new DataView(raw.buffer)
    icon = Uint32Array.from({ length: 128 }, (_, i) => view.getUint32(i * 4, true))
  }
  return {
    id,
    name,
    version,
    label,
    description,
    developer,
    permissions,
    storageKib,
    memoryKib,
    backup: e.backup as boolean,
    bytes,
    sha256: hash,
    path,
    icon
  }
}

/** The index, if `root`'s catalogue key signed it and it hasn't expired (`nowS`: unix seconds). */
export async function checkIndex(root: Root, file: Uint8Array, signature: Uint8Array, nowS: number): Promise<Index> {
  if (signature.length !== 64 || !(await verify(root.catalogue, INDEX_DOMAIN, file, signature))) {
    throw new StoreError("the store's index isn't signed by the maki store")
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file))
  } catch {
    throw new StoreError("the store's index isn't JSON")
  }
  if (json.format !== 1) throw new StoreError(`the store's index is format ${String(json.format)}, newer than this app reads`)
  const version = json.version
  const expires = json.expires
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(expires) || !Array.isArray(json.apps)) {
    throw new StoreError("the store's index is missing its version, expiry or apps")
  }
  if ((expires as number) <= nowS) {
    const when = new Date((expires as number) * 1000).toLocaleDateString()
    throw new StoreError(`the store's index expired on ${when}, so it may be out of date: try again later`)
  }
  const apps: StoreApp[] = []
  let skipped = 0
  for (const e of json.apps as unknown[]) {
    const app = e && typeof e === 'object' ? storeApp(e as Record<string, unknown>) : null
    if (app && !apps.some((a) => a.id === app.id)) apps.push(app)
    else skipped++
  }
  apps.sort((a, b) => a.name.localeCompare(b.name))
  return { version: version as number, expires: expires as number, apps, skipped }
}

// ------------------------------------------------------------------------------------------
// The store

/** Where the store's files come from: its address, or a folder (for development). */
export interface StoreSource {
  /** A file of the store's, by its path in the store (`roots/2.bin`), or null if it has none. */
  get(path: string): Promise<Uint8Array | null>
}

/** What this side keeps between runs: the newest root it took, and the newest index's version. */
export interface StoreMemory {
  root: Uint8Array | null
  indexVersion: number
}

export interface StoreKeeper {
  load(): Promise<StoreMemory>
  save(memory: StoreMemory): Promise<void>
}

export function memoryKeeper(): StoreKeeper {
  let kept: StoreMemory = { root: null, indexVersion: 0 }
  return {
    load: async () => kept,
    save: async (m) => {
      kept = m
    }
  }
}

export class Store {
  /** the newest root, once checked */
  root: Root | null = null
  index: Index | null = null
  revocations: Revocations | null = null
  /** why the last check failed */
  problem: string | null = null
  checkedAt = 0

  constructor(
    private source: StoreSource,
    private keeper: StoreKeeper = memoryKeeper(),
    private now: () => Date = () => new Date(),
    private firstRoot: Uint8Array = fromBase64(FIRST_ROOT)!
  ) {}

  get stale(): boolean {
    return this.now().getTime() - this.checkedAt > RECHECK_MS
  }

  /** Fetches the store's newest root, index and revocation list, and checks them. */
  async refresh(): Promise<void> {
    try {
      await this.check()
      this.problem = null
    } catch (e) {
      this.problem = (e as Error).message
      throw e
    } finally {
      this.checkedAt = this.now().getTime()
    }
  }

  private async check(): Promise<void> {
    const kept = await this.keeper.load()
    let root = await trustFirst(decodeRoot(this.firstRoot))
    // the newest root taken before: it was checked then, and can't be older than the first
    if (kept.root) {
      const before = await trustFirst(decodeRoot(kept.root)).catch(() => null)
      if (before && before.version > root.version) root = before
    }
    let taken: Uint8Array | null = null
    for (;;) {
      const next = await this.source.get(`roots/${root.version + 1}.bin`)
      if (!next) break
      root = await replaces(decodeRoot(next), root)
      taken = next
    }
    const nowS = Math.floor(this.now().getTime() / 1000)
    if (root.catalogueExpires <= nowS) throw new StoreError("the store's signing key has expired: update maki desktop")
    const [file, signature] = await Promise.all([this.source.get('index.json'), this.source.get('index.sig')])
    if (!file || !signature) throw new StoreError('the store has no index')
    const index = await checkIndex(root, file, signature, nowS)
    if (index.version < kept.indexVersion) {
      throw new StoreError(`the store's index is older than one seen before (${index.version}, not ${kept.indexVersion}): try again later`)
    }
    const listFile = await this.source.get('revocations.bin')
    let list: Revocations | null = null
    if (listFile) {
      list = decodeRevocations(listFile)
      if (!(await revocationsSigned(list, root))) throw new StoreError("the store's revocation list isn't signed by the maki store")
    }
    await this.keeper.save({ root: taken ?? kept.root, indexVersion: index.version })
    this.root = root
    this.index = index
    this.revocations = list
  }

  /**
   * Hands maki the store's roots it hasn't taken, in order, then the revocation list if it's
   * newer than maki's (or maki just took a root: a list the old catalogue key signed goes, whatever
   * its version). maki checks each against the root it trusts. What it said, a line each; `locked`
   * if maki can't take anything until its PIN is in.
   */
  async push(client: MakiClient): Promise<{ locked: boolean; notes: string[] }> {
    if (!this.root) return { locked: false, notes: [] }
    let r: StoreUpdate = await client.storeUpdate()
    if (r.status === 'locked') return { locked: true, notes: [] }
    if (r.status !== 'approved') return { locked: false, notes: [`maki can't take the store's records: ${r.status}`] }
    const notes: string[] = []
    let rooted = false
    for (let v = r.state.root + 1; v <= this.root.version; v++) {
      const bytes = await this.source.get(`roots/${v}.bin`)
      if (!bytes) return { locked: false, notes: [...notes, `the store has no root ${v}`] }
      r = await client.storeUpdate(bytes)
      if (r.status !== 'approved') {
        return { locked: r.status === 'locked', notes: [...notes, `maki didn't take the store's root ${v}: ${r.reason || r.status}`] }
      }
      notes.push(`maki took the store's root ${v}`)
      rooted = true
    }
    const list = this.revocations
    if (list && (list.version > r.state.revocations || rooted)) {
      const t = await client.storeUpdate(list.bytes)
      notes.push(
        t.status === 'approved'
          ? `maki took the store's revocation list ${list.version}`
          : `maki didn't take the store's revocation list ${list.version}: ${t.reason || t.status}`
      )
    }
    return { locked: false, notes }
  }

  /** A store app's stamped bundle, checked against the index: its size, its hash, and that it's the app the index names. */
  async bundle(app: StoreApp): Promise<Bundle> {
    const bytes = await this.source.get(app.path)
    if (!bytes) throw new StoreError(`the store has no ${app.path}`)
    if (bytes.length !== app.bytes || !equal(await sha256(bytes), app.sha256)) {
      throw new StoreError(`${app.name} from the store isn't what its index says`)
    }
    const b = readBundle(bytes)
    if (b.manifest.id !== app.id || b.manifest.version !== app.version || !equal(b.developer, app.developer) || !b.stamp) {
      throw new StoreError(`${app.name} from the store isn't what its index says`)
    }
    return b
  }
}
