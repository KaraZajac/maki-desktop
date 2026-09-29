/**
 * epee's portable storage: the binary form of monerod's `.bin` endpoints (the blocks a wallet
 * scans, the decoys it picks from). A header, then a section of named fields; sections, arrays
 * and strings count their contents with epee's own varint (its low two bits say how wide it is).
 *
 * Values come back as plain objects: numbers as bigints, strings as bytes, objects and arrays as
 * such. Writing takes the same, with the kinds of fields made explicit.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
import { concat } from './xmr'

const SIGNATURE = Uint8Array.of(0x01, 0x11, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01)

export type EpeeValue = bigint | number | boolean | Uint8Array | EpeeObject | EpeeValue[]
export interface EpeeObject {
  [name: string]: EpeeValue
}

const INT64 = 1
const INT32 = 2
const INT16 = 3
const INT8 = 4
const UINT64 = 5
const UINT32 = 6
const UINT16 = 7
const UINT8 = 8
const DOUBLE = 9
const STRING = 10
const BOOL = 11
const OBJECT = 12
const ARRAY = 0x80

class In {
  at = 0
  constructor(private b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new Error('epee: cut short')
    const out = this.b.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  u8(): number {
    return this.take(1)[0]
  }
  view(n: number): DataView {
    const b = this.take(n)
    return new DataView(b.buffer, b.byteOffset, n)
  }
  size(): number {
    const first = this.b[this.at]
    if (first === undefined) throw new Error('epee: cut short')
    const width = 1 << (first & 3)
    const v = this.view(width)
    const n =
      width === 1
        ? v.getUint8(0)
        : width === 2
          ? v.getUint16(0, true)
          : width === 4
            ? v.getUint32(0, true)
            : Number(v.getBigUint64(0, true))
    return Math.floor(n / 4)
  }
}

function readValue(r: In, type: number): EpeeValue {
  switch (type) {
    case INT64:
      return r.view(8).getBigInt64(0, true)
    case INT32:
      return BigInt(r.view(4).getInt32(0, true))
    case INT16:
      return BigInt(r.view(2).getInt16(0, true))
    case INT8:
      return BigInt(r.view(1).getInt8(0))
    case UINT64:
      return r.view(8).getBigUint64(0, true)
    case UINT32:
      return BigInt(r.view(4).getUint32(0, true))
    case UINT16:
      return BigInt(r.view(2).getUint16(0, true))
    case UINT8:
      return BigInt(r.u8())
    case DOUBLE:
      return r.view(8).getFloat64(0, true)
    case STRING:
      return r.take(r.size()).slice()
    case BOOL: {
      const v = r.u8()
      if (v > 1) throw new Error('epee: a bool neither 0 nor 1')
      return v === 1
    }
    case OBJECT:
      return readSection(r)
    default:
      throw new Error(`epee: a value of type ${type}`)
  }
}

function readSection(r: In): EpeeObject {
  const out: EpeeObject = {}
  for (let i = 0, n = r.size(); i < n; i++) {
    const len = r.u8()
    if (len === 0) throw new Error('epee: a field without a name')
    const name = new TextDecoder().decode(r.take(len))
    let type = r.u8()
    if (type === 0x0d) type = r.u8()
    if (type & ARRAY) {
      const items: EpeeValue[] = []
      for (let j = 0, m = r.size(); j < m; j++) items.push(readValue(r, type & ~ARRAY))
      out[name] = items
    } else {
      out[name] = readValue(r, type)
    }
  }
  return out
}

/** A document's root section. */
export function decodeEpee(bytes: Uint8Array): EpeeObject {
  if (bytes.length < 9 || !SIGNATURE.every((b, i) => bytes[i] === b))
    throw new Error('not an epee document')
  const r = new In(bytes)
  r.take(9)
  return readSection(r)
}

// ---------------------------------------------------------------------------------------------

function size(n: number): Uint8Array {
  if (n < 64) return Uint8Array.of(n << 2)
  if (n < 16384) {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, (n << 2) | 1, true)
    return b
  }
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, ((n << 2) | 2) >>> 0, true)
  return b
}

/** A field to write, with its kind. */
export type Field =
  | { u64: bigint | number }
  | { u8: number }
  | { bool: boolean }
  | { bytes: Uint8Array }
  | { objects: Record<string, Field>[] }
  | { u64s: (bigint | number)[] }

function u64(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true)
  return b
}

function writeSection(fields: Record<string, Field>): Uint8Array {
  const parts: Uint8Array[] = []
  // the C++ writer's order: by name, bytewise; empty containers aren't written
  const names = Object.keys(fields).sort()
  let count = 0
  for (const name of names) {
    const f = fields[name]
    let body: Uint8Array
    if ('u64' in f) body = concat(Uint8Array.of(UINT64), u64(f.u64))
    else if ('u8' in f) body = Uint8Array.of(UINT8, f.u8)
    else if ('bool' in f) body = Uint8Array.of(BOOL, f.bool ? 1 : 0)
    else if ('bytes' in f) {
      if (f.bytes.length === 0) continue
      body = concat(Uint8Array.of(STRING), size(f.bytes.length), f.bytes)
    } else if ('objects' in f) {
      if (f.objects.length === 0) continue
      body = concat(
        Uint8Array.of(OBJECT | ARRAY),
        size(f.objects.length),
        ...f.objects.map(writeSection)
      )
    } else {
      if (f.u64s.length === 0) continue
      body = concat(Uint8Array.of(UINT64 | ARRAY), size(f.u64s.length), ...f.u64s.map(u64))
    }
    const n = new TextEncoder().encode(name)
    parts.push(Uint8Array.of(n.length), n, body)
    count++
  }
  return concat(size(count), ...parts)
}

export function encodeEpee(fields: Record<string, Field>): Uint8Array {
  return concat(SIGNATURE, writeSection(fields))
}

// ---------------------------------------------------------------------------------------------
// Reading what came back, strictly.

export function field(o: EpeeObject, name: string): EpeeValue | undefined {
  return o[name]
}

export function bytesOf(o: EpeeObject, name: string): Uint8Array {
  const v = o[name]
  if (v === undefined) return new Uint8Array()
  if (!(v instanceof Uint8Array)) throw new Error(`epee: ${name} isn't a string`)
  return v
}

export function numberOf(o: EpeeObject, name: string): bigint {
  const v = o[name]
  if (v === undefined) return 0n
  if (typeof v !== 'bigint') throw new Error(`epee: ${name} isn't a number`)
  return v
}

export function boolOf(o: EpeeObject, name: string): boolean {
  const v = o[name]
  return v === true
}

export function objectsOf(o: EpeeObject, name: string): EpeeObject[] {
  const v = o[name]
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new Error(`epee: ${name} isn't an array`)
  return v.map((x) => {
    if (typeof x !== 'object' || x instanceof Uint8Array || Array.isArray(x))
      throw new Error(`epee: ${name} isn't of objects`)
    return x as EpeeObject
  })
}

export function listOf(o: EpeeObject, name: string): EpeeValue[] {
  const v = o[name]
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new Error(`epee: ${name} isn't an array`)
  return v
}

export function statusOf(o: EpeeObject): string {
  return new TextDecoder().decode(bytesOf(o, 'status'))
}
