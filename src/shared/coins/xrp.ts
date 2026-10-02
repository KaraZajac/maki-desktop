/**
 * The XRP Ledger, for maki desktop's wallet: XRP, and the tokens an account has trust lines for.
 * Payments are made here in the ledger's binary format (the fields a payment has, in its canonical
 * order), and maki's XRP app reads them back, shows them (where it goes, its destination tag, how
 * much, the fee) and signs; the signature goes in, and the transaction to a rippled server.
 * Balances, history and submitting through public rippled servers' JSON-RPC.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { base58xrp, hex } from '@scure/base'
import type {
  AccountChain,
  Activity,
  ChainState,
  ChainToken,
  Holding,
  Payment
} from '../account-chain'
import type { CoinFetch, SharedAccount } from '../coin-servers'

export const XRP_APP = 'com.leviathan.maki.xrp'

/** Drops in an XRP. */
export const DROPS = 1_000_000n
/** The ledger counts its time from 2000-01-01, not 1970's. */
const RIPPLE_EPOCH = 946_684_800
/** How many ledgers a payment may wait for before it lapses (a few seconds each). */
const LEDGERS = 20

/** Base58 with XRP's alphabet and a checksum: four bytes of SHA-256 twice. */
const checked = {
  encode(payload: Uint8Array): string {
    return base58xrp.encode(Uint8Array.from([...payload, ...sha256(sha256(payload)).slice(0, 4)]))
  },
  decode(text: string): Uint8Array {
    const b = base58xrp.decode(text)
    const payload = b.slice(0, -4)
    const sum = sha256(sha256(payload)).slice(0, 4)
    if (b.length < 5 || sum.some((x, i) => x !== b[b.length - 4 + i])) throw new Error('checksum')
    return payload
  }
}

/** An account's 20-byte ID from its classic address (`r…`); null if it isn't one. */
export function accountId(address: string): Uint8Array | null {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return null
  try {
    const b = checked.decode(address)
    return b.length === 21 && b[0] === 0 ? b.slice(1) : null
  } catch {
    return null
  }
}

export const classicAddress = (id: Uint8Array): string =>
  checked.encode(Uint8Array.from([0, ...id]))

/** A token's 20-byte currency code: three letters (ISO-style), or 40 hex digits. */
export function currencyCode(currency: string): Uint8Array {
  if (/^[0-9A-Fa-f]{40}$/.test(currency)) return hex.decode(currency.toLowerCase())
  if (!/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(currency) || currency === 'XRP')
    throw new Error(`not a token code: ${currency}`)
  const c = new Uint8Array(20)
  for (let i = 0; i < 3; i++) c[12 + i] = currency.charCodeAt(i)
  return c
}

/** A currency code as people write it: its three letters, or what its 20 bytes spell, or hex. */
export function currencyName(currency: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(currency)) return currency
  const b = hex.decode(currency.toLowerCase())
  const text = String.fromCharCode(...b.filter((x) => x !== 0))
  return /^[\x20-\x7e]{1,20}$/.test(text) && b[0] !== 0 ? text : `${currency.slice(0, 8)}…`
}

/** An issued token's amount: its value (a decimal) in the ledger's 64-bit form, exactly. */
function tokenValue(value: string): Uint8Array {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!m) throw new Error(`not an amount: ${value}`)
  const out = new Uint8Array(8)
  let mantissa = BigInt((m[2] + (m[3] ?? '')).replace(/^0+/, '') || '0')
  let exponent = -(m[3]?.length ?? 0)
  if (mantissa === 0n) {
    out[0] = 0x80
    return out
  }
  while (mantissa < 10n ** 15n) {
    mantissa *= 10n
    exponent--
  }
  while (mantissa >= 10n ** 16n) {
    if (mantissa % 10n !== 0n)
      throw new Error('more than 16 digits: the ledger can’t hold it exactly')
    mantissa /= 10n
    exponent++
  }
  if (exponent < -96 || exponent > 80) throw new Error('an amount the ledger can’t hold')
  let v = (1n << 63n) | (m[1] ? 0n : 1n << 62n) | (BigInt(exponent + 97) << 54n) | mantissa
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** An amount in the ledger's form: drops of XRP (8 bytes), or a token's value, code and issuer. */
type Amount = bigint | { currency: string; issuer: string; value: string }

function amountBytes(a: Amount): Uint8Array {
  if (typeof a === 'bigint') {
    if (a < 0n || a > 10n ** 17n) throw new Error('an amount of XRP the ledger can’t hold')
    let v = (1n << 62n) | a
    const out = new Uint8Array(8)
    for (let i = 7; i >= 0; i--) {
      out[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return out
  }
  const issuer = accountId(a.issuer)
  if (!issuer) throw new Error(`not an issuer’s address: ${a.issuer}`)
  return Uint8Array.from([...tokenValue(a.value), ...currencyCode(a.currency), ...issuer])
}

/** A field's ID: its type and its code, a byte or more (the ledger's serialization). */
function fieldId(type: number, code: number): number[] {
  if (type < 16 && code < 16) return [(type << 4) | code]
  if (type < 16) return [type << 4, code]
  if (code < 16) return [code, type]
  return [0, type, code]
}

/** A variable-length field's length prefix. */
function vl(n: number): number[] {
  if (n <= 192) return [n]
  if (n <= 12480) {
    n -= 193
    return [193 + (n >> 8), n & 0xff]
  }
  throw new Error('too long')
}

const be = (n: number, bytes: number): number[] =>
  Array.from({ length: bytes }, (_, i) => (n >>> (8 * (bytes - 1 - i))) & 0xff)

/** A payment, as the wallet makes them. */
export interface XrpPayment {
  account: string
  destination: string
  amount: Amount
  fee: bigint
  sequence: number
  lastLedgerSequence: number
  /** 33 bytes */
  signingPubKey: Uint8Array
  destinationTag?: number
  /** networks with IDs over 1024 need it; the main and test networks don't take it */
  networkId?: number
}

/**
 * A payment in the ledger's binary format, its fields in their canonical order (by type, then
 * code): with the signature (DER) if it has one, without it for signing.
 */
export function encodePayment(p: XrpPayment, signature?: Uint8Array): Uint8Array {
  const account = accountId(p.account)
  const destination = accountId(p.destination)
  if (!account || !destination) throw new Error('not an XRP address')
  const out: number[] = []
  // UInt16 (1): TransactionType (2), Payment is 0
  out.push(...fieldId(1, 2), 0, 0)
  // UInt32 (2): NetworkID (1), Flags (2), Sequence (4), DestinationTag (14), LastLedgerSequence (27)
  if (p.networkId !== undefined) out.push(...fieldId(2, 1), ...be(p.networkId, 4))
  out.push(...fieldId(2, 2), ...be(0, 4))
  out.push(...fieldId(2, 4), ...be(p.sequence, 4))
  if (p.destinationTag !== undefined) out.push(...fieldId(2, 14), ...be(p.destinationTag, 4))
  out.push(...fieldId(2, 27), ...be(p.lastLedgerSequence, 4))
  // Amount (6): Amount (1), Fee (8)
  out.push(...fieldId(6, 1), ...amountBytes(p.amount))
  out.push(...fieldId(6, 8), ...amountBytes(p.fee))
  // Blob (7): SigningPubKey (3), TxnSignature (4)
  out.push(...fieldId(7, 3), ...vl(p.signingPubKey.length), ...p.signingPubKey)
  if (signature) out.push(...fieldId(7, 4), ...vl(signature.length), ...signature)
  // AccountID (8): Account (1), Destination (3)
  out.push(...fieldId(8, 1), ...vl(20), ...account)
  out.push(...fieldId(8, 3), ...vl(20), ...destination)
  return Uint8Array.from(out)
}

/** A signed transaction's ID: SHA-512Half of "TXN\0" and its bytes. */
export function transactionId(signed: Uint8Array): string {
  const h = sha512(Uint8Array.from([0x54, 0x58, 0x4e, 0x00, ...signed]))
  return hex.encode(h.slice(0, 32)).toUpperCase()
}

/** Tokens maki knows, by network, issuer and code (as maki's XRP app knows them, maki-xrp's `tokens`). */
const RLUSD = '524C555344000000000000000000000000000000'
const USDC = '5553444300000000000000000000000000000000'
const KNOWN: { network: 0 | 1; issuer: string; currency: string; symbol: string }[] = [
  { network: 0, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', currency: RLUSD, symbol: 'RLUSD' },
  { network: 0, issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE', currency: USDC, symbol: 'USDC' },
  { network: 1, issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', currency: RLUSD, symbol: 'RLUSD' },
  { network: 1, issuer: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt', currency: USDC, symbol: 'USDC' }
]
/** A token's amounts are decimals: kept here to fifteen places. */
const TOKEN_DECIMALS = 15

function tokenOf(network: 0 | 1, currency: string, issuer: string): ChainToken {
  const known = KNOWN.find(
    (k) => k.network === network && k.issuer === issuer && k.currency === currency
  )
  return {
    id: `${currency}.${issuer}`,
    symbol: known?.symbol ?? null,
    decimals: TOKEN_DECIMALS,
    label: `${currencyName(currency)} by ${issuer.slice(0, 6)}…`
  }
}

/** A decimal string as so many of `decimals` places, cut (never rounded up) past them. */
function scaled(value: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value)
  if (!m) return 0n
  const digits = m[2] + (m[3] ?? '')
  const shift = decimals - (m[3]?.length ?? 0) + Number(m[4] ?? 0)
  const v =
    shift >= 0 ? BigInt(digits) * 10n ** BigInt(shift) : BigInt(digits) / 10n ** BigInt(-shift)
  return m[1] ? -v : v
}

/** So many of a token's fifteen places as a decimal string, as the ledger takes it. */
function decimal(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

async function rpc(
  fetch: CoinFetch,
  network: 0 | 1,
  method: string,
  params: object
): Promise<Record<string, unknown>> {
  const r = await fetch(network, 'POST', '/', JSON.stringify({ method, params: [params] }))
  let body: { result?: Record<string, unknown> }
  try {
    body = JSON.parse(r.text)
  } catch {
    throw new Error(`the XRP server answered ${r.status}`)
  }
  const result = body.result ?? {}
  if (result.status === 'error') {
    const e = new Error(String(result.error_message ?? result.error ?? 'the server refused it'))
    ;(e as { code?: unknown }).code = result.error
    throw e
  }
  return result
}

/** The account's XRP balance and sequence, or null if the ledger hasn't the account. */
async function accountInfo(
  fetch: CoinFetch,
  network: 0 | 1,
  account: string
): Promise<{ balance: bigint; sequence: number; owners: number } | null> {
  try {
    const r = await rpc(fetch, network, 'account_info', { account, ledger_index: 'current' })
    const d = r.account_data as { Balance: string; Sequence: number; OwnerCount: number }
    return { balance: BigInt(d.Balance), sequence: d.Sequence, owners: d.OwnerCount }
  } catch (e) {
    if ((e as { code?: unknown }).code === 'actNotFound') return null
    throw e
  }
}

/** The network's reserves, in drops: what every account keeps, and what each object it owns adds. */
async function reserves(
  fetch: CoinFetch,
  network: 0 | 1
): Promise<{ base: bigint; owner: bigint }> {
  const r = await rpc(fetch, network, 'server_state', {})
  const v = (r.state as { validated_ledger?: { reserve_base?: number; reserve_inc?: number } })
    ?.validated_ledger
  return { base: BigInt(v?.reserve_base ?? 1_000_000), owner: BigInt(v?.reserve_inc ?? 200_000) }
}

export const XRP: AccountChain = {
  id: 'xrp',
  name: 'XRP',
  app: XRP_APP,
  glyph: 'xrp',
  tint: 'bg-subtext0/10 text-subtext0',
  units: ['XRP', 'tXRP'],
  decimals: 6,
  priced: 'XRP',
  networks: ['XRP Ledger', 'Testnet'],
  hint: 'r…',
  memo: { label: 'Destination tag', placeholder: 'if the recipient gave one', numeric: true },
  wallets: 'The account Ledger and Trust Wallet make',
  servers:
    'Balances and payments go through public XRP Ledger servers (xrplcluster.com, Ripple’s), which see the account’s address and this computer’s IP address. An account keeps a reserve the network sets (1 XRP, and more for each token line), which can’t be sent.',
  explorerName: 'the XRPL explorer',
  explorer: (network, kind, id) =>
    `https://${network === 0 ? 'livenet' : 'testnet'}.xrpl.org/${kind === 'tx' ? 'transactions' : 'accounts'}/${id}`,
  uri: (address) => address,
  valid: (address) => accountId(address) !== null,

  async look(fetch, account) {
    const network = account.network
    const [info, res] = await Promise.all([
      accountInfo(fetch, network, account.address),
      reserves(fetch, network)
    ])
    if (!info) {
      return {
        holdings: [{ token: null, amount: 0n }],
        activity: [],
        reserved: 0n,
        exists: false,
        notes: [
          `The ledger hasn’t this account yet: it opens with a first payment of at least ${Number(res.base) / 1e6} XRP, the network’s reserve.`
        ]
      }
    }
    const holdings: Holding[] = [{ token: null, amount: info.balance }]
    const lines = (await rpc(fetch, network, 'account_lines', { account: account.address }))
      .lines as { account: string; currency: string; balance: string }[]
    for (const l of lines ?? []) {
      holdings.push({
        token: tokenOf(network, l.currency, l.account),
        amount: scaled(l.balance, TOKEN_DECIMALS)
      })
    }
    const txs = (await rpc(fetch, network, 'account_tx', { account: account.address, limit: 20 }))
      .transactions as {
      tx?: Record<string, unknown>
      tx_json?: Record<string, unknown>
      hash?: string
      meta?: { delivered_amount?: unknown; TransactionResult?: string }
    }[]
    const activity: Activity[] = (txs ?? []).map((t) => {
      const tx = (t.tx ?? t.tx_json ?? {}) as Record<string, unknown>
      const hash = String(t.hash ?? tx.hash ?? '')
      const from = tx.Account as string | undefined
      const outgoing = from === account.address
      const delivered = t.meta?.delivered_amount ?? tx.Amount ?? tx.DeliverMax
      let amount: bigint | null = null
      let token: ChainToken | null = null
      if (tx.TransactionType === 'Payment' && delivered !== undefined) {
        if (typeof delivered === 'string') amount = BigInt(delivered)
        else if (typeof delivered === 'object' && delivered) {
          const d = delivered as { currency: string; issuer: string; value: string }
          token = tokenOf(network, d.currency, d.issuer)
          amount = scaled(d.value, TOKEN_DECIMALS)
        }
        if (amount !== null && outgoing) amount = -amount
      }
      const date = typeof tx.date === 'number' ? tx.date + RIPPLE_EPOCH : null
      return {
        id: hash,
        kind:
          tx.TransactionType === 'Payment'
            ? outgoing
              ? 'Sent'
              : 'Received'
            : String(tx.TransactionType ?? 'Transaction'),
        amount,
        token,
        time: date,
        counterparty: (outgoing ? tx.Destination : from) as string | undefined,
        failed: t.meta?.TransactionResult !== undefined && t.meta.TransactionResult !== 'tesSUCCESS'
      }
    })
    return {
      holdings,
      activity,
      reserved: res.base + res.owner * BigInt(info.owners),
      exists: true,
      notes: []
    }
  },

  async pay(fetch, account, _state, to, amount, token, memo) {
    const network = account.network
    const [info, res, current, fees, there] = await Promise.all([
      accountInfo(fetch, network, account.address),
      reserves(fetch, network),
      rpc(fetch, network, 'ledger_current', {}),
      rpc(fetch, network, 'fee', {}),
      accountInfo(fetch, network, to)
    ])
    if (!info) throw new Error('the ledger hasn’t this account yet')
    const notes: string[] = []
    if (!there) {
      if (token) throw new Error('the recipient’s account doesn’t exist yet: it can’t hold a token')
      if (amount < res.base)
        throw new Error(
          `the recipient’s account doesn’t exist yet: send at least ${Number(res.base) / 1e6} XRP to open it`
        )
      notes.push('This payment opens the recipient’s account.')
    }
    const drops = (fees.drops ?? {}) as { open_ledger_fee?: string; base_fee?: string }
    // what the open ledger asks now, a little over, never under the base fee
    const fee = BigInt(
      Math.max(Number(drops.base_fee ?? 10), Math.ceil(Number(drops.open_ledger_fee ?? 10) * 1.2))
    )
    const [currency, issuer] = token ? token.id.split('.') : []
    const payment: XrpPayment = {
      account: account.address,
      destination: to,
      amount: token ? { currency, issuer, value: decimal(amount, token.decimals) } : amount,
      fee,
      sequence: info.sequence,
      lastLedgerSequence: Number(current.ledger_current_index) + LEDGERS,
      signingPubKey: hex.decode(account.publicKey),
      destinationTag: memo === '' ? undefined : Number(memo)
    }
    return { payload: encodePayment(payment), fee, feeIsMost: false, notes, carry: payment }
  },

  async submit(fetch, account, payment, signature) {
    // maki's XRP app answers a length byte, then the DER signature
    const der = signature.subarray(1, 1 + signature[0])
    if (signature.length !== 1 + signature[0] || der[0] !== 0x30)
      throw new Error('maki’s XRP app gave a signature maki desktop can’t read')
    const signed = encodePayment(payment.carry as XrpPayment, der)
    const r = await rpc(fetch, account.network, 'submit', {
      tx_blob: hex.encode(signed).toUpperCase()
    })
    const result = String(r.engine_result ?? '')
    // queued, or applied for now: both go out; anything else the network turned down
    if (!/^(tesSUCCESS|terQUEUED)$/.test(result))
      throw new Error(`the network turned it down: ${r.engine_result_message ?? result}`)
    return transactionId(signed)
  }
}
