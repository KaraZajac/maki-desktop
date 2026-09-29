/**
 * Paying from maki desktop's own Monero wallet: which outputs to spend, their rings, and the fee,
 * for maki to make the transaction from. maki's transactions are laid out as wallet2's are, so
 * their size, and the fee it takes at the node's rate, is known to the byte before maki makes one.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import { makeRings } from './decoys'
import type { MakiRequest } from './request'
import type { Output, Wallet } from './wallet'
import { type Address, decodeAddress, equal, subaddressKeys, varint } from './xmr'

/** The most inputs maki spends at once. */
export const MAX_INPUTS = 16

const vlen = (n: number | bigint): number => varint(n).length

function sameAddress(
  a: { spend: Uint8Array; view: Uint8Array },
  b: { spend: Uint8Array; view: Uint8Array }
): boolean {
  return equal(a.spend, b.spend) && equal(a.view, b.view)
}

/**
 * The length of the extra maki writes (as wallet2 does): the transaction's key, the outputs' own
 * keys when paying a subaddress and anything else, and a payment ID (an integrated address's, or
 * a dummy one with two outputs or fewer and one place paid).
 */
export function extraLength(r: MakiRequest, own: { spend: Uint8Array; view: Uint8Array }): number {
  const outputs = outputCount(r)
  const change = r.change > 0n ? own : null
  const dests = r.payments.map((p) => decodeAddress(p.address)!)
  const distinct: Address[] = []
  for (const d of dests) {
    if (change && sameAddress(d, change)) continue
    if (!distinct.some((x) => sameAddress(x, d))) distinct.push(d)
  }
  const subaddresses = distinct.filter((d) => d.kind === 'subaddress').length
  const standard = distinct.length - subaddresses
  let len = 33
  if (subaddresses > 0 && (standard > 0 || subaddresses > 1))
    len += 1 + vlen(outputs) + 32 * outputs
  const paymentId = dests.some((d) => d.kind === 'integrated')
  if (paymentId || (outputs <= 2 && distinct.length <= 1)) len += 11
  return len
}

export function outputCount(r: MakiRequest): number {
  return r.payments.length + (r.change > 0n || r.payments.length === 1 ? 1 : 0)
}

/** The transaction's size in bytes, as maki makes it. */
export function transactionSize(r: MakiRequest, extra: number): number {
  const outputs = outputCount(r)
  let size = 1 + 1 + vlen(r.inputs.length)
  for (const i of r.inputs) {
    let last = 0n
    size += 1 + 1 + vlen(i.ring.length) + 32
    for (const m of i.ring) {
      size += vlen(m.global - last)
      last = m.global
    }
  }
  size += vlen(outputs) + 35 * outputs + vlen(extra) + extra
  size += 1 + vlen(r.fee) + 40 * outputs
  const lr = 6 + Math.log2(padded(outputs))
  size += 1 + 6 * 32 + 2 * (vlen(lr) + 32 * lr)
  size += r.inputs.reduce((t, i) => t + 32 * i.ring.length + 64 + 32, 0)
  return size
}

function padded(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

/** What fees and Monero's size limit count: the size, and for more than two outputs, most of what separate range proofs would have taken (the "clawback"). */
export function transactionWeight(size: number, outputs: number): number {
  const p = padded(outputs)
  if (p <= 2) return size
  const lr = Math.log2(p) + 6
  return size + Math.floor(((320 * p - 32 * (6 + 2 * lr)) * 4) / 5)
}

/** The fee at `rate` per byte of weight, rounded up to the node's mask: settled with its own length in the transaction. */
export function feeFor(
  r: MakiRequest,
  own: { spend: Uint8Array; view: Uint8Array },
  rate: bigint,
  mask: bigint
): bigint {
  const extra = extraLength(r, own)
  let fee = 0n
  for (let i = 0; i < 4; i++) {
    const w = BigInt(transactionWeight(transactionSize({ ...r, fee }, extra), outputCount(r)))
    const next = ((w * rate + mask - 1n) / mask) * mask
    if (next === fee) break
    fee = next
  }
  return fee
}

/** A payment, planned: what maki's asked to sign, and the outputs it spends. */
export interface Plan {
  request: MakiRequest
  spends: Output[]
}

/**
 * Plan paying `payments` from account 0 at fee priority `priority` (1 slow to 4 fastest), or, with
 * `all`, sending everything that can be spent to the one payment's address (its amount ignored).
 */
export async function planPayment(
  wallet: Wallet,
  payments: { address: string; amount: bigint }[],
  priority: number,
  all = false
): Promise<Plan> {
  const node = wallet.node
  const keys = wallet.keys
  for (const p of payments) {
    const a = decodeAddress(p.address)
    if (!a) throw new Error(`${p.address.slice(0, 12)}… isn’t a Monero address`)
    if (a.network !== keys.network)
      throw new Error(`${p.address.slice(0, 12)}… is another network’s address`)
    if (!all && p.amount <= 0n) throw new Error('a payment of nothing')
  }
  const info = await node.info()
  const { rates, mask } = await node.fees()
  const rate = rates[Math.min(Math.max(priority, 1), rates.length) - 1]
  const own = subaddressKeys(keys.view, keys.spend, 0, 0)
  const spendable = wallet.state.outputs
    .filter((o) => !o.spent && o.major === 0 && o.unlockHeight <= info.height)
    .sort((a, b) =>
      BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0
    )
  if (spendable.length === 0)
    throw new Error('nothing to spend yet: new outputs wait 10 blocks, about 20 minutes')
  const paying = payments.reduce((t, p) => t + p.amount, 0n)

  // outputs from the biggest, until they cover the payments and a fee
  let count = all ? Math.min(spendable.length, MAX_INPUTS) : 1
  for (;;) {
    const spends = spendable.slice(0, count)
    const total = spends.reduce((t, o) => t + BigInt(o.amount), 0n)
    const rings = await makeRings(
      node,
      spends.map((o) => ({
        global: BigInt(o.global),
        key: hex.decode(o.key),
        commitment: hex.decode(o.commitment)
      }))
    )
    const request: MakiRequest = {
      network: keys.network,
      account: 0,
      fee: 0n,
      change: all ? 0n : 1n,
      payments: all ? [{ address: payments[0].address, amount: 1n }] : payments,
      inputs: spends.map((o, i) => ({
        amount: BigInt(o.amount),
        txKey: hex.decode(o.txKey),
        index: BigInt(o.index),
        subaddress: o.minor,
        real: rings[i].real,
        ring: rings[i].ring
      }))
    }
    const fee = feeFor(request, own, rate, mask)
    if (all) {
      if (total <= fee) throw new Error('not enough to pay the fee')
      return {
        request: {
          ...request,
          fee,
          payments: [{ address: payments[0].address, amount: total - fee }]
        },
        spends
      }
    }
    if (total >= paying + fee) {
      const change = total - paying - fee
      return { request: { ...request, fee, change }, spends }
    }
    if (count >= spendable.length) throw new Error('not enough unlocked to pay that and the fee')
    if (count >= MAX_INPUTS)
      throw new Error(`that takes more than ${MAX_INPUTS} of this wallet’s outputs at once`)
    count++
  }
}
