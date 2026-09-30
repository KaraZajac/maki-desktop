/**
 * Nostr events signed with a key maki desktop holds itself (NIP-01): its NIP-46 bunker's, which
 * only carries requests between clients and maki. The owner's own key never leaves maki; events
 * with it are signed by maki's Nostr app (./nostr.ts).
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { SignedEvent, UnsignedEvent } from './nostr'

/** NIP-01's id: the SHA-256 of the event's fields, serialized as JSON. */
export function eventId(pubkey: string, e: UnsignedEvent): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]))
    )
  )
}

export const publicKeyOf = (secret: Uint8Array): string => bytesToHex(schnorr.getPublicKey(secret))

/** An event, signed with `secret`. */
export function signEvent(secret: Uint8Array, e: UnsignedEvent): SignedEvent {
  const pubkey = publicKeyOf(secret)
  const id = eventId(pubkey, e)
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), secret)) }
}

const HEX32 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{128}$/

/** Whether `e` is an event, its id its fields' and its signature its key's. */
export function verifyEvent(e: unknown): e is SignedEvent {
  if (typeof e !== 'object' || e === null) return false
  const v = e as Record<string, unknown>
  if (
    typeof v.id !== 'string' ||
    !HEX32.test(v.id) ||
    typeof v.pubkey !== 'string' ||
    !HEX32.test(v.pubkey)
  )
    return false
  if (typeof v.sig !== 'string' || !HEX64.test(v.sig)) return false
  if (
    typeof v.kind !== 'number' ||
    typeof v.created_at !== 'number' ||
    typeof v.content !== 'string'
  )
    return false
  if (
    !Array.isArray(v.tags) ||
    !v.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))
  )
    return false
  const event = e as SignedEvent
  if (eventId(event.pubkey, event) !== event.id) return false
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}
