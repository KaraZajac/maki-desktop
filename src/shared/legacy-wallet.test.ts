/**
 * maki desktop's Dogecoin and Bitcoin Cash wallets against the fake maki running maki's apps for them
 * (Bitcoin's wallet code before SegWit; the test phrase's accounts) and a pretend chain: the
 * addresses are the ones wallets publish for the test phrase (and bitcoinjs-lib's and libauth's,
 * maki-btc's fixtures), and a send goes all the way (scan, PSBT, the app's review and maki's
 * signature, finished here, broadcast), each signature checked with noble: Dogecoin's over the old
 * digest, Bitcoin Cash's over BIP143's with its fork ID.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { BtcAccount, Network, type NetworkValue } from './protocol'
import { BITCOINCASH, BtcWallet, DOGECOIN, parseDescriptor } from './btc-wallet'
import { cashChain } from './electrum-esplora'
import { pretendChain } from './stand-ins'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { BITCOINCASH_APP, BitcoinApp, DOGECOIN_APP } from './wallet-apps'

const CASH = cashChain('bitcoincash', BITCOINCASH)

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'the Dogecoin and Bitcoin Cash wallets, with the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let transport: TcpTransport
    let doge: BitcoinApp
    let bch: BitcoinApp
    beforeAll(async () => {
      fake = await startFake(['--clock-verified'])
      transport = await TcpTransport.open(fake.port)
      const client = new MakiClient(transport)
      const send = (app: string, message: Uint8Array, timeoutMs?: number) =>
        client.appMessage(app, message, timeoutMs)
      doge = new BitcoinApp(send, DOGECOIN_APP, 'Dogecoin')
      bch = new BitcoinApp(send, BITCOINCASH_APP, 'Bitcoin Cash')
      for (const name of ['dogecoin.maki', 'bitcoincash.maki']) {
        const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, name)))
        expect(await client.appInstall(bundle)).toEqual({ approval: 'approved', reason: '' })
      }
    })
    afterAll(async () => {
      await transport?.close()
      fake?.proc.kill()
    })

    const wallet = async (
      app: BitcoinApp,
      chain: 'dogecoin' | 'bitcoincash',
      network: NetworkValue = Network.BITCOIN
    ) => parseDescriptor((await app.account(network, BtcAccount.LEGACY)).descriptor, chain)

    it('works out the addresses wallets publish for the test phrase', async () => {
      const d = await wallet(doge, 'dogecoin')
      expect(d).toMatchObject({ kind: 'legacy', network: 'dogecoin', fingerprint: 0x73c5da0a })
      const dk = new BtcWallet(d, async () => '').keys
      expect(dk.address(0, 0).address).toBe('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC')
      expect(dk.address(1, 0).address).toBe('D7ReBLrRv12mi9pYh5HtfFLTt1PSoeAa7e')
      const b = await wallet(bch, 'bitcoincash')
      const bk = new BtcWallet(b, async () => '').keys
      expect(bk.address(0, 0).address).toBe(
        'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6'
      )
      expect(bk.address(1, 0).address).toBe(
        'bitcoincash:qr8aeharupyrmhfu0d4tdmsnc5y8cfk47y6qrsjsrx'
      )
      // their test networks', at coin type 1
      const dt = new BtcWallet(await wallet(doge, 'dogecoin', Network.TESTNET), async () => '').keys
      expect(dt.address(0, 0).address).toBe('nZVmfmUtKPmskB9Ds4P9GUJy9eYFqPKHqH')
      const bt = new BtcWallet(await wallet(bch, 'bitcoincash', Network.TESTNET), async () => '')
        .keys
      expect(bt.address(0, 0).address).toBe('bchtest:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ymst35fx4')
      // the apps have no SegWit account to give
      expect(
        (await doge.account(Network.BITCOIN, BtcAccount.SEGWIT).catch((e) => e)).message
      ).toMatch(/couldn’t read/)
    })

    it('sends Dogecoin: maki signs the old digest, and the signature checks out', async () => {
      const info = await wallet(doge, 'dogecoin')
      const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
      const chain = pretendChain(receive.address, 5_000_000_000, DOGECOIN) // 50 DOGE
      const w = new BtcWallet(info, chain.esplora)
      const state = await w.scan()
      expect(state.confirmed).toBe(5_000_000_000n)
      // 10 DOGE to someone, at 0.01 DOGE a kilobyte (1,000 koinu a byte)
      const payee = 'DL54i6msdfchWaR7NHFA41HxSiYciTwhqW'
      const made = await w.send(state, payee, 1_000_000_000n, 1000)
      expect(made.fee + made.change + made.sent).toBe(5_000_000_000n)
      const r = await doge.sign(Network.BITCOIN, made.psbt)
      expect(r.approval, r.reason).toBe('approved')
      await w.broadcast(r.signed!)
      const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]), {
        allowUnknownInputs: true
      })
      expect(btc.Address(DOGECOIN).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(
        payee
      )
      expect(tx.getOutput(0).amount).toBe(1_000_000_000n)
      // <signature> <key>, the signature over the transaction as it was before SegWit, SIGHASH_ALL
      const [sig, pub] = btc.Script.decode(tx.getInput(0).finalScriptSig!) as Uint8Array[]
      expect(pub).toEqual(receive.publicKey)
      expect(sig[sig.length - 1]).toBe(btc.SigHash.ALL)
      // btc-signer's own digest, which its types keep to itself
      const legacy = tx as unknown as {
        preimageLegacy(i: number, script: Uint8Array, hashType: number): Uint8Array
      }
      const digest = legacy.preimageLegacy(0, receive.script, btc.SigHash.ALL)
      expect(
        secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
      ).toBe(true)
      // and it isn't replaceable: Dogecoin's nodes don't all take a replacement
      expect(tx.getInput(0).sequence).toBe(0xfffffffe)
    })

    it('sends Bitcoin Cash: maki signs with its fork ID, and the signature checks out', async () => {
      const info = await wallet(bch, 'bitcoincash')
      const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
      const chain = pretendChain(receive.address, 100_000, BITCOINCASH, CASH)
      const w = new BtcWallet(info, chain.esplora)
      const state = await w.scan()
      expect(state.confirmed).toBe(100_000n)
      const payee = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
      const made = await w.send(state, payee, 30_000n, 1.01)
      const r = await bch.sign(Network.BITCOIN, made.psbt)
      expect(r.approval, r.reason).toBe('approved')
      await w.broadcast(r.signed!)
      const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]), {
        allowUnknownInputs: true
      })
      expect(CASH.address(tx.getOutput(0).script!)).toBe(payee)
      expect(CASH.address(tx.getOutput(1).script!)).toBe(state.change.address)
      const [sig, pub] = btc.Script.decode(tx.getInput(0).finalScriptSig!) as Uint8Array[]
      expect(sig[sig.length - 1]).toBe(0x41)
      // BIP143's digest with SIGHASH_ALL | SIGHASH_FORKID (its fork ID zero)
      const digest = tx.preimageWitnessV0(0, receive.script, 0x41, 100_000n)
      expect(
        secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
      ).toBe(true)
      // a payment to a Bitcoin address is no Bitcoin Cash payment
      expect(() => w.plan(state, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 1_000n, 1)).toThrow(
        'that isn’t a Bitcoin Cash address'
      )
      // nor can a payment be sped up: Bitcoin Cash keeps the first it sees
      await expect(w.bump(tx.id, 5)).rejects.toThrow(/keeps the first payment/)
    })

    it('signs nothing on the test network’s account that’s the main network’s', async () => {
      const info = await wallet(bch, 'bitcoincash')
      const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
      const chain = pretendChain(receive.address, 100_000, BITCOINCASH, CASH)
      const w = new BtcWallet(info, chain.esplora)
      const made = await w.send(
        await w.scan(),
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        30_000n,
        1
      )
      const r = await bch.sign(Network.TESTNET, made.psbt)
      expect(r.approval).toBe('refused')
      expect(r.reason).toMatch(/isn't this wallet's/)
    })
  },
  60_000
)
