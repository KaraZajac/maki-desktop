/**
 * maki's Ethereum account for web pages: the EIP-1193 methods a site calls through the browser
 * extension's provider, answered here. Reads go to the network's JSON-RPC server; whatever
 * needs the account's key (connecting, signing) goes to maki, which shows the site and asks the
 * owner. A site sees the account only once the owner has connected it on maki.
 */

import type { ApprovalValue } from './protocol'
import { fromHex, quantity, toHex, toQuantity, unsignedEip1559 } from './rlp'

export interface EthNetwork {
  chainId: bigint
  name: string
  /** its coin */
  unit: string
  /** a public JSON-RPC server; it sees the account's address and this computer's IP */
  rpc: string
  /** others like it, tried in turn when it can't be reached */
  fallbacks: string[]
  /** where to read an address's activity or a transaction, on the web */
  explorer: string
  /** a network for testing, whose coin is worth nothing */
  test?: boolean
}

/**
 * The networks maki desktop knows, each with public servers to try in turn: when one can't be
 * reached (they come and go), the next.
 */
export const NETWORKS: EthNetwork[] = [
  {
    chainId: 1n,
    name: 'Ethereum',
    unit: 'ETH',
    rpc: 'https://ethereum-rpc.publicnode.com',
    fallbacks: ['https://eth.drpc.org'],
    explorer: 'https://etherscan.io'
  },
  {
    chainId: 8453n,
    name: 'Base',
    unit: 'ETH',
    rpc: 'https://mainnet.base.org',
    fallbacks: ['https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org'
  },
  {
    chainId: 10n,
    name: 'Optimism',
    unit: 'ETH',
    rpc: 'https://mainnet.optimism.io',
    fallbacks: ['https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io'
  },
  {
    chainId: 42161n,
    name: 'Arbitrum One',
    unit: 'ETH',
    rpc: 'https://arb1.arbitrum.io/rpc',
    fallbacks: ['https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io'
  },
  {
    chainId: 137n,
    name: 'Polygon',
    unit: 'POL',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    fallbacks: ['https://polygon.drpc.org'],
    explorer: 'https://polygonscan.com'
  },
  {
    chainId: 11155111n,
    name: 'Sepolia',
    unit: 'ETH',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    fallbacks: [],
    explorer: 'https://sepolia.etherscan.io',
    test: true
  }
]

/** An EIP-1193 error: the page's promise rejects with its code and message. */
export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** What maki desktop remembers: which sites are connected, and each site's network. */
export interface EthState {
  connected: Record<string, string>
  chains: Record<string, string>
}

export interface EthStore {
  load(): Promise<EthState>
  save(state: EthState): Promise<void>
}

export function memoryStore(): EthStore {
  let state: EthState = { connected: {}, chains: {} }
  return {
    load: async () => structuredClone(state),
    save: async (s) => void (state = structuredClone(s))
  }
}

/** A JSON-RPC call to a network: its result, or a thrown ProviderError. */
export type Rpc = (url: string, method: string, params: unknown[]) => Promise<unknown>

/** What of maki this needs: MakiClient's Ethereum calls. */
export interface EthSigner {
  ethAccount(site: string, index?: number): Promise<{ approval: ApprovalValue; address: string }>
  ethSignMessage(
    site: string,
    message: Uint8Array,
    index?: number
  ): Promise<{ approval: ApprovalValue; signature: Uint8Array }>
  ethSignTransaction(
    site: string,
    unsigned: Uint8Array,
    index?: number
  ): Promise<{ approval: ApprovalValue; reason: string; signed: Uint8Array | null }>
  ethSignTypedData(
    site: string,
    json: string,
    index?: number
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }>
}

/** Reads anyone may make: passed to the network as they are. */
const READS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'net_listening',
  'web3_clientVersion'
])

function refusal(approval: ApprovalValue, reason = ''): ProviderError {
  switch (approval) {
    case 'denied':
      return new ProviderError(4001, 'rejected on maki')
    case 'timed out':
      return new ProviderError(4001, 'nobody answered on maki in time')
    case 'locked':
      return new ProviderError(4100, 'maki is locked: enter its PIN')
    case 'no phrase':
      return new ProviderError(4100, 'maki has no recovery phrase yet')
    case 'refused':
      return new ProviderError(-32603, `maki won't sign it: ${reason}`)
    default:
      return new ProviderError(-32603, `maki: ${approval}`)
  }
}

/** A message as personal_sign passes it: hex bytes, or (some sites) plain text. */
function messageBytes(data: unknown): Uint8Array {
  if (typeof data !== 'string') throw new ProviderError(-32602, 'personal_sign takes a message')
  if (/^0x([0-9a-fA-F]{2})*$/.test(data)) return fromHex(data)
  return new TextEncoder().encode(data)
}

/**
 * Typed data as eth_signTypedData_v4 passes it: JSON text (most sites), or the object itself.
 * maki reads the JSON, strictly, and shows what it says; nothing here takes its word for it.
 */
function typedJson(data: unknown): string {
  if (typeof data === 'string') return data
  if (data !== null && typeof data === 'object') {
    try {
      return JSON.stringify(data)
    } catch {
      // falls through
    }
  }
  throw new ProviderError(-32602, 'eth_signTypedData_v4 takes typed data')
}

/** The chain typed data's domain names, if it names one maki desktop can read. */
function typedChain(json: string): bigint | null {
  let id: unknown
  try {
    id = (JSON.parse(json) as { domain?: { chainId?: unknown } }).domain?.chainId
  } catch {
    return null
  }
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return BigInt(id)
  if (typeof id === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(id)) return BigInt(id)
  return null
}

type TxRequest = {
  from?: unknown
  to?: unknown
  value?: unknown
  data?: unknown
  input?: unknown
  gas?: unknown
  gasPrice?: unknown
  maxFeePerGas?: unknown
  maxPriorityFeePerGas?: unknown
  chainId?: unknown
}

export class Ethereum {
  constructor(
    private signer: () => EthSigner | null,
    private rpc: Rpc,
    private store: EthStore,
    readonly networks: EthNetwork[] = NETWORKS
  ) {}

  private network(chainId: string): EthNetwork {
    const n = this.networks.find((n) => toQuantity(n.chainId) === chainId)
    if (!n) throw new ProviderError(4901, 'maki desktop has no server for that network')
    return n
  }

  private maki(): EthSigner {
    const m = this.signer()
    if (!m) throw new ProviderError(4900, 'maki is not linked: plug it in and open maki desktop')
    return m
  }

  /** The sites connected to the account, with each one's network, for the window to list. */
  async sites(): Promise<{ site: string; address: string; network: string }[]> {
    const state = await this.store.load()
    return Object.entries(state.connected)
      .map(([site, address]) => {
        const id = state.chains[site] ?? toQuantity(this.networks[0].chainId)
        const network =
          this.networks.find((n) => toQuantity(n.chainId) === id)?.name ?? `chain ${quantity(id)}`
        return { site, address, network }
      })
      .sort((a, b) => a.site.localeCompare(b.site))
  }

  /** Forget a site: it sees no account until the owner connects it again on maki. */
  async disconnect(site: string): Promise<void> {
    const state = await this.store.load()
    delete state.connected[site]
    await this.store.save(state)
  }

  /** One EIP-1193 request from `site`, as the browser reported it. */
  async request(site: string, method: string, params: unknown[] = []): Promise<unknown> {
    const state = await this.store.load()
    const address = state.connected[site] ?? null
    const chainId = state.chains[site] ?? toQuantity(this.networks[0].chainId)
    const ours = (from: unknown): void => {
      if (!address) throw new ProviderError(4100, 'connect this site to maki first')
      if (typeof from === 'string' && from.toLowerCase() !== address.toLowerCase()) {
        throw new ProviderError(4100, 'that is not the account connected to this site')
      }
    }
    switch (method) {
      case 'eth_chainId':
        return chainId
      case 'net_version':
        return quantity(chainId).toString()
      case 'eth_accounts':
        return address ? [address] : []
      case 'eth_requestAccounts':
      case 'wallet_requestPermissions': {
        if (!address) {
          const r = await this.maki().ethAccount(site)
          if (r.approval !== 'approved') throw refusal(r.approval)
          state.connected[site] = r.address
          await this.store.save(state)
        }
        const accounts = [state.connected[site]]
        return method === 'eth_requestAccounts' ? accounts : [{ parentCapability: 'eth_accounts' }]
      }
      case 'wallet_getPermissions':
        return address ? [{ parentCapability: 'eth_accounts' }] : []
      case 'wallet_revokePermissions':
        delete state.connected[site]
        await this.store.save(state)
        return null
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': {
        const wanted = (params[0] as { chainId?: unknown } | undefined)?.chainId
        let id: string
        try {
          id = toQuantity(quantity(wanted))
        } catch {
          throw new ProviderError(-32602, 'which network?')
        }
        if (!this.networks.some((n) => toQuantity(n.chainId) === id)) {
          throw new ProviderError(4902, 'maki desktop doesn’t know that network')
        }
        state.chains[site] = id
        await this.store.save(state)
        return null
      }
      case 'personal_sign': {
        ours(params[1])
        const r = await this.maki().ethSignMessage(site, messageBytes(params[0]))
        if (r.approval !== 'approved') throw refusal(r.approval)
        return toHex(r.signature)
      }
      case 'eth_sign':
        throw new ProviderError(
          4200,
          'eth_sign would sign anything, a transaction included: maki refuses it'
        )
      case 'eth_signTypedData_v4': {
        ours(params[0])
        const json = typedJson(params[1])
        // as MetaMask has it: signed for the network the site is on, or not at all
        const domainChain = typedChain(json)
        if (domainChain !== null && toQuantity(domainChain) !== chainId) {
          throw new ProviderError(
            -32602,
            `that typed data is for chain ${domainChain}, not the network this site is on`
          )
        }
        const r = await this.maki().ethSignTypedData(site, json)
        if (r.approval !== 'approved' || !r.signature) throw refusal(r.approval, r.reason)
        return toHex(r.signature)
      }
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
        throw new ProviderError(
          4200,
          'maki signs typed data (EIP-712) through eth_signTypedData_v4 only'
        )
      case 'eth_sendTransaction':
        return this.send(site, chainId, (params[0] ?? {}) as TxRequest, ours)
      default:
        if (READS.has(method)) return this.rpc(this.network(chainId).rpc, method, params)
        throw new ProviderError(4200, `maki doesn’t do ${method}`)
    }
  }

  /** Fill in what the site left out from the network, have maki sign it, and broadcast it. */
  private async send(
    site: string,
    chainId: string,
    tx: TxRequest,
    ours: (from: unknown) => void
  ): Promise<unknown> {
    ours(tx.from ?? null)
    const state = await this.store.load()
    const from = state.connected[site]
    if (tx.chainId !== undefined && toQuantity(quantity(tx.chainId)) !== chainId) {
      throw new ProviderError(4901, 'that transaction is for another network than this site is on')
    }
    const net = this.network(chainId)
    const rpc = (method: string, params: unknown[]): Promise<unknown> =>
      this.rpc(net.rpc, method, params)
    const to = tx.to === undefined || tx.to === null ? null : fromHex(String(tx.to))
    if (to && to.length !== 20) throw new ProviderError(-32602, 'to must be an address')
    const data = fromHex(String(tx.data ?? tx.input ?? '0x'))
    const value = tx.value === undefined ? 0n : quantity(tx.value)
    const call = {
      from,
      to: to ? toHex(to) : undefined,
      value: toQuantity(value),
      data: toHex(data)
    }
    const nonce = quantity(await rpc('eth_getTransactionCount', [from, 'pending']))
    // a little room over the estimate: state can move between estimating and mining
    const gasLimit =
      tx.gas !== undefined
        ? quantity(tx.gas)
        : (quantity(await rpc('eth_estimateGas', [call])) * 6n) / 5n
    let maxFeePerGas: bigint
    let maxPriorityFeePerGas: bigint
    if (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined) {
      maxFeePerGas = quantity(tx.maxFeePerGas)
      maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas)
    } else if (tx.gasPrice !== undefined) {
      maxFeePerGas = maxPriorityFeePerGas = quantity(tx.gasPrice)
    } else {
      const block = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
        baseFeePerGas?: unknown
      }
      maxPriorityFeePerGas = quantity(await rpc('eth_maxPriorityFeePerGas', []))
      // room for the base fee to double before the transaction is mined
      maxFeePerGas = quantity(block.baseFeePerGas ?? '0x0') * 2n + maxPriorityFeePerGas
    }
    const unsigned = unsignedEip1559({
      chainId: quantity(chainId),
      nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to,
      value,
      data,
      accessList: []
    })
    const r = await this.maki().ethSignTransaction(site, unsigned)
    if (r.approval !== 'approved' || !r.signed) throw refusal(r.approval, r.reason)
    return rpc('eth_sendRawTransaction', [toHex(r.signed)])
  }
}
