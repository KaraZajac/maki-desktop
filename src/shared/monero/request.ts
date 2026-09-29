/**
 * What maki is asked to sign, and what comes back: the Monero app's request (`maki_xmr::request`
 * in the firmware: the outputs spent, each in its ring of 16 as the chain has them, and the
 * payments, the change and the fee) and maki's signed transaction (`maki_xmr::spend::Signed`).
 * maki makes the rest of the transaction itself: the outputs' keys, the range proof, the
 * signatures.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { Reader, Writer } from './transaction'
import type { Network } from './xmr'

export interface RingMember {
  /** its global output index */
  global: bigint
  key: Uint8Array
  commitment: Uint8Array
}

export interface RequestInput {
  amount: bigint
  /** the public key its transaction derives it with: the transaction's own, or its additional key */
  txKey: Uint8Array
  /** its index among its transaction's outputs */
  index: bigint
  /** the subaddress (of the request's account) it was paid to */
  subaddress: number
  /** where it is in the ring */
  real: number
  /** in order of global index */
  ring: RingMember[]
}

export interface MakiRequest {
  network: Network
  /** the account (Monero's "major" index) the inputs are from and the change goes back to */
  account: number
  fee: bigint
  change: bigint
  payments: { address: string; amount: bigint }[]
  inputs: RequestInput[]
}

const NETWORKS: Network[] = ['mainnet', 'testnet', 'stagenet']

export function encodeRequest(r: MakiRequest): Uint8Array {
  const ring = r.inputs[0]?.ring.length ?? 0
  const w = new Writer()
    .u8(1)
    .u8(NETWORKS.indexOf(r.network))
    .u32(r.account)
    .u64(r.fee)
    .u64(r.change)
  w.u8(r.payments.length)
  for (const p of r.payments) {
    const address = new TextEncoder().encode(p.address)
    w.u64(p.amount).u8(address.length).raw(address)
  }
  w.u8(r.inputs.length).u8(ring)
  for (const i of r.inputs) {
    if (i.ring.length !== ring) throw new Error('rings of different sizes')
    w.u64(i.amount).key(i.txKey).u64(i.index).u32(i.subaddress).u8(i.real)
    for (const m of i.ring) w.u64(m.global).key(m.key).key(m.commitment)
  }
  return w.finish()
}

/** What an output of the signed transaction is: a payment's index, the change, or wallet2's output of nothing. */
export type Paid = number | 'change' | 'dummy'

export interface Signed {
  transaction: Uint8Array
  /** the transaction's secret key, and any additional ones: what proves a payment */
  txKey: Uint8Array
  additionalKeys: Uint8Array[]
  outputs: Paid[]
  /** outputs coming back to the wallet: their index, and their key image */
  own: { index: number; keyImage: Uint8Array }[]
}

export function decodeSigned(bytes: Uint8Array): Signed {
  const r = new Reader(bytes)
  const transaction = r.take(r.u32()).slice()
  const txKey = r.key()
  const additionalKeys = Array.from({ length: r.u8() }, () => r.key())
  const outputs = Array.from(r.take(r.u8()), (b): Paid =>
    b === 0xfe ? 'change' : b === 0xff ? 'dummy' : b
  )
  const own = Array.from({ length: r.u8() }, () => ({ index: r.u8(), keyImage: r.key() }))
  if (!r.done) throw new Error('bytes after the signed transaction')
  return { transaction, txKey, additionalKeys, outputs, own }
}
