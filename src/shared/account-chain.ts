/**
 * What maki desktop's wallet for a chain of accounts (Tron, XRP, Stellar and the others) needs from
 * the chain's own code: how to read what an account holds and has done, how to make a payment for
 * maki's app to sign, and how to send it once signed. The card (`AccountWallet.tsx`) is the same for
 * each; maki's app for the chain reads and shows every payment itself before it signs, so nothing
 * here is trusted to say what a payment does.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import type { CoinFetch, CoinId, SharedAccount } from './coin-servers'

/** A token an account holds besides the chain's coin, as the chain names it. */
export interface ChainToken {
  /** what identifies it on the chain: a contract's address, an asset's code and issuer */
  id: string
  /** what maki desktop (and maki's app) calls it; null for one they don't know */
  symbol: string | null
  decimals: number
  /** what to call one without a symbol, if better than its ID: its code and its issuer */
  label?: string
}

export interface Holding {
  /** null for the chain's own coin */
  token: ChainToken | null
  amount: bigint
}

/** A transaction that touched the account. */
export interface Activity {
  id: string
  /** what it did, in a word: "Received", "Sent" */
  kind: string
  /** what came in (positive) or went out, in the token's smallest units; null if it can't be said */
  amount: bigint | null
  token: ChainToken | null
  /** unix seconds; null while it waits */
  time: number | null
  /** the other side, when there's one */
  counterparty?: string
  failed?: boolean
}

export interface ChainState {
  /** the coin first, then its tokens */
  holdings: Holding[]
  activity: Activity[]
  /** the coin the account must keep and can't send (XRP's and Stellar's reserves) */
  reserved: bigint
  /** whether the chain has the account yet: some need a first payment to make one */
  exists: boolean
  /** anything the owner should know about the account */
  notes: string[]
}

/** A payment made ready: what maki is asked to sign, and what it costs. */
export interface Payment {
  /** the coin's own bytes, unsigned, as maki's app takes them (its `T` message) */
  payload: Uint8Array
  /** the fee in the coin's smallest units, and whether that's the most it can be */
  fee: bigint
  feeIsMost: boolean
  /** anything to say before it's sent (that it opens the recipient's account, say) */
  notes: string[]
  /** whatever sending it needs besides maki's signature */
  carry?: unknown
}

export interface AccountChain {
  id: CoinId
  name: string
  /** maki's app for it */
  app: string
  glyph: string
  /** the colour its mark takes on the card */
  tint: string
  /** the coin's symbol on its own network and on its test network */
  units: [string, string]
  decimals: number
  /** the symbol its price is kept under (prices.ts) */
  priced: string
  networks: [string, string]
  /** what an address looks like, as a hint where one goes */
  hint: string
  /** a payment's other field, where the chain has one people need (XRP's destination tag) */
  memo: { label: string; placeholder: string; numeric: boolean } | null
  /** the wallets whose account this is: "the account Lobstr and Freighter make" */
  wallets: string
  /** where balances come from, and who sees what */
  servers: string
  explorerName: string
  explorer(network: 0 | 1, kind: 'tx' | 'address', id: string): string
  /** what a payment request's QR code says, for an address */
  uri(address: string): string
  /** whether `address` is one of the chain's on `network` */
  valid(address: string, network: 0 | 1): boolean
  look(fetch: CoinFetch, account: SharedAccount): Promise<ChainState>
  pay(
    fetch: CoinFetch,
    account: SharedAccount,
    state: ChainState,
    to: string,
    amount: bigint,
    token: ChainToken | null,
    memo: string
  ): Promise<Payment>
  /** the payment, signed by maki, sent to the network: its transaction's ID */
  submit(
    fetch: CoinFetch,
    account: SharedAccount,
    payment: Payment,
    signature: Uint8Array
  ): Promise<string>
}
