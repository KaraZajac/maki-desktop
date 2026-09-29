/**
 * maki's Solana account as a wallet in maki desktop: what it holds on each network maki desktop
 * knows (SOL, and its tokens), and sending from it: SOL, or a token to its recipient's own
 * account for it (opened in the same transaction if it isn't yet), with a priority fee from what
 * the network has been charging.
 *
 * maki desktop uses the account as a site of its own, desktop.maki, which the owner connects on
 * maki like any other: every send goes through the same wallet a site's does, and maki's Solana
 * app shows it (the token, the amount, whose account it goes to, the most the fee can be) and
 * signs it there. Balances come from the networks' public servers, which see the account's
 * address and this computer's IP address.
 */
import { WALLET_SITE } from './bridge-types'
import { fromBase64, toBase64 } from './bridge-types'
import { ProviderError } from './ethereum'
import {
  associatedTokenAccount,
  compileMessage,
  computeUnitLimit,
  computeUnitPrice,
  createAssociatedTokenAccountIdempotent,
  type Instruction,
  isAddress,
  type SolNetwork,
  type SolRpc,
  type Solana,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  transactionOf,
  transfer,
  transferChecked
} from './solana'

export { WALLET_SITE }

export interface SolToken {
  mint: string
  /** what maki desktop (and maki's Solana app) calls it; null for one they don't know */
  symbol: string | null
  decimals: number
  /** the token program its mint belongs to: Token's, or Token-2022's */
  program: string
}

/** Tokens known by their mint, as maki's Solana app knows them (maki-sol's `tokens`). */
export const SOL_TOKENS: Record<string, Omit<SolToken, 'program'>[]> = {
  'solana:mainnet': [
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
    { mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD', decimals: 6 }
  ],
  'solana:devnet': [
    { mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', symbol: 'USDC', decimals: 6 }
  ]
}

/** So much SOL (`token` null) or of a token. */
export interface SolHolding {
  token: SolToken | null
  amount: bigint
}

export interface SolNetworkHoldings {
  network: SolNetwork
  holdings: SolHolding[]
  /** why it couldn't be read, if it couldn't */
  problem: string | null
}

/** What a send costs in compute units, at most; sized for each send by simulating it. */
const MOST_UNITS = 200_000
/** Room over what the simulation used: the chain can move between simulating and landing. */
const ROOM = 1.2

type TokenAccounts = {
  value?: {
    account?: {
      data?: {
        parsed?: {
          info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } }
        }
      }
    }
  }[]
}

export class SolWallet {
  constructor(
    private solana: Solana,
    private rpc: SolRpc
  ) {}

  /** Connects maki desktop to the account on maki (the owner says yes there): its address. */
  async connect(): Promise<string> {
    const r = (await this.solana.request(WALLET_SITE, 'connect', [{}])) as { accounts: string[] }
    return r.accounts[0]
  }

  async disconnect(): Promise<void> {
    await this.solana.disconnect(WALLET_SITE)
  }

  /** The account maki desktop is connected to, if it is. */
  async address(): Promise<string | null> {
    return (await this.solana.sites()).find((s) => s.site === WALLET_SITE)?.address ?? null
  }

  private call(network: SolNetwork, method: string, params: unknown[]): Promise<unknown> {
    return this.rpc(network.rpc, method, params)
  }

  /** What `address` holds on `network`: SOL, then its tokens (any it holds, known or not). */
  async holdingsOn(network: SolNetwork, address: string): Promise<SolHolding[]> {
    const balance = (await this.call(network, 'getBalance', [
      address,
      { commitment: 'confirmed' }
    ])) as { value?: unknown }
    if (typeof balance?.value !== 'number') throw new Error('the network didn’t say')
    const out: SolHolding[] = [{ token: null, amount: BigInt(balance.value) }]
    const known = SOL_TOKENS[network.chain] ?? []
    const tokens = new Map<string, SolHolding>()
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = (await this.call(network, 'getTokenAccountsByOwner', [
        address,
        { programId: program },
        { encoding: 'jsonParsed', commitment: 'confirmed' }
      ])) as TokenAccounts
      for (const a of r?.value ?? []) {
        const info = a.account?.data?.parsed?.info
        const mint = info?.mint
        const amount = info?.tokenAmount?.amount
        const decimals = info?.tokenAmount?.decimals
        if (
          typeof mint !== 'string' ||
          typeof amount !== 'string' ||
          !/^\d+$/.test(amount) ||
          typeof decimals !== 'number'
        )
          continue
        const k = known.find((t) => t.mint === mint)
        const held = tokens.get(mint)
        // a token's accounts together: its associated one, and any others
        if (held) held.amount += BigInt(amount)
        else
          tokens.set(mint, {
            token: { mint, symbol: k?.symbol ?? null, decimals: k?.decimals ?? decimals, program },
            amount: BigInt(amount)
          })
      }
    }
    out.push(
      ...[...tokens.values()].sort((a, b) =>
        (a.token!.symbol ?? '~').localeCompare(b.token!.symbol ?? '~')
      )
    )
    return out
  }

  /** What the account holds on each network: each asked in turn, and one that can't be reached says why. */
  async holdings(address: string): Promise<SolNetworkHoldings[]> {
    return Promise.all(
      this.solana.networks.map(async (network) => {
        try {
          return { network, holdings: await this.holdingsOn(network, address), problem: null }
        } catch (e) {
          return { network, holdings: [], problem: (e as Error).message }
        }
      })
    )
  }

  /** A compute unit's price for now, in microlamports: what most recent transactions paid. */
  async priority(network: SolNetwork, accounts: string[]): Promise<bigint> {
    try {
      const fees = (await this.call(network, 'getRecentPrioritizationFees', [accounts])) as {
        prioritizationFee?: unknown
      }[]
      const paid = fees
        .map((f) => f.prioritizationFee)
        .filter((f): f is number => typeof f === 'number' && f > 0)
        .sort((a, b) => a - b)
      // three quarters of the way up, and no more than a lamport a unit
      const p = paid.length ? paid[Math.floor(paid.length * 0.75)] : 0
      return BigInt(Math.min(Math.max(p, 1_000), 1_000_000))
    } catch {
      return 1_000n
    }
  }

  /** The instructions that pay `amount` of `token` (or SOL) to `to`. */
  private async payment(
    network: SolNetwork,
    from: string,
    to: string,
    amount: bigint,
    token: SolToken | null
  ): Promise<Instruction[]> {
    if (!token) return [transfer(from, to, amount)]
    // a token account isn't a wallet: tokens sent to its own token account would be stuck
    const info = (await this.call(network, 'getAccountInfo', [
      to,
      { encoding: 'base64', commitment: 'confirmed' }
    ])) as {
      value?: { owner?: unknown } | null
    }
    const owner = info?.value?.owner
    if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
      throw new ProviderError(
        -32602,
        'that’s a token account, not a wallet: ask for their wallet’s address'
      )
    }
    return [
      createAssociatedTokenAccountIdempotent(from, to, token.mint, token.program),
      transferChecked(
        associatedTokenAccount(from, token.mint, token.program),
        token.mint,
        associatedTokenAccount(to, token.mint, token.program),
        from,
        amount,
        token.decimals,
        token.program
      )
    ]
  }

  /**
   * Sends `amount` of `token` (or SOL) to `to`: simulated first (what it would do, and what it
   * uses), then shown on maki and signed there, then sent. Its signature, as explorers show it.
   */
  async send(
    network: SolNetwork,
    from: string,
    to: string,
    amount: bigint,
    token: SolToken | null
  ): Promise<string> {
    if (!isAddress(to)) throw new ProviderError(-32602, 'that isn’t a Solana address')
    if (amount <= 0n) throw new ProviderError(-32602, 'send something')
    const pay = await this.payment(network, from, to, amount, token)
    const price = await this.priority(network, [
      from,
      ...pay.flatMap((ix) => ix.accounts.filter((a) => a.writable).map((a) => a.address))
    ])
    const latest = (await this.call(network, 'getLatestBlockhash', [
      { commitment: 'confirmed' }
    ])) as { value?: { blockhash?: unknown } }
    const blockhash = latest?.value?.blockhash
    if (typeof blockhash !== 'string') throw new Error('the network didn’t give a blockhash')
    const build = (units: number): Uint8Array =>
      compileMessage(from, [computeUnitLimit(units), computeUnitPrice(price), ...pay], blockhash)
    // what it would do, unsigned: whether it works, and the compute units it uses
    const trial = transactionOf(build(MOST_UNITS), [new Uint8Array(64)])
    const sim = (await this.call(network, 'simulateTransaction', [
      toBase64(trial),
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed'
      }
    ])) as { value?: { err?: unknown; logs?: unknown; unitsConsumed?: unknown } }
    if (sim?.value?.err) {
      const logs = Array.isArray(sim.value.logs)
        ? sim.value.logs.filter((l): l is string => typeof l === 'string')
        : []
      const said = logs.reverse().find((l) => /failed|insufficient|error/i.test(l))
      throw new ProviderError(
        -32603,
        `the network says it would fail: ${said ?? JSON.stringify(sim.value.err)}`
      )
    }
    const used =
      typeof sim?.value?.unitsConsumed === 'number' ? sim.value.unitsConsumed : MOST_UNITS
    const units = Math.min(MOST_UNITS, Math.ceil(used * ROOM) + 300)
    const tx = transactionOf(build(units), [new Uint8Array(64)])
    const signed = (await this.solana.request(WALLET_SITE, 'signTransaction', [
      { transaction: toBase64(tx) }
    ])) as {
      signedTransaction: string
    }
    return this.solana.send(network.chain, fromBase64(signed.signedTransaction)!, {
      preflightCommitment: 'confirmed'
    })
  }
}
