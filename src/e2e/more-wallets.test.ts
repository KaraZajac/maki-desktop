/**
 * The TON, Dash, DigiByte and Zcash wallets, end to end: the real app, offscreen, linked to the fake
 * maki running maki's TON, Dash, DigiByte and Zcash apps (the test phrase's accounts), each network
 * stood in for on this computer, answering as its own servers answer. For each, it adds the account
 * from maki, sees what it holds, and sends from it, pressing what a person would: the app makes the
 * payment, maki's app reads it and signs, and the stand-in takes it only if the signature checks out,
 * by the account's own key, over what the network hashes; what it took is what was asked for.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e/more-wallets.test.ts
 *
 * It needs a display to render into (Wayland or X), and builds the app first.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TON_KEY,
  TON_THEM,
  TON_USDT,
  TON_W5,
  tonStandIn,
  ZEC_NEXT_CHANGE,
  ZEC_THEM,
  zecblockStandIn
} from '../shared/coin-stand-ins'
import { jettonWallet, JETTONS, walletAddress } from '../shared/coins/ton'
import { rawAddress, readAddress } from '../shared/coins/ton-cells'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { hash160 } from '@scure/btc-signer/utils.js'
import { DASH, DIGIBYTE } from '../shared/btc-wallet'
import { DashInsight, pretendChain, serve, serveEsplora } from '../shared/stand-ins'
import { APP_FIXTURES, FAKE_BUILT, startFake } from '../shared/test-support'
import { build, drive, E2E } from './drive'

describe.skipIf(!E2E || !FAKE_BUILT)(
  'the TON, Dash, DigiByte and Zcash wallets, end to end',
  () => {
    let fake: { port: number; proc: ChildProcess }
    const homes: string[] = []
    /** A home of the test's own: the app keeps the accounts it adds. */
    const home = (): string => {
      const h = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
      homes.push(h)
      return h
    }

    beforeAll(async () => {
      build()
      fake = await startFake(
        ['ton', 'dash', 'digibyte', 'zcash'].flatMap((a) => [
          '--app',
          join(APP_FIXTURES, `${a}.maki`)
        ])
      )
    }, 180_000)
    afterAll(() => {
      fake?.proc.kill()
      for (const h of homes) rmSync(h, { recursive: true, force: true })
    })

    it('adds the TON account, shows both its wallets, sends USDT from v4R2 and TON from W5, setting it up: maki signs, toncenter takes them', async () => {
      const network = tonStandIn()
      const server = await serve(network.answer)
      let said = ''
      try {
        said = await drive(
          home(),
          fake.port,
          [
            // the v4R2 wallet maki shares (25 TON, 40 USDT), and the W5 one beside it, holding 3 TON
            ...['--click', 'Wallets', '--click', 'TON › Add from maki'],
            ...['--until', 'TON W5 wallet', '--until', 'Received', '--until', '25TON'],
            ...['--until', '3TON', '--until', 'USDT\n40'],
            ...['--click', 'TON › Send', '--choose', TON_USDT, '--fill', `UQ… or EQ…=${TON_THEM}`],
            ...['--fill', '0.00=7.25', '--fill', 'if the recipient asked for one=order 7'],
            ...[
              '--click',
              'TON › Review on maki',
              '--until',
              'Sent 7.25 USDT',
              '--click',
              'TON › Done'
            ],
            // what's left, looked at again: the stand-in took it
            ...['--until', 'USDT\n32.75'],
            // then from the W5 wallet: its first payment, which sets it up
            ...['--click', 'TON W5 wallet › Send', '--fill', `UQ… or EQ…=${TON_THEM}`],
            ...['--fill', '0.00=1.5', '--click', 'TON W5 wallet › Review on maki'],
            ...['--until', 'Sent 1.5 TON', '--click', 'TON W5 wallet › Done'],
            // its address, as maki's app shows the W5 wallet's: the same
            ...[
              '--click',
              'TON W5 wallet › Receive',
              '--click',
              'TON W5 wallet › Check it on maki'
            ],
            ...['--until', 'It’s yours.']
          ],
          { MAKI_COIN_SERVER: server.url }
        )
      } finally {
        server.close()
      }
      expect(said).toContain('You said maki shows the same address. It’s yours.')
      expect(said).toContain(TON_W5)
      // v4R2's TON after the jetton transfer: the 0.05 TON it took and the stand-in's fee
      expect(said).toMatch(/V4R2 WALLET · BALANCE\s*24\.94753333\s*TON/)
      const v4 = walletAddress('v4R2', TON_KEY, 0)
      const them = rawAddress(readAddress(TON_THEM)!.address)
      expect(network.sent).toEqual([
        {
          wallet: 'v4R2',
          seqno: 7,
          init: false,
          messages: [
            {
              mode: 3,
              to: rawAddress(jettonWallet(JETTONS[0], v4)),
              bounce: true,
              value: 50_000_000n,
              jetton: {
                amount: 7_250_000n,
                to: them,
                response: rawAddress(v4),
                forwardTon: 1n,
                comment: 'order 7'
              }
            }
          ]
        },
        {
          wallet: 'v5R1',
          seqno: 0,
          init: true,
          messages: [{ mode: 3, to: them, bounce: false, value: 1_500_000_000n }]
        }
      ])
    }, 240_000)

    it('adds the Dash account, shows its coins, and spends one from Dash Platform with another: maki signs, Insight takes it', async () => {
      // the test phrase's first two receiving addresses (Dash Core's, Ledger's, Trezor's): a plain
      // coin, and one a withdrawal from Dash Platform paid (an asset unlock: special, with a payload)
      const insight = new DashInsight(DASH)
      const plain = insight.fund('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5', 150_000_000n)
      const platform = insight.withdraw('XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ', 25_000_000n)
      const server = await serve(insight.answer)
      const payee = 'XtNTcJBRDXN6xLh8o56kAMSvgFpxwVh4rJ'
      let said = ''
      try {
        said = await drive(
          home(),
          fake.port,
          [
            ...['--click', 'Wallets', '--click', 'Dash › Add from maki', '--until', '1.75'],
            ...['--click', 'Dash › Send', '--fill', `X…=${payee}`, '--fill', '0.00=1.6'],
            ...['--until', 'back to you', '--click', 'Dash › Review on maki'],
            ...['--until', 'Sent 1.6 DASH']
          ],
          { MAKI_INSIGHT: server.url }
        )
      } finally {
        server.close()
      }
      expect(said).toContain('Sent 1.6 DASH')
      // both coins, the payment, the change to the account's first change address; each input's
      // signature checked by the stand-in, by its coin's key, over the digest from before SegWit
      expect(insight.sent).toEqual([
        expect.objectContaining({
          inputs: [
            { txid: plain, vout: 0 },
            { txid: platform, vout: 0 }
          ],
          outputs: [
            { address: payee, value: 160_000_000n },
            {
              address: 'XeBdurzVrhrFtgqf9SxzQqvhHodb53njW4',
              value: 175_000_000n - 160_000_000n - insight.sent[0].fee
            }
          ]
        })
      ])
    }, 240_000)

    it('adds the DigiByte account, shows its coin, and sends from it: maki signs, the chain gets it', async () => {
      // the test phrase's first native SegWit address on DigiByte holds 12.5 DGB
      const receive = 'dgb1q9gmf0pv8jdymcly6lz6fl7lf6mhslsd72e2jq8'
      const payee = 'dgb1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j2jzs696'
      const chain = pretendChain(receive, 1_250_000_000, DIGIBYTE)
      const esplora = await serveEsplora(chain.esplora)
      let said = ''
      try {
        said = await drive(
          home(),
          fake.port,
          [
            ...['--click', 'Wallets', '--click', 'DigiByte › Add from maki', '--until', '12.5'],
            ...['--click', 'DigiByte › Send', '--fill', `dgb1…, D… or S…=${payee}`],
            ...['--fill', '0.00=2.5', '--until', 'back to you'],
            ...['--click', 'DigiByte › Review on maki', '--until', 'Sent 2.5 DGB']
          ],
          { MAKI_ESPLORA: esplora.url }
        )
      } finally {
        esplora.close()
      }
      expect(said).toContain('Sent 2.5 DGB')
      expect(chain.broadcast).toHaveLength(1)
      const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]))
      expect(hex.encode(tx.getInput(0).txid!)).toBe(chain.txid)
      expect(btc.Address(DIGIBYTE).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(
        payee
      )
      expect(tx.getOutput(0).amount).toBe(250_000_000n)
      // its change to the account's first change address, less the fee at the "Normal" estimate
      // (150 sat/vB, half an hour's: 144 blocks') for 140.5 vB
      expect(btc.Address(DIGIBYTE).encode(btc.OutScript.decode(tx.getOutput(1).script!))).toBe(
        'dgb1quca5eag8pyzhmnqtfg47krt7r4ywn4dgfzela7'
      )
      expect(tx.getOutput(1).amount).toBe(1_000_000_000n - 21_075n)
      // signed by the account's key for that coin, over BIP143's digest
      const [sig, pub] = tx.getInput(0).finalScriptWitness!
      expect(btc.p2wpkh(pub, DIGIBYTE).address).toBe(receive)
      const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(pub) })
      const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 1_250_000_000n)
      expect(
        secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })
      ).toBe(true)
    }, 240_000)

    it('adds the Zcash account, finds its coins on two addresses, and pays from both: maki signs each, zecblock takes it', async () => {
      const network = zecblockStandIn()
      const server = await serve(network.answer)
      let said = ''
      try {
        said = await drive(
          home(),
          fake.port,
          [
            ...['--click', 'Wallets', '--click', 'Zcash › Add from maki', '--until', 'as of'],
            ...['--until', '1.75', '--click', 'Zcash › Send'],
            ...['--fill', `t1… or tex1…=${ZEC_THEM}`, '--fill', '0.00=1.6'],
            ...['--click', 'Zcash › Review on maki', '--until', 'Sent 1.6 ZEC'],
            // then, looked at again: on its way, its change still the account's
            ...['--click', 'Zcash › Done', '--until', 'waits for a block']
          ],
          { MAKI_COIN_SERVER: server.url }
        )
      } finally {
        server.close()
      }
      expect(said).toContain('waits for a block')
      expect(said).toMatch(/0\.1499\s*ZEC/)
      // both coins, the payment, the change to the next change address, ZIP-317's fee; each
      // input's signature checked by the stand-in over ZIP-244's digest, by its coin's key
      expect(network.sent).toEqual([
        {
          txid: expect.stringMatching(/^[0-9a-f]{64}$/),
          inputs: [
            { txid: 'a1'.repeat(32), vout: 0 },
            { txid: 'b2'.repeat(32), vout: 1 }
          ],
          outputs: [
            { address: ZEC_THEM, value: 160_000_000n },
            { address: ZEC_NEXT_CHANGE, value: 14_990_000n }
          ],
          fee: 10_000n
        }
      ])
    }, 240_000)
  }
)
