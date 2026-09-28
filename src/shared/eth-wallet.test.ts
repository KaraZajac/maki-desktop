/**
 * maki desktop's Ethereum wallet against the fake maki (maki's own Ethereum code, the test
 * phrase's account) and a stand-in network: holdings on each network, and sends of a token and
 * of a coin, each signed on maki, its signer recovered here with noble.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { Ethereum, memoryStore, NETWORKS, ProviderError, type Rpc } from './ethereum'
import { checksummed, EthWallet, isAddress, transferData } from './eth-wallet'
import { fromHex, toHex } from './rlp'
import { tokensOn } from './tokens'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC = tokensOn(1n).find((t) => t.symbol === 'USDC')!

type Rlp = Uint8Array | Rlp[]
/** RLP, read back. */
function rlpDecode(b: Uint8Array): Rlp {
  const one = (at: number): [Rlp, number] => {
    const p = b[at]
    const len = (n: number, from: number): number => Number(BigInt(toHex(b.slice(from, from + n))))
    if (p < 0x80) return [b.slice(at, at + 1), at + 1]
    if (p < 0xb8) return [b.slice(at + 1, at + 1 + p - 0x80), at + 1 + p - 0x80]
    if (p < 0xc0) {
      const n = len(p - 0xb7, at + 1)
      const start = at + 1 + p - 0xb7
      return [b.slice(start, start + n), start + n]
    }
    const [start, end] =
      p < 0xf8
        ? [at + 1, at + 1 + p - 0xc0]
        : [at + 1 + p - 0xf7, at + 1 + p - 0xf7 + len(p - 0xf7, at + 1)]
    const items: Rlp[] = []
    for (let i = start; i < end;) {
      const [item, next] = one(i)
      items.push(item)
      i = next
    }
    return [items, end]
  }
  return one(0)[0]
}

/** An EIP-1559 transaction as maki signed it: its fields, and who signed it. */
function signedBy(raw: string): { fields: Uint8Array[]; from: string } {
  const bytes = fromHex(raw)
  expect(bytes[0]).toBe(2)
  const all = rlpDecode(bytes.slice(1)) as Uint8Array[]
  const fields = all.slice(0, 9)
  const [yParity, r, s] = all.slice(9) as Uint8Array[]
  // what was signed: the type, then the fields without the signature
  const unsigned = fromHex(raw).slice(0, 1)
  const body = (() => {
    const enc = (item: Rlp): Uint8Array => {
      const cat = (xs: Uint8Array[]): Uint8Array => Uint8Array.from(xs.flatMap((x) => [...x]))
      const head = (short: number, n: number): Uint8Array => {
        if (n < 56) return Uint8Array.of(short + n)
        const len = fromHex(
          `0x${n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0')}`
        )
        return Uint8Array.of(short + 55 + len.length, ...len)
      }
      if (item instanceof Uint8Array)
        return item.length === 1 && item[0] < 0x80 ? item : cat([head(0x80, item.length), item])
      const inner = cat(item.map(enc))
      return cat([head(0xc0, inner.length), inner])
    }
    return enc(all.slice(0, 9))
  })()
  const digest = keccak_256(Uint8Array.of(...unsigned, ...body))
  const pad = (x: Uint8Array): Uint8Array => Uint8Array.of(...new Uint8Array(32 - x.length), ...x)
  const sig = Uint8Array.of(yParity.length ? yParity[0] : 0, ...pad(r), ...pad(s))
  const pub = secp256k1.Point.fromBytes(
    secp256k1.recoverPublicKey(sig, digest, { prehash: false })
  ).toBytes(false)
  return { fields, from: toHex(keccak_256(pub.slice(1)).slice(12)) }
}

/** A network that holds 1 of its coin for everyone, and 1.5 USDC on Ethereum; it keeps what it's sent. */
function stand_in(): { rpc: Rpc; sent: [string, string, unknown[]][] } {
  const sent: [string, string, unknown[]][] = []
  const answers: Record<string, unknown> = {
    eth_getBalance: '0xde0b6b3a7640000',
    eth_getTransactionCount: '0x7',
    eth_estimateGas: '0xc350',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_sendRawTransaction: '0xfeed'
  }
  return {
    sent,
    rpc: async (url, method, params) => {
      sent.push([url, method, params])
      if (method === 'eth_call') {
        const to = (params[0] as { to: string }).to
        return to === USDC.contract && url === NETWORKS[0].rpc
          ? `0x${(1_500_000).toString(16).padStart(64, '0')}`
          : `0x${'0'.repeat(64)}`
      }
      if (!(method in answers)) throw new ProviderError(-32601, `no ${method} here`)
      return answers[method]
    }
  }
}

describe('addresses', () => {
  it('checks the capitals EIP-55 gives an address', () => {
    expect(checksummed(ADDRESS.toLowerCase())).toBe(ADDRESS)
    expect(checksummed(PAYEE.toLowerCase())).toBe(PAYEE)
    expect(isAddress(PAYEE)).toBe(true)
    expect(isAddress(PAYEE.toLowerCase())).toBe(true)
    // one letter's capital changed: a typo EIP-55 catches
    expect(isAddress(PAYEE.replace('C51812dc', 'C51812Dc'))).toBe(false)
    expect(isAddress('0x1234')).toBe(false)
  })
})

describe.skipIf(!FAKE_BUILT)('the Ethereum wallet, with the fake maki', () => {
  let fake: { port: number; proc: ChildProcess }
  let maki: MakiClient
  let said = ''
  beforeAll(async () => {
    fake = await startFake()
    fake.proc.stdout!.on('data', (d: Buffer) => (said += d.toString()))
    maki = new MakiClient(await TcpTransport.open(fake.port))
  })
  afterAll(() => fake?.proc.kill())

  it('connects once the owner says so on maki, and reads what the account holds', async () => {
    const net = stand_in()
    const wallet = new EthWallet(new Ethereum(() => maki, net.rpc, memoryStore()), net.rpc)
    expect(await wallet.account()).toBeNull()
    expect(await wallet.connect()).toBe(ADDRESS)
    expect(await wallet.account()).toBe(ADDRESS)
    const held = await wallet.holdings(ADDRESS)
    expect(held.map((h) => h.network.name)).toEqual(NETWORKS.map((n) => n.name))
    expect(held.every((h) => h.problem === null)).toBe(true)
    expect(held[0].holdings.map((h) => [h.token?.symbol ?? 'coin', h.amount])).toEqual([
      ['coin', 10n ** 18n],
      ['USDC', 1_500_000n]
    ])
    // on the others, their coin alone
    expect(
      held.slice(1).every((h) => h.holdings.length === 1 && h.holdings[0].token === null)
    ).toBe(true)
  })

  it('sends a token: maki spells it out and signs it', async () => {
    const net = stand_in()
    const wallet = new EthWallet(new Ethereum(() => maki, net.rpc, memoryStore()), net.rpc)
    await wallet.connect()
    expect(await wallet.send(NETWORKS[0], PAYEE, 1_500_000n, USDC)).toBe('0xfeed')
    const raw = net.sent.find(([, m]) => m === 'eth_sendRawTransaction')![2][0] as string
    const { fields, from } = signedBy(raw)
    expect(from.toLowerCase()).toBe(ADDRESS.toLowerCase())
    expect(toHex(fields[5]).toLowerCase()).toBe(USDC.contract.toLowerCase())
    expect(fields[6].length).toBe(0)
    expect(toHex(fields[7])).toBe(transferData(PAYEE, 1_500_000n))
    // what maki showed its owner: how much of the token, in its own units
    expect(said).toMatch(
      /maki shows: Send tokens\s+1\.5 USDC\s+0x70997970C51812dc3A010C7d01b50e0d17dc79C8/
    )
  })

  it('sends a coin on another network, and turns away what it can’t send', async () => {
    const net = stand_in()
    const wallet = new EthWallet(new Ethereum(() => maki, net.rpc, memoryStore()), net.rpc)
    await expect(wallet.send(NETWORKS[1], PAYEE, 1n, null)).rejects.toThrow(/connect maki desktop/)
    await wallet.connect()
    const base = NETWORKS.find((n) => n.name === 'Base')!
    await wallet.send(base, PAYEE, 10n ** 16n, null)
    const raw = net.sent.find(([, m]) => m === 'eth_sendRawTransaction')![2][0] as string
    const { fields, from } = signedBy(raw)
    expect(from.toLowerCase()).toBe(ADDRESS.toLowerCase())
    expect(BigInt(toHex(fields[0]))).toBe(8453n)
    expect(toHex(fields[5]).toLowerCase()).toBe(PAYEE.toLowerCase())
    expect(BigInt(toHex(fields[6]))).toBe(10n ** 16n)
    await expect(wallet.send(base, '0x1234', 1n, null)).rejects.toThrow(/isn’t an address/)
    await expect(wallet.send(base, PAYEE, 1n, USDC)).rejects.toThrow(/isn’t on Base/)
  })
})
