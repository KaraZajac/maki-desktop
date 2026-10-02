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
import { fromHex, quantity, toHex, toQuantity, unsignedEip1559 } from './rlp'
import { tokensOn, type Token } from './tokens'

export { WALLET_SITE }

/** A transaction's gas limit and fees, in wei. */
export interface Fees {
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

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

/** A number, as a 32-byte ABI word (hex, no 0x). */
const uintWord = (n: bigint): string => n.toString(16).padStart(64, '0')

/** The OP Stack's fee oracle, the same address on each of its chains (Mantle's too). */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F'
const GET_L1_FEE = '0x49948e0e' // getL1Fee(bytes)
const GET_OPERATOR_FEE = '0x275aedd2' // getOperatorFee(uint256), from the OP Stack's Isthmus
const TOKEN_RATIO = '0x06f837d3' // tokenRatio(), Mantle's: MNT to the ether

/** A uint256 an eth_call answered, or an error saying the oracle didn't say `what`. */
function oracleWord(r: unknown, what: string): bigint {
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r))
    throw new Error(`the network’s fee oracle didn’t say ${what}`)
  return BigInt(r)
}

/**
 * What a network that charges fees outside the gas would charge for `unsigned` that way, as its
 * fee oracle prices it now: the L1 data fee (Mantle's priced in ether, and charged in MNT at its
 * token ratio) and the operator fee for `gas`, which a chain from before the OP Stack's Isthmus
 * hasn't (its oracle says so by refusing the call).
 */
async function feesOutsideGas(
  network: EthNetwork,
  call: (method: string, params: unknown[]) => Promise<unknown>,
  unsigned: Uint8Array,
  gas: bigint
): Promise<bigint> {
  const ask = (data: string): Promise<unknown> =>
    call('eth_call', [{ to: GAS_PRICE_ORACLE, data }, 'latest'])
  const bytes = toHex(unsigned).slice(2)
  const l1 = oracleWord(
    await ask(
      GET_L1_FEE +
        uintWord(32n) +
        uintWord(BigInt(unsigned.length)) +
        bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
    ),
    'its L1 fee'
  )
  const ratio =
    network.feesOutsideGas === 'mantle' ? oracleWord(await ask(TOKEN_RATIO), 'its token ratio') : 1n
  let operator = 0n
  try {
    operator = oracleWord(await ask(GET_OPERATOR_FEE + uintWord(gas)), 'its operator fee')
  } catch {
    // none
  }
  return l1 * ratio + operator
}

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

/** ENS's registry, the same address on Ethereum and its test networks. */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const RESOLVER = '0x0178b8bf' // resolver(bytes32)
const ADDR = '0x3b3b57de' // addr(bytes32)

/**
 * Whether `s` looks like an ENS name maki desktop resolves: labels of lower-case letters, digits
 * and hyphens, ending .eth. (Names with other characters need ENSIP-15's normalization, which this
 * doesn't do, so they aren't taken rather than being resolved wrong.)
 */
export const isEnsName = (s: string): boolean => /^([a-z0-9-]+\.)+eth$/.test(s)

/** EIP-137's namehash: the name's node in ENS, as hex. */
export function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32)
  if (name) {
    for (const label of name.split('.').reverse()) {
      const joined = new Uint8Array(64)
      joined.set(node)
      joined.set(keccak_256(new TextEncoder().encode(label)), 32)
      node = keccak_256(joined)
    }
  }
  return '0x' + Array.from(node, (b) => b.toString(16).padStart(2, '0')).join('')
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

  /**
   * What the account holds on each network: its coin, and the known tokens it has any of (but the
   * coin's own ERC-20, Arc's USDC, which is the coin's balance again).
   */
  holdings(address: string): Promise<NetworkHoldings[]> {
    return Promise.all(
      this.networks.map(async (network): Promise<NetworkHoldings> => {
        const call = (method: string, params: unknown[]): Promise<unknown> =>
          this.rpc(network.rpc, method, params)
        const coinContract = network.coinContract?.toLowerCase()
        try {
          const coin = quantity(await call('eth_getBalance', [address, 'latest']))
          const tokens = await Promise.all(
            tokensOn(network.chainId)
              .filter((token) => token.contract.toLowerCase() !== coinContract)
              .map(async (token) => {
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
   * The address an ENS name points to (its `addr` record, on Ethereum), or null if it points
   * nowhere. Resolved here: maki shows the address, which it can't tie to the name itself.
   */
  async resolve(name: string): Promise<string | null> {
    if (!isEnsName(name)) throw new Error('that isn’t a name maki desktop can look up')
    const node = namehash(name).slice(2)
    const call = async (to: string, data: string): Promise<string> => {
      const r = await this.rpc(this.networks[0].rpc, 'eth_call', [{ to, data }, 'latest'])
      return typeof r === 'string' && /^0x([0-9a-fA-F]{64})*$/.test(r) ? r : '0x'
    }
    const resolver = await call(ENS_REGISTRY, RESOLVER + node)
    if (resolver.length < 66 || /^0x0{64}$/.test(resolver)) return null
    const answer = await call('0x' + resolver.slice(26, 66), ADDR + node)
    if (answer.length < 66 || /^0x0{64}$/.test(answer)) return null
    return checksummed('0x' + answer.slice(26, 66))
  }

  /**
   * The most of the network's coin the account can send to `to`, and the fees that leaves room
   * for: what it holds, less the gas it might use at the most it might cost (the base fee
   * doubling, as the provider allows), and on a network that charges fees outside the gas, less
   * twice what its fee oracle prices those at now. Send it with those fees, or it may not cover
   * them.
   */
  async most(network: EthNetwork, to: string): Promise<{ amount: bigint; fees: Fees }> {
    const from = await this.account()
    if (!from) throw new Error('connect maki desktop to the account first')
    const call = (method: string, params: unknown[]): Promise<unknown> =>
      this.rpc(network.rpc, method, params)
    const balance = quantity(await call('eth_getBalance', [from, 'latest']))
    // the same room over the estimate the provider leaves
    const gas = (quantity(await call('eth_estimateGas', [{ from, to, value: '0x0' }])) * 6n) / 5n
    const block = (await call('eth_getBlockByNumber', ['latest', false])) as {
      baseFeePerGas?: unknown
    }
    const maxPriorityFeePerGas = quantity(await call('eth_maxPriorityFeePerGas', []))
    const maxFeePerGas = quantity(block.baseFeePerGas ?? '0x0') * 2n + maxPriorityFeePerGas
    let outside = 0n
    if (network.feesOutsideGas) {
      // priced for a transaction as long as this one can be: all it holds, and a nonce as long
      // as any the account will have
      const unsigned = unsignedEip1559({
        chainId: network.chainId,
        nonce: 0xffffffffn,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit: gas,
        to: fromHex(to),
        value: balance,
        data: new Uint8Array(),
        accessList: []
      })
      outside = 2n * (await feesOutsideGas(network, call, unsigned, gas))
    }
    const amount = balance - gas * maxFeePerGas - outside
    if (amount <= 0n)
      throw new Error(`the account doesn’t hold enough ${network.unit} to pay the fee`)
    return { amount, fees: { gas, maxFeePerGas, maxPriorityFeePerGas } }
  }

  /**
   * Send `amount` (in its smallest units) of the network's coin, or of a token, to `to`: maki
   * shows it and signs it, and the network gets it. The transaction's hash.
   */
  async send(
    network: EthNetwork,
    to: string,
    amount: bigint,
    token: Token | null,
    fees?: Fees
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
    const tx = {
      ...(token
        ? { from, to: token.contract, value: '0x0', data: transferData(to, amount) }
        : { from, to, value: toQuantity(amount) }),
      // fees fixed beforehand (all of a coin), rather than the provider's own
      ...(fees && {
        gas: toQuantity(fees.gas),
        maxFeePerGas: toQuantity(fees.maxFeePerGas),
        maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas)
      })
    }
    return (await this.eth.request(WALLET_SITE, 'eth_sendTransaction', [tx])) as string
  }
}
