/**
 * The Wallets page's account coins, end to end: the real app, offscreen, linked to the fake maki
 * running maki's XRP, Stellar, Tron, Kaspa, Aptos and NEAR apps (the test phrase's accounts), each network stood in for
 * on this computer (coin-stand-ins.ts). For each, it adds the account from maki, sees what it holds,
 * and sends a token from it, pressing what a person would: the app makes the payment, maki's app
 * reads it and signs, and the stand-in takes it only if the signature checks out, by the account's
 * own key, over what the network hashes; what it took is what was asked for.
 *
 *     MAKI_E2E=1 npx vitest run src/e2e
 *
 * It needs a display to render into (Wayland or X), and builds the app first.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APT_ME,
  APT_THEM,
  APT_USDC,
  aptosStandIn,
  KAS_ME,
  KAS_NEXT_CHANGE,
  KAS_THEM,
  kaspaStandIn,
  NEAR_ME,
  NEAR_THEM,
  NEAR_USDC,
  nearStandIn,
  stellarStandIn,
  tronStandIn,
  TRX_ME,
  TRX_THEM,
  TRX_USDT,
  XLM_ME,
  XLM_THEM,
  XLM_USDC,
  XRP_ME,
  XRP_RLUSD,
  XRP_THEM,
  xrpStandIn
} from '../shared/coin-stand-ins'
import { serve } from '../shared/stand-ins'
import { APP_FIXTURES, FAKE_BUILT, startFake } from '../shared/test-support'
import { build, drive, E2E } from './drive'

const RLUSD = '524C555344000000000000000000000000000000'

describe.skipIf(!E2E || !FAKE_BUILT)('the account wallets, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  const homes: string[] = []
  /** A home of the test's own: the app keeps the accounts it adds, and each test has one network. */
  const home = (): string => {
    const h = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
    homes.push(h)
    return h
  }

  beforeAll(async () => {
    build()
    fake = await startFake(
      ['xrp', 'stellar', 'tron', 'kaspa', 'aptos', 'near'].flatMap((a) => [
        '--app',
        join(APP_FIXTURES, `${a}.maki`)
      ])
    )
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    for (const h of homes) rmSync(h, { recursive: true, force: true })
  })

  it('adds the XRP account, shows its XRP and RLUSD, and sends RLUSD with a destination tag: maki signs, the ledger takes it', async () => {
    const ledger = xrpStandIn()
    const server = await serve(ledger.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'XRP › Add from maki', '--until', 'as of'],
          ...['--click', 'XRP › Send', '--choose', `${RLUSD}.${XRP_RLUSD}`],
          ...['--fill', `r…=${XRP_THEM}`, '--fill', '0.00=5.25'],
          ...['--fill', 'if the recipient gave one=12345'],
          ...['--click', 'XRP › Review on maki', '--until', 'Sent 5.25 RLUSD']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 5.25 RLUSD')
      // what it held: 100 XRP, 1.2 of it the reserve, and 25 RLUSD
      expect(said).toMatch(/100[\s\S]*XRP[\s\S]*1\.2 XRP of it is kept[\s\S]*RLUSD\s*25/)
    } finally {
      server.close()
    }
    expect(ledger.sent).toEqual([
      expect.objectContaining({
        account: XRP_ME,
        destination: XRP_THEM,
        amount: { value: '5.25', currency: RLUSD, issuer: XRP_RLUSD },
        destinationTag: 12345,
        sequence: 7
      })
    ])
  }, 180_000)

  it('adds the Stellar account, shows its XLM and USDC, and sends USDC with a memo: maki signs, Horizon takes it', async () => {
    const horizon = stellarStandIn()
    const server = await serve(horizon.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'Stellar › Add from maki', '--until', 'as of'],
          ...['--click', 'Stellar › Send', '--choose', `USDC:${XLM_USDC}`],
          ...['--fill', `G…=${XLM_THEM}`, '--fill', '0.00=7.5'],
          ...['--fill', 'if the recipient asked for one=invoice 42'],
          ...['--click', 'Stellar › Review on maki', '--until', 'Sent 7.5 USDC']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 7.5 USDC')
      expect(said).toMatch(/250[\s\S]*XLM[\s\S]*USDC\s*40/)
    } finally {
      server.close()
    }
    expect(horizon.sent).toEqual([
      expect.objectContaining({
        source: XLM_ME,
        kind: 'payment',
        destination: XLM_THEM,
        asset: { code: 'USDC', issuer: XLM_USDC },
        amount: 75_000_000n,
        memo: 'invoice 42'
      })
    ])
  }, 180_000)

  it('adds the Tron account, shows its TRX and USDT, and sends USDT: maki signs, TronGrid takes it', async () => {
    const grid = tronStandIn()
    const server = await serve(grid.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'Tron › Add from maki', '--until', 'as of'],
          ...['--click', 'Tron › Send', '--choose', TRX_USDT],
          ...['--fill', `T…=${TRX_THEM}`, '--fill', '0.00=3'],
          ...['--click', 'Tron › Review on maki', '--until', 'Sent 3 USDT']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 3 USDT')
      expect(said).toMatch(/120[\s\S]*TRX[\s\S]*USDT\s*30/)
    } finally {
      server.close()
    }
    // 64,285 energy at 100 sun, with room, in whole TRX: the most it may burn
    expect(grid.sent).toEqual([
      {
        txid: expect.any(String),
        owner: TRX_ME,
        to: TRX_THEM,
        amount: 3_000_000n,
        token: TRX_USDT,
        feeLimit: 9_000_000n
      }
    ])
  }, 180_000)

  it('adds the Kaspa account, finds its coins on two addresses, and sends KAS: maki signs every input, the network takes it', async () => {
    const network = kaspaStandIn()
    const server = await serve(network.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'Kaspa › Add from maki', '--until', 'as of'],
          ...['--click', 'Kaspa › Send', '--fill', `kaspa:…=${KAS_THEM}`, '--fill', '0.00=12.5'],
          ...['--click', 'Kaspa › Review on maki', '--until', 'Sent 12.5 KAS']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 12.5 KAS')
      // 50 KAS on its first receiving address, 3 on its first change address
      expect(said).toMatch(/53[\s\S]*KAS/)
    } finally {
      server.close()
    }
    // the 50 KAS coin, 12.5 to them, the change to the next change address; 2036 grams at 100
    expect(network.sent).toEqual([
      expect.objectContaining({
        inputs: [{ txid: '11'.repeat(32), index: 0 }],
        outputs: [
          { address: KAS_THEM, value: 1_250_000_000n },
          { address: KAS_NEXT_CHANGE, value: 5_000_000_000n - 1_250_000_000n - 203_600n }
        ],
        fee: 203_600n
      })
    ])
    expect(KAS_ME).toMatch(/^kaspa:qqd6e65y/)
  }, 180_000)

  it('adds the Aptos account, shows its APT and USDC, and sends USDC: its gas simulated, maki signs, Aptos takes it', async () => {
    const aptos = aptosStandIn()
    const server = await serve(aptos.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'Aptos › Add from maki', '--until', 'as of'],
          ...['--click', 'Aptos › Send', '--choose', APT_USDC],
          ...['--fill', `0x…=${APT_THEM}`, '--fill', '0.00=7.25'],
          ...['--click', 'Aptos › Review on maki', '--until', 'Sent 7.25 USDC']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 7.25 USDC')
      expect(said).toMatch(/2\.5[\s\S]*APT[\s\S]*USDC\s*40/)
    } finally {
      server.close()
    }
    expect(aptos.sent).toEqual([
      expect.objectContaining({
        sender: APT_ME,
        function: '0x1::aptos_account::transfer_fungible_assets',
        args: [APT_USDC.slice(2), APT_THEM.slice(2), '50a06e0000000000'],
        maxGas: 28n,
        gasPrice: 100n
      })
    ])
  }, 180_000)

  it('adds the NEAR account, shows its NEAR and USDC, and sends USDC to someone not signed up for it: maki signs, NEAR takes it', async () => {
    const near = nearStandIn()
    const server = await serve(near.answer)
    try {
      const said = await drive(
        home(),
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'NEAR › Add from maki', '--until', 'as of'],
          ...['--click', 'NEAR › Send', '--choose', NEAR_USDC],
          ...['--fill', `name.near, or 64 hex digits=${NEAR_THEM}`, '--fill', '0.00=5.25'],
          ...['--click', 'NEAR › Review on maki', '--until', 'Sent 5.25 USDC']
        ],
        { MAKI_COIN_SERVER: server.url }
      )
      expect(said).toContain('Sent 5.25 USDC')
      expect(said).toMatch(/12\.5[\s\S]*NEAR[\s\S]*USDC\s*40/)
    } finally {
      server.close()
    }
    expect(near.sent).toEqual([
      expect.objectContaining({
        signer: NEAR_ME,
        receiver: NEAR_USDC,
        actions: [
          expect.objectContaining({ method: 'storage_deposit' }),
          expect.objectContaining({
            method: 'ft_transfer',
            args: JSON.stringify({ receiver_id: NEAR_THEM, amount: '5250000' })
          })
        ]
      })
    ])
  }, 180_000)
})
