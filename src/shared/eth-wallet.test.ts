/**
 * maki desktop's Ethereum wallet against the fake maki (maki's own Ethereum code, the test
 * phrase's account) and a stand-in network: holdings on each network, and sends of a token and
 * of a coin, each signed on maki, its signer recovered here with noble.
 */
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { Ethereum, memoryStore, NETWORKS } from './ethereum'
import { checksummed, EthWallet, isAddress, transferData } from './eth-wallet'
import { toHex } from './rlp'
import { tokensOn } from './tokens'
import { ethStandIn as stand_in, signedBy } from './stand-ins'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC = tokensOn(1n).find((t) => t.symbol === 'USDC')!

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
