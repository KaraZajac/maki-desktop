/**
 * The EIP-1193 methods a site calls, against the fake maki (which signs with the firmware's own
 * code) and a stand-in network that records what it's sent.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { Ethereum, memoryStore, ProviderError, type Rpc } from './ethereum'
import { toHex } from './rlp'
import { FAKE_BUILT, startFake, TcpTransport } from './test-support'

const FIXTURES = resolve(__dirname, '../../../xous-core/libs/maki-eth/tests/fixtures')
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)))
const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

/** A network that answers from a table and remembers what it was sent. */
function network(answers: Record<string, unknown>): {
  rpc: Rpc
  sent: [string, string, unknown[]][]
} {
  const sent: [string, string, unknown[]][] = []
  return {
    sent,
    rpc: async (url, method, params) => {
      sent.push([url, method, params])
      if (!(method in answers)) throw new ProviderError(-32601, `no ${method} here`)
      return answers[method]
    }
  }
}

const rejects = async (p: Promise<unknown>, code: number): Promise<void> => {
  await expect(p).rejects.toMatchObject({ code })
}

describe.skipIf(!FAKE_BUILT || !existsSync(resolve(FIXTURES, 'abandon-tx-unsigned.bin')))(
  'the Ethereum provider',
  () => {
    const fakes: ChildProcess[] = []
    let maki: MakiClient
    let refusing: MakiClient
    beforeAll(async () => {
      for (const args of [[], ['--deny']]) {
        const fake = await startFake(args)
        fakes.push(fake.proc)
        const client = new MakiClient(await TcpTransport.open(fake.port))
        if (args.length) refusing = client
        else maki = client
      }
    })
    afterAll(() => fakes.forEach((p) => p.kill()))

    it('shows a site nothing until the owner connects it on maki', async () => {
      const eth = new Ethereum(() => maki, network({}).rpc, memoryStore())
      expect(await eth.request('app.example.com', 'eth_accounts')).toEqual([])
      expect(await eth.request('app.example.com', 'eth_chainId')).toBe('0x1')
      expect(await eth.request('app.example.com', 'eth_requestAccounts')).toEqual([ADDRESS])
      expect(await eth.request('app.example.com', 'eth_accounts')).toEqual([ADDRESS])
      // another site is another question
      expect(await eth.request('other.example.com', 'eth_accounts')).toEqual([])
      await rejects(
        eth.request('other.example.com', 'personal_sign', ['0x68656c6c6f', ADDRESS]),
        4100
      )
    })

    it('passes on a refusal, and asks nothing of an unlinked maki', async () => {
      const eth = new Ethereum(() => refusing, network({}).rpc, memoryStore())
      await rejects(eth.request('app.example.com', 'eth_requestAccounts'), 4001)
      const unlinked = new Ethereum(() => null, network({}).rpc, memoryStore())
      await rejects(unlinked.request('app.example.com', 'eth_requestAccounts'), 4900)
    })

    it('signs messages as the firmware does', async () => {
      const eth = new Ethereum(() => maki, network({}).rpc, memoryStore())
      await eth.request('demo.maki', 'eth_requestAccounts')
      const hex = toHex(new TextEncoder().encode('Sign in to demo.maki'))
      expect(await eth.request('demo.maki', 'personal_sign', [hex, ADDRESS.toLowerCase()])).toBe(
        toHex(fixture('abandon-message.sig'))
      )
      // plain text, as some sites send it
      expect(
        await eth.request('demo.maki', 'personal_sign', ['Sign in to demo.maki', ADDRESS])
      ).toBe(toHex(fixture('abandon-message.sig')))
      // not the connected account
      await rejects(
        eth.request('demo.maki', 'personal_sign', [
          hex,
          '0x0000000000000000000000000000000000000001'
        ]),
        4100
      )
    })

    it('builds, signs and broadcasts a transaction', async () => {
      const net = network({ eth_getTransactionCount: '0x2a', eth_sendRawTransaction: '0xabc123' })
      const eth = new Ethereum(() => maki, net.rpc, memoryStore())
      await eth.request('demo.maki', 'eth_requestAccounts')
      // the fixture's transaction, gas and fees given by the site
      const hash = await eth.request('demo.maki', 'eth_sendTransaction', [
        {
          from: ADDRESS,
          to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          value: '0xb1a2bc2ec50000',
          gas: '0xfde8',
          maxFeePerGas: '0x6fc23ac00',
          maxPriorityFeePerGas: '0x59682f00'
        }
      ])
      expect(hash).toBe('0xabc123')
      const broadcast = net.sent.find(([, m]) => m === 'eth_sendRawTransaction')!
      expect(broadcast[0]).toBe('https://ethereum-rpc.publicnode.com')
      expect(broadcast[2]).toEqual([toHex(fixture('abandon-tx-signed.bin'))])
      expect(net.sent.find(([, m]) => m === 'eth_getTransactionCount')![2]).toEqual([
        ADDRESS,
        'pending'
      ])
    })

    it('fills in gas and fees from the network', async () => {
      const net = network({
        eth_getTransactionCount: '0x0',
        eth_estimateGas: '0x5208',
        eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
        eth_maxPriorityFeePerGas: '0x3b9aca00',
        eth_sendRawTransaction: '0xdef'
      })
      const eth = new Ethereum(() => maki, net.rpc, memoryStore())
      await eth.request('demo.maki', 'eth_requestAccounts')
      await eth.request('demo.maki', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }])
      expect(await eth.request('demo.maki', 'eth_chainId')).toBe('0x2105')
      expect(
        await eth.request('demo.maki', 'eth_sendTransaction', [
          { from: ADDRESS, to: ADDRESS, value: '0x1' }
        ])
      ).toBe('0xdef')
      const raw = net.sent.find(([, m]) => m === 'eth_sendRawTransaction')!
      expect(raw[0]).toBe('https://mainnet.base.org')
      // type 2, on Base (8453 = 0x2105): 0x02, a list header (f8 and its length), then the chain
      const signed = raw[2][0] as string
      expect(signed.startsWith('0x02f8')).toBe(true)
      expect(signed.slice(8, 14)).toBe('822105')
    })

    it('reads through, and refuses what it can’t show', async () => {
      const net = network({ eth_blockNumber: '0x10' })
      const eth = new Ethereum(() => maki, net.rpc, memoryStore())
      expect(await eth.request('app.example.com', 'eth_blockNumber')).toBe('0x10')
      await rejects(eth.request('app.example.com', 'eth_sign', []), 4200)
      await rejects(eth.request('app.example.com', 'eth_signTypedData_v4', []), 4200)
      await rejects(
        eth.request('app.example.com', 'wallet_switchEthereumChain', [{ chainId: '0x539' }]),
        4902
      )
      await rejects(eth.request('app.example.com', 'admin_peers', []), 4200)
    })
  }
)
