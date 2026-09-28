/**
 * maki's Ethereum account as a wallet in maki desktop: what it holds on each network maki desktop
 * knows (the coin, and the tokens maki knows by their contracts), and sending from it.
 *
 * maki desktop uses the account as a site of its own, desktop.maki, which the owner connects on
 * maki like any other: every send goes through the same provider a site's does, and maki shows it
 * (token amounts spelled out) and signs it there. The balances come from the networks' public
 * servers, which see the account's address and this computer's IP address.
 */
import { keccak_256 } from '@noble/hashes/sha3.js'
import { WALLET_SITE } from './bridge-types'
import { NETWORKS, type EthNetwork, type Ethereum, type Rpc } from './ethereum'
import { quantity, toQuantity } from './rlp'
import { tokensOn, type Token } from './tokens'

export { WALLET_SITE }

/** So much of a network's coin (`token` null) or of a token. */
export interface Holding {
  token: Token | null
  amount: bigint
}

export interface NetworkHoldings {
  network: EthNetwork
  holdings: Holding[]
  /** why it couldn't be read, if it couldn't */
  problem: string | null
}

const BALANCE_OF = '0x70a08231'
const TRANSFER = 'a9059cbb'

/** A 20-byte address, as a 32-byte ABI word (hex, no 0x). */
const addressWord = (address: string): string => address.slice(2).toLowerCase().padStart(64, '0')

/** Calldata for an ERC-20 transfer of `amount` to `to`. */
export function transferData(to: string, amount: bigint): string {
  return `0x${TRANSFER}${addressWord(to)}${amount.toString(16).padStart(64, '0')}`
}

/** An address with EIP-55's capitals, which say whether a letter of it has been changed. */
export function checksummed(address: string): string {
  const lower = address.slice(2).toLowerCase()
  const hash = keccak_256(new TextEncoder().encode(lower))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i]
  }
  return out
}

/** Whether `s` is an address: 40 hex digits after 0x, and if it has capitals, the right ones. */
export function isAddress(s: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false
  const body = s.slice(2)
  return body === body.toLowerCase() || body === body.toUpperCase() || checksummed(s) === s
}

export class EthWallet {
  constructor(
    private eth: Ethereum,
    private rpc: Rpc,
    readonly networks: EthNetwork[] = NETWORKS
  ) {}

  /** The account, if the owner has connected maki desktop to it. */
  async account(): Promise<string | null> {
    return (await this.eth.sites()).find((s) => s.site === WALLET_SITE)?.address ?? null
  }

  /** maki asks its owner to let maki desktop see the account; its address. */
  async connect(): Promise<string> {
    const [address] = (await this.eth.request(WALLET_SITE, 'eth_requestAccounts')) as string[]
    return address
  }

  /** Forget the account: maki asks again next time. */
  disconnect(): Promise<void> {
    return this.eth.disconnect(WALLET_SITE)
  }

  /** What the account holds on each network: its coin, and the known tokens it has any of. */
  holdings(address: string): Promise<NetworkHoldings[]> {
    return Promise.all(
      this.networks.map(async (network): Promise<NetworkHoldings> => {
        const call = (method: string, params: unknown[]): Promise<unknown> =>
          this.rpc(network.rpc, method, params)
        try {
          const coin = quantity(await call('eth_getBalance', [address, 'latest']))
          const tokens = await Promise.all(
            tokensOn(network.chainId).map(async (token) => {
              const r = await call('eth_call', [
                { to: token.contract, data: BALANCE_OF + addressWord(address) },
                'latest'
              ])
              return {
                token,
                amount: typeof r === 'string' && /^0x[0-9a-fA-F]+$/.test(r) ? BigInt(r) : 0n
              }
            })
          )
          return {
            network,
            holdings: [{ token: null, amount: coin }, ...tokens.filter((t) => t.amount > 0n)],
            problem: null
          }
        } catch (e) {
          return { network, holdings: [], problem: (e as Error).message }
        }
      })
    )
  }

  /**
   * Send `amount` (in its smallest units) of the network's coin, or of a token, to `to`: maki
   * shows it and signs it, and the network gets it. The transaction's hash.
   */
  async send(
    network: EthNetwork,
    to: string,
    amount: bigint,
    token: Token | null
  ): Promise<string> {
    const from = await this.account()
    if (!from) throw new Error('connect maki desktop to the account first')
    if (!isAddress(to)) throw new Error('that isn’t an address, or a letter of it is wrong')
    if (amount <= 0n) throw new Error('send more than nothing')
    if (token && token.chainId !== network.chainId)
      throw new Error(`${token.symbol} isn’t on ${network.name}`)
    await this.eth.request(WALLET_SITE, 'wallet_switchEthereumChain', [
      { chainId: toQuantity(network.chainId) }
    ])
    const tx = token
      ? { from, to: token.contract, value: '0x0', data: transferData(to, amount) }
      : { from, to, value: toQuantity(amount) }
    return (await this.eth.request(WALLET_SITE, 'eth_sendTransaction', [tx])) as string
  }
}
