/**
 * maki's Solana account: the wire format against @solana/web3.js's (the transactions it made for
 * the firmware's tests, libs/maki-sol/tests/fixtures in the firmware repo); the wallet sites use,
 * against the fake maki running maki's Solana app (maki keeps the key, from the BIP39 test phrase);
 * and maki desktop's own wallet sending SOL and a token through LiteSVM, Solana's runtime, which
 * checks maki's signatures and runs the programs.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58, hex } from '@scure/base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from './bridge-types'
import { MakiClient } from './client'
import { ProviderError } from './ethereum'
import { SolWallet } from './sol-wallet'
import { haveLiteSvm, solStandIn } from './stand-ins'
import {
  associatedTokenAccount,
  compileMessage,
  computeUnitLimit,
  computeUnitPrice,
  createAssociatedTokenAccountIdempotent,
  isAddress,
  keyOf,
  memorySolStore,
  readTransaction,
  Solana,
  SOL_NETWORKS,
  type SolNetwork,
  type SolRpc,
  TOKEN_2022_PROGRAM,
  transactionOf,
  transfer,
  transferChecked,
  withSignature
} from './solana'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { SolanaApp } from './wallet-apps'

const FIXTURES = resolve(
  __dirname,
  '../../../xous-core/libs/maki-sol/tests/fixtures/transactions.json'
)
const HAVE_FIXTURES = existsSync(FIXTURES)
const fixtures = (): { name: string; message: string; signature: string | null }[] =>
  JSON.parse(readFileSync(FIXTURES, 'utf8'))
const fixture = (name: string): { message: Uint8Array; signature: Uint8Array | null } => {
  const f = fixtures().find((x) => x.name === name)!
  return { message: hex.decode(f.message), signature: f.signature ? hex.decode(f.signature) : null }
}
const HAVE_APP = APP_FIXTURES_THERE && existsSync(join(APP_FIXTURES, 'solana.maki'))

/** The test phrase's first Solana account, as Phantom and Solflare have it. */
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const RECIPIENT = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k'

describe('Solana’s wire format', () => {
  it('reads addresses, and finds token accounts as spl-token does', () => {
    expect(isAddress(ME)).toBe(true)
    expect(isAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false)
    expect(keyOf('1111111111111111111111111111111')).toBeNull()
    expect(associatedTokenAccount(ME, USDC)).toBe('5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt')
  })

  it.skipIf(!HAVE_FIXTURES)('compiles transactions byte for byte as web3.js does', () => {
    const fee = [computeUnitLimit(600), computeUnitPrice(100_000n)]
    const made: Record<string, Uint8Array> = {
      sol: compileMessage(ME, [...fee, transfer(ME, RECIPIENT, 1_500_000_000n)], BLOCKHASH),
      usdc: compileMessage(
        ME,
        [
          ...fee,
          createAssociatedTokenAccountIdempotent(ME, RECIPIENT, USDC),
          transferChecked(
            associatedTokenAccount(ME, USDC),
            USDC,
            associatedTokenAccount(RECIPIENT, USDC),
            ME,
            5_250_000n,
            6
          )
        ],
        BLOCKHASH
      ),
      'pyusd-2022': compileMessage(
        ME,
        [
          createAssociatedTokenAccountIdempotent(ME, RECIPIENT, PYUSD, TOKEN_2022_PROGRAM),
          transferChecked(
            associatedTokenAccount(ME, PYUSD, TOKEN_2022_PROGRAM),
            PYUSD,
            associatedTokenAccount(RECIPIENT, PYUSD, TOKEN_2022_PROGRAM),
            ME,
            10_000_000n,
            6,
            TOKEN_2022_PROGRAM
          )
        ],
        BLOCKHASH
      )
    }
    for (const [name, message] of Object.entries(made))
      expect(hex.encode(message), name).toBe(hex.encode(fixture(name).message))
  })

  it.skipIf(!HAVE_FIXTURES)(
    'reads who signs a transaction, and puts a signature in its place',
    () => {
      const { message } = fixture('others-pay')
      const tx = transactionOf(message, [new Uint8Array(64), new Uint8Array(64)])
      const r = readTransaction(tx)
      expect(r.signers).toEqual(['GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse', ME])
      expect(r.message).toEqual(message)
      const signed = readTransaction(withSignature(tx, ME, new Uint8Array(64).fill(9)))
      expect(signed.signatures[1]).toEqual(new Uint8Array(64).fill(9))
      expect(signed.signatures[0]).toEqual(new Uint8Array(64))
      // version 0, and what isn't a transaction
      expect(
        readTransaction(transactionOf(fixture('swap-v0').message, [new Uint8Array(64)])).signers
      ).toEqual([ME])
      expect(() => readTransaction(Uint8Array.of(1, 2, 3))).toThrow('not a Solana transaction')
      expect(() => readTransaction(transactionOf(message, [new Uint8Array(64)]))).toThrow(
        'not a Solana transaction'
      )
      expect(() => withSignature(tx, RECIPIENT, new Uint8Array(64))).toThrow('doesn’t sign')
    }
  )
})

describe.skipIf(!FAKE_BUILT || !HAVE_APP || !HAVE_FIXTURES)(
  'the Solana wallet sites use, with maki’s Solana app',
  () => {
    const fakes: ChildProcess[] = []
    afterAll(() => fakes.forEach((p) => p.kill()))
    const app = async (args: string[] = []): Promise<SolanaApp> => {
      const fake = await startFake(args)
      fakes.push(fake.proc)
      const c = new MakiClient(await TcpTransport.open(fake.port))
      return new SolanaApp((id, message, timeoutMs) => c.appMessage(id, message, timeoutMs))
    }
    const sent: unknown[][] = []
    const rpc: SolRpc = async (url, method, params) => {
      sent.push([url, method, params])
      if (method === 'sendTransaction')
        return base58.encode(fromBase64(params[0] as string)!.subarray(1, 65))
      throw new ProviderError(-32601, 'no such method here')
    }

    it('says when maki hasn’t the app', async () => {
      const maki = await app()
      const solana = new Solana(() => maki, rpc, memorySolStore())
      await expect(solana.request('app.example', 'connect', [{}])).rejects.toThrow(
        'Solana app isn’t installed'
      )
    })

    it('connects a site once the owner agrees, signs what maki showed, and sends it', async () => {
      const maki = await app(['--app', join(APP_FIXTURES, 'solana.maki')])
      const solana = new Solana(() => maki, rpc, memorySolStore())
      // quietly, a site that isn't connected gets nothing
      expect(await solana.request('jup.ag', 'connect', [{ silent: true }])).toEqual({
        accounts: []
      })
      await expect(
        solana.request('jup.ag', 'signMessage', [{ message: toBase64(Uint8Array.of(1)) }])
      ).rejects.toThrow('connect this site')
      expect(await solana.request('jup.ag', 'connect', [{}])).toEqual({ accounts: [ME] })
      expect(await solana.request('jup.ag', 'connect', [{ silent: true }])).toEqual({
        accounts: [ME]
      })
      // a transaction web3.js made: maki signs it as web3.js does
      const { message, signature } = fixture('usdc')
      const unsigned = toBase64(transactionOf(message, [new Uint8Array(64)]))
      const r = (await solana.request('jup.ag', 'signTransaction', [
        { transaction: unsigned }
      ])) as { signedTransaction: string }
      expect(readTransaction(fromBase64(r.signedTransaction)!).signatures[0]).toEqual(signature)
      // and sent, on the network the site says
      const s = (await solana.request('jup.ag', 'signAndSendTransaction', [
        { transaction: unsigned, chain: 'solana:devnet' }
      ])) as {
        signature: string
      }
      expect(s.signature).toBe(base58.encode(signature!))
      expect(sent.at(-1)?.[0]).toBe(SOL_NETWORKS[1].rpc)
      // a message: a sign-in, signed once read
      const text = new TextEncoder().encode(
        `jup.ag wants you to sign in with your Solana account:\n${ME}\n\nNonce: 1`
      )
      const m = (await solana.request('jup.ag', 'signMessage', [{ message: toBase64(text) }])) as {
        signature: string
      }
      expect(ed25519.verify(fromBase64(m.signature)!, text, keyOf(ME)!)).toBe(true)
      // a transaction for another account, and one passed off as a message
      const theirs = toBase64(transactionOf(fixture('not-mine').message, [new Uint8Array(64)]))
      await expect(
        solana.request('jup.ag', 'signTransaction', [{ transaction: theirs }])
      ).rejects.toThrow('isn’t for the account')
      await expect(
        solana.request('jup.ag', 'signMessage', [{ message: toBase64(message) }])
      ).rejects.toThrow('not a message')
      expect(await solana.sites()).toEqual([{ site: 'jup.ag', address: ME }])
      await solana.request('jup.ag', 'disconnect', [])
      await expect(
        solana.request('jup.ag', 'signTransaction', [{ transaction: unsigned }])
      ).rejects.toThrow('connect this site')
    })

    it('passes on the owner’s no', async () => {
      const maki = await app(['--app', join(APP_FIXTURES, 'solana.maki'), '--deny'])
      const solana = new Solana(() => maki, rpc, memorySolStore())
      await expect(solana.request('jup.ag', 'connect', [{}])).rejects.toMatchObject({ code: 4001 })
    })
  }
)

// ---- maki desktop's wallet, sending through LiteSVM ----

const LITESVM = await haveLiteSvm()

describe.skipIf(!FAKE_BUILT || !HAVE_APP || !LITESVM)(
  'maki desktop’s Solana wallet, through Solana’s runtime',
  () => {
    let fake: ChildProcess
    let wallet: SolWallet
    let chain: Awaited<ReturnType<typeof solStandIn>>
    let network: SolNetwork

    beforeAll(async () => {
      const f = await startFake(['--app', join(APP_FIXTURES, 'solana.maki')])
      fake = f.proc
      const c = new MakiClient(await TcpTransport.open(f.port))
      const maki = new SolanaApp((id, message, timeoutMs) => c.appMessage(id, message, timeoutMs))
      chain = await solStandIn()
      network = { ...SOL_NETWORKS[0], rpc: 'litesvm' }
      const solana = new Solana(() => maki, chain.rpc, memorySolStore(), [network])
      wallet = new SolWallet(solana, chain.rpc)
    })
    afterAll(() => fake?.kill())

    it('connects, and sees what the account holds', async () => {
      expect(await wallet.connect()).toBe(ME)
      expect(await wallet.address()).toBe(ME)
      const [held] = await wallet.holdings(ME)
      expect(held.problem).toBeNull()
      expect(held.holdings.map((h) => [h.token?.symbol ?? 'SOL', h.amount])).toEqual([
        ['SOL', 10_000_000_000n],
        ['USDC', 100_000_000n]
      ])
    })

    it('sends SOL, signed on maki, and the runtime takes it', async () => {
      const before = chain.balance(ME)
      const sig = await wallet.send(network, ME, RECIPIENT, 1_500_000_000n, null)
      expect(base58.decode(sig)).toHaveLength(64)
      expect(chain.balance(RECIPIENT)).toBe(1_500_000_000n)
      // the payment, and a fee of a signature and a little priority
      const fee = before - chain.balance(ME) - 1_500_000_000n
      expect(fee).toBeGreaterThanOrEqual(5_000n)
      expect(fee).toBeLessThan(10_000n)
    })

    it('sends a token to its recipient’s own account, opening it', async () => {
      const [held] = await wallet.holdings(ME)
      const usdc = held.holdings.find((h) => h.token?.symbol === 'USDC')!.token!
      expect(chain.usdc(RECIPIENT)).toBe(-1n)
      await wallet.send(network, ME, RECIPIENT, 5_250_000n, usdc)
      expect(chain.usdc(RECIPIENT)).toBe(5_250_000n)
      expect(chain.usdc(ME)).toBe(94_750_000n)
      // again, to the account it now has
      await wallet.send(network, ME, RECIPIENT, 250_000n, usdc)
      expect(chain.usdc(RECIPIENT)).toBe(5_500_000n)
      // not to a token account: tokens sent to its own would be stuck
      await expect(
        wallet.send(network, ME, associatedTokenAccount(RECIPIENT, USDC), 1n, usdc)
      ).rejects.toThrow('token account, not a wallet')
      // more than it has: the network says so before maki's asked
      await expect(wallet.send(network, ME, RECIPIENT, 1_000_000_000n, usdc)).rejects.toThrow(
        'would fail'
      )
    })
  }
)
