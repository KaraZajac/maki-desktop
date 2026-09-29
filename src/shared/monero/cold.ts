/**
 * maki as a view-only wallet's cold wallet: the Monero GUI's (or the CLI's, or monero-wallet-rpc's)
 * "offline transaction signing", with maki desktop reading and writing wallet2's files and maki
 * signing. The view-only wallet has the address and the view key maki shares; it finds the
 * wallet's outputs and builds each transaction (its inputs and their rings, what it pays, the fee);
 * maki makes the transaction itself from that, once its owner has seen each payment, the change
 * and the fee on maki's screen, and wallet2 sends it.
 *
 * - An unsigned transaction set becomes a request to maki for each transaction (`prepare`): the
 *   inputs, each found with the view key (which transaction key, which subaddress), the payments,
 *   the change, which must come back to the wallet, and the fee.
 * - What maki signs goes back as wallet2's signed set (`signedSet`): the transaction, with
 *   wallet2's own bookkeeping around it, and the change's key image.
 * - Outputs a view-only wallet exports get their key images from maki (`keyImageAsks`), for it
 *   to import and see what's spent.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import { decodeSigned, encodeRequest, type MakiRequest, type Signed } from './request'
import { absoluteOffsets, parseExtra, parseTransaction } from './transaction'
import {
  type ConstructionData,
  type DestinationEntry,
  type ExportedTransfer,
  openFile,
  parseOutputs,
  parseUnsigned,
  type PendingTx,
  sealFile,
  type SignedTxSet,
  writeKeyImages,
  writeSigned
} from './wallet2'
import {
  derivation,
  derivationToScalar,
  encodeAddress,
  equal,
  mulBase,
  type Network,
  pointOrNull,
  subaddressKeys
} from './xmr'

/** What maki desktop knows of a Monero wallet: its network, its primary address's spend key, and its view key. */
export interface ViewWallet {
  network: Network
  spend: Uint8Array
  view: bigint
}

/** Subaddresses' public keys, worked out once each. */
class Subaddresses {
  private kept = new Map<string, { spend: Uint8Array; view: Uint8Array }>()
  constructor(private w: ViewWallet) {}
  get(major: number, minor: number): { spend: Uint8Array; view: Uint8Array } {
    const k = `${major}/${minor}`
    let s = this.kept.get(k)
    if (!s) {
      s = subaddressKeys(this.w.view, this.w.spend, major, minor)
      this.kept.set(k, s)
    }
    return s
  }
}

/**
 * Which of `candidates` (account, index) output `index` with key `key` pays, derived with one of
 * `txKeys` (the transaction's key, or the output's own additional key): null if none.
 */
function owner(
  subs: Subaddresses,
  w: ViewWallet,
  key: Uint8Array,
  index: number,
  txKeys: Uint8Array[],
  candidates: [number, number][]
): { txKey: Uint8Array; major: number; minor: number } | null {
  const p = pointOrNull(key)
  if (!p) return null
  for (const txKey of txKeys) {
    if (!pointOrNull(txKey)) continue
    const spend = p
      .subtract(mulBase(derivationToScalar(derivation(w.view, txKey), index)))
      .toBytes()
    for (const [major, minor] of candidates) {
      if (equal(subs.get(major, minor).spend, spend)) return { txKey, major, minor }
    }
  }
  return null
}

/** A transaction to ask maki for, and how its outputs map back to wallet2's list. */
export interface Prepared {
  request: MakiRequest
  construction: ConstructionData
  /** each payment's place in `splittedDsts` */
  payments: number[]
  /** the change's (or wallet2's output of nothing's) place there, if it has one */
  change: number | null
}

const zero = (b: Uint8Array): boolean => b.every((v) => v === 0)

/** The request for one of an unsigned set's transactions; throws with why maki shouldn't sign it. */
export function prepare(c: ConstructionData, w: ViewWallet): Prepared {
  if (c.unlockTime !== 0n)
    throw new Error('a transaction locked until later, which maki doesn’t make')
  if (c.sources.length === 0) throw new Error('a transaction spending nothing')
  const subs = new Subaddresses(w)
  const account = c.subaddrAccount
  const candidates: [number, number][] = [...new Set([0, ...c.subaddrIndices])].map((m) => [
    account,
    m
  ])

  const inputs = c.sources.map((s, i) => {
    const real = Number(s.realOutput)
    const index = Number(s.realOutputInTxIndex)
    const additional = s.realOutAdditionalTxKeys[index]
    const found = owner(
      subs,
      w,
      s.outputs[real].key,
      index,
      additional ? [s.realOutTxKey, additional] : [s.realOutTxKey],
      candidates
    )
    if (!found) throw new Error(`input ${i + 1} isn’t this wallet’s`)
    return {
      amount: s.amount,
      txKey: found.txKey,
      index: s.realOutputInTxIndex,
      subaddress: found.minor,
      real,
      ring: s.outputs.map((o) => ({ global: o.index, key: o.key, commitment: o.commitment }))
    }
  })

  // the change: wallet2 lists it among the outputs, as it does its output of nothing (to an
  // address nobody has) when there's no change and one payment
  const change = c.changeDts
  let changeAt: number | null = null
  if (!(zero(change.spend) && zero(change.view))) {
    changeAt = c.splittedDsts.findIndex(
      (d) =>
        d.amount === change.amount && equal(d.spend, change.spend) && equal(d.view, change.view)
    )
    if (changeAt < 0) throw new Error('change that isn’t among the transaction’s outputs')
    const own = subs.get(account, 0)
    if (change.amount > 0n && !(equal(change.spend, own.spend) && equal(change.view, own.view))) {
      throw new Error('change going somewhere other than this wallet')
    }
  }

  // a payment ID the view-only wallet put in the clear (not wallet2's dummy of zeros) goes with
  // the one place paid, as an integrated address
  const id = parseExtra(c.extra).paymentId
  const paymentId = id?.encrypted && !zero(id.id) ? id.id : undefined
  const payments: { address: string; amount: bigint }[] = []
  const places: number[] = []
  c.splittedDsts.forEach((d, i) => {
    if (i === changeAt) return
    places.push(i)
    payments.push({ address: address(d, w.network, paymentId), amount: d.amount })
  })
  if (paymentId && new Set(payments.map((p) => p.address)).size > 1) {
    throw new Error('a payment ID with more than one place paid')
  }

  const spent = c.sources.reduce((t, s) => t + s.amount, 0n)
  const paid = c.splittedDsts.reduce((t, d) => t + d.amount, 0n)
  if (paid > spent) throw new Error('more paid than spent')
  return {
    request: {
      network: w.network,
      account,
      fee: spent - paid,
      change: changeAt === null ? 0n : change.amount,
      payments,
      inputs
    },
    construction: c,
    payments: places,
    change: changeAt
  }
}

function address(d: DestinationEntry, network: Network, paymentId?: Uint8Array): string {
  if (paymentId && !d.isSubaddress) {
    return encodeAddress({ network, kind: 'integrated', spend: d.spend, view: d.view, paymentId })
  }
  return encodeAddress({
    network,
    kind: d.isSubaddress ? 'subaddress' : 'standard',
    spend: d.spend,
    view: d.view
  })
}

/** wallet2's record of a transaction maki signed, for its signed set, and the change's key image. */
export function pending(
  p: Prepared,
  signed: Signed
): { ptx: PendingTx; txKeyImages: [Uint8Array, Uint8Array][] } {
  const tx = parseTransaction(signed.transaction)
  const c = p.construction
  // the inputs in the transaction's order (by their rings), the outputs in its order
  const sources = tx.inputs.map((input) => {
    const globals = absoluteOffsets(input.keyOffsets)
    const s = c.sources.find(
      (s) =>
        s.outputs.length === globals.length && s.outputs.every((o, i) => o.index === globals[i])
    )
    if (!s) throw new Error('maki signed an input that wasn’t asked for')
    return s
  })
  const splittedDsts = signed.outputs.map((paid) => {
    const place = typeof paid === 'number' ? p.payments[paid] : p.change
    if (place === undefined || place === null)
      throw new Error('maki made an output that wasn’t asked for')
    return c.splittedDsts[place]
  })
  const identity = new Uint8Array(32)
  identity[0] = 1
  return {
    ptx: {
      tx,
      dust: 0n,
      fee: tx.fee,
      dustAddedToFee: false,
      changeDts: c.changeDts,
      selectedTransfers: c.selectedTransfers,
      keyImages: tx.inputs.map((i) => `<${hex.encode(i.keyImage)}> `).join(''),
      // wallet2 keeps the transaction's key to itself: the identity scalar
      txKey: identity,
      additionalTxKeys: [],
      dests: c.dests,
      constructionData: { ...c, sources, splittedDsts },
      multisigTxKeyEntropy: new Uint8Array(32)
    },
    txKeyImages: signed.own.map((o) => [tx.outputs[o.index].key, o.keyImage])
  }
}

/** The signed set wallet2 submits: each transaction, and no list of the wallet's key images (which it reads from offset 0). */
export function signedSet(
  signed: { ptx: PendingTx; txKeyImages: [Uint8Array, Uint8Array][] }[]
): SignedTxSet {
  return {
    ptx: signed.map((s) => s.ptx),
    keyImages: [],
    txKeyImages: signed.flatMap((s) => s.txKeyImages)
  }
}

/** An output to ask maki the key image of. */
export interface KeyImageAsk {
  txKey: Uint8Array
  index: bigint
  major: number
  minor: number
  key: Uint8Array
}

/** What to ask maki for each output a view-only wallet exported, checked with the view key. */
export function keyImageAsks(outputs: ExportedTransfer[], w: ViewWallet): KeyImageAsk[] {
  const subs = new Subaddresses(w)
  return outputs.map((e, i) => {
    const index = Number(e.internalOutputIndex)
    const additional = e.additionalTxKeys[index]
    const found = owner(
      subs,
      w,
      e.pubkey,
      index,
      additional ? [e.txPubkey, additional] : [e.txPubkey],
      [
        [e.major, e.minor],
        [0, 0]
      ]
    )
    if (!found) throw new Error(`output ${i + 1} isn’t this wallet’s`)
    return {
      txKey: found.txKey,
      index: e.internalOutputIndex,
      major: found.major,
      minor: found.minor,
      key: e.pubkey
    }
  })
}

/** maki, as the files need it: key images for outputs, and transactions signed. */
export interface MoneroSigner {
  keyImages(
    outputs: KeyImageAsk[]
  ): Promise<{
    approval: string
    reason: string
    images: { image: Uint8Array; proof: Uint8Array }[]
  }>
  sign(
    request: Uint8Array
  ): Promise<{ approval: string; reason: string; signed: Uint8Array | null }>
}

function refused(what: string, r: { approval: string; reason: string }): Error {
  return new Error(
    r.approval === 'refused'
      ? `maki won’t ${what}: ${r.reason}`
      : r.approval === 'denied'
        ? `you said no on maki`
        : `maki: ${r.approval}`
  )
}

/**
 * The key image file for a view-only wallet's outputs file (its "export outputs"): an image for
 * each output, from maki, for it to import and see what's spent.
 */
export async function keyImageFile(
  file: Uint8Array,
  w: ViewWallet,
  key: Uint8Array,
  maki: MoneroSigner
): Promise<{ file: Uint8Array; outputs: number }> {
  const viewPublic = mulBase(w.view).toBytes()
  const exported = parseOutputs(openFile('outputs', file, w.view, key), w.spend, viewPublic)
  const r = await maki.keyImages(keyImageAsks(exported.outputs, w))
  if (r.approval !== 'approved') throw refused('make key images', r)
  const body = writeKeyImages(Number(exported.offset), w.spend, viewPublic, r.images)
  return { file: sealFile('keyImages', body, w.view, key), outputs: exported.outputs.length }
}

/**
 * A view-only wallet's unsigned transactions, signed by maki (each gone through on maki's
 * screen): the signed file it submits, and the key image file it imports with it, for the
 * outputs it didn't have key images for yet.
 */
export async function signFile(
  file: Uint8Array,
  w: ViewWallet,
  key: Uint8Array,
  maki: MoneroSigner
): Promise<{ signed: Uint8Array; keyImages: Uint8Array; transactions: number; fee: bigint }> {
  const set = parseUnsigned(openFile('unsigned', file, w.view, key))
  // everything checked before maki is asked anything
  const prepared = set.txes.map((c) => prepare(c, w))
  const done = []
  for (const p of prepared) {
    const r = await maki.sign(encodeRequest(p.request))
    if (r.approval !== 'approved' || !r.signed) throw refused('sign it', r)
    done.push(pending(p, decodeSigned(r.signed)))
  }
  const signed = sealFile('signed', writeSigned(signedSet(done)), w.view, key)
  const viewPublic = mulBase(w.view).toBytes()
  let images: { image: Uint8Array; proof: Uint8Array }[] = []
  if (set.newTransfers.outputs.length > 0) {
    const r = await maki.keyImages(keyImageAsks(set.newTransfers.outputs, w))
    if (r.approval !== 'approved') throw refused('make key images', r)
    images = r.images
  }
  const offset =
    set.newTransfers.outputs.length > 0 ? set.newTransfers.offset : set.newTransfers.total
  const keyImages = sealFile(
    'keyImages',
    writeKeyImages(Number(offset), w.spend, viewPublic, images),
    w.view,
    key
  )
  return {
    signed,
    keyImages,
    transactions: done.length,
    fee: prepared.reduce((t, p) => t + p.request.fee, 0n)
  }
}
