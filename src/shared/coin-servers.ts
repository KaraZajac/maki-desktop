/**
 * The servers maki desktop's account wallets ask (Tron's, XRP's, Stellar's and the others'): for
 * each coin, on its own network and its test network, the addresses tried in turn, and the requests
 * its wallet makes, which are the only ones the main process passes on. Each server sees the
 * account's address and this computer's IP address; none sees a key.
 *
 * No Node or DOM imports: the main process checks requests against it; the wallets name it.
 */

/** maki's account wallets, by the coin's name. */
export type CoinId = 'tron' | 'xrp' | 'stellar' | 'cosmos' | 'near' | 'sui' | 'aptos' | 'cardano'

export interface CoinServers {
  /** base addresses, tried in turn: the coin's own network's, then its test network's */
  main: string[]
  test: string[]
  /** what a GET may ask, after the base */
  get: RegExp
  /** what a POST may send to, after the base */
  post: RegExp
  /** the most requests a second (the servers' own limits, with room) */
  perSecond: number
}

/** Each coin's servers; a coin's entry comes with its wallet. */
export const COIN_SERVERS: Partial<Record<CoinId, CoinServers>> = {
  // rippled's JSON-RPC, all at the root: the community's cluster first, then Ripple's own
  xrp: {
    main: ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234'],
    test: ['https://s.altnet.rippletest.net:51234'],
    get: /$^/,
    post: /^\/$/,
    perSecond: 4
  }
}

/** What the main process answers a wallet's request with: the server's status and its body. */
export type CoinResponse = { status: number; text: string } | { error: string }

/** A wallet's way to its coin's servers (the main process's `coin:fetch`). */
export type CoinFetch = (
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: string
) => Promise<{ status: number; text: string }>

/** Whether a request is one the coin's wallet makes. */
export function allowed(servers: CoinServers, method: string, path: string): boolean {
  return (method === 'GET' ? servers.get : method === 'POST' ? servers.post : /$^/).test(path)
}

/** What maki desktop keeps of an account maki shared: which, and its key and address. */
export interface SharedAccount {
  network: 0 | 1
  index: number
  address: string
  /** hex */
  publicKey: string
}
