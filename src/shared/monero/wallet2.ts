/**
 * wallet2's cold-signing files (Monero v0.18), which a view-only wallet (the Monero GUI's, the
 * CLI's, monero-wallet-rpc's) and its cold wallet pass each other: the view-only wallet's outputs,
 * the cold wallet's key images for them, the view-only wallet's unsigned transactions, and the
 * cold wallet's signed ones. maki desktop is the cold wallet here, with maki doing the signing.
 *
 * Each file is magic text and a version byte, then an envelope: an 8-byte IV, the body encrypted
 * with ChaCha20 (the key: CryptoNight of the view key), and a signature by the view key over IV
 * and ciphertext. Bodies are Monero's `binary_archive` (the key image file is packed by hand).
 * Written from the source of v0.18.5.1 and checked against files its binaries made.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { cnSlowHash } from './cryptonight'
import { Reader, Writer, readTransaction, type Transaction } from './transaction'
import {
  checkSignature,
  concat,
  equal,
  generateSignature,
  keccak,
  mulBase,
  scalarBytes
} from './xmr'

export const MAGIC = {
  unsigned: 'Monero unsigned tx set',
  signed: 'Monero signed tx set',
  outputs: 'Monero output export',
  keyImages: 'Monero key image export'
} as const
const VERSION = { unsigned: 5, signed: 5, outputs: 4, keyImages: 3 } as const
export type FileKind = keyof typeof MAGIC

/** What a file is, from its first bytes (after undoing ASCII armour); null for none of these. */
export function fileKind(file: Uint8Array): FileKind | null {
  const bytes = unarmour(file)
  for (const kind of Object.keys(MAGIC) as FileKind[]) {
    const magic = new TextEncoder().encode(MAGIC[kind])
    if (bytes.length > magic.length && equal(bytes.subarray(0, magic.length), magic)) return kind
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// ChaCha20 as Monero has it: DJB's original, a 64-bit block counter from 0 and a 64-bit IV.

function chacha20(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const words = (b: Uint8Array): Uint32Array => {
    const v = new DataView(b.buffer, b.byteOffset, b.length)
    return Uint32Array.from({ length: b.length / 4 }, (_, i) => v.getUint32(4 * i, true))
  }
  const k = words(key)
  const n = words(iv)
  const constant = words(new TextEncoder().encode('expand 32-byte k'))
  const out = new Uint8Array(data.length)
  const x = new Uint32Array(16)
  const state = new Uint32Array(16)
  const rotl = (v: number, c: number): number => ((v << c) | (v >>> (32 - c))) >>> 0
  const qr = (a: number, b: number, c: number, d: number): void => {
    x[a] += x[b]
    x[d] = rotl(x[d] ^ x[a], 16)
    x[c] += x[d]
    x[b] = rotl(x[b] ^ x[c], 12)
    x[a] += x[b]
    x[d] = rotl(x[d] ^ x[a], 8)
    x[c] += x[d]
    x[b] = rotl(x[b] ^ x[c], 7)
  }
  for (let block = 0, at = 0; at < data.length; block++, at += 64) {
    state.set(constant, 0)
    state.set(k, 4)
    state[12] = block >>> 0
    state[13] = Math.floor(block / 0x100000000)
    state.set(n, 14)
    x.set(state)
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12)
      qr(1, 5, 9, 13)
      qr(2, 6, 10, 14)
      qr(3, 7, 11, 15)
      qr(0, 5, 10, 15)
      qr(1, 6, 11, 12)
      qr(2, 7, 8, 13)
      qr(3, 4, 9, 14)
    }
    const stream = new Uint8Array(64)
    const sv = new DataView(stream.buffer)
    for (let i = 0; i < 16; i++) sv.setUint32(4 * i, (x[i] + state[i]) >>> 0, true)
    for (let i = 0; i < 64 && at + i < data.length; i++) out[at + i] = data[at + i] ^ stream[i]
  }
  return out
}

/** The key wallet2 encrypts files with: CryptoNight of the view key (once, as wallets run by default). */
export function fileKey(viewSecret: bigint): Uint8Array {
  return cnSlowHash(scalarBytes(viewSecret))
}

/** wallet2's ASCII armour, if a file has it (`export-format ascii`): its bytes. */
function unarmour(file: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(file.subarray(0, Math.min(file.length, 64)))
  if (!text.includes('-----BEGIN MoneroAsciiDataV1-----')) return file
  const all = new TextDecoder().decode(file)
  const body =
    all
      .split('-----BEGIN MoneroAsciiDataV1-----')[1]
      ?.split('-----END MoneroAsciiDataV1-----')[0] ?? ''
  const b64 = body.replace(/\s+/g, '')
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** A file's body: its magic and version checked, its signature by the view key checked, decrypted. */
export function openFile(
  kind: FileKind,
  file: Uint8Array,
  viewSecret: bigint,
  key: Uint8Array
): Uint8Array {
  const bytes = unarmour(file)
  const magic = new TextEncoder().encode(MAGIC[kind])
  if (bytes.length < magic.length + 1 || !equal(bytes.subarray(0, magic.length), magic)) {
    throw new Error(`not a Monero ${describe(kind)} file`)
  }
  if (bytes[magic.length] !== VERSION[kind]) {
    throw new Error(`a Monero ${describe(kind)} file of another version (${bytes[magic.length]})`)
  }
  const body = bytes.subarray(magic.length + 1)
  if (body.length < 8 + 64) throw new Error('a file cut short')
  const signed = body.subarray(0, body.length - 64)
  if (
    !checkSignature(keccak(signed), mulBase(viewSecret).toBytes(), body.subarray(body.length - 64))
  ) {
    throw new Error('a file from another wallet, or changed since')
  }
  return chacha20(signed.subarray(8), key, signed.subarray(0, 8))
}

/** A file for wallet2: `plain` encrypted and signed with the view key, behind its magic. */
export function sealFile(
  kind: FileKind,
  plain: Uint8Array,
  viewSecret: bigint,
  key: Uint8Array
): Uint8Array {
  const iv = crypto.getRandomValues(new Uint8Array(8))
  const signed = concat(iv, chacha20(plain, key, iv))
  const sig = generateSignature(keccak(signed), viewSecret)
  return concat(new TextEncoder().encode(MAGIC[kind]), Uint8Array.of(VERSION[kind]), signed, sig)
}

function describe(kind: FileKind): string {
  return {
    unsigned: 'unsigned transaction',
    signed: 'signed transaction',
    outputs: 'outputs',
    keyImages: 'key images'
  }[kind]
}

// ---------------------------------------------------------------------------------------------
// What's inside.

export interface DestinationEntry {
  /** the address as typed; empty for change */
  original: string
  amount: bigint
  spend: Uint8Array
  view: Uint8Array
  isSubaddress: boolean
  isIntegrated: boolean
}

export interface SourceEntry {
  /** the ring: each member's global index, key and commitment */
  outputs: { index: bigint; key: Uint8Array; commitment: Uint8Array }[]
  realOutput: bigint
  realOutTxKey: Uint8Array
  realOutAdditionalTxKeys: Uint8Array[]
  realOutputInTxIndex: bigint
  amount: bigint
  rct: boolean
  /** the real output's commitment's mask */
  mask: Uint8Array
  multisigKLRki: Uint8Array
}

export interface ConstructionData {
  sources: SourceEntry[]
  changeDts: DestinationEntry
  /** every output's destination, the change's included */
  splittedDsts: DestinationEntry[]
  selectedTransfers: bigint[]
  extra: Uint8Array
  unlockTime: bigint
  constructionFlags: number
  rctConfig: { version: number; rangeProofType: number; bpVersion: number }
  /** what the owner asked to pay, without change */
  dests: DestinationEntry[]
  subaddrAccount: number
  subaddrIndices: number[]
}

/** An output of the view-only wallet's, as it exports them (`exported_transfer_details`). */
export interface ExportedTransfer {
  version: number
  pubkey: Uint8Array
  internalOutputIndex: bigint
  globalOutputIndex: bigint
  txPubkey: Uint8Array
  flags: number
  amount: bigint
  additionalTxKeys: Uint8Array[]
  major: number
  minor: number
}

export interface OutputsExport {
  /** where in the view-only wallet's list of outputs these start, and how many it has */
  offset: bigint
  total: bigint
  outputs: ExportedTransfer[]
}

export interface UnsignedTxSet {
  txes: ConstructionData[]
  newTransfers: OutputsExport
}

export interface PendingTx {
  tx: Transaction
  dust: bigint
  fee: bigint
  dustAddedToFee: boolean
  changeDts: DestinationEntry
  selectedTransfers: bigint[]
  keyImages: string
  txKey: Uint8Array
  additionalTxKeys: Uint8Array[]
  dests: DestinationEntry[]
  constructionData: ConstructionData
  multisigTxKeyEntropy: Uint8Array
}

export interface SignedTxSet {
  ptx: PendingTx[]
  keyImages: Uint8Array[]
  /** own outputs' keys, and their key images */
  txKeyImages: [Uint8Array, Uint8Array][]
}

function readDestination(r: Reader): DestinationEntry {
  return {
    original: new TextDecoder().decode(r.take(r.count())),
    amount: r.varint(),
    spend: r.key(),
    view: r.key(),
    isSubaddress: r.bool(),
    isIntegrated: r.bool()
  }
}

function writeDestination(w: Writer, d: DestinationEntry): void {
  const original = new TextEncoder().encode(d.original)
  w.varint(original.length)
    .raw(original)
    .varint(d.amount)
    .key(d.spend)
    .key(d.view)
    .bool(d.isSubaddress)
    .bool(d.isIntegrated)
}

function pair(r: Reader): void {
  if (r.num() !== 2) throw new Error('not a pair')
}

function readSource(r: Reader): SourceEntry {
  const outputs: SourceEntry['outputs'] = []
  for (let i = 0, n = r.count(); i < n; i++) {
    pair(r)
    outputs.push({ index: r.varint(), key: r.key(), commitment: r.key() })
  }
  const realOutput = r.u64()
  if (realOutput >= BigInt(outputs.length))
    throw new Error('a source whose real output is outside its ring')
  const realOutTxKey = r.key()
  const realOutAdditionalTxKeys: Uint8Array[] = []
  for (let i = 0, n = r.count(); i < n; i++) realOutAdditionalTxKeys.push(r.key())
  return {
    outputs,
    realOutput,
    realOutTxKey,
    realOutAdditionalTxKeys,
    realOutputInTxIndex: r.u64(),
    amount: r.u64(),
    rct: r.bool(),
    mask: r.key(),
    multisigKLRki: r.take(128).slice()
  }
}

function writeSource(w: Writer, s: SourceEntry): void {
  w.varint(s.outputs.length)
  for (const o of s.outputs) w.varint(2).varint(o.index).key(o.key).key(o.commitment)
  w.u64(s.realOutput).key(s.realOutTxKey).varint(s.realOutAdditionalTxKeys.length)
  s.realOutAdditionalTxKeys.forEach((k) => w.key(k))
  w.u64(s.realOutputInTxIndex).u64(s.amount).bool(s.rct).key(s.mask).raw(s.multisigKLRki)
}

function list<T>(r: Reader, one: () => T): T[] {
  const out: T[] = []
  for (let i = 0, n = r.count(); i < n; i++) out.push(one())
  return out
}

function readConstruction(r: Reader): ConstructionData {
  return {
    sources: list(r, () => readSource(r)),
    changeDts: readDestination(r),
    splittedDsts: list(r, () => readDestination(r)),
    selectedTransfers: list(r, () => r.varint()),
    extra: r.take(r.count()).slice(),
    unlockTime: r.u64(),
    constructionFlags: r.u8(),
    rctConfig: { version: r.num(32), rangeProofType: r.num(32), bpVersion: r.num(32) },
    dests: list(r, () => readDestination(r)),
    subaddrAccount: r.u32(),
    subaddrIndices: list(r, () => r.num(32))
  }
}

function writeConstruction(w: Writer, c: ConstructionData): void {
  w.varint(c.sources.length)
  c.sources.forEach((s) => writeSource(w, s))
  writeDestination(w, c.changeDts)
  w.varint(c.splittedDsts.length)
  c.splittedDsts.forEach((d) => writeDestination(w, d))
  w.varint(c.selectedTransfers.length)
  c.selectedTransfers.forEach((t) => w.varint(t))
  w.varint(c.extra.length).raw(c.extra).u64(c.unlockTime).u8(c.constructionFlags)
  w.varint(c.rctConfig.version).varint(c.rctConfig.rangeProofType).varint(c.rctConfig.bpVersion)
  w.varint(c.dests.length)
  c.dests.forEach((d) => writeDestination(w, d))
  w.u32(c.subaddrAccount).varint(c.subaddrIndices.length)
  ;[...c.subaddrIndices].sort((a, b) => a - b).forEach((i) => w.varint(i))
}

function readExported(r: Reader): ExportedTransfer {
  const version = r.num(32)
  if (version < 1) throw new Error('an exported output of version 0')
  return {
    version,
    pubkey: r.key(),
    internalOutputIndex: r.varint(),
    globalOutputIndex: r.varint(),
    txPubkey: r.key(),
    flags: r.u8(),
    amount: r.varint(),
    additionalTxKeys: list(r, () => r.key()),
    major: r.num(32),
    minor: r.num(32)
  }
}

function readOutputs(r: Reader): OutputsExport {
  if (r.num() !== 3) throw new Error('not the outputs tuple')
  return { offset: r.varint(), total: r.varint(), outputs: list(r, () => readExported(r)) }
}

function writeOutputs(w: Writer, o: OutputsExport): void {
  w.varint(3).varint(o.offset).varint(o.total).varint(o.outputs.length)
  for (const e of o.outputs) {
    w.varint(1)
      .key(e.pubkey)
      .varint(e.internalOutputIndex)
      .varint(e.globalOutputIndex)
      .key(e.txPubkey)
      .u8(e.flags)
    w.varint(e.amount).varint(e.additionalTxKeys.length)
    e.additionalTxKeys.forEach((k) => w.key(k))
    w.varint(e.major).varint(e.minor)
  }
}

function whole<T>(bytes: Uint8Array, read: (r: Reader) => T): T {
  const r = new Reader(bytes)
  const v = read(r)
  if (!r.done) throw new Error(`${r.left} bytes too many`)
  return v
}

export function parseUnsigned(body: Uint8Array): UnsignedTxSet {
  return whole(body, (r) => {
    const version = r.num(32)
    if (version !== 2) throw new Error(`an unsigned transaction set of version ${version}`)
    return { txes: list(r, () => readConstruction(r)), newTransfers: readOutputs(r) }
  })
}

export function writeUnsigned(u: UnsignedTxSet): Uint8Array {
  const w = new Writer().varint(2).varint(u.txes.length)
  u.txes.forEach((c) => writeConstruction(w, c))
  writeOutputs(w, u.newTransfers)
  return w.finish()
}

function readPending(r: Reader): PendingTx {
  const version = r.num(32)
  const p: PendingTx = {
    tx: readTransaction(r),
    dust: r.u64(),
    fee: r.u64(),
    dustAddedToFee: r.bool(),
    changeDts: readDestination(r),
    selectedTransfers: list(r, () => r.varint()),
    keyImages: new TextDecoder().decode(r.take(r.count())),
    txKey: r.key(),
    additionalTxKeys: list(r, () => r.key()),
    dests: list(r, () => readDestination(r)),
    constructionData: readConstruction(r),
    multisigTxKeyEntropy: new Uint8Array(32)
  }
  if (r.count() !== 0) throw new Error('a multisig transaction')
  if (version >= 1) p.multisigTxKeyEntropy = r.key()
  return p
}

export function parseSigned(body: Uint8Array): SignedTxSet {
  return whole(body, (r) => {
    r.num(32)
    const ptx = list(r, () => readPending(r))
    const keyImages = list(r, () => r.key())
    const txKeyImages = list(r, (): [Uint8Array, Uint8Array] => {
      pair(r)
      return [r.key(), r.key()]
    })
    return { ptx, keyImages, txKeyImages }
  })
}

export function writeSigned(s: SignedTxSet): Uint8Array {
  const w = new Writer().varint(0).varint(s.ptx.length)
  for (const p of s.ptx) {
    w.varint(1).raw(p.tx.bytes).u64(p.dust).u64(p.fee).bool(p.dustAddedToFee)
    writeDestination(w, p.changeDts)
    w.varint(p.selectedTransfers.length)
    p.selectedTransfers.forEach((t) => w.varint(t))
    const images = new TextEncoder().encode(p.keyImages)
    w.varint(images.length).raw(images).key(p.txKey).varint(p.additionalTxKeys.length)
    p.additionalTxKeys.forEach((k) => w.key(k))
    w.varint(p.dests.length)
    p.dests.forEach((d) => writeDestination(w, d))
    writeConstruction(w, p.constructionData)
    // no multisig signatures; the entropy multisig would have used
    w.varint(0).key(p.multisigTxKeyEntropy)
  }
  w.varint(s.keyImages.length)
  s.keyImages.forEach((k) => w.key(k))
  w.varint(s.txKeyImages.length)
  s.txKeyImages.forEach(([key, image]) => w.varint(2).key(key).key(image))
  return w.finish()
}

/** An outputs file's body: the account's keys (checked), then the outputs. */
export function parseOutputs(body: Uint8Array, spend: Uint8Array, view: Uint8Array): OutputsExport {
  if (body.length < 64) throw new Error('an outputs file cut short')
  if (!equal(body.subarray(0, 32), spend) || !equal(body.subarray(32, 64), view)) {
    throw new Error('the outputs of another wallet')
  }
  return whole(body.subarray(64), readOutputs)
}

export function writeOutputsFile(
  o: OutputsExport,
  spend: Uint8Array,
  view: Uint8Array
): Uint8Array {
  const w = new Writer()
  writeOutputs(w, o)
  return concat(spend, view, w.finish())
}

/** A key image file's body: where they start in the view-only wallet's outputs, the account's keys, then each image and its proof. */
export function writeKeyImages(
  offset: number,
  spend: Uint8Array,
  view: Uint8Array,
  images: { image: Uint8Array; proof: Uint8Array }[]
): Uint8Array {
  const w = new Writer().u32(offset).key(spend).key(view)
  for (const { image, proof } of images) w.key(image).raw(proof)
  return w.finish()
}

export function parseKeyImages(body: Uint8Array): {
  offset: number
  spend: Uint8Array
  view: Uint8Array
  images: { image: Uint8Array; proof: Uint8Array }[]
} {
  const r = new Reader(body)
  const offset = r.u32()
  const spend = r.key()
  const view = r.key()
  if (r.left % 96 !== 0) throw new Error('a key image file cut short')
  const images = []
  while (!r.done) images.push({ image: r.key(), proof: r.take(64).slice() })
  return { offset, spend, view, images }
}
