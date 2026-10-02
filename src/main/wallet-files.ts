/**
 * What maki desktop keeps of each of maki's wallets, in files of its own in its folder
 * (shared/wallets.ts names them). The window says which wallet maki has, as its link hears it; the
 * files read and written are that wallet's.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ANOTHER_WALLET,
  btcFile,
  isWalletId,
  walletFileName,
  type WalletFile,
  type WalletId
} from '../shared/wallets'
import { writeAtomic } from './atomic'

/**
 * The wallet in use, and its files. The window switches it the moment its link hears maki has
 * another wallet, before anything is read for the new one; what's kept names the wallet it was read
 * or asked for under, and is turned down unless that's still the one in use, so a save under way as
 * maki switches can't land in the other wallet's files.
 */
export class WalletFiles {
  private wallet: WalletId = null

  /** `dir`: the folder the files are in (maki desktop's own). */
  constructor(private dir: () => string) {}

  /** The wallet in use: the phrase's own until the window says otherwise. */
  get inUse(): WalletId {
    return this.wallet
  }

  /** Switches to `wallet`: a passphrase wallet's fingerprint, or null for the phrase's own. */
  use(wallet: unknown): void {
    if (!isWalletId(wallet)) throw new Error('which wallet?')
    this.wallet = wallet
  }

  /** Where the wallet in use keeps `file`. */
  path(file: WalletFile): string {
    return join(this.dir(), walletFileName(file, this.wallet))
  }

  /**
   * Why what's kept for `wallet` can't be, or null if it can: only while it's the wallet in use.
   */
  refuses(wallet: unknown): string | null {
    return isWalletId(wallet) && wallet === this.wallet ? null : ANOTHER_WALLET
  }
}

/** A descriptor as maki's apps give them: text, and not long. */
const isDescriptor = (d: unknown): d is string => typeof d === 'string' && d.length < 300

/** The descriptors of `chain`'s accounts that maki shared, kept for the wallet in use. */
export async function loadDescriptors(files: WalletFiles, chain: unknown): Promise<string[]> {
  const path = files.path(btcFile(chain))
  try {
    const kept = JSON.parse(await readFile(path, 'utf8')) as { descriptors?: unknown }
    return Array.isArray(kept.descriptors) ? kept.descriptors.filter(isDescriptor) : []
  } catch {
    return []
  }
}

/**
 * Keeps `descriptors` as `chain`'s, for `wallet` (at most eight): in its own file, leaving the other
 * chains' as they are. Null once kept, or why it wasn't (`wallet` isn't the one in use).
 */
export async function saveDescriptors(
  files: WalletFiles,
  chain: unknown,
  descriptors: unknown,
  wallet: unknown
): Promise<string | null> {
  const file = btcFile(chain)
  const refused = files.refuses(wallet)
  if (refused) return refused
  const list = Array.isArray(descriptors) ? descriptors.filter(isDescriptor) : []
  await writeAtomic(files.path(file), JSON.stringify({ descriptors: list.slice(0, 8) }))
  return null
}
