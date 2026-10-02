/**
 * TON's cells, the bags of cells (BOCs) they travel in, and its addresses, for maki desktop's TON
 * wallet. Everything on TON is cells: up to 1023 bits and up to four references to other cells,
 * each named by its hash (SHA-256 of its bits and its references' depths and hashes). A BOC writes
 * a tree of them. These are written as @ton/core writes them (its builder, and `toBoc()`: no index,
 * a CRC32C, cells in the order its topological sort puts them), so that what maki is asked to sign
 * is byte for byte what TON's own libraries make, and read back (the wallets' code comes as a BOC).
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, base64url, hex } from '@scure/base'

/** The most bits a cell holds, and references. */
export const MAX_BITS = 1023
export const MAX_REFS = 4

/** A cell: its bits (the first in the first byte's top bit), its references, and whether it's exotic. */
export class Cell {
  private hashed: Uint8Array | null = null
  private deep: number | null = null

  constructor(
    /** its bits, a byte at a time, zeros after the last */
    readonly data: Uint8Array,
    /** how many bits it holds */
    readonly bits: number,
    readonly refs: readonly Cell[] = [],
    /** a library cell (exotic, type 2): it stands for code by the code's hash */
    readonly exotic = false
  ) {
    if (bits > MAX_BITS || refs.length > MAX_REFS || data.length !== Math.ceil(bits / 8))
      throw new Error('more than a TON cell holds')
  }

  /** A cell with nothing in it. */
  static readonly EMPTY = new Cell(new Uint8Array(), 0)

  /** Its two descriptor bytes: its references (and exotic), then its length in half-bytes. */
  descriptors(): [number, number] {
    return [this.refs.length + (this.exotic ? 8 : 0), Math.ceil(this.bits / 8) + (this.bits >> 3)]
  }

  /** Its bits as they're written: whole bytes, the last one with its end mark after the bits. */
  padded(): Uint8Array {
    const out = this.data.slice()
    if (this.bits % 8) out[out.length - 1] |= 0x80 >> (this.bits % 8)
    return out
  }

  /** How deep the cells under it go: 0 with no references. */
  depth(): number {
    this.deep ??= this.refs.length ? Math.max(...this.refs.map((r) => r.depth())) + 1 : 0
    return this.deep
  }

  /** Its hash (level 0): what names it, and what a wallet's key signs. */
  hash(): Uint8Array {
    if (!this.hashed) {
      const parts: number[] = [...this.descriptors(), ...this.padded()]
      for (const r of this.refs) parts.push(r.depth() >> 8, r.depth() & 0xff)
      for (const r of this.refs) parts.push(...r.hash())
      this.hashed = sha256(Uint8Array.from(parts))
    }
    return this.hashed
  }

  /** The same bits and references, to add to a builder. */
  asBuilder(): Builder {
    return new Builder().append(this)
  }
}

/** A standard address on TON: a workchain (0, the basechain; -1, the masterchain) and a hash. */
export interface TonAddress {
  workchain: number
  /** 32 bytes: the hash of the contract's first state */
  hash: Uint8Array
}

/** A cell being put together, as @ton/core's `beginCell()` builds one. */
export class Builder {
  private buf = new Uint8Array(128)
  private n = 0
  private kids: Cell[] = []

  get bits(): number {
    return this.n
  }
  get availableBits(): number {
    return MAX_BITS - this.n
  }
  get refCount(): number {
    return this.kids.length
  }

  bit(b: boolean | number): this {
    if (this.n >= MAX_BITS) throw new Error('more than a TON cell holds')
    if (b) this.buf[this.n >> 3] |= 0x80 >> (this.n & 7)
    this.n++
    return this
  }

  /** `width` bits of `v`, the most significant first. */
  uint(v: number | bigint, width: number): this {
    const x = BigInt(v)
    if (x < 0n || x >> BigInt(width) !== 0n) throw new Error(`${v} doesn't fit ${width} bits`)
    for (let i = width - 1; i >= 0; i--) this.bit((x >> BigInt(i)) & 1n ? 1 : 0)
    return this
  }

  /** `width` bits of `v`, two's complement. */
  int(v: number | bigint, width: number): this {
    const x = BigInt(v)
    const span = 1n << BigInt(width)
    if (x < -(span >> 1n) || x >= span >> 1n) throw new Error(`${v} doesn't fit ${width} bits`)
    return this.uint(x < 0n ? x + span : x, width)
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.uint(b[i], 8)
    return this
  }

  /** An amount (`Coins`, VarUInteger 16): how many bytes it takes in four bits, then them. */
  coins(v: bigint): this {
    if (v < 0n) throw new Error('a negative amount')
    if (v === 0n) return this.uint(0, 4)
    const size = Math.ceil(v.toString(2).length / 8)
    if (size > 15) throw new Error('more than TON counts')
    return this.uint(size, 4).uint(v, size * 8)
  }

  /** An address (`MsgAddress`): a standard one, without anycast; or none. */
  address(a: TonAddress | null): this {
    if (!a) return this.uint(0, 2)
    return this.uint(2, 2).bit(0).int(a.workchain, 8).bytes(a.hash)
  }

  ref(c: Cell): this {
    if (this.kids.length >= MAX_REFS) throw new Error('more references than a TON cell holds')
    this.kids.push(c)
    return this
  }

  /** A `Maybe ^Cell`: a bit, and the reference if there's one. */
  maybeRef(c: Cell | null): this {
    return c ? this.bit(1).ref(c) : this.bit(0)
  }

  /** A cell's bits and references, after these (@ton/core's `storeSlice` and `storeBuilder`). */
  append(c: Cell | Builder): this {
    const cell = c instanceof Builder ? c.cell() : c
    for (let i = 0; i < cell.bits; i++) this.bit((cell.data[i >> 3] >> (7 - (i & 7))) & 1)
    for (const r of cell.refs) this.ref(r)
    return this
  }

  cell(exotic = false): Cell {
    return new Cell(this.buf.slice(0, Math.ceil(this.n / 8)), this.n, [...this.kids], exotic)
  }
}

/** Text as TON writes it ("snake" data): whole bytes in a cell, the rest in its one reference. */
export function snake(b: Builder, bytes: Uint8Array): Builder {
  const room = Math.floor(b.availableBits / 8)
  if (bytes.length <= room) return b.bytes(bytes)
  b.bytes(bytes.subarray(0, room))
  return b.ref(snake(new Builder(), bytes.subarray(room)).cell())
}

// ---- bags of cells ----

const MAGIC = [0xb5, 0xee, 0x9c, 0x72]

/** CRC-32C (Castagnoli), as a BOC's checksum is: its four bytes little-endian. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const key = (c: Cell): string => hex.encode(c.hash())

/**
 * The tree's cells in @ton/core's order (its `topologicalSort`): each distinct cell once, found
 * breadth first, then placed so that every reference points to a later cell, the root first.
 */
function order(root: Cell): { cell: Cell; refs: number[] }[] {
  const all = new Map<string, Cell>()
  let pending: Cell[] = [root]
  while (pending.length) {
    const now = pending
    pending = []
    for (const c of now) {
      if (all.has(key(c))) continue
      all.set(key(c), c)
      pending.push(...c.refs)
    }
  }
  const left = new Set(all.keys())
  const sorted: string[] = []
  const visit = (k: string): void => {
    if (!left.has(k)) return
    const refs = all.get(k)!.refs
    for (let i = refs.length - 1; i >= 0; i--) visit(key(refs[i]))
    sorted.push(k)
    left.delete(k)
  }
  while (left.size) visit(left.values().next().value!)
  const index = new Map(sorted.map((k, i) => [k, sorted.length - 1 - i]))
  return sorted
    .slice()
    .reverse()
    .map((k) => ({ cell: all.get(k)!, refs: all.get(k)!.refs.map((r) => index.get(key(r))!) }))
}

/** How many bytes a number needs, one at least. */
const bytesFor = (n: number): number => Math.max(Math.ceil(n.toString(2).length / 8), 1)

/** A tree of cells as a BOC, as @ton/core's `toBoc()` writes it: one root, no index, a CRC32C. */
export function writeBoc(root: Cell): Uint8Array {
  const cells = order(root)
  const size = bytesFor(cells.length)
  const total = cells.reduce((n, c) => n + 2 + Math.ceil(c.cell.bits / 8) + c.refs.length * size, 0)
  const offset = bytesFor(total)
  const out: number[] = [...MAGIC, 0x40 | size, offset]
  const num = (v: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) out.push(Math.floor(v / 256 ** i) & 0xff)
  }
  num(cells.length, size)
  num(1, size)
  num(0, size)
  num(total, offset)
  num(0, size)
  for (const { cell, refs } of cells) {
    out.push(...cell.descriptors(), ...cell.padded())
    for (const r of refs) num(r, size)
  }
  const crc = crc32c(Uint8Array.from(out))
  out.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24)
  return Uint8Array.from(out)
}

/**
 * A BOC's one root, read whole: the form TON's libraries write (with an index or without, its
 * checksum checked if it has one), ordinary and library cells; refused if it isn't one.
 */
export function readBoc(b: Uint8Array): Cell {
  let at = 0
  const take = (n: number): Uint8Array => {
    if (at + n > b.length) throw new Error('not a TON bag of cells: it ends too soon')
    at += n
    return b.subarray(at - n, at)
  }
  const num = (width: number): number => take(width).reduce((v, x) => v * 256 + x, 0)
  if (!MAGIC.every((m, i) => b[i] === m)) throw new Error('not a TON bag of cells')
  at = 4
  const flags = num(1)
  const size = flags & 7
  const offset = num(1)
  if (size < 1 || size > 4 || offset < 1 || offset > 8 || flags & 0x18)
    throw new Error('not a TON bag of cells: its header')
  const [count, roots, absent] = [num(size), num(size), num(size)]
  num(offset)
  if (roots !== 1 || absent !== 0) throw new Error('not a TON bag of cells with one root')
  const root = num(size)
  if (flags & 0x80) take(count * offset)
  let end = b.length
  if (flags & 0x40) {
    end -= 4
    const stored = b[end] | (b[end + 1] << 8) | (b[end + 2] << 16) | (b[end + 3] << 24)
    if (crc32c(b.subarray(0, end)) !== stored >>> 0)
      throw new Error('not a TON bag of cells: its checksum is wrong')
  }
  const raw: { data: Uint8Array; bits: number; refs: number[]; exotic: boolean }[] = []
  for (let i = 0; i < count; i++) {
    const [d1, d2] = take(2)
    const refs = d1 & 7
    if (refs > MAX_REFS || d1 >> 5 !== 0) throw new Error('not a TON cell maki desktop reads')
    const bytes = take(Math.ceil(d2 / 2))
    let bits = (d2 >> 1) * 8
    let data = bytes.slice()
    if (d2 & 1) {
      // the end mark: the last byte's lowest 1
      const last = bytes[bytes.length - 1]
      if (last === 0) throw new Error('not a TON cell: its end mark is missing')
      const used = 7 - Math.log2(last & -last)
      bits = (bytes.length - 1) * 8 + used
      data = bytes.slice(0, Math.ceil(bits / 8))
      if (used) data[data.length - 1] &= (0xff << (8 - used)) & 0xff
    }
    raw.push({
      data,
      bits,
      refs: Array.from({ length: refs }, () => num(size)),
      exotic: !!(d1 & 8)
    })
  }
  if (at !== end) throw new Error('not a TON bag of cells: bytes after its cells')
  const cells: Cell[] = new Array(count)
  for (let i = count - 1; i >= 0; i--) {
    const r = raw[i]
    if (r.refs.some((t) => t <= i || t >= count))
      throw new Error('not a TON bag of cells: its order')
    cells[i] = new Cell(
      r.data,
      r.bits,
      r.refs.map((t) => cells[t]),
      r.exotic
    )
  }
  if (root >= count) throw new Error('not a TON bag of cells: its root')
  return cells[root]
}

// ---- addresses (TEP-2) ----

/** CRC-16/XModem, as an address's checksum is. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) {
    crc ^= b << 8
    for (let k = 0; k < 8; k++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

/**
 * An address as people see it, "user-friendly": a tag (bounceable or not, and whether it's only
 * for the test network), the workchain, the hash and their CRC16, in base64url: `UQ…`/`EQ…` on
 * TON, `0Q…`/`kQ…` on its test network. Wallets show their own non-bounceable.
 */
export function friendly(a: TonAddress, bounceable: boolean, testOnly: boolean): string {
  const b = new Uint8Array(36)
  b[0] = (bounceable ? 0x11 : 0x51) | (testOnly ? 0x80 : 0)
  b[1] = a.workchain & 0xff
  b.set(a.hash, 2)
  const crc = crc16(b.subarray(0, 34))
  b[34] = crc >> 8
  b[35] = crc & 0xff
  return base64url.encode(b)
}

/** The raw form: the workchain, a colon, and the hash in hex. */
export const rawAddress = (a: TonAddress): string => `${a.workchain}:${hex.encode(a.hash)}`

export const sameAddress = (a: TonAddress, b: TonAddress): boolean =>
  a.workchain === b.workchain && hex.encode(a.hash) === hex.encode(b.hash)

/** An address as it was written, and what its user-friendly form said of it (raw says neither). */
export interface ReadAddress {
  address: TonAddress
  bounceable: boolean | null
  testOnly: boolean | null
}

/**
 * An address as people write it: user-friendly (base64url, or base64's own two letters, not mixed),
 * its checksum and tag checked; or raw. On the basechain or the masterchain, TON's two; null if
 * it isn't one.
 */
export function readAddress(text: string): ReadAddress | null {
  const raw = /^(0|-1):([0-9a-fA-F]{64})$/.exec(text)
  if (raw)
    return {
      address: { workchain: Number(raw[1]), hash: hex.decode(raw[2].toLowerCase()) },
      bounceable: null,
      testOnly: null
    }
  if (!/^[A-Za-z0-9_-]{48}$/.test(text) && !/^[A-Za-z0-9+/]{48}$/.test(text)) return null
  let b: Uint8Array
  try {
    b = /[+/]/.test(text) ? base64.decode(text) : base64url.decode(text)
  } catch {
    return null
  }
  const crc = crc16(b.subarray(0, 34))
  if (b[34] !== crc >> 8 || b[35] !== (crc & 0xff)) return null
  const tag = b[0]
  if (![0x11, 0x51, 0x91, 0xd1].includes(tag)) return null
  const workchain = b[1] === 0xff ? -1 : b[1]
  if (workchain !== 0 && workchain !== -1) return null
  return {
    address: { workchain, hash: b.slice(2, 34) },
    bounceable: (tag & 0x40) === 0,
    testOnly: (tag & 0x80) !== 0
  }
}

/** A raw address as toncenter writes it (`0:ABCD…`, any case), or null. */
export function fromRaw(text: unknown): TonAddress | null {
  if (typeof text !== 'string') return null
  const r = readAddress(text)
  return r && r.bounceable === null ? r.address : null
}
