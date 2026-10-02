/**
 * CashAddr, Bitcoin Cash's addresses (`bitcoincash:q…`): a prefix, then a version byte (the
 * kind: 0 pay-to-key-hash, 1 pay-to-script-hash; the size: 0 for 160 bits) and the hash in
 * five-bit groups, then a 40-bit checksum over the prefix's low five bits, a zero and the groups.
 * The same as maki's own (maki-btc's `cashaddr`), which shows them on its screen. Kaspa's
 * addresses are written the same way, with versions of their own (`encodeCashBytes`).
 *
 * No Node or DOM imports: this runs in the renderer, in the main process and in tests.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATOR = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]

function polymod(values: number[]): bigint {
  let c = 1n
  for (const d of values) {
    const c0 = c >> 35n
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i]
  }
  return c ^ 1n
}

const prefixBits = (prefix: string): number[] => [...prefix].map((ch) => ch.charCodeAt(0) & 31)

/** Bytes as five-bit groups (padded), or five-bit groups back as bytes (no padding left over). */
function regroup(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (let i = 0; i < data.length; i++) {
    acc = (acc << from) | data[i]
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & max)
    }
    acc &= (1 << bits) - 1
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max)
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    return null
  }
  return out
}

/** Bytes (a version byte, then what it says) as an address with `prefix`, checksum and all. */
export function encodeCashBytes(prefix: string, bytes: ArrayLike<number>): string {
  const groups = regroup(bytes, 8, 5, true)!
  const sum = polymod([...prefixBits(prefix), 0, ...groups, 0, 0, 0, 0, 0, 0, 0, 0])
  const check = Array.from({ length: 8 }, (_, i) => Number((sum >> BigInt(5 * (7 - i))) & 31n))
  return `${prefix}:${[...groups, ...check].map((g) => CHARSET[g]).join('')}`
}

/**
 * The bytes an address on `prefix`'s network carries (its version byte, then the rest), if its
 * checksum holds: with its prefix or without, in small letters or in capitals (never mixed).
 */
export function decodeCashBytes(address: string, prefix: string): Uint8Array | null {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null
  const lower = address.toLowerCase()
  const body = lower.startsWith(`${prefix}:`) ? lower.slice(prefix.length + 1) : lower
  if (body.includes(':') || body.length <= 8 || body.length > 120) return null
  const values: number[] = []
  for (const ch of body) {
    const v = CHARSET.indexOf(ch)
    if (v < 0) return null
    values.push(v)
  }
  if (polymod([...prefixBits(prefix), 0, ...values]) !== 0n) return null
  const bytes = regroup(values.slice(0, -8), 5, 8, false)
  return bytes && bytes.length > 0 ? Uint8Array.from(bytes) : null
}

export type CashKind = 'p2pkh' | 'p2sh'

/** A 20-byte hash as a CashAddr with `prefix` (`bitcoincash`, or `bchtest` on the test network). */
export function encodeCashAddr(prefix: string, kind: CashKind, hash: Uint8Array): string {
  if (hash.length !== 20) throw new Error('CashAddr here is for 160-bit hashes')
  return encodeCashBytes(prefix, [kind === 'p2pkh' ? 0 : 8, ...hash])
}

/**
 * A CashAddr's kind and hash, if it's one on `prefix`'s network: with its prefix or without, in
 * small letters or in capitals (never mixed). Null if it isn't one.
 */
export function decodeCashAddr(
  address: string,
  prefix: string
): { kind: CashKind; hash: Uint8Array } | null {
  const bytes = decodeCashBytes(address, prefix)
  if (!bytes || bytes.length !== 21) return null
  const version = bytes[0]
  if ((version & 7) !== 0) return null // 160 bits alone
  const kind = version >> 3 === 0 ? 'p2pkh' : version >> 3 === 1 ? 'p2sh' : null
  if (!kind) return null
  return { kind, hash: bytes.slice(1) }
}
