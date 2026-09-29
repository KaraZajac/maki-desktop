/**
 * Bitcoin multisig with maki as one of the keys: maki's key for a wallet, as its Bitcoin app
 * shares it and coordinators (Sparrow, Nunchuk, Specter, Bitcoin Core) take a cosigner's, and the
 * wallets maki has added. The wallet itself (its descriptor, or Coldcard's multisig file, as
 * Sparrow exports it) goes to maki, which shows its owner every key before adding it; maki signs
 * what spends from it only after that.
 */

/** maki's key for multisig wallets: `[73c5da0a/48h/0h/0h/2h]Zpub…`, in parts. */
export interface CosignerKey {
  /** the master key's fingerprint, 8 hex digits in capitals, as coordinators show it */
  fingerprint: string
  /** BIP48's P2WSH path, as `m/48'/0'/0'/2'` */
  path: string
  /** the account key: a Zpub (Vpub on the test networks) */
  key: string
}

export function parseCosigner(text: string): CosignerKey | null {
  const m = /^\[([0-9a-f]{8})((?:\/\d+h)+)\]([1-9A-HJ-NP-Za-km-z]{100,120})$/.exec(text.trim())
  if (!m) return null
  return { fingerprint: m[1].toUpperCase(), path: 'm' + m[2].replace(/h/g, "'"), key: m[3] }
}

/**
 * The file Coldcard exports a cosigner's key in (`ccxp-FINGERPRINT.json`), which Sparrow takes for
 * a multisig wallet's keystore (Airgapped Hardware Wallet, Coldcard, Import File).
 */
export function coldcardFile(k: CosignerKey): { name: string; text: string } {
  const text =
    JSON.stringify({ p2wsh_deriv: k.path, p2wsh: k.key, xfp: k.fingerprint }, null, 2) + '\n'
  return { name: `ccxp-${k.fingerprint}.json`, text }
}

/** A multisig wallet maki's Bitcoin app has added. */
export interface MultisigWallet {
  /** its descriptor's SHA-256, the first 4 bytes, in hex: how maki knows it */
  id: string
  /** 0 bitcoin, 1 the test networks */
  network: number
  threshold: number
  keys: number
  name: string
}

/** What maki's Bitcoin app takes as a wallet: a descriptor, or Coldcard's multisig file. */
export function looksLikeWallet(text: string): boolean {
  const t = text.trim()
  return /^(wsh|sh)\(/.test(t) || (/^\s*Policy:/im.test(t) && /^\s*Format:/im.test(t))
}
