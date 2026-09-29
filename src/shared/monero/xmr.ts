/**
 * Monero's cryptography, as far as maki desktop needs it: never the spend key, which only maki
 * has. With the view key maki shares once its owner says yes, it finds the wallet's outputs and
 * which subaddress each was paid to, and reads and writes wallet2's files (wallet2.ts); everything
 * that spends is maki's.
 *
 * Keccak-256 (Monero's `cn_fast_hash`: Keccak's own padding, not SHA-3's), hashes to scalars
 * (reduced mod ℓ), Ed25519 points (noble's), key derivations (8·a·R), subaddresses, Monero's
 * base58 addresses, and the Schnorr signatures its files are signed with.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

export const Point = ed25519.Point
export type EdPoint = InstanceType<typeof ed25519.Point>
/** The prime order of the group Monero's keys live in. */
export const L = Point.Fn.ORDER

export function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** A little-endian number from bytes. */
export function leNumber(bytes: Uint8Array): bigint {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return v
}

/** A scalar as Monero writes one: 32 bytes, little-endian. */
export function scalarBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = ((s % L) + L) % L
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Monero's `hash_to_scalar`: Keccak-256, reduced mod ℓ. */
export function hashToScalar(data: Uint8Array): bigint {
  return leNumber(keccak(data)) % L
}

export function randomScalar(): bigint {
  const wide = crypto.getRandomValues(new Uint8Array(64))
  const s = leNumber(wide) % L
  return s === 0n ? randomScalar() : s
}

/** Monero's varint: seven bits a byte, low first, the top bit saying more follow. */
export function varint(n: number | bigint): Uint8Array {
  let v = BigInt(n)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return Uint8Array.from(out)
}

/** A point from its 32 bytes; throws if they aren't one. */
export function point(bytes: Uint8Array): EdPoint {
  return Point.fromBytes(bytes)
}

export function pointOrNull(bytes: Uint8Array): EdPoint | null {
  try {
    return Point.fromBytes(bytes)
  } catch {
    return null
  }
}

/** s·P, for any scalar (0 included). */
export function mul(p: EdPoint, s: bigint): EdPoint {
  const r = ((s % L) + L) % L
  return r === 0n ? Point.ZERO : p.multiplyUnsafe(r)
}

export function mulBase(s: bigint): EdPoint {
  return mul(Point.BASE, s)
}

/** H, the generator amounts are committed to. */
export const H = point(
  Uint8Array.from([
    0x8b, 0x65, 0x59, 0x70, 0x15, 0x37, 0x99, 0xaf, 0x2a, 0xea, 0xdc, 0x9f, 0xf1, 0xad, 0xd0, 0xea,
    0x6c, 0x72, 0x51, 0xd5, 0x41, 0x54, 0xcf, 0xa9, 0x2c, 0x17, 0x3a, 0x0d, 0xd3, 0x9c, 0x1f, 0x94
  ])
)

/** A commitment to `amount`, hidden by `mask`: mask·G + amount·H. */
export function commit(mask: bigint, amount: bigint): EdPoint {
  return mulBase(mask).add(mul(H, amount))
}

/** What sender and receiver share of an output (`generate_key_derivation`): 8·a·R. */
export function derivation(secret: bigint, publicKey: Uint8Array): Uint8Array {
  return mul(point(publicKey), secret).multiplyUnsafe(8n).toBytes()
}

/** The scalar an output's keys are made with: Hs(derivation ‖ index). */
export function derivationToScalar(d: Uint8Array, index: number): bigint {
  return hashToScalar(concat(d, varint(index)))
}

/** An output's one-time key for spend key `spend`: Hs(derivation ‖ index)·G + spend. */
export function derivePublicKey(d: Uint8Array, index: number, spend: Uint8Array): Uint8Array {
  return mulBase(derivationToScalar(d, index)).add(point(spend)).toBytes()
}

/** An output's view tag: the first byte of Keccak("view_tag" ‖ derivation ‖ index). */
export function viewTag(d: Uint8Array, index: number): number {
  return keccak(concat(new TextEncoder().encode('view_tag'), d, varint(index)))[0]
}

/** An output's amount from what the transaction carries (RingCT's `ecdhDecode`, version 2). */
export function decryptAmount(encrypted: Uint8Array, scalar: bigint): bigint {
  const pad = keccak(concat(new TextEncoder().encode('amount'), scalarBytes(scalar)))
  const plain = encrypted.map((b, i) => b ^ pad[i])
  return leNumber(plain)
}

/** The mask an output's amount commitment is made with (`genCommitmentMask`). */
export function commitmentMask(scalar: bigint): bigint {
  return hashToScalar(concat(new TextEncoder().encode('commitment_mask'), scalarBytes(scalar)))
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}

/** What subaddress (major, minor)'s spend key adds to the account's: Hs("SubAddr\0" ‖ a ‖ major ‖ minor). */
export function subaddressSecret(view: bigint, major: number, minor: number): bigint {
  return hashToScalar(
    concat(new TextEncoder().encode('SubAddr\0'), scalarBytes(view), u32le(major), u32le(minor))
  )
}

/** Subaddress (major, minor)'s public spend and view keys; (0, 0) is the account's own address. */
export function subaddressKeys(
  view: bigint,
  spend: Uint8Array,
  major: number,
  minor: number
): { spend: Uint8Array; view: Uint8Array } {
  if (major === 0 && minor === 0) return { spend, view: mulBase(view).toBytes() }
  const d = point(spend).add(mulBase(subaddressSecret(view, major, minor)))
  return { spend: d.toBytes(), view: mul(d, view).toBytes() }
}

// ---------------------------------------------------------------------------------------------
// Signatures: `crypto::generate_signature` and `check_signature`, what wallet2 signs its files
// with (the view key's), a Schnorr signature c ‖ r.

export function generateSignature(hash: Uint8Array, secret: bigint): Uint8Array {
  const pub = mulBase(secret).toBytes()
  for (;;) {
    const k = randomScalar()
    const c = hashToScalar(concat(hash, pub, mulBase(k).toBytes()))
    if (c === 0n) continue
    const r = (((k - c * secret) % L) + L) % L
    if (r === 0n) continue
    return concat(scalarBytes(c), scalarBytes(r))
  }
}

export function checkSignature(hash: Uint8Array, pub: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false
  const c = leNumber(sig.subarray(0, 32))
  const r = leNumber(sig.subarray(32))
  if (c >= L || r >= L || c === 0n) return false
  const p = pointOrNull(pub)
  if (!p) return false
  const comm = mul(p, c).add(mulBase(r))
  if (comm.is0()) return false
  return hashToScalar(concat(hash, pub, comm.toBytes())) === c
}

// ---------------------------------------------------------------------------------------------
// Addresses: Monero's base58 (eight bytes at a time, eleven characters to a block), its networks'
// tags, and the three kinds.

export type Network = 'mainnet' | 'testnet' | 'stagenet'
export type AddressKind = 'standard' | 'subaddress' | 'integrated'

const TAGS: Record<Network, Record<AddressKind, number>> = {
  mainnet: { standard: 18, integrated: 19, subaddress: 42 },
  testnet: { standard: 53, integrated: 54, subaddress: 63 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ENCODED = [0, 2, 3, 5, 6, 7, 9, 10, 11]

export function base58Encode(data: Uint8Array): string {
  let out = ''
  for (let at = 0; at < data.length; at += 8) {
    const block = data.subarray(at, at + 8)
    let n = 0n
    for (const b of block) n = (n << 8n) | BigInt(b)
    const chars: string[] = []
    for (let i = 0; i < ENCODED[block.length]; i++) {
      chars.push(ALPHABET[Number(n % 58n)])
      n /= 58n
    }
    out += chars.reverse().join('')
  }
  return out
}

export function base58Decode(text: string): Uint8Array | null {
  const out: number[] = []
  for (let at = 0; at < text.length; at += 11) {
    const block = text.slice(at, at + 11)
    const bytes = ENCODED.indexOf(block.length)
    if (bytes < 0) return null
    let n = 0n
    for (const ch of block) {
      const v = ALPHABET.indexOf(ch)
      if (v < 0) return null
      n = n * 58n + BigInt(v)
    }
    if ((bytes < 8 && n >> BigInt(8 * bytes) !== 0n) || n > 0xffffffffffffffffn) return null
    for (let i = bytes - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn))
  }
  return Uint8Array.from(out)
}

export interface Address {
  network: Network
  kind: AddressKind
  spend: Uint8Array
  view: Uint8Array
  /** an integrated address's */
  paymentId?: Uint8Array
}

export function encodeAddress(a: Address): string {
  const data = concat(
    Uint8Array.of(TAGS[a.network][a.kind]),
    a.spend,
    a.view,
    a.kind === 'integrated' ? a.paymentId! : new Uint8Array()
  )
  return base58Encode(concat(data, keccak(data).subarray(0, 4)))
}

/** What an address says, or null if it isn't one (or its check fails). */
export function decodeAddress(text: string): Address | null {
  const data = base58Decode(text.trim())
  if (!data || (data.length !== 69 && data.length !== 77)) return null
  const body = data.subarray(0, data.length - 4)
  if (!equal(keccak(body).subarray(0, 4), data.subarray(data.length - 4))) return null
  for (const network of Object.keys(TAGS) as Network[]) {
    for (const kind of Object.keys(TAGS[network]) as AddressKind[]) {
      if (TAGS[network][kind] !== data[0]) continue
      if ((kind === 'integrated') !== (data.length === 77)) return null
      return {
        network,
        kind,
        spend: data.slice(1, 33),
        view: data.slice(33, 65),
        ...(kind === 'integrated' ? { paymentId: data.slice(65, 73) } : {})
      }
    }
  }
  return null
}

/** Piconero in a monero. */
export const ATOMIC = 1_000_000_000_000n

/** An amount in monero, exactly, without trailing zeros: `0.5`, `1`, `0.000012`. */
export function formatXmr(piconero: bigint): string {
  const whole = piconero / ATOMIC
  const frac = piconero % ATOMIC
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(12, '0').replace(/0+$/, '')}`
}

/** "1.5" as piconero; null if it isn't an amount (more than twelve decimals, say). */
export function parseXmr(text: string): bigint | null {
  const m = /^\s*(\d*)(?:\.(\d{0,12}))?\s*$/.exec(text)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null
  return BigInt(m[1] || '0') * ATOMIC + BigInt((m[2] ?? '').padEnd(12, '0') || '0')
}
