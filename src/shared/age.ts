/**
 * maki's age key, as age writes it: the recipient (age's own X25519 kind, `age1…`) and the
 * identity that names age-plugin-maki (`AGE-PLUGIN-MAKI-1…`, the key's public half inside, nothing
 * secret). The key itself is maki's, in its Age app (the SDK's example `age`).
 */
import { bech32 } from '@scure/base'

/** Whether age-plugin-maki is where age looks for it. */
export interface AgePluginStatus {
  /** installed, and starting this copy of maki desktop */
  installed: boolean
  path: string
  /** whether its folder is on the PATH, where age looks */
  onPath: boolean
}

/** maki's Age app. */
export const AGE_APP = 'com.leviathan.maki.age'

const IDENTITY_HRP = 'age-plugin-maki-'

/** The identity naming maki's key, whose public half is `recipient`. */
export function identityOf(recipient: Uint8Array): string {
  return bech32.encode(IDENTITY_HRP, bech32.toWords(recipient), 200).toUpperCase()
}

/** An identity's public half, or null if it isn't one of maki's. */
export function publicOfIdentity(identity: string): Uint8Array | null {
  try {
    const { prefix, words } = bech32.decode(identity.toLowerCase() as `${string}1${string}`, 200)
    const key = bech32.fromWords(words)
    return prefix === IDENTITY_HRP && key.length === 32 ? Uint8Array.from(key) : null
  } catch {
    return null
  }
}

export function recipientOf(key: Uint8Array): string {
  return bech32.encode('age', bech32.toWords(key))
}

/** An identity file, as age-keygen writes one, for maki's key. */
export function identityFile(recipient: Uint8Array, now = new Date()): string {
  return (
    `# created: ${now.toISOString().replace(/\.\d+Z$/, 'Z')}\n` +
    `# recipient: ${recipientOf(recipient)}\n` +
    `# maki's Age app holds the key: decrypting asks maki first\n` +
    `${identityOf(recipient)}\n`
  )
}
