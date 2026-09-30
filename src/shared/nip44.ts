/**
 * NIP-44 (version 2): how Nostr's direct messages and NIP-46's requests are encrypted between two
 * keys. A conversation key from their ECDH (secp256k1, x only) through HKDF; for each message a
 * random nonce, HKDF-expanded to ChaCha20's key and nonce and HMAC-SHA256's key; the plaintext
 * padded so its length says little. And NIP-04, the older scheme some NIP-46 clients still send
 * (AES-256-CBC with the shared x as its key), so maki desktop can answer them in kind.
 */
import { cbc } from '@noble/ciphers/aes.js'
import { chacha20 } from '@noble/ciphers/chacha.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { base64 } from '@scure/base'

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

/** The ECDH of a secret key and an x-only public key (hex), its x: what both schemes start from. */
function sharedX(secret: Uint8Array, publicHex: string): Uint8Array {
  return secp256k1.getSharedSecret(secret, hexToBytes('02' + publicHex)).subarray(1, 33)
}

/** NIP-44's conversation key for `secret` and `publicHex`: the same from either side. */
export function conversationKey(secret: Uint8Array, publicHex: string): Uint8Array {
  return extract(sha256, sharedX(secret, publicHex), utf8.encode('nip44-v2'))
}

/** How long a plaintext of `n` bytes is once padded. */
export function paddedLength(n: number): number {
  if (n <= 32) return 32
  const next = 1 << (Math.floor(Math.log2(n - 1)) + 1)
  const chunk = next <= 256 ? 32 : next / 8
  return chunk * (Math.floor((n - 1) / chunk) + 1)
}

function pad(plaintext: string): Uint8Array {
  const b = utf8.encode(plaintext)
  if (b.length < 1 || b.length > 65535) throw new Error('a NIP-44 message is 1 to 65535 bytes')
  const out = new Uint8Array(2 + paddedLength(b.length))
  new DataView(out.buffer).setUint16(0, b.length)
  out.set(b, 2)
  return out
}

function unpad(padded: Uint8Array): string {
  const n = new DataView(padded.buffer, padded.byteOffset).getUint16(0)
  if (n < 1 || padded.length !== 2 + paddedLength(n)) throw new Error('NIP-44: bad padding')
  return fromUtf8.decode(padded.subarray(2, 2 + n))
}

function messageKeys(
  key: Uint8Array,
  nonce: Uint8Array
): { chacha: Uint8Array; iv: Uint8Array; mac: Uint8Array } {
  const k = expand(sha256, key, nonce, 76)
  return { chacha: k.subarray(0, 32), iv: k.subarray(32, 44), mac: k.subarray(44, 76) }
}

/** `plaintext`, encrypted with a conversation key: base64 of version 2, the nonce, the ciphertext and its MAC. */
export function encrypt(
  plaintext: string,
  key: Uint8Array,
  nonce: Uint8Array = randomBytes(32)
): string {
  const k = messageKeys(key, nonce)
  const ciphertext = chacha20(k.chacha, k.iv, pad(plaintext))
  const mac = hmac(sha256, k.mac, concatBytes(nonce, ciphertext))
  return base64.encode(concatBytes(Uint8Array.of(2), nonce, ciphertext, mac))
}

/** The plaintext of a payload, once its MAC checks; throws if it doesn't, or isn't version 2. */
export function decrypt(payload: string, key: Uint8Array): string {
  if (payload.length < 132 || payload.length > 87472 || payload[0] === '#')
    throw new Error('NIP-44: not a version 2 payload')
  const data = base64.decode(payload)
  if (data.length < 99 || data[0] !== 2) throw new Error('NIP-44: not a version 2 payload')
  const nonce = data.subarray(1, 33)
  const ciphertext = data.subarray(33, data.length - 32)
  const mac = data.subarray(data.length - 32)
  const k = messageKeys(key, nonce)
  const want = hmac(sha256, k.mac, concatBytes(nonce, ciphertext))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= want[i] ^ mac[i]
  if (diff !== 0) throw new Error('NIP-44: the MAC doesn’t match')
  return unpad(chacha20(k.chacha, k.iv, ciphertext))
}

/** NIP-04: `base64(AES-256-CBC(plaintext))?iv=base64(iv)`, keyed by the shared x. */
export function nip04Encrypt(
  plaintext: string,
  secret: Uint8Array,
  publicHex: string,
  iv: Uint8Array = randomBytes(16)
): string {
  const ciphertext = cbc(sharedX(secret, publicHex), iv).encrypt(utf8.encode(plaintext))
  return `${base64.encode(ciphertext)}?iv=${base64.encode(iv)}`
}

export function nip04Decrypt(payload: string, secret: Uint8Array, publicHex: string): string {
  const [ciphertext, iv] = payload.split('?iv=')
  if (!ciphertext || !iv) throw new Error('NIP-04: not an encrypted message')
  return fromUtf8.decode(
    cbc(sharedX(secret, publicHex), base64.decode(iv)).decrypt(base64.decode(ciphertext))
  )
}

/** Whether a payload is NIP-04's rather than NIP-44's. */
export const isNip04 = (payload: string): boolean => payload.includes('?iv=')
