/**
 * For tests: zips as exports come in, and passkeys' keys as exports write them, made here (no Node
 * or DOM imports, so the end-to-end test can write them to files too). The samples of each
 * manager's export, written from its documented format with made-up logins, are in
 * `samples/`.
 */
import { p256 } from '@noble/curves/nist.js'
import { crc32 } from '../protocol'
import { toBase64Url } from './text'

/** A zip of `files`, each deflated (or stored, with `stored`), as exporters write them. */
export async function makeZip(
  files: { name: string; data: Uint8Array | string; stored?: boolean }[]
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const data = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data
    const body = f.stored ? data : await deflate(data)
    const name = new TextEncoder().encode(f.name)
    const crc = crc32(data)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true)
    head.setUint16(4, 20, true)
    head.setUint16(6, 0x800, true)
    head.setUint16(8, f.stored ? 0 : 8, true)
    head.setUint32(14, crc, true)
    head.setUint32(18, body.length, true)
    head.setUint32(22, data.length, true)
    head.setUint16(26, name.length, true)
    parts.push(new Uint8Array(head.buffer), name, body)
    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(4, 20, true)
    dir.setUint16(6, 20, true)
    dir.setUint16(8, 0x800, true)
    dir.setUint16(10, f.stored ? 0 : 8, true)
    dir.setUint32(16, crc, true)
    dir.setUint32(20, body.length, true)
    dir.setUint32(24, data.length, true)
    dir.setUint16(28, name.length, true)
    dir.setUint32(42, offset, true)
    central.push(new Uint8Array(dir.buffer), name)
    offset += 30 + name.length + body.length
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, dirSize, true)
  end.setUint32(16, offset, true)
  return concat([...parts, ...central, new Uint8Array(end.buffer)])
}

/** Raw deflate, through the platform's CompressionStream. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Byte arrays, one after another. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) (out.set(p, at), (at += p.length))
  return out
}

/** A P-256 key's scalar for tests: 32 bytes of `fill`, then `n`. */
export function testScalar(n: number): Uint8Array {
  const d = new Uint8Array(32).fill(0x11)
  d[31] = n
  return d
}

/** A P-256 key as PKCS#8 DER, its public key with it, as WebCrypto exports one (Bitwarden's `keyValue`). */
export function pkcs8(d: Uint8Array): Uint8Array {
  const pub = p256.getPublicKey(d, false)
  return concat([
    Uint8Array.of(0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07),
    Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08),
    Uint8Array.of(
      0x2a,
      0x86,
      0x48,
      0xce,
      0x3d,
      0x03,
      0x01,
      0x07,
      0x04,
      0x6d,
      0x30,
      0x6b,
      0x02,
      0x01,
      0x01,
      0x04,
      0x20
    ),
    d,
    Uint8Array.of(0xa1, 0x44, 0x03, 0x42, 0x00),
    pub
  ])
}

/** An Ed25519 key as PKCS#8 DER (what an EdDSA passkey's key looks like): 32 bytes of seed. */
export function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  return concat([
    Uint8Array.of(
      0x30,
      0x2e,
      0x02,
      0x01,
      0x00,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x04,
      0x22,
      0x04,
      0x20
    ),
    seed
  ])
}

/** A key as PEM, the way KeePassXC keeps a passkey's ("-----BEGIN PRIVATE KEY-----"). */
export function pem(der: Uint8Array, label = 'PRIVATE KEY'): string {
  let b64 = ''
  for (let i = 0; i < der.length; i += 3) {
    const n = (der[i] << 16) | ((der[i + 1] ?? 0) << 8) | (der[i + 2] ?? 0)
    const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    b64 += s[(n >> 18) & 63] + s[(n >> 12) & 63]
    b64 += i + 1 < der.length ? s[(n >> 6) & 63] : '='
    b64 += i + 2 < der.length ? s[n & 63] : '='
  }
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

/** A P-256 key as a JWK, its public half with it. */
export function jwk(d: Uint8Array): Record<string, string> {
  const pub = p256.getPublicKey(d, false)
  return {
    kty: 'EC',
    crv: 'P-256',
    d: toBase64Url(d),
    x: toBase64Url(pub.subarray(1, 33)),
    y: toBase64Url(pub.subarray(33))
  }
}

/** A value for `msgpack`: bytes go as rmp-serde writes a `Vec<u8>`, an array of integers. */
export type Packable =
  null | boolean | number | string | Uint8Array | Packable[] | { [key: string]: Packable }

/** MessagePack, written as rmp-serde writes Proton Pass's passkeys (named fields; bytes as arrays). */
export function msgpack(v: Packable): Uint8Array {
  const out: number[] = []
  const len = (
    n: number,
    small: number,
    tiny: number,
    op8: number | null,
    op16: number,
    op32: number
  ): void => {
    if (n < small) out.push(tiny | n)
    else if (op8 !== null && n < 256) out.push(op8, n)
    else if (n < 65536) out.push(op16, n >> 8, n & 0xff)
    else out.push(op32, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
  }
  const put = (x: Packable): void => {
    if (x === null) out.push(0xc0)
    else if (typeof x === 'boolean') out.push(x ? 0xc3 : 0xc2)
    else if (typeof x === 'number') {
      if (x >= 0 && x < 128) out.push(x)
      else if (x < 0 && x >= -32) out.push(0x100 + x)
      else if (x >= 0 && x < 256) out.push(0xcc, x)
      else if (x >= 0 && x < 65536) out.push(0xcd, x >> 8, x & 0xff)
      else if (x < 0 && x >= -128) out.push(0xd0, x & 0xff)
      else out.push(0xce, (x >>> 24) & 0xff, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff)
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x)
      len(b.length, 32, 0xa0, 0xd9, 0xda, 0xdb)
      out.push(...b)
    } else if (x instanceof Uint8Array) put(Array.from(x))
    else if (Array.isArray(x)) {
      len(x.length, 16, 0x90, null, 0xdc, 0xdd)
      x.forEach(put)
    } else {
      const keys = Object.keys(x)
      len(keys.length, 16, 0x80, null, 0xde, 0xdf)
      for (const k of keys) (put(k), put(x[k]))
    }
  }
  put(v)
  return Uint8Array.from(out)
}

/** Bytes as standard base64, padded (Proton Pass's export writes its passkeys' bytes so). */
export function base64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return url + '='.repeat((4 - (url.length % 4)) % 4)
}
