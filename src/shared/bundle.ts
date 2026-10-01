/**
 * `.maki` app bundles, read on this side to show what one is before it goes to maki: its
 * manifest, icon and developer key. maki checks everything itself, signature included; this
 * reader only turns away what isn't a bundle. The format is libs/maki-bundle in the firmware
 * repo; keep the two in step.
 *
 * No Node or DOM imports here: this module runs in the renderer, in the main process and in tests.
 */

export const MAX_BUNDLE = 512 * 1024

export const Permissions = [
  {
    id: 1,
    name: 'ask',
    title: 'Ask you anytime',
    warning: "It can put questions to you on maki's screen, even while it isn't open."
  },
  {
    id: 2,
    name: 'link',
    title: 'Talk to your computer',
    warning:
      'It can send and receive messages through maki desktop. Your computer sees what it sends.'
  },
  {
    id: 3,
    name: 'keys',
    title: 'Keys of its own',
    warning:
      "It gets secrets made from your recovery phrase, for this app only: never your wallets' or passkeys'."
  },
  {
    id: 4,
    name: 'keyboard',
    title: 'Type on your computer',
    warning: "It can type anything into your computer while it's open, commands included."
  },
  {
    id: 5,
    name: 'camera',
    title: 'Use the camera',
    warning: "It can see what the camera sees while it's open."
  },
  {
    id: 6,
    name: 'motion',
    title: 'Sense motion',
    warning: 'It can read the accelerometer, which can pick up typing nearby.'
  },
  {
    id: 7,
    name: 'wallet',
    title: 'Sign for your wallets',
    warning:
      'It can sign for the accounts named next, once you say yes on maki: it could spend what they hold.'
  }
] as const

export type Permission = (typeof Permissions)[number]

export interface Manifest {
  id: string
  name: string
  version: number
  label: string
  kind: 'wasm' | 'native'
  api: number
  firmware: string
  permissions: { permission: Permission; reason: string }[]
  storageKib: number
  memoryKib: number
  backup: boolean
  description: string
  /** the wallet permission's accounts: BIP32 paths, each a hardened purpose and coin type */
  wallet: { curve: 'secp256k1' | 'ed25519'; paths: number[][] } | null
}

export interface Bundle {
  manifest: Manifest
  codeBytes: number
  /** 64x64 in maki_icons form (a set bit dark), or null */
  icon: Uint32Array | null
  /** the developer's Ed25519 public key */
  developer: Uint8Array
  /** the maki store's stamp, after the developer's signature, or null for a sideloaded bundle */
  stamp: Uint8Array | null
  bytes: Uint8Array
}

export class BundleError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function text(v: Uint8Array, what: string): string {
  try {
    return utf8.decode(v)
  } catch {
    throw new BundleError(`manifest: ${what} isn't text`)
  }
}

/** Reads a bundle's parts. Doesn't check the signature: maki does. */
export function readBundle(bytes: Uint8Array): Bundle {
  if (bytes.length > MAX_BUNDLE)
    throw new BundleError(`bigger than maki takes (${MAX_BUNDLE / 1024} KiB)`)
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MAKI')
    throw new BundleError('not a .maki bundle')
  if (bytes[4] !== 1) throw new BundleError(`bundle format ${bytes[4]}, newer than this app reads`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 5
  const section = (tag: number): Uint8Array => {
    if (at + 5 > bytes.length || bytes[at] !== tag)
      throw new BundleError('sections missing or out of order')
    const len = view.getUint32(at + 1, true)
    if (at + 5 + len > bytes.length) throw new BundleError('cut short')
    const s = bytes.subarray(at + 5, at + 5 + len)
    at += 5 + len
    return s
  }
  const manifestBytes = section(1)
  const code = section(2)
  let icon: Uint32Array | null = null
  if (bytes[at] === 3) {
    const raw = section(3)
    if (raw.length !== 512) throw new BundleError("the icon isn't 64x64")
    icon = new Uint32Array(128)
    const iv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    for (let i = 0; i < 128; i++) icon[i] = iv.getUint32(i * 4, true)
  }
  const sig = section(255)
  const stamp = bytes[at] === 254 ? section(254).slice() : null
  if (sig.length !== 96 || at !== bytes.length)
    throw new BundleError('sections missing or out of order')
  return {
    manifest: readManifest(manifestBytes),
    codeBytes: code.length,
    icon,
    developer: sig.slice(0, 32),
    stamp,
    bytes
  }
}

function readManifest(b: Uint8Array): Manifest {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const m: Manifest = {
    id: '',
    name: '',
    version: 0,
    label: '',
    kind: 'wasm',
    api: 0,
    firmware: '',
    permissions: [],
    storageKib: 0,
    memoryKib: 0,
    backup: false,
    description: '',
    wallet: null
  }
  let at = 0
  while (at < b.length) {
    if (at + 3 > b.length) throw new BundleError('manifest cut short')
    const tag = b[at]
    const len = view.getUint16(at + 1, true)
    if (at + 3 + len > b.length) throw new BundleError('manifest cut short')
    const v = b.subarray(at + 3, at + 3 + len)
    const u32 = (): number => new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0, true)
    at += 3 + len
    switch (tag) {
      case 1:
        m.id = text(v, 'id')
        break
      case 2:
        m.name = text(v, 'name')
        break
      case 3:
        m.version = u32()
        break
      case 4:
        m.label = text(v, 'label')
        break
      case 5:
        m.kind = v[0] === 2 ? 'native' : 'wasm'
        break
      case 6:
        m.api = new DataView(v.buffer, v.byteOffset, v.byteLength).getUint16(0, true)
        break
      case 7:
        m.firmware = text(v, 'firmware')
        break
      case 8: {
        const permission = Permissions.find((p) => p.id === v[0])
        if (!permission) throw new BundleError("manifest: a permission this app doesn't know")
        m.permissions.push({ permission, reason: text(v.subarray(1), 'permission reason') })
        break
      }
      case 9:
        m.storageKib = u32()
        break
      case 10:
        m.memoryKib = u32()
        break
      case 11:
        m.backup = v[0] === 1
        break
      case 12:
        m.description = text(v, 'description')
        break
      case 13:
        m.wallet = walletField(v)
        break
      default:
        throw new BundleError("manifest: a field this app doesn't know")
    }
  }
  if (!m.id || !m.name || !m.version) throw new BundleError('manifest: no id, name or version')
  return m
}

/** Hardened, in a BIP32 path. */
export const HARDENED = 0x80000000

/**
 * The wallet permission's paths: a curve (1, secp256k1; 2, Ed25519, Solana's), then each path,
 * its depth and parts.
 */
function walletField(v: Uint8Array): { curve: 'secp256k1' | 'ed25519'; paths: number[][] } {
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  const curve = v[0] === 1 ? 'secp256k1' : v[0] === 2 ? 'ed25519' : null
  if (!curve) throw new BundleError("manifest: a wallet curve this app doesn't know")
  const n = v[1] ?? 0
  const paths: number[][] = []
  let at = 2
  for (let i = 0; i < n; i++) {
    const depth = v[at] ?? 0
    if (at + 1 + depth * 4 > v.length) throw new BundleError('manifest: wallet paths cut short')
    paths.push(Array.from({ length: depth }, (_, k) => view.getUint32(at + 1 + k * 4, true)))
    at += 1 + depth * 4
  }
  if (n === 0 || at !== v.length) throw new BundleError('manifest: wallet paths')
  return { curve, paths }
}

/** A path as wallets write it: `m/84'/0'`. */
export function formatPath(path: number[]): string {
  return ['m', ...path.map((c) => (c >= HARDENED ? `${c - HARDENED}'` : `${c}`))].join('/')
}

/** BIP-85's purpose, `83696968'`: keys that make entropy for other wallets (child seeds). */
const BIP85 = 83696968 + HARDENED

/**
 * The coins a wallet's paths reach (SLIP-44, from the coin type, never the app's say-so), each
 * once, as maki's install screen names them (maki_hd::coin in the firmware).
 */
export function walletCoins(paths: number[][]): string[] {
  const names: Record<number, string> = {
    0: 'Bitcoin',
    1: 'test networks',
    2: 'Litecoin',
    3: 'Dogecoin',
    60: 'Ethereum',
    128: 'Monero',
    145: 'Bitcoin Cash',
    501: 'Solana'
  }
  const out: string[] = []
  for (const p of paths) {
    const type = (p[1] ?? 0) % HARDENED
    // BIP-85's purpose: phrases for other wallets (child seeds), not a coin
    const name = p[0] === BIP85 ? 'child seeds' : (names[type] ?? `coin type ${type}`)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** A developer key as people compare it, as maki shows it: six groups of four hex digits. */
export async function fingerprint(key: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))
  const hex = [...hash.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{4}/g)!.join(' ')
}

/** An icon's pixels, row by row, true for light. */
export function iconPixels(icon: Uint32Array | ArrayLike<number>): boolean[] {
  const out: boolean[] = []
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) out.push(((icon[y * 2 + (x >> 5)] >>> (x & 31)) & 1) === 0)
  }
  return out
}
