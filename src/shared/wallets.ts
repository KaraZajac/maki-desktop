/**
 * Which of maki's wallets maki desktop keeps things for, and the files each one's go in.
 *
 * maki's wallet apps answer for the wallet maki has open (PROTOCOL.md, "Wallets"): the recovery
 * phrase's own, or a passphrase wallet, one its owner opened on maki with a BIP39 passphrase typed
 * there. What they shared (accounts, descriptors, Monero's view key) and which sites were given
 * which account are kept by wallet, so a passphrase wallet's never mix with the phrase's own, and
 * no site connected under one wallet is handed the other's account without being connected again
 * (which would tell it both are one person's). The phrase's own wallet keeps the files it always
 * had; a passphrase wallet has files of its own, named by its fingerprint.
 *
 * No Node or DOM imports here: the main process, the renderer and tests use it.
 */
import { NETWORKS_OF, type BtcChain } from './btc-wallet'

/**
 * A wallet maki desktop keeps things for: a passphrase wallet, by its master key's fingerprint
 * (eight lowercase hex digits, as wallets write it), or null for the recovery phrase's own.
 */
export type WalletId = string | null

/** Whether `v` names a wallet: null, or eight lowercase hex digits. */
export function isWalletId(v: unknown): v is WalletId {
  return v === null || (typeof v === 'string' && /^[0-9a-f]{8}$/.test(v))
}

/**
 * Why something meant for one wallet wasn't kept, or asked of maki: maki has another open now (the
 * owner opened a passphrase wallet on maki, or went back to the phrase's own).
 */
export const ANOTHER_WALLET = 'maki has another wallet open now'

/**
 * The files each wallet has of its own: the accounts maki's apps shared by coin, the sites connected
 * to its Ethereum and Solana accounts, its Monero view key and wallet, and each chain of Bitcoin's
 * kind's descriptors.
 */
export type WalletFile = 'accounts' | 'ethereum' | 'solana' | 'monero' | BtcChain

/**
 * The name of `file` for `wallet`: `accounts.json` for the phrase's own wallet, as it always was;
 * `accounts.wallet-1a2b3c4d.json` for passphrase wallet 1a2b3c4d.
 */
export function walletFileName(file: WalletFile, wallet: WalletId): string {
  if (!isWalletId(wallet)) throw new Error('which wallet?')
  return wallet === null ? `${file}.json` : `${file}.wallet-${wallet}.json`
}

/**
 * The file a chain of Bitcoin's kind keeps its descriptors in: one of its own, by its name
 * (bitcoin, litecoin, dogecoin, bitcoincash), since a test network's descriptor (coin type 1) is
 * every chain's. Anything else is refused.
 */
export function btcFile(chain: unknown): BtcChain {
  if (typeof chain !== 'string' || !Object.hasOwn(NETWORKS_OF, chain))
    throw new Error('which chain?')
  return chain as BtcChain
}
