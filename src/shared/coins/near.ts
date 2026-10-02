/**
 * NEAR, for maki desktop's wallet: the implicit account maki's NEAR app shares (MyNearWallet's,
 * near-cli's and Trust Wallet's, at m/44'/397'/0': its name is its key's 64 hex digits), what it
 * holds (NEAR, and the NEP-141 tokens maki knows), what it's done (NearBlocks), and payments made as
 * the app takes them to sign: a transaction in borsh, as near-api-js encodes it, sent through
 * FastNEAR's RPC.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base58, base64, hex } from '@scure/base'
import type { AccountChain, Activity, ChainToken, Holding } from '../account-chain'
import type { CoinFetch } from '../coin-servers'

export const NEAR_APP = 'com.leviathan.maki.near'
/** yoctoNEAR in a NEAR. */
export const YOCTO = 10n ** 24n
/** What a byte the account keeps on chain locks up (NEAR's storage staking). */
const STORAGE_PER_BYTE = 10n ** 19n
/** Gas attached to a token's calls: plenty, and what isn't burnt comes back. */
const CALL_GAS = 30_000_000_000_000n
/** What a payment that opens an implicit account costs in all (since protocol 85). */
const ACCOUNT_CREATION = 7_000_000_000_000_000_000_000n
/** About what a transfer to an existing account burns, in gas. */
const TRANSFER_GAS = 450_000_000_000n

/** NEP-141 tokens maki knows (as maki's NEAR app knows them, maki-near's `tokens`). */
const KNOWN: { network: 0 | 1; contract: string; symbol: string; decimals: number }[] = [
  {
    network: 0,
    contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    symbol: 'USDC',
    decimals: 6
  },
  { network: 0, contract: 'usdt.tether-token.near', symbol: 'USDT', decimals: 6 },
  { network: 0, contract: 'wrap.near', symbol: 'wNEAR', decimals: 24 },
  {
    network: 0,
    contract: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
    symbol: 'USDC.e',
    decimals: 6
  },
  {
    network: 0,
    contract: 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
    symbol: 'USDT.e',
    decimals: 6
  },
  {
    network: 1,
    contract: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    symbol: 'USDC',
    decimals: 6
  },
  { network: 1, contract: 'wrap.testnet', symbol: 'wNEAR', decimals: 24 }
]

function tokenOf(network: 0 | 1, contract: string): ChainToken | null {
  const k = KNOWN.find((k) => k.network === network && k.contract === contract)
  return k ? { id: contract, symbol: k.symbol, decimals: k.decimals } : null
}

/** Whether `name` is a NEAR account's: a named one's rules, or an implicit one (hex). */
export function validAccount(name: string): boolean {
  return (
    name.length >= 2 &&
    name.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(name)
  )
}
const implicit = (name: string): boolean => /^[0-9a-f]{64}$/.test(name)

export type NearAction =
  | { kind: 'transfer'; deposit: bigint }
  | { kind: 'call'; method: string; args: string; gas: bigint; deposit: bigint }

export interface NearTransaction {
  signer: string
  /** the account's Ed25519 key, 32 bytes */
  publicKey: Uint8Array
  nonce: bigint
  receiver: string
  blockHash: Uint8Array
  actions: NearAction[]
}

/** Borsh: numbers little-endian, a string or bytes after their length (a u32). */
class Borsh {
  private out: number[] = []
  u8(n: number): this {
    this.out.push(n & 0xff)
    return this
  }
  u32(n: number): this {
    for (let i = 0; i < 4; i++) this.out.push((n >>> (8 * i)) & 0xff)
    return this
  }
  int(n: bigint, bytes: number): this {
    for (let i = 0n; i < BigInt(bytes); i++) this.out.push(Number((n >> (8n * i)) & 0xffn))
    return this
  }
  fixed(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.out.push(b[i])
    return this
  }
  bytes(b: ArrayLike<number>): this {
    return this.u32(b.length).fixed(b)
  }
  str(s: string): this {
    return this.bytes(new TextEncoder().encode(s))
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** The transaction as near-api-js's `encodeTransaction` writes it: what maki signs the SHA-256 of. */
export function encodeTransaction(tx: NearTransaction): Uint8Array {
  const w = new Borsh().str(tx.signer).u8(0).fixed(tx.publicKey).int(tx.nonce, 8)
  w.str(tx.receiver).fixed(tx.blockHash).u32(tx.actions.length)
  for (const a of tx.actions) {
    if (a.kind === 'transfer') w.u8(3).int(a.deposit, 16)
    else w.u8(2).str(a.method).str(a.args).int(a.gas, 8).int(a.deposit, 16)
  }
  return w.finish()
}

/** The signed transaction: the transaction, then its signature (Ed25519's tag, 64 bytes). */
export const signedTransaction = (tx: Uint8Array, signature: Uint8Array): Uint8Array =>
  Uint8Array.from([...tx, 0, ...signature])

/** A transaction's hash, its ID: base58 of the SHA-256 of its bytes. */
export const transactionHash = (tx: Uint8Array): string => base58.encode(sha256(tx))

async function rpc(
  fetch: CoinFetch,
  network: 0 | 1,
  method: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const r = await fetch(
    network,
    'POST',
    '/',
    JSON.stringify({ jsonrpc: '2.0', id: 'maki', method, params })
  )
  let body: {
    result?: Record<string, unknown>
    error?: { cause?: { name?: string }; data?: unknown; message?: string }
  }
  try {
    body = JSON.parse(r.text)
  } catch {
    throw new Error(`NEAR's RPC answered ${r.status}`)
  }
  if (body.error) {
    const e = new Error(String(body.error.data ?? body.error.message ?? 'NEAR’s RPC refused it'))
    ;(e as { cause?: unknown }).cause = body.error.cause?.name
    throw e
  }
  return body.result ?? {}
}

/** A contract's view call's answer, read as JSON. */
async function view(
  fetch: CoinFetch,
  network: 0 | 1,
  contract: string,
  method: string,
  args: object
): Promise<unknown> {
  const r = await rpc(fetch, network, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args)))
  })
  if (!Array.isArray(r.result)) throw new Error(String(r.error ?? `${contract} couldn’t say`))
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[])))
}

/** An account's NEAR, what it keeps for storage; null if NEAR hasn't the account. */
async function viewAccount(
  fetch: CoinFetch,
  network: 0 | 1,
  name: string
): Promise<{ amount: bigint; locked: bigint; storage: bigint } | null> {
  try {
    const r = await rpc(fetch, network, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: name
    })
    return {
      amount: BigInt(String(r.amount)),
      locked: BigInt(String(r.locked ?? 0)),
      storage: BigInt(Number(r.storage_usage ?? 0))
    }
  } catch (e) {
    if ((e as { cause?: unknown }).cause === 'UNKNOWN_ACCOUNT') return null
    throw e
  }
}

/** NearBlocks gives NEAR's amounts as JSON numbers: to a millionth of a NEAR, which they hold. */
const yocto = (n: unknown): bigint => BigInt(Math.round(Number(n ?? 0) / 1e18)) * 10n ** 18n

export const NEAR: AccountChain = {
  id: 'near',
  name: 'NEAR',
  app: NEAR_APP,
  glyph: 'near',
  tint: 'bg-subtext1/10 text-subtext1',
  units: ['NEAR', 'tNEAR'],
  decimals: 24,
  priced: 'NEAR',
  networks: ['NEAR', 'Testnet'],
  hint: 'name.near, or 64 hex digits',
  memo: null,
  wallets: 'The account MyNearWallet, near-cli and Trust Wallet make',
  servers:
    'Balances and payments go through FastNEAR’s RPC, and history through NearBlocks, which see the account’s name and this computer’s IP address. An account keeps a little NEAR for what it stores on chain, which can’t be sent.',
  explorerName: 'NearBlocks',
  explorer: (network, kind, id) =>
    `https://${network === 0 ? '' : 'testnet.'}nearblocks.io/${kind === 'tx' ? 'txns' : 'address'}/${id}`,
  uri: (address) => address,
  valid: (address) => validAccount(address),

  async look(fetch, account) {
    const network = account.network
    const me = await viewAccount(fetch, network, account.address)
    if (!me)
      return {
        holdings: [{ token: null, amount: 0n }],
        activity: [],
        reserved: 0n,
        exists: false,
        notes: ['NEAR hasn’t this account yet: the first NEAR sent to it opens it.']
      }
    const holdings: Holding[] = [{ token: null, amount: me.amount }]
    for (const k of KNOWN.filter((k) => k.network === network)) {
      try {
        const v = await view(fetch, network, k.contract, 'ft_balance_of', {
          account_id: account.address
        })
        const amount = BigInt(String(v))
        if (amount > 0n) holdings.push({ token: tokenOf(network, k.contract), amount })
      } catch {
        // a token the account has never held: none
      }
    }
    const activity = new Map<string, Activity>()
    const notes: string[] = []
    try {
      const [plain, tokens] = await Promise.all(
        ['txns-only', 'ft-txns'].map(
          async (kind) =>
            JSON.parse(
              (
                await fetch(
                  network,
                  'GET',
                  `/nearblocks/v1/account/${account.address}/${kind}?per_page=20`
                )
              ).text
            ) as { txns?: Record<string, unknown>[] }
        )
      )
      for (const t of plain.txns ?? []) {
        const hash = String(t.transaction_hash)
        const out = t.signer_account_id === account.address
        const deposit = yocto((t.actions_agg as { deposit?: unknown } | undefined)?.deposit)
        activity.set(hash, {
          id: hash,
          kind: deposit === 0n ? 'Transaction' : out ? 'Sent' : 'Received',
          amount: out ? -deposit : deposit,
          token: null,
          time: Math.floor(Number(BigInt(String(t.block_timestamp)) / 1_000_000_000n)),
          counterparty: String(out ? t.receiver_account_id : t.signer_account_id),
          failed: (t.outcomes as { status?: boolean } | undefined)?.status === false
        })
      }
      for (const t of tokens.txns ?? []) {
        const ft = t.ft as { contract?: string } | undefined
        const token = tokenOf(network, ft?.contract ?? '')
        if (!token) continue
        const hash = String(t.transaction_hash)
        const delta = BigInt(String(t.delta_amount))
        activity.set(hash, {
          id: hash,
          kind: delta < 0n ? 'Sent' : 'Received',
          amount: delta,
          token,
          time: Math.floor(Number(BigInt(String(t.block_timestamp)) / 1_000_000_000n)),
          counterparty: String(t.involved_account_id ?? ''),
          failed: (t.outcomes as { status?: boolean } | undefined)?.status === false
        })
      }
    } catch {
      notes.push('NearBlocks couldn’t be asked for the account’s history just now.')
    }
    return {
      holdings,
      activity: [...activity.values()].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 20),
      reserved: me.storage * STORAGE_PER_BYTE,
      exists: true,
      notes
    }
  },

  async pay(fetch, account, _state, to, amount, token) {
    const network = account.network
    if (!validAccount(to)) throw new Error('that isn’t a NEAR account’s name')
    const key = hex.decode(account.publicKey).subarray(-32)
    const [access, block, price, there] = await Promise.all([
      rpc(fetch, network, 'query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: account.address,
        public_key: `ed25519:${base58.encode(key)}`
      }),
      rpc(fetch, network, 'block', { finality: 'final' }),
      rpc(fetch, network, 'gas_price', [null]),
      viewAccount(fetch, network, to)
    ])
    const gasPrice = BigInt(String(price.gas_price ?? 100_000_000))
    const blockHash = base58.decode(String((block.header as { hash?: string } | undefined)?.hash))
    const notes: string[] = []
    let receiver = to
    let actions: NearAction[]
    let fee: bigint
    if (!token) {
      if (!there && !implicit(to))
        throw new Error('NEAR hasn’t that account: a named account has to be made before it’s paid')
      actions = [{ kind: 'transfer', deposit: amount }]
      if (!there) notes.push('This payment opens the recipient’s account.')
      fee = there ? TRANSFER_GAS * gasPrice : ACCOUNT_CREATION
    } else {
      // a token: its contract's ft_transfer, with the recipient signed up to hold it if it isn't
      receiver = token.id
      actions = []
      const signed = await view(fetch, network, token.id, 'storage_balance_of', { account_id: to })
      if (signed === null) {
        const bounds = (await view(fetch, network, token.id, 'storage_balance_bounds', {})) as {
          min?: string
        }
        actions.push({
          kind: 'call',
          method: 'storage_deposit',
          args: JSON.stringify({ account_id: to, registration_only: true }),
          gas: CALL_GAS,
          deposit: BigInt(bounds.min ?? '1250000000000000000000')
        })
        notes.push(
          `The recipient isn’t signed up to hold ${token.symbol ?? 'it'} yet: this pays the token’s deposit for them too.`
        )
      }
      actions.push({
        kind: 'call',
        method: 'ft_transfer',
        args: JSON.stringify({ receiver_id: to, amount: amount.toString() }),
        gas: CALL_GAS,
        deposit: 1n
      })
      fee = CALL_GAS * BigInt(actions.length) * gasPrice
    }
    const tx: NearTransaction = {
      signer: account.address,
      publicKey: key,
      nonce: BigInt(String(access.nonce)) + 1n,
      receiver,
      blockHash,
      actions
    }
    const payload = encodeTransaction(tx)
    return { payload, fee, feeIsMost: true, notes, carry: payload }
  },

  async submit(fetch, account, payment, signature) {
    if (signature.length !== 64)
      throw new Error('maki’s NEAR app gave a signature maki desktop can’t read')
    const tx = payment.carry as Uint8Array
    try {
      await rpc(fetch, account.network, 'send_tx', {
        signed_tx_base64: base64.encode(signedTransaction(tx, signature)),
        wait_until: 'INCLUDED'
      })
    } catch (e) {
      throw new Error(`the network turned it down: ${(e as Error).message}`)
    }
    return transactionHash(tx)
  }
}
