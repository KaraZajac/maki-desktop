/**
 * maki desktop's Ethereum wallet against the fake maki (maki's own Ethereum code, the test
 * phrase's account) and a stand-in network: holdings on each network, and sends of a token and
 * of a coin, each signed on maki, its signer recovered here with noble.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import {
  Ethereum,
  memoryStore,
  NETWORKS,
  ProviderError,
  type EthNetwork,
  type Rpc
} from './ethereum'
import {
  checksummed,
  ENS_REGISTRY,
  EthWallet,
  GAS_PRICE_ORACLE,
  isAddress,
  isEnsName,
  namehash,
  transferData,
  WALLET_SITE
} from './eth-wallet'
import { toHex } from './rlp'
import { tokensOn } from './tokens'
import { ethStandIn as stand_in, signedBy } from './stand-ins'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { EthereumApp } from './wallet-apps'

const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC = tokensOn(1n).find((t) => t.symbol === 'USDC')!

describe('ENS names', () => {
  it('hashes names as EIP-137 does', () => {
    expect(namehash('')).toBe('0x' + '0'.repeat(64))
    expect(namehash('eth')).toBe(
      '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae'
    )
    expect(namehash('foo.eth')).toBe(
      '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f'
    )
  })

  it('takes only names it can look up without normalizing them', () => {
    expect(['vitalik.eth', 'a-b.c9.eth'].every(isEnsName)).toBe(true)
    expect(['Vitalik.eth', 'vitalik.com', 'eth', 'ví.eth', '0x1234.eth '].some(isEnsName)).toBe(
      false
    )
  })

  it('looks a name up: its resolver in the registry, then its address there', async () => {
    const node = namehash('maki.eth').slice(2)
    const resolver = '0x' + '42'.repeat(20)
    const asked: [string, string, string][] = []
    const rpc: Rpc = async (url, method, params) => {
      const { to, data } = params[0] as { to: string; data: string }
      asked.push([url, to.toLowerCase(), data])
      if (method !== 'eth_call') throw new Error(method)
      if (to === ENS_REGISTRY && data === '0x0178b8bf' + node)
        return '0x' + resolver.slice(2).padStart(64, '0')
      if (to === resolver && data === '0x3b3b57de' + node)
        return '0x' + PAYEE.slice(2).toLowerCase().padStart(64, '0')
      return '0x' + '0'.repeat(64)
    }
    const wallet = new EthWallet(new Ethereum(() => null, rpc, memoryStore()), rpc)
    expect(await wallet.resolve('maki.eth')).toBe(PAYEE)
    // on Ethereum, whatever the network a payment goes on
    expect(asked.every(([url]) => url === NETWORKS[0].rpc)).toBe(true)
    // a name with no resolver, or no address, points nowhere
    expect(await wallet.resolve('nobody.eth')).toBeNull()
    await expect(wallet.resolve('Maki.eth')).rejects.toThrow('look up')
  })
})

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

describe('the Ethereum wallet’s networks', () => {
  const network = (name: string): EthNetwork => NETWORKS.find((n) => n.name === name)!
  const word = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0')

  /** A wallet connected to the account, on `rpc`, whatever the network. */
  const wallet = async (rpc: Rpc): Promise<EthWallet> => {
    const store = memoryStore()
    await store.save({ connected: { [WALLET_SITE]: ADDRESS }, chains: {} })
    return new EthWallet(new Ethereum(() => null, rpc, store), rpc)
  }

  it('counts Arc’s USDC once: the coin, not its ERC-20 again', async () => {
    const arc = network('Arc')
    const rpc: Rpc = async (_url, method) =>
      method === 'eth_getBalance' ? '0xde0b6b3a7640000' : word(1_000_000n)
    const held = await new EthWallet(new Ethereum(() => null, rpc, memoryStore()), rpc, [
      arc
    ]).holdings(ADDRESS)
    expect(held[0].holdings).toEqual([{ token: null, amount: 10n ** 18n }])
  })

  /** A network that holds 1 of its coin, as the stand-in's, and fee oracle answers. */
  const fees = (
    oracle: Record<string, string>
  ): { rpc: Rpc; calls: { url: string; data: string }[] } => {
    const calls: { url: string; data: string }[] = []
    const answers: Record<string, unknown> = {
      eth_getBalance: '0xde0b6b3a7640000',
      eth_estimateGas: '0xc350',
      eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
      eth_maxPriorityFeePerGas: '0x3b9aca00'
    }
    return {
      calls,
      rpc: async (url, method, params) => {
        if (method !== 'eth_call') return answers[method]
        const { to, data } = params[0] as { to: string; data: string }
        expect(to).toBe(GAS_PRICE_ORACLE)
        calls.push({ url, data })
        const answer = oracle[data.slice(0, 10)]
        if (answer === undefined) throw new ProviderError(3, 'execution reverted')
        return answer
      }
    }
  }
  // the gas at the most it might cost: 50,000 and a fifth, at the base fee (1 gwei) doubled and
  // the tip (1 gwei)
  const gas = 60_000n * 3_000_000_000n

  it('sends all of a coin less twice the fees a network charges outside the gas', async () => {
    const base = network('Base')
    const net = fees({ '0x49948e0e': word(10n ** 12n), '0x275aedd2': word(5n * 10n ** 11n) })
    const { amount } = await (await wallet(net.rpc)).most(base, PAYEE)
    expect(amount).toBe(10n ** 18n - gas - 2n * (10n ** 12n + 5n * 10n ** 11n))
    // its L1 fee, priced for the transaction: getL1Fee(bytes) of it unsigned, an EIP-1559 one
    // to the payee on Base, and the operator fee for its gas
    const [l1, operator] = net.calls
    expect(l1.url).toBe(base.rpc)
    expect(l1.data.slice(0, 74)).toBe('0x49948e0e' + word(32n).slice(2))
    const length = Number(BigInt('0x' + l1.data.slice(74, 138)))
    const unsigned = l1.data.slice(138, 138 + length * 2)
    expect(unsigned.startsWith('02')).toBe(true)
    expect(unsigned).toContain('822105') // chain 8453
    expect(unsigned).toContain(PAYEE.slice(2).toLowerCase())
    expect(operator.data).toBe('0x275aedd2' + word(60_000n).slice(2))
    // an oracle from before the operator fee refuses that call: no operator fee
    const older = fees({ '0x49948e0e': word(10n ** 12n) })
    expect((await (await wallet(older.rpc)).most(base, PAYEE)).amount).toBe(
      10n ** 18n - gas - 2n * 10n ** 12n
    )
  })

  it('prices Mantle’s L1 fee in MNT, at its token ratio', async () => {
    const net = fees({
      '0x49948e0e': word(6n * 10n ** 10n),
      '0x06f837d3': word(4_037n),
      '0x275aedd2': word(21n * 10n ** 13n)
    })
    const { amount } = await (await wallet(net.rpc)).most(network('Mantle'), PAYEE)
    expect(amount).toBe(10n ** 18n - gas - 2n * (6n * 10n ** 10n * 4_037n + 21n * 10n ** 13n))
  })

  it('asks a network with fees in the gas alone nothing more, and believes no odd answer', async () => {
    const net = fees({})
    const { amount } = await (await wallet(net.rpc)).most(network('Avalanche'), PAYEE)
    expect([amount, net.calls.length]).toEqual([10n ** 18n - gas, 0])
    const odd = fees({ '0x49948e0e': '0x1234' })
    await expect((await wallet(odd.rpc)).most(network('Unichain'), PAYEE)).rejects.toThrow(
      /didn’t say its L1 fee/
    )
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'the Ethereum wallet, with the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let maki: EthereumApp
    let said = ''
    beforeAll(async () => {
      fake = await startFake(['--app', join(APP_FIXTURES, 'ethereum.maki')])
      fake.proc.stdout!.on('data', (d: Buffer) => (said += d.toString()))
      const client = new MakiClient(await TcpTransport.open(fake.port))
      maki = new EthereumApp((app, message, timeoutMs) =>
        client.appMessage(app, message, timeoutMs)
      )
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
      // what the app showed maki's owner: how much of the token, in its own units
      expect(said).toMatch(
        /Ethereum shows \[Send tokens\] 1\.5 USDC 0x70997970C51812dc3A010C7d01b50e0d17dc79C8/
      )
    })

    it('sends all of a coin: what it holds less the most the fee could be, with those fees', async () => {
      const net = stand_in()
      const wallet = new EthWallet(new Ethereum(() => maki, net.rpc, memoryStore()), net.rpc)
      await wallet.connect()
      const { amount, fees } = await wallet.most(NETWORKS[1], PAYEE)
      // 1 ETH; gas 50,000 and a fifth; the base fee (1 gwei) doubled, and the tip (1 gwei)
      expect(fees).toEqual({
        gas: 60_000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n
      })
      expect(amount).toBe(10n ** 18n - 60_000n * 3_000_000_000n)
      await wallet.send(NETWORKS[1], PAYEE, amount, null, fees)
      const raw = net.sent.find(([, m]) => m === 'eth_sendRawTransaction')![2][0] as string
      const { fields } = signedBy(raw)
      const n = (b: Uint8Array): bigint => BigInt('0x' + (toHex(b).slice(2) || '0'))
      // chain, tip, most fee, gas: the value and the gas at the most it costs are all of it
      expect([n(fields[0]), n(fields[2]), n(fields[3]), n(fields[4])]).toEqual([
        8453n,
        1_000_000_000n,
        3_000_000_000n,
        60_000n
      ])
      expect(n(fields[6]) + n(fields[4]) * n(fields[3])).toBe(10n ** 18n)
    })

    it('sends a coin on another network, and turns away what it can’t send', async () => {
      const net = stand_in()
      const wallet = new EthWallet(new Ethereum(() => maki, net.rpc, memoryStore()), net.rpc)
      await expect(wallet.send(NETWORKS[1], PAYEE, 1n, null)).rejects.toThrow(
        /connect maki desktop/
      )
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
  }
)
