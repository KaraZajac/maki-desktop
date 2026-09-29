/**
 * maki's Sudo app and maki desktop's sudo plugin, as the window sees them (src/main/sudo.ts sets
 * the plugin up).
 */
import { toBase64 } from './bridge-types'

export const SUDO_APP = 'com.leviathan.maki.sudo'

export interface SudoStatus {
  /** why it can't be set up here, if it can't */
  unavailable: string | null
  /** sudo's version, as it says it */
  version: string | null
  /** sudo.conf loads the plugin */
  on: boolean
  /** whose commands wait for maki; null for everyone's */
  users: string[] | null
  /** the keys the plugin trusts, base64 */
  keys: string[]
  /** sudo started with it loaded, for this user */
  loads: boolean
  /** sudo won't start for this user, and why: the plugin can't, say */
  problem: string | null
}

/** The key maki's Sudo app answers `P` with, base64; null if that isn't one. */
export function keyOf(answer: Uint8Array): string | null {
  return answer.length === 33 && answer[0] === 0 ? toBase64(answer.subarray(1)) : null
}

/** A key as maki's Sudo app shows it, from its menu: four lines of hex. */
export function keyLines(key: string): string[] {
  const hex = [...atob(key)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return [0, 1, 2, 3].map((i) => hex.slice(i * 16, i * 16 + 16))
}
