/**
 * NIP-44 against its own test vectors (paulmillr/nip44's nip44.vectors.json, which NIP-44 points
 * to), and NIP-04 and NIP-44 against nostr-tools', in both directions.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nip04 as theirNip04, nip44 as theirNip44 } from 'nostr-tools'
import { describe, expect, it } from 'vitest'
import {
  conversationKey,
  decrypt,
  encrypt,
  nip04Decrypt,
  nip04Encrypt,
  paddedLength
} from './nip44'

const V = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/nip44.vectors.json'), 'utf8')).v2
const pub = (secHex: string): string =>
  bytesToHex(secp256k1.getPublicKey(hexToBytes(secHex), true).subarray(1))
const sha = (s: string): string => bytesToHex(sha256(new TextEncoder().encode(s)))

describe('NIP-44', () => {
  it('makes the conversation keys its vectors do, and refuses what isn’t a key', () => {
    for (const v of V.valid.get_conversation_key) {
      expect(bytesToHex(conversationKey(hexToBytes(v.sec1), v.pub2)), v.note ?? v.sec1).toBe(
        v.conversation_key
      )
    }
    for (const v of V.invalid.get_conversation_key) {
      expect(() => conversationKey(hexToBytes(v.sec1), v.pub2), v.note).toThrow()
    }
  })

  it('pads as its vectors do', () => {
    for (const [n, padded] of V.valid.calc_padded_len)
      expect(paddedLength(n), String(n)).toBe(padded)
  })

  it('encrypts and decrypts its vectors, from either side', () => {
    for (const v of V.valid.encrypt_decrypt) {
      const key = conversationKey(hexToBytes(v.sec1), pub(v.sec2))
      expect(bytesToHex(key)).toBe(v.conversation_key)
      expect(conversationKey(hexToBytes(v.sec2), pub(v.sec1))).toEqual(key)
      expect(encrypt(v.plaintext, key, hexToBytes(v.nonce))).toBe(v.payload)
      expect(decrypt(v.payload, key)).toBe(v.plaintext)
    }
    for (const v of V.valid.encrypt_decrypt_long_msg) {
      const plaintext = v.pattern.repeat(v.repeat)
      expect(sha(plaintext)).toBe(v.plaintext_sha256)
      const payload = encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce))
      expect(sha(payload)).toBe(v.payload_sha256)
      expect(decrypt(payload, hexToBytes(v.conversation_key))).toBe(plaintext)
    }
  })

  it('refuses what its vectors say to', () => {
    for (const v of V.invalid.decrypt) {
      expect(() => decrypt(v.payload, hexToBytes(v.conversation_key)), v.note).toThrow()
    }
    const key = randomBytes(32)
    for (const n of V.invalid.encrypt_msg_lengths) {
      expect(() => encrypt('a'.repeat(n), key), String(n)).toThrow()
    }
  })

  it('agrees with nostr-tools, NIP-44 and NIP-04, both ways', () => {
    for (let i = 0; i < 5; i++) {
      const [a, b] = [secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey()]
      const [pa, pb] = [pub(bytesToHex(a)), pub(bytesToHex(b))]
      const text = `a message ${i} ✓ ${'x'.repeat(i * 100)}`
      const key = conversationKey(a, pb)
      expect(key).toEqual(theirNip44.getConversationKey(b, pa))
      expect(theirNip44.decrypt(encrypt(text, key), theirNip44.getConversationKey(b, pa))).toBe(
        text
      )
      expect(decrypt(theirNip44.encrypt(text, theirNip44.getConversationKey(b, pa)), key)).toBe(
        text
      )
      expect(theirNip04.decrypt(b, pa, nip04Encrypt(text, a, pb))).toBe(text)
      expect(nip04Decrypt(theirNip04.encrypt(b, pa, text), a, pb)).toBe(text)
    }
  })
})
