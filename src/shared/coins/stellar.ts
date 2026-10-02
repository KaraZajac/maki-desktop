/**
 * Stellar, for maki desktop's wallet: XLM, and the assets an account has trust lines for. Payments
 * are made here as Stellar's transaction envelopes (XDR: a payment, or a new account for a
 * recipient Stellar hasn't yet), and maki's Stellar app reads them back, shows them (where it
 * goes, the asset, how much, the memo, the fee) and signs the transaction's hash for the network it
 * names; the signature goes in, and the envelope to Horizon. Balances, history and submitting
 * through the Stellar Development Foundation's Horizon servers.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base32nopad, base64, hex } from '@scure/base'
import type {
  AccountChain,
  Activity,
  ChainState,
  ChainToken,
  Holding,
  Payment
} from '../account-chain'
import type { CoinFetch, SharedAccount } from '../coin-servers'

export const STELLAR_APP = 'com.leviathan.maki.stellar'

/** Stroops in an XLM: amounts are counted to the seventh place. */
export const STROOPS = 10_000_000n
const DECIMALS = 7
/** How long a payment stays good for, in seconds: it lapses rather than wait about. */
const VALID_FOR = 300

/** The networks' passphrases, which every signature covers. */
export const PASSPHRASE = [
  'Public Global Stellar Network ; September 2015',
  'Test SDF Network ; September 2015'
] as const

function crc16(data: Uint8Array): number {
  let crc = 0
  for (const b of data) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

/** An account's key from its address (`G…`, StrKey); null if it isn't one. */
export function accountKey(address: string): Uint8Array | null {
  if (!/^G[A-Z2-7]{55}$/.test(address)) return null
  try {
    const b = base32nopad.decode(address)
    if (b.length !== 35 || b[0] !== 6 << 3) return null
    const sum = crc16(b.subarray(0, 33))
    return b[33] === (sum & 0xff) && b[34] === sum >> 8 ? b.slice(1, 33) : null
  } catch {
    return null
  }
}

export function accountAddress(key: Uint8Array): string {
  const body = Uint8Array.from([6 << 3, ...key])
  const sum = crc16(body)
  return base32nopad.encode(Uint8Array.from([...body, sum & 0xff, sum >> 8]))
}

/** XDR, as Stellar writes its records: big-endian, everything in fours. */
class Xdr {
  private out: number[] = []
  u32(n: number): this {
    this.out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
    return this
  }
  u64(n: bigint): this {
    for (let i = 7; i >= 0; i--) this.out.push(Number((n >> BigInt(8 * i)) & 0xffn))
    return this
  }
  fixed(b: Uint8Array): this {
    this.out.push(...b)
    while (this.out.length % 4) this.out.push(0)
    return this
  }
  opaque(b: Uint8Array): this {
    return this.u32(b.length).fixed(b)
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

export type StellarAsset = 'native' | { code: string; issuer: string }

export interface StellarPayment {
  source: string
  fee: number
  sequence: bigint
  maxTime: bigint
  memo: string
  /** a payment, or a new account with this starting balance (XLM) */
  kind: 'payment' | 'create'
  destination: string
  asset: StellarAsset
  /** stroops (or the asset's seven places) */
  amount: bigint
}

function asset(x: Xdr, a: StellarAsset): void {
  if (a === 'native') {
    x.u32(0)
    return
  }
  const issuer = accountKey(a.issuer)
  if (!issuer || !/^[A-Za-z0-9]{1,12}$/.test(a.code)) throw new Error('not a Stellar asset')
  const four = a.code.length <= 4
  const code = new Uint8Array(four ? 4 : 12)
  for (let i = 0; i < a.code.length; i++) code[i] = a.code.charCodeAt(i)
  x.u32(four ? 1 : 2)
    .fixed(code)
    .u32(0)
    .fixed(issuer)
}

/** The transaction's XDR (what its hash, and the signature, cover). */
export function transactionXdr(p: StellarPayment): Uint8Array {
  const source = accountKey(p.source)
  const destination = accountKey(p.destination)
  if (!source || !destination) throw new Error('not a Stellar address')
  const memo = new TextEncoder().encode(p.memo)
  if (memo.length > 28) throw new Error('a memo is 28 bytes at most')
  const x = new Xdr()
    // the source, a plain ed25519 account (MuxedAccount KEY_TYPE_ED25519)
    .u32(0)
    .fixed(source)
    .u32(p.fee)
    .u64(p.sequence)
    // PRECOND_TIME: from any time, until maxTime
    .u32(1)
    .u64(0n)
    .u64(p.maxTime)
  if (memo.length === 0) x.u32(0)
  else x.u32(1).opaque(memo)
  // one operation, with no source of its own
  x.u32(1).u32(0)
  if (p.kind === 'create') {
    if (p.asset !== 'native') throw new Error('a new account starts with XLM')
    x.u32(0).u32(0).fixed(destination).u64(p.amount)
  } else {
    x.u32(1).u32(0).fixed(destination)
    asset(x, p.asset)
    x.u64(p.amount)
  }
  // ext: v0
  return x.u32(0).bytes()
}

/** The envelope (ENVELOPE_TYPE_TX), unsigned for maki, or with its one signature. */
export function envelope(p: StellarPayment, signature?: Uint8Array): Uint8Array {
  const x = new Xdr().u32(2)
  const tx = transactionXdr(p)
  const out = [...x.bytes(), ...tx]
  const sigs = new Xdr()
  if (!signature) sigs.u32(0)
  else sigs.u32(1).fixed(accountKey(p.source)!.slice(28)).opaque(signature)
  return Uint8Array.from([...out, ...sigs.bytes()])
}

/** The transaction's hash on `network`: what's signed, and its ID. */
export function transactionHash(p: StellarPayment, network: 0 | 1): Uint8Array {
  const id = sha256(new TextEncoder().encode(PASSPHRASE[network]))
  return sha256(Uint8Array.from([...id, 0, 0, 0, 2, ...transactionXdr(p)]))
}

/** Assets maki knows on the main network, by code and issuer (as maki's Stellar app knows them). */
const KNOWN = [
  {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    symbol: 'USDC'
  }
]

function tokenOf(network: 0 | 1, code: string, issuer: string): ChainToken {
  const known =
    network === 0 ? KNOWN.find((k) => k.code === code && k.issuer === issuer) : undefined
  return {
    id: `${code}:${issuer}`,
    symbol: known?.symbol ?? null,
    decimals: DECIMALS,
    label: `${code} by ${issuer.slice(0, 6)}…`
  }
}

/** Horizon's decimal amounts (seven places) as stroops. */
function stroops(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(value)
  if (!m) throw new Error(`not an amount: ${value}`)
  const v = BigInt(m[2]) * STROOPS + BigInt((m[3] ?? '').padEnd(7, '0'))
  return m[1] ? -v : v
}

async function get(
  fetch: CoinFetch,
  network: 0 | 1,
  path: string
): Promise<Record<string, unknown> | null> {
  const r = await fetch(network, 'GET', path)
  if (r.status === 404) return null
  if (r.status !== 200) throw new Error(`Horizon answered ${r.status}`)
  return JSON.parse(r.text)
}

interface HorizonAccount {
  sequence: string
  subentry_count: number
  num_sponsoring?: number
  num_sponsored?: number
  balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[]
}

/** What an account must keep (Stellar's minimum balance): two base reserves, and one for each entry. */
async function baseReserve(fetch: CoinFetch, network: 0 | 1): Promise<bigint> {
  const l = (await get(fetch, network, '/ledgers?order=desc&limit=1')) as {
    _embedded?: { records?: { base_reserve_in_stroops?: number }[] }
  } | null
  return BigInt(l?._embedded?.records?.[0]?.base_reserve_in_stroops ?? 5_000_000)
}

export const STELLAR: AccountChain = {
  id: 'stellar',
  name: 'Stellar',
  app: STELLAR_APP,
  glyph: 'stellar',
  tint: 'bg-blue/10 text-blue',
  units: ['XLM', 'tXLM'],
  decimals: DECIMALS,
  priced: 'XLM',
  networks: ['Stellar', 'Testnet'],
  hint: 'G…',
  memo: { label: 'Memo', placeholder: 'if the recipient asked for one', numeric: false },
  wallets: 'The account Lobstr, Freighter and Ledger make',
  servers:
    'Balances and payments go through Horizon, the Stellar Development Foundation’s servers, which see the account’s address and this computer’s IP address. An account keeps a minimum balance the network sets (1 XLM, and half an XLM for each trust line), which can’t be sent.',
  explorerName: 'stellar.expert',
  explorer: (network, kind, id) =>
    `https://stellar.expert/explorer/${network === 0 ? 'public' : 'testnet'}/${kind === 'tx' ? 'tx' : 'account'}/${id}`,
  uri: (address) => `web+stellar:pay?destination=${address}`,
  valid: (address) => accountKey(address) !== null,

  async look(fetch, account) {
    const network = account.network
    const [a, reserve] = await Promise.all([
      get(fetch, network, `/accounts/${account.address}`) as Promise<HorizonAccount | null>,
      baseReserve(fetch, network)
    ])
    if (!a) {
      return {
        holdings: [{ token: null, amount: 0n }],
        activity: [],
        reserved: 0n,
        exists: false,
        notes: [
          `Stellar hasn’t this account yet: it opens with a first payment of at least ${Number(2n * reserve) / 1e7} XLM, the network’s minimum balance.`
        ]
      }
    }
    const holdings: Holding[] = []
    for (const b of a.balances) {
      if (b.asset_type === 'native') holdings.unshift({ token: null, amount: stroops(b.balance) })
      else if (b.asset_code && b.asset_issuer)
        holdings.push({
          token: tokenOf(network, b.asset_code, b.asset_issuer),
          amount: stroops(b.balance)
        })
    }
    const entries = 2 + a.subentry_count + (a.num_sponsoring ?? 0) - (a.num_sponsored ?? 0)
    const payments = (await get(
      fetch,
      network,
      `/accounts/${account.address}/payments?order=desc&limit=20`
    )) as {
      _embedded?: { records?: Record<string, string | boolean>[] }
    } | null
    const activity: Activity[] = (payments?._embedded?.records ?? []).map((r) => {
      const outgoing = (r.from ?? r.funder ?? r.source_account) === account.address
      const amount =
        typeof r.amount === 'string'
          ? r.amount
          : typeof r.starting_balance === 'string'
            ? r.starting_balance
            : null
      const token =
        r.asset_type && r.asset_type !== 'native' && r.asset_code
          ? tokenOf(network, String(r.asset_code), String(r.asset_issuer))
          : null
      const value = amount === null ? null : stroops(amount)
      return {
        id: String(r.transaction_hash),
        kind:
          r.type === 'create_account'
            ? outgoing
              ? 'Opened an account'
              : 'Opened'
            : outgoing
              ? 'Sent'
              : 'Received',
        amount: value === null ? null : outgoing ? -value : value,
        token,
        time: typeof r.created_at === 'string' ? Math.floor(Date.parse(r.created_at) / 1000) : null,
        counterparty: String((outgoing ? (r.to ?? r.account) : (r.from ?? r.funder)) ?? ''),
        failed: r.transaction_successful === false
      }
    })
    return {
      holdings: holdings.length ? holdings : [{ token: null, amount: 0n }],
      activity,
      reserved: BigInt(entries) * reserve,
      exists: true,
      notes: []
    }
  },

  async pay(fetch, account, _state, to, amount, token, memo) {
    const network = account.network
    const [me, there, stats, reserve] = await Promise.all([
      get(fetch, network, `/accounts/${account.address}`) as Promise<HorizonAccount | null>,
      get(fetch, network, `/accounts/${to}`) as Promise<HorizonAccount | null>,
      get(fetch, network, '/fee_stats') as Promise<{
        last_ledger_base_fee?: string
        fee_charged?: { p70?: string }
      } | null>,
      baseReserve(fetch, network)
    ])
    if (!me) throw new Error('Stellar hasn’t this account yet')
    const notes: string[] = []
    let kind: StellarPayment['kind'] = 'payment'
    const [code, issuer] = token ? token.id.split(':') : []
    if (!there) {
      if (token)
        throw new Error('the recipient’s account doesn’t exist yet: it can’t hold an asset')
      if (amount < 2n * reserve)
        throw new Error(
          `the recipient’s account doesn’t exist yet: send at least ${Number(2n * reserve) / 1e7} XLM to open it`
        )
      kind = 'create'
      notes.push('This payment opens the recipient’s account.')
    } else if (
      token &&
      !there.balances.some((b) => b.asset_code === code && b.asset_issuer === issuer)
    ) {
      throw new Error(`the recipient hasn’t a trust line for ${code}: they can’t take it yet`)
    }
    // what the last ledgers charged, a little over, never under the base fee
    const base = Number(stats?.last_ledger_base_fee ?? 100)
    const fee = Math.max(base, Math.ceil(Number(stats?.fee_charged?.p70 ?? base) * 1.2))
    const payment: StellarPayment = {
      source: account.address,
      fee,
      sequence: BigInt(me.sequence) + 1n,
      maxTime: BigInt(Math.floor(Date.now() / 1000) + VALID_FOR),
      memo,
      kind,
      destination: to,
      asset: token ? { code, issuer } : 'native',
      amount
    }
    return { payload: envelope(payment), fee: BigInt(fee), feeIsMost: true, notes, carry: payment }
  },

  async submit(fetch, account, payment, signature) {
    const p = payment.carry as StellarPayment
    const signed = base64.encode(envelope(p, signature))
    const r = await fetch(account.network, 'POST', `/transactions?tx=${encodeURIComponent(signed)}`)
    const body = JSON.parse(r.text) as {
      hash?: string
      extras?: { result_codes?: unknown }
      title?: string
    }
    if (r.status !== 200 || !body.hash)
      throw new Error(
        `the network turned it down: ${JSON.stringify(body.extras?.result_codes ?? body.title ?? r.status)}`
      )
    if (body.hash !== hex.encode(transactionHash(p, account.network)))
      throw new Error('Horizon took a different transaction from the one maki signed')
    return body.hash
  }
}
