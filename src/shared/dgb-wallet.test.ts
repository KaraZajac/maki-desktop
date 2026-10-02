/**
 * maki desktop's DigiByte wallet with the fake maki running maki's DigiByte app (Bitcoin's wallet
 * code on DigiByte's networks; the test phrase's accounts): its three accounts' addresses as
 * DigiByte's own libraries make them (maki-btc's fixtures), its fee estimates from a plain Esplora
 * (digiexplorer.info's, by blocks), and a payment from each account against a pretend chain, maki's
 * signature checked here over the digest its kind signs: SegWit's (BIP143), taproot's (BIP341),
 * and the one from before SegWit.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { hash160 } from '@scure/btc-signer/utils.js'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BtcWallet,
  DIGIBYTE,
  DUST_OF,
  explorerLink,
  parseDescriptor,
  REPLACEABLE
} from './btc-wallet'
import { MakiClient } from './client'
import { BtcAccount, Network, type BtcAccountValue, type NetworkValue } from './protocol'
import { pretendChain } from './stand-ins'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'
import { BitcoinApp, DIGIBYTE_APP } from './wallet-apps'

/** Someone else's: maki-btc's fixture's payee, a seed of sevens' key as P2WPKH on DigiByte. */
const PAYEE = 'dgb1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j2jzs696'

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)(
  'the DigiByte wallet, with the fake maki',
  () => {
    let fake: { port: number; proc: ChildProcess }
    let transport: TcpTransport
    let dgb: BitcoinApp
    beforeAll(async () => {
      fake = await startFake(['--clock-verified'])
      transport = await TcpTransport.open(fake.port)
      const client = new MakiClient(transport)
      dgb = new BitcoinApp(
        (app, message, timeoutMs) => client.appMessage(app, message, timeoutMs),
        DIGIBYTE_APP,
        'DigiByte'
      )
      const bundle = new Uint8Array(readFileSync(join(APP_FIXTURES, 'digibyte.maki')))
      expect(await client.appInstall(bundle)).toEqual({ approval: 'approved', reason: '' })
    })
    afterAll(async () => {
      await transport?.close()
      fake?.proc.kill()
    })

    const account = async (kind: BtcAccountValue, network: NetworkValue = Network.BITCOIN) =>
      parseDescriptor((await dgb.account(network, kind)).descriptor, 'digibyte')

    it('works out the addresses DigiByte’s wallets make for the test phrase, in all three accounts', async () => {
      const at = async (
        kind: BtcAccountValue,
        chain: 0 | 1,
        index: number,
        network: NetworkValue = Network.BITCOIN
      ) =>
        new BtcWallet(await account(kind, network), async () => '').keys.address(chain, index)
          .address
      expect(await at(BtcAccount.SEGWIT, 0, 0)).toBe('dgb1q9gmf0pv8jdymcly6lz6fl7lf6mhslsd72e2jq8')
      expect(await at(BtcAccount.SEGWIT, 0, 1)).toBe('dgb1qg2qjk6wgrcqpnr7l2fvy2me9x0xc6czsehk7jt')
      expect(await at(BtcAccount.SEGWIT, 1, 0)).toBe('dgb1quca5eag8pyzhmnqtfg47krt7r4ywn4dgfzela7')
      expect(await at(BtcAccount.LEGACY, 0, 0)).toBe('DG1KhhBKpsyWXTakHNezaDQ34focsXjN1i')
      expect(await at(BtcAccount.LEGACY, 1, 0)).toBe('DRxxhYdXPMKL9y1kZpgLz1GJpaZ23bTcQE')
      expect(await at(BtcAccount.TAPROOT, 0, 0)).toBe(
        'dgb1pcevt23hht82rkdrjdpwzstmqyj4ngyy42r9cu73rl4n9h5vu6hgsx5tm5q'
      )
      expect(await at(BtcAccount.TAPROOT, 1, 1)).toBe(
        'dgb1pq296zua4gmxfkn698jcmztvnym34cxqyr5ddqak575ry8mvz9wjqgtx0dd'
      )
      // the test network's, at coin type 1
      expect(await at(BtcAccount.SEGWIT, 0, 0, Network.TESTNET)).toBe(
        'dgbt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pg05lg0'
      )
      expect(await at(BtcAccount.LEGACY, 0, 0, Network.TESTNET)).toBe(
        'sntcUBMdYjoGNoxMBWiHa6rCLCtX7V7ggr'
      )
      // its accounts' keys as maki-btc's fixtures have them
      expect((await account(BtcAccount.SEGWIT)).xpub).toBe(
        'xpub6BmjNc3e3DmWgKc5xswF9m4pCrJ8qSw9LcHmLsdymvkuYm9BCRqYvkVbkC8JijGLZDwgG62hysxgAf32EdHVVQjiabWVfJ6xMRe425ph1B2'
      )
      expect((await account(BtcAccount.LEGACY)).xpub).toBe(
        'xpub6Cj2cdNXaWhn9mwjaxofCJujxrALww7kw6WcyCsGnU9twBEsGcaMqR6gCtQ9b3k6awqL2egNaat2btUCVoETYzcmngU9outdn6RA2KxmNEn'
      )
    })

    it('takes DigiByte’s addresses, and no Bitcoin or Dogecoin one', async () => {
      const w = new BtcWallet(await account(BtcAccount.SEGWIT), async () => '')
      expect(w.valid(PAYEE)).toBe(true)
      expect(w.valid('DG1KhhBKpsyWXTakHNezaDQ34focsXjN1i')).toBe(true)
      expect(w.valid('SNrExv4meNtf7QKvwj5EWudgZUrE14xFqc')).toBe(true)
      expect(w.valid('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe(false)
      expect(w.valid('dgbt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pg05lg0')).toBe(false)
      expect(explorerLink('digibyte', 'tx', 'ab'.repeat(32))).toBe(
        `https://digiexplorer.info/tx/${'ab'.repeat(32)}`
      )
    })

    it('reads its fee estimates by blocks, never below what its nodes relay', async () => {
      const w = new BtcWallet(await account(BtcAccount.SEGWIT), async (_n, path) => {
        expect(path).toBe('/fee-estimates')
        return JSON.stringify({
          '1': 369.314,
          '2': 369.314,
          '144': 150.0,
          '504': 20,
          '1008': 150.0
        })
      })
      // a block every 15 seconds: half an hour is 120 blocks (144's estimate), an hour 240 (504's)
      expect(await w.feeRates()).toEqual({
        fastestFee: 370,
        halfHourFee: 150,
        hourFee: 100,
        economyFee: 150,
        minimumFee: 100
      })
    })

    for (const [kind, value] of [
      ['native SegWit', BtcAccount.SEGWIT],
      ['taproot', BtcAccount.TAPROOT],
      ['legacy', BtcAccount.LEGACY]
    ] as const) {
      it(`sends from its ${kind} account: maki signs, and the signature checks out`, async () => {
        const info = await account(value)
        const receive = new BtcWallet(info, async () => '').keys.address(0, 0)
        const chain = pretendChain(receive.address, 50_000_000, DIGIBYTE) // 0.5 DGB
        const wallet = new BtcWallet(info, chain.esplora)
        const state = await wallet.scan()
        expect(state.confirmed).toBe(50_000_000n)
        const rates = await wallet.feeRates()
        const made = await wallet.send(state, PAYEE, 20_000_000n, rates.halfHourFee)
        expect(made.fee + made.change + made.sent).toBe(50_000_000n)
        expect(made.change).toBeGreaterThan(DUST_OF.digibyte)
        const r = await dgb.sign(Network.BITCOIN, made.psbt)
        expect(r.approval, r.reason).toBe('approved')
        await wallet.broadcast(r.signed!)
        const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]), {
          allowUnknownInputs: true
        })
        expect(btc.Address(DIGIBYTE).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(
          PAYEE
        )
        expect(tx.getOutput(0).amount).toBe(20_000_000n)
        expect(tx.getOutput(1).script).toEqual(state.change.script)
        // replaceable: DigiByte Core takes a replacement (BIP125)
        expect(tx.getInput(0).sequence).toBe(REPLACEABLE)
        if (value === BtcAccount.SEGWIT) {
          const [sig, pub] = tx.getInput(0).finalScriptWitness!
          const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(pub) })
          const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 50_000_000n)
          expect(
            secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
          ).toBe(true)
        } else if (value === BtcAccount.TAPROOT) {
          const [sig] = tx.getInput(0).finalScriptWitness!
          const digest = tx.preimageWitnessV1(
            0,
            [receive.script],
            sig.length === 65 ? sig[64] : btc.SigHash.DEFAULT,
            [50_000_000n]
          )
          expect(schnorr.verify(sig.slice(0, 64), digest, receive.script.slice(2))).toBe(true)
        } else {
          const [sig, pub] = btc.Script.decode(tx.getInput(0).finalScriptSig!) as Uint8Array[]
          expect(pub).toEqual(receive.publicKey)
          const legacy = tx as unknown as {
            preimageLegacy(i: number, script: Uint8Array, hashType: number): Uint8Array
          }
          const digest = legacy.preimageLegacy(0, receive.script, btc.SigHash.ALL)
          expect(
            secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
          ).toBe(true)
        }
      })
    }
  },
  60_000
)
