/**
 * The Wallets page's account coins, end to end: the real app, offscreen, linked to the fake maki
 * running maki's XRP, Stellar and Tron apps (the test phrase's accounts), each network stood in for
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
      ['xrp', 'stellar', 'tron'].flatMap((a) => ['--app', join(APP_FIXTURES, `${a}.maki`)])
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
})
