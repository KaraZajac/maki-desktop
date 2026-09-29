/**
 * maki's Solana account for web pages and for maki desktop's own wallet: what a site asks through
 * the browser extension's wallet (the Wallet Standard's connect, signTransaction,
 * signAndSendTransaction and signMessage), answered here, and Solana's wire format as far as that
 * and the wallet's sends need it. Whatever needs the account's key (connecting, signing) goes to
 * maki's Solana app, which reads the transaction itself, shows it and asks the owner; a site sees
 * the account only once the owner has connected it on maki. Reads and sends go to the network's
 * JSON-RPC server.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { fromBase64, toBase64 } from './bridge-types'
import { ProviderError } from './ethereum'
import type { ApprovalValue } from './protocol'

export interface SolNetwork {
  /** as the Wallet Standard names it: `solana:mainnet` */
  chain: string
  name: string
  /** a public JSON-RPC server; it sees the account's address and this computer's IP */
  rpc: string
  /** others like it, tried in turn when it can't be reached */
  fallbacks: string[]
  /** a transaction's or address's page on the web, before its path */
  explorer: string
  /** what the explorer's pages end with, for this network */
  explorerQuery: string
  /** a network for testing, whose SOL is worth nothing */
  test?: boolean
}

export const SOL_NETWORKS: SolNetwork[] = [
  {
    chain: 'solana:mainnet',
    name: 'Solana',
    rpc: 'https://api.mainnet-beta.solana.com',
    fallbacks: ['https://solana-rpc.publicnode.com'],
    explorer: 'https://explorer.solana.com',
    explorerQuery: ''
  },
  {
    chain: 'solana:devnet',
    name: 'Solana devnet',
    rpc: 'https://api.devnet.solana.com',
    fallbacks: [],
    explorer: 'https://explorer.solana.com',
    explorerQuery: '?cluster=devnet',
    test: true
  }
]

/** Lamports in a SOL. */
export const LAMPORTS = 1_000_000_000n

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

/** An address's key: 32 bytes of base58; null if it isn't one. */
export function keyOf(address: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null
  try {
    const k = base58.decode(address)
    return k.length === 32 ? k : null
  } catch {
    return null
  }
}

export const addressOf = (key: Uint8Array): string => base58.encode(key)
export const isAddress = (s: string): boolean => keyOf(s) !== null

function key(address: string): Uint8Array {
  const k = keyOf(address)
  if (!k) throw new Error(`not a Solana address: ${address}`)
  return k
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Whether `k` is a point on the Ed25519 curve: a key someone could hold the secret of. */
export function onCurve(k: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(k, true)
    return true
  } catch {
    return false
  }
}

/** A program's address from `seeds` (find_program_address): the first off the curve, bump 255 down. */
export function programAddress(seeds: Uint8Array[], program: string): string {
  const suffix = concat(key(program), new TextEncoder().encode('ProgramDerivedAddress'))
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), suffix))
    if (!onCurve(h)) return addressOf(h)
  }
  throw new Error('no program address for those seeds')
}

/** `owner`'s associated token account for `mint`: where wallets send that token. */
export const associatedTokenAccount = (
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM
): string => programAddress([key(owner), key(tokenProgram), key(mint)], ASSOCIATED_TOKEN_PROGRAM)

// ---- instructions ----

export interface Meta {
  address: string
  signer: boolean
  writable: boolean
}

export interface Instruction {
  program: string
  accounts: Meta[]
  data: Uint8Array
}

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const meta = (address: string, signer: boolean, writable: boolean): Meta => ({
  address,
  signer,
  writable
})

/** The System program's transfer: `lamports` from `from` (which signs) to `to`. */
export const transfer = (from: string, to: string, lamports: bigint): Instruction => ({
  program: SYSTEM_PROGRAM,
  accounts: [meta(from, true, true), meta(to, false, true)],
  data: concat(u32le(2), u64le(lamports))
})

/** The most compute units the transaction may use. */
export const computeUnitLimit = (units: number): Instruction => ({
  program: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: concat(Uint8Array.of(2), u32le(units))
})

/** What each compute unit's worth to the one paying the fee, in microlamports: its priority. */
export const computeUnitPrice = (microLamports: bigint): Instruction => ({
  program: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: concat(Uint8Array.of(3), u64le(microLamports))
})

/** Opens `owner`'s token account for `mint` if it isn't open yet (`payer` pays its rent). */
export const createAssociatedTokenAccountIdempotent = (
  payer: string,
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM
): Instruction => ({
  program: ASSOCIATED_TOKEN_PROGRAM,
  accounts: [
    meta(payer, true, true),
    meta(associatedTokenAccount(owner, mint, tokenProgram), false, true),
    meta(owner, false, false),
    meta(mint, false, false),
    meta(SYSTEM_PROGRAM, false, false),
    meta(tokenProgram, false, false)
  ],
  data: Uint8Array.of(1)
})

/** The token program's transferChecked: the mint and its decimals, which it checks. */
export const transferChecked = (
  source: string,
  mint: string,
  destination: string,
  owner: string,
  amount: bigint,
  decimals: number,
  tokenProgram = TOKEN_PROGRAM
): Instruction => ({
  program: tokenProgram,
  accounts: [
    meta(source, false, true),
    meta(mint, false, false),
    meta(destination, false, true),
    meta(owner, true, false)
  ],
  data: concat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals))
})

// ---- messages and transactions ----

/** A count, as Solana writes one (compact-u16): seven bits a byte, least significant first. */
function shortvec(n: number): Uint8Array {
  const out: number[] = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if (n === 0) {
      out.push(b)
      return Uint8Array.from(out)
    }
    out.push(b | 0x80)
  }
}

/** web3.js's order for accounts that are neither signers nor fee payer: its locale compare. */
const byAddress = (a: string, b: string): number =>
  a.localeCompare(b, 'en', {
    usage: 'sort',
    sensitivity: 'variant',
    ignorePunctuation: false,
    numeric: false,
    caseFirst: 'lower'
  })

/**
 * A legacy message, as @solana/web3.js compiles one: the fee payer first, then the other signers
 * that write, those that only read, the others that write, then the rest (programs among them).
 */
export function compileMessage(
  payer: string,
  instructions: Instruction[],
  blockhash: string
): Uint8Array {
  const metas: Meta[] = []
  const programs: string[] = []
  for (const ix of instructions) {
    metas.push(...ix.accounts.map((m) => ({ ...m })))
    if (!programs.includes(ix.program)) programs.push(ix.program)
  }
  metas.push(...programs.map((p) => meta(p, false, false)))
  const unique: Meta[] = []
  for (const m of metas) {
    const u = unique.find((x) => x.address === m.address)
    if (u) {
      u.writable ||= m.writable
      u.signer ||= m.signer
    } else unique.push(m)
  }
  unique.sort((x, y) =>
    x.signer !== y.signer
      ? x.signer
        ? -1
        : 1
      : x.writable !== y.writable
        ? x.writable
          ? -1
          : 1
        : byAddress(x.address, y.address)
  )
  const at = unique.findIndex((m) => m.address === payer)
  const first =
    at < 0 ? meta(payer, true, true) : { ...unique.splice(at, 1)[0], signer: true, writable: true }
  const keys = [first, ...unique]
  const signers = keys.filter((m) => m.signer)
  const header = Uint8Array.of(
    signers.length,
    signers.filter((m) => !m.writable).length,
    keys.filter((m) => !m.signer && !m.writable).length
  )
  const index = (a: string): number => keys.findIndex((m) => m.address === a)
  const compiled = instructions.map((ix) =>
    concat(
      Uint8Array.of(index(ix.program)),
      shortvec(ix.accounts.length),
      Uint8Array.from(ix.accounts.map((m) => index(m.address))),
      shortvec(ix.data.length),
      ix.data
    )
  )
  return concat(
    header,
    shortvec(keys.length),
    ...keys.map((m) => key(m.address)),
    key(blockhash),
    shortvec(compiled.length),
    ...compiled
  )
}

/** A transaction's wire form: its signatures (zeros where one's still to come), then its message. */
export function transactionOf(message: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  return concat(shortvec(signatures.length), ...signatures, message)
}

export interface ReadTransaction {
  signatures: Uint8Array[]
  message: Uint8Array
  /** the keys that sign it, in the order their signatures go; the first pays the fee */
  signers: string[]
}

/** A transaction in its wire form, legacy or version 0, read as far as who signs it. */
export function readTransaction(bytes: Uint8Array): ReadTransaction {
  let at = 0
  const bad = (): never => {
    throw new ProviderError(-32602, 'not a Solana transaction')
  }
  const count = (): number => {
    let n = 0
    for (let i = 0; i < 3; i++) {
      if (at >= bytes.length) bad()
      const b = bytes[at++]
      n |= (b & 0x7f) << (7 * i)
      if (!(b & 0x80)) return n
    }
    return bad()
  }
  const n = count()
  if (at + n * 64 > bytes.length) bad()
  const signatures = Array.from({ length: n }, (_, i) =>
    bytes.slice(at + i * 64, at + (i + 1) * 64)
  )
  at += n * 64
  const message = bytes.slice(at)
  // the message: a version byte (v0), the header, the keys
  if (bytes[at] & 0x80) {
    if (bytes[at] !== 0x80)
      throw new ProviderError(-32602, 'a Solana transaction version maki doesn’t know')
    at++
  }
  if (at + 3 > bytes.length) bad()
  const required = bytes[at]
  at += 3
  const keys = count()
  if (required > keys || at + keys * 32 > bytes.length || required !== n) bad()
  const signers = Array.from({ length: required }, (_, i) =>
    addressOf(bytes.subarray(at + i * 32, at + (i + 1) * 32))
  )
  return { signatures, message, signers }
}

/** The transaction with `signer`'s signature in its place. */
export function withSignature(tx: Uint8Array, signer: string, signature: Uint8Array): Uint8Array {
  const r = readTransaction(tx)
  const i = r.signers.indexOf(signer)
  if (i < 0) throw new ProviderError(-32602, 'that account doesn’t sign this transaction')
  r.signatures[i] = signature
  return transactionOf(r.message, r.signatures)
}

// ---- for sites ----

/** What maki desktop remembers: which sites are connected, and to which address. */
export interface SolState {
  connected: Record<string, string>
}

export interface SolStore {
  load(): Promise<SolState>
  save(state: SolState): Promise<void>
}

export function memorySolStore(): SolStore {
  let state: SolState = { connected: {} }
  return {
    load: async () => structuredClone(state),
    save: async (s) => void (state = structuredClone(s))
  }
}

/** A JSON-RPC call to a network: its result, or a thrown ProviderError. */
export type SolRpc = (url: string, method: string, params: unknown[]) => Promise<unknown>

/** What of maki this needs: its Solana app's calls. */
export interface SolSigner {
  solAccount(
    site: string,
    index?: number
  ): Promise<{ approval: ApprovalValue; reason: string; address: string }>
  solSignTransaction(
    site: string,
    message: Uint8Array,
    index?: number
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }>
  solSignMessage(
    site: string,
    message: Uint8Array,
    index?: number
  ): Promise<{ approval: ApprovalValue; reason: string; signature: Uint8Array | null }>
}

/** The error a page's promise rejects with, when maki didn't. */
export function solRefusal(approval: ApprovalValue, reason = ''): ProviderError {
  switch (approval) {
    case 'denied':
      return new ProviderError(4001, 'rejected on maki')
    case 'timed out':
      return new ProviderError(4001, 'nobody answered on maki in time')
    case 'locked':
      return new ProviderError(4100, 'maki is locked: enter its PIN')
    case 'no phrase':
      return new ProviderError(4100, 'maki has no recovery phrase yet')
    case 'no match':
      return new ProviderError(
        4100,
        'maki’s Solana app isn’t installed: add it from the maki store, in maki desktop'
      )
    case 'unavailable':
      return new ProviderError(
        4100,
        'maki couldn’t run its Solana app: if another app is open on maki, go back to its home screen'
      )
    case 'refused':
      return new ProviderError(-32603, `maki won't sign it: ${reason}`)
    default:
      return new ProviderError(-32603, `maki: ${approval}`)
  }
}

/** What a site's request carries: an object, the first of its params. */
const arg = (params: unknown[]): Record<string, unknown> => {
  const a = params[0]
  return typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {}
}

const bytesOf = (v: unknown, what: string, max: number): Uint8Array => {
  const b = typeof v === 'string' ? fromBase64(v) : null
  if (!b || b.length === 0 || b.length > max)
    throw new ProviderError(-32602, `${what} must be base64, 1 to ${max} bytes`)
  return b
}

/** The biggest message maki's Solana app takes to sign: a link message, less its head. */
export const MAX_SOL_MESSAGE = 3800

export class Solana {
  constructor(
    private signer: () => SolSigner | null,
    private rpc: SolRpc,
    private store: SolStore,
    readonly networks: SolNetwork[] = SOL_NETWORKS
  ) {}

  private maki(): SolSigner {
    const m = this.signer()
    if (!m) throw new ProviderError(4900, 'maki is not linked: plug it in and open maki desktop')
    return m
  }

  network(chain: unknown): SolNetwork {
    const n = this.networks.find((x) => x.chain === (chain ?? this.networks[0].chain))
    if (!n) throw new ProviderError(4901, 'maki desktop has no server for that network')
    return n
  }

  /** The sites connected to the account, for the window to list. */
  async sites(): Promise<{ site: string; address: string }[]> {
    const state = await this.store.load()
    return Object.entries(state.connected)
      .map(([site, address]) => ({ site, address }))
      .sort((a, b) => a.site.localeCompare(b.site))
  }

  async disconnect(site: string): Promise<void> {
    const state = await this.store.load()
    delete state.connected[site]
    await this.store.save(state)
  }

  /** The address connected to `site`; throws if there's none. */
  private async connected(site: string): Promise<string> {
    const address = (await this.store.load()).connected[site]
    if (!address) throw new ProviderError(4100, 'connect this site to maki first')
    return address
  }

  /** Has maki sign a transaction (wire form) for `site`: the transaction, signed. */
  private async sign(site: string, tx: Uint8Array): Promise<Uint8Array> {
    const address = await this.connected(site)
    const read = readTransaction(tx)
    if (!read.signers.includes(address))
      throw new ProviderError(4100, 'that transaction isn’t for the account connected to this site')
    if (read.message.length > MAX_SOL_MESSAGE)
      throw new ProviderError(-32602, 'bigger than maki takes')
    const r = await this.maki().solSignTransaction(site, read.message)
    if (r.approval !== 'approved' || !r.signature) throw solRefusal(r.approval, r.reason)
    return withSignature(tx, address, r.signature)
  }

  /** Sends a signed transaction on `chain`: its signature (the first), base58, as explorers show it. */
  async send(
    chain: unknown,
    signed: Uint8Array,
    options: Record<string, unknown> = {}
  ): Promise<string> {
    const n = this.network(chain)
    const config: Record<string, unknown> = { encoding: 'base64' }
    for (const k of ['skipPreflight', 'preflightCommitment', 'maxRetries', 'minContextSlot']) {
      if (options[k] !== undefined) config[k] = options[k]
    }
    const sig = await this.rpc(n.rpc, 'sendTransaction', [toBase64(signed), config])
    if (typeof sig !== 'string')
      throw new ProviderError(-32603, 'the network didn’t say it took it')
    return sig
  }

  /** One request from `site`'s page, through the extension's wallet. */
  async request(site: string, method: string, params: unknown[] = []): Promise<unknown> {
    const a = arg(params)
    switch (method) {
      case 'connect': {
        const state = await this.store.load()
        let address = state.connected[site]
        if (!address) {
          // a page that connects quietly (on load) gets only what the owner allowed before
          if (a.silent === true) return { accounts: [] }
          const r = await this.maki().solAccount(site)
          if (r.approval !== 'approved') throw solRefusal(r.approval, r.reason)
          address = r.address
          state.connected[site] = address
          await this.store.save(state)
        }
        return { accounts: [address] }
      }
      case 'disconnect':
        await this.disconnect(site)
        return null
      case 'signTransaction': {
        const signed = await this.sign(site, bytesOf(a.transaction, 'transaction', 1232))
        return { signedTransaction: toBase64(signed) }
      }
      case 'signAndSendTransaction': {
        const n = this.network(a.chain)
        const signed = await this.sign(site, bytesOf(a.transaction, 'transaction', 1232))
        const options =
          typeof a.options === 'object' && a.options !== null
            ? (a.options as Record<string, unknown>)
            : {}
        return { signature: await this.send(n.chain, signed, options) }
      }
      case 'signMessage': {
        await this.connected(site)
        const message = bytesOf(a.message, 'message', MAX_SOL_MESSAGE)
        const r = await this.maki().solSignMessage(site, message)
        if (r.approval !== 'approved' || !r.signature) throw solRefusal(r.approval, r.reason)
        return { signature: toBase64(r.signature) }
      }
      default:
        throw new ProviderError(4200, `maki doesn’t do ${method}`)
    }
  }
}
