/**
 * RLP, and the unsigned Ethereum transactions maki desktop builds for maki to sign: EIP-1559
 * (type 2). maki parses exactly these bytes, shows what they say, and signs them.
 */

export type RlpItem = Uint8Array | RlpItem[]

function header(len: number, short: number): number[] {
  if (len <= 55) return [short + len]
  const bytes: number[] = []
  for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256)
  return [short + 55 + bytes.length, ...bytes]
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item
    return Uint8Array.from([...header(item.length, 0x80), ...item])
  }
  const payload = item.flatMap((i) => [...rlpEncode(i)])
  return Uint8Array.from([...header(payload.length, 0xc0), ...payload])
}

/** An unsigned integer as RLP wants it: big-endian, no leading zeros (zero is empty). */
export function uint(n: bigint | number): Uint8Array {
  let v = BigInt(n)
  if (v < 0n) throw new Error('negative')
  const out: number[] = []
  while (v > 0n) {
    out.unshift(Number(v & 0xffn))
    v >>= 8n
  }
  return Uint8Array.from(out)
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h))
    throw new Error(`not hex: ${hex.slice(0, 20)}`)
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** A JSON-RPC quantity ("0x1a") as a bigint. */
export function quantity(q: unknown): bigint {
  if (typeof q === 'number' && Number.isSafeInteger(q) && q >= 0) return BigInt(q)
  if (typeof q !== 'string' || !/^0x[0-9a-fA-F]+$/.test(q))
    throw new Error(`not a quantity: ${String(q)}`)
  return BigInt(q)
}

export function toQuantity(n: bigint): string {
  return `0x${n.toString(16)}`
}

export interface Eip1559 {
  chainId: bigint
  nonce: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  gasLimit: bigint
  /** null: deploys a contract */
  to: Uint8Array | null
  value: bigint
  data: Uint8Array
  accessList: [Uint8Array, Uint8Array[]][]
}

/** `0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, accessList])` */
export function unsignedEip1559(tx: Eip1559): Uint8Array {
  const body = rlpEncode([
    uint(tx.chainId),
    uint(tx.nonce),
    uint(tx.maxPriorityFeePerGas),
    uint(tx.maxFeePerGas),
    uint(tx.gasLimit),
    tx.to ?? new Uint8Array(),
    uint(tx.value),
    tx.data,
    tx.accessList.map(([address, keys]) => [address, keys])
  ])
  return Uint8Array.from([0x02, ...body])
}
