/**
 * The Wallets page's Solana account, end to end: the real app, offscreen, linked to the fake maki
 * running maki's Solana app (the test phrase's account, as Phantom has it), Solana stood in for by
 * LiteSVM, its runtime, behind JSON-RPC on this computer. It connects to the account and sends
 * USDC from it, pressing what a person would; the app reads and shows it, maki signs, and the
 * runtime checks the signature and runs the token program: the recipient's own USDC account holds
 * it after.
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
import { haveLiteSvm, serveSolRpc, SOL_ME, solStandIn } from '../shared/stand-ins'
import { APP_FIXTURES, FAKE_BUILT, startFake } from '../shared/test-support'
import { build, drive, E2E } from './drive'

const RECIPIENT = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
const LITESVM = await haveLiteSvm()

describe.skipIf(!E2E || !FAKE_BUILT || !LITESVM)('the Solana wallet, end to end', () => {
  let fake: { port: number; proc: ChildProcess }
  let home = ''

  beforeAll(async () => {
    build()
    fake = await startFake(['--app', join(APP_FIXTURES, 'solana.maki')])
    home = mkdtempSync(join(tmpdir(), 'maki-e2e-'))
  }, 180_000)
  afterAll(() => {
    fake?.proc.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  it('connects to the Solana account, shows what it holds, and sends USDC: maki shows whose account it goes to, and signs', async () => {
    const chain = await solStandIn()
    const rpc = await serveSolRpc(chain.rpc)
    try {
      const said = await drive(
        home,
        fake.port,
        [
          ...['--click', 'Wallets', '--click', 'Solana › Connect on maki', '--until', 'USDC'],
          ...[
            '--click',
            'Solana › Send',
            '--click',
            'Solana › USDC',
            '--fill',
            `their Solana address=${RECIPIENT}`,
            '--fill',
            '0.00=5.25',
            '--until',
            'maki shows the token'
          ],
          ...['--click', 'Solana › Review on maki', '--until', 'Sent 5.25 USDC on Solana']
        ],
        { MAKI_SOL_RPC: rpc.url }
      )
      expect(said).toContain('Sent 5.25 USDC on Solana')
      // what it held: 10 SOL and 100 USDC
      expect(said).toMatch(/Solana[\s\S]*10[\s\S]*SOL[\s\S]*100[\s\S]*USDC/)
    } finally {
      rpc.close()
    }
    // what the runtime did: the recipient's own USDC account, opened and paid
    expect(chain.usdc(RECIPIENT)).toBe(5_250_000n)
    expect(chain.usdc(SOL_ME)).toBe(94_750_000n)
  }, 180_000)
})
