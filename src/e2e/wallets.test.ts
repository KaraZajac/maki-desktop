/**
 * The Wallets page, end to end: the real app, offscreen, linked to the fake maki (maki's own
 * wallet code, the test phrase's accounts), its networks stand-ins on this computer. It adds the
 * Bitcoin account and sends from it, and connects to the Ethereum account and sends a token from
 * it, pressing what a person would; maki reviews and signs each, and the stand-ins get what's
 * broadcast, which is checked here: where it goes, how much, and that the account signed it.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 *
 * It needs a display to render into (Wayland or X), and builds the app first.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { hash160 } from '@scure/btc-signer/utils.js'
import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BtcWallet, parseDescriptor } from '../shared/btc-wallet'
import { MakiClient } from '../shared/client'
import { transferData } from '../shared/eth-wallet'
import { BtcAccount, Network } from '../shared/protocol'
import { ethStandIn, pretendChain, serveEsplora, serveEthRpc, signedBy } from '../shared/stand-ins'
import { FAKE_BUILT, startFake, TcpTransport } from '../shared/test-support'
import { tokensOn } from '../shared/tokens'

const DESKTOP = resolve(__dirname, '../..')
const ELECTRON = join(DESKTOP, 'node_modules/electron/dist/electron')
const ACCOUNT = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const PAYEE_ETH = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
/** BIP173's own example address: somewhere to send that isn't the account's. */
const PAYEE_BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

describe.skipIf(!process.env.MAKI_E2E || !FAKE_BUILT)('the Wallets page, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    execFileSync('npm', ['run', '-s', 'build'], { cwd: DESKTOP, stdio: 'ignore' })
    fake = await startFake()
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** The app, clicked through `steps`; what its page said at the end. */
  const drive = (steps: string[], env: Record<string, string>): Promise<string> => {
    const page = join(home, 'page.png')
    const text = join(home, 'page.txt')
    const wayland = process.env.WAYLAND_DISPLAY
    return new Promise((ok, fail) =>
      execFile(
        ELECTRON,
        [
          join(DESKTOP, 'scripts/screenshot.cjs'),
          page,
          '--fake',
          '--size',
          '1080x1600',
          ...steps,
          '--dump',
          text
        ],
        {
          cwd: DESKTOP,
          env: {
            ...process.env,
            // its settings, sockets and anything else it keeps, in here
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_RUNTIME_DIR: home,
            // the display, wherever it was: its name alone is relative to the runtime directory
            ...(wayland && !wayland.startsWith('/') && process.env.XDG_RUNTIME_DIR
              ? { WAYLAND_DISPLAY: join(process.env.XDG_RUNTIME_DIR, wayland) }
              : {}),
            MAKI_FAKE_PORT: String(fake.port),
            ...env
          },
          timeout: 170_000
        },
        (e, _out, err) => {
          let said = ''
          try {
            said = readFileSync(text, 'utf8')
          } catch {
            // nothing to read: it didn't get that far
          }
          if (e) fail(new Error(`${err}\n--- the page said:\n${said}`))
          else ok(said)
        }
      )
    )
  }

  it('adds the Bitcoin account, shows its coin, and sends from it: maki signs, the chain gets it', async () => {
    // the account's first receiving address holds 50,000 satoshis
    const t = await TcpTransport.open(fake.port)
    const info = parseDescriptor(
      (await new MakiClient(t).btcAccount(Network.BITCOIN, BtcAccount.SEGWIT)).descriptor
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
          ...['--click', 'Review on maki', '--until', 'Sent 0.0002 BTC']
        ],
        { MAKI_ESPLORA: esplora.url }
      )
      expect(said).toContain('Sent 0.0002 BTC')
    } finally {
      esplora.close()
    }

    // what reached the chain: the coin, spent to the payee, the rest back to the account's change
    expect(chain.broadcast).toHaveLength(1)
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
            `0x…=${PAYEE_ETH}`,
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
