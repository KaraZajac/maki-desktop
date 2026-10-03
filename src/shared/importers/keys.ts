/**
 * Passkeys' private keys as exports hold them (PKCS#8, SEC 1, PEM, JWK, COSE_Key), made what maki
 * keeps: the P-256 private scalar, 32 bytes. maki's passkeys are ES256 (ECDSA on P-256 with
 * SHA-256) alone; a key of another kind is named, so the owner knows why it's left out. A key that
 * carries its public half is checked against it.
 */
import { p256 } from '@noble/curves/nist.js'
import type { FoundKey } from './model'
import { fromBase64Any, str } from './text'

/** A DER value: its tag, and its contents. */
interface Der {
  tag: number
  body: Uint8Array
}

/** The DER values in `bytes`, one after another; null if they aren't DER. */
function derList(bytes: Uint8Array): Der[] | null {
  const out: Der[] = []
  let at = 0
  while (at < bytes.length) {
    if (at + 2 > bytes.length) return null
    const tag = bytes[at]
    let length = bytes[at + 1]
    at += 2
    if (length & 0x80) {
      const n = length & 0x7f
      if (n === 0 || n > 3 || at + n > bytes.length) return null
      length = 0
      for (let i = 0; i < n; i++) length = length * 256 + bytes[at + i]
      at += n
    }
    if (at + length > bytes.length) return null
    out.push({ tag, body: bytes.subarray(at, at + length) })
    at += length
  }
  return out
}

/** An OID's dotted form. */
function oid(body: Uint8Array): string {
  const parts = [Math.floor(body[0] / 40), body[0] % 40]
  let value = 0
  for (const b of body.subarray(1)) {
    value = value * 128 + (b & 0x7f)
    if (!(b & 0x80)) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

const EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const P256 = '1.2.840.10045.3.1.7'
/** What other keys are, for saying why they're left out. */
const OTHERS: Record<string, string> = {
  '1.3.101.112': 'an EdDSA (Ed25519) passkey',
  '1.3.101.113': 'an EdDSA (Ed448) passkey',
  '1.2.840.113549.1.1.1': 'an RS256 (RSA) passkey',
  '1.2.840.113549.1.1.10': 'an RSA-PSS passkey',
  '1.3.132.0.34': 'an ES384 (P-384) passkey',
  '1.3.132.0.35': 'an ES512 (P-521) passkey',
  '1.3.132.0.10': 'a passkey on secp256k1 (ES256K)'
}
const ONLY_ES256 = 'and maki’s passkeys are ES256 (P-256) alone'

/** The scalar of a P-256 key, checked: 32 bytes, in range, and matching `publicKey` if there is one. */
function scalar(
  d: Uint8Array,
  publicKey: Uint8Array | null
): { scalar: Uint8Array } | { why: string } {
  // a leading zero dropped, or one too many
  let k = d
  while (k.length > 32 && k[0] === 0) k = k.subarray(1)
  if (k.length > 32) return { why: 'a passkey whose key isn’t a P-256 key' }
  const out = new Uint8Array(32)
  out.set(k, 32 - k.length)
  if (!p256.utils.isValidSecretKey(out))
    return { why: 'a passkey whose key isn’t a valid P-256 key' }
  if (publicKey !== null) {
    const ours = p256.getPublicKey(out, publicKey.length === 33)
    if (ours.length !== publicKey.length || ours.some((b, i) => b !== publicKey[i]))
      return { why: 'a passkey whose private key doesn’t match its public key (a damaged file)' }
  }
  return { scalar: out }
}

/** SEC 1's ECPrivateKey: its scalar, its curve if it names one, and its public key if it has it. */
function sec1(
  bytes: Uint8Array
): { d: Uint8Array; curve: string | null; publicKey: Uint8Array | null } | null {
  const outer = derList(bytes)
  if (!outer || outer.length !== 1 || outer[0].tag !== 0x30) return null
  const fields = derList(outer[0].body)
  if (!fields || fields.length < 2 || fields[0].tag !== 0x02 || fields[1].tag !== 0x04) return null
  let curve: string | null = null
  let publicKey: Uint8Array | null = null
  for (const f of fields.slice(2)) {
    const inner = derList(f.body)
    if (f.tag === 0xa0 && inner?.[0]?.tag === 0x06) curve = oid(inner[0].body)
    // a BIT STRING: its first byte the unused bits (0)
    if (f.tag === 0xa1 && inner?.[0]?.tag === 0x03 && inner[0].body[0] === 0)
      publicKey = inner[0].body.subarray(1)
  }
  return { d: fields[1].body, curve, publicKey }
}

/** PKCS#8's PrivateKeyInfo, for P-256: its scalar; or why it isn't one maki takes. */
export function fromPkcs8(bytes: Uint8Array): { scalar: Uint8Array } | { why: string } {
  const outer = derList(bytes)
  const fields = outer?.length === 1 && outer[0].tag === 0x30 ? derList(outer[0].body) : null
  if (!fields || fields.length < 3 || fields[1].tag !== 0x30 || fields[2].tag !== 0x04)
    return { why: 'a passkey whose key can’t be read' }
  const algorithm = derList(fields[1].body)
  if (!algorithm || algorithm[0]?.tag !== 0x06) return { why: 'a passkey whose key can’t be read' }
  const kind = oid(algorithm[0].body)
  if (kind !== EC_PUBLIC_KEY)
    return { why: `${OTHERS[kind] ?? 'a passkey of a kind maki doesn’t know'}, ${ONLY_ES256}` }
  const inner = sec1(fields[2].body)
  if (!inner) return { why: 'a passkey whose key can’t be read' }
  const curve = algorithm[1]?.tag === 0x06 ? oid(algorithm[1].body) : inner.curve
  if (curve !== P256)
    return {
      why: `${(curve && OTHERS[curve]) ?? 'a passkey on a curve maki doesn’t know'}, ${ONLY_ES256}`
    }
  // a PKCS#8 v2 public key ([1]), if SEC 1's hasn't one
  let publicKey = inner.publicKey
  const v2 = fields.find((f) => f.tag === 0x81)
  if (!publicKey && v2 && v2.body[0] === 0) publicKey = v2.body.subarray(1)
  return scalar(inner.d, publicKey)
}

/** A PEM key (PKCS#8, or SEC 1's EC key): its scalar; or why maki can't take it. */
export function fromPem(pem: string): { scalar: Uint8Array } | { why: string } {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem)
  if (!m) return { why: 'a passkey whose key can’t be read' }
  const der = fromBase64Any(m[2].replace(/^[A-Za-z-]+:.*$/gm, ''))
  if (!der) return { why: 'a passkey whose key can’t be read' }
  switch (m[1]) {
    case 'PRIVATE KEY':
      return fromPkcs8(der)
    case 'EC PRIVATE KEY': {
      const k = sec1(der)
      if (!k) return { why: 'a passkey whose key can’t be read' }
      if (k.curve !== null && k.curve !== P256)
        return {
          why: `${OTHERS[k.curve] ?? 'a passkey on a curve maki doesn’t know'}, ${ONLY_ES256}`
        }
      return scalar(k.d, k.publicKey)
    }
    case 'RSA PRIVATE KEY':
      return { why: `an RS256 (RSA) passkey, ${ONLY_ES256}` }
    case 'ENCRYPTED PRIVATE KEY':
      return { why: 'a passkey whose key is encrypted in the file' }
    default:
      return { why: 'a passkey whose key can’t be read' }
  }
}

/** A JSON Web Key: its scalar, for P-256; or why maki can't take it. */
export function fromJwk(jwk: Record<string, unknown>): { scalar: Uint8Array } | { why: string } {
  const kty = str(jwk.kty)
  const crv = str(jwk.crv)
  if (kty === 'OKP') return { why: `an EdDSA (${crv || 'Ed25519'}) passkey, ${ONLY_ES256}` }
  if (kty === 'RSA') return { why: `an RS256 (RSA) passkey, ${ONLY_ES256}` }
  if (kty !== 'EC') return { why: 'a passkey whose key can’t be read' }
  if (crv !== 'P-256')
    return {
      why: `${crv === 'P-384' ? 'an ES384 (P-384) passkey' : crv === 'P-521' ? 'an ES512 (P-521) passkey' : `a passkey on ${crv || 'a curve maki doesn’t know'}`}, ${ONLY_ES256}`
    }
  const d = fromBase64Any(str(jwk.d))
  if (!d || d.length === 0) return { why: 'a passkey whose private key isn’t in the file' }
  const x = fromBase64Any(str(jwk.x))
  const y = fromBase64Any(str(jwk.y))
  const publicKey =
    x && y && x.length === 32 && y.length === 32 ? Uint8Array.of(4, ...x, ...y) : null
  return scalar(d, publicKey)
}

/** A COSE_Key (RFC 9052; CBOR): its scalar, for an EC2 key on P-256; or why maki can't take it. */
export function fromCose(bytes: Uint8Array): { scalar: Uint8Array } | { why: string } {
  const map = cborMap(bytes)
  if (!map) return { why: 'a passkey whose key can’t be read' }
  return fromCoseKey(map)
}

/**
 * A COSE_Key's parameters, by label (1 kty, -1 crv, -2 x, -3 y, -4 d): the scalar, for an EC2 key
 * on P-256; or why maki can't take it.
 */
export function fromCoseKey(
  map: Map<number, number | Uint8Array>
): { scalar: Uint8Array } | { why: string } {
  const kty = map.get(1)
  const crv = map.get(-1)
  if (kty === 1) return { why: `an EdDSA passkey, ${ONLY_ES256}` }
  if (kty === 3) return { why: `an RS256 (RSA) passkey, ${ONLY_ES256}` }
  if (kty !== 2) return { why: 'a passkey whose key can’t be read' }
  if (crv !== 1)
    return {
      why: `${crv === 2 ? 'an ES384 (P-384) passkey' : crv === 3 ? 'an ES512 (P-521) passkey' : 'a passkey on a curve maki doesn’t know'}, ${ONLY_ES256}`
    }
  const d = map.get(-4)
  if (!(d instanceof Uint8Array)) return { why: 'a passkey whose private key isn’t in the file' }
  const x = map.get(-2)
  const y = map.get(-3)
  const publicKey =
    x instanceof Uint8Array && y instanceof Uint8Array && x.length === 32 && y.length === 32
      ? Uint8Array.of(4, ...x, ...y)
      : null
  return scalar(d, publicKey)
}

/**
 * A CBOR map with integer keys and integer or byte-string values, as COSE keys are: null if the
 * bytes aren't one. Text values are skipped; nothing else is read.
 */
function cborMap(bytes: Uint8Array): Map<number, number | Uint8Array> | null {
  let at = 0
  const head = (): { major: number; value: number } | null => {
    if (at >= bytes.length) return null
    const b = bytes[at++]
    const major = b >> 5
    let value = b & 0x1f
    if (value === 24) value = bytes[at++]
    else if (value === 25) ((value = (bytes[at] << 8) | bytes[at + 1]), (at += 2))
    else if (value === 26)
      ((value =
        ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0),
        (at += 4))
    else if (value > 26) return null
    return at <= bytes.length ? { major, value } : null
  }
  const top = head()
  if (!top || top.major !== 5 || top.value > 64) return null
  const out = new Map<number, number | Uint8Array>()
  for (let i = 0; i < top.value; i++) {
    const k = head()
    if (!k || (k.major !== 0 && k.major !== 1)) return null
    const key = k.major === 0 ? k.value : -1 - k.value
    const v = head()
    if (!v) return null
    if (v.major === 0) out.set(key, v.value)
    else if (v.major === 1) out.set(key, -1 - v.value)
    else if (v.major === 2 || v.major === 3) {
      if (at + v.value > bytes.length) return null
      if (v.major === 2) out.set(key, bytes.slice(at, at + v.value))
      at += v.value
    } else return null
  }
  return out
}

/** A passkey's key as an export holds it: the P-256 scalar maki keeps, or why maki can't take it. */
export function privateScalar(key: FoundKey): { scalar: Uint8Array } | { why: string } {
  if ('pkcs8' in key) return fromPkcs8(key.pkcs8)
  if ('pem' in key) return fromPem(key.pem)
  if ('jwk' in key) return fromJwk(key.jwk)
  if ('coseKey' in key) return fromCoseKey(key.coseKey)
  return fromCose(key.cose)
}
