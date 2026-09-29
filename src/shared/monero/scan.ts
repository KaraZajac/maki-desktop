/**
 * Finding a wallet's outputs in transactions, with its view key, as wallet2 does
 * (`process_new_transaction`): each of the transaction's keys (and its outputs' own additional
 * keys) with the view key gives a shared secret; an output whose view tag matches, and whose key
 * less that secret's part is a spend key of the wallet's subaddresses, is the wallet's. Its amount
 * comes from the amount the transaction carries, encrypted, if that opens its commitment (a
 * coinbase output's is in the clear).
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import type { ViewWallet } from './cold'
import { parseExtra, type Transaction } from './transaction'
import {
  commit,
  commitmentMask,
  decryptAmount,
  derivation,
  derivationToScalar,
  equal,
  mulBase,
  pointOrNull,
  subaddressSecret,
  viewTag
} from './xmr'

/** The wallet's subaddresses' spend keys, to look an output's up by: hex of the key → (account, index). */
export class Subaddresses {
  readonly byKey = new Map<string, [number, number]>()
  /** per account, how many of its subaddresses are in the table */
  readonly counts = new Map<number, number>()

  constructor(private w: ViewWallet) {}

  /** Account `major`'s subaddresses up to (not including) `count`. */
  cover(major: number, count: number): void {
    const had = this.counts.get(major) ?? 0
    const spend = pointOrNull(this.w.spend)
    if (!spend || had >= count) return
    for (let minor = had; minor < count; minor++) {
      const key =
        major === 0 && minor === 0
          ? this.w.spend
          : spend.add(mulBase(subaddressSecret(this.w.view, major, minor))).toBytes()
      this.byKey.set(hex.encode(key), [major, minor])
    }
    this.counts.set(major, count)
  }
}

/** An output of the wallet's, found in a transaction. */
export interface Found {
  index: number
  key: Uint8Array
  amount: bigint
  /** its commitment's mask: 1 for a coinbase output */
  mask: bigint
  /** its commitment, as the chain has it */
  commitment: Uint8Array
  /** the public key that finds it: the transaction's, or the output's own additional key */
  txKey: Uint8Array
  major: number
  minor: number
  global: bigint
}

/**
 * The wallet's outputs in `tx`, whose outputs have the global indices `globals` (a coinbase's are
 * RingCT too, from version 2 on).
 */
export function scanTransaction(
  tx: Transaction,
  w: ViewWallet,
  subs: Subaddresses,
  globals: bigint[]
): Found[] {
  const coinbase = tx.inputs.length > 0 && tx.inputs[0].gen !== undefined
  const extra = parseExtra(tx.extra)
  if (extra.txKeys.length === 0) return []
  const found: Found[] = []
  const matched = new Set<number>()
  extra.txKeys.forEach((txKey, k) => {
    if (!pointOrNull(txKey)) return
    const d = derivation(w.view, txKey)
    // an output's own keys go with the first of the transaction's
    const additional =
      k === 0
        ? extra.additionalKeys.map((key) =>
            pointOrNull(key) ? { key, d: derivation(w.view, key) } : null
          )
        : []
    tx.outputs.forEach((out, i) => {
      if (matched.has(i)) return
      const tries = [{ key: txKey, d }, ...(additional[i] ? [additional[i]!] : [])]
      for (const t of tries) {
        if (out.viewTag !== undefined && out.viewTag !== viewTag(t.d, i)) continue
        const p = pointOrNull(out.key)
        if (!p) return
        const scalar = derivationToScalar(t.d, i)
        const spend = p.subtract(mulBase(scalar)).toBytes()
        const whose = subs.byKey.get(hex.encode(spend))
        if (!whose) continue
        let amount: bigint
        let mask: bigint
        let commitment: Uint8Array
        if (coinbase || tx.rctType === 0) {
          amount = out.amount
          mask = 1n
          commitment = commit(1n, amount).toBytes()
        } else {
          amount = decryptAmount(tx.encryptedAmounts[i], scalar)
          mask = commitmentMask(scalar)
          commitment = tx.commitments[i]
          // one whose amount doesn't open its commitment can't be spent: wallet2 skips it
          if (!equal(commit(mask, amount).toBytes(), commitment)) return
        }
        if (amount === 0n) return
        matched.add(i)
        found.push({
          index: i,
          key: out.key,
          amount,
          mask,
          commitment,
          txKey: t.key,
          major: whose[0],
          minor: whose[1],
          global: globals[i]
        })
        return
      }
    })
  })
  return found.sort((a, b) => a.index - b.index)
}
