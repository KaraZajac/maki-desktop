/**
 * What maki desktop keeps of the Monero wallet between runs (monero.json, readable by this user
 * alone): for each network, the address and view key maki shared once its owner let this computer
 * watch. Never a spend key: maki has that.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import type { ViewWallet } from './cold'
import type { WalletState } from './wallet'
import { decodeAddress, leNumber, mulBase, type Network, equal } from './xmr'

export interface Watched {
  address: string
  /** the secret view key, hex */
  view: string
}

export interface KeptMonero {
  watched: Partial<Record<Network, Watched>>
  /** maki desktop's own wallet, per network */
  wallets: Partial<Record<Network, WalletState>>
}

export const NETWORK_NAMES: Record<Network, string> = {
  mainnet: 'Monero',
  testnet: 'testnet',
  stagenet: 'stagenet'
}

/** What was kept, if it's what maki desktop keeps; else nothing. */
export function readKept(v: unknown): KeptMonero {
  const out: KeptMonero = { watched: {}, wallets: {} }
  const o = v as { watched?: Record<string, unknown>; wallets?: Record<string, unknown> } | null
  if (!o || typeof o !== 'object' || !o.watched || typeof o.watched !== 'object') return out
  for (const network of ['mainnet', 'testnet', 'stagenet'] as Network[]) {
    const w = o.watched[network] as Watched | undefined
    if (
      w &&
      typeof w.address === 'string' &&
      typeof w.view === 'string' &&
      viewWallet(w, network)
    ) {
      out.watched[network] = { address: w.address, view: w.view }
      const state = o.wallets?.[network] as WalletState | undefined
      if (walletState(state)) out.wallets[network] = state
    }
  }
  return out
}

/** Whether a kept wallet is one maki desktop kept (its shape: what's in it, it made). */
function walletState(s: WalletState | undefined): s is WalletState {
  return (
    !!s &&
    typeof s.node === 'string' &&
    Number.isInteger(s.restoreHeight) &&
    Number.isInteger(s.scanned) &&
    Array.isArray(s.ids) &&
    Array.isArray(s.outputs) &&
    Array.isArray(s.sent) &&
    Number.isInteger(s.receiveIndex)
  )
}

/** The wallet a kept address and view key are, checked: the view key must be the address's. */
export function viewWallet(w: Watched, network: Network): ViewWallet | null {
  const a = decodeAddress(w.address)
  if (!a || a.network !== network || a.kind !== 'standard' || !/^[0-9a-f]{64}$/.test(w.view))
    return null
  const view = leNumber(hex.decode(w.view))
  if (!equal(mulBase(view).toBytes(), a.view)) return null
  return { network, spend: a.spend, view }
}
