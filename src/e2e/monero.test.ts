/**
 * The Monero wallet, end to end: the real app, offscreen, linked to the fake maki running maki's
 * Monero app (the test phrase's wallet), and a regtest chain (scripts/regtest.sh). It lets the
 * computer watch the wallet, scans the chain, and pays from it, pressing what a person would; the
 * app shows the payment and maki signs, and the node gets it.
 *
 *     MAKI_E2E=1 MAKI_REGTEST=1 npx vitest run src/e2e/monero.test.ts
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_FIXTURES, FAKE_BUILT, startFake } from '../shared/test-support'
import { build, drive, E2E } from './drive'

const REGTEST = process.env.MAKI_REGTEST === '1'
const NODE = process.env.MAKI_REGTEST_NODE ?? 'http://127.0.0.1:28081'
/** A wallet not the test phrase's (the cold-signing research's throwaway regtest wallet). */
const PAYEE =
  '44LozChfYpiYc66YWqqXGfX2Fv8VXV1Q4bwzMB1nD9iweUbEpRS5pRDNBJrKcikigXXQT9tBay1Tp8Btn4MSAsp715HMk66'

describe.skipIf(!E2E || !REGTEST || !FAKE_BUILT)('the Monero wallet, end to end', () => {
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

  it('watches the wallet, scans the chain and pays from it: maki signs, the node gets it', async () => {
    const said = await drive(home, fake.port, [
      ...[
        '--click',
        'Wallets',
        '--click',
        'Let this computer watch',
        '--until',
        'With the Monero GUI'
      ],
      ...[
        '--fill',
        `http://127.0.0.1:18081=${NODE}`,
        '--fill',
        'now=0',
        '--click',
        'Start',
        '--until',
        'Monero key images from maki'
      ],
      ...[
        '--click',
        'Send',
        '--fill',
        `a Monero address=${PAYEE}`,
        '--fill',
        '0.0=0.75',
        '--click',
        'Review',
        '--until',
        'Sign on maki'
      ],
      ...['--click', 'Sign on maki', '--until', 'Sent. It waits in the pool']
    ])
    const txid =
      /Sent\. It waits in the pool for a block, about two minutes\.\s*([0-9a-f]{64})/.exec(
        said
      )?.[1]
    expect(txid).toBeTruthy()
    // the node has it, waiting for a block
    const pool = (await (
      await fetch(`${NODE}/get_transaction_pool`, { method: 'POST', body: '{}' })
    ).json()) as {
      transactions?: { id_hash: string }[]
    }
    expect(pool.transactions?.map((t) => t.id_hash)).toContain(txid)
  }, 300_000)
})
