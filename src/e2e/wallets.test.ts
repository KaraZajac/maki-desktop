/**
 * The Wallets page, end to end: the real app, offscreen, linked to the fake maki running maki's
 * Bitcoin and Ethereum apps (maki's own wallet code, the test phrase's accounts), its networks
 * stand-ins on this computer. It adds the Bitcoin account and sends from it, and connects to the
 * Ethereum account and sends a token from it, pressing what a person would; the apps review each
 * and maki signs, and the stand-ins get what's broadcast, which is checked here: where it goes,
 * how much, and that the account signed it. And on a maki without the apps, the page offers the
 * store's.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 *
 * It needs a display to render into (Wayland or X), and builds the app first.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { hash160 } from '@scure/btc-signer/utils.js'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BtcWallet, parseDescriptor } from '../shared/btc-wallet'
import { MakiClient } from '../shared/client'
import { transferData } from '../shared/eth-wallet'
import { BtcAccount, Network } from '../shared/protocol'
import {
  ethStandIn,
  MAKI_ETH,
  pretendChain,
  serveEsplora,
  serveEthRpc,
  signedBy
} from '../shared/stand-ins'
import {
  APP_FIXTURES,
  FAKE_BUILT,
  MAKI_STORE,
  MAKI_STORE_THERE,
  startFake,
  TcpTransport
} from '../shared/test-support'
import { tokensOn } from '../shared/tokens'
import { BITCOIN_APP, BitcoinApp } from '../shared/wallet-apps'
import { build, drive as driveApp, E2E } from './drive'

const ACCOUNT = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
/** Where the stand-in's maki.eth points. */
const PAYEE_ETH = MAKI_ETH
/** BIP173's own example address: somewhere to send that isn't the account's. */
const PAYEE_BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

describe.skipIf(!E2E || !FAKE_BUILT)('the Wallets page, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake([
      '--app',
      join(APP_FIXTURES, 'bitcoin.maki'),
      '--app',
      join(APP_FIXTURES, 'ethereum.maki'),
      '--app',
      join(APP_FIXTURES, 'monero.maki')
    ])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const drive = (steps: string[], env: Record<string, string>): Promise<string> =>
    driveApp(home, fake.port, steps, env)

  it('adds the Bitcoin account, shows its coin, and sends from it: maki signs, the chain gets it', async () => {
    // the account's first receiving address holds 50,000 satoshis
    const t = await TcpTransport.open(fake.port)
    const client = new MakiClient(t)
    const bitcoin = new BitcoinApp((app, message, timeoutMs) =>
      client.appMessage(app, message, timeoutMs)
    )
    const info = parseDescriptor(
      (await bitcoin.account(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
    )
    await t.close()
    const keys = new BtcWallet(info, async () => '').keys
    const chain = pretendChain(keys.address(0, 0).address, 50_000)
    const esplora = await serveEsplora(chain.esplora)
    try {
      const said = await drive(
        [
          ...['--click', 'Wallets', '--click', 'Add from maki', '--until', '0.0005'],
          ...[
            '--click',
            'Send',
            '--fill',
            `bc1…=${PAYEE_BTC}`,
            '--fill',
            '0.00=0.0002',
            '--until',
            'back to you'
          ],
          ...['--click', 'Review on maki', '--until', 'Sent 0.0002 BTC'],
          // then, while it waits for a block, again at the fastest rate there is
          ...[
            '--click',
            'Done',
            '--until',
            'speed up',
            '--click',
            'speed up',
            '--until',
            'Send it again with a higher fee'
          ],
          ...['--click', 'Review on maki', '--until', 'sped up']
        ],
        { MAKI_ESPLORA: esplora.url }
      )
      expect(said).toMatch(/sped up: its fee 703 sats → 1,265 sats/)
    } finally {
      esplora.close()
    }

    // what reached the chain: the coin, spent to the payee, the rest back to the account's change
    expect(chain.broadcast).toHaveLength(2)
    const tx = btc.Transaction.fromRaw(hex.decode(chain.broadcast[0]))
    expect(hex.encode(tx.getInput(0).txid!)).toBe(chain.txid)
    const pay = tx.getOutput(0)
    const change = tx.getOutput(1)
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(pay.script!))).toBe(PAYEE_BTC)
    expect(pay.amount).toBe(20_000n)
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(change.script!))).toBe(
      keys.address(1, 0).address
    )
    const fee = 50_000n - 20_000n - change.amount!
    // the "Normal" rate the stand-in recommends, 5 sat/vB, for 140.5 vB: one SegWit input, two outputs
    expect(fee).toBe(703n)
    // signed by the account's key for that coin
    const [sig, pub] = tx.getInput(0).finalScriptWitness!
    expect(hex.encode(pub)).toBe(hex.encode(keys.address(0, 0).publicKey))
    const code = btc.OutScript.encode({ type: 'pkh', hash: hash160(pub) })
    const digest = tx.preimageWitnessV0(0, code, btc.SigHash.ALL, 50_000n)
    expect(secp256k1.verify(sig.slice(0, -1), digest, pub, { prehash: false, format: 'der' })).toBe(
      true
    )

    // and sped up: the same coin and payment, at 9 sat/vB (1,265 sats), the difference out of the
    // change; it took the first one's place
    const again = btc.Transaction.fromRaw(hex.decode(chain.broadcast[1]))
    expect(hex.encode(again.getInput(0).txid!)).toBe(chain.txid)
    expect(again.getOutput(0).amount).toBe(20_000n)
    expect(again.getOutput(1).amount).toBe(change.amount! - (1_265n - 703n))
    expect([chain.chain.waiting(tx.id), chain.chain.waiting(again.id)]).toEqual([false, true])
    const [sig2, pub2] = again.getInput(0).finalScriptWitness!
    const digest2 = again.preimageWitnessV0(0, code, btc.SigHash.ALL, 50_000n)
    expect(
      secp256k1.verify(sig2.slice(0, -1), digest2, pub2, { prehash: false, format: 'der' })
    ).toBe(true)
  }, 180_000)

  it('connects to the Ethereum account, shows what it holds, and sends a token: maki spells it out and signs', async () => {
    const network = ethStandIn()
    const rpc = await serveEthRpc(network.rpc)
    try {
      const said = await drive(
        [
          ...['--click', 'Wallets', '--click', 'Connect on maki', '--until', 'USDC'],
          ...[
            '--click',
            'Send',
            '--click',
            'USDC',
            '--fill',
            // a name, looked up on the stand-in's ENS: maki shows the address it points to
            '0x… or name.eth=maki.eth',
            '--until',
            'the address maki will show you',
            '--fill',
            '0.00=1.25'
          ],
          ...[
            '--until',
            'maki shows the token',
            '--click',
            'Review on maki',
            '--until',
            'Sent 1.25 USDC on Ethereum'
          ]
        ],
        { MAKI_ETH_RPC: rpc.url }
      )
      expect(said).toContain('Sent 1.25 USDC on Ethereum')
      // what it holds: a coin on every network, and on Ethereum the stand-in's USDC too
      expect(said).toMatch(/Ethereum[\s\S]*1\.5[\s\S]*USDC/)
    } finally {
      rpc.close()
    }

    const raw = network.sent.find(([, m]) => m === 'eth_sendRawTransaction')![2][0] as string
    const { fields, from } = signedBy(raw)
    expect(from.toLowerCase()).toBe(ACCOUNT.toLowerCase())
    const usdc = tokensOn(1n).find((t) => t.symbol === 'USDC')!
    // chain 1, to the token's contract, nothing but the transfer
    expect(Number(BigInt('0x' + (hex.encode(fields[0]) || '0')))).toBe(1)
    expect('0x' + hex.encode(fields[5])).toBe(usdc.contract.toLowerCase())
    expect('0x' + hex.encode(fields[7])).toBe(transferData(PAYEE_ETH, 1_250_000n))
  }, 180_000)
})

const PRIMARY =
  '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn'

describe.skipIf(!E2E || !FAKE_BUILT)('the Wallets page, Monero', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'monero.maki')])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('shows the Monero address once it matches maki’s, and a fresh subaddress', async () => {
    const said = await driveApp(
      home,
      fake.port,
      [
        // the test phrase's primary address, as Ledger's Monero app and monero-python make it
        ...['--click', 'Wallets', '--click', 'Show on maki', '--until', PRIMARY],
        ...['--click', 'A fresh subaddress', '--until', 'matches maki']
      ],
      {}
    )
    // then subaddress 1, in its place
    expect(said).toContain(
      '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ'
    )
    expect(said).not.toContain(PRIMARY)
  }, 180_000)
})

describe.skipIf(!E2E || !FAKE_BUILT || !MAKI_STORE_THERE)('the Wallets page, on a maki without the apps', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake()
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('offers the Bitcoin app from the maki store, and has the account once maki installs it', async () => {
    // the test phrase's first address (BIP84's vector) holds 50,000 satoshis, on a stand-in chain
    const chain = pretendChain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 50_000)
    const esplora = await serveEsplora(chain.esplora)
    let said = ''
    try {
      said = await driveApp(
        home,
        fake.port,
        [
          ...['--click', 'Wallets', '--until', 'Bitcoin app isn’t installed'],
          ...['--click', 'Add Bitcoin', '--gone', 'Bitcoin app isn’t installed'],
          ...['--click', 'Add from maki', '--until', '0.0005']
        ],
        { MAKI_STORE, MAKI_ESPLORA: esplora.url }
      )
    } finally {
      esplora.close()
    }
    // the account's coin, from the stand-in chain
    expect(said).toMatch(/0\.0005/)
    const t = await TcpTransport.open(fake.port)
    try {
      const apps = (await new MakiClient(t).appList()).apps
      // from the store, as the store's
      expect(apps.map((a) => [a.id, a.fromStore])).toContainEqual([BITCOIN_APP, true])
    } finally {
      await t.close()
    }
  }, 180_000)
})
