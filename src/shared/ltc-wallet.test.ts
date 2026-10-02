/**
 * maki desktop's Litecoin wallet against the fake maki running maki's Litecoin app (the store's,
 * Bitcoin's wallet code on Litecoin's networks; the test phrase's accounts) and a pretend chain:
 * the addresses are the ones bitcoinjs-lib makes with Litecoin Core's parameters (BIP84's first,
 * `ltc1qjmxnz…`, is the one wallets publish), and a send goes all the way (scan, PSBT, the app's
 * review and maki's signature, broadcast), its signature checked here with noble's own ECDSA and
 * Schnorr.
 */
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hash160 } from '@scure/btc-signer/utils.js'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { BtcAccount, Network } from './protocol'
import { BtcWallet, LITECOIN, parseDescriptor, REPLACEABLE, walletKey } from './btc-wallet'
import { pretendChain } from './stand-ins'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { BitcoinApp, LITECOIN_APP } from './wallet-apps'

/** Someone else's: the key of a seed of sevens, as P2WPKH on Litecoin. */
const PAYEE = 'ltc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j2p9wx9y'

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'the Litecoin wallet, with the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let transport: TcpTransport
    let litecoin: BitcoinApp
    beforeAll(async () => {
      fake = await startFake(['--clock-verified'])
      transport = await TcpTransport.open(fake.port)
      const client = new MakiClient(transport)
      litecoin = new BitcoinApp(
        (app, message, timeoutMs) => client.appMessage(app, message, timeoutMs),
        LITECOIN_APP,
        'Litecoin'
      )
      expect((await litecoin.account(Network.BITCOIN)).approval).toBe('no match')
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'litecoin.maki')))
      expect(await client.appInstall(bundle)).toEqual({ approval: 'approved', reason: '' })
    })
    afterAll(async () => {
      await transport?.close()
      fake?.proc.kill()
    })

    it('works out the addresses Litecoin’s wallets make from the test phrase', async () => {
      const segwit = await litecoin.account(Network.BITCOIN, BtcAccount.SEGWIT)
      const info = parseDescriptor(segwit.descriptor, 'litecoin')
      expect(info).toMatchObject({ kind: 'segwit', network: 'litecoin', fingerprint: 0x73c5da0a })
      const w = new BtcWallet(info, async () => '')
      expect(w.keys.address(0, 0).address).toBe('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh')
      expect(w.keys.address(0, 1).address).toBe('ltc1qwlezpr3890hcp6vva9twqh27mr6edadreqvhnn')
      expect(w.keys.address(1, 0).address).toBe('ltc1qyeljcy9v88jg8sqvnqh0m5q390xruc5r98q9yy')
      const taproot = parseDescriptor(
        (await litecoin.account(Network.BITCOIN, BtcAccount.TAPROOT)).descriptor,
        'litecoin'
      )
      expect(new BtcWallet(taproot, async () => '').keys.address(0, 0).address).toBe(
        'ltc1puht8rk95c53q3u9w3pf9h3jfcutcrl9lxc7rqsdthjrse4k6sn7q9tuqm9'
      )
      // the key Litecoin's wallets take on its own: Bitcoin's zpub, which Electrum-LTC takes
      expect(walletKey(info)).toBe(segwit.zpub)
      const test = await litecoin.account(Network.TESTNET, BtcAccount.SEGWIT)
      const testInfo = parseDescriptor(test.descriptor, 'litecoin')
      expect(testInfo.network).toBe('litecoin-test')
      expect(new BtcWallet(testInfo, async () => '').keys.address(0, 0).address).toBe(
        'tltc1q6rz28mcfaxtmd6v789l9rrlrusdprr9pesrjxk'
      )
      expect(walletKey(testInfo)).toBe(test.zpub)
      // a descriptor of Litecoin's isn't Bitcoin's, nor the other way round
      expect(() => parseDescriptor(segwit.descriptor)).toThrow(/Bitcoin/)
      expect(() =>
        parseDescriptor(segwit.descriptor.replace('/84h/2h/', '/84h/0h/'), 'litecoin')
      ).toThrow(/Litecoin/)
    })

    it('takes Litecoin’s addresses, its old P2SH ones too, and no Bitcoin address', async () => {
      const info = parseDescriptor(
        (await litecoin.account(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor,
        'litecoin'
      )
      const w = new BtcWallet(info, async () => '')
      expect(w.valid(PAYEE)).toBe(true)
      expect(w.valid('LYyKS4hm5QcmAWntuZSA6Kp5TKg9fCeLQn')).toBe(true)
      // the same script, as M… and as the 3… Litecoin's wallets wrote before
      const m = w.script('MUi6eFEWq7Sj3XaWUzJTDvSFTpaSdDR3fq')!
      const three = btc.Address(btc.NETWORK).encode(btc.OutScript.decode(m))
      expect(three.startsWith('3')).toBe(true)
      expect(w.script(three)).toEqual(m)
      expect(w.valid('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe(false)
      expect(w.valid('tltc1q6rz28mcfaxtmd6v789l9rrlrusdprr9pesrjxk')).toBe(false)
      expect(() =>
        w.plan({} as never, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 1n, 1)
      ).toThrow('that isn’t a Litecoin address')
    })

    for (const [kind, account] of [
      ['native SegWit', BtcAccount.SEGWIT],
      ['taproot', BtcAccount.TAPROOT]
    ] as const) {
      it(`sends from ${kind}: maki signs what the wallet made, and the signature checks out`, async () => {
        const info = parseDescriptor(
          (await litecoin.account(Network.BITCOIN, account)).descriptor,
          'litecoin'
        )
        const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
        const chain = pretendChain(receive.address, 100_000, LITECOIN)
        const wallet = new BtcWallet(info, chain.esplora)

        const state = await wallet.scan()
        expect(state.confirmed).toBe(100_000n)
        expect(state.receive.index).toBe(1)

        const made = await wallet.send(state, PAYEE, 30_000n, 2)
        expect(made.fee + made.change + made.sent).toBe(100_000n)
        // maki reviews it in LTC (the payment, its change as change, the fee) and signs
        const r = await litecoin.sign(Network.BITCOIN, made.psbt)
        expect(r.approval, r.reason).toBe('approved')
        await wallet.broadcast(r.signed!)
        const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]))
        expect(tx.getInput(0).sequence).toBe(REPLACEABLE)
        expect(hex.encode(tx.getInput(0).txid!)).toBe(chain.txid)
        expect(btc.Address(LITECOIN).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(
          PAYEE
        )
        expect(tx.getOutput(0).amount).toBe(30_000n)
        expect(tx.getOutput(1).script).toEqual(state.change.script)

        const witness = tx.getInput(0).finalScriptWitness!
        if (account === BtcAccount.SEGWIT) {
          const [sig, pub] = witness
          expect(pub).toEqual(receive.publicKey)
          const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(receive.publicKey) })
          const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 100_000n)
          expect(
            secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
          ).toBe(true)
        } else {
          const [sig] = witness
          const digest = tx.preimageWitnessV1(
            0,
            [receive.script],
            sig.length === 65 ? sig[64] : btc.SigHash.DEFAULT,
            [100_000n]
          )
          expect(schnorr.verify(sig.slice(0, 64), digest, receive.script.slice(2))).toBe(true)
        }
      })
    }

    it('signs nothing for the test network’s accounts that is Litecoin’s', async () => {
      const info = parseDescriptor(
        (await litecoin.account(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor,
        'litecoin'
      )
      const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
      const chain = pretendChain(receive.address, 100_000, LITECOIN)
      const wallet = new BtcWallet(info, chain.esplora)
      const made = await wallet.send(await wallet.scan(), PAYEE, 30_000n, 2)
      const r = await litecoin.sign(Network.TESTNET, made.psbt)
      expect(r.approval).toBe('refused')
      expect(r.reason).toMatch(/isn't this wallet's/)
    })
  },
  60_000
)
