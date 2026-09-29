/**
 * Monero transactions as the chain and wallet2 carry them: version 2, a coinbase (no RingCT) or
 * RingCT type 6 (CLSAG and Bulletproofs+), view-tagged outputs or not. Read from bytes (to scan
 * them, and to find where one ends inside wallet2's files), and their hashes. What maki signs
 * comes whole from maki; nothing here makes one.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { hex } from '@scure/base'
import { concat, keccak } from './xmr'

/** Reads Monero's binary encodings: fixed little-endian numbers, varints, raw bytes. */
export class Reader {
  offset = 0
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length
  }

  get left(): number {
    return this.bytes.length - this.offset
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error('cut short')
    const out = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  u8(): number {
    return this.take(1)[0]
  }

  u32(): number {
    const b = this.take(4)
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
  }

  u64(): bigint {
    const b = this.take(8)
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true)
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  /** A varint that fits `bits` bits, written the shortest way (as Monero's reader insists). */
  varint(bits = 64): bigint {
    let v = 0n
    for (let shift = 0; ; shift += 7) {
      const byte = this.u8()
      if (shift + 7 >= bits && byte >= 1 << (bits - shift)) throw new Error('a varint too big')
      if (byte === 0 && shift !== 0) throw new Error('a varint written long')
      v |= BigInt(byte & 0x7f) << BigInt(shift)
      if (!(byte & 0x80)) return v
    }
  }

  /** A varint that's a count or a small number. */
  num(bits = 64): number {
    const v = this.varint(bits)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('a number too big')
    return Number(v)
  }

  /** A count of things to follow, no more than bytes are left. */
  count(): number {
    const n = this.num()
    if (n > this.left) throw new Error('a count past the end')
    return n
  }

  key(): Uint8Array {
    return this.take(32).slice()
  }
}

/** Writes them. */
export class Writer {
  private parts: Uint8Array[] = []

  raw(b: Uint8Array): this {
    this.parts.push(b.slice())
    return this
  }

  u8(v: number): this {
    return this.raw(Uint8Array.of(v))
  }

  u32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    return this.raw(b)
  }

  u64(v: bigint): this {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, v, true)
    return this.raw(b)
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0)
  }

  varint(v: number | bigint): this {
    let n = BigInt(v)
    const out: number[] = []
    while (n >= 0x80n) {
      out.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    out.push(Number(n))
    return this.raw(Uint8Array.from(out))
  }

  key(k: Uint8Array): this {
    if (k.length !== 32) throw new Error('a key is 32 bytes')
    return this.raw(k)
  }

  finish(): Uint8Array {
    return concat(...this.parts)
  }
}

export interface TxInput {
  /** a coinbase's: the block's height */
  gen?: bigint
  amount: bigint
  /** relative, as the transaction writes them */
  keyOffsets: bigint[]
  keyImage: Uint8Array
}

export interface TxOutput {
  amount: bigint
  key: Uint8Array
  viewTag?: number
}

export interface Transaction {
  version: number
  unlockTime: bigint
  inputs: TxInput[]
  outputs: TxOutput[]
  extra: Uint8Array
  /** RingCT's type: 0 for none (a coinbase), 6 for CLSAG and Bulletproofs+ */
  rctType: number
  fee: bigint
  /** each output's amount, encrypted (8 bytes), and its commitment */
  encryptedAmounts: Uint8Array[]
  commitments: Uint8Array[]
  /** the transaction's bytes, and where its prefix and RingCT's base end */
  bytes: Uint8Array
  prefixEnd: number
  baseEnd: number
}

/**
 * A transaction from where `r` is, to its end (which the bytes don't say otherwise). A pruned one
 * (as a node sends them to scan) ends after RingCT's base: no proofs or signatures.
 */
export function readTransaction(r: Reader, pruned = false): Transaction {
  const start = r.offset
  const version = r.num()
  if (version !== 1 && version !== 2) throw new Error(`a version ${version} transaction`)
  const unlockTime = r.varint()
  const inputs: TxInput[] = []
  for (let i = 0, n = r.count(); i < n; i++) {
    const tag = r.u8()
    if (tag === 0xff) {
      inputs.push({ gen: r.varint(), amount: 0n, keyOffsets: [], keyImage: new Uint8Array(32) })
    } else if (tag === 0x02) {
      const amount = r.varint()
      const keyOffsets: bigint[] = []
      for (let j = 0, m = r.count(); j < m; j++) keyOffsets.push(r.varint())
      inputs.push({ amount, keyOffsets, keyImage: r.key() })
    } else {
      throw new Error(`an input of kind ${tag}`)
    }
  }
  const outputs: TxOutput[] = []
  for (let i = 0, n = r.count(); i < n; i++) {
    const amount = r.varint()
    const tag = r.u8()
    if (tag === 0x02) outputs.push({ amount, key: r.key() })
    else if (tag === 0x03) outputs.push({ amount, key: r.key(), viewTag: r.u8() })
    else throw new Error(`an output of kind ${tag}`)
  }
  const extra = r.take(r.count()).slice()
  const prefixEnd = r.offset
  const coinbase = inputs.length > 0 && inputs[0].gen !== undefined
  if (version === 1) {
    // before RingCT: a ring signature for each input (a coinbase has none), unless pruned
    if (!pruned && !coinbase) for (const input of inputs) r.take(64 * input.keyOffsets.length)
    return {
      version,
      unlockTime,
      inputs,
      outputs,
      extra,
      rctType: 0,
      fee: 0n,
      encryptedAmounts: [],
      commitments: [],
      bytes: r.bytes.slice(start, r.offset),
      prefixEnd: prefixEnd - start,
      baseEnd: r.offset - start
    }
  }
  let rctType = 0
  let fee = 0n
  const encryptedAmounts: Uint8Array[] = []
  const commitments: Uint8Array[] = []
  let baseEnd = r.offset
  if (inputs.length > 0) {
    rctType = r.u8()
    if (rctType !== 0) {
      if (rctType !== 6) throw new Error(`RingCT type ${rctType}`)
      fee = r.varint()
      for (let i = 0; i < outputs.length; i++) encryptedAmounts.push(r.take(8).slice())
      for (let i = 0; i < outputs.length; i++) commitments.push(r.key())
      baseEnd = r.offset
      // the prunable part: one Bulletproof+, then each input's CLSAG and pseudo-output
      if (pruned) {
        return {
          version,
          unlockTime,
          inputs,
          outputs,
          extra,
          rctType,
          fee,
          encryptedAmounts,
          commitments,
          bytes: r.bytes.slice(start, r.offset),
          prefixEnd: prefixEnd - start,
          baseEnd: baseEnd - start
        }
      }
      if (r.num() !== 1) throw new Error('not one range proof')
      r.take(6 * 32)
      for (let side = 0; side < 2; side++) r.take(32 * r.count())
      const ring = inputs[0].keyOffsets.length
      for (let i = 0; i < inputs.length; i++) r.take(32 * (ring + 2))
      r.take(32 * inputs.length)
    } else {
      baseEnd = r.offset
      if (!coinbase) throw new Error('a spend without RingCT')
    }
  }
  return {
    version,
    unlockTime,
    inputs,
    outputs,
    extra,
    rctType,
    fee,
    encryptedAmounts,
    commitments,
    bytes: r.bytes.slice(start, r.offset),
    prefixEnd: prefixEnd - start,
    baseEnd: baseEnd - start
  }
}

/** A whole transaction's bytes; throws if there's more, or less. */
export function parseTransaction(bytes: Uint8Array): Transaction {
  const r = new Reader(bytes)
  const tx = readTransaction(r)
  if (!r.done) throw new Error('bytes after the transaction')
  return tx
}

/** Its ID: of its prefix's hash, RingCT's base's and its prunable part's (for a coinbase, zeros). */
export function transactionId(tx: Transaction): Uint8Array {
  if (tx.version === 1) return keccak(tx.bytes)
  const prefix = keccak(tx.bytes.subarray(0, tx.prefixEnd))
  const base = keccak(tx.bytes.subarray(tx.prefixEnd, tx.baseEnd))
  const prunable = tx.rctType === 0 ? new Uint8Array(32) : keccak(tx.bytes.subarray(tx.baseEnd))
  return keccak(concat(prefix, base, prunable))
}

/** The absolute global indices a ring's relative offsets stand for. */
export function absoluteOffsets(offsets: bigint[]): bigint[] {
  let sum = 0n
  return offsets.map((o) => (sum += o))
}

/** Extra's fields, as Monero parses them: the transaction's key(s), the additional keys, a nonce. */
export interface Extra {
  txKeys: Uint8Array[]
  additionalKeys: Uint8Array[]
  /** a payment ID, 8 bytes encrypted or 32 plain */
  paymentId?: { encrypted: boolean; id: Uint8Array }
}

export function parseExtra(extra: Uint8Array): Extra {
  const out: Extra = { txKeys: [], additionalKeys: [] }
  const r = new Reader(extra)
  try {
    while (!r.done) {
      const tag = r.u8()
      if (tag === 0x01) out.txKeys.push(r.key())
      else if (tag === 0x04) {
        for (let i = 0, n = r.count(); i < n; i++) out.additionalKeys.push(r.key())
      } else if (tag === 0x02) {
        const nonce = r.take(r.count())
        if (nonce.length === 9 && nonce[0] === 0x01)
          out.paymentId = { encrypted: true, id: nonce.slice(1) }
        else if (nonce.length === 33 && nonce[0] === 0x00)
          out.paymentId = { encrypted: false, id: nonce.slice(1) }
      } else if (tag === 0x00) {
        // padding: zeros to the end
        break
      } else if (tag === 0x03) {
        r.take(r.count())
      } else {
        break
      }
    }
  } catch {
    // what could be read of it
  }
  return out
}

/** A block: its header, the miner's transaction and the IDs of the others. */
export interface Block {
  major: number
  minor: number
  timestamp: bigint
  prevId: Uint8Array
  nonce: number
  minerTx: Transaction
  txHashes: Uint8Array[]
  /** the header's bytes (what the block's ID hashes, with the tree of its transactions) */
  header: Uint8Array
}

export function parseBlock(bytes: Uint8Array): Block {
  const r = new Reader(bytes)
  const major = r.num()
  const minor = r.num()
  const timestamp = r.varint()
  const prevId = r.key()
  const nonce = r.u32()
  const header = bytes.slice(0, r.offset)
  const minerTx = readTransaction(r)
  const txHashes: Uint8Array[] = []
  for (let i = 0, n = r.count(); i < n; i++) txHashes.push(r.key())
  if (!r.done) throw new Error('bytes after the block')
  return { major, minor, timestamp, prevId, nonce, minerTx, txHashes, header }
}

/** Monero's tree hash of a block's transaction IDs (`tree_hash`). */
export function treeHash(hashes: Uint8Array[]): Uint8Array {
  const n = hashes.length
  if (n === 0) throw new Error('no hashes')
  if (n === 1) return hashes[0]
  if (n === 2) return keccak(concat(hashes[0], hashes[1]))
  let cnt = 1
  while (cnt * 2 < n) cnt *= 2
  const ints = hashes.slice(0, 2 * cnt - n)
  for (let i = 2 * cnt - n; i < n; i += 2) ints.push(keccak(concat(hashes[i], hashes[i + 1])))
  while (ints.length > 2) {
    const next: Uint8Array[] = []
    for (let i = 0; i < ints.length; i += 2) next.push(keccak(concat(ints[i], ints[i + 1])))
    ints.splice(0, ints.length, ...next)
  }
  return keccak(concat(ints[0], ints[1]))
}

/** A block's ID: of its header, its transactions' tree hash and how many it has, with its length first. */
export function blockId(block: Block): Uint8Array {
  const hashes = [transactionId(block.minerTx), ...block.txHashes]
  const blob = concat(block.header, treeHash(hashes), new Writer().varint(hashes.length).finish())
  const id = keccak(concat(new Writer().varint(blob.length).finish(), blob))
  // the one block whose ID Monero hard-codes (mainnet's 202612)
  if (hex.encode(id) === '3a8a2b3a29b50fc86ff73dd087ea43c6f0d6b8f936c849194d5c84c737903966') {
    return hex.decode('bbd604d2ba11ba27935e006ed39c9bfdd99b76bf4a50654bc1e1e61217962698')
  }
  return id
}
