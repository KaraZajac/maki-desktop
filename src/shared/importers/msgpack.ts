/**
 * MessagePack, read: enough for Proton Pass's passkeys, which its export keeps serialized so
 * (rmp-serde's, with named fields). Maps become plain objects (their keys as strings), arrays
 * arrays, `bin` a Uint8Array; floats and extension types are read past. No Node or DOM imports.
 */

/** MessagePack that can't be read. */
export class MsgpackError extends Error {}

/** How deep values may nest, and how many items an array or map may have. */
const MAX_DEPTH = 64
const MAX_ITEMS = 1 << 20

/** A value read from MessagePack. */
export type Msgpack =
  null | boolean | number | string | Uint8Array | Msgpack[] | { [key: string]: Msgpack }

/** Reads one MessagePack value that is the whole of `bytes`. */
export function readMsgpack(bytes: Uint8Array): Msgpack {
  let at = 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const need = (n: number): number => {
    if (at + n > bytes.length) throw new MsgpackError('it ends early')
    at += n
    return at - n
  }
  const text = (n: number): string => {
    const i = need(n)
    return new TextDecoder().decode(bytes.subarray(i, i + n))
  }
  const value = (depth: number): Msgpack => {
    if (depth > MAX_DEPTH) throw new MsgpackError('it nests too deep')
    const t = bytes[need(1)]
    if (t <= 0x7f) return t
    if (t >= 0xe0) return t - 0x100
    if ((t & 0xf0) === 0x80) return map(t & 0x0f, depth)
    if ((t & 0xf0) === 0x90) return array(t & 0x0f, depth)
    if ((t & 0xe0) === 0xa0) return text(t & 0x1f)
    switch (t) {
      case 0xc0:
        return null
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xc4:
      case 0xc5:
      case 0xc6: {
        const n =
          t === 0xc4
            ? bytes[need(1)]
            : t === 0xc5
              ? view.getUint16(need(2))
              : view.getUint32(need(4))
        const i = need(n)
        return bytes.slice(i, i + n)
      }
      case 0xca:
        return view.getFloat32(need(4))
      case 0xcb:
        return view.getFloat64(need(8))
      case 0xcc:
        return bytes[need(1)]
      case 0xcd:
        return view.getUint16(need(2))
      case 0xce:
        return view.getUint32(need(4))
      case 0xcf:
        return Number(view.getBigUint64(need(8)))
      case 0xd0:
        return view.getInt8(need(1))
      case 0xd1:
        return view.getInt16(need(2))
      case 0xd2:
        return view.getInt32(need(4))
      case 0xd3:
        return Number(view.getBigInt64(need(8)))
      case 0xd9:
        return text(bytes[need(1)])
      case 0xda:
        return text(view.getUint16(need(2)))
      case 0xdb:
        return text(view.getUint32(need(4)))
      case 0xdc:
        return array(view.getUint16(need(2)), depth)
      case 0xdd:
        return array(view.getUint32(need(4)), depth)
      case 0xde:
        return map(view.getUint16(need(2)), depth)
      case 0xdf:
        return map(view.getUint32(need(4)), depth)
      // extension types: their bytes read past
      case 0xd4:
      case 0xd5:
      case 0xd6:
      case 0xd7:
      case 0xd8:
        need(1 + [1, 2, 4, 8, 16][t - 0xd4])
        return null
      case 0xc7:
      case 0xc8:
      case 0xc9: {
        const n =
          t === 0xc7
            ? bytes[need(1)]
            : t === 0xc8
              ? view.getUint16(need(2))
              : view.getUint32(need(4))
        need(1 + n)
        return null
      }
      default:
        throw new MsgpackError(`a byte that starts nothing (0x${t.toString(16)})`)
    }
  }
  const array = (n: number, depth: number): Msgpack[] => {
    if (n > MAX_ITEMS || n > bytes.length - at)
      throw new MsgpackError('an array longer than it can be')
    const out: Msgpack[] = []
    for (let i = 0; i < n; i++) out.push(value(depth + 1))
    return out
  }
  const map = (n: number, depth: number): { [key: string]: Msgpack } => {
    if (n > MAX_ITEMS || 2 * n > bytes.length - at)
      throw new MsgpackError('a map longer than it can be')
    const out: { [key: string]: Msgpack } = {}
    for (let i = 0; i < n; i++) {
      const k = value(depth + 1)
      out[typeof k === 'string' ? k : JSON.stringify(k)] = value(depth + 1)
    }
    return out
  }
  const v = value(0)
  if (at !== bytes.length) throw new MsgpackError('there’s more after it')
  return v
}

/** Bytes as rmp-serde writes a `Vec<u8>`: an array of integers 0 to 255 (or `bin`); null if they aren't. */
export function msgpackBytes(v: Msgpack | undefined): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (
    !Array.isArray(v) ||
    !v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 256)
  )
    return null
  return Uint8Array.from(v as number[])
}
