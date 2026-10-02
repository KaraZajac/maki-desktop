/**
 * Stand-ins for the account coins' servers, for tests (Node only): XRP's rippled, Stellar's Horizon,
 * Tron's TronGrid, api.kaspa.org, Aptos Labs' API, NEAR's RPC (with NearBlocks) and Koios, each answering what maki desktop's wallet asks of it, for the test phrase's
 * account holding some of the coin and of a token. What each is sent is read back here byte by byte,
 * apart from maki desktop's own encoding, and taken only if its signature checks out over the hash
 * the network has signed, by the account's own key, as the network would check it; each keeps what
 * it took.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { keccak_256, sha3_256 } from '@noble/hashes/sha3.js'
import { base58, base64, bech32, hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { addressAt, addressOfScript, transactionId } from './coins/kaspa'
import { accountAddress, PASSPHRASE } from './coins/stellar'
import { addressText } from './coins/tron'
import { classicAddress } from './coins/xrp'

type Answer = (
  method: string,
  path: string,
  body: string,
  bytes?: Uint8Array
) => Promise<[number, string]>

/** An Ed25519 key by SLIP-10 (every step hardened), as Stellar's, Aptos's and Solana's wallets make them. */
export function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let node = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  for (const i of path) {
    const index = Uint8Array.of(0x80 | (i >>> 24), (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff)
    node = hmac(sha512, node.slice(32), Uint8Array.of(0, ...node.slice(0, 32), ...index))
  }
  return node.slice(0, 32)
}

/** The test phrase's seed: "abandon" eleven times, then "about" (BIP 39's). */
export const TEST_SEED = hex.decode(
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
)

/** A decimal's text, from an integer and a power of ten: `5.25` from 525 and -2. */
function decimal(mantissa: bigint, exponent: number): string {
  if (mantissa === 0n) return '0'
  if (exponent >= 0) return (mantissa * 10n ** BigInt(exponent)).toString()
  const digits = mantissa.toString().padStart(1 - exponent, '0')
  const whole = digits.slice(0, exponent)
  const fraction = digits.slice(exponent).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

// ---- XRP ----

/** The test phrase's XRP account (xrpl.js's, as Ripple's Xpring SDK publishes it). */
export const XRP_ME = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3'
/** Another account the stand-in has, which holds RLUSD too. */
export const XRP_THEM = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
/** RLUSD: its issuer, and its currency code. */
export const XRP_RLUSD = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'
const RLUSD = '524C555344000000000000000000000000000000'

/** A payment the XRP stand-in took. */
export interface XrpSent {
  id: string
  account: string
  destination: string
  /** drops, or a token's amount as the ledger writes it */
  amount: bigint | { currency: string; issuer: string; value: string }
  fee: bigint
  sequence: number
  destinationTag?: number
}

/** The ledger's binary format, field by field: each one's type, field code, value and where it lies. */
function xrpFields(
  b: Uint8Array
): { type: number; field: number; value: Uint8Array; start: number; end: number }[] {
  const out: { type: number; field: number; value: Uint8Array; start: number; end: number }[] = []
  let i = 0
  const length = (): number => {
    const b1 = b[i++]
    if (b1 <= 192) return b1
    if (b1 <= 240) return 193 + (b1 - 193) * 256 + b[i++]
    const n = 12481 + (b1 - 241) * 65536 + b[i] * 256 + b[i + 1]
    i += 2
    return n
  }
  while (i < b.length) {
    const start = i
    let type = b[i] >> 4
    let field = b[i] & 15
    i++
    if (type === 0) type = b[i++]
    if (field === 0) field = b[i++]
    const len =
      type === 1
        ? 2
        : type === 2
          ? 4
          : type === 3
            ? 8
            : type === 5
              ? 32
              : type === 6
                ? b[i] & 0x80
                  ? 48
                  : 8
                : type === 7 || type === 8
                  ? length()
                  : type === 16
                    ? 1
                    : -1
    if (len < 0 || i + len > b.length)
      throw new Error(`a field the stand-in can't read (type ${type})`)
    out.push({ type, field, value: b.slice(i, i + len), start, end: i + len })
    i += len
  }
  return out
}

/** An amount field's value: drops, or a token's (its value, currency code and issuer). */
function xrpAmount(v: Uint8Array): XrpSent['amount'] {
  const n = BigInt(`0x${hex.encode(v.slice(0, 8))}`)
  if (!(n >> 63n)) {
    if (!((n >> 62n) & 1n)) throw new Error('a negative amount')
    return n & ((1n << 62n) - 1n)
  }
  const mantissa = n & ((1n << 54n) - 1n)
  const exponent = Number((n >> 54n) & 0xffn) - 97
  return {
    value: `${(n >> 62n) & 1n ? '' : '-'}${decimal(mantissa, exponent)}`,
    currency: hex.encode(v.slice(8, 28)).toUpperCase(),
    issuer: classicAddress(v.slice(28, 48))
  }
}

/**
 * The XRP Ledger, as rippled's JSON-RPC answers maki desktop's wallet: the account holds 100 XRP and
 * 25 RLUSD (one trust line), `XRP_THEM` 20 XRP, and no other account exists. A submitted payment is
 * taken if its signature checks out over what rippled hashes (SHA-512Half of `STX\0` and the
 * transaction without its signature) by its SigningPubKey, which must be the account's own.
 */
export function xrpStandIn(): { answer: Answer; sent: XrpSent[] } {
  const sent: XrpSent[] = []
  let sequence = 7
  const result = (r: object): [number, string] => [
    200,
    JSON.stringify({ result: { status: 'success', ...r } })
  ]
  const answer: Answer = async (_method, _path, body) => {
    const { method, params } = JSON.parse(body) as {
      method: string
      params: Record<string, string>[]
    }
    const p = params?.[0] ?? {}
    switch (method) {
      case 'account_info':
        if (p.account !== XRP_ME && p.account !== XRP_THEM)
          return result({
            status: 'error',
            error: 'actNotFound',
            error_message: 'Account not found.'
          })
        return result({
          account_data:
            p.account === XRP_ME
              ? { Account: XRP_ME, Balance: '100000000', Sequence: sequence, OwnerCount: 1 }
              : { Account: XRP_THEM, Balance: '20000000', Sequence: 3, OwnerCount: 1 }
        })
      case 'server_state':
        return result({
          state: { validated_ledger: { reserve_base: 1_000_000, reserve_inc: 200_000 } }
        })
      case 'account_lines':
        return result({
          lines:
            p.account === XRP_ME ? [{ account: XRP_RLUSD, currency: RLUSD, balance: '25' }] : []
        })
      case 'account_tx':
        return result({
          transactions: [
            {
              hash: 'C3D0D6C2C3C9E4B5F8A6E1D2B3C4A5F6E7D8C9B0A1F2E3D4C5B6A7980706F5E4',
              tx_json: {
                TransactionType: 'Payment',
                Account: XRP_THEM,
                Destination: XRP_ME,
                date: 812_000_000
              },
              meta: { delivered_amount: '100000000', TransactionResult: 'tesSUCCESS' }
            }
          ]
        })
      case 'ledger_current':
        return result({ ledger_current_index: 95_000_000 })
      case 'fee':
        return result({ drops: { base_fee: '10', open_ledger_fee: '10' } })
      case 'submit': {
        const blob = hex.decode(p.tx_blob.toLowerCase())
        const fields = xrpFields(blob)
        const one = (type: number, field: number): Uint8Array | undefined =>
          fields.find((f) => f.type === type && f.field === field)?.value
        const signature = fields.find((f) => f.type === 7 && f.field === 4)
        const key = one(7, 3)
        const account = one(8, 1)
        if (!signature || !key || !account)
          return result({ engine_result: 'temMALFORMED', engine_result_message: 'unsigned' })
        // what's signed: the transaction without its signature, after rippled's prefix
        const unsigned = Uint8Array.from([
          ...blob.slice(0, signature.start),
          ...blob.slice(signature.end)
        ])
        const digest = sha512(Uint8Array.of(0x53, 0x54, 0x58, 0x00, ...unsigned)).slice(0, 32)
        const good =
          secp256k1.verify(signature.value, digest, key, {
            prehash: false,
            format: 'der',
            lowS: true
          }) && hex.encode(ripemd160(sha256(key))) === hex.encode(account)
        if (!good || classicAddress(account) !== XRP_ME)
          return result({ engine_result: 'tefBAD_AUTH', engine_result_message: 'A bad signature.' })
        const tag = one(2, 14)
        const id = hex
          .encode(sha512(Uint8Array.of(0x54, 0x58, 0x4e, 0x00, ...blob)).slice(0, 32))
          .toUpperCase()
        sent.push({
          id,
          account: classicAddress(account),
          destination: classicAddress(one(8, 3)!),
          amount: xrpAmount(one(6, 1)!),
          fee: xrpAmount(one(6, 8)!) as bigint,
          sequence: new DataView(one(2, 4)!.buffer).getUint32(0),
          destinationTag: tag ? new DataView(tag.buffer).getUint32(0) : undefined
        })
        sequence++
        return result({
          engine_result: 'tesSUCCESS',
          engine_result_message: 'The transaction was applied.',
          tx_json: { hash: id }
        })
      }
    }
    return result({ status: 'error', error: 'unknownCmd' })
  }
  return { answer, sent }
}

// ---- Stellar ----

/** The test phrase's Stellar account (SEP-5's), another the stand-in has, and USDC's issuer. */
export const XLM_ME = 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'
export const XLM_THEM = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
export const XLM_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

/** A payment the Stellar stand-in took. */
export interface XlmSent {
  hash: string
  source: string
  fee: number
  memo: string
  kind: 'payment' | 'create'
  destination: string
  /** null for XLM */
  asset: { code: string; issuer: string } | null
  /** stroops (seven places) */
  amount: bigint
}

/** XDR, read as Stellar writes it: big-endian, every item padded to four bytes. */
class XdrReader {
  at = 0
  constructor(private b: Uint8Array) {}
  u32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 4).getUint32(0)
    this.at += 4
    return v
  }
  u64(): bigint {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 8).getBigUint64(0)
    this.at += 8
    return v
  }
  fixed(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error('short')
    const v = this.b.slice(this.at, this.at + n)
    this.at += n + ((4 - (n % 4)) % 4)
    return v
  }
  opaque(): Uint8Array {
    return this.fixed(this.u32())
  }
  account(): Uint8Array {
    if (this.u32() !== 0) throw new Error('not a plain account')
    return this.fixed(32)
  }
}

/**
 * Horizon, answering maki desktop's wallet: the account holds 250 XLM and 40 USDC (one trust line),
 * `XLM_THEM` 10 XLM and a USDC trust line, and no other account exists; the base fee is 100 stroops
 * and the base reserve half an XLM. A submitted envelope is taken if its one signature checks out
 * over the transaction's hash on the main network, by the source account's key, with its hint.
 */
export function stellarStandIn(): { answer: Answer; sent: XlmSent[] } {
  const sent: XlmSent[] = []
  let sequence = 123_456_789_012n
  const json = (status: number, body: object): [number, string] => [status, JSON.stringify(body)]
  const answer: Answer = async (method, path) => {
    const url = new URL(path, 'http://horizon')
    if (method === 'GET' && url.pathname === `/accounts/${XLM_ME}`)
      return json(200, {
        sequence: sequence.toString(),
        subentry_count: 1,
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: XLM_USDC,
            balance: '40.0000000'
          },
          { asset_type: 'native', balance: '250.0000000' }
        ]
      })
    if (method === 'GET' && url.pathname === `/accounts/${XLM_THEM}`)
      return json(200, {
        sequence: '1',
        subentry_count: 1,
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: XLM_USDC,
            balance: '0.0000000'
          },
          { asset_type: 'native', balance: '10.0000000' }
        ]
      })
    if (method === 'GET' && url.pathname === `/accounts/${XLM_ME}/payments`)
      return json(200, {
        _embedded: {
          records: [
            {
              type: 'create_account',
              funder: XLM_THEM,
              account: XLM_ME,
              starting_balance: '250.0000000',
              transaction_hash: 'b9d0b2292c4e09e8eb22d036171491e87b8d2086bf8b265874c8d182cb9c9020',
              created_at: '2026-09-30T12:00:00Z',
              transaction_successful: true
            }
          ]
        }
      })
    if (method === 'GET' && url.pathname.startsWith('/accounts/')) return json(404, { status: 404 })
    if (method === 'GET' && url.pathname === '/fee_stats')
      return json(200, { last_ledger_base_fee: '100', fee_charged: { p70: '100' } })
    if (method === 'GET' && url.pathname === '/ledgers')
      return json(200, { _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] } })
    if (method === 'POST' && url.pathname === '/transactions') {
      const failed = (code: string): [number, string] =>
        json(400, { title: 'Transaction Failed', extras: { result_codes: { transaction: code } } })
      const envelope = Uint8Array.from(Buffer.from(url.searchParams.get('tx') ?? '', 'base64'))
      const x = new XdrReader(envelope)
      if (x.u32() !== 2) return failed('tx_malformed')
      const start = x.at
      const source = x.account()
      const fee = x.u32()
      const seq = x.u64()
      const cond = x.u32()
      if (cond === 1) {
        x.u64()
        if (x.u64() * 1000n < BigInt(Date.now())) return failed('tx_too_late')
      } else if (cond !== 0) return failed('tx_malformed')
      const memoType = x.u32()
      const memo =
        memoType === 0
          ? ''
          : memoType === 1
            ? new TextDecoder().decode(x.opaque())
            : '(another kind)'
      if (x.u32() !== 1 || x.u32() !== 0) return failed('tx_malformed') // one operation, no source of its own
      const type = x.u32()
      let destination: Uint8Array
      let asset: XlmSent['asset'] = null
      let amount: bigint
      if (type === 0) {
        destination = x.account()
        amount = x.u64()
      } else if (type === 1) {
        destination = x.account()
        const kind = x.u32()
        if (kind === 1 || kind === 2) {
          const code = new TextDecoder().decode(x.fixed(kind === 1 ? 4 : 12)).replace(/\0+$/, '')
          asset = { code, issuer: accountAddress(x.account()) }
        } else if (kind !== 0) return failed('tx_malformed')
        amount = x.u64()
      } else return failed('tx_malformed')
      if (x.u32() !== 0) return failed('tx_malformed')
      const tx = envelope.slice(start, x.at)
      if (x.u32() !== 1) return failed('tx_bad_auth')
      const hint = x.fixed(4)
      const signature = x.opaque()
      if (x.at !== envelope.length) return failed('tx_malformed')
      const hash = sha256(
        Uint8Array.of(...sha256(new TextEncoder().encode(PASSPHRASE[0])), 0, 0, 0, 2, ...tx)
      )
      if (
        accountAddress(source) !== XLM_ME ||
        hex.encode(hint) !== hex.encode(source.slice(28)) ||
        !ed25519.verify(signature, hash, source)
      )
        return failed('tx_bad_auth')
      if (seq !== sequence + 1n) return failed('tx_bad_seq')
      sequence = seq
      sent.push({
        hash: hex.encode(hash),
        source: accountAddress(source),
        fee,
        memo,
        kind: type === 0 ? 'create' : 'payment',
        destination: accountAddress(destination),
        asset,
        amount
      })
      return json(200, { hash: hex.encode(hash), successful: true })
    }
    return json(404, { status: 404 })
  }
  return { answer, sent }
}

// ---- Tron ----

/** The test phrase's Tron account (TronLink's first), USDT's contract, and someone to pay. */
export const TRX_ME = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
export const TRX_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const TRX_THEM = addressText(Uint8Array.of(0x41, ...new Uint8Array(20).fill(0x11)))

/** A payment the Tron stand-in took. */
export interface TrxSent {
  txid: string
  owner: string
  to: string
  /** sun, or the token's smallest units */
  amount: bigint
  /** the token's contract; none for TRX */
  token?: string
  feeLimit?: bigint
}

/** Protocol buffers' fields, as they come: each one's number and its value (a varint or bytes). */
function protoFields(b: Uint8Array): { field: number; value: bigint | Uint8Array }[] {
  const out: { field: number; value: bigint | Uint8Array }[] = []
  let i = 0
  const varint = (): bigint => {
    let v = 0n
    for (let shift = 0n; ; shift += 7n) {
      if (i >= b.length) throw new Error('short')
      const byte = b[i++]
      v |= BigInt(byte & 0x7f) << shift
      if (!(byte & 0x80)) return v
    }
  }
  while (i < b.length) {
    const key = Number(varint())
    const wire = key & 7
    if (wire === 0) out.push({ field: key >> 3, value: varint() })
    else if (wire === 2) {
      const n = Number(varint())
      if (i + n > b.length) throw new Error('short')
      out.push({ field: key >> 3, value: b.slice(i, i + n) })
      i += n
    } else throw new Error(`a wire type the stand-in doesn't read: ${wire}`)
  }
  return out
}

const field = <T extends bigint | Uint8Array>(
  fields: { field: number; value: bigint | Uint8Array }[],
  n: number
): T | undefined => fields.find((f) => f.field === n)?.value as T | undefined

/**
 * TronGrid, answering maki desktop's wallet: the account holds 120 TRX and 30 USDT, the latest block
 * is now, a USDT transfer takes 64,285 energy at 100 sun. A broadcast transaction is taken if its
 * signature recovers, over the SHA-256 of its `raw_data`, to the key of the account that owns its
 * one contract, and it hasn't expired.
 */
export function tronStandIn(): { answer: Answer; sent: TrxSent[] } {
  const sent: TrxSent[] = []
  const json = (body: object): [number, string] => [200, JSON.stringify(body)]
  const answer: Answer = async (method, path, body) => {
    if (method === 'GET' && path === `/v1/accounts/${TRX_ME}`)
      return json({
        data: [{ balance: 120_000_000, trc20: [{ [TRX_USDT]: '30000000' }] }],
        success: true
      })
    if (method === 'GET' && path.startsWith(`/v1/accounts/${TRX_ME}/transactions/trc20`))
      return json({
        data: [
          {
            transaction_id: 'a3f1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80',
            token_info: { address: TRX_USDT, decimals: 6, symbol: 'USDT' },
            from: TRX_THEM,
            to: TRX_ME,
            value: '30000000',
            block_timestamp: 1_790_000_000_000
          }
        ],
        success: true
      })
    if (method === 'GET' && path.startsWith(`/v1/accounts/${TRX_ME}/transactions`))
      return json({ data: [], success: true })
    if (method === 'POST' && path === '/wallet/getnowblock') {
      const number = 78_824_404
      return json({
        blockID: number.toString(16).padStart(16, '0') + 'c0ffee'.repeat(8),
        block_header: { raw_data: { number, timestamp: Date.now() } }
      })
    }
    if (method === 'POST' && path === '/wallet/triggerconstantcontract')
      return json({ result: { result: true }, energy_used: 64_285 })
    if (method === 'POST' && path === '/wallet/getchainparameters')
      return json({ chainParameter: [{ key: 'getEnergyFee', value: 100 }] })
    if (method === 'POST' && path === '/wallet/broadcasthex') {
      const refused = (why: string): [number, string] =>
        json({
          result: false,
          code: 'SIGERROR',
          message: hex.encode(new TextEncoder().encode(why))
        })
      const tx = protoFields(hex.decode((JSON.parse(body) as { transaction: string }).transaction))
      const raw = field<Uint8Array>(tx, 1)
      const signature = field<Uint8Array>(tx, 2)
      if (!raw || signature?.length !== 65) return refused('unsigned')
      const r = protoFields(raw)
      if (Number(field<bigint>(r, 8) ?? 0n) < Date.now()) return refused('expired')
      const contracts = r.filter((f) => f.field === 11)
      if (contracts.length !== 1) return refused('one contract, please')
      const contract = protoFields(contracts[0].value as Uint8Array)
      const kind = Number(field<bigint>(contract, 1))
      const value = field<Uint8Array>(protoFields(field<Uint8Array>(contract, 2)!), 2)!
      const v = protoFields(value)
      const owner = addressText(field<Uint8Array>(v, 1)!)
      let sentNow: TrxSent
      const id = hex.encode(sha256(raw))
      if (kind === 1) {
        sentNow = {
          txid: id,
          owner,
          to: addressText(field<Uint8Array>(v, 2)!),
          amount: field<bigint>(v, 3) ?? 0n
        }
      } else if (kind === 31) {
        const data = field<Uint8Array>(v, 4)!
        if (hex.encode(data.slice(0, 4)) !== 'a9059cbb' || data.length !== 68)
          return refused('not a transfer')
        sentNow = {
          txid: id,
          owner,
          to: addressText(Uint8Array.of(0x41, ...data.slice(16, 36))),
          amount: BigInt(`0x${hex.encode(data.slice(36))}`),
          token: addressText(field<Uint8Array>(v, 2)!),
          feeLimit: field<bigint>(r, 18)
        }
      } else return refused(`a contract of type ${kind}`)
      // who signed: the key the signature recovers to, over the hash of raw_data
      const recovery = signature[64] >= 27 ? signature[64] - 27 : signature[64]
      let signer = ''
      try {
        const key = secp256k1.recoverPublicKey(
          Uint8Array.of(recovery, ...signature.slice(0, 64)),
          sha256(raw),
          { prehash: false }
        )
        const full = secp256k1.Point.fromBytes(key).toBytes(false)
        signer = addressText(Uint8Array.of(0x41, ...keccak_256(full.slice(1)).slice(12)))
      } catch {
        // no key: not signed
      }
      if (signer !== owner || owner !== TRX_ME) return refused('Validate signature error')
      sent.push(sentNow)
      return json({ result: true, txid: id })
    }
    return [404, '{}']
  }
  return { answer, sent }
}

// ---- Kaspa ----

/** The test phrase's Kaspa account (m/44'/111111'/0'): its first receiving address is Kastle's. */
const KAS_ACCOUNT = HDKey.fromMasterSeed(TEST_SEED).derive("m/44'/111111'/0'")
export const KAS_ME = addressAt(KAS_ACCOUNT, 0, 0, 0)
/** Its first change address, which holds a coin too, and its second, where change goes next. */
export const KAS_CHANGE = addressAt(KAS_ACCOUNT, 0, 1, 0)
export const KAS_NEXT_CHANGE = addressAt(KAS_ACCOUNT, 0, 1, 1)
/** Someone to pay. */
export const KAS_THEM = 'kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73'

/** A payment the Kaspa stand-in took. */
export interface KasSent {
  id: string
  inputs: { txid: string; index: number }[]
  outputs: { address: string | null; value: bigint }[]
  fee: bigint
}

/** Kaspa's signature hash for a version 0 transaction and SIGHASH_ALL (rusty-kaspa's `sighash`). */
export function kaspaSignatureHash(
  inputs: {
    txid: Uint8Array
    index: number
    sequence: bigint
    sigOps: number
    amount: bigint
    script: Uint8Array
  }[],
  outputs: { value: bigint; script: Uint8Array }[],
  n: number
): Uint8Array {
  const le = (n: bigint | number, bytes: number): number[] =>
    Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn))
  const hash = (b: number[]): number[] => [
    ...blake2b(Uint8Array.from(b), {
      dkLen: 32,
      key: new TextEncoder().encode('TransactionSigningHash')
    })
  ]
  const me = inputs[n]
  return Uint8Array.from(
    hash([
      ...le(0, 2),
      ...hash(inputs.flatMap((i) => [...i.txid, ...le(i.index, 4)])),
      ...hash(inputs.flatMap((i) => le(i.sequence, 8))),
      ...hash(inputs.map((i) => i.sigOps)),
      ...me.txid,
      ...le(me.index, 4),
      ...le(0, 2),
      ...le(me.script.length, 8),
      ...me.script,
      ...le(me.amount, 8),
      ...le(me.sequence, 8),
      me.sigOps,
      ...hash(
        outputs.flatMap((o) => [
          ...le(o.value, 8),
          ...le(0, 2),
          ...le(o.script.length, 8),
          ...o.script
        ])
      ),
      ...le(0, 8),
      ...new Array(20).fill(0),
      ...le(0, 8),
      // the native subnetwork, no payload: zeros
      ...new Array(32).fill(0),
      1
    ])
  )
}

/**
 * api.kaspa.org, answering maki desktop's wallet: the account's first receiving address holds a
 * coin of 50 KAS, its first change address one of 3; the DAG's score is far past both; fees are
 * 100 sompi a gram. A transaction is taken if every coin it spends is one of these, each input's
 * script is its BIP340 signature over Kaspa's signature hash (with the coin's amount and script,
 * as only the stand-in knows them) and SIGHASH_ALL, by the coin's own key, and it pays no more than
 * it spends; its coins are spent then, and its outputs new ones.
 */
export function kaspaStandIn(): { answer: Answer; sent: KasSent[] } {
  const sent: KasSent[] = []
  const coins = new Map<string, { address: string; amount: bigint; script: Uint8Array }>()
  const fund = (txid: string, index: number, address: string, amount: bigint): void => {
    const key = KAS_ACCOUNT.deriveChild(address === KAS_ME ? 0 : 1).deriveChild(0).publicKey!
    coins.set(`${txid}:${index}`, {
      address,
      amount,
      script: Uint8Array.of(0x20, ...key.subarray(1), 0xac)
    })
  }
  fund('11'.repeat(32), 0, KAS_ME, 5_000_000_000n)
  fund('22'.repeat(32), 1, KAS_CHANGE, 300_000_000n)
  const json = (status: number, body: unknown): [number, string] => [status, JSON.stringify(body)]
  const answer: Answer = async (method, path, body) => {
    if (method === 'POST' && path === '/addresses/active') {
      const { addresses } = JSON.parse(body) as { addresses: string[] }
      return json(
        200,
        addresses.map((address) => ({
          address,
          active: address === KAS_ME || address === KAS_CHANGE
        }))
      )
    }
    if (method === 'POST' && path === '/addresses/utxos') {
      const { addresses } = JSON.parse(body) as { addresses: string[] }
      return json(
        200,
        [...coins.entries()]
          .filter(([, c]) => addresses.includes(c.address))
          .map(([outpoint, c]) => ({
            address: c.address,
            outpoint: {
              transactionId: outpoint.split(':')[0],
              index: Number(outpoint.split(':')[1])
            },
            utxoEntry: {
              amount: c.amount.toString(),
              scriptPublicKey: { scriptPublicKey: hex.encode(c.script) },
              blockDaaScore: '80000000',
              isCoinbase: false
            }
          }))
      )
    }
    if (method === 'GET' && path.startsWith(`/addresses/${KAS_ME}/full-transactions`))
      return json(200, [
        {
          transaction_id: '11'.repeat(32),
          block_time: 1_790_000_000_000,
          is_accepted: true,
          inputs: [
            { previous_outpoint_address: KAS_THEM, previous_outpoint_amount: 5_100_000_000 }
          ],
          outputs: [
            { amount: 5_000_000_000, script_public_key_address: KAS_ME },
            { amount: 99_000_000, script_public_key_address: KAS_THEM }
          ]
        }
      ])
    if (method === 'GET' && path.startsWith('/addresses/')) return json(200, [])
    if (method === 'GET' && path === '/info/fee-estimate')
      return json(200, {
        priorityBucket: { feerate: 100 },
        normalBuckets: [{ feerate: 100 }],
        lowBuckets: [{ feerate: 100 }]
      })
    if (method === 'GET' && path === '/info/blockdag')
      return json(200, { virtualDaaScore: '90000000' })
    if (method === 'POST' && path === '/transactions') {
      const refused = (error: string): [number, string] => json(400, { error })
      const { transaction: t } = JSON.parse(body) as {
        transaction: {
          version: number
          inputs: {
            previousOutpoint: { transactionId: string; index: number }
            signatureScript: string
            sequence: number
            sigOpCount: number
          }[]
          outputs: {
            amount: number
            scriptPublicKey: { version: number; scriptPublicKey: string }
          }[]
          lockTime: number
          subnetworkId: string
        }
      }
      // amounts as written, not as JavaScript's numbers would read them
      const values = [...body.matchAll(/"amount":(\d+)/g)].map((m) => BigInt(m[1]))
      if (t.version !== 0 || t.lockTime !== 0 || t.subnetworkId !== '0'.repeat(40))
        return refused('not a plain transaction')
      const inputs = t.inputs.map((i) => {
        const coin = coins.get(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`)
        return (
          coin && {
            txid: hex.decode(i.previousOutpoint.transactionId),
            index: i.previousOutpoint.index,
            sequence: BigInt(i.sequence),
            sigOps: i.sigOpCount,
            amount: coin.amount,
            script: coin.script,
            signature: hex.decode(i.signatureScript)
          }
        )
      })
      if (inputs.some((i) => !i)) return refused('a coin that isn’t there')
      const outputs = t.outputs.map((o, n) => ({
        value: values[n],
        script: hex.decode(o.scriptPublicKey.scriptPublicKey)
      }))
      for (const [n, i] of inputs.entries()) {
        const s = i!.signature
        if (s.length !== 66 || s[0] !== 0x41 || s[65] !== 1)
          return refused('not a signature script')
        const hash = kaspaSignatureHash(
          inputs as NonNullable<(typeof inputs)[number]>[],
          outputs,
          n
        )
        if (!schnorr.verify(s.subarray(1, 65), hash, i!.script.subarray(1, 33)))
          return refused('a bad signature')
      }
      const spent = inputs.reduce((sum, i) => sum + i!.amount, 0n)
      const paid = outputs.reduce((sum, o) => sum + o.value, 0n)
      if (paid > spent) return refused('it pays more than it spends')
      const tx = {
        inputs: t.inputs.map((i, n) => ({
          txid: i.previousOutpoint.transactionId,
          index: i.previousOutpoint.index,
          amount: inputs[n]!.amount,
          script: inputs[n]!.script,
          chain: 0 as const,
          keyIndex: 0
        })),
        outputs
      }
      const id = transactionId(tx)
      for (const i of t.inputs)
        coins.delete(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`)
      sent.push({
        id,
        inputs: tx.inputs.map(({ txid, index }) => ({ txid, index })),
        outputs: outputs.map((o) => ({ address: addressOfScript(o.script, 0), value: o.value })),
        fee: spent - paid
      })
      return json(200, { transactionId: id })
    }
    return json(404, { detail: 'Not Found' })
  }
  return { answer, sent }
}

// ---- Aptos ----

/** The test phrase's Aptos account (Petra's first), its key, and someone to pay. */
export const APT_ME = '0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf'
export const APT_THEM = '0xf867372dfec13fb6c0740d4b574363685e10e6f243e9554ffa8f6e698e940efa'
/** Circle's USDC on Aptos: its metadata's address. */
export const APT_USDC = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'

/** A transaction the Aptos stand-in took. */
export interface AptSent {
  hash: string
  sender: string
  sequence: bigint
  /** `module::function`, its type arguments and its arguments (each as BCS) */
  function: string
  types: string[]
  args: string[]
  maxGas: bigint
  gasPrice: bigint
}

/** A RawTransaction read back (BCS), as far as an entry function goes; null if it's anything else. */
function aptosRaw(raw: Uint8Array) {
  let at = 0
  const take = (n: number): Uint8Array => {
    if (at + n > raw.length) throw new Error('short')
    return raw.slice(at, (at += n))
  }
  const u64 = (): bigint => new DataView(take(8).buffer).getBigUint64(0, true)
  const uleb = (): number => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const b = take(1)[0]
      v += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return v
    }
  }
  const str = (): string => new TextDecoder().decode(take(uleb()))
  const address = (): string => `0x${hex.encode(take(32))}`
  const sender = address()
  const sequence = u64()
  if (uleb() !== 2) return null
  const fn = `${address()}::${str()}::${str()}`
  const types: string[] = []
  for (let n = uleb(); n > 0; n--) {
    if (uleb() !== 7) return null
    types.push(`${address()}::${str()}::${str()}`)
    if (uleb() !== 0) return null
  }
  const args: string[] = []
  for (let n = uleb(); n > 0; n--) args.push(hex.encode(take(uleb())))
  const maxGas = u64()
  const gasPrice = u64()
  const expiration = u64()
  const chain = take(1)[0]
  if (at !== raw.length) return null
  return { sender, sequence, fn, types, args, maxGas, gasPrice, expiration, chain }
}

/**
 * Aptos Labs' API, answering maki desktop's wallet: the account (sequence 16, its own key) holds 2.5
 * APT and 40 USDC; gas is 100 octas a unit and a transfer uses 12 units. A simulation must carry no
 * signature (Aptos's simulations refuse a real one); a transaction sent must be signed: Ed25519
 * over SHA3-256("APTOS::RawTransaction") and the transaction, by the key whose SHA3-256 (with the
 * scheme's 0) is the sender's address, at the account's sequence, on the main network's chain, not
 * expired.
 */
export function aptosStandIn(): { answer: Answer; sent: AptSent[] } {
  const sent: AptSent[] = []
  let sequence = 16n
  const json = (status: number, body: unknown): [number, string] => [status, JSON.stringify(body)]
  /** a signed transaction: the raw one, then an Ed25519 authenticator (99 bytes) */
  const split = (b: Uint8Array) => {
    const auth = b.subarray(b.length - 99)
    if (auth[0] !== 0 || auth[1] !== 32 || auth[34] !== 64) return null
    return {
      raw: b.subarray(0, b.length - 99),
      key: auth.subarray(2, 34),
      signature: auth.subarray(35)
    }
  }
  const answer: Answer = async (method, path, _body, bytes = new Uint8Array()) => {
    if (method === 'GET' && path === `/v1/accounts/${APT_ME}`)
      return json(200, { sequence_number: sequence.toString(), authentication_key: APT_ME })
    if (method === 'GET' && path === `/v1/accounts/${APT_ME}/balance/0x1::aptos_coin::AptosCoin`)
      return json(200, 250_000_000)
    if (method === 'GET' && path === `/v1/accounts/${APT_ME}/balance/${APT_USDC}`)
      return json(200, 40_000_000)
    if (method === 'GET' && path.startsWith(`/v1/accounts/${APT_ME}/balance/`)) return json(200, 0)
    if (method === 'GET' && path === '/v1/estimate_gas_price')
      return json(200, {
        deprioritized_gas_estimate: 100,
        gas_estimate: 100,
        prioritized_gas_estimate: 150
      })
    if (method === 'POST' && path === '/v1/graphql')
      return json(200, {
        data: {
          account_transactions: [
            {
              transaction_version: 3_000_000_123,
              fungible_asset_activities: [
                {
                  amount: 250_000_000,
                  type: '0x1::fungible_asset::Deposit',
                  asset_type: '0x000000000000000000000000000000000000000000000000000000000000000a',
                  is_transaction_success: true,
                  transaction_timestamp: '2026-09-30T12:00:00.000000',
                  is_gas_fee: false
                }
              ]
            }
          ]
        }
      })
    if (method === 'POST' && path.startsWith('/v1/transactions')) {
      const signed = split(bytes)
      const tx = signed && aptosRaw(signed.raw)
      if (!signed || !tx)
        return json(400, { message: 'not a signed transaction maki desktop makes' })
      if (path.startsWith('/v1/transactions/simulate')) {
        if (signed.signature.some((b) => b !== 0))
          return json(400, { message: 'a simulation is not signed' })
        return json(200, [{ success: true, vm_status: 'Executed successfully', gas_used: '12' }])
      }
      const message = Uint8Array.from([
        ...sha3_256(new TextEncoder().encode('APTOS::RawTransaction')),
        ...signed.raw
      ])
      const owner = `0x${hex.encode(sha3_256(Uint8Array.from([...signed.key, 0])))}`
      if (
        owner !== tx.sender ||
        tx.sender !== APT_ME ||
        !ed25519.verify(signed.signature, message, signed.key)
      )
        return json(400, { message: 'Invalid transaction: INVALID_SIGNATURE' })
      if (tx.sequence !== sequence) return json(400, { message: 'SEQUENCE_NUMBER_TOO_OLD' })
      if (tx.chain !== 1) return json(400, { message: 'BAD_CHAIN_ID' })
      if (tx.expiration * 1000n < BigInt(Date.now()))
        return json(400, { message: 'TRANSACTION_EXPIRED' })
      const hash = `0x${hex.encode(sha3_256(Uint8Array.from([...sha3_256(new TextEncoder().encode('APTOS::Transaction')), 0, ...bytes])))}`
      sequence++
      sent.push({
        hash,
        sender: tx.sender,
        sequence: tx.sequence,
        function: tx.fn.replace(/^0x0+1::/, '0x1::'),
        types: tx.types,
        args: tx.args,
        maxGas: tx.maxGas,
        gasPrice: tx.gasPrice
      })
      return json(202, { hash })
    }
    return json(404, { message: 'not found' })
  }
  return { answer, sent }
}

// ---- NEAR ----

/** The test phrase's NEAR account (implicit: its key's hex), a named account, and USDC's contract. */
export const NEAR_ME = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
export const NEAR_THEM = 'bob.near'
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

/** A transaction the NEAR stand-in took. */
export interface NearSent {
  hash: string
  signer: string
  receiver: string
  nonce: bigint
  /** each action: a transfer's deposit, or a call's method, arguments, gas and deposit */
  actions: ({ transfer: bigint } | { method: string; args: string; gas: bigint; deposit: bigint })[]
}

/**
 * NEAR's RPC and NearBlocks, answering maki desktop's wallet: the account holds 12.5 NEAR (182
 * bytes stored) and 40 USDC; bob.near exists but isn't signed up for USDC (its contract asks 0.00125
 * NEAR for that); the latest block's hash is fixed. A transaction sent is taken if it's the
 * account's (its signer and key), at the key's next nonce, on that block, and Ed25519-signed over
 * its SHA-256 by that key.
 */
export function nearStandIn(): { answer: Answer; sent: NearSent[] } {
  const sent: NearSent[] = []
  let nonce = 117_000_000_000_000n
  const blockHash = new Uint8Array(32).fill(7)
  const json = (body: unknown): [number, string] => [200, JSON.stringify(body)]
  const ok = (result: unknown): [number, string] => json({ jsonrpc: '2.0', id: 'maki', result })
  const error = (name: string, data: string): [number, string] =>
    json({
      jsonrpc: '2.0',
      id: 'maki',
      error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, data }
    })
  const bytesOf = (v: unknown): number[] => [...new TextEncoder().encode(JSON.stringify(v))]
  const answer: Answer = async (method, path, body) => {
    if (method === 'GET' && path.startsWith(`/nearblocks/v1/account/${NEAR_ME}/txns-only`))
      return json({
        txns: [
          {
            transaction_hash: 'FMzgJy1CP6y73Pfp6q7iKoZ1o73wmaLwFwcBSbWSjFPL',
            signer_account_id: NEAR_THEM,
            receiver_account_id: NEAR_ME,
            block_timestamp: '1790000000000000000',
            actions_agg: { deposit: 1.25e25 },
            outcomes: { status: true }
          }
        ]
      })
    if (method === 'GET' && path.startsWith(`/nearblocks/v1/account/${NEAR_ME}/ft-txns`))
      return json({
        txns: [
          {
            transaction_hash: '97FmXVRNTWMuuP39YyT95sg21TKHo1wzu5QFAzFY2ARS',
            involved_account_id: NEAR_THEM,
            delta_amount: '40000000',
            block_timestamp: '1790000100000000000',
            outcomes: { status: true },
            ft: { contract: NEAR_USDC, symbol: 'USDC', decimals: 6 }
          }
        ]
      })
    if (method !== 'POST' || path !== '/') return [404, '{}']
    const { method: call, params } = JSON.parse(body) as {
      method: string
      params: Record<string, string>
    }
    if (call === 'block')
      return ok({ header: { hash: base58.encode(blockHash), height: 218_000_000 } })
    if (call === 'gas_price') return ok({ gas_price: '100000000' })
    if (call === 'query' && params.request_type === 'view_account') {
      if (params.account_id === NEAR_ME)
        return ok({ amount: '12500000000000000000000000', locked: '0', storage_usage: 182 })
      if (params.account_id === NEAR_THEM)
        return ok({ amount: '1000000000000000000000000', locked: '0', storage_usage: 300 })
      return error('UNKNOWN_ACCOUNT', `account ${params.account_id} does not exist while viewing`)
    }
    if (call === 'query' && params.request_type === 'view_access_key')
      return ok({ nonce: Number(nonce), permission: 'FullAccess' })
    if (call === 'query' && params.request_type === 'call_function') {
      const args = JSON.parse(new TextDecoder().decode(base64.decode(params.args_base64))) as {
        account_id?: string
      }
      const result =
        params.method_name === 'ft_balance_of'
          ? params.account_id === NEAR_USDC && args.account_id === NEAR_ME
            ? '40000000'
            : '0'
          : params.method_name === 'storage_balance_of'
            ? args.account_id === NEAR_ME
              ? { total: '1250000000000000000000', available: '0' }
              : null
            : params.method_name === 'storage_balance_bounds'
              ? { min: '1250000000000000000000', max: '1250000000000000000000' }
              : undefined
      if (result === undefined) return error('NO_SUCH_METHOD', params.method_name)
      return ok({ result: bytesOf(result), logs: [] })
    }
    if (call === 'send_tx') {
      const signed = base64.decode(params.signed_tx_base64)
      const tx = signed.subarray(0, signed.length - 65)
      const signature = signed.subarray(signed.length - 64)
      // read it back: borsh
      let at = 0
      const take = (n: number): Uint8Array => tx.slice(at, (at += n))
      const u32 = (): number => new DataView(take(4).buffer).getUint32(0, true)
      const int = (n: number): bigint =>
        [...take(n)].reduceRight((v, x) => (v << 8n) | BigInt(x), 0n)
      const str = (): string => new TextDecoder().decode(take(u32()))
      const signer = str()
      const keyType = take(1)[0]
      const key = take(32)
      const txNonce = int(8)
      const receiver = str()
      const block = take(32)
      const actions: NearSent['actions'] = []
      for (let n = u32(); n > 0; n--) {
        const kind = take(1)[0]
        if (kind === 3) actions.push({ transfer: int(16) })
        else if (kind === 2)
          actions.push({ method: str(), args: str(), gas: int(8), deposit: int(16) })
        else return error('INVALID_TRANSACTION', 'an action the stand-in doesn’t take')
      }
      if (
        at !== tx.length ||
        signed[signed.length - 65] !== 0 ||
        keyType !== 0 ||
        signer !== NEAR_ME ||
        hex.encode(key) !== NEAR_ME ||
        !ed25519.verify(signature, sha256(tx), key)
      )
        return error('INVALID_TRANSACTION', 'InvalidSignature')
      if (txNonce !== nonce + 1n) return error('INVALID_TRANSACTION', 'InvalidNonce')
      if (hex.encode(block) !== hex.encode(blockHash))
        return error('INVALID_TRANSACTION', 'Expired')
      nonce = txNonce
      const hash = base58.encode(sha256(tx))
      sent.push({ hash, signer, receiver, nonce: txNonce, actions })
      return ok({ final_execution_status: 'INCLUDED', transaction: { hash } })
    }
    return error('NO_SUCH_METHOD', call)
  }
  return { answer, sent }
}

// ---- Cardano ----

/**
 * CBOR, read back from `start`: numbers, bytes, text, arrays, maps (as entries), tags (their item),
 * simple values; with where the item ends.
 */
export function cborRead(b: Uint8Array, start = 0): [unknown, number] {
  let at = start
  const take = (n: number): Uint8Array => {
    if (at + n > b.length) throw new Error('short')
    return b.slice(at, (at += n))
  }
  const item = (): unknown => {
    const first = take(1)[0]
    const major = first >> 5
    const info = first & 31
    let n = BigInt(info)
    if (info >= 24) {
      if (info > 27) throw new Error('an indefinite length')
      n = [...take(1 << (info - 24))].reduce((v, x) => (v << 8n) | BigInt(x), 0n)
    }
    if (major === 0) return n
    if (major === 1) return -1n - n
    if (major === 2) return take(Number(n))
    if (major === 3) return new TextDecoder().decode(take(Number(n)))
    if (major === 4) return Array.from({ length: Number(n) }, item)
    if (major === 5) return Array.from({ length: Number(n) }, () => [item(), item()] as const)
    if (major === 6) return item()
    return info === 21 ? true : info === 20 ? false : null
  }
  return [item(), at]
}

/** Its first address, and CIP-19's base address example: someone to pay. */
export const ADA_ME =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'
export const ADA_CHANGE =
  'addr1qykhadtnvjpkxh76xgr0mu4huc9tg800x2sxsqemn9uz8jh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq28kufu'
export const ADA_STAKE = 'stake1u8j40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzaskqlx2l'
export const ADA_THEM =
  'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x'
/** SNEK: a token maki knows (its policy, and its name's hex). */
export const ADA_SNEK = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b'

/** A transaction the Cardano stand-in took. */
export interface AdaSent {
  id: string
  inputs: string[]
  outputs: { address: string; lovelace: bigint; assets: Record<string, bigint> }[]
  fee: bigint
  witnesses: number
}

/**
 * Koios, answering maki desktop's wallet: the account's first address holds a coin of 120 ADA and
 * 500 SNEK, its first change address one of 5 ADA; fees are mainnet's (44 a byte, 155,381 more,
 * 4,310 a byte for each output). A transaction is taken if every coin it spends is one of these,
 * each coin's payment key has signed its body's hash (Ed25519, a witness each, nothing else), it
 * pays at least the ledger's fee for its size, it balances (ADA and every token), every output holds
 * at least 1 ADA, and its slot isn't past.
 */
export function cardanoStandIn(
  held: [string, { address: string; lovelace: bigint; assets: Record<string, bigint> }][] = [
    [
      `${'31'.repeat(32)}#0`,
      { address: ADA_ME, lovelace: 120_000_000n, assets: { [ADA_SNEK]: 500n } }
    ],
    [`${'32'.repeat(32)}#1`, { address: ADA_CHANGE, lovelace: 5_000_000n, assets: {} }]
  ]
): { answer: Answer; sent: AdaSent[] } {
  const sent: AdaSent[] = []
  const tipSlot = 199_350_706n
  const addressBytes = (a: string): Uint8Array =>
    bech32.fromWords(bech32.decode(a as `${string}1${string}`, 200).words)
  const coins = new Map(held)
  const json = (status: number, body: unknown): [number, string] => [status, JSON.stringify(body)]
  const refused = (why: string): [number, string] => [400, why]
  const answer: Answer = async (method, path, _body, bytes = new Uint8Array()) => {
    if (method === 'GET' && path === '/tip')
      return json(200, [{ epoch_no: 659, abs_slot: Number(tipSlot) }])
    if (method === 'GET' && path.startsWith('/epoch_params'))
      return json(200, [
        {
          epoch_no: 659,
          min_fee_a: 44,
          min_fee_b: 155381,
          coins_per_utxo_size: '4310',
          max_tx_size: 16384
        }
      ])
    if (method === 'POST' && path === '/account_info')
      return json(200, [{ stake_address: ADA_STAKE, rewards_available: '0' }])
    if (method === 'POST' && path === '/account_utxos')
      return json(
        200,
        [...coins.entries()].map(([outpoint, c]) => ({
          tx_hash: outpoint.split('#')[0],
          tx_index: Number(outpoint.split('#')[1]),
          address: c.address,
          value: c.lovelace.toString(),
          asset_list: Object.entries(c.assets).map(([unit, q]) => ({
            policy_id: unit.slice(0, 56),
            asset_name: unit.slice(56),
            quantity: q.toString()
          }))
        }))
      )
    if (method === 'POST' && path.startsWith('/account_txs'))
      return json(200, [{ tx_hash: '31'.repeat(32), block_time: 1_790_000_000 }])
    if (method === 'POST' && path === '/tx_info')
      return json(200, [
        {
          tx_hash: '31'.repeat(32),
          inputs: [{ stake_addr: null, value: '130000000' }],
          outputs: [{ stake_addr: ADA_STAKE, value: '120000000' }]
        }
      ])
    if (method === 'POST' && path === '/submittx') {
      // the transaction: an array of four, its body first; the body's own bytes are what's hashed
      let bodyBytes: Uint8Array
      let witnessSet: [unknown, [Uint8Array, Uint8Array][]][]
      try {
        if (bytes[0] !== 0x84) throw new Error('not four items')
        const [, bodyEnd] = cborRead(bytes, 1)
        bodyBytes = bytes.subarray(1, bodyEnd)
        const [set, end] = cborRead(bytes, bodyEnd)
        witnessSet = set as typeof witnessSet
        if (bytes.length !== end + 2 || bytes[end] !== 0xf5 || bytes[end + 1] !== 0xf6)
          throw new Error('not valid, or with metadata')
      } catch (e) {
        return refused(`not a transaction maki desktop makes: ${(e as Error).message}`)
      }
      const fields = new Map(
        (cborRead(bodyBytes)[0] as [bigint, unknown][]).map(([k, v]) => [Number(k), v])
      )
      if ([...fields.keys()].join() !== '0,1,2,3') return refused('a body with more than a payment')
      const hash = blake2b(bodyBytes, { dkLen: 32 })
      const witnesses = witnessSet.find(([k]) => k === 0n)?.[1] ?? []
      const signedBy = new Set<string>()
      for (const [key, sig] of witnesses) {
        if (!ed25519.verify(sig, hash, key)) return refused('a witness that doesn’t check out')
        signedBy.add(hex.encode(blake2b(key, { dkLen: 28 })))
      }
      let inLovelace = 0n
      const balance = new Map<string, bigint>()
      const inputs: string[] = []
      for (const [txid, index] of fields.get(0) as [Uint8Array, bigint][]) {
        const outpoint = `${hex.encode(txid)}#${index}`
        const coin = coins.get(outpoint)
        if (!coin) return refused(`a coin that isn’t there: ${outpoint}`)
        if (!signedBy.has(hex.encode(addressBytes(coin.address).subarray(1, 29))))
          return refused('a coin its key didn’t sign for')
        inLovelace += coin.lovelace
        for (const [unit, q] of Object.entries(coin.assets))
          balance.set(unit, (balance.get(unit) ?? 0n) + q)
        inputs.push(outpoint)
      }
      const outputs: AdaSent['outputs'] = []
      let outLovelace = 0n
      for (const [address, v] of fields.get(1) as [
        Uint8Array,
        bigint | [bigint, [Uint8Array, [Uint8Array, bigint][]][]]
      ][]) {
        const lovelace = Array.isArray(v) ? v[0] : v
        const assets: Record<string, bigint> = {}
        if (Array.isArray(v))
          for (const [policy, names] of v[1])
            for (const [name, q] of names) {
              const unit = hex.encode(policy) + hex.encode(name)
              assets[unit] = q
              balance.set(unit, (balance.get(unit) ?? 0n) - q)
            }
        outputs.push({
          address: bech32.encode(
            address[0] & 0x0f ? 'addr' : 'addr_test',
            bech32.toWords(address),
            200
          ),
          lovelace,
          assets
        })
        outLovelace += lovelace
      }
      const fee = fields.get(2) as bigint
      const ttl = fields.get(3) as bigint
      if (fee < 44n * BigInt(bytes.length) + 155_381n) return refused('FeeTooSmallUTxO')
      if (inLovelace !== outLovelace + fee || [...balance.values()].some((q) => q !== 0n))
        return refused('ValueNotConservedUTxO')
      if (outputs.some((o) => o.lovelace < 1_000_000n)) return refused('BabbageOutputTooSmallUTxO')
      if (ttl <= tipSlot) return refused('OutsideValidityIntervalUTxO')
      const id = hex.encode(hash)
      for (const i of inputs) coins.delete(i)
      sent.push({ id, inputs, outputs, fee, witnesses: witnesses.length })
      return json(202, id)
    }
    return [404, '{}']
  }
  return { answer, sent }
}
