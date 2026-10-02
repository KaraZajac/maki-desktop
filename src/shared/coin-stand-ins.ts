/**
 * Stand-ins for the account coins' servers, for tests (Node only): XRP's rippled, Stellar's Horizon
 * and Tron's TronGrid, each answering what maki desktop's wallet asks of it, for the test phrase's
 * account holding some of the coin and of a token. What each is sent is read back here byte by byte,
 * apart from maki desktop's own encoding, and taken only if its signature checks out over the hash
 * the network has signed, by the account's own key, as the network would check it; each keeps what
 * it took.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import { accountAddress, PASSPHRASE } from './coins/stellar'
import { addressText } from './coins/tron'
import { classicAddress } from './coins/xrp'

type Answer = (method: string, path: string, body: string) => Promise<[number, string]>

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
